
'use strict';
const $=s=>document.querySelector(s);
const els={wallets:$('#wallets'),contract:$('#contract'),rpc:$('#rpc'),batchSize:$('#batchSize'),artworkHelperStatus:$('#artworkHelperStatus'),clearServerArtworkCache:$('#clearServerArtworkCacheBtn'),scan:$('#scanBtn'),save:$('#saveBtn'),clear:$('#clearBtn'),export:$('#exportBtn'),rebuildCache:$('#rebuildCacheBtn'),clearCache:$('#clearCacheBtn'),cacheStatus:$('#cacheStatus'),status:$('#status'),statusText:$('#statusText'),bar:$('#bar'),content:$('#content'),search:$('#search'),walletFilter:$('#walletFilter'),mask:$('#mask'),walletView:$('#walletView'),galleryView:$('#galleryView'),statExpected:$('#statExpected'),statDeeds:$('#statDeeds'),statWallets:$('#statWallets'),statMulti:$('#statMulti'),statBlock:$('#statBlock')};
const DEFAULT_CONTRACT='0x0495601af6f86efb14c9d478ea46b2aa09cb164a';
const CACHE_VERSION=1, CACHE_PREFIX='toadaidLoreVault.ownerCache.v1', ZERO_ADDRESS='0x0000000000000000000000000000000000000000';
let state={wallets:[],deeds:[],view:'wallet',scanning:false,scanComplete:false,block:null,blockTag:'latest',contract:DEFAULT_CONTRACT,expected:null,walletBalances:new Map(),discoveryMethod:'',pendingCache:null,forceCacheRebuild:false};
const selectors={
  totalSupply:'0x18160ddd',
  balanceOf:'0x70a08231',
  ownerOf:'0x6352211e',
  tokenURI:'0xc87b56dd',
  name:'0x06fdde03',
  tokenOfOwnerByIndex:'0x2f745c59',
  tokenByIndex:'0x4f6ccce7'
};
const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const LOG_BLOCK_WINDOW=2000;
function addrOK(a){return /^0x[0-9a-fA-F]{40}$/.test(a)}
function norm(a){return a.toLowerCase()}
function parseWallets(){
  const out=[],seen=new Set();
  for(const raw of els.wallets.value.split(/\r?\n/)){
    const line=raw.trim(); if(!line) continue;
    let label,address;
    if(line.includes(',')){const p=line.split(',');label=p.shift().trim();address=p.join(',').trim();}
    else{address=line;label=`W${out.length+1}`}
    if(!addrOK(address)) throw new Error(`Invalid wallet address: ${address}`);
    const key=norm(address); if(seen.has(key)) continue; seen.add(key);
    out.push({label:label||`W${out.length+1}`,address});
  }
  if(!out.length) throw new Error('Add at least one wallet address.');
  return out;
}
function setStatus(msg,type='',pct=null){els.status.className='status'+(type?` ${type}`:'');els.statusText.innerHTML=msg;if(pct!==null)els.bar.style.width=Math.max(0,Math.min(100,pct))+'%';}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function hexPadUint(n){return BigInt(n).toString(16).padStart(64,'0')}
function hexPadAddress(a){return a.replace(/^0x/,'').toLowerCase().padStart(64,'0')}
function encodeUintCall(sel,n){return sel+hexPadUint(n)}
function encodeAddressCall(sel,a){return sel+hexPadAddress(a)}
function encodeAddressUintCall(sel,a,n){return sel+hexPadAddress(a)+hexPadUint(n)}
function blockHex(n){return '0x'+BigInt(n).toString(16)}
function addressTopic(a){return '0x'+'0'.repeat(24)+a.replace(/^0x/,'').toLowerCase()}
function hexToBig(h){return BigInt(h||'0x0')}
function bigToSafeNumber(v,label='value'){const n=Number(v);if(!Number.isSafeInteger(n)||n<0)throw new Error(`${label} is outside the safe numeric range.`);return n}
function decodeAddress(hex){if(!hex||hex.length<42)return null;return '0x'+hex.slice(-40)}
function hexToUtf8(hex){const clean=hex.startsWith('0x')?hex.slice(2):hex;const bytes=new Uint8Array(clean.match(/.{1,2}/g)?.map(b=>parseInt(b,16))||[]);return new TextDecoder().decode(bytes)}
function decodeAbiString(hex){
  if(!hex||hex==='0x')return '';
  const h=hex.startsWith('0x')?hex.slice(2):hex;
  try{const offset=Number(BigInt('0x'+h.slice(0,64)))*2;const len=Number(BigInt('0x'+h.slice(offset,offset+64)));const data=h.slice(offset+64,offset+64+len*2);return hexToUtf8(data)}catch{return ''}
}
function cacheKey(contract=els.contract.value.trim()){
  if(!addrOK(contract))return null;
  return `${CACHE_PREFIX}.8453.${norm(contract)}`;
}
function loadOwnerCache(contract=els.contract.value.trim()){
  const key=cacheKey(contract); if(!key)return null;
  try{
    const raw=localStorage.getItem(key); if(!raw)return null;
    const c=JSON.parse(raw);
    if(c?.version!==CACHE_VERSION||c?.chainId!==8453||norm(c?.contract||'')!==norm(contract)||!Number.isSafeInteger(c?.deploymentBlock)||!Number.isSafeInteger(c?.lastScannedBlock)||!c?.owners||typeof c.owners!=='object'||Array.isArray(c.owners))return null;
    for(const [id,owner] of Object.entries(c.owners)){if(!/^\d+$/.test(id)||!addrOK(owner))return null}
    return c;
  }catch{return null}
}
function saveOwnerCache(cache){
  const key=cacheKey(cache.contract); if(!key)throw new Error('Cannot save cache for an invalid contract address.');
  const payload={version:CACHE_VERSION,chainId:8453,contract:norm(cache.contract),deploymentBlock:cache.deploymentBlock,lastScannedBlock:cache.lastScannedBlock,owners:cache.owners,updatedAt:new Date().toISOString()};
  try{localStorage.setItem(key,JSON.stringify(payload))}catch(e){throw new Error(`Ownership cache could not be saved locally: ${e.message||e}`)}
  updateCacheUI(payload); return payload;
}
function deleteOwnerCache(contract=els.contract.value.trim()){const key=cacheKey(contract);if(key)localStorage.removeItem(key);updateCacheUI(null)}
function updateCacheUI(cache=undefined){
  if(!els.cacheStatus)return;
  const contract=els.contract.value.trim();
  if(!addrOK(contract)){els.cacheStatus.textContent='Enter a valid contract address.';return}
  const c=cache===undefined?loadOwnerCache(contract):cache;
  if(!c){els.cacheStatus.textContent='No cache yet · first refresh builds the contract-wide ownership index.';return}
  const count=Object.keys(c.owners||{}).length;
  els.cacheStatus.textContent=`Indexed ${count.toLocaleString()} live token owner${count===1?'':'s'} through Base block ${Number(c.lastScannedBlock).toLocaleString()} · saved locally.`;
}
function localArtworkURL(tokenId){
  const id=Number(tokenId);
  return Number.isSafeInteger(id)&&id>=0?`/api/artwork/${id}`:'';
}
async function checkArtworkHelper(){
  if(!els.artworkHelperStatus)return;
  try{
    const r=await fetch('/api/health',{cache:'no-store'});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const j=await r.json();
    els.artworkHelperStatus.innerHTML=`🟢 helper online · ${Number(j.cached_artworks||0).toLocaleString()} image${Number(j.cached_artworks||0)===1?'':'s'} cached${j.opensea_api_key?' · API key available':' · public-page resolver'}`;
  }catch(e){
    els.artworkHelperStatus.innerHTML=`🟠 helper unavailable · run <code>start-vault.sh</code> (Linux/macOS) or <code>start-vault.bat</code> (Windows)`;
  }
}
async function clearServerArtworkCache(){
  try{
    const r=await fetch('/api/artwork-cache',{method:'DELETE'});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    await checkArtworkHelper();
    setStatus('Local artwork byte cache cleared. Ownership cache was not changed.','live',0);
  }catch(e){setStatus(`Artwork helper cache clear failed: ${escapeHTML(e.message||e)}`,'err',0)}
}
function topicAddress(topic){if(!topic||topic.length<42)return null;return '0x'+topic.slice(-40).toLowerCase()}
function applyTransferLog(owners,log){
  if(log?.removed)return 0;
  const t=log?.topics;
  if(!Array.isArray(t)||t.length<4||norm(t[0]||'')!==TRANSFER_TOPIC)return 0;
  const to=topicAddress(t[2]); if(!to||!addrOK(to))throw new Error('Malformed ERC-721 Transfer destination topic.');
  const id=String(bigToSafeNumber(hexToBig(t[3]),'Transfer token ID'));
  if(norm(to)===ZERO_ADDRESS)delete owners[id];else owners[id]=norm(to);
  return 1;
}
let rpcId=1;
function isOfficialBaseRpc(){
  try{return new URL(els.rpc.value.trim()).hostname.toLowerCase()==='mainnet.base.org'}catch{return false}
}
function transientRpcError(error){
  const text=String(error?.message||error||'').toLowerCase();
  return /http (408|425|429|500|502|503|504)|rate|limit|too many|timeout|temporar|busy|overload|try again|-32005|-32016/.test(text);
}
async function rpcOnce(method,params=[]){
  const url=els.rpc.value.trim(); if(!/^https?:\/\//i.test(url))throw new Error('RPC URL must start with http:// or https://');
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:rpcId++,method,params})});
  let body=''; try{body=await res.text()}catch{}
  if(!res.ok){const hint=body&&body.length<220?`: ${body}`:'';throw new Error(`RPC HTTP ${res.status}${hint}`)}
  let j;try{j=JSON.parse(body)}catch{throw new Error('RPC returned invalid JSON')}
  if(j.error)throw new Error(`RPC ${j.error.code??''} ${j.error.message||'error'}`.trim()); return j.result;
}
async function rpc(method,params=[]){
  const maxAttempts=isOfficialBaseRpc()?6:4;
  let last;
  for(let attempt=0;attempt<maxAttempts;attempt++){
    try{return await rpcOnce(method,params)}catch(error){
      last=error;
      if(!transientRpcError(error)||attempt===maxAttempts-1)throw error;
      const wait=Math.min(8000,500*(2**attempt))+Math.floor(Math.random()*180);
      await sleep(wait);
    }
  }
  throw last||new Error('RPC read failed');
}
async function ethCall(data,blockTag=state.blockTag||'latest'){return rpc('eth_call',[{to:state.contract,data},blockTag])}
async function pacedEthCalls(calls,{strict=true,label='RPC read',blockTag=state.blockTag||'latest'}={}){
  const out=[];
  const official=isOfficialBaseRpc();
  const burst=official?1:Math.max(1,Math.min(8,Number(els.batchSize.value)||4));
  const pause=official?220:70;
  for(let i=0;i<calls.length;i+=burst){
    const part=calls.slice(i,i+burst);
    const rows=await Promise.all(part.map(async c=>{
      try{return {...c,result:await ethCall(c.data,blockTag),error:null}}
      catch(error){return {...c,result:null,error}}
    }));
    const bad=rows.filter(r=>r.result==null||r.error);
    if(strict&&bad.length){
      const first=bad[0]?.error?.message||String(bad[0]?.error||'unknown RPC error');
      throw new Error(`${label}: ${bad.length} read${bad.length===1?'':'s'} failed after paced retries. First error: ${first}. Refusing a partial result.`);
    }
    out.push(...rows);
    if(i+burst<calls.length)await sleep(pause);
  }
  return out;
}
async function strictEthCalls(calls,label,chunkSize=null){
  return pacedEthCalls(calls,{strict:true,label});
}
async function tolerantEthCalls(calls,chunkSize=null){
  return pacedEthCalls(calls,{strict:false,label:'Metadata read'});
}
function ipfsPath(uri){
  if(!uri)return '';
  if(uri.startsWith('ipfs://')){let p=uri.slice(7);if(p.startsWith('ipfs/'))p=p.slice(5);return p.replace(/^\/+/, '')}
  try{const u=new URL(uri);const marker='/ipfs/';const i=u.pathname.toLowerCase().indexOf(marker);if(i>=0)return (u.pathname.slice(i+marker.length)+u.search).replace(/^\/+/, '')}catch{}
  return '';
}
function resolveURI(uri){
  if(!uri)return '';
  uri=String(uri).trim();
  if(/^data:image\//i.test(uri)||/^blob:/i.test(uri))return uri;
  const p=ipfsPath(uri);
  if(p)return 'https://dweb.link/ipfs/'+p;
  if(/^\/ipfs\//i.test(uri))return 'https://dweb.link'+uri;
  if(uri.startsWith('ar://'))return 'https://arweave.net/'+uri.slice(5);
  if(uri.startsWith('//'))return 'https:'+uri;
  if(/^https?:\/\//i.test(uri))return uri;
  if(/^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(uri))return 'https://'+uri;
  return uri;
}
function imageCandidatesForURI(uri){
  if(!uri)return [];
  uri=String(uri).trim();
  const out=[]; const add=u=>{u=resolveURI(u);if(u&&!out.includes(u))out.push(u)};
  if(/^data:image\//i.test(uri)||/^blob:/i.test(uri)){add(uri);return out}
  const p=ipfsPath(uri)||(/^\/ipfs\//i.test(uri)?uri.replace(/^\/ipfs\//i,''):null);
  if(p){
    add(`https://dweb.link/ipfs/${p}`);
    add(`https://ipfs.io/ipfs/${p}`);
    add(`https://gateway.pinata.cloud/ipfs/${p}`);
    add(`https://nftstorage.link/ipfs/${p}`);
  }else add(uri);
  return out;
}
function collectImageCandidates(meta){
  if(!meta||typeof meta!=='object')return [];
  const raw=[];
  const push=v=>{if(typeof v==='string'&&v.trim())raw.push(v.trim())};
  // Prefer explorer/media mirrors first: they are often browser-displayable even
  // when the metadata's original IPFS gateway is blocked or slow.
  push(meta.image_url); push(meta.imageUrl); push(meta.media_url); push(meta.mediaUrl); push(meta.image);
  push(meta?.properties?.image);
  const files=meta?.properties?.files;
  if(Array.isArray(files))for(const f of files){
    if(typeof f==='string')push(f);
    else if(f&&typeof f==='object'&&(!f.type||String(f.type).toLowerCase().startsWith('image/')))push(f.uri||f.url||f.src);
  }
  const out=[];
  for(const u of raw)for(const c of imageCandidatesForURI(u))if(c&&!out.includes(c))out.push(c);
  return out;
}
function metadataCandidates(uri){
  if(!uri)return [];
  const out=[]; const add=u=>{if(u&&!out.includes(u))out.push(u)};
  if(/^https?:\/\//i.test(uri))add(uri);
  const p=ipfsPath(uri);
  if(p){add(`https://ipfs.io/ipfs/${p}`);add(`https://dweb.link/ipfs/${p}`);add(`https://gateway.pinata.cloud/ipfs/${p}`)}
  if(uri.startsWith('ar://'))add(`https://arweave.net/${uri.slice(5)}`);
  return out;
}
function normalizeMeta(meta, extra={}){
  const m=(meta&&typeof meta==='object')?{...meta}:{};
  if(!m.name&&extra.name)m.name=extra.name;
  if(!m.description&&extra.description)m.description=extra.description;
  if(!m.image&&extra.image)m.image=extra.image;
  if(!m.image_url&&extra.image_url)m.image_url=extra.image_url;
  if(!m.animation_url&&extra.animation_url)m.animation_url=extra.animation_url;
  return m;
}
async function readBlockscoutMetadata(tokenId){
  const url=`https://base.blockscout.com/api/v2/tokens/${state.contract}/instances/${tokenId}`;
  try{
    const res=await fetch(url,{cache:'no-store',headers:{'Accept':'application/json'}});
    if(!res.ok)throw new Error(`Blockscout HTTP ${res.status}`);
    const j=await res.json();
    const meta=normalizeMeta(j?.metadata,{name:j?.name,description:j?.description,image:j?.image_url||j?.media_url,image_url:j?.image_url,animation_url:j?.animation_url});
    // Keep Blockscout's top-level media URLs even when metadata already contains
    // an original `image` field. The top-level URL is frequently the most reliable
    // browser-renderable mirror.
    if(j?.image_url)meta.image_url=j.image_url;
    if(j?.media_url)meta.media_url=j.media_url;
    if(j?.animation_url&&!meta.animation_url)meta.animation_url=j.animation_url;
    if(!meta.name&&!meta.image&&!meta.image_url&&!meta.media_url&&!meta.attributes&&!meta.traits)throw new Error('Blockscout returned no NFT metadata');
    return {meta,error:null,source:'Blockscout metadata mirror'};
  }catch(e){return {meta:null,error:e.message||String(e),source:null}}
}
async function readMetadata(uri,tokenId){
  let directError='No tokenURI';
  if(uri){
    try{
      if(/^data:application\/json/i.test(uri)){
        const comma=uri.indexOf(','); const head=uri.slice(0,comma); const body=uri.slice(comma+1);
        const txt=/;base64/i.test(head)?atob(body):decodeURIComponent(body);
        return {meta:JSON.parse(txt),error:null,source:'on-chain data URI'};
      }
    }catch(e){directError=e.message||String(e)}
    for(const url of metadataCandidates(uri)){
      try{
        const res=await fetch(url,{cache:'no-store',headers:{'Accept':'application/json'}});
        if(!res.ok)throw new Error(`metadata HTTP ${res.status}`);
        return {meta:await res.json(),error:null,source:url.includes('/ipfs/')?'IPFS gateway':'tokenURI HTTPS'};
      }catch(e){directError=e.message||String(e)}
    }
  }
  const fallback=await readBlockscoutMetadata(tokenId);
  if(fallback.meta)return fallback;
  return {meta:null,error:`${directError}; ${fallback.error||'Blockscout fallback unavailable'}`,source:null};
}
function traitsFrom(meta){
  const out={};
  const arrays=[];
  if(Array.isArray(meta?.attributes))arrays.push(meta.attributes);
  if(Array.isArray(meta?.traits))arrays.push(meta.traits);
  for(const attrs of arrays){for(const a of attrs){const k=a?.trait_type??a?.traitType??a?.type??a?.name;const v=a?.value??a?.trait_value;if(k!=null&&v!=null)out[String(k)]=String(v)}}
  if(meta?.attributes&&typeof meta.attributes==='object'&&!Array.isArray(meta.attributes)){for(const [k,v] of Object.entries(meta.attributes)){if(v!=null&&typeof v!=='object')out[String(k)]=String(v)}}
  if(meta?.traits&&typeof meta.traits==='object'&&!Array.isArray(meta.traits)){for(const [k,v] of Object.entries(meta.traits)){if(v!=null&&typeof v!=='object')out[String(k)]=String(v)}}
  return out;
}
function niceTraits(t){
  const preferred=['Background','Core','Keeper','Land','Relic']; const entries=[];
  for(const k of preferred){const hit=Object.keys(t).find(x=>x.toLowerCase()===k.toLowerCase());if(hit)entries.push([hit,t[hit]])}
  for(const [k,v] of Object.entries(t)){if(!entries.some(([x])=>x===k))entries.push([k,v])}
  return entries.slice(0,8);
}
function escapeHTML(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function maskAddr(a){return els.mask.checked?`${a.slice(0,6)}…${a.slice(-4)}`:a}
async function advanceArtwork(img,tokenId){
  const deed=state.deeds.find(d=>String(d.tokenId)===String(tokenId));
  if(!deed)return;
  const list=Array.isArray(deed.imageCandidates)?deed.imageCandidates:[];
  let i=Number(img.dataset.sourceIndex||0)+1;
  if(i<list.length){img.dataset.sourceIndex=String(i);img.src=list[i];return}
  if(img.dataset.localHelperTried!=='1'){
    img.dataset.localHelperTried='1';
    const u=localArtworkURL(tokenId);
    if(u){deed.artworkSource='localhost artwork helper';img.src=u;return}
  }
  img.style.display='none';
  const art=img.closest('.art'); if(art){art.classList.add('imageFailed');art.title=deed.artworkError||'Metadata loaded, but no browser-displayable artwork source succeeded.'}
}
function artworkLoaded(img){const art=img.closest('.art');if(art)art.classList.add('imageLoaded')}
function cardHTML(d){
  const traits=niceTraits(d.traits); const helper=localArtworkURL(d.tokenId); const first=(d.imageCandidates&&d.imageCandidates[0])||d.image||helper||''; const helperFirst=!!helper&&first===helper;
  const img=first?`<img src="${escapeHTML(first)}" alt="${escapeHTML(d.name)}" loading="lazy" data-source-index="0" data-local-helper-tried="${helperFirst?'1':'0'}" onload="artworkLoaded(this)" onerror="advanceArtwork(this,${Number(d.tokenId)})">`:'';
  return `<article class="card" data-search="${escapeHTML((d.name+' '+d.wallet.label+' '+d.wallet.address+' '+Object.values(d.traits).join(' ')).toLowerCase())}" data-wallet="${escapeHTML(norm(d.wallet.address))}">
    <div class="art"><div class="placeholder">🪷</div>${img}<div class="badge">${escapeHTML(d.wallet.label)}</div></div>
    <div class="body"><div class="name">${escapeHTML(d.name||`Lore Land Deed #${d.tokenId}`)}</div><div class="token">Token #${d.tokenId}${d.metadataError?` · <span class="warn" title="${escapeHTML(d.metadataError)}">metadata unavailable</span>`:` · <span class="okTxt" title="${escapeHTML(d.metadataSource||'metadata loaded')}">metadata loaded</span>`}</div>
      <div class="traits">${traits.length?traits.map(([k,v])=>`<div class="trait"><small>${escapeHTML(k)}</small><span title="${escapeHTML(v)}">${escapeHTML(v)}</span></div>`).join(''):'<div class="trait"><small>Ownership</small><span>On-chain owner verified</span></div>'}</div>
      <div class="links"><a target="_blank" rel="noopener" href="https://opensea.io/item/base/${state.contract}/${d.tokenId}">OpenSea</a><a target="_blank" rel="noopener" href="https://basescan.org/token/${state.contract}?a=${d.tokenId}">BaseScan</a></div>
    </div></article>`
}
function multiWalletCount(){
  if(state.walletBalances.size)return [...state.walletBalances.values()].filter(n=>n>1).length;
  return state.wallets.filter(w=>state.deeds.filter(d=>norm(d.wallet.address)===norm(w.address)).length>1).length;
}
