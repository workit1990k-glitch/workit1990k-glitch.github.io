

(function() {
  'use strict';

  const CONFIG = { maxPages: 500, delayMs: 200, imgQuality: 0.75, selectors: { title: '.p-novel__title--rensai', content: '.p-novel__body' }, epubLang: 'ja' };
  let modal = null, metadata = {}, chapters = [], images = new Map(), imgCounter = 0;

  // === UTILS ===
  const $ = (sel, ctx=document) => ctx?.querySelector(sel);
  const slug = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'novel';
  const escapeHtml = s => (s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
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
        <h2 style="margin:0;color:#00ff9d">${title}</h2>
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
    
    const imgMap = {};
    const imgUrls = [];
    
    // Extract images first
    doc.querySelectorAll('img').forEach((img,i) => {
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      if(src) {
        const abs = new URL(src, chUrl).href;
        imgUrls.push(abs);
      }
    });

    // Extract text blocks (paragraphs)
    const blocks = [];
    doc.querySelectorAll('p, div, br').forEach(node => {
      const txt = node.textContent?.trim();
      if(txt && txt.length > 0) blocks.push(txt);
    });
    
    // Also catch any remaining text nodes
    const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while((node = walker.nextNode())) {
      const txt = node.textContent.trim();
      if(txt && !blocks.includes(txt)) blocks.push(txt);
    }

    // Build output with image markers
    let result = [];
    let textBuffer = [];
    
    // Simple approach: interleave text and images
    const allText = blocks.filter(t => t.length > 0);
    
    // Add text blocks
    for(const txt of allText) {
      if(txt) result.push(txt);
    }
    
    // Add image markers at end (simplified - in practice images appear inline)
    for(const imgUrl of imgUrls) {
      result.push(`%%IMG:${imgUrl}%%`);
    }

    return { text: result.filter(Boolean).join('\n\n'), imgUrls: [...new Set(imgUrls)] };
  }

  // === RESOLVE TRANSLATED DATA ===
  function resolveChaptersData() {
    const el = document.getElementById('n18-out');
    if(!el) return chapters;
    const raw = el.innerText.trim();
    const regex = /%%CH:(\d+)%%/g;
    const parts = raw.split(regex);
    
    const newData = [];
    for(let i=1; i<parts.length; i+=2) {
      const pageNum = parseInt(parts[i]);
      const block = parts[i+1] || '';
      const lines = block.trim().split('\n');
      const title = lines[0]?.trim() || `Chapter ${pageNum}`;
      const contentLines = lines.slice(1);
      
      // Build HTML from translated text
      let htmlParts = [];
      contentLines.forEach(line => {
        const trimmed = line.trim();
        if(!trimmed) return;
        // Check for image marker (Google Translate might add spaces)
        const imgMatch = trimmed.match(/%%\s*IMG:\s*(.*?)\s*%%/);
        if(imgMatch) {
          htmlParts.push(`<img src="${escapeHtml(imgMatch[1])}" alt="image"/>`);
        } else {
          htmlParts.push(`<p>${escapeHtml(trimmed)}</p>`);
        }
      });

      const orig = chapters.find(c=>c.page===pageNum);
      newData.push({page:pageNum, title, html:htmlParts.join('\n'), url:orig?.url||''});
    }
    return newData.length>0 ? newData : chapters;
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
    metadata = { title:$('#n18-title').value.trim(), author:$('#n18-author').value.trim()||'Unknown', desc:$('#n18-desc').value.trim(), tags:$('#n18-tags').value.split(',').map(t=>t.trim()).filter(Boolean), start:parseInt($('#n18-start').value)||1, end:parseInt($('#n18-end').value) };
    if(!metadata.title||!metadata.end||metadata.end<metadata.start){notify('⚠️ Invalid input','error');return;}
    chapters=[];images=new Map();imgCounter=0;

    openModal('⏳ Fetching', `<div style="text-align:center;padding:40px 0"><div style="font-size:2rem;margin-bottom:16px">🔄</div><div id="p-status">Starting...</div><progress id="p-bar" value="0" max="100" style="width:100%;height:8px;margin:16px 0"></progress><div id="p-stats" style="color:#888;font-size:13px"></div></div>`);

    const total = metadata.end - metadata.start + 1;
    let globalImgCounter = 0;

    for(let i=metadata.start;i<=metadata.end;i++){
      const url=`${CONFIG.baseURL}${i}/`;
      $('#p-status').textContent=`Page ${i-metadata.start+1}/${total}`;
      $('#p-bar').value=((i-metadata.start)/total)*100;
      try{
        const res=await fetch(url);if(!res.ok)throw new Error(`HTTP ${res.status}`);
        const html=await res.text(),doc=new DOMParser().parseFromString(html,'text/html');
        const title = doc.querySelector(CONFIG.selectors.title)?.textContent?.trim()||`Ch ${i}`;
        const contentHtml = doc.querySelector(CONFIG.selectors.content)?.innerHTML||'';
        
        // Extract plain text & images
        const extracted = extractContent(contentHtml, url);
        chapters.push({page:i,title,html:extracted.text,imgUrls:extracted.imgUrls,url,error:null});
      }catch(e){chapters.push({page:i,title:`Ch ${i}`,html:'',imgUrls:[],url,error:e.message});}
      await new Promise(r=>setTimeout(r,CONFIG.delayMs));
    }

    // Extract & Convert Images
    const allUrls = new Set();
    for(const c of chapters) if(c.imgUrls) c.imgUrls.forEach(u=>allUrls.add(u));
    const arr=Array.from(allUrls);
    
    if(arr.length>0){
      $('#p-status').textContent=`Converting ${arr.length} image(s) to WebP...`;$('#p-stats').textContent=`0/${arr.length}`;
      for(let i=0;i<arr.length;i++){
        try{
          const res=await fetch(arr[i]);if(!res.ok)continue;
          const blob=await res.blob(),wb=await toWebP(blob,CONFIG.imgQuality);
          globalImgCounter++;
          const id=`img-${String(globalImgCounter).padStart(3,'0')}`;
          images.set(arr[i],{id,blob:wb,isCover:globalImgCounter===1});
        }catch(e){}
        $('#p-bar').value=50+((i+1)/arr.length)*50;$('#p-stats').textContent=`${i+1}/${arr.length}`;
      }
    }

    showResults();
  }

  async function toWebP(blob,q){return new Promise((res,rej)=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);c.toBlob(b=>{URL.revokeObjectURL(img.src);res(b);},'image/webp',q);};img.onerror=()=>{URL.revokeObjectURL(img.src);rej(new Error('Decode failed'));};img.src=URL.createObjectURL(blob);});}

  // === RESULTS UI ===
  // === RESULTS UI (Mobile-Optimized) ===
