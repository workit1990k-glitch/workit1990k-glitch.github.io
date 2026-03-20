// down.js - Manga Downloader Script
// Loaded via bookmarklet from GitHub Raw
// Version: 2024-03-20

(function() {
  'use strict';

  // Prevent double-load
  if (window.mdxLoaded) {
    console.log('📚 Manga Downloader already loaded');
    return;
  }
  window.mdxLoaded = true;
  console.log('📚 Manga Downloader v2024-03-20 initialized');

  // ============ CONFIG ============
  const API_BASE = 'https://comix.to/api/v2';
  const HEADERS = {
    'Referer': 'https://comix.to/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };
  const WSRV_BASE = 'https://wsrv.nl/?url=';
  const WSRV_PARAMS = '&w=1080&we&q=75&output=webp';
  const MAX_ZIP_SIZE = 200 * 1024 * 1024; // 200MB per ZIP

  // ============ STATE ============
  let allChapters = [];
  let selectedChapters = new Set();
  let mangaTitle = 'manga';
  let isDownloading = false;

  // ============ UTILS ============
  const extractCode = (url) => {
    const match = url.match(/comix\.to\/title\/([^/]+)/i);
    return match ? match[1].split('-')[0] : null;
  };

  const fetchRetry = async (url, retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) {
        if (i === retries - 1) throw e;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  };

  const fetchAllChapters = async (code) => {
    const chapters = [];
    let page = 1, hasMore = true;
    
    while (hasMore) {
      try {
        const res = await fetchRetry(
          `${API_BASE}/manga/${code}/chapters?limit=100&page=${page}&order[number]=asc`
        );
        const items = res.result?.items || [];
        if (!items.length) {
          hasMore = false;
        } else {
          chapters.push(...items);
          hasMore = items.length === 100;
          page++;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (e) {
        console.warn('Failed to fetch chapters page', page, e);
        hasMore = false;
      }
    }
    
    return chapters.sort((a, b) => {
      const na = parseFloat(a.number), nb = parseFloat(b.number);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
    });
  };

  const fetchChapterImages = async (chapterId) => {
    try {
      const res = await fetchRetry(`${API_BASE}/chapters/${chapterId}/`);
      const data = res.result || res;
      let imageUrls = [];

      if (Array.isArray(data)) {
        imageUrls = data.map(i => i.image_url || i.url || i).filter(Boolean);
      } else if (data?.pages?.length) {
        imageUrls = data.pages.map(p => p.image_url || p.url || p).filter(Boolean);
      } else if (data?.images?.length) {
        imageUrls = data.images.map(i => i.image_url || i.url || i).filter(Boolean);
      } else if (data?.result) {
        return fetchChapterImages(data.result);
      }

      if (!imageUrls.length) {
        return { blobs: [], size: 0, total: 0, failed: 0 };
      }

      const blobs = [];
      let totalSize = 0, failedCount = 0;

      for (let i = 0; i < imageUrls.length; i++) {
        let url = imageUrls[i];
        url = WSRV_BASE + encodeURIComponent(url) + WSRV_PARAMS;
        const fileName = `page_${String(i + 1).padStart(3, '0')}.webp`;

        try {
          const res = await fetch(url, {
            headers: {
              'Referer': 'https://comix.to/',
              'Origin': 'https://comix.to'
            }
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          blobs.push({ fileName, blob, size: blob.size });
          totalSize += blob.size;
        } catch (e) {
          failedCount++;
          console.warn(`Failed to fetch image ${i + 1}:`, e.message);
        }
      }

      return { blobs, size: totalSize, total: imageUrls.length, failed: failedCount };
    } catch (err) {
      console.error('fetchChapterImages error:', err);
      return { blobs: [], size: 0, total: 0, failed: 0, error: err.message };
    }
  };

  // ============ UI ============
  const createOverlay = () => {
    const overlay = document.createElement('div');
    overlay.id = 'mdx-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif;';
    
    overlay.innerHTML = `
      <div id="mdx-modal" style="background:#1a1b26;color:#c0caf5;border-radius:12px;border:1px solid #414868;max-width:1000px;width:100%;max-height:95vh;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;">
        <div id="mdx-header" style="padding:16px 20px;border-bottom:1px solid #414868;display:flex;justify-content:space-between;align-items:center;background:#24283b;flex-shrink:0;">
          <strong style="font-size:16px;">📚 Manga Downloader</strong>
          <button id="mdx-close" style="background:none;border:none;color:#7982a9;font-size:24px;cursor:pointer;padding:4px 8px;">&times;</button>
        </div>
        <div id="mdx-body" style="flex:1;overflow:hidden;display:flex;flex-direction:column;">
          <div id="mdx-loading" style="text-align:center;padding:60px;color:#7982a9;">
            <div style="width:40px;height:40px;border:3px solid #414868;border-top-color:#e0af68;border-radius:50%;animation:mdx-spin 1s linear infinite;margin:0 auto 16px"></div>
            <div>Fetching chapters...</div>
          </div>
        </div>
      </div>
      <style>
        @keyframes mdx-spin { to { transform: rotate(360deg) } }
        #mdx-content { display:none; flex:1; overflow:hidden; }
        #mdx-chapters { flex:1; overflow-y:auto; padding:16px; background:#1f202e; }
        #mdx-chap-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid #414868; }
        #mdx-chap-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:8px; }
        .mdx-chap-item { display:flex; align-items:center; padding:10px 12px; background:#24283b; border-radius:6px; font-size:12px; cursor:pointer; transition:background .15s; border:1px solid transparent; user-select: none; }
        .mdx-chap-item:hover { background:#2f3549; }
        .mdx-chap-item.selected { background:rgba(224,175,104,.15); border-color:#e0af68; }
        .mdx-chap-check { width:18px; height:18px; margin-right:10px; cursor:pointer; }
        #mdx-chap-info { flex:1; pointer-events: none; }
        #mdx-chap-num { font-weight:600; color:#c0caf5; margin-bottom:2px; }
        #mdx-chap-group { font-size:10px; color:#7982a9; }
        #mdx-footer { padding:14px 20px; border-top:1px solid #414868; background:#24283b; display:flex; justify-content:space-between; align-items:center; flex-shrink:0; gap:10px; flex-wrap:wrap; }
        #mdx-actions { display:flex; gap:8px; flex-wrap:wrap; }
        .mdx-btn { padding:8px 16px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; transition:background .2s; }
        .mdx-btn-primary { background:#e0af68; color:#1a1b26; }
        .mdx-btn-primary:hover { background:#f0bf78; }
        .mdx-btn-primary:disabled { opacity:.5; cursor:not-allowed; }
        .mdx-btn-secondary { background:#2f3549; color:#c0caf5; border:1px solid #414868; }
        .mdx-btn-secondary:hover { background:#414868; }
        #mdx-count { font-size:13px; color:#7982a9; }
        #mdx-count strong { color:#e0af68; }
        #mdx-console { position:fixed; bottom:20px; right:20px; width:400px; background:#24283b; border:1px solid #414868; border-radius:8px; padding:12px; display:none; flex-direction:column; max-height:280px; z-index:100000; }
        #mdx-console.active { display:flex; }
        #mdx-console-log { flex:1; overflow-y:auto; font-family:monospace; font-size:11px; margin-bottom:8px; }
        .mdx-console-line { padding:3px 6px; margin:2px 0; border-radius:4px; }
        .mdx-console-line.info { color:#7982a9; }
        .mdx-console-line.success { color:#9ece6a; background:rgba(158,206,106,.1); }
        .mdx-console-line.error { color:#f7768e; background:rgba(247,118,142,.1); }
        #mdx-progress { height:4px; background:#1a1b26; border-radius:2px; overflow:hidden; }
        #mdx-progress-fill { height:100%; background:#9ece6a; transition:width .3s; }
      </style>
    `;
    
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('mdx-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    
    return { overlay, close };
  };

  const renderChapters = () => {
    const list = document.getElementById('mdx-chap-list');
    if (!list) return;
    list.innerHTML = '';
    
    allChapters.forEach(ch => {
      const item = document.createElement('div');
      const isSelected = selectedChapters.has(ch.chapter_id);
      item.className = 'mdx-chap-item' + (isSelected ? ' selected' : '');
      item.dataset.chapterId = ch.chapter_id;
      
      // Item click handler (toggle chapter)
      item.addEventListener('click', (e) => {
        if (e.target.type !== 'checkbox') {
          toggleChapter(ch.chapter_id);
        }
      });
      
      // Checkbox
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'mdx-chap-check';
      checkbox.checked = isSelected;
      checkbox.addEventListener('change', () => toggleChapter(ch.chapter_id));
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      
      // Chapter info
      const info = document.createElement('div');
      info.id = 'mdx-chap-info';
      info.innerHTML = `
        <div id="mdx-chap-num">Ch.${ch.number}${ch.name ? ' — ' + ch.name : ''}</div>
        <div id="mdx-chap-group">${ch.scanlation_group?.name || 'Unknown'}</div>
      `;
      
      item.appendChild(checkbox);
      item.appendChild(info);
      list.appendChild(item);
    });
  };

  const toggleChapter = (id) => {
    if (selectedChapters.has(id)) {
      selectedChapters.delete(id);
    } else {
      selectedChapters.add(id);
    }
    renderChapters();
    updateCount();
  };

  const selectAll = () => {
    allChapters.forEach(ch => selectedChapters.add(ch.chapter_id));
    renderChapters();
    updateCount();
  };

  const deselectAll = () => {
    selectedChapters.clear();
    renderChapters();
    updateCount();
  };
  
  const selectUnique = () => {
    selectedChapters.clear();
    const seen = new Map();
    
    allChapters.forEach(ch => {
      const num = parseFloat(ch.number);
      if (!isNaN(num)) {
        const intNum = Math.floor(num);
        if (!seen.has(intNum)) {
          seen.set(intNum, ch.chapter_id);
          selectedChapters.add(ch.chapter_id);
        }
      }
    });
    
    renderChapters();
    updateCount();
  };

  const updateCount = () => {
    const count = document.getElementById('mdx-selected-count');
    const btn = document.getElementById('mdx-download-btn');
    if (count) count.textContent = selectedChapters.size;
    if (btn) {
      btn.disabled = selectedChapters.size === 0;
      btn.innerHTML = `📦 DOWNLOAD (${selectedChapters.size} Ch)`;
    }
  };

  const log = (msg, type = 'info') => {
    const logEl = document.getElementById('mdx-console-log');
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = `mdx-console-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    document.getElementById('mdx-console').classList.add('active');
  };

  const updateProgress = (current, total) => {
    const fill = document.getElementById('mdx-progress-fill');
    if (fill) fill.style.width = `${(current / total) * 100}%`;
  };

  // ============ DOWNLOAD ============
  const downloadSelected = async () => {
    if (selectedChapters.size === 0 || isDownloading) return;
    
    isDownloading = true;
    const downloadBtn = document.getElementById('mdx-download-btn');
    if (downloadBtn) downloadBtn.disabled = true;
    
    document.getElementById('mdx-console').classList.add('active');
    log(`📦 Starting download: ${selectedChapters.size} chapters`, 'info');

    const selected = allChapters.filter(ch => selectedChapters.has(ch.chapter_id));
    selected.sort((a, b) => {
      const na = parseFloat(a.number), nb = parseFloat(b.number);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
    });

    let currentZip = new JSZip();
    let currentZipSize = 0;
    let zipIndex = 1;
    let rangeStart = null, rangeEnd = null;

    const saveZip = async (isFinal) => {
      if (currentZipSize === 0) return;
      
      let rangeStr = `part${zipIndex}`;
      if (rangeStart !== null && rangeEnd !== null) {
        rangeStr = `Ch${Math.floor(rangeStart)}-${Math.floor(rangeEnd)}`;
      }
      
      const zipName = `${mangaTitle} ${rangeStr}.zip`;
      log('🗜️ Generating ZIP...', 'info');
      
      try {
        const content = await currentZip.generateAsync({ 
          type: 'blob', 
          compression: 'STORE' 
        });
        saveAs(content, zipName);
        log(`✓ Saved: ${zipName}`, 'success');
      } catch (err) {
        log(`❌ ZIP save failed: ${err.message}`, 'error');
      }
      
      zipIndex++;
      currentZip = new JSZip();
      currentZipSize = 0;
      rangeStart = null;
    };

    try {
      for (let i = 0; i < selected.length; i++) {
        const ch = selected[i];
        log(`📥 Chapter ${ch.number}...`, 'info');
        
        try {
          const data = await fetchChapterImages(ch.chapter_id);
          
          if (data.blobs.length > 0) {
            const chapterNum = parseFloat(ch.number);
            if (rangeStart === null) rangeStart = chapterNum;
            rangeEnd = chapterNum;
            
            const folderName = 'Ch.' + ch.number + (ch.name ? ' - ' + ch.name : '');
            const folder = currentZip.folder(folderName);
            
            data.blobs.forEach(b => {
              if (b && b.fileName && b.blob) {
                folder.file(b.fileName, b.blob);
              }
            });
            
            currentZipSize += data.size;
            const mb = (data.size / 1024 / 1024).toFixed(1);
            log(`✓ Fetched ${data.total} images (${mb}MB)`, 'success');
          } else {
            log(`❌ Chapter ${ch.number} failed: No images`, 'error');
          }
        } catch (err) {
          log(`❌ Chapter ${ch.number} error: ${err.message}`, 'error');
        }
        
        updateProgress(i + 1, selected.length);
        
        if (currentZipSize >= MAX_ZIP_SIZE && i < selected.length - 1) {
          await saveZip(false);
        }
        
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      
      await saveZip(true);
      log('🎉 Download complete!', 'success');
      
    } catch (err) {
      log(`❌ Fatal error: ${err.message}`, 'error');
      console.error('Download error:', err);
    } finally {
      isDownloading = false;
      if (downloadBtn) downloadBtn.disabled = false;
    }
  };

  // ============ EVENT LISTENERS SETUP ============
  const setupEventListeners = () => {
    // Close button
    const closeBtn = document.getElementById('mdx-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => document.getElementById('mdx-overlay')?.remove());
    }

    // Select All button
    const btnAll = document.getElementById('mdx-btn-all');
    if (btnAll) btnAll.addEventListener('click', selectAll);

    // Deselect All button
    const btnNone = document.getElementById('mdx-btn-none');
    if (btnNone) btnNone.addEventListener('click', deselectAll);

    // Select Unique button
    const btnUnique = document.getElementById('mdx-btn-unique');
    if (btnUnique) btnUnique.addEventListener('click', selectUnique);

    // Download button
    const btnDownload = document.getElementById('mdx-download-btn');
    if (btnDownload) btnDownload.addEventListener('click', downloadSelected);

    // Overlay click to close
    const overlay = document.getElementById('mdx-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
    }
  };

  // ============ MAIN ============
  const init = async () => {
    // Load JSZip if not present
    if (typeof JSZip === 'undefined') {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load JSZip'));
        document.head.appendChild(s);
      });
    }
    
    // Load FileSaver.js if not present
    if (typeof saveAs === 'undefined') {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load FileSaver.js'));
        document.head.appendChild(s);
      });
    }

    const { overlay } = createOverlay();
    
    try {
      const url = location.href;
      const code = extractCode(url);
      
      if (!code) {
        throw new Error('Not a valid comix.to title page');
      }

      const data = await fetchRetry(`${API_BASE}/manga/${code}/`);
      const manga = data.result;
      
      if (!manga) {
        throw new Error('Manga not found');
      }
      
      mangaTitle = (manga.title || 'manga')
        .replace(/[^a-z0-9\s]/gi, '')
        .trim()
        .slice(0, 50) || 'manga';
      
      allChapters = await fetchAllChapters(code);

      document.getElementById('mdx-loading').style.display = 'none';
      
      const content = document.createElement('div');
      content.id = 'mdx-content';
      content.style.cssText = 'display:flex;flex-direction:column;height:100%;';
      content.innerHTML = `
        <div id="mdx-chapters">
          <div id="mdx-chap-header">
            <span>📖 Select Chapters (${allChapters.length} total)</span>
            <span style="font-size:11px;color:#7982a9;">Click to toggle</span>
          </div>
          <div id="mdx-chap-list"></div>
        </div>
        <div id="mdx-footer">
          <div id="mdx-actions">
            <button id="mdx-btn-all" class="mdx-btn mdx-btn-secondary">All</button>
            <button id="mdx-btn-none" class="mdx-btn mdx-btn-secondary">None</button>
            <button id="mdx-btn-unique" class="mdx-btn mdx-btn-secondary">Unique Only</button>
          </div>
          <div style="display:flex;align-items:center;gap:16px;">
            <div id="mdx-count"><strong id="mdx-selected-count">0</strong> selected</div>
            <button id="mdx-download-btn" class="mdx-btn mdx-btn-primary" disabled>
              📦 DOWNLOAD
            </button>
          </div>
        </div>
      `;
      
      document.getElementById('mdx-body').appendChild(content);
      
      const consoleEl = document.createElement('div');
      consoleEl.id = 'mdx-console';
      consoleEl.innerHTML = `
        <div id="mdx-console-log"></div>
        <div id="mdx-progress"><div id="mdx-progress-fill" style="width:0%"></div></div>
      `;
      document.body.appendChild(consoleEl);
      
      // Setup all event listeners
      setupEventListeners();
      
      // Initial render
      renderChapters();
      updateCount();
      
    } catch (err) {
      console.error('Init error:', err);
      const body = document.getElementById('mdx-body');
      if (body) {
        document.getElementById('mdx-loading').style.display = 'none';
        body.innerHTML = `
          <div style="padding:40px;color:#f7768e;text-align:center;">
            ❌ Error: ${err.message || 'Unknown error'}
          </div>
          <div style="text-align:center;margin-top:16px;">
            <button id="mdx-error-close" style="padding:10px 24px;background:#e0af68;border:none;border-radius:6px;color:#1a1b26;font-weight:600;cursor:pointer">
              Close
            </button>
          </div>
        `;
        document.getElementById('mdx-error-close')?.addEventListener('click', () => overlay?.remove());
      }
    }
  };

  // Start the app
  init();

})(); // End of IIFE
