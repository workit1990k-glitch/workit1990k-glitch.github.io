// ==UserScript==
// @name        WTR Lab JSON & EPUB Downloader (Fixed Storage)
// @namespace   Violentmonkey Scripts
// @match       https://wtr-lab.com/en/*
// @grant       none
// @version     4.1
// @author      -
// @description Fixed Storage Full error. Blocks Base64 covers. Adds Nuke Storage button.
// ==/UserScript==

(async function WTRMetaDownloader() {
"use strict";

// --- Configuration ---
const STORAGE_KEY = 'wtr_meta_download_data';
const DELAY_MS = 12000; // 12 seconds

// --- State ---
let isDownloading = false;
let stopRequested = false;
let downloadState = {
    novelId: '',
    title: '',
    author: '',
    genres: [],
    description: '',
    coverUrl: '',
    chapters: [], // { order, title, content }
    totalChapters: 0,
    lastUpdated: Date.now()
};

// --- Helper: Load/Save State ---
function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.novelId === downloadState.novelId) {
                downloadState = parsed;
            }
        }
    } catch (e) { 
        console.error("Failed to load state", e); 
    }
}

function saveState() {
    try {
        downloadState.lastUpdated = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(downloadState));
        updateProgressUI();
    } catch (e) {
        // IMPROVED ERROR HANDLING
        let msg = "Storage Error: " + e.name;
        if (e.name === 'QuotaExceededError') {
            msg = "Storage FULL! Click 'Nuke Storage' to clear space.";
        }
        console.error(msg, e);
        alert(msg);
        stopDownload();
    }
}

function clearState() {
    localStorage.removeItem(STORAGE_KEY);
    const meta = { ...downloadState };
    downloadState = {
        novelId: meta.novelId,
        title: meta.title,
        author: meta.author,
        genres: meta.genres,
        description: meta.description,
        coverUrl: meta.coverUrl,
        chapters: [],
        totalChapters: meta.totalChapters,
        lastUpdated: Date.now()
    };
    updateProgressUI();
}

