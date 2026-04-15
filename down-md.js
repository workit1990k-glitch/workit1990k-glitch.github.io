// down-mangadex.js - MangaDex Downloader (Compact)
// Bookmarklet: Load via console or bookmark
// Uses MangaDex API v5 + data-saver images for smaller downloads

(function(){'use strict';
if(window.mddxLoaded){console.log('✅ Already loaded');return;}
window.mddxLoaded=true;

// Config
const API='https://api.mangadex.org',QUALITY='data-saver',MAX_ZIP=500<<20,PAR_CH=2,PAR_IMG=2;
const LOAD=async(u,o)=>{const r=await fetch(u,{...o,headers:{'Content-Type':'application/json',...o?.headers}});if(!r.ok)throw new Error(r.status);return r.json();};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fmt=b=>b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(2)+'MB';

// Extract manga ID from URL
const getId=()=>location.href.match(/mangadex\.org\/title\/([0-9a-f-]+)/i)?.[1]||null;

// Fetch all chapters (paginated)
const getChapters=async(id)=>{
  const ch=[];let p=1;
  while(true){
    const r=await LOAD(`${API}/manga/${id}/feed?limit=100&order[chapter]=desc&translatedLanguage[]=en&page=${p}`);
    const items=r.data||[];if(!items.length)break;
    ch.push(...items.map(c=>({id:c.id,num:c.attributes.chapter||'0',title:c.attributes.title,grp:(c.attributes.groups||[]).map(g=>g.attributes?.name).filter(Boolean).join(', ')})));
    if(items.length<100)break;p++;await sleep(100);
  }
  return ch.sort((a,b)=>parseFloat(a.num)-parseFloat(b.num));
};

// Get chapter images via at-home server
const getImages=async(cid)=>{
  const r=await LOAD(`${API}/at-home/server/${cid}`);
  const{baseUrl,chapter:{hash,[QUALITY]:files}}=r;
  return files.map(f=>`${baseUrl}/${QUALITY}/${hash}/${f}`);
};

// Download blob
const dlBlob=async(url)=>{const r=await fetch(url);if(!r.ok)throw new Error(r.status);return await r.blob();};

// Create ZIP (lazy-load JSZip)
let JSZip,saveAs;const loadLibs=async()=>{
  if(!JSZip){await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});}
  if(!saveAs){await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});}
};

