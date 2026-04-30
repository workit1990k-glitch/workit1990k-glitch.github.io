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
    }
  };

  // === STATE ===
  let results = [];
  let modal = null;

  // === UTILITIES ===
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  function createModal() {
    if (modal) return modal;
    
    modal = document.createElement('div');
    modal.id = 'novel18-exporter-modal';
    modal.style.cssText = `
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      background: rgba(0,0,0,0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    modal.innerHTML = `
      <div style="
        background: #1a1a2e;
        color: #e0e0ff;
        border-radius: 12px;
        padding: 20px;
        max-width: 95vw;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        border: 2px solid #00ff9d;
        box-shadow: 0 10px 40px rgba(0,255,157,0.2);
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px;padding-bottom:12px;border-bottom:1px solid #00ff9d33">
          <h3 style="margin:0;color:#00ff9d">📚 Novel Exporter</h3>
          <button id="n18-close" style="background:none;border:none;color:#ff6b6b;font-size:24px;cursor:pointer;line-height:1">&times;</button>
        </div>
        
        <div id="n18-status" style="margin-bottom:15px;font-size:14px;color:#aaa">
          Initializing...
        </div>
        
        <div style="display:flex;gap:10px;margin-bottom:15px;flex-wrap:wrap">
          <button id="n18-copy" style="
            background:#00ff9d;color:#000;border:none;padding:10px 20px;
            border-radius:6px;cursor:pointer;font-weight:600;transition:0.2s
          ">📋 Copy JSON</button>
          <button id="n18-download" style="
            background:#4d7cff;color:#fff;border:none;padding:10px 20px;
            border-radius:6px;cursor:pointer;font-weight:600;transition:0.2s
          ">💾 Download .json</button>
          <button id="n18-toggle" style="
            background:#6c5ce7;color:#fff;border:none;padding:10px 20px;
            border-radius:6px;cursor:pointer;font-weight:600;transition:0.2s
          ">👁 Toggle View</button>
        </div>
        
        <div id="n18-output" style="
          flex:1;
          overflow:auto;
          background:#0f0f1a;
          border-radius:8px;
          padding:15px;
          font-family:Consolas,Monaco,'Courier New',monospace;
          font-size:11px;
          line-height:1.5;
          white-space:pre-wrap;
          word-break:break-all;
          color:#00ff9d;
          min-height:200px;
        "></div>
      </div>
    `;

    document.body.appendChild(modal);

    // Event listeners
    $('#n18-close').onclick = () => modal.remove();
    $('#n18-copy').onclick = copyJSON;
    $('#n18-download').onclick = downloadJSON;
    $('#n18-toggle').onclick = toggleView;

    // Close on background click
    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };

    // Keyboard shortcuts
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', onKey);
      }
    });

    return modal;
  }

  function updateStatus(msg) {
    const el = $('#n18-status');
    if (el) el.textContent = msg;
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
      // Show preview
      try {
        const data = JSON.parse(el.textContent);
        const preview = data
          .filter(item => item.content)
          .map(item => `
            <div style="margin-bottom:25px;padding:15px;background:#16213e;border-radius:8px">
              <h4 style="color:#00ff9d;margin:0 0 10px 0">📄 Page ${item.page}: ${item.title || 'Untitled'}</h4>
              <div style="color:#ccc;line-height:1.6">${item.content}</div>
            </div>
          `).join('<hr style="border-color:#00ff9d33">');
        setOutput(preview || '<em style="color:#666">No content to preview</em>', false);
      } catch {
        alert('⚠️ Cannot preview: Invalid JSON');
      }
    } else {
      // Back to JSON
      setOutput(JSON.stringify(results, null, 2));
    }
  }

  async function copyJSON() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(results, null, 2));
      const btn = $('#n18-copy');
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      btn.style.background = '#00cc7a';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.background = '#00ff9d';
      }, 1500);
    } catch {
      alert('❌ Failed to copy. Select text manually.');
    }
  }

  function downloadJSON() {
    const blob = new Blob([JSON.stringify(results, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `novel18_export_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function extractChapter(url, html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return {
      page: parseInt(url.match(/\/(\d+)\/?$/)?.[1] || 0),
      title: doc.querySelector(CONFIG.selectors.title)?.textContent?.trim() || null,
      content: doc.querySelector(CONFIG.selectors.content)?.innerHTML?.trim() || null,
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
      console.warn(`Failed to fetch ${url}:`, err);
      return { success: false, error: err.message, url };
    }
  }

  async function run() {
    // Validate page
    const match = location.href.match(/(https:\/\/novel18\.syosetu\.com\/[a-z0-9]+\/)/i);
    if (!match) {
      alert('⚠️ Please run this on a novel18.syosetu.com chapter page\nExample: https://novel18.syosetu.com/n6952fb/71/');
      return;
    }
    
    CONFIG.baseURL = match[1];
    
    // Get page count
    const input = prompt('📖 How many pages to fetch? (1-500)', '120');
    const pageCount = parseInt(input);
    
    if (!pageCount || pageCount < 1 || pageCount > CONFIG.maxPages) {
      alert(`⚠️ Please enter a number between 1 and ${CONFIG.maxPages}`);
      return;
    }

    // Show modal
    createModal();
    updateStatus(`🚀 Starting fetch: 1/${pageCount}`);
    setOutput('// Fetching chapters...');

    results = [];

    // Fetch chapters
    for (let i = 1; i <= pageCount; i++) {
      const url = `${CONFIG.baseURL}${i}/`;
      updateStatus(`📥 Fetching page ${i}/${pageCount}...`);
      
      const result = await fetchPage(url);
      if (result.success) {
        results.push(result.data);
      } else {
        results.push({
          page: i,
          url: url,
          error: result.error
        });
      }
      
      // Rate limiting
      if (i < pageCount) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.delayMs));
      }
    }

    // Display results
    updateStatus(`✨ Complete! ✅ ${results.filter(r => !r.error).length}/${pageCount} succeeded`);
    setOutput(JSON.stringify(results, null, 2));
    
    // Auto-focus output for easy selection
    setTimeout(() => {
      $('#n18-output')?.scrollTo({top: 0, behavior: 'smooth'});
    }, 100);
  }

  // === INIT ===
  if (location.hostname.includes('novel18.syosetu.com')) {
    run();
  } else {
    alert('⚠️ This script only works on novel18.syosetu.com');
  }
})();