// --- 1. Scraping Metadata & Chapter Info ---
const dom = document;
const leaves = dom.baseURI.split("/");
const novelIndex = leaves.indexOf("novel");
const id = leaves[novelIndex + 1];
const novelLink = document.querySelector('a[href*="/novel/"]');
const novelTitle = novelLink ? novelLink.textContent.trim().replace(/[\/\\?%*:|"<>]/g, '-') : "Unknown Novel";

// Initialize State ID
downloadState.novelId = id;
downloadState.title = novelTitle;
loadState();

// Scrape Metadata from Page
function scrapeMetadata() {
    // Author
    const authorEl = document.querySelector('.author, .mb-2 a[href*="/author/"]');
    downloadState.author = authorEl ? authorEl.textContent.trim() : "Unknown";

    // Genres
    const genreEls = document.querySelectorAll('.genres a, .mb-2 a[href*="/genre/"]');
    downloadState.genres = Array.from(genreEls).map(el => el.textContent.trim());

    // Description
    const descEl = document.querySelector('.description, .summary, .mb-3');
    downloadState.description = descEl ? descEl.textContent.trim() : "";

    // Cover (FIXED: Ignore Base64 Data URIs to save space)
    const coverEl = document.querySelector('.image-wrap img, .cover img, picture source[srcset]');
    if (coverEl) {
        let url = coverEl.src || coverEl.srcset;
        // Only save if it starts with http (ignore data:image/base64)
        if (url && url.startsWith('http')) {
            downloadState.coverUrl = url.split(' ')[0]; // Take first URL if srcset has multiple
        } else {
            downloadState.coverUrl = '';
        }
    }
    // Only save if we actually have new metadata (avoid triggering quota on load)
    if (downloadState.author !== "Unknown" || downloadState.genres.length > 0) {
        saveState();
    }
}

// Fetch Chapter List
const chaptersResp = await fetch(`https://wtr-lab.com/api/chapters/${id}`, { credentials: "include" });
const chaptersJson = await chaptersResp.json();
const chapters = chaptersJson.chapters;
downloadState.totalChapters = chapters.length;
scrapeMetadata();

// --- 2. Menu UI ---
const menu = document.createElement("div");
menu.style.cssText = `
position: fixed; top: 60px; right: 20px; background: #fff; border-radius: 12px;
padding: 0; max-height: 80vh; overflow-y: auto; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
display: none; width: 350px; font-family: sans-serif;
`;

menu.innerHTML = `
<div id="menuHeader" style="
position: sticky; top: 0; background: #fff; z-index: 10;
padding: 10px; border-bottom: 1px solid #ddd;
">
<h3 style="margin: 0 0 6px 0;">Downloader</h3>
<div style="font-size:12px; color:#666; margin-bottom:8px;" id="progressText">Ready</div>
<div style="display:flex; gap:8px; flex-wrap:wrap;">
    <button id="toggleDownloadBtn" style="flex:1; background:#28a745; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Start</button>
    <button id="saveJsonBtn" style="flex:1; background:#007bff; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Save JSON</button>
    <button id="saveEpubBtn" style="flex:1; background:#6f42c1; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Save EPUB</button>
</div>
<div style="display:flex; gap:8px; margin-top:8px;">
    <button id="clearBtn" style="flex:1; background:#dc3545; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Clear Chapters</button>
    <button id="nukeBtn" style="flex:1; background:#333; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">🗑️ Nuke Storage</button>
</div>
<div style="margin-top:8px; font-size:11px; color:#555;">
    <strong>Meta:</strong> <span id="metaStatus">Loaded</span>
</div>
</div>
<div id="chaptersList" style="padding:10px;">
${chapters.map(ch => `
<div style="padding:4px 0; border-bottom:1px solid #eee; font-size:13px;">
    ${ch.order}: ${ch.title}
</div>
`).join("")}
</div>
`;

document.body.appendChild(menu);

// Toggle Menu Button
const toggleBtn = document.createElement("button");
toggleBtn.textContent = "📥 Download";
toggleBtn.style.cssText = `position: fixed; top: 10px; right: 10px; z-index: 999999; padding: 8px 12px; background: #333; color: #fff; border: none; border-radius: 4px; cursor: pointer;`;
toggleBtn.onclick = () => menu.style.display = menu.style.display === "none" ? "block" : "none";
document.body.appendChild(toggleBtn);

// --- 3. Fetch Chapter Content ---
async function fetchChapterContent(order) {
    const formData = { translate: "ai", language: leaves[novelIndex - 1], raw_id: id, chapter_no: order };
    const res = await fetch("https://wtr-lab.com/api/reader/get", {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify(formData),
        credentials: "include"
    });
    let json;
    try { json = await res.json(); } catch { throw new Error("Invalid JSON"); }
    if (!json?.data?.data?.body) { throw new Error("Missing body"); }

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
            if (json?.data?.data?.glossary_data?.terms) {
                for (let i = 0; i < json.data.data.glossary_data.terms.length; i++) {
                    const term = json.data.data.glossary_data.terms[i][0];
                    if (term) {
                        pnode.textContent = pnode.textContent.replaceAll(`※${i}⛬`, term);
                        pnode.textContent = pnode.textContent.replaceAll(`※${i}〓`, term);
                    }
                }
            }
            tempDiv.appendChild(pnode);
        }
    });
    const text = Array.from(tempDiv.querySelectorAll("p")).map(p => p.textContent).join("\n").trim();
    return {
        order: order,
        title: json.chapter?.title ?? `Chapter ${order}`,
        content: text
    };
}

// --- 4. Download Logic ---
const toggleBtnEl = document.getElementById("toggleDownloadBtn");
const progressText = document.getElementById("progressText");
const metaStatus = document.getElementById("metaStatus");

function updateProgressUI() {
    const count = downloadState.chapters.length;
    const total = downloadState.totalChapters;
    progressText.textContent = `${count} / ${total} Chapters`;
    toggleBtnEl.textContent = isDownloading ? "Pause" : "Start";
    toggleBtnEl.style.background = isDownloading ? "#dc3545" : "#28a745";
    metaStatus.textContent = downloadState.author ? "Loaded" : "Missing";
}

function stopDownload() {
    isDownloading = false;
    stopRequested = true;
    updateProgressUI();
}

toggleBtnEl.onclick = () => {
    if (isDownloading) {
        stopDownload();
    } else {
        isDownloading = true;
        stopRequested = false;
        updateProgressUI();
        runDownloadLoop();
    }
};

document.getElementById("clearBtn").onclick = () => {
    if(confirm("Clear all saved chapters? (Metadata kept)")) {
        clearState();
        stopDownload();
    }
};

// --- Nuke Storage Button (FIX) ---
document.getElementById("nukeBtn").onclick = () => {
    if(confirm("WARNING: This will delete ALL saved data for this script on this site. Continue?")) {
        localStorage.clear(); // Clears everything for this domain
        location.reload();
    }
};

