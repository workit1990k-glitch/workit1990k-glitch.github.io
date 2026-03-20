// down.js - Manga Downloader External Script
// Loaded via bookmarklet from GitHub Raw
// All functions attached to window for inline onclick compatibility

(function() {
  if (window.mdxLoaded) { console.log('Manga Downloader already loaded'); return; }
  window.mdxLoaded = true;

  // ============ CONFIG ============
  const WORKER_URL = 'https://plain-night-1447-opt.yuush.workers.dev';
  const API_BASE = 'https://comix.to/api/v2';
  const HEADERS = { 'Referer': 'https://comix.to/', 'User-Agent': 'Mozilla/5.0' };
  const MAX_ZIP_SIZE_MB = 500;
  const MAX_ZIP_SIZE_BYTES = MAX_ZIP_SIZE_MB * 1024 * 1024;
  const GENRE_MAP = {6:"Action",87264:"Adult",7:"Adventure",9:"Comedy",11:"Drama",87265:"Ecchi",12:"Fantasy",14:"Historical",15:"Horror",16:"Isekai",87267:"Mature",18:"Mecha",20:"Mystery",22:"Psychological",23:"Romance",24:"Sci-Fi",25:"Slice of Life",87268:"Smut",26:"Sports",27:"Superhero",28:"Thriller",29:"Tragedy",30:"Wuxia"};
  const KNOWN_GENRE_IDS = new Set(Object.keys(GENRE_MAP).map(Number));

  // ============ STATE ============
  let allChapters = [], filteredChapters = [], selectedChapters = new Set(), scanlators = new Set(), chapterDataCache = new Map(), mangaDataCache = null, currentJsonData = null, totalImagesDownloaded = 0, totalDownloadedBytes = 0, isDownloading = new Set(), isBatchFetching = false, isBatchZipping = false, batchFetchCancelled = false, batchFetchPaused = false, batchFetchResolve = null;

  // ============ UTILS ============
  const extractCode = (url) => url.replace(/\/$/, '').split('/').pop()?.split('-')[0] || '';
  
  const fetchRetry = async (url, retries = 3, delay = 1000) => {
    for (let i = 1; i <= retries; i++) {
      try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { if (i === retries) throw e; await new Promise(r => setTimeout(r, delay * i)); }
    }
  };

  const fetchChapterWithRetry = async (chapterId, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/chapters/${chapterId}/`, { headers: HEADERS });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (err) { if (attempt === maxRetries) throw err; await new Promise(resolve => setTimeout(resolve, 5000)); }
    }
  };

  const extractImageUrls = (data) => {
    if (Array.isArray(data)) return data.map(item => item.image_url || item.url || item.src || item.data || item).filter(url => typeof url === 'string' && url.startsWith('http'));
    if (data?.pages && Array.isArray(data.pages)) return data.pages.map(page => page.image_url || page.url || page.src || page.data || page).filter(url => typeof url === 'string' && url.startsWith('http'));
    if (data?.images && Array.isArray(data.images)) return data.images.map(img => img.image_url || img.url || img.src || img.data || img).filter(url => typeof url === 'string' && url.startsWith('http'));
    if (data?.result) return extractImageUrls(data.result);
    return [];
  };

  const fetchTermNames = async (termIds, type) => {
    if (!termIds?.length) return [];
    const unknownIds = termIds.filter(id => !KNOWN_GENRE_IDS.has(Number(id)));
    if (!unknownIds.length) return [];
    try {
      const params = unknownIds.map(id => `ids[]=${id}`).join('&');
      const res = await fetchRetry(`${API_BASE}/terms?type=${type}&${params}`);
      return (res.result?.items || []).map(item => item.title).filter(Boolean);
    } catch { return []; }
  };

  const fetchWithConcurrency = async (items, fetchFn, concurrency = 3, onProgress) => {
    const results = [], executing = new Set();
    for (let i = 0; i < items.length; i++) {
      const promise = fetchFn(items[i], i, items.length).then(result => { executing.delete(promise); return result; });
      executing.add(promise); results.push(promise);
      if (executing.size >= concurrency) await Promise.race(executing);
      if (onProgress) onProgress(i + 1, items.length);
    }
    return Promise.all(results);
  };

  // ============ CONSOLE ============
  window.showConsole = () => document.getElementById('downloadConsole')?.classList.add('active');
  window.closeConsole = () => document.getElementById('downloadConsole')?.classList.remove('active');
  window.minimizeConsole = () => {
    const el = document.getElementById('downloadConsole');
    if (!el) return;
    ['console-body','console-stats'].forEach(cls => {
      const part = el.querySelector('.'+cls);
      if (part) part.style.display = part.style.display === 'none' ? (cls==='console-body'?'block':'grid') : 'none';
    });
  };
  window.logConsole = (msg, type='info') => {
    const log = document.getElementById('consoleLog'); if (!log) return;
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    line.innerHTML = `<span class="console-timestamp">[${new Date().toLocaleTimeString()}]</span><span>${msg}</span>`;
    log.appendChild(line); log.scrollTop = log.scrollHeight;
  };
  window.updateConsoleStats = () => {
    document.getElementById('statSize').textContent = `${(totalDownloadedBytes/1024/1024).toFixed(1)} MB`;
    document.getElementById('statImages').textContent = totalImagesDownloaded.toLocaleString();
  };
  window.updateConsoleProgress = (cur, tot, imgs, sizeMB) => {
    const fill = document.getElementById('consoleProgressFill');
    if (fill) fill.style.width = `${tot>0?(cur/tot)*100:0}%`;
    const stat = document.getElementById('statChapters'); if (stat) stat.textContent = `${cur}/${tot}`;
    if (imgs!==undefined) document.getElementById('statImages').textContent = imgs.toLocaleString();
    if (sizeMB!==undefined) document.getElementById('statSize').textContent = `${sizeMB.toFixed(1)} MB`;
  };
  window.clearConsole = () => {
    const log = document.getElementById('consoleLog'); if (log) log.innerHTML = '';
    updateConsoleProgress(0,0,0,0); totalDownloadedBytes = 0; totalImagesDownloaded = 0; updateConsoleStats();
  };

  // ============ CORE FUNCTIONS (attached to window for onclick) ============
  window.fetchManga = async () => {
    const url = document.getElementById('urlInput')?.value.trim();
    const btn = document.getElementById('fetchBtn'), loading = document.getElementById('loading'), list = document.getElementById('chaptersList');
    if (!url?.includes('comix.to/title/')) { alert('Please enter a valid comix.to URL'); return; }
    btn.disabled = true; loading.classList.add('active'); list.innerHTML = '';
    allChapters = []; selectedChapters.clear(); scanlators.clear(); mangaDataCache = null; chapterDataCache.clear();
    try {
      const code = extractCode(url);
      const mangaRes = await fetchRetry(`${API_BASE}/manga/${code}/`);
      const manga = mangaRes.result; mangaDataCache = manga;
      const termIds = manga.term_ids || [], genreNames = [], authorIds = [], artistIds = [];
      for (const id of termIds) { const numId = Number(id); if (KNOWN_GENRE_IDS.has(numId)) genreNames.push(GENRE_MAP[numId]); else { authorIds.push(id); artistIds.push(id); } }
      const [authors, artists] = await Promise.all([fetchTermNames(authorIds,'author'), fetchTermNames(artistIds,'artist')]);
      mangaDataCache.resolvedGenres = [...new Set(genreNames)]; mangaDataCache.resolvedAuthors = [...new Set(authors)]; mangaDataCache.resolvedArtists = [...new Set(artists)];
      document.getElementById('mangaInfo').style.display = 'block';
      document.getElementById('coverImg').src = manga.poster?.large || manga.poster?.medium || '';
      document.getElementById('mangaTitle').textContent = manga.title;
      document.getElementById('mangaType').textContent = manga.type || 'Unknown';
      document.getElementById('mangaLang').textContent = manga.original_language || 'Unknown';
      document.getElementById('mangaStatus').textContent = manga.status || 'Unknown';
      document.getElementById('mangaYear').textContent = manga.year || '?';
      document.getElementById('mangaLatest').textContent = manga.latest_chapter || '?';
      document.getElementById('mangaFollowers').textContent = manga.follows_total?.toLocaleString() || '0';
      document.getElementById('mangaid').textContent = manga.hash_id;
      document.getElementById('mangaDesc').textContent = manga.synopsis || 'No description available.';
      ['genresRow','authorsRow','artistsRow'].forEach((rowId, idx) => {
        const row = document.getElementById(rowId), span = document.getElementById(['mangaGenres','mangaAuthors','mangaArtists'][idx]), items = [mangaDataCache.resolvedGenres, mangaDataCache.resolvedAuthors, mangaDataCache.resolvedArtists][idx];
        if (row && span) { if (items?.length) { span.textContent = items.join(', '); row.style.display = 'block'; } else row.style.display = 'none'; }
      });
      let page = 1, hasMore = true;
      while (hasMore) {
        const chapRes = await fetchRetry(`${API_BASE}/manga/${code}/chapters?limit=100&page=${page}&order[number]=asc`);
        const items = chapRes.result?.items || [];
        if (!items.length) hasMore = false; else { allChapters.push(...items); items.forEach(ch => scanlators.add(ch.scanlation_group?.name || 'Unknown')); hasMore = items.length === 100; page++; }
        await new Promise(r => setTimeout(r, 100));
      }
      allChapters.sort((a,b) => { const na=parseFloat(a.number), nb=parseFloat(b.number); if (!isNaN(na)&&!isNaN(nb)) return na-nb; return String(a.number).localeCompare(String(b.number), undefined, {numeric:true}); });
      const filterSelect = document.getElementById('scanlatorFilter'); filterSelect.innerHTML = '<option value="">All Scanlators</option>';
      Array.from(scanlators).sort().forEach(group => { const opt = document.createElement('option'); opt.value = group; opt.textContent = group === 'Unknown' ? '• No Group •' : group; filterSelect.appendChild(opt); });
      filteredChapters = [...allChapters]; window.renderChapters(); window.updateCount();
    } catch (err) { alert('Error: ' + err.message); console.error(err); }
    finally { if (btn) btn.disabled = false; if (loading) loading.classList.remove('active'); }
  };

  window.renderChapters = () => {
    const list = document.getElementById('chaptersList'); if (!list) return; list.innerHTML = '';
    if (filteredChapters.length === 0) { list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">No chapters found</div>'; return; }
    filteredChapters.forEach(chapter => {
      const div = document.createElement('div'), isSelected = selectedChapters.has(chapter.chapter_id), cache = chapterDataCache.get(chapter.chapter_id), status = cache ? cache.status : 'gray';
      div.className = `chapter-item${isSelected?' selected':''}`;
      div.onclick = (e) => { if (e.target.tagName!=='BUTTON' && !e.target.closest('.btn-preview') && !e.target.closest('.btn-download') && !e.target.closest('.btn-refetch')) window.toggleChapter(chapter.chapter_id); };
      const group = chapter.scanlation_group?.name || 'Unknown', isOfficial = chapter.is_official || group.toLowerCase()==='official';
      let resultHtml = '';
      if (cache && cache.status!=='gray' && cache.status!=='fetching') { const sizeMB = (cache.size/1024/1024).toFixed(1); resultHtml = `<div class="chapter-result">Size: <span>${sizeMB}MB</span>, Downloaded: <span>${cache.total-cache.failed}</span>, Failed: <span style="color:${cache.failed>0?'var(--error)':'var(--success)'}">${cache.failed}</span></div>`; }
      div.innerHTML = `<div class="status-box ${status==='green'?'green':status==='yellow'?'yellow':status==='red'?'red':status==='fetching'?'fetching':''}" title="Status: ${status}"></div><div class="chapter-info"><div class="chapter-number">Ch. ${chapter.number}${chapter.name?' — '+chapter.name:''}</div><div class="chapter-group ${isOfficial?'official':''}">${group}</div>${resultHtml}</div><div class="chapter-actions"><div style="flex:1"></div><button class="btn btn-secondary btn-preview" onclick="event.stopPropagation();window.previewChapter('${chapter.chapter_id}')">👁 Preview</button><button class="btn btn-secondary btn-refetch" onclick="event.stopPropagation();window.refetchChapter('${chapter.chapter_id}')" title="Refetch">🔄 Refetch</button><button class="btn btn-secondary btn-download" onclick="event.stopPropagation();window.handleIndividualFetch('${chapter.chapter_id}','${String(chapter.number).replace(/'/g,"\\'")}','${chapter.name?String(chapter.name).replace(/'/g,"\\'"):''}')" ${isDownloading.has(chapter.chapter_id)?'disabled':''}>${isDownloading.has(chapter.chapter_id)?'⏳...':'⬇ Fetch & Download'}</button></div>`;
      list.appendChild(div);
    });
    document.getElementById('chaptersCount').textContent = `${filteredChapters.length} shown (of ${allChapters.length})`;
  };

  window.toggleChapter = (id) => { if (selectedChapters.has(id)) selectedChapters.delete(id); else selectedChapters.add(id); window.renderChapters(); window.updateCount(); };
  window.selectAll = () => { filteredChapters.forEach(ch => selectedChapters.add(ch.chapter_id)); window.renderChapters(); window.updateCount(); };
  window.deselectAll = () => { selectedChapters.clear(); window.renderChapters(); window.updateCount(); };
  
  window.selectUniqueChapters = () => {
    selectedChapters.clear(); const seen = new Set();
    filteredChapters.forEach(ch => { const num = parseFloat(ch.number); if (!isNaN(num) && num===Math.floor(num) && !seen.has(num)) { seen.add(num); selectedChapters.add(ch.chapter_id); } });
    window.renderChapters(); window.updateCount();
  };

  window.filterChapters = () => {
    const filter = document.getElementById('scanlatorFilter')?.value;
    filteredChapters = !filter ? [...allChapters] : allChapters.filter(ch => (ch.scanlation_group?.name||'Unknown') === filter);
    window.renderChapters(); window.updateCount();
  };

  window.selectByRange = () => {
    const input = document.getElementById('chapterRange')?.value.trim();
    if (!input) { alert('Enter range like 1-30 or 5,10,15'); return; }
    selectedChapters.clear();
    const parts = input.split(',').map(p=>p.trim()), chapters = new Set();
    parts.forEach(part => {
      if (part.includes('-')) { const [s,e] = part.split('-').map(n=>parseFloat(n.trim())); if (!isNaN(s)&&!isNaN(e)) for (let i=Math.floor(s); i<=Math.floor(e); i++) chapters.add(i); }
      else { const num = parseFloat(part); if (!isNaN(num)) chapters.add(Math.floor(num)); }
    });
    Array.from(chapters).forEach(num => { const ch = filteredChapters.find(c => parseFloat(c.number)===num); if (ch) selectedChapters.add(ch.chapter_id); });
    window.renderChapters(); window.updateCount();
  };

  window.updateCount = () => {
    const sel = document.getElementById('selectedCount'); if (sel) sel.textContent = selectedChapters.size;
    const jsonBtn = document.getElementById('showJsonBtn'); if (jsonBtn) jsonBtn.disabled = selectedChapters.size===0;
    const fetchBtn = document.getElementById('batchFetchBtn'); if (fetchBtn) fetchBtn.disabled = selectedChapters.size===0 || isBatchFetching;
    let failed = 0; selectedChapters.forEach(id => { const c = chapterDataCache.get(id); if (c && (c.status==='yellow'||c.status==='red')) failed++; });
    const refBtn = document.getElementById('batchRefetchFailedBtn'); if (refBtn) { refBtn.disabled = failed===0 || isBatchFetching; refBtn.innerHTML = `<span>🔄</span> REFETCH ALL FAILED (${failed})`; }
    let ready=0, size=0; selectedChapters.forEach(id => { const c = chapterDataCache.get(id); if (c && (c.status==='green'||c.status==='yellow')) { ready++; size+=c.size; } });
    const zipBtn = document.getElementById('batchZipBtn'); if (zipBtn) { zipBtn.disabled = ready===0 || isBatchFetching || isBatchZipping; zipBtn.innerHTML = `<span>📦</span> DOWNLOAD ZIPs (${ready} Ch, ${(size/1024/1024).toFixed(1)} MB)`; }
  };

  window.previewChapter = async (chapterId) => {
    const panel = document.getElementById('previewPanel'), loading = document.getElementById('previewLoading'), error = document.getElementById('previewError'), iframe = document.getElementById('previewFrame');
    if (!panel) return; panel.style.display = 'block'; loading.style.display = 'block'; error.style.display = 'none'; iframe.style.display = 'none'; iframe.srcdoc = '';
    try {
      let chapter = allChapters.find(ch => ch.chapter_id == chapterId);
      if (!chapter) { const res = await fetchRetry(`${API_BASE}/chapters/${chapterId}/`); chapter = res.result; if (!chapter) throw new Error('Chapter not found'); }
      const res = await fetchChapterWithRetry(chapterId), urls = extractImageUrls(res);
      if (!urls.length) throw new Error('No images found');
      const title = `Ch. ${chapter.number}${chapter.name?' — '+chapter.name:''}`, group = chapter.scanlation_group?.name||'Unknown';
      iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#1a1b26;color:#c0caf5;padding:16px;line-height:1.5}.header{position:sticky;top:0;background:#24283b;padding:12px 16px;border-radius:8px;margin-bottom:16px;border:1px solid #414868;z-index:10}.chapter-title{font-weight:700;font-size:16px;margin-bottom:4px}.chapter-meta{font-size:12px;color:#7982a9}.pages{display:flex;flex-direction:column;gap:12px;max-width:900px;margin:0 auto}.page{background:#2f3549;border-radius:8px;overflow:hidden;border:1px solid #414868}.page img{width:100%;height:auto;display:block;max-height:80vh;object-fit:contain}.page-num{padding:8px 12px;font-size:11px;color:#7982a9;background:#24283b;text-align:center}@media(min-width:768px){.pages{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}}</style></head><body><div class="header"><div class="chapter-title">${title}</div><div class="chapter-meta">${group} • ${urls.length} pages</div></div><div class="pages">${urls.map((u,i)=>`<div class="page"><img src="https://wsrv.nl/?url=${encodeURIComponent(u)}&w=1080&we&q=75&output=webp" alt="Page ${i+1}" loading="lazy"><div class="page-num">Page ${i+1}</div></div>`).join('')}</div></body></html>`;
      iframe.onload = () => { loading.style.display='none'; iframe.style.display='block'; };
    } catch (err) { loading.style.display='none'; error.textContent='Error: '+err.message; error.style.display='block'; console.error(err); }
  };

  window.closePreview = () => { const panel=document.getElementById('previewPanel'), iframe=document.getElementById('previewFrame'); if(panel)panel.style.display='none'; if(iframe){iframe.srcdoc='';iframe.style.display='none';} };

  window.fetchChapterImages = async (chapterId) => {
    try {
      const res = await fetchChapterWithRetry(chapterId), urls = extractImageUrls(res);
      if (!urls.length) throw new Error('No images found');
      const blobs = []; let totalSize = 0, failed = 0, executing = new Set(), CONCURRENCY = 4;
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i], ext = url.split('?')[0].split('.').pop()?.toLowerCase()||'jpg', fileName = `page_${String(i+1).padStart(3,'0')}.${ext}`;
        const promise = fetch(WORKER_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url}) })
          .then(async r => { if(!r.ok) throw new Error('HTTP '+r.status); const blob = await r.blob(); return {fileName,blob,size:blob.size}; })
          .then(data => { executing.delete(promise); blobs.push(data); totalSize+=data.size; totalImagesDownloaded++; totalDownloadedBytes+=data.size; window.updateConsoleStats(); })
          .catch(() => { executing.delete(promise); failed++; });
        executing.add(promise); if (executing.size >= CONCURRENCY) await Promise.race(executing);
      }
      await Promise.all(executing);
      return { blobs, size: totalSize, total: urls.length, failed, status: failed===0?'green':failed<urls.length?'yellow':'red' };
    } catch (err) { return { blobs:[], size:0, total:0, failed:0, status:'red', error:err.message }; }
  };

  window.updateChapterUI = (id, data) => { chapterDataCache.set(id, data); window.renderChapters(); window.updateCount(); };

  window.handleIndividualFetch = async (chapterId, number, name) => {
    if (isDownloading.has(chapterId)) return;
    const btn = event?.target; if (!btn) return;
    const original = btn.innerHTML;
    try {
      isDownloading.add(chapterId); btn.disabled = true; btn.innerHTML = '⏳...';
      chapterDataCache.set(chapterId, {status:'fetching'}); window.renderChapters();
      const data = await window.fetchChapterImages(chapterId);
      window.updateChapterUI(chapterId, data);
      if (data.status === 'green') { window.logConsole(`✓ Chapter ${number} fetched`, 'success'); await window.createChapterZip(chapterId, number, name, data.blobs); }
      else if (data.status === 'yellow') window.logConsole(`⚠ Chapter ${number} fetched with errors`, 'warning');
      else window.logConsole(`❌ Chapter ${number} failed`, 'error');
    } catch (err) { console.error(err); chapterDataCache.set(chapterId, {status:'red',error:err.message}); window.renderChapters(); }
    finally { isDownloading.delete(chapterId); window.renderChapters(); window.updateCount(); }
  };

  window.createChapterZip = async (chapterId, number, name, blobs) => {
    const zip = new JSZip(), folder = zip.folder(`Ch.${number}${name?' - '+name:''}`);
    blobs.forEach(b => { if (b?.fileName && b?.blob) folder.file(b.fileName, b.blob); });
    const title = (document.getElementById('mangaTitle')?.textContent || 'manga').replace(/[^a-z0-9]/gi,'_').slice(0,50);
    const content = await zip.generateAsync({type:'blob'});
    saveAs(content, `${title}_Ch.${number}.zip`);
    window.logConsole(`💾 Saved ${title}_Ch.${number}.zip`, 'success');
  };

  window.refetchChapter = async (chapterId) => {
    const chapter = allChapters.find(c => c.chapter_id === chapterId);
    if (!chapter) { window.logConsole(`❌ Chapter ${chapterId} not found`, 'error'); return; }
    chapterDataCache.delete(chapterId); window.renderChapters();
    try {
      chapterDataCache.set(chapterId, {status:'fetching'}); window.renderChapters();
      window.logConsole(`🔄 Refetching Chapter ${chapter.number}...`, 'info');
      const data = await window.fetchChapterImages(chapterId);
      window.updateChapterUI(chapterId, data);
      if (data.status==='green') window.logConsole(`✓ Chapter ${chapter.number} refetched`, 'success');
      else if (data.status==='yellow') window.logConsole(`⚠ Chapter ${chapter.number} refetched with errors`, 'warning');
      else window.logConsole(`❌ Chapter ${chapter.number} refetch failed`, 'error');
    } catch (err) { console.error(err); chapterDataCache.set(chapterId,{status:'red',error:err.message}); window.renderChapters(); window.logConsole(`❌ Refetch error: ${err.message}`, 'error'); }
  };

  window.startBatchRefetchFailed = async () => {
    if (isBatchFetching) return;
    const failed = []; selectedChapters.forEach(id => { const c = chapterDataCache.get(id); if (c && (c.status==='yellow'||c.status==='red')) { const ch = allChapters.find(x=>x.chapter_id===id); if (ch) failed.push(ch); } });
    if (!failed.length) { alert('No failed chapters to refetch!'); return; }
    isBatchFetching = true; batchFetchCancelled = false; batchFetchPaused = false;
    window.showConsole(); window.logConsole(`🔄 Refetching ${failed.length} failed chapters`, 'info');
    const pauseBtn = document.getElementById('pauseBtn'); if (pauseBtn) { pauseBtn.style.display='flex'; pauseBtn.innerHTML='<span>⏸</span> PAUSE'; }
    document.getElementById('batchSummary')?.classList.remove('active');
    let done = 0, executing = new Set(), CONCURRENCY = 3;
    try {
      for (let i=0; i<failed.length; i++) {
        if (batchFetchCancelled) break;
        while (batchFetchPaused && !batchFetchCancelled) await new Promise(r => batchFetchResolve = r);
        if (batchFetchCancelled) break;
        while (executing.size >= CONCURRENCY) await Promise.race(executing);
        const ch = failed[i]; window.logConsole(`📥 Refetching Chapter ${ch.number}...`, 'info');
        const promise = (async () => {
          const data = await window.fetchChapterImages(ch.chapter_id);
          window.updateChapterUI(ch.chapter_id, data); done++;
          window.updateConsoleProgress(done, failed.length, totalImagesDownloaded, totalDownloadedBytes/1024/1024);
          if (data.status==='green') window.logConsole(`✓ Chapter ${ch.number} refetched`, 'success');
          else if (data.status==='yellow') window.logConsole(`⚠ Chapter ${ch.number} refetched with errors`, 'warning');
          else window.logConsole(`❌ Chapter ${ch.number} refetch failed`, 'error');
        })();
        executing.add(promise); promise.finally(() => executing.delete(promise));
      }
      await Promise.all(executing);
      if (!batchFetchCancelled) { window.logConsole(`🎉 Batch refetch complete!`, 'success'); const s = document.getElementById('summaryText'); if (s) { s.textContent = `${done} chapters refetched. Ready to download ZIPs.`; document.getElementById('batchSummary')?.classList.add('active'); } }
    } catch (err) { window.logConsole(`❌ Fatal error: ${err.message}`, 'error'); }
    finally { isBatchFetching = false; batchFetchPaused = false; if (pauseBtn) pauseBtn.style.display='none'; window.updateCount(); }
  };

  window.startBatchFetch = async () => {
    if (!selectedChapters.size || isBatchFetching) return;
    isBatchFetching = true; batchFetchCancelled = false; batchFetchPaused = false;
    window.showConsole(); window.clearConsole();
    const pauseBtn = document.getElementById('pauseBtn'); if (pauseBtn) { pauseBtn.style.display='flex'; pauseBtn.innerHTML='<span>⏸</span> PAUSE'; }
    document.getElementById('batchSummary')?.classList.remove('active');
    const selected = allChapters.filter(ch => selectedChapters.has(ch.chapter_id));
    window.logConsole(`📦 Fetching ${selected.length} chapters`, 'info');
    let done = 0, executing = new Set(), CONCURRENCY = 3;
    try {
      for (let i=0; i<selected.length; i++) {
        if (batchFetchCancelled) break;
        while (batchFetchPaused && !batchFetchCancelled) await new Promise(r => batchFetchResolve = r);
        if (batchFetchCancelled) break;
        while (executing.size >= CONCURRENCY) await Promise.race(executing);
        const ch = selected[i]; window.logConsole(`📥 Fetching Chapter ${ch.number}...`, 'info');
        const promise = (async () => {
          const data = await window.fetchChapterImages(ch.chapter_id);
          window.updateChapterUI(ch.chapter_id, data); done++;
          window.updateConsoleProgress(done, selected.length, totalImagesDownloaded, totalDownloadedBytes/1024/1024);
          if (data.status==='green') window.logConsole(`✓ Chapter ${ch.number} fetched`, 'success');
          else if (data.status==='yellow') window.logConsole(`⚠ Chapter ${ch.number} fetched with errors`, 'warning');
          else window.logConsole(`❌ Chapter ${ch.number} failed`, 'error');
        })();
        executing.add(promise); promise.finally(() => executing.delete(promise));
      }
      await Promise.all(executing);
      if (!batchFetchCancelled) { window.logConsole(`🎉 Batch fetch complete!`, 'success'); const s = document.getElementById('summaryText'); if (s) { s.textContent = `${done} chapters fetched. Ready to download ZIPs.`; document.getElementById('batchSummary')?.classList.add('active'); } }
    } catch (err) { window.logConsole(`❌ Fatal error: ${err.message}`, 'error'); }
    finally { isBatchFetching = false; batchFetchPaused = false; if (pauseBtn) pauseBtn.style.display='none'; window.updateCount(); }
  };

  window.togglePause = () => {
    if (!isBatchFetching) return;
    batchFetchPaused = !batchFetchPaused;
    const btn = document.getElementById('pauseBtn');
    if (!btn) return;
    if (batchFetchPaused) { btn.innerHTML='<span>▶</span> RESUME'; window.logConsole(`⏸ Paused`, 'warning'); }
    else { btn.innerHTML='<span>⏸</span> PAUSE'; window.logConsole(`▶ Resumed`, 'info'); if (batchFetchResolve) batchFetchResolve(); }
  };

  window.startBatchZipDownload = async () => {
    if (isBatchZipping) return;
    const toZip = []; selectedChapters.forEach(id => {
      const c = chapterDataCache.get(id);
      if (c && c.blobs && Array.isArray(c.blobs) && c.blobs.length>0 && (c.status==='green'||c.status==='yellow')) {
        const ch = allChapters.find(x=>x.chapter_id===id); if (ch) toZip.push({chapter:ch, data:c});
      }
    });
    if (!toZip.length) { alert('No successfully fetched chapters to zip. Fetch Selected Chapters first.'); return; }
    isBatchZipping = true; window.updateCount(); window.showConsole();
    window.logConsole(`📦 Generating ZIPs for ${toZip.length} chapters...`, 'info');
    const mangaTitle = (mangaDataCache?.title || document.getElementById('mangaTitle')?.textContent || 'manga').replace(/[\\/:\*?"<>|]/g,'').trim().slice(0,50);
    let zipIdx = 1, currentZip = new JSZip(), currentSize = 0, rangeStart = null, rangeEnd = null;
    const saveZip = async (isFinal) => {
      if (currentSize === 0) return;
      const rangeStr = (rangeStart!==null && rangeEnd!==null) ? `Ch${Math.floor(rangeStart)}-${Math.floor(rangeEnd)}` : `part${zipIdx}`;
      const zipName = `${mangaTitle} ${rangeStr}.zip`;
      window.logConsole(`🗜️ Generating ZIP (${(currentSize/1024/1024).toFixed(1)} MB)...`, 'info');
      const content = await currentZip.generateAsync({type:'blob',compression:'STORE',compressionOptions:{level:0}});
      saveAs(content, zipName); window.logConsole(`✓ Saved: ${zipName}`, 'success');
      zipIdx++; currentZip = new JSZip(); currentSize = 0; rangeStart = null;
    };
    try {
      for (let i=0; i<toZip.length; i++) {
        const {chapter, data} = toZip[i], num = parseFloat(chapter.number);
        if (rangeStart === null) rangeStart = num; rangeEnd = num;
        const folder = currentZip.folder(`Ch.${chapter.number}${chapter.name?' - '+chapter.name:''}`);
        if (data.blobs && Array.isArray(data.blobs)) data.blobs.forEach(b => { if (b?.fileName && b?.blob) folder.file(b.fileName, b.blob); });
        currentSize += (data.size || 0);
        if (currentSize >= MAX_ZIP_SIZE_BYTES && i < toZip.length - 1) { await saveZip(false); rangeStart = null; }
      }
      await saveZip(true);
      window.logConsole(`🎉 ZIP generation complete!`, 'success');
      await window.saveMangaToList();
    } catch (err) { window.logConsole(`❌ ZIP Error: ${err.message}`, 'error'); console.error(err); }
    finally { isBatchZipping = false; window.updateCount(); }
  };

  window.showJsonSelected = async () => {
    if (!selectedChapters.size) return;
    const modal = document.getElementById('jsonModal'), loading = document.getElementById('jsonLoading'), error = document.getElementById('jsonError'), output = document.getElementById('jsonOutput'), copyBtn = document.getElementById('copyJsonBtn'), progress = document.getElementById('fetchProgress');
    if (!modal) return;
    modal.classList.add('active'); loading.style.display='block'; error.style.display='none'; output.textContent=''; copyBtn.disabled=true;
    document.getElementById('fetchingCount').textContent = selectedChapters.size; progress.textContent='';
    try {
      const selected = allChapters.filter(ch => selectedChapters.has(ch.chapter_id));
      const mangaObj = { title: mangaDataCache?.title || document.getElementById('mangaTitle')?.textContent || '', url: document.getElementById('urlInput')?.value.trim() || '', cover: mangaDataCache?.poster?.large || mangaDataCache?.poster?.medium || '', description: mangaDataCache?.synopsis || document.getElementById('mangaDesc')?.textContent || '', type: mangaDataCache?.type || document.getElementById('mangaType')?.textContent || '', language: mangaDataCache?.original_language || document.getElementById('mangaLang')?.textContent || '', status: mangaDataCache?.status || document.getElementById('mangaStatus')?.textContent || '', year: mangaDataCache?.year || document.getElementById('mangaYear')?.textContent || '', latest_chapter: mangaDataCache?.latest_chapter || document.getElementById('mangaLatest')?.textContent || '', genres: mangaDataCache?.resolvedGenres || [], authors: mangaDataCache?.resolvedAuthors || [], artists: mangaDataCache?.resolvedArtists || [] };
      const result = { manga: mangaObj, chapters: [] };
      const fetchChap = async (ch, idx, total) => {
        progress.textContent = `Fetching ${idx+1} of ${total}: Ch. ${ch.number}`;
        try {
          const res = await fetchChapterWithRetry(ch.chapter_id), urls = extractImageUrls(res);
          return { chapter_id: ch.chapter_id, number: ch.number, name: ch.name||null, scanlation_group: ch.scanlation_group?.name||'Unknown', language: ch.language||'en', pages_count: urls.length, images: urls };
        } catch (err) { console.warn(`Failed chapter ${ch.chapter_id}:`, err); return { chapter_id: ch.chapter_id, number: ch.number, name: ch.name||null, scanlation_group: ch.scanlation_group?.name||'Unknown', error: `Fetch failed: ${err.message}`, images: [] }; }
      };
      const results = await fetchWithConcurrency(selected, fetchChap, 4, (done,total) => { progress.textContent = `Progress: ${done}/${total}`; });
      result.chapters = results; currentJsonData = result;
      output.textContent = JSON.stringify(result, null, 2); copyBtn.disabled = false;
    } catch (err) { error.textContent = 'Error: ' + err.message; error.style.display = 'block'; output.textContent = ''; console.error(err); }
    finally { loading.style.display = 'none'; }
  };

  window.closeJsonModal = () => { document.getElementById('jsonModal')?.classList.remove('active'); document.getElementById('copyStatus')?.classList.remove('show'); currentJsonData = null; };

  window.copyJsonToClipboard = async () => {
    if (!currentJsonData) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(currentJsonData, null, 2));
      const status = document.getElementById('copyStatus'); if (status) { status.classList.add('show'); setTimeout(()=>status.classList.remove('show'),2000); }
    } catch {
      const ta = document.createElement('textarea'); ta.value = JSON.stringify(currentJsonData, null, 2); document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      const status = document.getElementById('copyStatus'); if (status) { status.classList.add('show'); setTimeout(()=>status.classList.remove('show'),2000); }
    }
  };

  window.saveMangaToList = async () => {
    const saveBtn = document.getElementById('saveToListBtn'), saveStatus = document.getElementById('saveStatus'), mangaId = document.getElementById('mangaid')?.textContent?.trim(), latest = document.getElementById('mangaLatest')?.textContent?.trim();
    if (!mangaId || !latest) return;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '⏳ Saving...'; }
    if (saveStatus) saveStatus.textContent = '';
    try {
      const res = await fetch('https://tiny-night-7d75.yuush.workers.dev/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ manga_id: mangaId, latest_chapter: latest }) });
      const result = await res.json();
      if (result.success) { if (saveStatus) { saveStatus.textContent = '✓ Saved!'; saveStatus.style.color = 'var(--success)'; } window.showToast(`✓ ${mangaId}:${latest} saved!`); }
      else throw new Error(result.error || 'Save failed');
    } catch (err) { console.error(err); if (saveStatus) { saveStatus.textContent = '✗ Failed'; saveStatus.style.color = 'var(--error)'; } alert('Error: ' + err.message); }
    finally { if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = 'Save ID'; } setTimeout(()=>{ if (saveStatus && saveStatus.textContent) saveStatus.textContent=''; }, 4000); }
  };

  window.showToast = (msg) => {
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;top:20px;right:20px;background:var(--bg-secondary);border:1px solid var(--success);border-radius:8px;padding:12px 20px;color:var(--text-primary);font-size:13px;z-index:3000;box-shadow:0 4px 20px rgba(0,0,0,0.4);animation:slideIn 0.3s ease;`;
    t.textContent = msg; document.body.appendChild(t);
    setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity 0.3s'; setTimeout(()=>t.remove(),300); }, 3000);
  };

  // ============ INIT ============
  const init = async () => {
    // Load libraries if needed
    if (typeof JSZip === 'undefined') await new Promise(r => { const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload=r; document.head.appendChild(s); });
    if (typeof saveAs === 'undefined') await new Promise(r => { const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js'; s.onload=r; document.head.appendChild(s); });

    // Create UI overlay
    const overlay = document.createElement('div');
    overlay.id = 'mdx-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif;';
    overlay.innerHTML = `<div id="mdx-modal" style="background:#1a1b26;color:#c0caf5;border-radius:12px;border:1px solid #414868;max-width:1000px;width:100%;max-height:95vh;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;"><div id="mdx-header" style="padding:16px 20px;border-bottom:1px solid #414868;display:flex;justify-content:space-between;align-items:center;background:#24283b;flex-shrink:0;"><strong style="font-size:16px;">📚 Manga Downloader</strong><button id="mdx-close" style="background:none;border:none;color:#7982a9;font-size:24px;cursor:pointer;padding:4px 8px;">&times;</button></div><div id="mdx-body" style="flex:1;overflow:hidden;display:flex;flex-direction:column;"><div id="mdx-loading" style="text-align:center;padding:60px;color:#7982a9;"><div style="width:40px;height:40px;border:3px solid #414868;border-top-color:#e0af68;border-radius:50%;animation:mdx-spin 1s linear infinite;margin:0 auto 16px"></div><div>Fetching chapters...</div></div></div></div><style>@keyframes mdx-spin{to{transform:rotate(360deg)}}#mdx-content{display:none;flex:1;overflow:hidden;}#mdx-chapters{flex:1;overflow-y:auto;padding:16px;background:#1f202e;}#mdx-chap-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #414868;}#mdx-chap-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;}#mdx-chap-item{display:flex;align-items:center;padding:10px 12px;background:#24283b;border-radius:6px;font-size:12px;cursor:pointer;transition:background.15s;border:1px solid transparent;}#mdx-chap-item:hover{background:#2f3549;}#mdx-chap-item.selected{background:rgba(224,175,104,.15);border-color:#e0af68;}#mdx-chap-check{width:18px;height:18px;margin-right:10px;cursor:pointer;}#mdx-chap-info{flex:1;}#mdx-chap-num{font-weight:600;color:#c0caf5;margin-bottom:2px;}#mdx-chap-group{font-size:10px;color:#7982a9;}#mdx-footer{padding:14px 20px;border-top:1px solid #414868;background:#24283b;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;gap:10px;flex-wrap:wrap;}#mdx-actions{display:flex;gap:8px;flex-wrap:wrap;}#mdx-btn{padding:8px 16px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:background.2s;}#mdx-btn-primary{background:#e0af68;color:#1a1b26;}#mdx-btn-primary:hover{background:#f0bf78;}#mdx-btn-primary:disabled{opacity:.5;cursor:not-allowed;}#mdx-btn-secondary{background:#2f3549;color:#c0caf5;border:1px solid #414868;}#mdx-btn-secondary:hover{background:#414868;}#mdx-count{font-size:13px;color:#7982a9;}#mdx-count strong{color:#e0af68;}#mdx-console{position:fixed;bottom:20px;right:20px;width:400px;background:#24283b;border:1px solid #414868;border-radius:8px;padding:12px;display:none;flex-direction:column;max-height:280px;z-index:100000;}#mdx-console.active{display:flex;}#mdx-console-log{flex:1;overflow-y:auto;font-family:monospace;font-size:11px;margin-bottom:8px;}#mdx-console-line{padding:3px 6px;margin:2px 0;border-radius:4px;}#mdx-console-line.info{color:#7982a9;}#mdx-console-line.success{color:#9ece6a;background:rgba(158,206,106,.1);}#mdx-console-line.error{color:#f7768e;background:rgba(247,118,142,.1);}#mdx-progress{height:4px;background:#1a1b26;border-radius:2px;overflow:hidden;}#mdx-progress-fill{height:100%;background:#9ece6a;transition:width.3s;}</style>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById('mdx-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    // Fetch manga data
    try {
      const url = location.href, code = extractCode(url);
      if (!code) throw new Error('Not a valid comix.to title page');
      const data = await fetchRetry(`${API_BASE}/manga/${code}/`), manga = data.result;
      if (!manga) throw new Error('Manga not found');
      mangaDataCache = manga;
      allChapters = await (async () => { const ch=[], p=1; let hasMore=true, page=p; while(hasMore){const res=await fetchRetry(`${API_BASE}/manga/${code}/chapters?limit=100&page=${page}&order[number]=asc`);const items=res.result?.items||[];if(!items.length)hasMore=false;else{ch.push(...items);hasMore=items.length===100;page++;}await new Promise(r=>setTimeout(r,50));}return ch.sort((a,b)=>{const na=parseFloat(a.number),nb=parseFloat(b.number);if(!isNaN(na)&&!isNaN(nb))return na-nb;return String(a.number).localeCompare(String(b.number),undefined,{numeric:true});});})();
      document.getElementById('mdx-loading').style.display = 'none';
      const content = document.createElement('div'); content.id = 'mdx-content'; content.style.cssText = 'display:flex;flex-direction:column;height:100%;';
      content.innerHTML = `<div id="mdx-chapters"><div id="mdx-chap-header"><span>📖 Select Chapters (${allChapters.length} total)</span><span style="font-size:11px;color:#7982a9;">Click to toggle</span></div><div id="mdx-chap-list"></div></div><div id="mdx-footer"><div id="mdx-actions"><button id="mdx-btn" class="mdx-btn-secondary" onclick="window.selectAll()">All</button><button id="mdx-btn" class="mdx-btn-secondary" onclick="window.deselectAll()">None</button><button id="mdx-btn" class="mdx-btn-secondary" onclick="window.selectUniqueChapters()">Unique Only</button></div><div style="display:flex;align-items:center;gap:16px;"><div id="mdx-count"><strong id="mdx-selected-count">0</strong> selected</div><button id="mdx-download-btn" style="padding:10px 20px;background:#9ece6a;color:#1a1b26;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;" onclick="window.startBatchZipDownload()" disabled>📦 DOWNLOAD</button></div></div></div>`;
      document.getElementById('mdx-body').appendChild(content);
      const consoleEl = document.createElement('div'); consoleEl.id = 'mdx-console'; consoleEl.innerHTML = '<div id="mdx-console-log"></div><div id="mdx-progress"><div id="mdx-progress-fill" style="width:0%"></div></div>'; document.body.appendChild(consoleEl);
      window.renderChapters(); window.updateCount();
    } catch (err) {
      document.getElementById('mdx-loading').style.display = 'none';
      document.getElementById('mdx-body').innerHTML = `<div style="padding:40px;color:#f7768e;text-align:center;">❌ Error: ${err.message}</div><div style="text-align:center;margin-top:16px;"><button onclick="document.getElementById('mdx-overlay').remove()" style="padding:10px 24px;background:#e0af68;border:none;border-radius:6px;color:#1a1b26;font-weight:600;cursor:pointer">Close</button></div>`;
    }
  };

  // Start
  init();
})();
