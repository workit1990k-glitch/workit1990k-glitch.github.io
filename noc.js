(function() {
  'use strict';

  const CONFIG = { 
    maxPages: 500, delayMs: 200, imgQuality: 0.75, parallelFetch: 3,
    selectors: { title: '.p-novel__title--rensai', content: '.p-novel__body' },
    epubLang: 'ja', previewPageSize: 5
  };
  
  let modal = null, metadata = {}, chapters = [], images = new Map(), imgCounter = 0;
  let previewPage = 0, translatedCache = new Map(); 

  // === UTILS ===
  const $ = (sel, ctx=document) => ctx?.querySelector(sel);
  const slug = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'novel';
  
  // 🔒 Robust XML/HTML Escaper (strips control chars, normalizes UTF-8, escapes entities)
  const escapeXml = s => {
    if (!s) return '';
    let clean = s.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE-\uFFFF]/g, '');
    return clean.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[m]));
  };
  
  const notify = (m,t='info') => {
    const d=document.createElement('div');d.textContent=m;
    d.style.cssText=`position:fixed;top:24px;left:50%;transform:translateX(-50%);background:${t==='error'?'#ff4757':t==='success'?'#00ff9d':'#4d7cff'};color:#fff;padding:12px 24px;border-radius:10px;z-index:9999999;font-weight:500;box-shadow:0 8px 25px rgba(0,0,0,0.3);transition:opacity .3s`;
    document.body.appendChild(d);setTimeout(()=>{d.style.opacity='0';setTimeout(()=>d.remove(),300);},2500);
  };
  
  const dl = (b,n) => { const u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=n;a.click();URL.revokeObjectURL(u); };

  // === MODAL ===
  function openModal(title, html) {
    if(modal) modal.remove();
    modal=document.createElement('div');modal.id='n18-modal';
    modal.style.cssText='position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:system-ui,sans-serif;';
    modal.innerHTML=`<div style="background:#1a1a2e;color:#e0e0ff;border-radius:16px;padding:24px;max-width:95vw;max-height:95vh;width:700px;display:flex;flex-direction:column;border:2px solid #00ff9d;box-shadow:0 20px 60px rgba(0,255,157,0.15);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #00ff9d33">
        <h2 style="margin:0;color:#00ff9d">${escapeXml(title)}</h2>
        <button onclick="document.getElementById('n18-modal').remove()" style="background:none;border:none;color:#ff6b6b;font-size:28px;cursor:pointer">&times;</button>
      </div><div style="overflow-y:auto;flex:1;padding-right:8px">${html}</div></div>`;
    document.body.appendChild(modal);
    modal.onclick=e=>{if(e.target===modal)modal.remove();};
    document.addEventListener('keydown',function esc(e){if(e.key==='Escape'){modal.remove();document.removeEventListener('keydown',esc);}});
  }

  // === EXTRACT TEXT & IMAGES ===
  function extractContent(chHtml, chUrl) {
    if(!chHtml) return { text: '', imgUrls: [] };
    const doc = new DOMParser().parseFromString(chHtml, 'text/html');
    const imgUrls = [];
    doc.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      if(src) imgUrls.push(new URL(src, chUrl).href);
    });
    const blocks = [];
    doc.querySelectorAll('p, div').forEach(node => {
      const txt = node.textContent?.trim();
      if(txt && txt.length > 0) blocks.push(txt);
    });
    const allText = blocks.filter(t => t.length > 0);
    let result = [...allText];
    for(const imgUrl of [...new Set(imgUrls)]) result.push(`%%IMG:${imgUrl}%%`);
    return { text: result.filter(Boolean).join('\n\n'), imgUrls: [...new Set(imgUrls)] };
  }

  // === PARALLEL FETCH ===
  async function fetchWithConcurrency(urls, concurrency) {
    const results = [];
    const executing = [];
    for(const [idx, url] of urls.entries()) {
      const promise = (async () => {
        try {
          const res = await fetch(url);
          if(!res.ok) throw new Error(`HTTP ${res.status}`);
          // 🔒 Guarantee valid UTF-8
          const buf = await res.arrayBuffer();
          const html = new TextDecoder('utf-8', {fatal: true}).decode(buf);
          return { idx, html, error: null };
        } catch(e) { return { idx, html: null, error: e.message }; }
      })();
      results[idx] = promise;
      const exec = promise.then(() => executing.splice(executing.indexOf(exec), 1));
      executing.push(exec);
      if(executing.length >= concurrency) await Promise.race(executing);
    }
    return Promise.all(results);
  }

  // === INPUT FORM ===
  function showInputForm() {
    openModal('📚 Novel Metadata', `
      <form id="n18-form" style="display:grid;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <div><label style="color:#00ff9d;font-weight:600">Title *</label><input type="text" id="n18-title" required placeholder="Novel title" style="width:100%;padding:10px;border-radius:8px;border:1px solid #00ff9d44;background:#0f0f1a;color:#fff"></div>
          <div><label style="color:#00ff9d;font-weight:600">Author</label><input type="text" id="n18-author" placeholder="Author" style="width:100%;padding:10px;border-radius:8px;border:1px solid #00ff9d44;background:#0f0f1a;color:#fff"></div>
        </div>
        <div><label style="color:#00ff9d;font-weight:600">Description</label><textarea id="n18-desc" rows="2" placeholder="Synopsis" style="width:100%;padding:10px;border-radius:8px;border:1px solid #00ff9d44;background:#0f0f1a;color:#fff;resize:vertical"></textarea></div>
        <div><label style="color:#00ff9d;font-weight:600">Tags <span style="color:#666;font-weight:400">(comma-separated)</span></label><input type="text" id="n18-tags" placeholder="fantasy, isekai" style="width:100%;padding:10px;border-radius:8px;border:1px solid #00ff9d44;background:#0f0f1a;color:#fff"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <div><label style="color:#00ff9d;font-weight:600">Start Page</label><input type="number" id="n18-start" min="1" value="1" style="width:100%;padding:10px;border-radius:8px;border:1px solid #00ff9d44;background:#0f0f1a;color:#fff"></div>
          <div><label style="color:#00ff9d;font-weight:600">End Page *</label><input type="number" id="n18-end" min="1" required placeholder="120" style="width:100%;padding:10px;border-radius:8px;border:1px solid #00ff9d44;background:#0f0f1a;color:#fff"></div>
        </div>
        <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:8px">
          <button type="button" onclick="document.getElementById('n18-modal').remove()" style="background:#444;color:#fff;border:none;padding:12px 24px;border-radius:8px;cursor:pointer">Cancel</button>
          <button type="submit" style="background:#00ff9d;color:#000;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;font-weight:700">🚀 Fetch Chapters</button>
        </div>
      </form>`);
    $('#n18-form').onsubmit = e => { e.preventDefault(); startProcess(); };
    const pt = $(CONFIG.selectors.title)?.textContent?.trim();
    if(pt) $('#n18-title').value = pt.replace(/\s*[\-～~]\s*\d+$/, '').trim();
  }

  // === FETCH & PROCESS ===
  async function startProcess() {
    metadata = { 
      title:$('#n18-title').value.trim(), author:$('#n18-author').value.trim()||'Unknown', 
      desc:$('#n18-desc').value.trim(), tags:$('#n18-tags').value.split(',').map(t=>t.trim()).filter(Boolean), 
      start:parseInt($('#n18-start').value)||1, end:parseInt($('#n18-end').value) 
    };
    if(!metadata.title||!metadata.end||metadata.end<metadata.start){notify('⚠️ Invalid input','error');return;}
    chapters=[]; images=new Map(); imgCounter=0; previewPage=0; translatedCache.clear();

    openModal('⏳ Fetching', `<div style="text-align:center;padding:40px 0"><div style="font-size:2rem;margin-bottom:16px">🔄</div><div id="p-status">Starting parallel fetch...</div><progress id="p-bar" value="0" max="100" style="width:100%;height:8px;margin:16px 0"></progress><div id="p-stats" style="color:#888;font-size:13px">Concurrency: ${CONFIG.parallelFetch}x</div></div>`);

    const total = metadata.end - metadata.start + 1;
    const urls = [];
    for(let i=metadata.start; i<=metadata.end; i++) urls.push({ page:i, url:`${CONFIG.baseURL}${i}/` });

    const results = await fetchWithConcurrency(urls.map(u=>u.url), CONFIG.parallelFetch);
    for(let i=0; i<results.length; i++) {
      const { idx, html, error } = results[i];
      const { page, url } = urls[idx];
      $('#p-bar').value = (idx/total)*50;
      $('#p-stats').textContent = `Fetched ${idx+1}/${total}`;
      if(error || !html) { chapters.push({page,title:`Ch ${page}`,html:'',imgUrls:[],url,error}); continue; }
      const doc = new DOMParser().parseFromString(html,'text/html');
      const title = doc.querySelector(CONFIG.selectors.title)?.textContent?.trim()||`Ch ${page}`;
      const contentHtml = doc.querySelector(CONFIG.selectors.content)?.innerHTML||'';
      const extracted = extractContent(contentHtml, url);
      chapters.push({page,title,html:extracted.text,imgUrls:extracted.imgUrls,url,error:null});
      await new Promise(r=>setTimeout(r, CONFIG.delayMs/2));
    }

    const allUrls = new Set();
    for(const c of chapters) if(c.imgUrls) c.imgUrls.forEach(u=>allUrls.add(u));
    const arr = Array.from(allUrls);
    if(arr.length>0){
      $('#p-status').textContent=`Converting ${arr.length} image(s)...`;
      for(let i=0;i<arr.length;i++){
        try{
          const res=await fetch(arr[i]);if(!res.ok)continue;
          const blob=await res.blob(),wb=await toWebP(blob,CONFIG.imgQuality);
          imgCounter++;
          const id=`img-${String(imgCounter).padStart(3,'0')}`;
          images.set(arr[i],{id,blob:wb,isCover:imgCounter===1});
        }catch(e){}
        $('#p-bar').value=50+((i+1)/arr.length)*50;
        $('#p-stats').textContent=`Images: ${i+1}/${arr.length}`;
      }
    }
    showResults();
  }

  async function toWebP(blob,q){return new Promise((res,rej)=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);c.toBlob(b=>{URL.revokeObjectURL(img.src);res(b);},'image/webp',q);};img.onerror=()=>{URL.revokeObjectURL(img.src);rej(new Error('Decode failed'));};img.src=URL.createObjectURL(blob);});}

  // === RESULTS UI ===
  function showResults() {
    const ok=chapters.filter(c=>!c.error&&c.html).length;
    const totalPages = Math.ceil(chapters.length / CONFIG.previewPageSize);
    
    openModal('✨ Export Ready', `
      <div style="background:#0f0f1a;padding:16px;border-radius:10px;border:1px solid #00ff9d33;margin-bottom:16px">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center">
          <div><div style="font-size:1.5rem;font-weight:700;color:#00ff9d">${chapters.length}</div><div style="font-size:12px;color:#888">Total</div></div>
          <div><div style="font-size:1.5rem;font-weight:700;color:#4ade80">${ok}</div><div style="font-size:12px;color:#888">Success</div></div>
          <div><div style="font-size:1.5rem;font-weight:700;color:#a855f7">${images.size}</div><div style="font-size:12px;color:#888">Images</div></div>
          <div><div style="font-size:1.5rem;font-weight:700;color:#fbbf24">${translatedCache.size}</div><div style="font-size:12px;color:#888">Saved</div></div>
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
        <button id="n18-copy" style="background:#00ff9d;color:#000;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:600">📋 Copy Page</button>
        <button id="n18-dl-txt" style="background:#4d7cff;color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:600">💾 TXT File</button>
        <button id="n18-epub" style="background:#a855f7;color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:700;box-shadow:0 4px 15px rgba(168,85,247,0.4)">📕 Create EPUB</button>
        <span id="n18-trans-status" style="margin-left:auto;font-size:12px;color:#888">🌐 Page ${previewPage+1}/${totalPages}</span>
      </div>
      <div style="background:#0f0f1a;padding:10px;border-radius:8px;margin-bottom:12px;font-size:12px;color:#888">💡 <strong>Auto-Save Enabled:</strong> Translate → Click Next/Prev or wait 1.5s. EPUB uses all saved translations.</div>
      <div id="n18-out" style="flex:1;overflow:auto;background:#0f0f1a;border-radius:10px;padding:16px;font-family:monospace;font-size:13px;color:#00ff9d;white-space:pre-wrap;word-break:break-word;min-height:300px;border:1px solid #00ff9d22;cursor:text;outline:none"></div>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:16px">
        <button id="n18-prev" disabled style="background:#444;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;opacity:0.5">⬅️ Prev</button>
        <button id="n18-next" style="background:#00ff9d;color:#000;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:600">Next ➡️</button>
      </div>
    `);

    renderPreviewPage();
    
    $('#n18-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('#n18-out').innerText);notify('✓ Copied');}catch{notify('❌ Failed','error');}};
    $('#n18-dl-txt').onclick=()=>{
      const fullText = chapters.map(c => `%%CH:${c.page}%%\n${c.title}\n\n${translatedCache.get(c.page)||c.html}`).join('\n\n');
      dl(new Blob([fullText],{type:'text/plain;charset=utf-8'}),`${slug(metadata.title)}_full.txt`);
    };
    $('#n18-epub').onclick=buildEPUB;
    
    $('#n18-prev').onclick=()=>{saveCurrentPageTranslations(); if(previewPage>0){previewPage--;renderPreviewPage();}};
    $('#n18-next').onclick=()=>{saveCurrentPageTranslations(); if(previewPage<totalPages-1){previewPage++;renderPreviewPage();}};

    let saveTimeout;
    $('#n18-out').oninput=()=>{clearTimeout(saveTimeout);saveTimeout=setTimeout(saveCurrentPageTranslations,1500);};
    $('#n18-out').onblur=saveCurrentPageTranslations;
  }

  function renderPreviewPage() {
    const start = previewPage * CONFIG.previewPageSize;
    const end = Math.min(start + CONFIG.previewPageSize, chapters.length);
    const pageChapters = chapters.slice(start, end);
    const totalPages = Math.ceil(chapters.length / CONFIG.previewPageSize);
    
    const textOut = pageChapters.map(c => {
      const isTranslated = translatedCache.has(c.page);
      const content = translatedCache.get(c.page) || c.html;
      const status = isTranslated ? '✅' : '🔄';
      return `%%CH:${c.page}%%\n${status} ${c.title}\n\n${content}`;
    }).join('\n\n');
    
    $('#n18-out').textContent = textOut;
    $('#n18-trans-status').textContent = `🌐 Page ${previewPage+1}/${totalPages} • ${translatedCache.size} saved`;
    
    const pBtn=$('#n18-prev'), nBtn=$('#n18-next');
    pBtn.disabled=previewPage===0; pBtn.style.opacity=previewPage===0?'0.5':'1';
    nBtn.disabled=previewPage>=totalPages-1; nBtn.style.opacity=previewPage>=totalPages-1?'0.5':'1';
  }

  function saveCurrentPageTranslations() {
    const raw = $('#n18-out').innerText.trim();
    const regex = /%%CH:(\d+)%%/g;
    let match;
    while((match = regex.exec(raw)) !== null) {
      const pageNum = parseInt(match[1]);
      const chapter = chapters.find(c => c.page === pageNum);
      if(!chapter) continue;
      
      const nextIdx = raw.indexOf('%%CH:', match.index + match[0].length);
      const block = raw.substring(match.index + match[0].length, nextIdx === -1 ? raw.length : nextIdx).trim();
      const lines = block.split('\n').filter(l => l.trim() !== '');
      if(lines.length === 0) continue;

      let titleLine = lines[0].replace(/^[✅🔄]\s*/,'').trim();
      if(!titleLine) titleLine = chapter.title;
      
      const bodyLines = lines.slice(1);
      let htmlParts = [`<h2 style="text-align:center;margin-top:0;margin-bottom:1.5em;">${escapeXml(titleLine)}</h2>`];
      
      bodyLines.forEach(line => {
        const t = line.trim();
        if(!t) return;
        const imgMatch = t.match(/%%\s*IMG:\s*(.*?)\s*%%/);
        if(imgMatch) {
          htmlParts.push(`<img src="${escapeXml(imgMatch[1])}" alt="image" style="max-width:100%;height:auto;display:block;margin:1em auto;"/>`);
        } else {
          htmlParts.push(`<p style="text-indent:1em;margin:0.5em 0;">${escapeXml(t)}</p>`);
        }
      });
      translatedCache.set(pageNum, htmlParts.join('\n'));
    }
    $('#n18-trans-status').textContent = `🌐 Page ${previewPage+1}/${Math.ceil(chapters.length/CONFIG.previewPageSize)} • ${translatedCache.size} saved ✅`;
  }

  // === EPUB GENERATION ===
  async function buildEPUB() {
    const btn=$('#n18-epub');btn.disabled=true;btn.innerHTML='⏳ Packaging...';
    try{
      saveCurrentPageTranslations();
      const {JSZip}=await loadJSZip(),zip=new JSZip();
      
      const epubChapters = chapters.map(c => ({...c, html:translatedCache.get(c.page)||c.html})).filter(c=>c.html&&!c.error);
      const slugT=slug(metadata.title),uuid='urn:uuid:'+crypto.randomUUID(),now=new Date().toISOString().split('T')[0];
      const coverId=images.size>0?images.values().next().value.id:null;

      zip.file('mimetype','application/epub+zip',{compression:'STORE'});
      zip.file('META-INF/container.xml',`<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);

      for(const ch of epubChapters){
        let html = ch.html;
        for(const [origUrl, val] of images){
          if(html.includes(origUrl)){
            const re = new RegExp(origUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            html = html.replace(re, `images/${val.id}.webp`);
          }
        }
        zip.file(`OPS/ch-${ch.page}.xhtml`,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${CONFIG.epubLang}">
<head><title>${escapeXml(ch.title)}</title><style>body{font-family:serif;line-height:1.6;}img{max-width:100%;height:auto;}</style></head>
<body><article epub:type="chapter">${html}</article></body></html>`);
      }

      if(coverId){
        const firstImg = images.get([...images.keys()][0]);
        zip.file(`OPS/images/${coverId}.webp`, firstImg.blob, {base64:false});
        zip.file('OPS/cover.xhtml',`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title><style>body{margin:0;text-align:center;background:#fff;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="images/${coverId}.webp" alt="Cover"/></body></html>`);
      }
      images.forEach(v=>{if(v.id!==coverId)zip.file(`OPS/images/${v.id}.webp`,v.blob,{base64:false});});

      const mImgs=Array.from(images.values()).map(v=>`    <item id="${v.id}" href="images/${v.id}.webp" media-type="image/webp"/>`).join('\n');
      const mChs=epubChapters.map(c=>`    <item id="ch-${c.page}" href="ch-${c.page}.xhtml" media-type="application/xhtml+xml"/>`).join('\n');
      const sChs=epubChapters.map(c=>`    <itemref idref="ch-${c.page}"/>`).join('\n');
      const tags=metadata.tags.map(t=>`<dc:subject>${escapeXml(t)}</dc:subject>`).join('\n      ');
      const coverMeta=coverId?`<meta property="cover-image" id="cover-img" refines="#${coverId}"/>`:'';
      
      zip.file('OPS/content.opf',`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier><dc:title>${escapeXml(metadata.title)}</dc:title><dc:creator>${escapeXml(metadata.author)}</dc:creator>
    <dc:language>${CONFIG.epubLang}</dc:language><dc:date>${now}</dc:date>${metadata.desc?`<dc:description>${escapeXml(metadata.desc)}</dc:description>`:''}
    ${tags}${coverMeta}<meta property="dcterms:modified">${new Date().toISOString()}</meta>
  </metadata>
  <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${coverId?`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`:''}${mImgs}${mChs}</manifest>
  <spine toc="ncx">${coverId?'<itemref idref="cover"/>':''}${sChs}</spine></package>`);

      const navLs=epubChapters.map(c=>`<li><a href="ch-${c.page}.xhtml">${escapeXml(c.title)}</a></li>`).join('\n');
      zip.file('OPS/nav.xhtml',`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>TOC</title><style>nav ol{list-style:none;padding:0}nav li{margin:0.5em 0}</style></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navLs}</ol></nav></body></html>`);
      
      const ncxPts=epubChapters.map((c,i)=>`<navPoint id="nav-${i+1}" playOrder="${i+1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="ch-${c.page}.xhtml"/></navPoint>`).join('\n');
      zip.file('OPS/toc.ncx',`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uuid}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="${epubChapters.length}"/></head><docTitle><text>${escapeXml(metadata.title)}</text></docTitle><docAuthor><text>${escapeXml(metadata.author)}</text></docAuthor><navMap>${ncxPts}</navMap></ncx>`);

      dl(await zip.generateAsync({type:'blob',mimeType:'application/epub+zip',compression:'DEFLATE',compressionOptions:{level:3},streamFiles:true}),`${slugT}_${metadata.start}-${metadata.end}.epub`);
      notify(`✓ EPUB downloaded! (${epubChapters.length} chapters, ${translatedCache.size} translated)`,'success');
    }catch(e){
      console.error('EPUB Build Error:', e);
      notify(`❌ XML Encoding Error: ${e.message}. Check console for details.`,'error');
    }finally{btn.disabled=false;btn.innerHTML='📕 Create EPUB';}
  }

  async function loadJSZip(){if(window.JSZip)return{JSZip:window.JSZip};return new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';s.onload=()=>res({JSZip:window.JSZip});s.onerror=()=>rej(new Error('JSZip load failed'));document.head.appendChild(s);});}

  const m=location.href.match(/(https:\/\/novel18\.syosetu\.com\/[a-z0-9]+\/)/i);
  if(m){CONFIG.baseURL=m[1];showInputForm();}else{notify('⚠️ Run on novel18.syosetu.com','error');}
})();
