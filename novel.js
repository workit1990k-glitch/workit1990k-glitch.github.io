(async function WTREpubDownloader() {
"use strict";

// --- Configuration ---
const STORAGE_KEY = 'wtr_epub_data';
const DELAY_MS = 12000; // 12 seconds
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

// --- State ---
let isDownloading = false;
let stopRequested = false;
let downloadState = {
    novelTitle: '',
    novelId: '',
    coverUrl: '',
    chapters: [], // { order, title, content }
    totalChapters: 0,
    lastUpdated: Date.now()
};

// --- Helper: Load JSZip dynamically ---
async function loadJSZip() {
    if (window.JSZip) return window.JSZip;
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = JSZIP_URL;
        script.onload = () => resolve(window.JSZip);
        script.onerror = () => reject(new Error('Failed to load JSZip'));
        document.head.appendChild(script);
    });
}

// --- Helper: Generate UUID ---
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- Helper: Escape XML ---
function escapeXML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// --- Helper: Convert HTML to valid XHTML ---
function htmlToXhtml(html, title) {
    // Basic XHTML wrapper with required namespaces
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head>
    <title>${escapeXML(title)}</title>
    <meta charset="UTF-8"/>
    <style>
        body { font-family: serif; line-height: 1.6; margin: 2em; }
        p { margin: 0.5em 0; text-align: justify; }
        img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
    </style>
</head>
<body>
    <h1>${escapeXML(title)}</h1>
    ${html}
</body>
</html>`;
    return xhtml;
}

// --- Helper: Load/Save State ---
function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.novelId === downloadState.novelId) {
                downloadState = { ...downloadState, ...parsed };
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
        alert("Storage Full! Please click 'Download EPUB' to save and clear space.");
        stopDownload();
    }
}

function clearState() {
    localStorage.removeItem(STORAGE_KEY);
    downloadState = {
        novelTitle: '',
        novelId: '',
        coverUrl: '',
        chapters: [],
        totalChapters: 0,
        lastUpdated: Date.now()
    };
    updateProgressUI();
}

// --- 1. Extract Metadata ---
const dom = document;
const leaves = dom.baseURI.split("/");
const novelIndex = leaves.indexOf("novel");
const id = leaves[novelIndex + 1];

// Extract title from breadcrumb (as requested)
const breadcrumbLink = document.querySelector('div.header nav.breadcrumb li.breadcrumb-item.active a');
const novelTitle = breadcrumbLink 
    ? breadcrumbLink.textContent.trim().replace(/[\/\\?%*:|"<>]/g, '-') 
    : "Unknown Novel";

// Extract cover image from menu-button (as requested)
const menuButton = document.querySelector('a.menu-button img');
const coverUrl = menuButton 
    ? (menuButton.src.startsWith('http') ? menuButton.src : `https://wtr-lab.com${menuButton.src}`)
    : '';

// Initialize State
downloadState.novelId = id;
downloadState.novelTitle = novelTitle;
downloadState.coverUrl = coverUrl;
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
<h3 style="margin: 0 0 6px 0;">📚 EPUB Downloader</h3>
<div style="font-size:12px; color:#666; margin-bottom:8px;" id="progressText">Ready</div>
<div style="display:flex; gap:8px; flex-wrap:wrap;">
    <button id="toggleDownloadBtn" style="flex:1; background:#28a745; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Start</button>
    <button id="downloadEpubBtn" style="flex:1; background:#007bff; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Save EPUB</button>
    <button id="clearBtn" style="background:#dc3545; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Clear</button>
</div>
</div>
<div id="chaptersList" style="padding:10px; max-height:50vh; overflow-y:auto;">
${chapters.map(ch => `
<div style="padding:4px 0; border-bottom:1px solid #eee; font-size:13px;">
    ${ch.order}: ${escapeXML(ch.title)}
</div>
`).join("")}
</div>
`;

document.body.appendChild(menu);

// Toggle Menu Button
const toggleBtn = document.createElement("button");
toggleBtn.textContent = "📥 EPUB Download";
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
    
    // Reconstruct HTML content with images
    const tempDiv = document.createElement("div");
    let imgCounter = 0;
    json.data.data.body.forEach(el => {
        if (el === "[image]") {
            const src = json.data.data?.images?.[imgCounter++] ?? "";
            if (src) {
                const img = document.createElement("img");
                img.src = src;
                img.alt = "Chapter image";
                tempDiv.appendChild(img);
            }
        } else {
            const pnode = document.createElement("p");
            const wrapper = document.createElement("div");
            wrapper.innerHTML = el;
            // Keep basic formatting but extract text content for safety
            pnode.innerHTML = wrapper.innerHTML;
            // Basic glossary replacement
            if (json?.data?.data?.glossary_data?.terms) {
                for (let i = 0; i < json.data.data.glossary_data.terms.length; i++) {
                    const term = json.data.data.glossary_data.terms[i][0];
                    if (term) {
                        pnode.innerHTML = pnode.innerHTML.replaceAll(`※${i}⛬`, `<strong>${escapeXML(term)}</strong>`);
                        pnode.innerHTML = pnode.innerHTML.replaceAll(`※${i}〓`, `<strong>${escapeXML(term)}</strong>`);
                    }
                }
            }
            tempDiv.appendChild(pnode);
        }
    });
    
    // Convert to clean HTML string
    const html = Array.from(tempDiv.children).map(el => el.outerHTML).join("\n");
    
    return {
        order: order,
        title: json.chapter?.title ?? `Chapter ${order}`,
        content: html,
        images: json.data.data?.images || []
    };
}

// --- 4. EPUB Creation Functions ---

function createMimetype() {
    return "application/epub+zip";
}

function createContainerXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function createContentOpf(title, author, language, chapters, coverExists, uuid) {
    const manifestItems = chapters.map((ch, idx) => 
        `    <item id="chapter${idx}" href="chapter${idx}.xhtml" media-type="application/xhtml+xml"/>`
    ).join("\n");
    
    const spineItems = chapters.map((ch, idx) => 
        `    <itemref idref="chapter${idx}"/>`
    ).join("\n");
    
    const coverMeta = coverExists ? `    <meta name="cover" content="cover-image"/>\n` : '';
    const coverItem = coverExists ? `    <item id="cover-image" href="cover.jpg" media-type="image/jpeg"/>\n` : '';
    const coverRef = coverExists ? `    <itemref idref="cover" linear="no"/>\n` : '';
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${escapeXML(title)}</dc:title>
    <dc:creator>${escapeXML(author || "Unknown")}</dc:creator>
    <dc:identifier id="uid">urn:uuid:${uuid}</dc:identifier>
    <dc:language>${language || "en"}</dc:language>
    <dc:publisher>wtr-lab.com</dc:publisher>
    <dc:date>${new Date().toISOString().split('T')[0]}</dc:date>
${coverMeta}  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${coverItem}${manifestItems}
  </manifest>
  <spine toc="ncx">
${coverRef}${spineItems}
  </spine>
</package>`;
}

