
(async function WTRDownloader() {
"use strict";

// --- Configuration ---
const CHAPTER_DELAY_MS = 12000; // 12 seconds
const STORAGE_KEY_PROGRESS = 'wtr_download_progress';

// --- State ---
let isDownloading = false;
let isPaused = false;
let stopFlag = false;
let downloadedChapters = []; // { order, title, content }
let currentNovelInfo = null;

// --- 1. Chapter Info & Fetching ---
const dom = document;
const leaves = dom.baseURI.split("/");
const novelIndex = leaves.indexOf("novel");
const id = leaves[novelIndex + 1];
const novelLink = document.querySelector('a[href*="/novel/"]');
const novelTitle = novelLink ? novelLink.textContent.trim().replace(/[\/\\?%*:|"<>]/g, '-') : "Unknown Novel";

// Fetch Chapter List
const chaptersResp = await fetch(`https://wtr-lab.com/api/chapters/${id}`, { credentials: "include" });
const chaptersJson = await chaptersResp.json();
const chapters = chaptersJson.chapters;

// --- 2. UI Construction ---
const menu = document.createElement("div");
menu.style.cssText = `
    position: fixed; top: 60px; right: 20px; background: #fff; border-radius: 12px;
    padding: 0; max-height: 80vh; overflow-y: auto; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    display: none; width: 400px; font-family: sans-serif;
`;

menu.innerHTML = `
    <div id="menuHeader" style="position: sticky; top: 0; background: #fff; z-index: 10; padding: 10px; border-bottom: 1px solid #ddd;">
        <h3 style="margin: 0 0 10px 0;">Downloader</h3>
        <div style="display:flex; gap:8px; margin-bottom:10px;">
            <button id="toggleMenuBtn" style="flex:1;">Pause/Start</button>
            <button id="downloadEpubBtn" style="flex:1;">Load EPUB</button>
        </div>
        <div id="statusDisplay" style="font-size:12px; color:#555; margin-bottom:5px;">Ready</div>
        <div id="progressBar" style="height:4px; background:#eee; border-radius:2px; overflow:hidden;">
            <div id="progressFill" style="height:100%; width:0%; background:#4caf50; transition:width 0.3s;"></div>
        </div>
    </div>
    <div id="progressLog" style="padding:10px; max-height:400px; overflow-y:auto; font-size:12px; background:#f9f9f9;">
        <div style="color:#888; font-style:italic;">Progress log will appear here...</div>
    </div>
    <div id="chaptersList" style="padding:10px; display:none;">
        ${chapters.map(ch => `
        <label style="display:block; border-bottom:1px solid #eee; padding:4px 0;">
            <input type="checkbox" checked data-order="${ch.order}" data-title="${ch.title.replace(/"/g, '&quot;')}">
            ${ch.order}: ${ch.title}
        </label>
        `).join("")}
    </div>
`;
document.body.appendChild(menu);

// Toggle Button
const toggleBtn = document.createElement("button");
toggleBtn.textContent = "📚 Download Menu";
toggleBtn.style.cssText = `position: fixed; top: 10px; right: 10px; z-index: 999999; padding: 8px 12px; background: #333; color: #fff; border: none; border-radius: 4px; cursor: pointer;`;
toggleBtn.onclick = () => menu.style.display = menu.style.display === "none" ? "block" : "none";
document.body.appendChild(toggleBtn);

// --- 3. Logic Functions ---

function logProgress(message, type = 'info') {
    const log = document.getElementById('progressLog');
    // Clear initial italic text if exists
    if (log.querySelector('i')) log.innerHTML = '';
    
    const entry = document.createElement('div');
    entry.style.marginBottom = '4px';
    entry.style.borderBottom = '1px solid #eee';
    entry.style.paddingBottom = '2px';
    
    const color = type === 'error' ? '#d32f2f' : (type === 'success' ? '#388e3c' : '#333');
    entry.style.color = color;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
}

function updateProgress(current, total) {
    const pct = Math.round((current / total) * 100);
    document.getElementById('progressFill').style.width = `${pct}%`;
    document.getElementById('statusDisplay').textContent = `Downloading: ${current} / ${total}`;
}

function saveProgress() {
    if (currentNovelInfo) {
        localStorage.setItem(STORAGE_KEY_PROGRESS, JSON.stringify({
            novelId: currentNovelInfo.id,
            novelTitle: currentNovelInfo.title,
            downloaded: downloadedChapters,
            totalChapters: currentNovelInfo.total
        }));
    }
}

function loadProgress() {
    const raw = localStorage.getItem(STORAGE_KEY_PROGRESS);
    return raw ? JSON.parse(raw) : null;
}

function clearProgress() {
    localStorage.removeItem(STORAGE_KEY_PROGRESS);
}

async function ensureJSZip() {
    if (window.JSZip) return window.JSZip;
    return new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
        s.onload = () => res(window.JSZip);
        s.onerror = rej;
        document.head.appendChild(s);
    });
}

