async function prepareOwnerCache(end,forceRebuild=false){
  let cache=forceRebuild?null:loadOwnerCache(state.contract);
  if(cache&&cache.lastScannedBlock>end)throw new Error(`Local cache is ahead of the current RPC head (${cache.lastScannedBlock.toLocaleString()} > ${end.toLocaleString()}). Use “Rebuild full cache” or a synchronized Base RPC.`);
  if(!cache)return buildFullOwnerCache(end);
  // Clone before mutation so a failed incremental refresh cannot corrupt the saved cache.
  cache={...cache,owners:{...cache.owners}};
  if(cache.lastScannedBlock<end){
    const from=cache.lastScannedBlock+1;
    setStatus(`Cache hit at block <b>${cache.lastScannedBlock.toLocaleString()}</b>. Scanning only <b>${(end-from+1).toLocaleString()}</b> newer blocks…`,'',30);
    await replayTransferRange(cache,from,end,{full:false});
    cache.lastScannedBlock=end;
  }else{
    setStatus(`Cache hit through pinned block <b>${end.toLocaleString()}</b>. No historical Transfer scan needed.`,'',52);
  }
  return cache;
}
async function discoverByCachedTransferIndex(wallets,expected,{forceRebuild=false}={}){
  if(expected===0)return [];
  const end=bigToSafeNumber(BigInt(state.block),'pinned block');
  const cache=await prepareOwnerCache(end,forceRebuild);
  const wanted=new Map(wallets.map(w=>[norm(w.address),w]));
  const owned=[];
  for(const [id,owner] of Object.entries(cache.owners)){
    const wallet=wanted.get(norm(owner));
    if(wallet)owned.push({tokenId:bigToSafeNumber(BigInt(id),'cached token ID'),wallet});
  }
  owned.sort((a,b)=>a.tokenId-b.tokenId);
  if(owned.length!==expected){
    const mode=forceRebuild||!loadOwnerCache(state.contract)?'freshly rebuilt':'cached';
    throw new Error(`Ownership-cache invariant mismatch: balanceOf() expects ${expected} deeds, but the ${mode} contract index maps ${owned.length} tokens to these wallets. Refusing the cache. Use “Rebuild full cache” if this was an incremental refresh.`);
  }
  state.pendingCache=cache;
  state.discoveryMethod=forceRebuild?'rebuilt contract-wide Transfer cache + ownerOf':'contract-wide Transfer cache + ownerOf';
  return owned;
}
async function verifyOwned(owned,expected){
  validateOwnedSet(owned,expected); if(!owned.length)return owned;
  setStatus(`Re-verifying <b>${owned.length}</b> discovered tokens with <code>ownerOf()</code>…`,'',70);
  const calls=owned.map(x=>({key:x.tokenId,tokenId:x.tokenId,wallet:x.wallet,data:encodeUintCall(selectors.ownerOf,x.tokenId)}));
  const rows=await strictEthCalls(calls,'Final owner verification');
  for(const r of rows){const owner=decodeAddress(r.result);if(!owner||norm(owner)!==norm(r.wallet.address))throw new Error(`Owner verification mismatch for token #${r.tokenId}. Refusing the result.`)}
  return owned.sort((a,b)=>a.tokenId-b.tokenId);
}
async function loadMetadata(owned,collectionName){
  const deeds=[]; const metaBatch=24;
  for(let i=0;i<owned.length;i+=metaBatch){
    const part=owned.slice(i,i+metaBatch); const calls=part.map(x=>({key:x.tokenId,tokenId:x.tokenId,data:encodeUintCall(selectors.tokenURI,x.tokenId)}));
    const uriRows=await tolerantEthCalls(calls,metaBatch); const byId=new Map(uriRows.map(x=>[x.tokenId,x]));
    const metas=await Promise.all(part.map(async x=>{
      const rr=byId.get(x.tokenId); const uri=rr?.result?decodeAbiString(rr.result):''; const {meta,error,source}=await readMetadata(uri,x.tokenId); const traits=traitsFrom(meta); const imageCandidates=collectImageCandidates(meta);
      return {tokenId:x.tokenId,wallet:x.wallet,tokenURI:uri,name:meta?.name||`${collectionName} #${x.tokenId}`,description:meta?.description||'',image:imageCandidates[0]||'',imageCandidates,traits,metadataSource:source||'',metadataError:error||(rr?.error?'tokenURI read failed':null),artworkSource:'',artworkError:''}
    }));
    deeds.push(...metas); const done=Math.min(owned.length,i+metaBatch);setStatus(`Ownership complete. Loading artwork + traits… <b>${done}</b> / ${owned.length}`,'',82+(owned.length?17*(done/owned.length):17));
  }
  return deeds;
}
async function scan(options={}){
  if(state.scanning)return;
  const forceCacheRebuild=!!options.forceCacheRebuild;
  try{
    state.scanning=true; state.scanComplete=false; els.scan.disabled=true; els.scan.textContent='Reading Base…';
    const wallets=parseWallets(); const contract=els.contract.value.trim(); if(!addrOK(contract))throw new Error('Invalid Lore Land contract address.');
    state.wallets=wallets;state.contract=contract;state.deeds=[];state.expected=null;state.walletBalances=new Map();state.discoveryMethod='';state.block=null;state.blockTag='latest';state.pendingCache=null;state.forceCacheRebuild=forceCacheRebuild;rebuildFilter();render();updateCacheUI();
    setStatus('Checking Base network and contract…','',2);
    const chain=await rpc('eth_chainId'); if(hexToBig(chain)!==8453n)throw new Error(`Wrong network: RPC chain ID is ${hexToBig(chain)}; expected Base Mainnet 8453.`);
    const code=await rpc('eth_getCode',[contract,'latest']); if(!code||code==='0x')throw new Error('No contract bytecode found at this address on Base.');
    const blockHex=await rpc('eth_blockNumber'); state.block=hexToBig(blockHex).toString(); state.blockTag=blockHex; render();
    let collectionName='Lore Land Deed';try{collectionName=decodeAbiString(await ethCall(selectors.name))||collectionName}catch{}
    const expected=await readWalletBalances(wallets);
    if(expected===0){state.deeds=[];state.scanComplete=true;render();setStatus(`<span class="okTxt">Live Base refresh complete.</span> The <b>${wallets.length}</b> tracked wallets own <b>0</b> deeds at pinned block <b>${Number(state.block).toLocaleString()}</b>.`,'live',100);return}
    setStatus(`<b>balanceOf()</b> establishes an expected total of <b>${expected}</b> deeds. Discovering their token IDs…`,'',16);
    let owned=await discoverByOwnerIndex(wallets,expected);
    if(owned===null)owned=await discoverByGlobalEnumerable(wallets,expected);
    if(owned===null)owned=await discoverByCachedTransferIndex(wallets,expected,{forceRebuild:forceCacheRebuild});
    owned=await verifyOwned(owned,expected);
    if(owned.length!==expected)throw new Error(`Final invariant failed: expected ${expected}, verified ${owned.length}.`);
    if(state.pendingCache){saveOwnerCache(state.pendingCache);state.pendingCache=null}
    state.deeds=await loadMetadata(owned,collectionName); state.scanComplete=true; rebuildFilter(); render();
    const missing=state.deeds.filter(d=>d.metadataError).length;
    setStatus(`<span class="okTxt">Ownership refresh complete.</span> Expected <b>${expected}</b> from wallet balances and independently verified <b>${state.deeds.length}</b> token owners at block <b>${Number(state.block).toLocaleString()}</b> using <b>${escapeHTML(state.discoveryMethod)}</b>. <span class="okTxt">Contract cache is indexed through this pinned block.</span>${missing?` <span class="warn">${missing} metadata record${missing===1?' is':'s are'} unavailable, but ownership is complete.</span>`:''}`,'live',100);
    localStorage.setItem('toadaidLoreVault.wallets',els.wallets.value);localStorage.setItem('toadaidLoreVault.contract',contract);localStorage.setItem('toadaidLoreVault.rpc',els.rpc.value.trim());
  }catch(e){console.error(e);state.scanComplete=false;state.deeds=[];rebuildFilter();render();setStatus(`<span class="errTxt">Refresh stopped:</span> ${escapeHTML(e.message||String(e))}`,'err',0)}finally{state.scanning=false;els.scan.disabled=false;els.scan.textContent='Refresh from Base'}
}
els.scan.addEventListener('click',()=>scan());
els.rebuildCache.addEventListener('click',()=>{if(state.scanning)return;if(confirm('Rebuild the complete contract ownership cache from deployment? The existing cache stays untouched unless the rebuild succeeds.'))scan({forceCacheRebuild:true})});
els.clearCache.addEventListener('click',()=>{if(state.scanning)return;if(confirm('Clear only the local contract ownership cache? Your wallet list will stay saved.')){deleteOwnerCache();setStatus('Contract ownership cache cleared. The next refresh will perform a full rebuild.','',0)}});
els.clearServerArtworkCache.addEventListener('click',clearServerArtworkCache);
els.contract.addEventListener('input',()=>{updateCacheUI();checkArtworkHelper()});
els.save.addEventListener('click',()=>{try{parseWallets();localStorage.setItem('toadaidLoreVault.wallets',els.wallets.value);localStorage.setItem('toadaidLoreVault.contract',els.contract.value.trim());localStorage.setItem('toadaidLoreVault.rpc',els.rpc.value.trim());setStatus('Wallet list and chain-reader settings saved locally in this browser.','live',0)}catch(e){setStatus(escapeHTML(e.message),'err',0)}});
els.clear.addEventListener('click',()=>{if(confirm('Clear the wallet list and current deed results?')){els.wallets.value='';state.wallets=[];state.deeds=[];state.expected=null;state.walletBalances=new Map();state.scanComplete=false;localStorage.removeItem('toadaidLoreVault.wallets');render();rebuildFilter();setStatus('Wallet list cleared.','',0)}});
els.export.addEventListener('click',()=>{const cache=loadOwnerCache(state.contract);const data={title:'Tobyworld Lore Land Deed Viewer',chainId:8453,contract:state.contract,baseBlock:state.block,expectedFromBalances:state.expected,verifiedDeeds:state.deeds.length,discoveryMethod:state.discoveryMethod,ownershipComplete:state.scanComplete&&state.expected===state.deeds.length,cache:cache?{deploymentBlock:cache.deploymentBlock,lastScannedBlock:cache.lastScannedBlock,indexedLiveOwners:Object.keys(cache.owners).length,updatedAt:cache.updatedAt}:null,exportedAt:new Date().toISOString(),wallets:state.wallets.map(w=>({label:w.label,address:w.address,onChainBalance:state.walletBalances.get(norm(w.address))??null,deeds:state.deeds.filter(d=>norm(d.wallet.address)===norm(w.address)).map(d=>({tokenId:d.tokenId,name:d.name,tokenURI:d.tokenURI,image:d.image,traits:d.traits,metadataSource:d.metadataSource,metadataError:d.metadataError}))}))};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='tobyworld-lore-land-deed-viewer-snapshot.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)});
els.search.addEventListener('input',render);els.walletFilter.addEventListener('change',render);els.mask.addEventListener('change',render);
els.walletView.addEventListener('click',()=>{state.view='wallet';els.walletView.classList.add('active');els.galleryView.classList.remove('active');render()});
els.galleryView.addEventListener('click',()=>{state.view='gallery';els.galleryView.classList.add('active');els.walletView.classList.remove('active');render()});
(function boot(){const w=localStorage.getItem('toadaidLoreVault.wallets');const c=localStorage.getItem('toadaidLoreVault.contract');const r=localStorage.getItem('toadaidLoreVault.rpc');if(w)els.wallets.value=w;if(c)els.contract.value=c;if(r)els.rpc.value=r;render();updateCacheUI();checkArtworkHelper()})();