function createTocNcx(title, chapters, uuid) {
    const navPoints = chapters.map((ch, idx) => `
    <navPoint id="navpoint-${idx}" playOrder="${idx}">
      <navLabel><text>${escapeXML(ch.title)}</text></navLabel>
      <content src="chapter${idx}.xhtml"/>
    </navPoint>`).join("");
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXML(title)}</text></docTitle>
  <navMap>${navPoints}
  </navMap>
</ncx>`;
}

function createCoverXhtml(title, hasCover) {
    const coverContent = hasCover 
        ? `<div style="text-align:center;"><img src="cover.jpg" alt="Cover" style="max-width:100%;height:auto;"/></div>`
        : `<div style="text-align:center;font-size:2em;">${escapeXML(title)}</div>`;
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title></head>
<body>${coverContent}</body>
</html>`;
}

// --- 5. Download Logic ---
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

// --- EPUB Download Handler ---
document.getElementById("downloadEpubBtn").onclick = async () => {
    if (downloadState.chapters.length === 0) {
        alert("No chapters downloaded yet.");
        return;
    }
    
    progressText.textContent = "Creating EPUB...";
    
    try {
        const JSZip = await loadJSZip();
        const zip = new JSZip();
        const uuid = generateUUID();
        const safeTitle = downloadState.novelTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        
        // 1. mimetype (must be first, uncompressed)
        zip.file("mimetype", createMimetype(), { compression: "STORE" });
        
        // 2. META-INF/container.xml
        zip.file("META-INF/container.xml", createContainerXml());
        
        // 3. Fetch and add cover image if available
        let hasCover = false;
        if (downloadState.coverUrl) {
            try {
                const coverResp = await fetch(downloadState.coverUrl);
                const coverBlob = await coverResp.blob();
                const coverArray = await coverBlob.arrayBuffer();
                zip.file("OEBPS/cover.jpg", coverArray, { binary: true });
                hasCover = true;
            } catch (e) {
                console.warn("Could not fetch cover image:", e);
            }
        }
        
        // 4. Add cover.xhtml
        zip.file("OEBPS/cover.xhtml", createCoverXhtml(downloadState.novelTitle, hasCover));
        
        // 5. Add chapter XHTML files
        const sortedChapters = [...downloadState.chapters].sort((a, b) => a.order - b.order);
        for (let i = 0; i < sortedChapters.length; i++) {
            const ch = sortedChapters[i];
            const xhtml = htmlToXhtml(ch.content, ch.title);
            zip.file(`OEBPS/chapter${i}.xhtml`, xhtml);
        }
        
        // 6. Add content.opf
        const opf = createContentOpf(
            downloadState.novelTitle,
            "Web Novel Author",
            "en",
            sortedChapters,
            hasCover,
            uuid
        );
        zip.file("OEBPS/content.opf", opf);
        
        // 7. Add toc.ncx
        const ncx = createTocNcx(downloadState.novelTitle, sortedChapters, uuid);
        zip.file("OEBPS/toc.ncx", ncx);
        
        // 8. Generate and download
        const blob = await zip.generateAsync({ 
            type: "blob",
            mimeType: "application/epub+zip",
            compression: "DEFLATE"
        }, (metadata) => {
            progressText.textContent = `Packaging: ${Math.round(metadata.percent)}%`;
        });
        
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${safeTitle}.epub`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        
        progressText.textContent = "EPUB Ready!";
        
        // Optional: Clear storage after download
        if(confirm("Download complete. Clear local storage to save space?")) {
            clearState();
        }
        
    } catch (err) {
        console.error("EPUB creation failed:", err);
        alert("Failed to create EPUB: " + err.message);
        progressText.textContent = "Error creating EPUB";
    }
};

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
        if (stopRequested || !isDownloading) {
            break;
        }

        progressText.textContent = `Fetching ${ch.order}...`;
        try {
            const data = await fetchChapterContent(ch.order);
            downloadState.chapters.push(data);
            saveState();
            console.log(`Saved chapter ${ch.order}`);
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
        alert("Download Complete! Click 'Save EPUB' to create your file.");
        isDownloading = false;
        updateProgressUI();
    }
}

updateProgressUI();
})();
