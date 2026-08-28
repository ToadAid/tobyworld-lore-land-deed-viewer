function render(){
  const q=els.search.value.trim().toLowerCase(), wf=els.walletFilter.value;
  const deeds=state.deeds.filter(d=>(!q||(d.name+' '+d.tokenId+' '+d.wallet.label+' '+d.wallet.address+' '+Object.entries(d.traits).flat().join(' ')).toLowerCase().includes(q))&&(!wf||norm(d.wallet.address)===wf));
  els.statExpected.textContent=state.expected==null?'—':Number(state.expected).toLocaleString();
  els.statDeeds.textContent=state.deeds.length;
  els.statWallets.textContent=state.wallets.length;
  els.statMulti.textContent=multiWalletCount();
  els.statBlock.textContent=state.block?Number(state.block).toLocaleString():'—';
  if(!state.deeds.length){
    if(state.scanComplete&&state.expected===0){els.content.innerHTML='<div class="empty">Live scan complete: these tracked wallets own 0 deeds at the pinned Base block.</div>';return}
    els.content.innerHTML='<div class="empty">No verified deed set loaded yet.<br><span class="mini">Tap “Refresh from Base” to verify ownership live.</span></div>';return
  }
  if(!deeds.length){els.content.innerHTML='<div class="empty">No deeds match the current filters.</div>';return}
  if(state.view==='gallery'){els.content.innerHTML=`<section class="wallet"><div class="grid">${deeds.map(cardHTML).join('')}</div></section>`;return}
  const groups=[];
  for(const w of state.wallets){
    const mine=deeds.filter(d=>norm(d.wallet.address)===norm(w.address));
    if(mine.length)groups.push(`<section class="wallet"><div class="walletHead"><div class="walletTitle"><b>${escapeHTML(w.label)}</b><span class="addr">${escapeHTML(maskAddr(w.address))}</span></div><span class="count">${mine.length} deed${mine.length===1?'':'s'}</span></div><div class="grid">${mine.map(cardHTML).join('')}</div></section>`)
  }
  els.content.innerHTML=groups.join('')||'<div class="empty">No deeds match the current filters.</div>';
}
function rebuildFilter(){
  els.walletFilter.innerHTML='<option value="">All wallets</option>'+state.wallets.map(w=>{
    const n=state.walletBalances.has(norm(w.address))?state.walletBalances.get(norm(w.address)):state.deeds.filter(d=>norm(d.wallet.address)===norm(w.address)).length;
    return `<option value="${norm(w.address)}">${escapeHTML(w.label)} (${n})</option>`
  }).join('')
}
async function readWalletBalances(wallets){
  setStatus(`Reading <code>balanceOf()</code> for <b>${wallets.length}</b> wallets at pinned block with paced RPC reads…`,'',8);
  const calls=wallets.map((wallet,i)=>({key:i,wallet,data:encodeAddressCall(selectors.balanceOf,wallet.address)}));
  const rows=await strictEthCalls(calls,'Wallet balance check');
  const balances=new Map(); let expected=0;
  for(const row of rows){const n=bigToSafeNumber(hexToBig(row.result),'wallet balance');balances.set(norm(row.wallet.address),n);expected+=n}
  state.walletBalances=balances; state.expected=expected; rebuildFilter(); render();
  return expected;
}
function validateOwnedSet(owned,expected){
  if(owned.length!==expected)throw new Error(`Discovery incomplete: balanceOf() expects ${expected} deeds, but ${owned.length} token IDs were discovered.`);
  const seen=new Set();
  for(const x of owned){const k=String(x.tokenId);if(seen.has(k))throw new Error(`Discovery returned duplicate token ID ${x.tokenId}.`);seen.add(k)}
}
async function discoverByOwnerIndex(wallets,expected){
  if(expected===0)return [];
  const first=wallets.find(w=>(state.walletBalances.get(norm(w.address))||0)>0);
  try{await ethCall(encodeAddressUintCall(selectors.tokenOfOwnerByIndex,first.address,0))}catch{return null}
  const calls=[];
  for(const wallet of wallets){const balance=state.walletBalances.get(norm(wallet.address))||0;for(let i=0;i<balance;i++)calls.push({key:`${norm(wallet.address)}:${i}`,wallet,index:i,data:encodeAddressUintCall(selectors.tokenOfOwnerByIndex,wallet.address,i)})}
  setStatus(`Wallet-first enumeration available. Reading exactly <b>${expected}</b> owned token IDs…`,'',22);
  const rows=await strictEthCalls(calls,'Wallet-first token enumeration');
  const owned=rows.map(r=>({tokenId:bigToSafeNumber(hexToBig(r.result),'token ID'),wallet:r.wallet}));
  validateOwnedSet(owned,expected); state.discoveryMethod='tokenOfOwnerByIndex'; return owned;
}
async function discoverByGlobalEnumerable(wallets,expected){
  setStatus('Wallet-owner enumeration is unavailable. Trying ERC-721 global enumeration…','',22);
  let supply;
  try{supply=bigToSafeNumber(hexToBig(await ethCall(selectors.totalSupply)),'totalSupply')}catch{return null}
  if(supply>25000)return null;
  if(supply===0){if(expected!==0)return null;return []}
  try{await ethCall(encodeUintCall(selectors.tokenByIndex,0))}catch{return null}
  const ids=[]; const batch=Math.max(10,Math.min(50,Number(els.batchSize.value)||4)*5);
  for(let i=0;i<supply;i+=batch){
    const end=Math.min(supply,i+batch); const calls=[];for(let x=i;x<end;x++)calls.push({key:x,data:encodeUintCall(selectors.tokenByIndex,x)});
    const rows=await strictEthCalls(calls,'Global token enumeration',batch);ids.push(...rows.map(r=>bigToSafeNumber(hexToBig(r.result),'token ID')));
    setStatus(`Enumerating collection tokens… <b>${end.toLocaleString()}</b> / ${supply.toLocaleString()}`,'',22+28*(end/supply));
  }
  const unique=new Set(ids.map(String));if(unique.size!==ids.length)throw new Error('Global enumeration returned duplicate token IDs. Refusing the result.');
  const wanted=new Map(wallets.map(w=>[norm(w.address),w])); const owned=[];
  for(let i=0;i<ids.length;i+=batch){
    const part=ids.slice(i,i+batch);const calls=part.map(id=>({key:id,tokenId:id,data:encodeUintCall(selectors.ownerOf,id)}));
    const rows=await strictEthCalls(calls,'Global ownership verification',batch);
    for(const r of rows){const owner=decodeAddress(r.result);const wallet=owner&&wanted.get(norm(owner));if(wallet)owned.push({tokenId:r.tokenId,wallet})}
    const done=Math.min(ids.length,i+batch);setStatus(`Matching global owners to our wallets… <b>${done.toLocaleString()}</b> / ${ids.length.toLocaleString()} · matched <b>${owned.length}</b>`,'',50+18*(done/ids.length));
  }
  validateOwnedSet(owned,expected); state.discoveryMethod='tokenByIndex + ownerOf'; return owned;
}
async function findContractDeploymentBlock(){
  const end=BigInt(state.block);
  let lo=0n,hi=end,steps=0;
  setStatus('Locating the contract deployment block for the ownership cache…','',24);
  while(lo<hi){
    const mid=(lo+hi)>>1n;
    const code=await rpc('eth_getCode',[state.contract,blockHex(mid)]);
    if(code&&code!=='0x')hi=mid;else lo=mid+1n;
    steps++;
    if(isOfficialBaseRpc())await sleep(120);
    if(steps%5===0)setStatus(`Locating contract deployment block… search step <b>${steps}</b>`,'',24);
  }
  const code=await rpc('eth_getCode',[state.contract,blockHex(lo)]);
  if(!code||code==='0x')throw new Error('Could not locate contract deployment block from this RPC. Ownership-cache discovery cannot proceed.');
  return bigToSafeNumber(lo,'deployment block');
}
async function getTransferLogsAdaptive(from,to,depth=0){
  try{return await rpc('eth_getLogs',[{fromBlock:blockHex(from),toBlock:blockHex(to),address:state.contract,topics:[TRANSFER_TOPIC]}])}
  catch(error){
    if(from<to&&depth<12){
      const mid=Math.floor((from+to)/2);
      const a=await getTransferLogsAdaptive(from,mid,depth+1);
      const b=await getTransferLogsAdaptive(mid+1,to,depth+1);
      return [...a,...b];
    }
    throw new Error(`Transfer-log cache scan failed for blocks ${from.toLocaleString()}–${to.toLocaleString()}: ${error.message||error}. No partial cache accepted.`);
  }
}
async function replayTransferRange(cache,from,end,{full=false}={}){
  if(from>end)return {events:0,windows:0};
  const totalWindows=Math.max(1,Math.ceil((end-from+1)/LOG_BLOCK_WINDOW));
  let windowIndex=0,events=0;
  for(let start=from;start<=end;start+=LOG_BLOCK_WINDOW){
    const to=Math.min(end,start+LOG_BLOCK_WINDOW-1);
    const logs=await getTransferLogsAdaptive(start,to);
    if(!Array.isArray(logs))throw new Error(`Transfer-log cache scan returned a non-array result for blocks ${start.toLocaleString()}–${to.toLocaleString()}.`);
    for(const log of logs)events+=applyTransferLog(cache.owners,log);
    windowIndex++;
    const base=full?27:30, span=full?31:22;
    const pct=base+span*(windowIndex/totalWindows);
    setStatus(`${full?'Building full':'Updating'} contract ownership cache… <b>${windowIndex}</b> / ${totalWindows} windows · <b>${Object.keys(cache.owners).length.toLocaleString()}</b> live token owners · <b>${events.toLocaleString()}</b> transfers applied`,'',pct);
    if(isOfficialBaseRpc()&&to<end)await sleep(180);
  }
  return {events,windows:windowIndex};
}
async function buildFullOwnerCache(end){
  const deployment=await findContractDeploymentBlock();
  const cache={version:CACHE_VERSION,chainId:8453,contract:norm(state.contract),deploymentBlock:deployment,lastScannedBlock:deployment-1,owners:{},updatedAt:null};
  setStatus(`No usable cache. Building a contract-wide ownership index from deployment block <b>${deployment.toLocaleString()}</b>. This first build is the slow one…`,'',27);
  await replayTransferRange(cache,deployment,end,{full:true});
  cache.lastScannedBlock=end;
  return cache;
}
