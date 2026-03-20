// down.js - Manga Downloader Script
// Loaded via bookmarklet from GitHub Raw
// Version: 2024-03-20 (3-Chapter Parallel Fetch + Save ID + Image Progress + Scanlator Filter)

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
  const MAX_ZIP_SIZE = 500 * 1024 * 1024; // 200MB per ZIP
  const PARALLEL_IMAGES = 3; // Images per chapter
  const PARALLEL_CHAPTERS = 3; // Chapters simultaneously
  const WORKER_SAVE_URL = 'https://tiny-night-7d75.yuush.workers.dev/save';

  // ============ STATE ============
  let allChapters = [];
  let selectedChapters = new Set();
  let mangaTitle = 'manga';
  let mangaId = '';
  let latestChapter = '?';
  let isDownloading = false;
  let isFetching = false;
  let isPaused = false;
  let pauseResolve = null;
  let fetchCancelled = false;
  let chapterDataCache = new Map();
  
  // Scanlator filter state
  let selectedScanlators = new Set();
  let availableScanlators = [];

  // ============ UTILS ============
  const extractCode = (url) => {
    const match = url.match(/comix\.to\/title\/([^/]+)/i);
    return match ? match[1].split('-')[0] : null;
  };

  const extractScanlators = (chapters) => {
    const scanlators = new Set();
    chapters.forEach(ch => {
      const name = ch.scanlation_group?.name || 'Unknown';
      scanlators.add(name);
    });
    return Array.from(scanlators).sort((a, b) => a.localeCompare(b));
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

  // ============ PARALLEL DOWNLOADER (Images) ============
  const downloadWithConcurrency = async (tasks, concurrencyLimit, onImageProgress) => {
    const results = [];
    const executing = new Set();
    let completed = 0;
    
    for (let i = 0; i < tasks.length; i++) {
      if (fetchCancelled) break;
      
      const task = tasks[i];
      const promise = Promise.resolve().then(() => task()).then(result => {
        executing.delete(promise);
        completed++;
        if (onImageProgress) onImageProgress(completed, tasks.length);
        return { index: i, success: true, result };
      }).catch(error => {
        executing.delete(promise);
        completed++;
        if (onImageProgress) onImageProgress(completed, tasks.length);
        return { index: i, success: false, error };
      });
      
      results.push(promise);
      executing.add(promise);
      
      if (executing.size >= concurrencyLimit) {
        await Promise.race(executing);
      }
    }
    
    return Promise.all(results);
  };

  // ============ PARALLEL CHAPTER FETCHER ============
  const fetchChaptersParallel = async (chapters, onProgress, isRefetch = false) => {
    const results = new Map();
    const executing = new Set();
    let completed = 0;

    for (let i = 0; i < chapters.length; i++) {
      if (fetchCancelled) break;
      
      while (isPaused && !fetchCancelled) {
        await new Promise(resolve => { pauseResolve = resolve; });
      }
      if (fetchCancelled) break;

      while (executing.size >= PARALLEL_CHAPTERS) {
        await Promise.race(executing);
      }

      const chapter = chapters[i];
      const chapterNum = chapter.number;
      
      log(`📥 ${isRefetch ? 'Re-' : ''}Fetching Chapter ${chapterNum}...`, 'info');

      const promise = (async () => {
        try {
          const data = await fetchChapterImages(chapter.chapter_id, chapterNum, false);
          chapterDataCache.set(chapter.chapter_id, data);
          results.set(chapter.chapter_id, data);
          
          completed++;
          onProgress(completed, chapters.length);
          
          const mb = (data.size / 1024 / 1024).toFixed(2);
          const statusEmoji = data.status === 'success' ? '✓' : data.status === 'partial' ? '⚠' : '❌';
          log(`${statusEmoji} Chapter ${chapterNum}: ${data.total - data.failed}/${data.total} images, ${mb}MB`, 
              data.status === 'success' ? 'success' : 'error');
          
          if (data.failedDetails && data.failedDetails.length > 0) {
            data.failedDetails.slice(0, 3).forEach(fail => {
              log(`  ❌ Image ${fail.index + 1}: ${fail.error}`, 'image-fail');
            });
            if (data.failedDetails.length > 3) {
              log(`  ... and ${data.failedDetails.length - 3} more failed`, 'image-fail');
            }
          }
          
          renderChapters();
          updateCount();
        } catch (err) {
          log(`❌ Chapter ${chapterNum} error: ${err.message}`, 'error');
          chapterDataCache.set(chapter.chapter_id, { 
            blobs: [], size: 0, total: 0, failed: 0, status: 'error', error: err.message, failedDetails: [] 
          });
          results.set(chapter.chapter_id, null);
          completed++;
          onProgress(completed, chapters.length);
          renderChapters();
          updateCount();
        }
      })();

      executing.add(promise);
      promise.finally(() => executing.delete(promise));
    }

    await Promise.all(executing);
    return results;
  };

  const fetchChapterImages = async (chapterId, chapterNum, showLog = true) => {
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
        return fetchChapterImages(data.result, showLog);
      }

      if (!imageUrls.length) {
        return { blobs: [], size: 0, total: 0, failed: 0, status: 'empty', failedDetails: [] };
      }

      let downloadedCount = 0;
      
      const downloadTasks = imageUrls.map((originalUrl, index) => async () => {
        let url = WSRV_BASE + encodeURIComponent(originalUrl) + WSRV_PARAMS;
        const fileName = `page_${String(index + 1).padStart(3, '0')}.webp`;

        try {
          const res = await fetch(url, {
            headers: {
              'Referer': 'https://comix.to/',
              'Origin': 'https://comix.to'
            }
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          
          downloadedCount++;
          // Log image progress: every 5 images or on completion
          if (showLog && (downloadedCount % 5 === 0 || downloadedCount === imageUrls.length)) {
            const imgWord = downloadedCount === 1 ? 'image' : 'images';
            log(`🖼️ Chapter ${chapterNum}: ${downloadedCount}/${imageUrls.length} ${imgWord} downloaded`, 'image-success');
          }
          
          return { fileName, blob, size: blob.size, index, success: true };
        } catch (e) {
          return { 
            fileName, 
            index, 
            success: false, 
            error: e.message,
            originalUrl: originalUrl.substring(0, 100)
          };
        }
      });

      const results = await downloadWithConcurrency(
        downloadTasks, 
        PARALLEL_IMAGES,
        (completed, total) => {
          // Optional: Update visual progress bar per chapter
          if (showLog && completed % 10 === 0 && completed < total) {
            const imgWord = completed === 1 ? 'image' : 'images';
            log(`⏳ Chapter ${chapterNum}: ${completed}/${total} ${imgWord}...`, 'info');
          }
        }
      );
      
      const blobs = [];
      let totalSize = 0;
      const failedDetails = [];

      results.forEach(result => {
        if (result.success && result.result.success) {
          const r = result.result;
          blobs.push({ fileName: r.fileName, blob: r.blob, size: r.size });
          totalSize += r.size;
        } else {
          const errorResult = result.success ? result.result : result.error;
          failedDetails.push({
            index: result.index,
            fileName: errorResult.fileName,
            error: errorResult.error || 'Unknown error',
            url: errorResult.originalUrl || 'N/A'
          });
        }
      });

      const failedCount = failedDetails.length;
      const status = failedCount === 0 ? 'success' : (blobs.length > 0 ? 'partial' : 'failed');
      
      return { 
        blobs, 
        size: totalSize, 
        total: imageUrls.length, 
        failed: failedCount,
        failedDetails,
        status 
      };
    } catch (err) {
      console.error('fetchChapterImages error:', err);
      return { blobs: [], size: 0, total: 0, failed: 0, status: 'error', error: err.message, failedDetails: [] };
    }
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // ============ SAVE ID TO LIST ============
  const saveMangaToList = async () => {
    if (!mangaId || !latestChapter) {
      log('❌ No manga ID or chapter info available', 'error');
      return false;
    }

    try {
      log('💾 Saving manga ID to list...', 'info');
      
      const response = await fetch(WORKER_SAVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: mangaId,
          latest_chapter: latestChapter
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        log(`✓ Saved ${mangaId}:${latestChapter} to list!`, 'success');
        showToast(`✓ ${mangaId}:${latestChapter} saved!`);
        return true;
      } else {
        throw new Error(result.error || 'Save failed');
      }
    } catch (err) {
      log(`❌ Save failed: ${err.message}`, 'error');
      showToast(`✗ Save failed: ${err.message}`);
      return false;
    }
  };

  const showToast = (msg) => {
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;top:20px;right:20px;background:#24283b;border:1px solid #9ece6a;border-radius:8px;padding:12px 20px;color:#c0caf5;font-size:13px;z-index:3000;box-shadow:0 4px 20px rgba(0,0,0,0.4);animation:slideIn 0.3s ease;`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { 
      toast.style.opacity = '0'; 
      toast.style.transition = 'opacity 0.3s'; 
      setTimeout(() => toast.remove(), 300); 
    }, 3000);
  };

  // ============ UI ============
  const createOverlay = () => {
    const overlay = document.createElement('div');
    overlay.id = 'mdx-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif;';
    
    overlay.innerHTML = `
      <div id="mdx-modal" style="background:#1a1b26;color:#c0caf5;border-radius:12px;border:1px solid #414868;max-width:1000px;width:100%;max-height:95vh;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;">
        <div id="mdx-header" style="padding:16px 20px;border-bottom:1px solid #414868;display:flex;justify-content:space-between;align-items:center;background:#24283b;flex-shrink:0;flex-wrap:wrap;gap:8px;">
          <strong style="font-size:16px;">📚 Manga Downloader</strong>
          <button id="mdx-close" style="background:none;border:none;color:#7982a9;font-size:24px;cursor:pointer;padding:4px 8px;">&times;</button>
        </div>
        <div id="mdx-body" style="flex:1;overflow:hidden;display:flex;flex-direction:column;">
          <div id="mdx-loading" style="text-align:center;padding:60px;color:#7982a9;">
            <div style="width:40px;height:40px;border:3px solid #414868;border-top-color:#e0af68;border-radius:50%;animation:mdx-spin 1s linear infinite;margin:0 auto 16px"></div>
            <div>Fetching chapter list...</div>
          </div>
        </div>
      </div>
      <style>
        @keyframes mdx-spin { to { transform: rotate(360deg) } }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        #mdx-content { display:none; flex:1; overflow:hidden; }
        #mdx-chapters { flex:1; overflow-y:auto; padding:16px; background:#1f202e; }
        #mdx-chap-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:12px; border-bottom:1px solid #414868; flex-wrap:wrap; gap:8px; }
        #mdx-chap-list { display:flex; flex-direction:column; gap:8px; }
        .mdx-chap-item { display:flex; flex-direction:column; padding:12px 14px; background:#24283b; border-radius:8px; font-size:12px; cursor:pointer; transition:background .15s; border:1px solid transparent; }
        .mdx-chap-item:hover { background:#2f3549; }
        .mdx-chap-item.selected { border-color:#e0af68; }
        .mdx-chap-item.fetched { background:#2a303c; }
        .mdx-chap-item.fetching { opacity:0.6; pointer-events:none; }
        .mdx-chap-row { display:flex; align-items:center; width:100%; }
        .mdx-chap-check { width:18px; height:18px; margin-right:12px; cursor:pointer; }
        #mdx-chap-info { flex:1; pointer-events: none; }
        #mdx-chap-num { font-weight:600; color:#c0caf5; margin-bottom:4px; }
        #mdx-chap-group { font-size:10px; color:#7982a9; }
        .mdx-chap-scanlator { font-size:10px; color:#9ece6a; margin-top:2px; }
        #mdx-chap-status { margin-top:10px; padding:10px; background:#1a1b26; border-radius:6px; font-size:11px; }
        .mdx-status-success { color:#9ece6a; }
        .mdx-status-partial { color:#e0af68; }
        .mdx-status-failed { color:#f7768e; }
        .mdx-failed-list { margin-top:8px; padding:8px; background:#1f202e; border-radius:4px; max-height:100px; overflow-y:auto; }
        .mdx-failed-item { padding:4px 6px; margin:2px 0; background:#2a303c; border-radius:3px; font-size:10px; color:#f7768e; }
        .mdx-refetch-btn { margin-top:8px; padding:6px 12px; background:#f7768e; color:#1a1b26; border:none; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer; }
        .mdx-refetch-btn:hover { background:#ff8fa3; }
        .mdx-refetch-btn:disabled { opacity:0.5; cursor:not-allowed; }
        #mdx-footer { padding:14px 20px; border-top:1px solid #414868; background:#24283b; display:flex; justify-content:space-between; align-items:center; flex-shrink:0; gap:10px; flex-wrap:wrap; }
        #mdx-actions { display:flex; gap:8px; flex-wrap:wrap; }
        .mdx-btn { padding:10px 18px; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer; transition:background .2s; }
        .mdx-btn-primary { background:#e0af68; color:#1a1b26; }
        .mdx-btn-primary:hover { background:#f0bf78; }
        .mdx-btn-primary:disabled { opacity:.5; cursor:not-allowed; }
        .mdx-btn-secondary { background:#2f3549; color:#c0caf5; border:1px solid #414868; }
        .mdx-btn-secondary:hover { background:#414868; }
        .mdx-btn-success { background:#9ece6a; color:#1a1b26; }
        .mdx-btn-success:hover { background:#b5e38a; }
        .mdx-btn-save { background:#007bff; color:#fff; }
        .mdx-btn-save:hover { background:#0056b3; }
        .mdx-btn-pause { background:#e0af68; color:#1a1b26; display:none; }
        .mdx-btn-pause:hover { background:#f0bf78; }
        #mdx-count { font-size:13px; color:#7982a9; }
        #mdx-count strong { color:#e0af68; }
        #mdx-total-size { font-size:13px; color:#7982a9; margin-left:12px; }
        #mdx-total-size strong { color:#9ece6a; }
        #mdx-console { position:fixed; bottom:500px; right:20px; width:200px; background:#24283b; border:1px solid #414868; border-radius:8px; padding:12px; display:none; flex-direction:column; max-height:300px; z-index:100000; }
        #mdx-console.active { display:flex; }
        #mdx-console-log { flex:1; overflow-y:auto; font-family:monospace; font-size:10px; margin-bottom:8px; }
        .mdx-console-line { padding:3px 6px; margin:2px 0; border-radius:4px; }
        .mdx-console-line.info { color:#7982a9; }
        .mdx-console-line.success { color:#9ece6a; background:rgba(158,206,106,.1); }
        .mdx-console-line.error { color:#f7768e; background:rgba(247,118,142,.1); }
        .mdx-console-line.image-success { color:#9ece6a; font-size:9px; }
        .mdx-console-line.image-fail { color:#f7768e; font-size:9px; }
        #mdx-progress { height:4px; background:#1a1b26; border-radius:2px; overflow:hidden; }
        #mdx-progress-fill { height:100%; background:#9ece6a; transition:width .3s; }
        .mdx-parallel-info { font-size:10px; color:#7982a9; margin-top:4px; }
        #mdx-save-status { font-size:11px; margin-left:8px; }
        #mdx-save-status.success { color:#9ece6a; }
        #mdx-save-status.error { color:#f7768e; }
        .mdx-batch-summary { background:#2f3549; padding:10px; border-radius:6px; margin-top:10px; font-size:12px; color:#7982a9; display:none; }
        .mdx-batch-summary.active { display:block; }
        .mdx-batch-summary strong { color:#c0caf5; }
        .mdx-scanlator-chip { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; background:#2f3549; border:1px solid #414868; border-radius:16px; font-size:10px; color:#c0caf5; cursor:pointer; transition:all 0.15s; user-select:none; }
        .mdx-scanlator-chip:hover { background:#414868; }
        .mdx-scanlator-chip.active { background:#e0af68; color:#1a1b26; border-color:#f0bf78; font-weight:600; }
        .mdx-scanlator-chip input { display:none; }
        .mdx-scanlator-count { font-size:9px; color:#7982a9; background:#1a1b26; padding:2px 6px; border-radius:10px; }
        .mdx-image-progress { font-size:10px; color:#7982a9; margin-top:6px; display:flex; align-items:center; gap:6px; }
        .mdx-image-bar { flex:1; height:4px; background:#1a1b26; border-radius:2px; overflow:hidden; }
        .mdx-image-fill { height:100%; background:#7aa2f7; transition:width 0.2s; }
      </style>
    `;
    
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('mdx-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    
    return { overlay, close };
  };

  const renderScanlatorFilters = () => {
    const container = document.getElementById('mdx-scanlator-filters');
    if (!container) return;
    
    container.innerHTML = '';
    
    availableScanlators.forEach(scanlator => {
      const chip = document.createElement('label');
      chip.className = 'mdx-scanlator-chip' + (selectedScanlators.has(scanlator) ? ' active' : '');
      
      const count = allChapters.filter(ch => 
        (ch.scanlation_group?.name || 'Unknown') === scanlator
      ).length;
      
      chip.innerHTML = `
        <input type="checkbox" value="${scanlator}" ${selectedScanlators.has(scanlator) ? 'checked' : ''}>
        <span>${scanlator}</span>
        <span class="mdx-scanlator-count">${count}</span>
      `;
      
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        toggleScanlator(scanlator);
      });
      
      container.appendChild(chip);
    });
    
    if (availableScanlators.length > 1) {
      const allChip = document.createElement('label');
      allChip.className = 'mdx-scanlator-chip' + (selectedScanlators.size === 0 ? ' active' : '');
      allChip.innerHTML = `<input type="checkbox"> <span>🌐 All</span>`;
      allChip.addEventListener('click', (e) => {
        e.preventDefault();
        clearScanlatorFilter();
      });
      container.insertBefore(allChip, container.firstChild);
    }
  };

  const toggleScanlator = (name) => {
    if (selectedScanlators.has(name)) {
      selectedScanlators.delete(name);
    } else {
      selectedScanlators.add(name);
    }
    renderScanlatorFilters();
    renderChapters();
  };

  const clearScanlatorFilter = () => {
    selectedScanlators.clear();
    renderScanlatorFilters();
    renderChapters();
  };

  const isChapterFiltered = (chapter) => {
    if (selectedScanlators.size === 0) return true;
    const chapScanlator = chapter.scanlation_group?.name || 'Unknown';
    return selectedScanlators.has(chapScanlator);
  };

  const selectByScanlator = () => {
    if (isFetching) return;
    selectedChapters.clear();
    
    allChapters.forEach(ch => {
      if (isChapterFiltered(ch)) {
        selectedChapters.add(ch.chapter_id);
      }
    });
    
    renderChapters();
    updateCount();
  };

  const renderChapters = () => {
    const list = document.getElementById('mdx-chap-list');
    if (!list) return;
    list.innerHTML = '';
    
    allChapters.forEach(ch => {
      const item = document.createElement('div');
      const isSelected = selectedChapters.has(ch.chapter_id);
      const cacheData = chapterDataCache.get(ch.chapter_id);
      const isFiltered = isChapterFiltered(ch);
      
      item.className = 'mdx-chap-item' + 
        (isSelected ? ' selected' : '') + 
        (cacheData ? ' fetched' : '') +
        (isFetching && isSelected ? ' fetching' : '');
      
      if (!isFiltered) {
        item.style.opacity = '0.5';
        item.style.pointerEvents = 'none';
      }
      
      item.dataset.chapterId = ch.chapter_id;
      
      item.addEventListener('click', (e) => {
        if (isFiltered && e.target.type !== 'checkbox' && !e.target.classList.contains('mdx-refetch-btn')) {
          toggleChapter(ch.chapter_id);
        }
      });
      
      const row = document.createElement('div');
      row.className = 'mdx-chap-row';
      
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'mdx-chap-check';
      checkbox.checked = isSelected;
      checkbox.disabled = isFetching || !isFiltered;
      checkbox.addEventListener('change', () => toggleChapter(ch.chapter_id));
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      
      const info = document.createElement('div');
      info.id = 'mdx-chap-info';
      info.innerHTML = `
        <div id="mdx-chap-num">Ch.${ch.number}${ch.name ? ' — ' + ch.name : ''}</div>
        <div id="mdx-chap-group">${ch.scanlation_group?.name || 'Unknown'}</div>
        <div class="mdx-chap-scanlator">🏷️ ${ch.scanlation_group?.name || 'Unknown'}</div>
      `;
      
      row.appendChild(checkbox);
      row.appendChild(info);
      item.appendChild(row);
      
      if (cacheData) {
        const statusDiv = document.createElement('div');
        statusDiv.id = 'mdx-chap-status';
        
        const statusClass = cacheData.status === 'success' ? 'mdx-status-success' :
                           cacheData.status === 'partial' ? 'mdx-status-partial' : 'mdx-status-failed';
        
        const sizeText = formatBytes(cacheData.size);
        const successCount = cacheData.total - cacheData.failed;
        const successText = `${successCount}/${cacheData.total} images`;
        const failText = cacheData.failed > 0 ? ` (${cacheData.failed} failed)` : '';
        
        statusDiv.innerHTML = `
          <div class="${statusClass}">
            <strong>✓ ${cacheData.status.toUpperCase()}</strong> 
            | 🏷️ ${ch.scanlation_group?.name || 'Unknown'}
            | ${sizeText} | ${successText}${failText}
          </div>
        `;
        
        if (cacheData.failedDetails && cacheData.failedDetails.length > 0) {
          const failedList = document.createElement('div');
          failedList.className = 'mdx-failed-list';
          failedList.innerHTML = '<strong style="color:#f7768e">Failed Images:</strong>';
          
          cacheData.failedDetails.slice(0, 5).forEach(fail => {
            const failItem = document.createElement('div');
            failItem.className = 'mdx-failed-item';
            failItem.textContent = `Page ${fail.index + 1}: ${fail.error}`;
            failedList.appendChild(failItem);
          });
          
          if (cacheData.failedDetails.length > 5) {
            const moreItem = document.createElement('div');
            moreItem.className = 'mdx-failed-item';
            moreItem.textContent = `... and ${cacheData.failedDetails.length - 5} more`;
            failedList.appendChild(moreItem);
          }
          
          statusDiv.appendChild(failedList);
        }
        
        if (cacheData.failed > 0) {
          const refetchBtn = document.createElement('button');
          refetchBtn.className = 'mdx-refetch-btn';
          refetchBtn.textContent = `🔄 Re-fetch ${cacheData.failed} Failed Images`;
          refetchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            refetchChapter(ch.chapter_id);
          });
          statusDiv.appendChild(refetchBtn);
        }
        
        item.appendChild(statusDiv);
      }
      
      // Show image progress bar for actively fetching chapters
      if (isFetching && isSelected && !cacheData && isFiltered) {
        const progressDiv = document.createElement('div');
        progressDiv.className = 'mdx-image-progress';
        progressDiv.id = `mdx-img-progress-${ch.chapter_id}`;
        progressDiv.innerHTML = `
          <span>🖼️ Loading...</span>
          <div class="mdx-image-bar"><div class="mdx-image-fill" style="width:0%"></div></div>
          <span id="mdx-img-count-${ch.chapter_id}">0/0</span>
        `;
        item.appendChild(progressDiv);
      }
      
      list.appendChild(item);
    });
  };

  const updateImageProgress = (chapterId, downloaded, total) => {
    const fill = document.querySelector(`#mdx-img-progress-${chapterId} .mdx-image-fill`);
    const count = document.getElementById(`mdx-img-count-${chapterId}`);
    if (fill) fill.style.width = `${(downloaded / total) * 100}%`;
    if (count) count.textContent = `${downloaded}/${total}`;
  };

  const toggleChapter = (id) => {
    if (isFetching) return;
    
    if (selectedChapters.has(id)) {
      selectedChapters.delete(id);
    } else {
      selectedChapters.add(id);
    }
    renderChapters();
    updateCount();
  };

  const selectAll = () => {
    if (isFetching) return;
    allChapters.forEach(ch => {
      if (isChapterFiltered(ch)) {
        selectedChapters.add(ch.chapter_id);
      }
    });
    renderChapters();
    updateCount();
  };

  const deselectAll = () => {
    if (isFetching) return;
    selectedChapters.clear();
    renderChapters();
    updateCount();
  };
  
  const selectUnique = () => {
    if (isFetching) return;
    selectedChapters.clear();
    const seen = new Map();
    
    allChapters.forEach(ch => {
      if (!isChapterFiltered(ch)) return;
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
    const btnFetch = document.getElementById('mdx-fetch-btn');
    const btnDownload = document.getElementById('mdx-download-btn');
    const btnPause = document.getElementById('mdx-pause-btn');
    const totalSize = document.getElementById('mdx-total-size');
    
    if (count) count.textContent = selectedChapters.size;
    
    let fetchedSize = 0;
    let fetchedCount = 0;
    let failedCount = 0;
    
    selectedChapters.forEach(id => {
      const cacheData = chapterDataCache.get(id);
      if (cacheData && cacheData.blobs.length > 0) {
        fetchedSize += cacheData.size;
        fetchedCount++;
      }
      if (cacheData && (cacheData.status === 'partial' || cacheData.status === 'failed')) {
        failedCount++;
      }
    });
    
    if (totalSize) {
      totalSize.innerHTML = fetchedCount > 0 
        ? `Total: <strong>${formatBytes(fetchedSize)}</strong> (${fetchedCount}/${selectedChapters.size} fetched)`
        : '';
    }
    
    if (btnFetch) {
      btnFetch.disabled = selectedChapters.size === 0 || isFetching;
      btnFetch.textContent = isFetching ? '⏳ FETCHING...' : `📥 FETCH (${selectedChapters.size} Ch)`;
    }
    
    if (btnPause) {
      btnPause.style.display = isFetching ? 'inline-block' : 'none';
      btnPause.textContent = isPaused ? '▶ RESUME' : '⏸ PAUSE';
    }
    
    if (btnDownload) {
      btnDownload.disabled = fetchedCount === 0 || isDownloading;
      btnDownload.textContent = isDownloading ? '⏳ DOWNLOADING...' : `📦 DOWNLOAD (${fetchedCount} Ch)`;
    }
    
    const btnRefetchAll = document.getElementById('mdx-refetch-all-btn');
    if (btnRefetchAll) {
      btnRefetchAll.disabled = failedCount === 0 || isFetching;
      btnRefetchAll.textContent = failedCount > 0 ? `🔄 REFETCH ALL FAILED (${failedCount})` : '🔄 REFETCH ALL FAILED';
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

  // ============ FETCH SELECTED (3 PARALLEL CHAPTERS) ============
  const fetchSelected = async () => {
    if (selectedChapters.size === 0 || isFetching) return;
    
    isFetching = true;
    isPaused = false;
    fetchCancelled = false;
    renderChapters();
    updateCount();
    document.getElementById('mdx-console').classList.add('active');
    
    const selected = allChapters.filter(ch => selectedChapters.has(ch.chapter_id) && isChapterFiltered(ch));
    selected.sort((a, b) => {
      const na = parseFloat(a.number), nb = parseFloat(b.number);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
    });

    log(`📥 Starting fetch: ${selected.length} chapters (${PARALLEL_CHAPTERS} parallel)`, 'info');
    log(`⚡ ${PARALLEL_IMAGES} parallel images per chapter`, 'info');

    try {
      await fetchChaptersParallel(selected, (completed, total) => {
        updateProgress(completed, total);
      }, false);
      
      const successCount = [...selectedChapters].filter(id => {
        const cacheData = chapterDataCache.get(id);
        return cacheData && cacheData.status === 'success';
      }).length;
      
      const totalImages = [...selectedChapters].reduce((sum, id) => {
        const cacheData = chapterDataCache.get(id);
        return sum + (cacheData ? cacheData.total - cacheData.failed : 0);
      }, 0);
      
      const totalFailed = [...selectedChapters].reduce((sum, id) => {
        const cacheData = chapterDataCache.get(id);
        return sum + (cacheData ? cacheData.failed : 0);
      }, 0);
      
      log(`🎉 Fetch complete! ${successCount}/${selected.length} chapters, ${totalImages} images, ${totalFailed} failed`, 'success');
      
      const summary = document.getElementById('mdx-batch-summary');
      if (summary) {
        summary.innerHTML = `<strong>Fetch Summary:</strong> ${successCount} chapters ready. ${totalFailed} images failed.`;
        summary.classList.add('active');
      }
      
    } catch (err) {
      log(`❌ Fetch error: ${err.message}`, 'error');
      console.error('Fetch error:', err);
    } finally {
      isFetching = false;
      isPaused = false;
      renderChapters();
      updateCount();
    }
  };

  // ============ REFETCH ALL FAILED ============
  const refetchAllFailed = async () => {
    const failedChapters = [];
    selectedChapters.forEach(id => {
      const cacheData = chapterDataCache.get(id);
      if (cacheData && (cacheData.status === 'partial' || cacheData.status === 'failed')) {
        const ch = allChapters.find(c => c.chapter_id === id);
        if (ch && isChapterFiltered(ch)) failedChapters.push(ch);
      }
    });
    
    if (failedChapters.length === 0) {
      log('❌ No failed chapters to refetch', 'error');
      return;
    }
    
    isFetching = true;
    isPaused = false;
    fetchCancelled = false;
    renderChapters();
    updateCount();
    document.getElementById('mdx-console').classList.add('active');
    
    log(`🔄 Starting refetch: ${failedChapters.length} failed chapters (${PARALLEL_CHAPTERS} parallel)`, 'info');

    try {
      await fetchChaptersParallel(failedChapters, (completed, total) => {
        updateProgress(completed, total);
      }, true);
      
      log(`🎉 Refetch complete!`, 'success');
      
    } catch (err) {
      log(`❌ Refetch error: ${err.message}`, 'error');
    } finally {
      isFetching = false;
      isPaused = false;
      renderChapters();
      updateCount();
    }
  };

  // ============ REFETCH SINGLE CHAPTER ============
  const refetchChapter = async (chapterId) => {
    const ch = allChapters.find(c => c.chapter_id === chapterId);
    if (!ch) return;
    
    log(`🔄 Re-fetching Chapter ${ch.number}...`, 'info');
    
    try {
      const data = await fetchChapterImages(chapterId, ch.number, true);
      chapterDataCache.set(chapterId, data);
      
      const mb = (data.size / 1024 / 1024).toFixed(2);
      const statusEmoji = data.status === 'success' ? '✓' : '⚠';
      
      if (data.failedDetails && data.failedDetails.length > 0) {
        data.failedDetails.forEach(fail => {
          log(`  ❌ Image ${fail.index + 1} (${fail.fileName}): ${fail.error}`, 'image-fail');
        });
      }
      
      log(`${statusEmoji} Chapter ${ch.number} re-fetched: ${data.total - data.failed}/${data.total} images, ${mb}MB`, 
          data.status === 'success' ? 'success' : 'error');
      
      renderChapters();
      updateCount();
      
    } catch (err) {
      log(`❌ Re-fetch error: ${err.message}`, 'error');
    }
  };

  // ============ TOGGLE PAUSE ============
  const togglePause = () => {
    if (!isFetching) return;
    isPaused = !isPaused;
    
    if (isPaused) {
      log('⏸ Fetching paused', 'warning');
      if (pauseResolve) pauseResolve();
    } else {
      log('▶ Fetching resumed', 'info');
    }
    
    updateCount();
  };

  // ============ DOWNLOAD ============
  const downloadSelected = async () => {
    const fetchedChapters = [...selectedChapters].filter(id => {
      const cacheData = chapterDataCache.get(id);
      return cacheData && cacheData.blobs.length > 0;
    });
    
    if (fetchedChapters.length === 0 || isDownloading) {
      log('❌ No fetched chapters to download. Please fetch first!', 'error');
      return;
    }
    
    isDownloading = true;
    const downloadBtn = document.getElementById('mdx-download-btn');
    if (downloadBtn) downloadBtn.disabled = true;
    
    log(`📦 Starting download: ${fetchedChapters.length} chapters`, 'info');

    const selected = allChapters.filter(ch => fetchedChapters.includes(ch.chapter_id));
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
        const cacheData = chapterDataCache.get(ch.chapter_id);
        
        if (!cacheData || cacheData.blobs.length === 0) {
          log(`⚠️ Skipping Chapter ${ch.number} (not fetched)`, 'info');
          continue;
        }
        
        log(`📦 Adding Chapter ${ch.number} to ZIP...`, 'info');
        
        const chapterNum = parseFloat(ch.number);
        if (rangeStart === null) rangeStart = chapterNum;
        rangeEnd = chapterNum;
        
        const folderName = 'Ch.' + ch.number + (ch.name ? ' - ' + ch.name : '');
        const folder = currentZip.folder(folderName);
        
        cacheData.blobs.forEach(b => {
          if (b && b.fileName && b.blob) {
            folder.file(b.fileName, b.blob);
          }
        });
        
        currentZipSize += cacheData.size;
        const mb = (cacheData.size / 1024 / 1024).toFixed(1);
        log(`✓ Added ${cacheData.blobs.length} images (${mb}MB)`, 'success');
        
        updateProgress(i + 1, selected.length);
        
        if (currentZipSize >= MAX_ZIP_SIZE && i < selected.length - 1) {
          await saveZip(false);
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      await saveZip(true);
      log('🎉 Download complete!', 'success');
      log('💾 Auto-saving manga ID to list...', 'info');
      await saveMangaToList();
      
    } catch (err) {
      log(`❌ Download error: ${err.message}`, 'error');
      console.error('Download error:', err);
    } finally {
      isDownloading = false;
      if (downloadBtn) downloadBtn.disabled = false;
    }
  };

  // ============ EVENT LISTENERS SETUP ============
  const setupEventListeners = () => {
    const closeBtn = document.getElementById('mdx-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => document.getElementById('mdx-overlay')?.remove());
    }

    const btnAll = document.getElementById('mdx-btn-all');
    if (btnAll) btnAll.addEventListener('click', selectAll);

    const btnNone = document.getElementById('mdx-btn-none');
    if (btnNone) btnNone.addEventListener('click', deselectAll);

    const btnUnique = document.getElementById('mdx-btn-unique');
    if (btnUnique) btnUnique.addEventListener('click', selectUnique);

    const btnFetch = document.getElementById('mdx-fetch-btn');
    if (btnFetch) btnFetch.addEventListener('click', fetchSelected);

    const btnPause = document.getElementById('mdx-pause-btn');
    if (btnPause) btnPause.addEventListener('click', togglePause);

    const btnRefetchAll = document.getElementById('mdx-refetch-all-btn');
    if (btnRefetchAll) btnRefetchAll.addEventListener('click', refetchAllFailed);

    const btnDownload = document.getElementById('mdx-download-btn');
    if (btnDownload) btnDownload.addEventListener('click', downloadSelected);

    const btnSave = document.getElementById('mdx-save-btn');
    if (btnSave) btnSave.addEventListener('click', () => saveMangaToList());

    const btnScanlatorSelect = document.getElementById('mdx-btn-scanlator-select');
    if (btnScanlatorSelect) {
      btnScanlatorSelect.addEventListener('click', selectByScanlator);
    }

    const overlay = document.getElementById('mdx-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
    }
  };

  // ============ MAIN ============
  const init = async () => {
    if (typeof JSZip === 'undefined') {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load JSZip'));
        document.head.appendChild(s);
      });
    }
    
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
      
      mangaId = manga.hash_id || manga.id || '';
      latestChapter = manga.latest_chapter || '?';
      
      mangaTitle = (manga.title || 'manga')
        .replace(/[^a-z0-9\s]/gi, '')
        .trim()
        .slice(0, 50) || 'manga';
      
      allChapters = await fetchAllChapters(code);
      availableScanlators = extractScanlators(allChapters);

      document.getElementById('mdx-loading').style.display = 'none';
      
      const content = document.createElement('div');
      content.id = 'mdx-content';
      content.style.cssText = 'display:flex;flex-direction:column;height:100%;';
      content.innerHTML = `
        <div id="mdx-chapters">
          <div id="mdx-chap-header">
            <span>📖 Select Chapters (${allChapters.length} total)</span>
            <span style="font-size:11px;color:#7982a9;">Click to toggle</span>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-size:11px;color:#7982a9;">Filter by:</span>
              <div id="mdx-scanlator-filters" style="display:flex;gap:4px;flex-wrap:wrap;"></div>
              <button id="mdx-btn-scanlator-select" class="mdx-btn mdx-btn-secondary" style="padding:4px 10px;font-size:11px;" title="Select chapters matching chosen scanlators">
                ✅ Select Filtered
              </button>
            </div>
          </div>
          <div id="mdx-chap-list"></div>
        </div>
        <div id="mdx-footer">
          <div id="mdx-actions">
            <button id="mdx-btn-all" class="mdx-btn mdx-btn-secondary">All</button>
            <button id="mdx-btn-none" class="mdx-btn mdx-btn-secondary">None</button>
            <button id="mdx-btn-unique" class="mdx-btn mdx-btn-secondary">Unique Only</button>
          </div>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <div id="mdx-count"><strong id="mdx-selected-count">0</strong> selected</div>
            <div id="mdx-total-size"></div>
            <button id="mdx-save-btn" class="mdx-btn mdx-btn-save" title="Save manga ID to list">
              💾 SAVE ID
            </button>
            <button id="mdx-pause-btn" class="mdx-btn mdx-btn-pause" title="Pause/Resume fetching">
              ⏸ PAUSE
            </button>
            <button id="mdx-refetch-all-btn" class="mdx-btn mdx-btn-secondary" disabled>
              🔄 REFETCH ALL FAILED
            </button>
            <button id="mdx-fetch-btn" class="mdx-btn mdx-btn-success" disabled>
              📥 FETCH
            </button>
            <button id="mdx-download-btn" class="mdx-btn mdx-btn-primary" disabled>
              📦 DOWNLOAD
            </button>
          </div>
        </div>
        <div id="mdx-batch-summary" class="mdx-batch-summary"></div>
      `;
      
      document.getElementById('mdx-body').appendChild(content);
      
      const consoleEl = document.createElement('div');
      consoleEl.id = 'mdx-console';
      consoleEl.innerHTML = `
        <div id="mdx-console-log"></div>
        <div id="mdx-progress"><div id="mdx-progress-fill" style="width:0%"></div></div>
        <div class="mdx-parallel-info">⚡ ${PARALLEL_CHAPTERS} parallel chapters × ${PARALLEL_IMAGES} parallel images</div>
      `;
      document.body.appendChild(consoleEl);
      
      setupEventListeners();
      renderScanlatorFilters();
      renderChapters();
      updateCount();
      
      log(`📚 Loaded: ${mangaTitle}`, 'info');
      log(`🆔 Manga ID: ${mangaId}`, 'info');
      log(`📖 Latest Chapter: ${latestChapter}`, 'info');
      log(`🏷️ Scanlators found: ${availableScanlators.join(', ') || 'Unknown'}`, 'info');
      
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

  init();

})();