// --- JSON Export ---
document.getElementById("saveJsonBtn").onclick = () => {
    if (downloadState.chapters.length === 0) {
        alert("No chapters downloaded yet.");
        return;
    }
    const blob = new Blob([JSON.stringify(downloadState, null, 2)], { type: 'application/json' });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${downloadState.title}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
};

// --- EPUB Creation (With Metadata) ---
document.getElementById("saveEpubBtn").onclick = async () => {
    if (downloadState.chapters.length === 0) {
        alert("No chapters downloaded yet.");
        return;
    }
    await ensureJSZip();
    const zip = new JSZip();
    const { title, author, genres, description, coverUrl, chapters: savedChapters } = downloadState;

    // EPUB Structure
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    const metaInf = zip.folder("META-INF");
    const oebps = zip.folder("OEBPS");
    const imagesFolder = oebps.folder("images");

    metaInf.file("container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);

    // Cover Image Handling
    let coverHref = null;
    let coverId = "cover-image";
    if (coverUrl) {
        try {
            const resp = await fetch(coverUrl, { credentials: "include" });
            if (resp.ok) {
                const buf = await resp.arrayBuffer();
                const ct = resp.headers.get("content-type") || "";
                let ext = "jpg";
                if (ct.includes("png")) ext = "png";
                else if (ct.includes("webp")) ext = "webp";
                coverHref = `images/cover.${ext}`;
                imagesFolder.file(`cover.${ext}`, new Uint8Array(buf));
            }
        } catch (e) { console.warn("Cover fetch failed", e); }
    }

    // Manifest & Spine
    const chapterOrders = savedChapters.map(c => c.order);
    const manifestItems = chapterOrders.map(num => `<item id="ch${num}" href="ch${num}.xhtml" media-type="application/xhtml+xml"/>`).join("\n");
    const spineItems = chapterOrders.map(num => `<itemref idref="ch${num}"/>`).join("\n");
    
    // Metadata in OPF
    const genreTags = genres.map(g => `<dc:subject>${escapeXml(g)}</dc:subject>`).join("\n");
    const metaCoverTag = coverHref ? `<meta name="cover" content="${coverId}"/>` : "";
    const descTag = description ? `<dc:description>${escapeXml(description)}</dc:description>` : "";

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>${escapeXml(author)}</dc:creator>
<dc:language>en</dc:language>
<dc:identifier id="BookId">urn:uuid:${crypto.randomUUID()}</dc:identifier>
${genreTags}
${descTag}
${metaCoverTag}
</metadata>
<manifest>
${manifestItems}
${coverHref ? `<item id="${coverId}" href="${coverHref}" media-type="image/${coverHref.split('.').pop()}"/>` : ''}
</manifest>
<spine>
${spineItems}
</spine>
</package>`;

    oebps.file("content.opf", opf);

    // Chapters
    savedChapters.forEach((ch, idx) => {
        const safeHtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(ch.title)}</title></head>
<body><h1>${escapeXml(ch.title)}</h1>${ch.content.replace(/\n/g, "<br/>")}</body>
</html>`;
        oebps.file(`ch${ch.order}.xhtml`, safeHtml);
    });

    // Generate
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${sanitizeFilename(title)}.epub`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
};

// --- Loop ---
async function runDownloadLoop() {
    const existingOrders = new Set(downloadState.chapters.map(c => c.order));
    const remaining = chapters.filter(ch => !existingOrders.has(ch.order));

    if (remaining.length === 0) {
        alert("All chapters already downloaded!");
        isDownloading = false;
        updateProgressUI();
        return;
    }

    for (const ch of remaining) {
        if (stopRequested || !isDownloading) break;

        progressText.textContent = `Fetching ${ch.order}...`;
        try {
            const data = await fetchChapterContent(ch.order);
            downloadState.chapters.push(data);
            saveState();
        } catch (err) {
            console.error(`Failed chapter ${ch.order}`, err);
            progressText.textContent = `Error at ${ch.order}. Paused.`;
            stopDownload();
            alert(`Failed to download chapter ${ch.order}. Check console.`);
            break;
        }
        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    if (isDownloading && !stopRequested) {
        alert("Download Complete!");
        isDownloading = false;
        updateProgressUI();
    }
}

// --- Utils ---
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
function escapeXml(str) { return (str+"").replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'})[c]); }
function sanitizeFilename(name) { return (name||"book").replace(/[\/\\?%*:|"<>]/g,"-").slice(0,200); }

updateProgressUI();
})();
