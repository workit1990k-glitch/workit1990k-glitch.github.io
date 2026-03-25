// ==UserScript==
// @name        WTR Lab JSON Downloader
// @namespace   Violentmonkey Scripts
// @match       https://wtr-lab.com/en/*
// @grant       none
// @version     3.0
// @author      -
// @description Downloads chapters to JSON with 12s delay. No EPUB, No Replacer.
// ==/UserScript==

(async function WTRJsonDownloader() {
"use strict";

// --- Configuration ---
const STORAGE_KEY = 'wtr_json_data';
const DELAY_MS = 12000; // 12 seconds

// --- State ---
let isDownloading = false;
let stopRequested = false;
let downloadState = {
    novelTitle: '',
    novelId: '',
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
            // Merge if same novel, otherwise reset
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
        alert("Storage Full! Please click 'Download JSON' to save and clear space.");
        stopDownload();
    }
}

function clearState() {
    localStorage.removeItem(STORAGE_KEY);
    downloadState = {
        novelTitle: '',
        novelId: '',
        chapters: [],
        totalChapters: 0,
        lastUpdated: Date.now()
    };
    updateProgressUI();
}

// --- 1. Chapter Info ---
const dom = document;
const leaves = dom.baseURI.split("/");
const novelIndex = leaves.indexOf("novel");
const id = leaves[novelIndex + 1];
const novelLink = document.querySelector('a[href*="/novel/"]');
const novelTitle = novelLink ? novelLink.textContent.trim().replace(/[\/\\?%*:|"<>]/g, '-') : "Unknown Novel";

// Initialize State ID
downloadState.novelId = id;
downloadState.novelTitle = novelTitle;
loadState();

// Fetch Chapter List
const chaptersResp = await fetch(`https://wtr-lab.com/api/chapters/${id}`, { credentials: "include" });
const chaptersJson = await chaptersResp.json();
const chapters = chaptersJson.chapters;
downloadState.totalChapters = chapters.length;

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
<h3 style="margin: 0 0 6px 0;">JSON Downloader</h3>
<div style="font-size:12px; color:#666; margin-bottom:8px;" id="progressText">Ready</div>
<div style="display:flex; gap:8px; flex-wrap:wrap;">
    <button id="toggleDownloadBtn" style="flex:1; background:#28a745; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Start</button>
    <button id="downloadJsonBtn" style="flex:1; background:#007bff; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Save JSON</button>
    <button id="clearBtn" style="background:#dc3545; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Clear</button>
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
toggleBtn.textContent = "📥 JSON Download";
toggleBtn.style.cssText = `position: fixed; top: 10px; right: 10px; z-index: 999999; padding: 8px 12px; background: #333; color: #fff; border: none; border-radius: 4px; cursor: pointer;`;
toggleBtn.onclick = () => menu.style.display = menu.style.display === "none" ? "block" : "none";
document.body.appendChild(toggleBtn);

// --- 3. Fetch Chapter Content (Simplified) ---
async function fetchChapterContent(order) {
    const formData = { translate: "ai", language: leaves[novelIndex - 1], raw_id: id, chapter_no: order };
    const res = await fetch("https://wtr-lab.com/api/reader/get", {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify(formData),
        credentials: "include"
    });
    let json;
    try {
        json = await res.json();
    } catch {
        throw new Error("Invalid JSON");
    }
    if (!json?.data?.data?.body) {
        throw new Error("Missing body");
    }
    // Reconstruct text simply
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
            // Basic glossary replacement (optional, kept minimal)
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

function updateProgressUI() {
    const count = downloadState.chapters.length;
    const total = downloadState.totalChapters;
    progressText.textContent = `${count} / ${total} Chapters Saved`;
    toggleBtnEl.textContent = isDownloading ? "Pause" : "Start";
    toggleBtnEl.style.background = isDownloading ? "#dc3545" : "#28a745";
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
    if(confirm("Clear all saved progress?")) {
        clearState();
        stopDownload();
    }
};

document.getElementById("downloadJsonBtn").onclick = () => {
    if (downloadState.chapters.length === 0) {
        alert("No chapters downloaded yet.");
        return;
    }
    const blob = new Blob([JSON.stringify(downloadState, null, 2)], { type: 'application/json' });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${downloadState.novelTitle}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Optional: Clear storage after download to save space
    if(confirm("Download complete. Clear local storage to save space?")) {
        clearState();
    }
};

async function runDownloadLoop() {
    // Determine start point
    const existingOrders = new Set(downloadState.chapters.map(c => c.order));
    const remaining = chapters.filter(ch => !existingOrders.has(ch.order));

    if (remaining.length === 0) {
        alert("All chapters already downloaded!");
        isDownloading = false;
        updateProgressUI();
        return;
    }

    for (const ch of remaining) {
        if (stopRequested || !isDownloading) {
            break;
        }

        progressText.textContent = `Fetching ${ch.order}...`;
        try {
            const data = await fetchChapterContent(ch.order);
            downloadState.chapters.push(data);
            saveState(); // Save after each chapter
            console.log(`Saved chapter ${ch.order}`);
        } catch (err) {
            console.error(`Failed chapter ${ch.order}`, err);
            progressText.textContent = `Error at ${ch.order}. Paused.`;
            stopDownload();
            alert(`Failed to download chapter ${ch.order}. Check console.`);
            break;
        }

        // Delay 12 seconds
        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    if (isDownloading && !stopRequested) {
        alert("Download Complete!");
        isDownloading = false;
        updateProgressUI();
    }
}

updateProgressUI();
})();