async function fetchChapterContent(order) {
    // Determine language from URL
    const language = leaves[novelIndex - 1] || 'en';
    
    const formData = { translate: "ai", language, raw_id: id, chapter_no: order };
    const res = await fetch("https://wtr-lab.com/api/reader/get", {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify(formData),
        credentials: "include"
    });
    
    let json;
    try { json = await res.json(); } 
    catch (e) { throw new Error("Invalid JSON response"); }
    
    if (!json?.data?.data?.body) throw new Error("Missing chapter body");
    
    const tempDiv = document.createElement("div");
    let imgCounter = 0;
    
    json.data.data.body.forEach(el => {
        if (el === "[image]") {
            const src = json.data.data?.images?.[imgCounter++] ?? "";
            if (src) {
                const img = document.createElement("img");
                img.src = src;
                tempDiv.appendChild(img);
            }
        } else {
            const pnode = document.createElement("p");
            const wrapper = document.createElement("div");
            wrapper.innerHTML = el;
            pnode.textContent = wrapper.textContent;
            // Glossary replacement (basic)
            for (let i = 0; i < (json?.data?.data?.glossary_data?.terms?.length ?? 0); i++) {
                const term = json.data.data.glossary_data.terms[i][0];
                if (term) {
                    pnode.textContent = pnode.textContent.replaceAll(`※${i}⛬`, term);
                    pnode.textContent = pnode.textContent.replaceAll(`※${i}〓`, term);
                }
            }
            tempDiv.appendChild(pnode);
        }
    });
    
    const rawText = Array.from(tempDiv.querySelectorAll("p"))
        .map(p => p.textContent)
        .join("\n")
        .trim();
        
    return `<h1>${order}: ${json.chapter?.title ?? "Untitled"}</h1><p>${rawText.replace(/\n/g,"<br>")}</p>`;
}