// Main UI
const ui=()=>{
  const ov=document.createElement('div');ov.id='mdx';ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:sans-serif;color:#fff;';
  ov.innerHTML=`<div style="background:#1a1a2e;max-width:800px;width:100%;max-height:95vh;overflow:hidden;border-radius:12px;display:flex;flex-direction:column;">
    <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
      <strong>📚 MangaDex Downloader</strong><button id="x" style="background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;">&times;</button>
    </div>
    <div id="body" style="flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px;"></div>
    <div style="padding:12px 16px;border-top:1px solid #333;display:flex;gap:8px;flex-wrap:wrap;">
      <button id="all" style="padding:8px 16px;background:#333;border:none;border-radius:6px;color:#fff;cursor:pointer;">All</button>
      <button id="none" style="padding:8px 16px;background:#333;border:none;border-radius:6px;color:#fff;cursor:pointer;">None</button>
      <span id="cnt" style="margin-left:auto;color:#aaa;font-size:13px;">0 selected</span>
      <button id="fetch" disabled style="padding:8px 16px;background:#4a4; border:none;border-radius:6px;color:#fff;cursor:pointer;">📥 Fetch</button>
      <button id="dl" disabled style="padding:8px 16px;background:#48a; border:none;border-radius:6px;color:#fff;cursor:pointer;">💾 Download</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.querySelector('#x').onclick=close;
  ov.onclick=e=>e.target===ov&&close();
  return{ov,body:ov.querySelector('#body'),cnt:ov.querySelector('#cnt'),fetch:ov.querySelector('#fetch'),dl:ov.querySelector('#dl'),close};
};

// Render chapter list
const render=(ch,sel,cache)=>{
  const list=document.createDocumentFragment();
  ch.forEach(c=>{
    const div=document.createElement('div');
    div.style.cssText='padding:10px;background:#222;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:10px;';
    if(cache[c.id])div.style.background='#2a3a2a';
    div.innerHTML=`<input type="checkbox"${sel.has(c.id)?' checked':''} data-id="${c.id}"><div><div style="font-weight:600">Ch.${c.num}${c.title?' - '+c.title:''}</div><div style="font-size:11px;color:#aaa">${c.grp||'Unknown'}</div>${cache[c.id]?`<div style="font-size:10px;color:#4a4">✓ ${fmt(cache[c.id].size)}</div>`:''}</div>`;
    div.onclick=e=>{if(e.target.tagName!=='INPUT'){e.target.querySelector('input').click();}};
    div.querySelector('input').onchange=()=>{sel.has(c.id)?sel.delete(c.id):sel.add(c.id);updateCnt(sel,cache);};
    list.appendChild(div);
  });
  return list;
};

const updateCnt=(sel,cache)=>{
  const fetched=[...sel].filter(id=>cache[id]).length;
  document.getElementById('mdx')?.querySelector('#cnt').textContent=`${sel.size} selected (${fetched} fetched)`;
  document.getElementById('mdx')?.querySelector('#fetch').disabled=sel.size===0;
  document.getElementById('mdx')?.querySelector('#dl').disabled=fetched===0;
};

// Fetch selected chapters
const fetchCh=async(ch,sel,cache,onProg)=>{
  const todo=[...sel].map(id=>ch.find(c=>c.id===id)).filter(Boolean);
  let done=0;
  for(const c of todo){
    if(cache[c.id])continue;
    try{
      const urls=await getImages(c.id);
      const blobs=[];let size=0;
      for(let i=0;i<urls.length;i+=PAR_IMG){
        const batch=urls.slice(i,i+PAR_IMG);
        const res=await Promise.all(batch.map(u=>dlBlob(u).catch(e=>null)));
        res.forEach((b,idx)=>{if(b){blobs.push({name:`page_${String(i+idx+1).padStart(3,'0')}.jpg`,blob:b});size+=b.size;}});
        onProg?.(done,blobs.length,urls.length);
      }
      cache[c.id]={blobs,size,total:urls.length};
    }catch(e){console.warn('Failed:',c.num,e);}
    done++;onProg?.(done,todo.length,0);
    await sleep(50);
  }
};

// Download as ZIP
const download=async(ch,sel,cache,title)=>{
  await loadLibs();
  const fetched=[...sel].filter(id=>cache[id]).map(id=>ch.find(c=>c.id===id)).filter(Boolean);
  if(!fetched.length)return;
  
  let zip=new JSZip(),zipSize=0,zipIdx=1;
  const saveZip=async()=>{
    if(!zipSize)return;
    const blob=await zip.generateAsync({type:'blob',compression:'STORE'});
    saveAs(blob,`${title}_part${zipIdx++}.zip`);
    zip=new JSZip();zipSize=0;
  };
  
  for(const c of fetched){
    const data=cache[c.id];if(!data)continue;
    const folder=zip.folder(`Ch.${c.num}${c.title?' - '+c.title:''}`);
    data.blobs.forEach(b=>folder?.file(b.name,b.blob));
    zipSize+=data.size;
    if(zipSize>=MAX_ZIP)await saveZip();
  }
  await saveZip();
  alert('✅ Download complete!');
};

// Init
const init=async()=>{
  const id=getId();if(!id){alert('❌ Not a MangaDex manga page');return;}
  const{ov,body,cnt,fetch,dl,close}=ui();
  
  try{
    body.innerHTML='<div style="text-align:center;padding:40px;">⏳ Loading...</div>';
    const manga=await LOAD(`${API}/manga/${id}`);
    const title=(manga.data.attributes.title.en||manga.data.attributes.title['ja-ro']||'manga').replace(/[^a-z0-9]/gi,'').slice(0,40);
    const chapters=await getChapters(id);
    
    const sel=new Set(),cache={};
    body.innerHTML='';body.appendChild(render(chapters,sel,cache));
    
    document.getElementById('all').onclick=()=>{chapters.forEach(c=>sel.add(c.id));body.innerHTML='';body.appendChild(render(chapters,sel,cache));updateCnt(sel,cache);};
    document.getElementById('none').onclick=()=>{sel.clear();body.innerHTML='';body.appendChild(render(chapters,sel,cache));updateCnt(sel,cache);};
    
    fetch.onclick=async()=>{
      fetch.disabled=true;
      body.insertAdjacentHTML('beforeend',`<div id="prog" style="padding:8px;background:#222;border-radius:6px;font-size:12px;">⏳ Fetching...</div>`);
      await fetchCh(chapters,sel,cache,(d,t,imgTot)=>{
        const prog=document.getElementById('prog');
        if(prog)prog.textContent=`📥 Ch ${d}/${t}`+(imgTot?` | Img ${imgTot}`:'');
      });
      body.innerHTML='';body.appendChild(render(chapters,sel,cache));
      fetch.disabled=false;updateCnt(sel,cache);
      document.getElementById('prog')?.remove();
    };
    
    dl.onclick=()=>download(chapters,sel,cache,title);
    updateCnt(sel,cache);
    
  }catch(e){
    body.innerHTML=`<div style="color:#f66;text-align:center;padding:20px;">❌ ${e.message||'Error'}</div>`;
    console.error(e);
  }
};

init();
})();