function showResults() {
  const ok=chapters.filter(c=>!c.error&&c.html).length,fail=chapters.filter(c=>c.error).length,imgCnt=images.size;
  
  openModal('✨ Export Ready', `
    <div style="background:#0f0f1a;padding:16px;border-radius:10px;border:1px solid #00ff9d33;margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center">
        <div><div style="font-size:1.5rem;font-weight:700;color:#00ff9d">${chapters.length}</div><div style="font-size:12px;color:#888">Total</div></div>
        <div><div style="font-size:1.5rem;font-weight:700;color:#4ade80">${ok}</div><div style="font-size:12px;color:#888">Success</div></div>
        <div><div style="font-size:1.5rem;font-weight:700;color:#ff4757">${fail}</div><div style="font-size:12px;color:#888">Failed</div></div>
        <div><div style="font-size:1.5rem;font-weight:700;color:#a855f7">${imgCnt}</div><div style="font-size:12px;color:#888">Images</div></div>
      </div>
    </div>
    
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
      <button id="n18-copy" style="background:#00ff9d;color:#000;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:600">📋 Copy Text</button>
      <button id="n18-dl-txt" style="background:#4d7cff;color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:600">💾 TXT File</button>
      <button id="n18-epub" style="background:#a855f7;color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:700;box-shadow:0 4px 15px rgba(168,85,247,0.4)">📕 Create EPUB</button>
      <span id="n18-trans-status" style="margin-left:auto;font-size:12px;color:#888">🌐 Status: Original</span>
    </div>
    
    <!-- Performance Warning -->
    <div id="n18-perf-warning" style="background:#fff3cd;color:#856404;padding:10px;border-radius:6px;margin-bottom:12px;font-size:12px;display:none">
      ⚠️ Showing full text may freeze mobile devices. <button id="n18-hide-full" style="background:none;border:none;color:#0066cc;cursor:pointer;text-decoration:underline">Hide full text</button>
    </div>
    
    <div style="background:#0f0f1a;padding:8px;border-radius:6px;margin-bottom:12px;font-size:12px;color:#888">
      💡 Translate the text below. Images: %%IMG:url%%. EPUB uses translated text automatically.
    </div>
    
    <!-- Summary View (Default) -->
    <div id="n18-summary" style="background:#0f0f1a;padding:16px;border-radius:10px;margin-bottom:12px">
      <h4 style="color:#00ff9d;margin:0 0 12px 0">📋 Preview (First 3 Chapters)</h4>
      <div id="n18-preview-content" style="font-family:monospace;font-size:12px;color:#00ff9d;white-space:pre-wrap;max-height:200px;overflow:auto"></div>
      <button id="n18-show-full" style="margin-top:12px;background:#6c5ce7;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px">
        ▶ Show Full Text (${chapters.length} chapters)
      </button>
    </div>
    
    <!-- Full Text View (Hidden by Default) -->
    <textarea id="n18-out" style="display:none;width:100%;min-height:300px;background:#0f0f1a;color:#00ff9d;border:1px solid #00ff9d22;border-radius:10px;padding:12px;font-family:monospace;font-size:12px;resize:vertical;content-visibility:auto;contain-intrinsic-size:0 1000px"></textarea>
  `);

  // Generate preview (first 3 chapters)
  const previewText = chapters.slice(0,3).map(c => `%%CH:${c.page}%%\n${c.title}\n\n${c.html.substring(0,300)}...`).join('\n\n');
  $('#n18-preview-content').textContent = previewText;

  // Generate full text (but don't render yet)
  const fullText = chapters.map(c => `%%CH:${c.page}%%\n${c.title}\n\n${c.html}`).join('\n\n');

  // Event: Show Full Text
  $('#n18-show-full').onclick = () => {
    if(window.innerWidth < 768) {
      if(!confirm('📱 Mobile detected: Showing full text may cause freezing. Continue?')) return;
      $('#n18-perf-warning').style.display = 'block';
    }
    $('#n18-summary').style.display = 'none';
    $('#n18-out').style.display = 'block';
    $('#n18-out').value = fullText; // Use .value for textarea
  };
  
  // Event: Hide Full Text (from warning)
  $('#n18-hide-full')?.onclick = () => {
    $('#n18-out').style.display = 'none';
    $('#n18-summary').style.display = 'block';
    $('#n18-perf-warning').style.display = 'none';
  };

  // Copy button (works for both views)
  $('#n18-copy').onclick = async () => {
    const text = $('#n18-out').style.display !== 'none' ? $('#n18-out').value : fullText;
    try {
      await navigator.clipboard.writeText(text);
      notify('✓ Copied');
    } catch {
      notify('❌ Copy failed','error');
    }
  };
  
  // Download button
  $('#n18-dl-txt').onclick = () => {
    const text = $('#n18-out').style.display !== 'none' ? $('#n18-out').value : fullText;
    dl(new Blob([text],{type:'text/plain;charset=utf-8'}), `${slug(metadata.title)}_text.txt`);
  };
  
  $('#n18-epub').onclick = buildEPUB;
};

  // === EPUB GENERATION ===
  async function buildEPUB() {
    const btn=$('#n18-epub');btn.disabled=true;btn.innerHTML='⏳ Packaging...';
    try{
      const {JSZip}=await loadJSZip(),zip=new JSZip();
      const data = resolveChaptersData();
      const statusEl=$('#n18-trans-status');
      statusEl.textContent = data!==chapters ? '🌐 Using Translated' : '🌐 Using Original';
      statusEl.style.color = data!==chapters ? '#00ff9d' : '#fbbf24';

      const slugT=slug(metadata.title),uuid='urn:uuid:'+crypto.randomUUID(),now=new Date().toISOString().split('T')[0];
      const coverId=images.size>0?images.values().next().value.id:null;

      zip.file('mimetype','application/epub+zip',{compression:'STORE'});
      zip.file('META-INF/container.xml',`<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);

      const valid=data.filter(c=>c.html);
      for(const ch of valid){
        // HTML is already wrapped in <p> and <img> by resolveChaptersData()
        // We just need to swap URLs to local paths
        let html = ch.html;
        images.forEach((val, origUrl) => {
          const escaped = origUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          html = html.replace(new RegExp(escaped, 'g'), `images/${val.id}.webp`);
        });
        
        zip.file(`OPS/ch-${ch.page}.xhtml`,`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${CONFIG.epubLang}">
<head><title>${escapeHtml(ch.title)}</title><style></style></head>
<body><article epub:type="chapter"><h1>${escapeHtml(ch.title)}</h1>${html}</article></body></html>`);
      }

      if(coverId){
        zip.file(`OPS/images/${coverId}.webp`,images.get([...images.keys()][0]).blob,{base64:false});
        zip.file('OPS/cover.xhtml',`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title><style>body{margin:0;text-align:center;background:#fff;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="images/${coverId}.webp" alt="Cover"/></body></html>`);
      }
      images.forEach(v=>{if(v.id!==coverId)zip.file(`OPS/images/${v.id}.webp`,v.blob,{base64:false});});

      const mImgs=Array.from(images.values()).map(v=>`    <item id="${v.id}" href="images/${v.id}.webp" media-type="image/webp"/>`).join('\n');
      const mChs=valid.map(c=>`    <item id="ch-${c.page}" href="ch-${c.page}.xhtml" media-type="application/xhtml+xml"/>`).join('\n');
      const sChs=valid.map(c=>`    <itemref idref="ch-${c.page}"/>`).join('\n');
      const tags=metadata.tags.map(t=>`<dc:subject>${escapeHtml(t)}</dc:subject>`).join('\n      ');
      const coverMeta=coverId?`<meta property="cover-image" id="cover-img" refines="#${coverId}"/>`:'';
      zip.file('OPS/content.opf',`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier><dc:title>${escapeHtml(metadata.title)}</dc:title><dc:creator>${escapeHtml(metadata.author)}</dc:creator>
    <dc:language>${CONFIG.epubLang}</dc:language><dc:date>${now}</dc:date>${metadata.desc?`<dc:description>${escapeHtml(metadata.desc)}</dc:description>`:''}
    ${tags}${coverMeta}<meta property="dcterms:modified">${new Date().toISOString()}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${coverId?`    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n`:''}${mImgs}${mChs}
  </manifest>
  <spine toc="ncx">${coverId?'<itemref idref="cover"/>':''}${sChs}
  </spine>
</package>`);

      // FIX: Changed ch.title to c.title below
      const navLs=valid.map(c=>`        <li><a href="ch-${c.page}.xhtml">${escapeHtml(c.title)}</a></li>`).join('\n');
      zip.file('OPS/nav.xhtml',`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>TOC</title><style>nav ol{list-style:none;padding:0}nav li{margin:0.5em 0}</style></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navLs}</ol></nav></body></html>`);
      
      const ncxPts=valid.map((c,i)=>`    <navPoint id="nav-${i+1}" playOrder="${i+1}"><navLabel><text>${escapeHtml(c.title)}</text></navLabel><content src="ch-${c.page}.xhtml"/></navPoint>`).join('\n');
      zip.file('OPS/toc.ncx',`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uuid}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="${valid.length}"/></head><docTitle><text>${escapeHtml(metadata.title)}</text></docTitle><docAuthor><text>${escapeHtml(metadata.author)}</text></docAuthor><navMap>${ncxPts}</navMap></ncx>`);

      dl(await zip.generateAsync({type:'blob',mimeType:'application/epub+zip',compression:'DEFLATE',compressionOptions:{level:6}}),`${slugT}_${metadata.start}-${metadata.end}.epub`);
      notify('✓ EPUB downloaded!','success');
    }catch(e){console.error(e);notify('❌ EPUB Error: '+e.message,'error');}
    finally{btn.disabled=false;btn.innerHTML='📕 Create EPUB';}
  }

  async function loadJSZip(){if(window.JSZip)return{JSZip:window.JSZip};return new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';s.onload=()=>res({JSZip:window.JSZip});s.onerror=()=>rej(new Error('JSZip load failed'));document.head.appendChild(s);});}

  // === INIT ===
  const m=location.href.match(/(https:\/\/novel18\.syosetu\.com\/[a-z0-9]+\/)/i);
  if(m){CONFIG.baseURL=m[1];showInputForm();}else{notify('⚠️ Run on novel18.syosetu.com','error');}
})();
