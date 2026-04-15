// down-mangadex.js - MangaDex Downloader (Fixed & Compact)
(function(){'use strict';
if(window.mddxLoaded){console.log('✅ Already loaded');return;}
window.mddxLoaded=true;

// Config
const API='https://api.mangadex.org';
const QUALITY='data-saver'; // 'data' for original quality
const MAX_ZIP=500*1024*1024;
const PAR_CH=2;
const PAR_IMG=2;

// Helper: fetch with JSON parsing
const LOAD=async(url,options)=>{
  const res=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options?.headers}});
  if(!res.ok)throw new Error('HTTP '+res.status);
  return res.json();
};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fmtBytes=b=>b<1024?b+'B':b<1048576?(b/1024).toFixed(1)+'KB':(b/1048576).toFixed(2)+'MB';

// Extract manga UUID from MangaDex URL
const getMangaId=()=>{
  const m=location.href.match(/mangadex\.org\/title\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m?m[1]:null;
};

// Fetch all chapters for a manga (paginated, English only)
const fetchChapters=async(mangaId)=>{
  const chapters=[];
  let page=1;
  while(true){
    const url=`${API}/manga/${mangaId}/feed?limit=100&order[chapter]=desc&translatedLanguage[]=en&page=${page}`;
    const res=await LOAD(url);
    const items=res.data||[];
    if(!items.length)break;
    for(const c of items){
      const attr=c.attributes;
      chapters.push({
        id:c.id,
        num:attr.chapter||'0',
        title:attr.title||'',
        groups:(attr.groups||[]).map(g=>g.attributes?.name).filter(Boolean).join(', ')
      });
    }
    if(items.length<100)break;
    page++;
    await sleep(100); // Be nice to API
  }
  // Sort by chapter number (numeric aware)
  return chapters.sort((a,b)=>{
    const na=parseFloat(a.num),nb=parseFloat(b.num);
    if(!isNaN(na)&&!isNaN(nb))return na-nb;
    return String(a.num).localeCompare(String(b.num),undefined,{numeric:true});
  });
};

// Get image URLs for a chapter via at-home server
const fetchChapterImages=async(chapterId)=>{
  const res=await LOAD(`${API}/at-home/server/${chapterId}`);
  const chapter=res.chapter;
  const baseUrl=res.baseUrl;
  const hash=chapter.hash;
  // Use computed property to get data-saver or data array
  const files=chapter[QUALITY]||chapter.data||[];
  return files.map(f=>`${baseUrl}/${QUALITY}/${hash}/${f}`);
};

// Download a single image as blob
const downloadImage=async(url)=>{
  const res=await fetch(url);
  if(!res.ok)throw new Error('HTTP '+res.status);
  return await res.blob();
};

// Lazy-load external libraries
let JSZip,saveAs;
const loadLibs=async()=>{
  if(!JSZip){
    JSZip=await new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      s.onload=()=>resolve(window.JSZip);
      s.onerror=reject;
      document.head.appendChild(s);
    });
  }
  if(!saveAs){
    saveAs=await new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js';
      s.onload=()=>resolve(window.saveAs);
      s.onerror=reject;
      document.head.appendChild(s);
    });
  }
};

