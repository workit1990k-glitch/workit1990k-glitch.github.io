/* ============================================================================
 *  Downloader (Auto-Splitting ~495 MB, Simplified Naming)
 * - Downloads via Cloudflare Worker, resizes to 1280px, WebP q=0.75 (Client-side)
 * - Groups chapters into ~495 MB chunks.
 * - File naming: TitleName_ch1-ch30.zip
 * - TRUE GLOBAL WORKER POOL: N workers pull from a single flat task list.
 * ==========================================================================*/
(async function () {
  'use strict';
  if (window.__XCOMIC_DL__) return;
  const api = (window.__XCOMIC_DL__ = { toggle, close });

  const MAX_WIDTH = 1280;
  const QUALITY = 0.75;
  const GLOBAL_CONCURRENCY = 6;      // 👈 global pool size (was PAGE_CONCURRENCY)
  const IMG_RETRIES = 1;
  const MAX_ZIP_BYTES = 495 * 1024 * 1024;

  const CF_WORKER_URL = 'https://xcom.yuush.workers.dev';

  const PROXIES = [
    { name: 'cloudflare', processed: false, make: (u) => CF_WORKER_URL + '/?url=' + encodeURIComponent(u) },
  ];

  /* ---------------------------------------------------------- UI scaffold */
  const style = document.createElement('style');
  style.textContent = `
  #xcdl-root{position:fixed;top:60px;right:16px;width:440px;max-height:85vh;z-index:2147483647;
    display:flex;flex-direction:column;font:13px/1.45 system-ui,Segoe UI,Roboto,sans-serif;
    background:#14181f;color:#e6e9ef;border:1px solid #2b3340;border-radius:12px;
    box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden}
  #xcdl-root *{box-sizing:border-box}
  .xcdl-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1b2230;
    font-weight:600;font-size:14px}
  .xcdl-head .sp{flex:1}
  .xcdl-x{background:none;border:none;color:#9aa4b2;font-size:18px;cursor:pointer;line-height:1}
  .xcdl-body{padding:10px 12px;overflow-y:auto;flex:1}
  .xcdl-row{display:flex;align-items:center;gap:6px;margin:4px 0}
  .xcdl-row select{flex:1;background:#0e1319;color:#e6e9ef;border:1px solid #2b3340;
    border-radius:6px;padding:5px}
  .xcdl-btn{background:#2f6fed;border:none;color:#fff;border-radius:7px;padding:8px 12px;
    cursor:pointer;font-size:12px;text-align:left;width:100%;margin-bottom:6px}
  .xcdl-btn.sec{background:#26303d;width:auto;margin-bottom:0}
  .xcdl-btn:disabled{opacity:.45;cursor:default}
  .xcdl-btn.danger{background:#b23b3b;width:auto;margin-bottom:0}
  .xcdl-btn.part-btn{background:#1b2230;border:1px solid #2f6fed;display:flex;justify-content:space-between;align-items:center}
  .xcdl-btn.part-btn:hover{background:#232d3d}
  .xcdl-stats{padding:8px 12px 2px;border-top:1px solid #232b36;font-size:12px;color:#cfe0f5;white-space:pre-line}
  .xcdl-fails{max-height:110px;overflow-y:auto;padding:4px 12px;font-size:11px;color:#e08a8a}
  .xcdl-fails div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .xcdl-prog{padding:6px 12px 10px;font-size:11px;color:#7c8794;white-space:pre-line}
  .xcdl-list{margin-top:8px;border-top:1px solid #232b36;padding-top:6px}
  .xcdl-item{display:flex;gap:8px;align-items:center;padding:3px 2px;border-radius:5px;cursor:pointer}
  .xcdl-item:hover{background:#1d2632}
  .xcdl-item input{accent-color:#2f6fed}
  .xcdl-item .n{color:#8f9bad;min-width:52px}
  .xcdl-item .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .xcdl-empty{color:#7c8794;padding:14px 4px;text-align:center}`;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'xcdl-root';
  root.innerHTML = `
    <div class="xcdl-head"><span>⬇ XCOMIC downloader</span><span class="sp"></span>
      <button class="xcdl-x" title="Close">×</button></div>
    <div class="xcdl-body">
      <div class="xcdl-row"><span>Edition:</span><select id="xcdl-ed" disabled></select></div>
      <div class="xcdl-row">
        <button class="xcdl-btn sec" id="xcdl-all">Select all</button>
        <button class="xcdl-btn sec" id="xcdl-none">None</button>
        <span style="flex:1"></span>
        <button class="xcdl-btn danger" id="xcdl-retry" style="display:none">Retry failed</button>
        <button class="xcdl-btn danger" id="xcdl-dl" disabled>Download ZIP</button>
      </div>
      <div class="xcdl-list" id="xcdl-list"><div class="xcdl-empty">Loading editions…</div></div>
    </div>
    <div class="xcdl-stats" id="xcdl-stats">Chapters 0/0 · Images 0/0 · Failed 0</div>
    <div class="xcdl-fails" id="xcdl-fails"></div>
    <div class="xcdl-prog" id="xcdl-prog"></div>`;
  document.body.appendChild(root);
  root.querySelector('.xcdl-x').onclick = close;
  function close() { root.remove(); style.remove(); window.__XCOMIC_DL__ = null; }
  function toggle() { if (root.isConnected) close(); }
  const $ = (sel) => root.querySelector(sel);
  const prog = (t) => { $('#xcdl-prog').textContent = t; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

  /* ------------------------------------------------------------ JSZip */
  async function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  try {
    if (!window.JSZip) {
      const hosts = ['https://cdn.jsdelivr.net'];
      try { hosts.unshift(new URL(document.currentScript.src).origin); } catch (_) {}
      let ok = false;
      for (const h of hosts) {
        try { await loadScript(h + '/jszip.min.js'); ok = true; break; } catch (_) {}
      }
      if (!ok) throw new Error('JSZip could not be loaded');
    }
  } catch (e) { prog('Error: ' + e.message); }

  /* ------------------------------------------------------------ GraphQL */
  async function gql(query, variables) {
    const r = await fetch('/query/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors && j.errors.length) throw new Error(j.errors.map((e) => e.message).join('; '));
    return j.data;
  }
  const Q_TITLE = `query($id:ID!){get_title_titleNode(id:$id){id data{title}}}`;
  const Q_CHAPTERS = `query($select:Select_Comic_ChapterList){get_comic_chapterList_fullList(select:$select){paging{next} items{id data{id dname chaNum serial volNum datePublic}}}}`;
  const Q_PAGES = `query($id:ID!){get_chapterNode(id:$id){id data{imageUrls}}}`;
  const CH_COUNT_RE = /([0-9,]+) chapters/;

  /* ---------------------------------------------------------- title id */
  const m = location.pathname.match(/^\/title\/([^/]+)/i);
  if (!m) { prog('Open a /title/<id> page and run the bookmarklet again.'); return; }
  const titleId = m[1];

  try {
    const html = await (await fetch(location.pathname)).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const editions = [...doc.querySelectorAll('a[href^="/source/"]')].map((a) => {
      let p = a.parentElement;
      while (p && !(CH_COUNT_RE.test(p.textContent || '') && p.querySelectorAll('a[href^="/source/"]').length === 1)) p = p.parentElement;
      const count = +(p ? (p.textContent.match(CH_COUNT_RE) || [])[1] || '0' : '0').replace(/,/g, '');
      const flag = (a.parentElement && a.parentElement.querySelector('.font-family-NotoColorEmoji') || {}).textContent || '';
      return { id: a.getAttribute('href').split('/')[2] || '', count, flag };
    }).filter((e) => e.id && e.count > 0);

    if (!editions.length) { prog('No readable editions found on this title.'); return; }

    const sel = $('#xcdl-ed');
    sel.disabled = false;
    for (const e of editions) {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = `${e.flag || ''} ${e.id} — ${e.count} chapters`;
      sel.appendChild(o);
    }
    editions.sort((a, b) => b.count - a.count);
    sel.value = editions[0].id;

    let chapters = [];
    async function loadChapters(comicId) {
      $('#xcdl-list').innerHTML = '<div class="xcdl-empty">Loading chapters…</div>';
      chapters = [];
      let page = 1;
      while (true) {
        const data = await gql(Q_CHAPTERS, { select: { comic_id: comicId, page, size: 100, sortby: 'chapter_desc' } });
        const rootList = data.get_comic_chapterList_fullList;
        chapters.push(...rootList.items.map((it) => it.data));
        const next = (rootList.paging && rootList.paging.next) || 0;
        if (!next) break;
        page = next;
      }
      chapters.sort((a, b) => (a.volNum - b.volNum) || (a.chaNum - b.chaNum));
      renderList();
      $('#xcdl-dl').disabled = chapters.length === 0;
    }

    function renderList() {
      const list = $('#xcdl-list');
      list.innerHTML = '';
      for (const ch of chapters) {
        const label = document.createElement('label');
        label.className = 'xcdl-item';
        const num = ch.chaNum != null ? ch.chaNum : ch.serial;
        label.innerHTML = `<input type="checkbox" checked>
          <span class="n">${ch.volNum ? 'v' + ch.volNum + ' ' : ''}ch${num}</span>
          <span class="t" title=""></span>`;
        label.querySelector('.t').textContent = ch.dname || ('Chapter ' + num);
        label.dataset.id = ch.id;
        list.appendChild(label);
      }
    }

    sel.onchange = () => loadChapters(sel.value).catch((e) => prog('Error: ' + e.message));
    $('#xcdl-all').onclick = () => root.querySelectorAll('.xcdl-item input').forEach((i) => (i.checked = true));
    $('#xcdl-none').onclick = () => root.querySelectorAll('.xcdl-item input').forEach((i) => (i.checked = false));
    await loadChapters(sel.value);

    /* ------------------------------------------------------ download core */
    const stats = { chDone: 0, chTotal: 0, imgDone: 0, imgTotal: 0, failed: 0 };
    const failedList = [];
    let globalChaptersData = [];
    let currentTitleName = '';

    function renderStats() {
      $('#xcdl-stats').textContent = `Chapters ${stats.chDone}/${stats.chTotal} · Images ${stats.imgDone}/${stats.imgTotal} · Failed ${stats.failed}`;
      const box = $('#xcdl-fails');
      box.innerHTML = failedList.slice(-300).map((f) => `<div>✗ ${f.label} p${f.idx + 1} — ${f.url}</div>`).join('');
      $('#xcdl-retry').style.display = failedList.length ? '' : 'none';
      $('#xcdl-retry').textContent = `Retry failed (${failedList.length})`;
    }

    async function toWebp(blob, alreadyProcessed) {
      if (alreadyProcessed && blob.type === 'image/webp') return blob;
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, MAX_WIDTH / bmp.width);
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      bmp.close();
      return await new Promise((res) => c.toBlob(res, 'image/webp', QUALITY));
    }

    /* ------------------------------------------------ grab ONE image */
    // Task shape: { ch, chId, idx, url, dir, label }
    // Returns { chId, name, blob, size } or null.
    async function grabImage(task) {
      const { ch, chId, idx, url, dir, label } = task;
      for (const via of PROXIES) {
        try {
          const r = await fetch(via.make(url), { credentials: 'omit', mode: 'cors' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const b = await r.blob();
          if (!b.type.startsWith('image/')) throw new Error('not an image (' + b.type + ')');

          const processedBlob = await toWebp(b, via.processed);
          const fileName = `${dir}/${String(idx + 1).padStart(4, '0')}.webp`;

          stats.imgDone++;
          // Remove from failedList if it was there.
          const fi = failedList.findIndex((f) => f.url === url && f.idx === idx && f.ch.id === ch.id);
          if (fi >= 0) { failedList.splice(fi, 1); stats.failed = failedList.length; }

          return { chId, name: fileName, blob: processedBlob, size: processedBlob.size };
        } catch (e) { /* try next proxy */ }
      }

      // All proxies failed.
      if (!failedList.some((f) => f.url === url && f.idx === idx && f.ch.id === ch.id)) {
        failedList.push({ ch, idx, url, dir, label });
        stats.failed = failedList.length;
      }
      return null;
    }

    /* ------------------------------------------------ build allTasks */
    // 1) Resolve page URLs for every selected chapter (cheap, sequential GraphQL).
    // 2) Flatten into a single task array.
    async function buildAllTasks(pickedChapters, dirBase) {
      const allTasks = [];
      const chapterMap = new Map(); // chId -> { ch, files: [] }

      for (const ch of pickedChapters) {
        let urls;
        try {
          urls = (await gql(Q_PAGES, { id: ch.id })).get_chapterNode.data.imageUrls;
        } catch (e) {
          prog(`Skipping chapter ${ch.chaNum ?? ch.serial}: ${e.message}`);
          failedList.push({ ch, idx: -1, url: '', dir: '', label: `ch${ch.chaNum ?? ch.serial}`, chapterFail: true });
          stats.failed = failedList.length;
          stats.chDone++;
          renderStats();
          continue;
        }

        const num = ch.chaNum != null ? ch.chaNum : ch.serial;
        const label = `ch${num}`;
        const dir = `${dirBase}/${ch.volNum ? 'v' + safe(ch.volNum) + '_' : ''}ch${safe(num)}${ch.dname ? '_' + safe(ch.dname) : ''}`;

        chapterMap.set(ch.id, { ch, files: [] });
        stats.imgTotal += urls.length;

        for (let idx = 0; idx < urls.length; idx++) {
          allTasks.push({ ch, chId: ch.id, idx, url: urls[idx], dir, label });
        }
        // Chapter appears "done" once its images are in — we track completion by imgDone below.
      }
      renderStats();
      return { allTasks, chapterMap };
    }

    /* ------------------------------------------------ GLOBAL WORKER POOL */
    async function runWorkerPool(allTasks, chapterMap) {
      let nextTask = 0;
      let completed = 0;
      let lastUIUpdate = 0;
      const total = allTasks.length;
      const doneChapters = new Set();

      const chLabel = (ch) => `ch${ch.chaNum != null ? ch.chaNum : ch.serial}`;

      async function worker(workerId) {
        while (true) {
          const index = nextTask++;
          if (index >= total) return;
          const task = allTasks[index];

          let result = null;
          try {
            result = await grabImage(task);
          } catch (err) {
            console.error('Unexpected task error:', task.url, err);
          }

          if (result) {
            const chData = chapterMap.get(result.chId);
            if (chData) {
              chData.files.push(result);
              // If this chapter has all its images, mark it done.
              const chTotal = allTasks.filter(t => t.chId === result.chId).length;
              if (chData.files.length >= chTotal && !doneChapters.has(result.chId)) {
                doneChapters.add(result.chId);
                stats.chDone = doneChapters.size;
              }
            }
          }

          completed++;
          const now = Date.now();
          if (now - lastUIUpdate >= 200 || completed === total) {
            lastUIUpdate = now;
            renderStats();
            prog(`Completed ${completed}/${total} image tasks`);
          }
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(GLOBAL_CONCURRENCY, total) },
          (_, i) => worker(i)
        )
      );

      // Final stats sync.
      stats.imgDone = completed - failedList.length;
      renderStats();
      return chapterMap;
    }

    /* ------------------------------------------------ grouping / zip */
    function groupIntoParts(chaptersData, maxSizeBytes) {
      const parts = [];
      let currentPart = { startLabel: '', endLabel: '', totalSize: 0, chapters: [] };

      for (const chData of chaptersData) {
        const num = chData.ch.chaNum != null ? chData.ch.chaNum : chData.ch.serial;
        const label = `ch${num}`;
        const chSize = chData.files.reduce((sum, f) => sum + f.size, 0);

        if (currentPart.totalSize + chSize > maxSizeBytes && currentPart.chapters.length > 0) {
          parts.push(currentPart);
          currentPart = { startLabel: label, endLabel: label, totalSize: chSize, chapters: [chData] };
        } else {
          if (currentPart.startLabel === '') currentPart.startLabel = label;
          currentPart.endLabel = label;
          currentPart.totalSize += chSize;
          currentPart.chapters.push(chData);
        }
      }
      if (currentPart.chapters.length > 0) parts.push(currentPart);
      return parts;
    }

    function renderDownloadButtons(parts, titleName) {
      const list = $('#xcdl-list');
      list.innerHTML = '';

      const header = document.createElement('div');
      header.style.padding = '10px';
      header.style.color = '#cfe0f5';
      header.innerHTML = `<strong>Ready!</strong> Split into ${parts.length} part(s) (~495 MB each).<br><small style="color:#7c8794">⚠ Click each button to download.</small>`;
      list.appendChild(header);

      parts.forEach((part, index) => {
        const sizeMB = (part.totalSize / 1048576).toFixed(1);
        const btn = document.createElement('button');
        btn.className = 'xcdl-btn part-btn';
        btn.innerHTML = `<span>⬇ ${part.startLabel} - ${part.endLabel}</span><span style="color:#8f9bad">${sizeMB} MB</span>`;

        btn.onclick = async () => {
          btn.disabled = true;
          btn.querySelector('span:first-child').textContent = `⏳ Packing ${part.startLabel}-${part.endLabel}...`;
          try {
            const zip = new JSZip();
            for (const chData of part.chapters) {
              for (const file of chData.files) {
                zip.file(file.name, file.blob);
              }
            }
            prog(`Generating ZIP for ${part.startLabel}-${part.endLabel}...`);
            const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${titleName}_${part.startLabel}-${part.endLabel}.zip`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 60000);

            btn.querySelector('span:first-child').textContent = `✔ ${part.startLabel}-${part.endLabel}`;
            btn.style.background = '#1b3a22';
            btn.style.borderColor = '#2b8a3e';
            prog(`${part.startLabel}-${part.endLabel} downloaded successfully.`);
          } catch (e) {
            btn.querySelector('span:first-child').textContent = `✗ Error: ${e.message}`;
            btn.style.background = '#3a1b1b';
            btn.style.borderColor = '#b23b3b';
          }
        };
        list.appendChild(btn);
      });
    }

    /* ---------------------------------------------------------- retry */
    $('#xcdl-retry').onclick = async () => {
      if (!failedList.length || !globalChaptersData.length) return;
      $('#xcdl-retry').disabled = true;

      // Build retry tasks from the failed list (skip chapter-level failures — those
      // need a full re-fetch of the chapter's pages, which we handle below).
      const chapterFailures = failedList.filter(f => f.chapterFail);
      const imageFailures = failedList.filter(f => !f.chapterFail);

      const retryTasks = imageFailures.map(f => ({
        ch: f.ch, chId: f.ch.id, idx: f.idx, url: f.url, dir: f.dir, label: f.label,
      }));

      // For chapter-level failures, re-fetch page URLs and add them as tasks.
      for (const cf of chapterFailures) {
        try {
          const urls = (await gql(Q_PAGES, { id: cf.ch.id })).get_chapterNode.data.imageUrls;
          const ch = cf.ch;
          const num = ch.chaNum != null ? ch.chaNum : ch.serial;
          const dir = `${currentTitleName}/${ch.volNum ? 'v' + safe(ch.volNum) + '_' : ''}ch${safe(num)}${ch.dname ? '_' + safe(ch.dname) : ''}`;
          if (!globalChaptersData.some(c => c.ch.id === ch.id)) {
            globalChaptersData.push({ ch, files: [] });
          }
          for (let idx = 0; idx < urls.length; idx++) {
            retryTasks.push({ ch, chId: ch.id, idx, url: urls[idx], dir, label: `ch${num}` });
          }
        } catch (e) {
          console.warn('Chapter retry failed:', cf.label, e);
        }
      }

      if (!retryTasks.length) {
        prog('Nothing to retry.');
        $('#xcdl-retry').disabled = false;
        return;
      }

      // Rebuild the chapter map from globalChaptersData for easy lookup.
      const chapterMap = new Map(globalChaptersData.map(c => [c.ch.id, c]));

      // Clear failed entries we're retrying (grabImage will re-add on failure).
      failedList.length = 0;
      for (const f of imageFailures) {
        if (!failedList.some(x => x.url === f.url && x.idx === f.idx && x.ch.id === f.ch.id)) {
          // Don't pre-add — grabImage adds only on failure.
        }
      }
      stats.failed = 0;
      renderStats();

      // Run the pool on just the retry tasks.
      await runWorkerPool(retryTasks, chapterMap);

      prog('Re-calculating ZIP parts...');
      await sleep(100);
      const parts = groupIntoParts(globalChaptersData, MAX_ZIP_BYTES);
      renderDownloadButtons(parts, currentTitleName);
      $('#xcdl-retry').disabled = false;
    };

    /* ---------------------------------------------------------- download */
    $('#xcdl-dl').onclick = async () => {
      const picked = [...root.querySelectorAll('.xcdl-item input')].map((i, k) => [i.checked, chapters[k]])
        .filter(([c]) => c).map(([, ch]) => ch);
      if (!picked.length || !window.JSZip) return;

      $('#xcdl-dl').disabled = true;
      $('#xcdl-retry').style.display = 'none';
      failedList.length = 0;
      stats.chTotal = picked.length; stats.chDone = 0; stats.imgDone = 0; stats.failed = 0;
      stats.imgTotal = 0;

      currentTitleName = safe(await gql(Q_TITLE, { id: titleId }).then((d) => d.get_title_titleNode.data.title).catch(() => titleId));
      const dirBase = currentTitleName;
      const t0 = Date.now();

      prog('Collecting page URLs for all selected chapters…');
      const { allTasks, chapterMap } = await buildAllTasks(picked, dirBase);

      if (!allTasks.length) {
        prog('No image tasks — nothing to download.');
        $('#xcdl-dl').disabled = false;
        return;
      }

      prog(`Starting global worker pool (${GLOBAL_CONCURRENCY} workers) on ${allTasks.length} tasks…`);
      globalChaptersData = [...chapterMap.values()];

      await runWorkerPool(allTasks, chapterMap);

      prog('Calculating ZIP parts (Target: ~495 MB)...');
      await sleep(100);

      const parts = groupIntoParts(globalChaptersData, MAX_ZIP_BYTES);
      const totalTime = ((Date.now() - t0) / 1000).toFixed(0);
      prog(`Processing complete in ${totalTime}s. Select a part below to download.`);

      renderDownloadButtons(parts, currentTitleName);

      if (failedList.length > 0) {
        $('#xcdl-retry').style.display = '';
      }
    };
  } catch (e) {
    prog('Error: ' + (e && e.message ? e.message : e));
  }
})();
