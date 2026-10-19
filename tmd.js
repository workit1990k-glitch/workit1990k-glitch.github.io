// down.js - Manga Downloader Script (MangaDex API + Data Saver + Client-Side Resize/Convert)
// Loaded via bookmarklet
// Version: 2024-03-20-MANGADEX (Data Saver + WebP + Smart Resize + Save ID + Progress + Group Selector)

(function() {
  'use strict';

  if (window.mdxLoaded) {
    console.log('📚 Manga Downloader already loaded');
    return;
  }
  window.mdxLoaded = true;
  console.log('📚 Manga Downloader (MangaDex) initialized');

  // ============ CONFIG ============
  const CF_WORKER_URL = 'https://xcom.yuush.workers.dev'; // Fallback proxy if direct fetch fails
  const SAVE_URL = 'https://tiny-night-7d75.yuush.workers.dev/save';

  // Note: Change 'en' to your preferred language code (e.g., 'pt-br', 'es', 'fr') if needed
  const LANG_FILTER = 'en'; 

  const RESIZE_CONFIG = {
    maxWidth: 1280,
    quality: 0.75,
    format: 'image/webp',
    skipIfLarger: true,
  };

  const MAX_ZIP_SIZE = 495 * 1024 * 1024;
  const PARALLEL_IMAGES = 3;
  const PARALLEL_CHAPTERS = 3;

  // ============ STATE ============
  let allChapters = [];          // { chapter_id, number, name, vol, group }
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
  let currentTitleId = '';
  let editions = [];             // [{ id, count, flag }]
  let currentEditionId = 'ALL';
  let isLoadingEdition = false;

  // ============ UTILS ============
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

  const extractTitleId = (url) => {
    const match = url.match(/\/(?:title|manga)\/([^/?]+)/i);
    return match ? match[1] : null;
  };

  const fetchRetry = async (fn, retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i === retries - 1) throw e;
        await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
      }
    }
  };

  // Generate "Editions" (Scanlation Groups) from fetched chapters
  const generateEditions = (chapters) => {
    const counts = {};
    chapters.forEach(ch => {
      counts[ch.group] = (counts[ch.group] || 0) + 1;
    });
    return Object.entries(counts).map(([name, count]) => ({
      id: name,
      count: count,
      flag: '👥'
    })).sort((a, b) => b.count - a.count);
  };

  const getFilteredChapters = () => {
    if (currentEditionId === 'ALL') return allChapters;
    return allChapters.filter(ch => ch.group === currentEditionId);
  };

  const fetchAllChapters = async (mangaId) => {
    const chapters = [];
    let offset = 0;
    const limit = 500;
    while (true) {
      const url = `https://api.mangadex.org/manga/${mangaId}/feed?limit=${limit}&offset=${offset}&order[chapter]=asc&order[volume]=asc&includes[]=scanlation_group&translatedLanguage[]=${LANG_FILTER}`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.result === 'error') throw new Error(data.errors ? data.errors.map(e => e.detail).join(', ') : 'Failed to fetch chapters');
      
      for (const item of data.data) {
        const attrs = item.attributes;
        const groupRel = item.relationships.find(r => r.type === 'scanlation_group');
        const groupName = groupRel && groupRel.attributes ? groupRel.attributes.name : 'No Group';
        
        chapters.push({
          chapter_id: item.id,
          number: attrs.chapter || '0',
          name: attrs.title || '',
          vol: attrs.volume || '',
          group: groupName,
        });
      }
      
      if (data.data.length < limit) break;
      offset += limit;
    }
    
    chapters.sort((a, b) => {
      const va = parseFloat(a.vol) || 0, vb = parseFloat(b.vol) || 0;
      if (va !== vb) return va - vb;
      const na = parseFloat(a.number), nb = parseFloat(b.number);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
    });
    return chapters;
  };

  // ============ IMAGE CONVERTER ============
  const resizeImage = async (imageUrl, originalBlob) => {
    return new Promise(async (resolve) => {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const objectUrl = URL.createObjectURL(originalBlob);

        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          const { width, height } = img;

          let drawWidth = width, drawHeight = height;
          if (width > RESIZE_CONFIG.maxWidth) {
            const ratio = RESIZE_CONFIG.maxWidth / width;
            drawWidth = RESIZE_CONFIG.maxWidth;
            drawHeight = Math.round(height * ratio);
          }

          const canvas = document.createElement('canvas');
          canvas.width = drawWidth;
          canvas.height = drawHeight;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, drawWidth, drawHeight);

          canvas.toBlob(
            (convertedBlob) => {
              canvas.remove();
              img.src = '';
              if (!convertedBlob) {
                resolve({
                  blob: originalBlob, converted: false, resized: false,
                  originalSize: originalBlob.size, newSize: originalBlob.size,
                });
                return;
              }
              const wasResized = width > RESIZE_CONFIG.maxWidth;
              if (RESIZE_CONFIG.skipIfLarger && convertedBlob.size >= originalBlob.size) {
                resolve({
                  blob: originalBlob, converted: false, resized: wasResized,
                  originalSize: originalBlob.size, newSize: originalBlob.size,
                });
                return;
              }
              const savings = ((1 - convertedBlob.size / originalBlob.size) * 100).toFixed(1) + '%';
              resolve({
                blob: convertedBlob, converted: true, resized: wasResized,
                originalSize: originalBlob.size, newSize: convertedBlob.size, savings,
              });
            },
            RESIZE_CONFIG.format,
            RESIZE_CONFIG.quality
          );
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          resolve({
            blob: originalBlob, converted: false, resized: false,
            originalSize: originalBlob.size, newSize: originalBlob.size,
          });
        };
        img.src = objectUrl;
      } catch (err) {
        resolve({
          blob: originalBlob, converted: false, resized: false,
          originalSize: originalBlob.size, newSize: originalBlob.size,
        });
      }
    });
  };

  // Fetch with direct CORS, fallback to proxy if needed
  const fetchImageBlob = async (url) => {
    try {
      // MangaDex images support CORS, direct fetch is preferred and faster
      const response = await fetch(url, { credentials: 'omit', mode: 'cors' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error('not an image (' + blob.type + ')');
      return blob;
    } catch (e) {
      // Fallback to proxy if direct fetch fails (e.g., strict browser policies)
      const proxied = CF_WORKER_URL + '/?url=' + encodeURIComponent(url);
      const response2 = await fetch(proxied, { credentials: 'omit', mode: 'cors' });
      if (!response2.ok) throw new Error('HTTP ' + response2.status);
      const blob2 = await response2.blob();
      if (!blob2.type.startsWith('image/')) throw new Error('not an image (' + blob2.type + ')');
      return blob2;
    }
  };

  // ============ PARALLEL DOWNLOADER ============
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
      if (executing.size >= concurrencyLimit) await Promise.race(executing);
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
      while (executing.size >= PARALLEL_CHAPTERS) await Promise.race(executing);

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
          const convertInfo = data.convertedCount > 0
            ? ` | 🎨 ${data.convertedCount} converted (${formatBytes(data.savedBytes)} saved)` : '';
          const statusEmoji = data.status === 'success' ? '✓' : data.status === 'partial' ? '⚠' : '❌';
          log(`${statusEmoji} Chapter ${chapterNum}: ${data.total - data.failed}/${data.total} images, ${mb}MB${convertInfo}`,
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
            blobs: [], size: 0, total: 0, failed: 0, status: 'error',
            error: err.message, failedDetails: [], convertedCount: 0, savedBytes: 0,
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
      const response = await fetch(`https://api.mangadex.org/at-home/server/${chapterId}`);
      const data = await response.json();
      if (data.result === 'error') throw new Error(data.errors ? data.errors.map(e => e.detail).join(', ') : 'Failed to fetch chapter images');
      
      const baseUrl = data.baseUrl;
      const hash = data.chapter.hash;
      
      // USE DATA SAVER ENDPOINT
      const filenames = data.chapter.dataSaver; 
      const imageUrls = filenames.map(f => `${baseUrl}/data-saver/${hash}/${f}`);

      if (!imageUrls.length) {
        return { blobs: [], size: 0, total: 0, failed: 0, status: 'empty', failedDetails: [], convertedCount: 0, savedBytes: 0 };
      }

      let downloadedCount = 0;
      const downloadTasks = imageUrls.map((originalUrl, index) => async () => {
        const fileName = `page_${String(index + 1).padStart(3, '0')}.webp`;
        try {
          const originalBlob = await fetchImageBlob(originalUrl);
          const { blob: finalBlob, converted, resized, savings, originalSize, newSize } =
            await resizeImage(originalUrl, originalBlob);
          downloadedCount++;

          if (showLog && (downloadedCount % 5 === 0 || downloadedCount === imageUrls.length)) {
            const imgWord = downloadedCount === 1 ? 'image' : 'images';
            const convertNote = converted ? ` 🎨-${savings}` : '';
            const resizeNote = resized ? ` ✂️` : '';
            log(`🖼️ Chapter ${chapterNum}: ${downloadedCount}/${imageUrls.length} ${imgWord}${convertNote}${resizeNote}`, 'image-success');
          }
          return { fileName, blob: finalBlob, size: finalBlob.size, index, success: true, converted, resized, originalSize, newSize };
        } catch (e) {
          return {
            fileName, index, success: false, error: e.message,
            originalUrl: originalUrl.substring(0, 100),
          };
        }
      });

      const results = await downloadWithConcurrency(downloadTasks, PARALLEL_IMAGES, (completed, total) => {
        if (showLog && completed % 10 === 0 && completed < total) {
          const imgWord = completed === 1 ? 'image' : 'images';
          log(`⏳ Chapter ${chapterNum}: ${completed}/${total} ${imgWord}...`, 'info');
        }
      });

      const blobs = [];
      let totalSize = 0, convertedCount = 0, savedBytes = 0;
      const failedDetails = [];

      results.forEach(result => {
        if (result.success && result.result.success) {
          const r = result.result;
          blobs.push({ fileName: r.fileName, blob: r.blob, size: r.size });
          totalSize += r.size;
          if (r.converted) {
            convertedCount++;
            if (r.newSize < r.originalSize) savedBytes += (r.originalSize - r.newSize);
          }
        } else {
          const errorResult = result.success ? result.result : result.error;
          failedDetails.push({
            index: result.index,
            fileName: errorResult.fileName,
            error: errorResult.error || 'Unknown error',
            url: errorResult.originalUrl || 'N/A',
          });
        }
      });

      const failedCount = failedDetails.length;
      const status = failedCount === 0 ? 'success' : (blobs.length > 0 ? 'partial' : 'failed');
      return { blobs, size: totalSize, total: imageUrls.length, failed: failedCount, failedDetails, status, convertedCount, savedBytes };
    } catch (err) {
      console.error('fetchChapterImages error:', err);
      return { blobs: [], size: 0, total: 0, failed: 0, status: 'error', error: err.message, failedDetails: [], convertedCount: 0, savedBytes: 0 };
    }
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // ============ SAVE ID ============
  const saveMangaToList = async () => {
    if (!mangaId || !latestChapter) {
      log('❌ No manga ID or chapter info available', 'error');
      return false;
    }
    try {
      log('💾 Saving manga ID to list...', 'info');
      const response = await fetch(SAVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manga_id: mangaId, latest_chapter: latestChapter }),
      });
      const result = await response.json();
      if (result.success) {
        log(`✓ Saved ${mangaId}:${latestChapter} to list!`, 'success');
        showToast(`✓ ${mangaId}:${latestChapter} saved!`);
        return true;
      }
      throw new Error(result.error || 'Save failed');
    } catch (err) {
      log(`❌ Save failed: ${err.message}`, 'error');
      showToast(`✗ Save failed: ${err.message}`);
      return false;
    }
  };

  const showToast = (msg) => {
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;top:20px;right:20px;background:#24283b;border:1px solid #9ece6a;border-radius:8px;padding:12px 20px;color:#c0caf5;font-size:13px;z-index:3000;box-shadow:0 4px 20px rgba(0,0,0,0.4);`;
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
          <strong style="font-size:16px;">📚 Manga Downloader (MangaDex)</strong>
          <button id="mdx-close" style="background:none;border:none;color:#7982a9;font-size:24px;cursor:pointer;padding:4px 8px;">&times;</button>
        </div>
        <div id="mdx-body" style="flex:1;overflow:hidden;display:flex;flex-direction:column;">
          <div id="mdx-loading" style="text-align:center;padding:60px;color:#7982a9;">
            <div style="width:40px;height:40px;border:3px solid #414868;border-top-color:#e0af68;border-radius:50%;animation:mdx-spin 1s linear infinite;margin:0 auto 16px"></div>
            <div>Fetching groups & chapters...</div>
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
        #mdx-count { font-size:13px; color:#7982a9; }
        #mdx-count strong { color:#e0af68; }
        #mdx-total-size { font-size:13px; color:#7982a9; margin-left:12px; }
        #mdx-total-size strong { color:#9ece6a; }
        #mdx-console { position:fixed; bottom:350px; right:20px; width:50%; background:#24283b; border:1px solid #414868; border-radius:8px; padding:12px; display:none; flex-direction:column; max-height:300px; z-index:100000; }
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
        .mdx-batch-summary { background:#2f3549; padding:10px; border-radius:6px; margin-top:10px; font-size:12px; color:#7982a9; display:none; }
        .mdx-batch-summary.active { display:block; }
        .mdx-batch-summary strong { color:#c0caf5; }
        .mdx-scanlator-chip { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; background:#2f3549; border:1px solid #414868; border-radius:16px; font-size:10px; color:#c0caf5; cursor:pointer; transition:all 0.15s; user-select:none; pointer-events:auto; font-family:inherit; }
        .mdx-scanlator-chip:hover { background:#414868; }
        .mdx-scanlator-chip.active { background:#e0af68; color:#1a1b26; border-color:#f0bf78; font-weight:600; }
        .mdx-scanlator-chip:disabled { opacity:0.5; cursor:wait; }
        .mdx-scanlator-chip:disabled:hover { background:#2f3549; }
        .mdx-scanlator-count { font-size:9px; color:#7982a9; background:#1a1b26; padding:2px 6px; border-radius:10px; }
        .mdx-scanlator-chip.active .mdx-scanlator-count { background:#c08a3e; color:#1a1b26; }
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

  /* -------- Group selector (single-select, filters chapters) -------- */
  const renderScanlatorFilters = () => {
    const container = document.getElementById('mdx-scanlator-filters');
    if (!container) return;
    container.innerHTML = '';

    editions.forEach(ed => {
      const isActive = ed.id === currentEditionId;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mdx-scanlator-chip' + (isActive ? ' active' : '');
      chip.disabled = isLoadingEdition || isFetching;
      chip.title = isActive ? 'Currently loaded group' : 'Click to filter by this group';
      chip.innerHTML = `
        <span>${ed.flag} ${ed.id}</span>
        <span class="mdx-scanlator-count">${ed.count}</span>
      `;
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        switchEdition(ed.id);
      });
      container.appendChild(chip);
    });
  };

  const switchEdition = async (editionId) => {
    if (editionId === currentEditionId || isLoadingEdition || isFetching) return;
    isLoadingEdition = true;
    renderScanlatorFilters();

    try {
      log(`🌐 Switching group → ${editionId}...`, 'info');
      currentEditionId = editionId;
      selectedChapters.clear();
      chapterDataCache.clear();

      const summary = document.getElementById('mdx-batch-summary');
      if (summary) summary.classList.remove('active');

      log(`✓ Filtered to ${getFilteredChapters().length} chapters for ${editionId}`, 'success');
    } catch (err) {
      log(`❌ Group switch failed: ${err.message}`, 'error');
    } finally {
      isLoadingEdition = false;
      renderScanlatorFilters();
      renderChapters();
      updateCount();
    }
  };

  const selectByScanlator = () => {
    if (isFetching || isLoadingEdition) return;
    selectedChapters.clear();
    getFilteredChapters().forEach(ch => selectedChapters.add(ch.chapter_id));
    renderChapters();
    updateCount();
  };

  const renderChapters = () => {
    const list = document.getElementById('mdx-chap-list');
    if (!list) return;
    list.innerHTML = '';

    const filtered = getFilteredChapters();
    if (!filtered.length) {
      list.innerHTML = '<div style="text-align:center;padding:40px;color:#7982a9;">No chapters found for this group.</div>';
      return;
    }

    filtered.forEach(ch => {
      const item = document.createElement('div');
      const isSelected = selectedChapters.has(ch.chapter_id);
      const cacheData = chapterDataCache.get(ch.chapter_id);

      item.className = 'mdx-chap-item' +
        (isSelected ? ' selected' : '') +
        (cacheData ? ' fetched' : '') +
        (isFetching && isSelected ? ' fetching' : '');

      item.dataset.chapterId = ch.chapter_id;

      item.addEventListener('click', (e) => {
        if (e.target.type !== 'checkbox' && !e.target.classList.contains('mdx-refetch-btn')) {
          toggleChapter(ch.chapter_id);
        }
      });

      const row = document.createElement('div');
      row.className = 'mdx-chap-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'mdx-chap-check';
      checkbox.checked = isSelected;
      checkbox.disabled = isFetching;
      checkbox.addEventListener('change', () => toggleChapter(ch.chapter_id));
      checkbox.addEventListener('click', (e) => e.stopPropagation());

      const info = document.createElement('div');
      info.id = 'mdx-chap-info';
      info.innerHTML = `
        <div id="mdx-chap-num">Ch.${ch.number}${ch.name ? ' — ' + ch.name : ''}</div>
        <div id="mdx-chap-group">${ch.vol ? 'Vol.' + ch.vol + ' · ' : ''}Group: ${ch.group}</div>
        <div class="mdx-chap-scanlator">🏷️ ${ch.group}</div>
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
        const convertText = cacheData.convertedCount > 0
          ? ` | 🎨 ${cacheData.convertedCount} (${formatBytes(cacheData.savedBytes)} saved)` : '';
        statusDiv.innerHTML = `
          <div class="${statusClass}">
            <strong>${cacheData.status === 'success' ? '✓' : '⚠'} ${cacheData.status.toUpperCase()}</strong>
            | ${sizeText} | ${successText}${failText}${convertText}
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
          refetchBtn.addEventListener('click', (e) => { e.stopPropagation(); refetchChapter(ch.chapter_id); });
          statusDiv.appendChild(refetchBtn);
        }
        item.appendChild(statusDiv);
      }

      if (isFetching && isSelected && !cacheData) {
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
    if (selectedChapters.has(id)) selectedChapters.delete(id);
    else selectedChapters.add(id);
    renderChapters();
    updateCount();
  };

  const selectAll = () => {
    if (isFetching) return;
    getFilteredChapters().forEach(ch => selectedChapters.add(ch.chapter_id));
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
    getFilteredChapters().forEach(ch => {
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

    let fetchedSize = 0, fetchedCount = 0, failedCount = 0;
    selectedChapters.forEach(id => {
      const cacheData = chapterDataCache.get(id);
      if (cacheData && cacheData.blobs.length > 0) { fetchedSize += cacheData.size; fetchedCount++; }
      if (cacheData && (cacheData.status === 'partial' || cacheData.status === 'failed')) failedCount++;
    });

    if (totalSize) {
      totalSize.innerHTML = fetchedCount > 0
        ? `Total: <strong>${formatBytes(fetchedSize)}</strong> (${fetchedCount}/${selectedChapters.size} fetched)`
        : '';
    }
    if (btnFetch) {
      btnFetch.disabled = selectedChapters.size === 0 || isFetching || isLoadingEdition;
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

  const fetchSelected = async () => {
    if (selectedChapters.size === 0 || isFetching) return;
    isFetching = true;
    isPaused = false;
    fetchCancelled = false;
    renderChapters();
    updateCount();
    document.getElementById('mdx-console').classList.add('active');

    const selected = getFilteredChapters().filter(ch => selectedChapters.has(ch.chapter_id));
    selected.sort((a, b) => {
      const na = parseFloat(a.number), nb = parseFloat(b.number);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a.number).localeCompare(String(b.number), undefined, { numeric: true });
    });

    log(`📥 Starting fetch: ${selected.length} chapters (${PARALLEL_CHAPTERS} parallel)`, 'info');
    log(`⚡ Data Saver + ${PARALLEL_IMAGES} parallel images + WebP convert @${Math.round(RESIZE_CONFIG.quality * 100)}%`, 'info');

    try {
      await fetchChaptersParallel(selected, (completed, total) => updateProgress(completed, total), false);
      const successCount = [...selectedChapters].filter(id => {
        const c = chapterDataCache.get(id);
        return c && c.status === 'success';
      }).length;
      const totalImages = [...selectedChapters].reduce((s, id) => {
        const c = chapterDataCache.get(id); return s + (c ? c.total - c.failed : 0);
      }, 0);
      const totalFailed = [...selectedChapters].reduce((s, id) => {
        const c = chapterDataCache.get(id); return s + (c ? c.failed : 0);
      }, 0);
      const totalConverted = [...selectedChapters].reduce((s, id) => {
        const c = chapterDataCache.get(id); return s + (c ? c.convertedCount : 0);
      }, 0);
      const totalSaved = [...selectedChapters].reduce((s, id) => {
        const c = chapterDataCache.get(id); return s + (c ? c.savedBytes : 0);
      }, 0);
      const convertNote = totalConverted > 0 ? ` | 🎨 ${totalConverted} converted (${formatBytes(totalSaved)} saved)` : '';
      log(`🎉 Fetch complete! ${successCount}/${selected.length} chapters, ${totalImages} images, ${totalFailed} failed${convertNote}`, 'success');

      const summary = document.getElementById('mdx-batch-summary');
      if (summary) {
        summary.innerHTML = `<strong>Fetch Summary:</strong> ${successCount} chapters ready. ${totalFailed} images failed.${convertNote ? `<br>✨ ${convertNote.trim()}` : ''}`;
        summary.classList.add('active');
      }
    } catch (err) {
      log(`❌ Fetch error: ${err.message}`, 'error');
    } finally {
      isFetching = false;
      isPaused = false;
      renderChapters();
      updateCount();
    }
  };

  const refetchAllFailed = async () => {
    const failedChapters = [];
    selectedChapters.forEach(id => {
      const c = chapterDataCache.get(id);
      if (c && (c.status === 'partial' || c.status === 'failed')) {
        const ch = getFilteredChapters().find(x => x.chapter_id === id);
        if (ch) failedChapters.push(ch);
      }
    });
    if (failedChapters.length === 0) { log('❌ No failed chapters to refetch', 'error'); return; }

    isFetching = true; isPaused = false; fetchCancelled = false;
    renderChapters(); updateCount();
    document.getElementById('mdx-console').classList.add('active');
    log(`🔄 Starting refetch: ${failedChapters.length} failed chapters`, 'info');
    try {
      await fetchChaptersParallel(failedChapters, (completed, total) => updateProgress(completed, total), true);
      log(`🎉 Refetch complete!`, 'success');
    } catch (err) {
      log(`❌ Refetch error: ${err.message}`, 'error');
    } finally {
      isFetching = false; isPaused = false;
      renderChapters(); updateCount();
    }
  };

  const refetchChapter = async (chapterId) => {
    const ch = getFilteredChapters().find(c => c.chapter_id === chapterId);
    if (!ch) return;
    log(`🔄 Re-fetching Chapter ${ch.number}...`, 'info');
    try {
      const data = await fetchChapterImages(chapterId, ch.number, true);
      chapterDataCache.set(chapterId, data);
      const mb = (data.size / 1024 / 1024).toFixed(2);
      const convertNote = data.convertedCount > 0 ? ` | 🎨 ${data.convertedCount} (${formatBytes(data.savedBytes)} saved)` : '';
      const statusEmoji = data.status === 'success' ? '✓' : '⚠';
      if (data.failedDetails && data.failedDetails.length > 0) {
        data.failedDetails.forEach(fail => {
          log(`  ❌ Image ${fail.index + 1} (${fail.fileName}): ${fail.error}`, 'image-fail');
        });
      }
      log(`${statusEmoji} Chapter ${ch.number} re-fetched: ${data.total - data.failed}/${data.total} images, ${mb}MB${convertNote}`,
          data.status === 'success' ? 'success' : 'error');
      renderChapters(); updateCount();
    } catch (err) {
      log(`❌ Re-fetch error: ${err.message}`, 'error');
    }
  };

  const togglePause = () => {
    if (!isFetching) return;
    isPaused = !isPaused;
    if (isPaused) {
      log('⏸ Fetching paused', 'warning');
      if (pauseResolve) pauseResolve();
    } else log('▶ Fetching resumed', 'info');
    updateCount();
  };

  const downloadSelected = async () => {
    const fetchedChapters = [...selectedChapters].filter(id => {
      const c = chapterDataCache.get(id);
      return c && c.blobs.length > 0;
    });
    if (fetchedChapters.length === 0 || isDownloading) {
      log('❌ No fetched chapters to download. Please fetch first!', 'error');
      return;
    }
    isDownloading = true;
    const downloadBtn = document.getElementById('mdx-download-btn');
    if (downloadBtn) downloadBtn.disabled = true;
    log(`📦 Starting download: ${fetchedChapters.length} chapters`, 'info');

    const selected = getFilteredChapters().filter(ch => fetchedChapters.includes(ch.chapter_id));
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
        const content = await currentZip.generateAsync({ type: 'blob', compression: 'STORE' });
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

        const folderName = `Ch.${ch.number}${ch.vol ? ' (v' + ch.vol + ')' : ''}${ch.name ? ' - ' + ch.name : ''}`;
        const folder = currentZip.folder(folderName);
        cacheData.blobs.forEach(b => {
          if (b && b.fileName && b.blob) folder.file(b.fileName, b.blob);
        });
        currentZipSize += cacheData.size;
        const mb = (cacheData.size / 1024 / 1024).toFixed(1);
        const convertNote = cacheData.convertedCount > 0 ? ` | 🎨 ${cacheData.convertedCount}` : '';
        log(`✓ Added ${cacheData.blobs.length} images (${mb}MB)${convertNote}`, 'success');
        updateProgress(i + 1, selected.length);
        if (currentZipSize >= MAX_ZIP_SIZE && i < selected.length - 1) await saveZip(false);
      }
      await saveZip(true);
      log('🎉 Download complete!', 'success');
      log('💾 Auto-saving manga ID to list...', 'info');
      await saveMangaToList();
    } catch (err) {
      log(`❌ Download error: ${err.message}`, 'error');
    } finally {
      isDownloading = false;
      if (downloadBtn) downloadBtn.disabled = false;
    }
  };

  const setupEventListeners = () => {
    const closeBtn = document.getElementById('mdx-close');
    if (closeBtn) closeBtn.addEventListener('click', () => document.getElementById('mdx-overlay')?.remove());

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
    if (btnScanlatorSelect) btnScanlatorSelect.addEventListener('click', selectByScanlator);

    const overlay = document.getElementById('mdx-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }
  };

  const init = async () => {
    // WebP support check
    const supportsWebP = () => {
      const canvas = document.createElement('canvas');
      return new Promise(resolve => {
        try { canvas.toBlob(blob => resolve(!!blob), 'image/webp', 0.75); }
        catch (e) { resolve(false); }
      });
    };
    const webpSupported = await supportsWebP();
    if (!webpSupported) {
      console.warn('⚠️ WebP export not supported, falling back to PNG');
      RESIZE_CONFIG.format = 'image/png';
      RESIZE_CONFIG.quality = 0.92;
    }

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
      const titleId = extractTitleId(location.href);
      if (!titleId) throw new Error('Not a valid MangaDex title page (expected /title/<id> or /manga/<id>)');
      currentTitleId = titleId;
      mangaId = titleId;

      // Title name
      log('📥 Fetching manga details...', 'info');
      const titleResponse = await fetch(`https://api.mangadex.org/manga/${titleId}?includes[]=cover_art`);
      const titleData = await titleResponse.json();
      if (titleData.result === 'error') throw new Error(titleData.errors ? titleData.errors.map(e => e.detail).join(', ') : 'Failed to fetch manga');
      
      const rawTitle = titleData.data.attributes.title.en || 
                       titleData.data.attributes.title.ja || 
                       titleData.data.attributes.title['ja-ro'] || 
                       Object.values(titleData.data.attributes.title)[0] || 
                       'manga';
      mangaTitle = safe(rawTitle) || 'manga';

      // Fetch chapters
      log('📥 Fetching chapters from MangaDex...', 'info');
      allChapters = await fetchAllChapters(titleId);
      
      if (allChapters.length) {
        const last = allChapters[allChapters.length - 1];
        latestChapter = String(last.number);
      } else {
        latestChapter = '?';
      }

      // Generate editions (groups) from chapters
      editions = generateEditions(allChapters);
      editions.unshift({ id: 'ALL', count: allChapters.length, flag: '🌐' });
      currentEditionId = 'ALL';

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
              <span style="font-size:11px;color:#7982a9;">Group:</span>
              <div id="mdx-scanlator-filters" style="display:flex;gap:4px;flex-wrap:wrap;"></div>
              <button id="mdx-btn-scanlator-select" class="mdx-btn mdx-btn-secondary" style="padding:4px 10px;font-size:11px;" title="Select all chapters in current group">
                ✅ Select All
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
            <button id="mdx-save-btn" class="mdx-btn mdx-btn-save" title="Save manga ID to list">💾 SAVE ID</button>
            <button id="mdx-pause-btn" class="mdx-btn mdx-btn-pause" title="Pause/Resume fetching">⏸ PAUSE</button>
            <button id="mdx-refetch-all-btn" class="mdx-btn mdx-btn-secondary" disabled>🔄 REFETCH ALL FAILED</button>
            <button id="mdx-fetch-btn" class="mdx-btn mdx-btn-success" disabled>📥 FETCH</button>
            <button id="mdx-download-btn" class="mdx-btn mdx-btn-primary" disabled>📦 DOWNLOAD</button>
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
        <div class="mdx-parallel-info">⚡ ${PARALLEL_CHAPTERS} parallel chapters × ${PARALLEL_IMAGES} parallel images + Data Saver WebP convert</div>
      `;
      document.body.appendChild(consoleEl);

      setupEventListeners();
      renderScanlatorFilters();
      renderChapters();
      updateCount();

      log(`📚 Loaded: ${mangaTitle}`, 'info');
      log(`🆔 Manga ID: ${mangaId}`, 'info');
      log(`📖 Latest Chapter: ${latestChapter}`, 'info');
      log(`👥 Groups: ${editions.map(e => e.id + ' (' + e.count + ')').join(', ')}`, 'info');
      log(`🎨 Convert: Data Saver + ${RESIZE_CONFIG.maxWidth}px max width, ${Math.round(RESIZE_CONFIG.quality * 100)}% ${RESIZE_CONFIG.format.split('/')[1].toUpperCase()}${RESIZE_CONFIG.skipIfLarger ? ', skip if larger' : ''}`, 'info');
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
