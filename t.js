/* ============================================================================
 * XCOMIC Downloader (remote script for bookmarklet)
 * - Reads title id from https://xcomic.me/title/<id>
 * - Lets you pick an edition (language) and select chapters
 * - Downloads pages, resizes to max width 1280, converts to WebP q=0.75
 * - Packs everything into one ZIP and triggers download
 * ==========================================================================*/
(async function () {
  'use strict';
  if (window.__XCOMIC_DL__) return;
  const api = (window.__XCOMIC_DL__ = { toggle, close });

  const MAX_WIDTH = 1280;
  const QUALITY = 0.75;
  const PAGE_CONCURRENCY = 3;   // parallel page downloads inside one chapter
  const PROXIES = [
    (u) => u,
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  ];

  /* ---------------------------------------------------------- UI scaffold */
  const style = document.createElement('style');
  style.textContent = `
  #xcdl-root{position:fixed;top:60px;right:16px;width:420px;max-height:80vh;z-index:2147483647;
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
  .xcdl-prog{padding:8px 12px;border-top:1px solid #232b36;font-size:12px;color:#9fb3d1;
    min-height:18px;white-space:pre-line}
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
        <button class="xcdl-btn danger" id="xcdl-dl" disabled>Download ZIP</button>
      </div>
      <div class="xcdl-list" id="xcdl-list"><div class="xcdl-empty">Loading editions…</div></div>
    </div>
    <div class="xcdl-prog" id="xcdl-prog"></div>`;
  document.body.appendChild(root);
  root.querySelector('.xcdl-x').onclick = close;
  function close() { root.remove(); style.remove(); window.__XCOMIC_DL__ = null; }
  function toggle() { if (root.isConnected) close(); }
  const $ = (sel) => root.querySelector(sel);
  const prog = (t) => { $('#xcdl-prog').textContent = t; };

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
    /* Editions are not in GraphQL — scrape the title page like the parser does */
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

    /* ---------------------------------------------------------- download */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

    async function fetchImage(url) {
      let lastErr;
      for (const via of PROXIES) {
        try {
          const r = await fetch(via(url), { credentials: 'omit', mode: 'cors' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const b = await r.blob();
          if (!b.type.startsWith('image/')) throw new Error('not an image');
          return b;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('fetch failed');
    }

    async function toWebp(blob) {
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

    $('#xcdl-dl').onclick = async () => {
      const picked = [...root.querySelectorAll('.xcdl-item input')].map((i, k) => [i.checked, chapters[k]])
        .filter(([c]) => c).map(([, ch]) => ch);
      if (!picked.length) return;
      $('#xcdl-dl').disabled = true;
      const zip = new JSZip();
      const titleName = safe(await gql(Q_TITLE, { id: titleId }).then((d) => d.get_title_titleNode.data.title).catch(() => titleId));
      let done = 0, failed = 0;
      const t0 = Date.now();

      for (const ch of picked) {
        const num = ch.chaNum != null ? ch.chaNum : ch.serial;
        const dir = `${titleName}/${ch.volNum ? 'v' + safe(ch.volNum) + '_' : ''}c${safe(num)}${ch.dname ? '_' + safe(ch.dname) : ''}`;
        try {
          const urls = (await gql(Q_PAGES, { id: ch.id })).get_chapterNode.data.imageUrls;
          let i = 0;
          while (i < urls.length) {
            const batch = urls.slice(i, i + PAGE_CONCURRENCY);
            const results = await Promise.all(batch.map(async (u) => {
              try { return await toWebp(await fetchImage(u)); }
              catch (e) { failed++; return null; }
            }));
            results.forEach((b, k) => { if (b) zip.file(`${dir}/${String(i + k + 1).padStart(4, '0')}.webp`, b); });
            i += batch.length;
            prog(`Chapter c${num}: ${i}/${urls.length} pages\nTotal: ${done}/${picked.length} chapters, ${failed} failed pages`);
          }
        } catch (e) {
          failed++;
          prog(`Chapter c${num} failed: ${e.message}`);
        }
        done++;
        await sleep(120); // be gentle
      }
      prog('Packing ZIP…');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${titleName}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      prog(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${a.download} (${(blob.size / 1048576).toFixed(1)} MB)`);
      $('#xcdl-dl').disabled = false;
    };
  } catch (e) {
    prog('Error: ' + (e && e.message ? e.message : e));
    window.__XCOMIC_DL__ = null;
  }
})();
