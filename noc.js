
(function() {
  'use strict';

  // === CONFIG ===
  const CONFIG = {
    baseURL: null,
    maxPages: 500,
    delayMs: 200,
    selectors: {
      title: '.p-novel__title--rensai',
      content: '.p-novel__body'
    },
    epub: {
      lang: 'ja',
      generator: 'Novel18-EPUB-Exporter/1.0'
    }
  };

  // === STATE ===
  let results = [];
  let modal = null;
  let metadata = {};

  // === UTILITIES ===
  const $ = (sel, ctx = document) => ctx?.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx?.querySelectorAll(sel) || []);
  const escapeHTML = (str) => (str || '').replace(/[&<>"']/g, m => 
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const sanitizeXML = (str) => (str || '').replace(/[&<>"']/g, m => 
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[m]));
  const toSlug = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'novel';

  // === MODAL CREATION ===
  function createModal(mode = 'input') {
    if (modal) modal.remove();
    
    modal = document.createElement('div');
    modal.id = 'n18-epub-modal';
    modal.style.cssText = `
      position:fixed;top:0;left:0;width:100vw;height:100vh;
      background:rgba(0,0,0,0.9);display:flex;align-items:center;justify-content:center;
      z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    `;

    const isInput = mode === 'input';
    
    modal.innerHTML = `
      <div style="
        background:#1a1a2e;color:#e0e0ff;border-radius:16px;padding:24px;
        max-width:95vw;max-height:95vh;width:700px;display:flex;flex-direction:column;
        border:2px solid #00ff9d;box-shadow:0 20px 60px rgba(0,255,157,0.15);
      ">
        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #00ff9d33">
          <h2 style="margin:0;color:#00ff9d;font-size:1.4rem">
            ${isInput ? '📚 Novel Metadata' : '✨ Export Complete'}
          </h2>
          <button id="n18-close" style="background:none;border:none;color:#ff6b6b;font-size:28px;cursor:pointer;line-height:1">&times;</button>
        </div>

        <!-- Input Form -->
        ${isInput ? `
          <form id="n18-form" style="display:grid;gap:14px;overflow-y:auto;padding-right:8px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <div>
                <label style="display:block;margin-bottom:6px;font-weight:600;color:#00ff9d">Novel Title *</label>
                <input type="text" id="n18-title" required placeholder="Enter novel title" style="
                  width:100%;padding:10px 14px;border-radius:8px;border:1px solid #00ff9d44;
                  background:#0f0f1a;color:#fff;font-size:14px;box-sizing:border-box
                ">
              </div>
              <div>
                <label style="display:block;margin-bottom:6px;font-weight:600;color:#00ff9d">Author</label>
                <input type="text" id="n18-author" placeholder="Author name" style="
                  width:100%;padding:10px 14px;border-radius:8px;border:1px solid #00ff9d44;
                  background:#0f0f1a;color:#fff;font-size:14px;box-sizing:border-box
                ">
              </div>
            </div>
            
            <div>
              <label style="display:block;margin-bottom:6px;font-weight:600;color:#00ff9d">Description</label>
              <textarea id="n18-desc" rows="3" placeholder="Brief description (optional)" style="
                width:100%;padding:10px 14px;border-radius:8px;border:1px solid #00ff9d44;
                background:#0f0f1a;color:#fff;font-size:14px;resize:vertical;box-sizing:border-box
              "></textarea>
            </div>
            
            <div>
              <label style="display:block;margin-bottom:6px;font-weight:600;color:#00ff9d">Tags <span style="color:#666;font-weight:400">(comma-separated)</span></label>
              <input type="text" id="n18-tags" placeholder="fantasy, romance, isekai" style="
                width:100%;padding:10px 14px;border-radius:8px;border:1px solid #00ff9d44;
                background:#0f0f1a;color:#fff;font-size:14px;box-sizing:border-box
              ">
            </div>
            
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <div>
                <label style="display:block;margin-bottom:6px;font-weight:600;color:#00ff9d">Start Page</label>
                <input type="number" id="n18-start" min="1" value="1" style="
                  width:100%;padding:10px 14px;border-radius:8px;border:1px solid #00ff9d44;
                  background:#0f0f1a;color:#fff;font-size:14px;box-sizing:border-box
                ">
              </div>
              <div>
                <label style="display:block;margin-bottom:6px;font-weight:600;color:#00ff9d">End Page *</label>
                <input type="number" id="n18-end" min="1" required placeholder="e.g., 120" style="
                  width:100%;padding:10px 14px;border-radius:8px;border:1px solid #00ff9d44;
                  background:#0f0f1a;color:#fff;font-size:14px;box-sizing:border-box
                ">
              </div>
            </div>
            
            <div style="background:#0f0f1a;padding:12px;border-radius:8px;border-left:3px solid #00ff9d;margin-top:8px">
              <small style="color:#aaa">
                💡 Tips:<br>
                • Run on any chapter page of the novel<br>
                • Pages are fetched sequentially: Start → End<br>
                • Failed pages will be marked in output<br>
                • EPUB includes all metadata for e-readers
              </small>
            </div>
            
            <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:8px">
              <button type="button" id="n18-cancel" style="
                background:#444;color:#fff;border:none;padding:12px 24px;border-radius:8px;
                cursor:pointer;font-weight:600;transition:0.2s
              ">Cancel</button>
              <button type="submit" id="n18-submit" style="
                background:#00ff9d;color:#000;border:none;padding:12px 24px;border-radius:8px;
                cursor:pointer;font-weight:700;font-size:1.05rem;transition:0.2s;box-shadow:0 4px 15px rgba(0,255,157,0.3)
              ">🚀 Start Fetching</button>
            </div>
          </form>
        ` : `
          <!-- Results View -->
          <div id="n18-results" style="display:flex;flex-direction:column;gap:16px;overflow:hidden">
            <!-- Stats -->
            <div style="background:#0f0f1a;padding:14px;border-radius:10px;border:1px solid #00ff9d33">
              <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center">
                <div><div style="font-size:1.5rem;font-weight:700;color:#00ff9d" id="n18-stat-total">0</div><div style="font-size:12px;color:#888">Total</div></div>
                <div><div style="font-size:1.5rem;font-weight:700;color:#4ade80" id="n18-stat-ok">0</div><div style="font-size:12px;color:#888">Success</div></div>
                <div><div style="font-size:1.5rem;font-weight:700;color:#fbbf24" id="n18-stat-warn">0</div><div style="font-size:12px;color:#888">Partial</div></div>
                <div><div style="font-size:1.5rem;font-weight:700;color:#ff6b6b" id="n18-stat-err">0</div><div style="font-size:12px;color:#888">Failed</div></div>
              </div>
            </div>
            
            <!-- Actions -->
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button id="n18-copy-json" style="
                background:#00ff9d;color:#000;border:none;padding:10px 18px;border-radius:8px;
                cursor:pointer;font-weight:600;transition:0.2s;display:flex;align-items:center;gap:6px
              ">📋 Copy JSON</button>
              <button id="n18-dl-json" style="
                background:#4d7cff;color:#fff;border:none;padding:10px 18px;border-radius:8px;
                cursor:pointer;font-weight:600;transition:0.2s;display:flex;align-items:center;gap:6px
              ">💾 JSON File</button>
              <button id="n18-make-epub" style="
                background:#a855f7;color:#fff;border:none;padding:10px 18px;border-radius:8px;
                cursor:pointer;font-weight:700;transition:0.2s;display:flex;align-items:center;gap:6px;
                box-shadow:0 4px 15px rgba(168,85,247,0.4)
              ">📕 Create EPUB</button>
              <button id="n18-toggle-view" style="
                background:#6c5ce7;color:#fff;border:none;padding:10px 18px;border-radius:8px;
                cursor:pointer;font-weight:600;transition:0.2s
              ">👁 Preview</button>
            </div>
            
            <!-- Output Area -->
            <div id="n18-output" style="
              flex:1;overflow:auto;background:#0f0f1a;border-radius:10px;padding:16px;
              font-family:Consolas,Monaco,'Courier New',monospace;font-size:11px;
              line-height:1.5;white-space:pre-wrap;word-break:break-all;color:#00ff9d;
              border:1px solid #00ff9d22;min-height:200px
            "></div>
          </div>
        `}
      </div>
    `;

    document.body.appendChild(modal);

    // Event bindings
    $('#n18-close').onclick = () => modal.remove();
    if (isInput) {
      $('#n18-cancel').onclick = () => modal.remove();
      $('#n18-form').onsubmit = handleFormSubmit;
    } else {
      $('#n18-copy-json').onclick = copyJSON;
      $('#n18-dl-json').onclick = downloadJSON;
      $('#n18-make-epub').onclick = createAndDownloadEPUB;
      $('#n18-toggle-view').onclick = toggleView;
    }

    // Close on background click
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // ESC to close
    const escHandler = (e) => { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    return modal;
  }

  // === FORM HANDLING ===
  async function handleFormSubmit(e) {
    e.preventDefault();
    
    metadata = {
      title: $('#n18-title').value.trim(),
      author: $('#n18-author').value.trim() || 'Unknown',
      description: $('#n18-desc').value.trim(),
      tags: $('#n18-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      startPage: parseInt($('#n18-start').value) || 1,
      endPage: parseInt($('#n18-end').value)
    };

    // Validation
    if (!metadata.title) {
      showInlineError('n18-title', 'Title is required');
      return;
    }
    if (!metadata.endPage || metadata.endPage < metadata.startPage || metadata.endPage > CONFIG.maxPages) {
      showInlineError('n18-end', `Enter 1-${CONFIG.maxPages}`);
      return;
    }

    // Switch to fetching view
    createModal('fetching');
    await fetchChapters();
  }

  function showInlineError(fieldId, msg) {
    const field = $('#'+fieldId);
    field.style.borderColor = '#ff6b6b';
    field.style.boxShadow = '0 0 0 3px rgba(255,107,107,0.2)';
    
    const err = document.createElement('div');
    err.textContent = msg;
    err.style.cssText = 'color:#ff6b6b;font-size:12px;margin-top:4px';
    err.id = fieldId+'-err';
    field.parentNode.appendChild(err);
    
    field.onfocus = () => {
      field.style.borderColor = '';
      field.style.boxShadow = '';
      $('#'+fieldId+'-err')?.remove();
    };
  }

  // === FETCHING VIEW ===
  function createFetchingModal() {
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'n18-epub-modal';
    modal.style.cssText = `
      position:fixed;top:0;left:0;width:100vw;height:100vh;
      background:rgba(0,0,0,0.95);display:flex;align-items:center;justify-content:center;
      z-index:2147483647;font-family:sans-serif;
    `;
    modal.innerHTML = `
      <div style="background:#1a1a2e;color:#fff;border-radius:16px;padding:32px;max-width:500px;text-align:center;border:2px solid #00ff9d">
        <div style="font-size:3rem;margin-bottom:16px">🔄</div>
        <h3 style="margin:0 0 8px 0;color:#00ff9d">Fetching Chapters</h3>
        <p id="n18-fetch-status" style="color:#aaa;margin:0 0 20px 0">Initializing...</p>
        <div style="background:#0f0f1a;border-radius:10px;overflow:hidden;margin-bottom:20px">
          <div id="n18-progress-bar" style="height:8px;background:#00ff9d;width:0%;transition:width 0.3s"></div>
        </div>
        <div style="display:flex;justify-content:center;gap:20px;font-size:13px;color:#888">
          <span>✅ <b id="n18-p-ok">0</b></span>
          <span>⚠️ <b id="n18-p-warn">0</b></span>
          <span>❌ <b id="n18-p-err">0</b></span>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  function updateProgress(current, total, ok, warn, err) {
    const pct = Math.round((current/total)*100);
    $('#n18-fetch-status').textContent = `Page ${current}/${total} (${pct}%)`;
    $('#n18-progress-bar').style.width = pct+'%';
    $('#n18-p-ok').textContent = ok;
    $('#n18-p-warn').textContent = warn;
    $('#n18-p-err').textContent = err;
  }

  // === CHAPTER FETCHING ===
  function extractChapter(url, html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pageNum = parseInt(url.match(/\/(\d+)\/?$/)?.[1] || 0);
    return {
      page: pageNum,
      title: doc.querySelector(CONFIG.selectors.title)?.textContent?.trim() || `Chapter ${pageNum}`,
      content: doc.querySelector(CONFIG.selectors.content)?.innerHTML?.trim() || '',
      url: url
    };
  }

  async function fetchPage(url) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': navigator.userAgent,
          'Accept': 'text/html,application/xhtml+xml'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      return { success: true, data: extractChapter(url, html) };
    } catch (err) {
      console.warn(`Fetch failed ${url}:`, err);
      return { success: false, error: err.message, url };
    }
  }

  async function fetchChapters() {
    createFetchingModal();
    results = [];
    
    const total = metadata.endPage - metadata.startPage + 1;
    let ok = 0, warn = 0, err = 0;

    for (let i = metadata.startPage; i <= metadata.endPage; i++) {
      const url = `${CONFIG.baseURL}${i}/`;
      const result = await fetchPage(url);
      
      if (result.success) {
        results.push(result.data);
        if (result.data.content) ok++; else warn++;
      } else {
        results.push({ page: i, url, error: result.error });
        err++;
      }
      
      updateProgress(i - metadata.startPage + 1, total, ok, warn, err);
      
      if (i < metadata.endPage) {
        await new Promise(r => setTimeout(r, CONFIG.delayMs));
      }
    }

    // Show results
    createModal('results');
    updateStats();
    setOutput(JSON.stringify(results, null, 2));
  }

  // === RESULTS DISPLAY ===
  function updateStats() {
    const total = results.length;
    const ok = results.filter(r => r.content && !r.error).length;
    const partial = results.filter(r => r.title && !r.content && !r.error).length;
    const failed = results.filter(r => r.error).length;
    
    $('#n18-stat-total').textContent = total;
    $('#n18-stat-ok').textContent = ok;
    $('#n18-stat-warn').textContent = partial;
    $('#n18-stat-err').textContent = failed;
  }

  function setOutput(content, isJSON = true) {
    const el = $('#n18-output');
    if (!el) return;
    if (isJSON) {
      el.textContent = content;
      el.dataset.mode = 'json';
    } else {
      el.innerHTML = content;
      el.dataset.mode = 'preview';
    }
  }

  function toggleView() {
    const el = $('#n18-output');
    if (!el) return;
    
    if (el.dataset.mode === 'json') {
      try {
        const data = JSON.parse(el.textContent);
        const preview = data
          .filter(item => item.content || item.title)
          .map(item => `
            <div style="margin-bottom:20px;padding:16px;background:#16213e;border-radius:10px;border-left:4px solid #00ff9d">
              <h4 style="color:#00ff9d;margin:0 0 8px 0;font-size:1.1rem">📄 #${item.page}: ${escapeHTML(item.title)}</h4>
              <div style="color:#ccc;line-height:1.7;font-size:13px">${item.content || '<em style="color:#666">No content</em>'}</div>
            </div>
          `).join('<hr style="border-color:#00ff9d22;margin:20px 0">');
        setOutput(preview || '<em style="color:#666">Nothing to preview</em>', false);
      } catch {
        showNotification('⚠️ Cannot preview: Invalid JSON');
      }
    } else {
      setOutput(JSON.stringify(results, null, 2));
    }
  }

  async function copyJSON() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(results, null, 2));
      showNotification('✓ JSON copied to clipboard!');
    } catch {
      showNotification('❌ Copy failed. Select text manually.');
    }
  }

  function downloadJSON() {
    const blob = new Blob([JSON.stringify(results, null, 2)], {type: 'application/json'});
    triggerDownload(blob, `${toSlug(metadata.title)}_chapters.json`);
  }

  function showNotification(msg, type = 'info') {
    const n = document.createElement('div');
    n.textContent = msg;
    n.style.cssText = `
      position:fixed;top:24px;left:50%;transform:translateX(-50%);
      background:${type==='error'?'#ff4757':type==='success'?'#00ff9d':'#4d7cff'};
      color:#fff;padding:12px 24px;border-radius:10px;z-index:9999999;
      font-weight:500;box-shadow:0 8px 25px rgba(0,0,0,0.3);animation:slideIn 0.3s ease;
    `;
    document.body.appendChild(n);
    setTimeout(() => {
      n.style.opacity = '0';
      n.style.transition = 'opacity 0.3s';
      setTimeout(() => n.remove(), 300);
    }, 2500);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // === EPUB GENERATION ===
  async function createAndDownloadEPUB() {
    const btn = $('#n18-make-epub');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ Generating...';

    try {
      const epubBlob = await generateEPUB();
      const filename = `${toSlug(metadata.title)}_${metadata.startPage}-${metadata.endPage}.epub`;
      triggerDownload(epubBlob, filename);
      showNotification('✓ EPUB downloaded!', 'success');
    } catch (err) {
      console.error('EPUB generation failed:', err);
      showNotification('❌ EPUB error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }

  async function generateEPUB() {
    const { JSZip } = await loadJSZip();
    const zip = new JSZip();
    const slug = toSlug(metadata.title);
    const uuid = 'urn:uuid:' + crypto.randomUUID();
    const now = new Date().toISOString().split('T')[0];

    // 1. mimetype (must be first, uncompressed)
    zip.file('mimetype', 'application/epub+zip', {compression: 'STORE'});

    // 2. META-INF/container.xml
    zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    // 3. OPS/ - content files
    const chapters = results.filter(r => r.content && !r.error);
    
    // Generate chapter XHTML files
    for (const ch of chapters) {
      const chSlug = toSlug(ch.title) || `chapter-${ch.page}`;
      const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${CONFIG.epub.lang}">
<head>
  <title>${sanitizeXML(ch.title)}</title>
  <style>
    body { font-family: serif; line-height: 1.8; margin: 2em; color: #333; }
    h1 { color: #222; border-bottom: 2px solid #00ff9d; padding-bottom: 0.5em; }
    p { margin: 1em 0; text-align: justify; }
    @media (prefers-color-scheme: dark) { body { background: #1a1a2e; color: #e0e0ff; } h1 { color: #00ff9d; } }
  </style>
</head>
<body>
  <article epub:type="chapter">
    <h1>${sanitizeXML(ch.title)}</h1>
    ${ch.content}
  </article>
</body>
</html>`;
      zip.file(`OPS/${chSlug}.xhtml`, xhtml);
    }

    // 4. OPS/content.opf (package document)
    const manifestItems = chapters.map(ch => {
      const slug = toSlug(ch.title) || `chapter-${ch.page}`;
      return `    <item id="chap-${ch.page}" href="${slug}.xhtml" media-type="application/xhtml+xml"/>`;
    }).join('\n');
    
    const spineItems = chapters.map(ch => `    <itemref idref="chap-${ch.page}"/>`).join('\n');
    
    const tagsXML = metadata.tags.map(t => `<dc:subject>${sanitizeXML(t)}</dc:subject>`).join('\n      ');
    
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uuid}</dc:identifier>
    <dc:title>${sanitizeXML(metadata.title)}</dc:title>
    <dc:creator>${sanitizeXML(metadata.author)}</dc:creator>
    <dc:language>${CONFIG.epub.lang}</dc:language>
    <dc:date>${now}</dc:date>
    ${metadata.description ? `<dc:description>${sanitizeXML(metadata.description)}</dc:description>` : ''}
    ${tagsXML}
    <meta property="dcterms:modified">${new Date().toISOString()}</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifestItems}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`;
    zip.file('OPS/content.opf', opf);

    // 5. OPS/toc.ncx (legacy navigation)
    const navPoints = chapters.map((ch, idx) => `
    <navPoint id="navpoint-${idx+1}" playOrder="${idx+1}">
      <navLabel><text>${sanitizeXML(ch.title)}</text></navLabel>
      <content src="${toSlug(ch.title) || `chapter-${ch.page}`}.xhtml"/>
    </navPoint>`).join('');
    
    const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="${chapters.length}"/>
  </head>
  <docTitle><text>${sanitizeXML(metadata.title)}</text></docTitle>
  <docAuthor><text>${sanitizeXML(metadata.author)}</text></docAuthor>
  <navMap>${navPoints}
  </navMap>
</ncx>`;
    zip.file('OPS/toc.ncx', ncx);

    // 6. OPS/nav.xhtml (EPUB3 navigation)
    const navItems = chapters.map(ch => `
        <li><a href="${toSlug(ch.title) || `chapter-${ch.page}`}.xhtml">${sanitizeXML(ch.title)}</a></li>`).join('');
    
    const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${CONFIG.epub.lang}">
<head>
  <title>Table of Contents</title>
  <style>nav ol { list-style: none; padding: 0; } nav li { margin: 0.5em 0; }</style>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>${navItems}
    </ol>
  </nav>
</body>
</html>`;
    zip.file('OPS/nav.xhtml', navXhtml);

    // Generate ZIP blob
    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/epub+zip',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
  }

  // === LOAD JSZIP DYNAMICALLY ===
  async function loadJSZip() {
    if (window.JSZip) return { JSZip: window.JSZip };
    
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      script.onload = () => resolve({ JSZip: window.JSZip });
      script.onerror = () => reject(new Error('Failed to load JSZip library'));
      document.head.appendChild(script);
    });
  }

  // === INIT ===
  function init() {
    if (!location.hostname.includes('novel18.syosetu.com')) {
      createModal('input');
      showNotification('⚠️ Best used on novel18.syosetu.com', 'error');
      return;
    }
    
    const match = location.href.match(/(https:\/\/novel18\.syosetu\.com\/[a-z0-9]+\/)/i);
    if (!match) {
      createModal('input');
      showNotification('⚠️ Run on a novel chapter page', 'error');
      return;
    }
    
    CONFIG.baseURL = match[1];
    createModal('input');
    
    // Auto-fill title from page if possible
    const pageTitle = document.querySelector(CONFIG.selectors.title)?.textContent?.trim();
    if (pageTitle) {
      $('#n18-title').value = pageTitle.replace(/\s*[\-～~]\s*\d+$/, '').trim();
    }
  }

  // Start
  init();
})();