// Create overlay UI
const createUI=()=>{
  const overlay=document.createElement('div');
  overlay.id='mddx-overlay';
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif;color:#fff;';
  
  overlay.innerHTML=`
    <div style="background:#1a1a2e;max-width:800px;width:100%;max-height:95vh;overflow:hidden;border-radius:12px;display:flex;flex-direction:column;">
      <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
        <strong>📚 MangaDex Downloader</strong>
        <button id="mddx-close" style="background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;">&times;</button>
      </div>
      <div id="mddx-body" style="flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px;"></div>
      <div style="padding:12px 16px;border-top:1px solid #333;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button id="mddx-all" style="padding:8px 16px;background:#333;border:none;border-radius:6px;color:#fff;cursor:pointer;">All</button>
        <button id="mddx-none" style="padding:8px 16px;background:#333;border:none;border-radius:6px;color:#fff;cursor:pointer;">None</button>
        <span id="mddx-count" style="margin-left:auto;color:#aaa;font-size:13px;">0 selected</span>
        <button id="mddx-fetch" disabled style="padding:8px 16px;background:#4a4;border:none;border-radius:6px;color:#fff;cursor:pointer;">📥 Fetch</button>
        <button id="mddx-dl" disabled style="padding:8px 16px;background:#48a;border:none;border-radius:6px;color:#fff;cursor:pointer;">💾 Download</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  const close=()=>overlay.remove();
  document.getElementById('mddx-close').onclick=close;
  overlay.onclick=e=>{if(e.target===overlay)close();};
  
  return{
    overlay,
    body:document.getElementById('mddx-body'),
    count:document.getElementById('mddx-count'),
    fetchBtn:document.getElementById('mddx-fetch'),
    dlBtn:document.getElementById('mddx-dl'),
    close
  };
};

// Render chapter list
const renderChapters=(chapters,selected,cache)=>{
  const fragment=document.createDocumentFragment();
  
  for(const ch of chapters){
    const div=document.createElement('div');
    div.style.cssText='padding:10px;background:#222;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:10px;';
    if(cache[ch.id])div.style.background='#2a3a2a';
    
    const checked=selected.has(ch.id)?' checked':'';
    div.innerHTML=`
      <input type="checkbox"${checked} data-id="${ch.id}" style="cursor:pointer;">
      <div>
        <div style="font-weight:600">Ch.${ch.num}${ch.title?' - '+ch.title:''}</div>
        <div style="font-size:11px;color:#aaa">${ch.groups||'Unknown'}</div>
        ${cache[ch.id]?`<div style="font-size:10px;color:#4a4">✓ ${fmtBytes(cache[ch.id].size)}</div>`:''}
      </div>
    `;
    
    div.onclick=e=>{
      if(e.target.tagName!=='INPUT'){
        const cb=div.querySelector('input');
        cb.checked=!cb.checked;
        cb.onchange();
      }
    };
    
    const checkbox=div.querySelector('input');
    checkbox.onchange=()=>{
      if(checkbox.checked){
        selected.add(ch.id);
      }else{
        selected.delete(ch.id);
      }
      updateCount(selected,cache);
    };
    
    fragment.appendChild(div);
  }
  
  return fragment;
};

// Update UI counts and button states
const updateCount=(selected,cache)=>{
  const countEl=document.getElementById('mddx-count');
  const fetchBtn=document.getElementById('mddx-fetch');
  const dlBtn=document.getElementById('mddx-dl');
  
  if(!countEl||!fetchBtn||!dlBtn)return;
  
  const fetchedCount=[...selected].filter(id=>cache[id]?.blobs?.length>0).length;
  countEl.textContent=`${selected.size} selected (${fetchedCount} fetched)`;
  fetchBtn.disabled=selected.size===0;
  dlBtn.disabled=fetchedCount===0;
};

// Fetch selected chapters with progress
const fetchSelected=async(chapters,selected,cache,onProgress)=>{
  const todo=[...selected].map(id=>chapters.find(c=>c.id===id)).filter(Boolean);
  let completed=0;
  
  for(const ch of todo){
    if(cache[ch.id])continue; // Skip already fetched
    
    try{
      const urls=await fetchChapterImages(ch.id);
      const blobs=[];
      let totalSize=0;
      
      // Download images with concurrency limit
      for(let i=0;i<urls.length;i+=PAR_IMG){
        const batch=urls.slice(i,i+PAR_IMG);
        const results=await Promise.all(batch.map(url=>
          downloadImage(url).catch(err=>{console.warn('Img fail:',err);return null;})
        ));
        
        for(let j=0;j<results.length;j++){
          const blob=results[j];
          if(blob){
            const idx=i+j+1;
            blobs.push({
              name:`page_${String(idx).padStart(3,'0')}.jpg`,
              blob:blob,
              size:blob.size
            });
            totalSize+=blob.size;
          }
        }
        if(onProgress)onProgress(completed,blobs.length,urls.length);
      }
      
      cache[ch.id]={blobs,size:totalSize,total:urls.length};
      
    }catch(err){
      console.warn('Chapter failed:',ch.num,err);
      cache[ch.id]={blobs:[],size:0,total:0,error:err.message};
    }
    
    completed++;
    if(onProgress)onProgress(completed,todo.length,0);
    await sleep(50);
  }
};

// Download fetched chapters as ZIP
const downloadChapters=async(chapters,selected,cache,mangaTitle)=>{
  await loadLibs();
  
  const fetched=[...selected]
    .filter(id=>cache[id]?.blobs?.length>0)
    .map(id=>chapters.find(c=>c.id===id))
    .filter(Boolean);
  
  if(!fetched.length){
    alert('❌ No fetched chapters to download');
    return;
  }
  
  let zip=new JSZip();
  let currentSize=0;
  let partNum=1;
  
  const saveCurrentZip=async()=>{
    if(currentSize===0)return;
    const blob=await zip.generateAsync({type:'blob',compression:'STORE'});
    const filename=`${mangaTitle}_part${partNum++}.zip`;
    saveAs(blob,filename);
    zip=new JSZip();
    currentSize=0;
  };
  
  for(const ch of fetched){
    const data=cache[ch.id];
    if(!data||!data.blobs.length)continue;
    
    const folderName=`Ch.${ch.num}${ch.title?' - '+ch.title:''}`;
    const folder=zip.folder(folderName);
    
    for(const item of data.blobs){
      if(item?.name&&item?.blob){
        folder.file(item.name,item.blob);
      }
    }
    
    currentSize+=data.size;
    
    // Split ZIP if too large
    if(currentSize>=MAX_ZIP){
      await saveCurrentZip();
    }
  }
  
  await saveCurrentZip();
  alert('✅ Download complete!');
};

// Main initialization
const init=async()=>{
  const mangaId=getMangaId();
  if(!mangaId){
    alert('❌ Please open a MangaDex manga page first');
    return;
  }
  
  const ui=createUI();
  const body=ui.body;
  
  try{
    body.innerHTML='<div style="text-align:center;padding:40px;color:#aaa;">⏳ Loading manga info...</div>';
    
    // Fetch manga details
    const mangaRes=await LOAD(`${API}/manga/${mangaId}`);
    const manga=mangaRes.data;
    const titles=manga.attributes.title;
    const mangaTitle=(titles.en||titles['ja-ro']||titles['ja']||'manga')
      .replace(/[^a-z0-9\s]/gi,'')
      .trim()
      .slice(0,40)||'manga';
    
    // Fetch chapters
    const chapters=await fetchChapters(mangaId);
    
    // State
    const selected=new Set();
    const cache={};
    
    // Render UI
    body.innerHTML='';
    body.appendChild(renderChapters(chapters,selected,cache));
    
    // Button handlers
    document.getElementById('mddx-all').onclick=()=>{
      chapters.forEach(c=>selected.add(c.id));
      body.innerHTML='';
      body.appendChild(renderChapters(chapters,selected,cache));
      updateCount(selected,cache);
    };
    
    document.getElementById('mddx-none').onclick=()=>{
      selected.clear();
      body.innerHTML='';
      body.appendChild(renderChapters(chapters,selected,cache));
      updateCount(selected,cache);
    };
    
    ui.fetchBtn.onclick=async()=>{
      ui.fetchBtn.disabled=true;
      body.insertAdjacentHTML('beforeend',`<div id="mddx-progress" style="padding:8px;background:#222;border-radius:6px;font-size:12px;color:#aaa;">⏳ Fetching chapters...</div>`);
      
      await fetchSelected(chapters,selected,cache,(chDone,chTotal,imgDone,imgTotal)=>{
        const prog=document.getElementById('mddx-progress');
        if(prog){
          let text=`📥 Chapter ${chDone}/${chTotal}`;
          if(imgTotal)text+=` | Images ${imgDone}/${imgTotal}`;
          prog.textContent=text;
        }
      });
      
      // Re-render with cached data
      body.innerHTML='';
      body.appendChild(renderChapters(chapters,selected,cache));
      ui.fetchBtn.disabled=false;
      updateCount(selected,cache);
      document.getElementById('mddx-progress')?.remove();
    };
    
    ui.dlBtn.onclick=()=>downloadChapters(chapters,selected,cache,mangaTitle);
    
    updateCount(selected,cache);
    
  }catch(err){
    console.error('Init error:',err);
    body.innerHTML=`<div style="color:#f66;text-align:center;padding:20px;">❌ ${err.message||'Unknown error'}</div>`;
  }
};

// Start
init();
})();