async function generateEPUB() {
    if (downloadedChapters.length === 0) {
        alert("No chapters downloaded yet.");
        return;
    }
    
    logProgress("Generating EPUB...", "info");
    await ensureJSZip();
    
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    const metaInf = zip.folder("META-INF");
    const oebps = zip.folder("OEBPS");
    
    metaInf.file("container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
    
    const chapterOrders = downloadedChapters.map(c => c.order);
    const manifestItems = chapterOrders.map(num => `<item id="ch${num}" href="ch${num}.xhtml" media-type="application/xhtml+xml"/>`).join("\n");
    const spineItems = chapterOrders.map(num => `<itemref idref="ch${num}"/>`).join("\n");
    
    const safeTitle = (currentNovelInfo?.title || novelTitle).replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'})[c]);
    
    oebps.file("content.opf", `<?xml version="1.0" encoding="utf-8"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${safeTitle}</dc:title><dc:language>en</dc:language><dc:creator>WTR-LAB</dc:creator><dc:identifier id="BookId">urn:uuid:${crypto.randomUUID()}</dc:identifier></metadata><manifest>${manifestItems}</manifest><spine>${spineItems}</spine></package>`);
    
    downloadedChapters.forEach((ch, idx) => {
        const title = `Chapter ${ch.order}`;
        const safeHtml = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${ch.content}</body></html>`;
        oebps.file(`ch${ch.order}.xhtml`, safeHtml);
    });
    
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const fileName = `${(currentNovelInfo?.title || novelTitle).replace(/[\/\\?%*:|"<>]/g,"-").slice(0,200)}.epub`;
    a.download = fileName;
    document.body.appendChild(a); 
    a.click(); 
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    
    logProgress("EPUB Downloaded Successfully!", "success");
    isDownloading = false;
    updateBtnState();
}

// --- 4. Download Loop ---

async function startDownload() {
    if (isDownloading && !isPaused) return; // Already running
    
    // Check for saved progress
    const saved = loadProgress();
    const selectedCheckboxes = menu.querySelectorAll("#chaptersList input[type=checkbox]:checked");
    const selectedOrders = Array.from(selectedCheckboxes).map(cb => parseInt(cb.dataset.order));
    
    if (saved && saved.novelId === id) {
        // Resume
        downloadedChapters = saved.downloaded || [];
        currentNovelInfo = { id: saved.novelId, title: saved.novelTitle, total: saved.totalChapters };
        logProgress(`Resuming from ${downloadedChapters.length} chapters...`, "info");
        // Filter out already downloaded from selected list if resuming all
        // For simplicity, we continue from where we left off based on saved data
    } else {
        // New Download
        downloadedChapters = [];
        currentNovelInfo = { id: id, title: novelTitle, total: selectedOrders.length };
        logProgress(`Starting new download: ${selectedOrders.length} chapters selected.`, "info");
    }
    
    isDownloading = true;
    isPaused = false;
    stopFlag = false;
    updateBtnState();
    
    // Determine which chapters to fetch
    // If resuming, we usually want to continue the sequence. 
    // For this simplified version, we will fetch the selected checkboxes that are NOT in downloadedChapters.
    const existingOrders = new Set(downloadedChapters.map(c => c.order));
    const chaptersToFetch = selectedOrders.filter(o => !existingOrders.has(o));
    
    // If resuming and no specific checkboxes checked differently, we might need to fetch the rest of the novel.
    // To keep it simple: We fetch what is checked and not yet downloaded.
    
    if (chaptersToFetch.length === 0 && downloadedChapters.length > 0) {
        logProgress("All selected chapters already downloaded.", "success");
        generateEPUB();
        return;
    }
    
    const totalToFetch = chaptersToFetch.length + downloadedChapters.length;
    
    for (const order of chaptersToFetch) {
        if (stopFlag) break;
        
        // Pause Check
        while (isPaused) {
            await new Promise(r => setTimeout(r, 1000));
            if (stopFlag) break;
        }
        if (stopFlag) break;
        
        try {
            logProgress(`Fetching Chapter ${order}...`, "info");
            const content = await fetchChapterContent(order);
            const title = selectedCheckboxes.find(cb => parseInt(cb.dataset.order) === order)?.dataset.title || `Chapter ${order}`;
            
            downloadedChapters.push({ order, title, content });
            saveProgress();
            
            updateProgress(downloadedChapters.length, totalToFetch);
            logProgress(`✓ Completed: ${title}`, "success");
            
            // 12 Second Delay
            if (order !== chaptersToFetch[chaptersToFetch.length - 1]) {
                logProgress(`Waiting ${CHAPTER_DELAY_MS/1000}s before next chapter...`, "info");
                await new Promise(r => setTimeout(r, CHAPTER_DELAY_MS));
            }
        } catch (err) {
            logProgress(`Error fetching Chapter ${order}: ${err.message}`, "error");
            // Save progress even on error so we don't lose previous work
            saveProgress();
            // Pause on error to let user decide
            isPaused = true;
            updateBtnState();
            logProgress("Download paused due to error. Click Start to resume.", "info");
            break;
        }
    }
    
    if (!stopFlag && !isPaused) {
        logProgress("All selected chapters fetched.", "success");
        generateEPUB();
        clearProgress(); // Clear temp storage after successful EPUB gen
    }
}

function stopDownload() {
    stopFlag = true;
    isDownloading = false;
    isPaused = false;
    logProgress("Download stopped manually.", "info");
    updateBtnState();
}

function togglePause() {
    if (!isDownloading && downloadedChapters.length === 0) {
        startDownload();
        return;
    }
    
    if (isDownloading) {
        isPaused = !isPaused;
        logProgress(isPaused ? "Download Paused." : "Download Resumed.", "info");
        updateBtnState();
    } else if (downloadedChapters.length > 0) {
        // Resume from pause/stop
        isPaused = false;
        stopFlag = false;
        startDownload();
    }
}

function updateBtnState() {
    const btn = document.getElementById('toggleMenuBtn');
    if (!isDownloading) {
        btn.textContent = downloadedChapters.length > 0 ? "Resume Download" : "Start Download";
        btn.style.background = "#4caf50";
        btn.style.color = "#fff";
    } else if (isPaused) {
        btn.textContent = "Resume";
        btn.style.background = "#ff9800";
        btn.style.color = "#fff";
    } else {
        btn.textContent = "Pause";
        btn.style.background = "#f44336";
        btn.style.color = "#fff";
    }
}

// --- 5. Event Listeners ---

document.getElementById('toggleMenuBtn').onclick = togglePause;
document.getElementById('downloadEpubBtn').onclick = () => {
    if (isDownloading) {
        if(confirm("Download is in progress. Generate EPUB with current chapters?")) {
            generateEPUB();
        }
    } else {
        generateEPUB();
    }
};

// Initialize UI
updateBtnState();

})();
