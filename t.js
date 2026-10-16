/* ============================================================================
 * XCOMIC Downloader (remote script for bookmarklet)
 * - Reads title id from https://xcomic.me/title/<id>
 * - Lets you pick an edition (language) and select chapters
 * - Downloads pages, resizes to max width 1280, converts to WebP q=0.75 (Client-side)
 * - Packs everything into one ZIP and triggers download
 * - Live counters, failed-pages list with retry
 * ==========================================================================*/
(async function () {
  'use strict';
  if (window.__XCOMIC_DL__) return;
  const api = (window.__XCOMIC_DL__ = { toggle, close });

  const MAX_WIDTH = 1280;
  const QUALITY = 0.75;
  const PAGE_CONCURRENCY = 3;   // parallel page downloads inside one chapter
  const IMG_RETRIES = 2;        // in-pass retries per image
  const MIN_REQUEST_INTERVAL = 100; // ms between STARTS of image requests (global)

  // Updated Proxies: Direct first, then your custom Cloudflare Worker
  // REPLACE 'https://YOUR-WORKER-NAME.YOUR-SUBDOMAIN.workers.dev' with your actual Worker URL
  const CF_WORKER_URL = 'https://xcom.yuush.workers.dev';
  
  const PROXIES = [
    { name: 'direct', processed: false, make: (u) => u },
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
  .xcdl-btn{background:#2f6fed;border:none;color:#fff;border-radius:7px;padding:6px 12px;
    cursor:pointer;font-size:12px}
  .xcdl-btn.sec{background:#26303d}
  .xcdl-btn:disabled{opacity:.45;cursor:default}
  .xcdl-btn.danger{background:#b23b3b}
  .xcdl-stats{padding:8px 12px 2px;border-top:1px solid #232b36;font-size:12px;color:#cfe0f5;
    white-space:pre-line}
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
        <button class="xcdl-btn sec" id="xcdl-retry" style="display:none">Retry failed</button>
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
      const hosts = [];
      try { hosts.push(new URL(document.currentScript.src).origin); } catch (_) {}
      hosts.push('https://cdn.jsdelivr.net');
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
      const card = a.closest('div');
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
          <span class="n">${ch.volNum ? 'v' + ch.volNum + ' ' : ''}c${num}</span>
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
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

    const stats = { chDone: 0, chTotal: 0, imgDone: 0, imgTotal: 0, failed: 0 };
    const failedList = [];
    let zip = null;

    function renderStats() {
      $('#xcdl-stats').textContent =
        `Chapters ${stats.chDone}/${stats.chTotal} · Images ${stats.imgDone}/${stats.imgTotal} · Failed ${stats.failed}`;
      const box = $('#xcdl-fails');
      box.innerHTML = failedList.slice(-300).map((f) =>
        `<div>✗ ${f.label} p${f.idx + 1} — ${f.url}</div>`).join('');
      $('#xcdl-retry').style.display = failedList.length ? '' : 'none';
      $('#xcdl-retry').textContent = `Retry failed (${failedList.length})`;
    }

    let lastReqStart = 0, rateChain = Promise.resolve();
    function rateLimit() {
      const p = rateChain.then(async () => {
        const wait = Math.max(0, MIN_REQUEST_INTERVAL - (Date.now() - lastReqStart));
        if (wait) await sleep(wait);
        lastReqStart = Date.now();
      });
      rateChain = p.catch(() => {});
      return p;
    }

    async function fetchImage(url) {
      let lastErr;
      for (let attempt = 0; attempt <= IMG_RETRIES; attempt++) {
        for (const via of PROXIES) {
          try {
            await rateLimit();
            const r = await fetch(via.make(url), { credentials: 'omit', mode: 'cors' });
            if (r.status === 429 || r.status === 403) {
              const ra = parseInt(r.headers.get('retry-after') || '0', 10);
              await sleep((ra || 10) * 1000);
              throw new Error('HTTP ' + r.status);
            }
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const b = await r.blob();
            if (!b.type.startsWith('image/')) throw new Error('not an image (' + b.type + ')');
            return { blob: b, processed: via.processed, via: via.name };
          } catch (e) { lastErr = e; }
        }
        if (attempt < IMG_RETRIES) await sleep(400 * (attempt + 1));
      }
      throw lastErr || new Error('fetch failed');
    }

    // Client-side resizing and WebP conversion
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

    async function grab(ch, idx, url, dir, label) {
      try {
        const { blob, processed, via } = await fetchImage(url);
        const b = await toWebp(blob, processed);
        zip.file(`${dir}/${String(idx + 1).padStart(4, '0')}.webp`, b);
        stats.imgDone++;
        const fi = failedList.findIndex((f) => f.url === url && f.idx === idx && f.ch.id === ch.id);
        if (fi >= 0) { failedList.splice(fi, 1); stats.failed = failedList.length; }
        return true;
      } catch (e) {
        if (!failedList.some((f) => f.url === url && f.idx === idx && f.ch.id === ch.id)) {
          failedList.push({ ch, idx, url, dir, label });
        }
        stats.failed = failedList.length;
        return false;
      } finally {
        renderStats();
      }
    }

    async function downloadChapter(ch, dirBase) {
      const num = ch.chaNum != null ? ch.chaNum : ch.serial;
      const label = `c${num}`;
      const dir = `${dirBase}/${ch.volNum ? 'v' + safe(ch.volNum) + '_' : ''}c${safe(num)}${ch.dname ? '_' + safe(ch.dname) : ''}`;
      const urls = (await gql(Q_PAGES, { id: ch.id })).get_chapterNode.data.imageUrls;
      let i = 0;
      while (i < urls.length) {
        const batch = urls.slice(i, i + PAGE_CONCURRENCY);
        await Promise.all(batch.map((u, k) => grab(ch, i + k, u, dir, label)));
        i += batch.length;
        prog(`Chapter ${label}: ${i}/${urls.length} pages`);
      }
    }

    /* ---------------------------------------------------------- buttons */
    $('#xcdl-retry').onclick = async () => {
      if (!failedList.length || !zip) return;
      $('#xcdl-retry').disabled = true;
      const items = [...failedList];
      prog(`Retrying ${items.length} failed pages…`);
      for (let i = 0; i < items.length; i++) {
        const f = items[i];
        await grab(f.ch, f.idx, f.url, f.dir, f.label);
        prog(`Retry ${i + 1}/${items.length}`);
      }
      prog(failedList.length ? 'Some pages still failing — you can retry again.' : 'All failed pages recovered ✔');
      $('#xcdl-retry').disabled = false;
      renderStats();
    };

    $('#xcdl-dl').onclick = async () => {
      const picked = [...root.querySelectorAll('.xcdl-item input')].map((i, k) => [i.checked, chapters[k]])
        .filter(([c]) => c).map(([, ch]) => ch);
      if (!picked.length || !window.JSZip) return;
      $('#xcdl-dl').disabled = true;
      zip = new JSZip();
      failedList.length = 0;
      const titleName = safe(await gql(Q_TITLE, { id: titleId }).then((d) => d.get_title_titleNode.data.title).catch(() => titleId));
      stats.chTotal = picked.length; stats.chDone = 0; stats.imgDone = 0; stats.failed = 0;
      stats.imgTotal = 0;
      prog('Counting pages…');
      for (const ch of picked) {
        try { stats.imgTotal += (await gql(Q_PAGES, { id: ch.id })).get_chapterNode.data.imageUrls.length; }
        catch (_) { stats.imgTotal += 0; }
      }
      renderStats();
      const t0 = Date.now();

      for (const ch of picked) {
        try { await downloadChapter(ch, titleName); }
        catch (e) { prog(`Chapter failed: ${e.message}`); failedList.push({ ch, idx: -1, url: '', dir: '', label: `c${ch.chaNum ?? ch.serial}`, chapterFail: true }); }
        stats.chDone++;
        renderStats();
        await sleep(120);
      }
      prog('Packing ZIP…');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${titleName}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      prog(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${a.download} (${(blob.size / 1048576).toFixed(1)} MB)` +
        (failedList.length ? `\n⚠ ${failedList.length} pages missing — press "Retry failed"` : ''));
      renderStats();
      $('#xcdl-dl').disabled = false;
    };
  } catch (e) {
    prog('Error: ' + (e && e.message ? e.message : e));
  }
})();
