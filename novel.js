(async function WTRJsonDownloader() {
"use strict";

// --- Configuration ---
// localStorage persistence REMOVED - state is now in-memory only
const DELAY_MS = 12000;

// --- State ---
let isDownloading = false;
let stopRequested = false;
let downloadState = {
    novelTitle: '',
    novelId: '',
    chapters: [],
    totalChapters: 0,
    lastUpdated: Date.now()
};

// --- XML Entity Encoder ---
function escapeXml(unsafe) {
    if (!unsafe) return '';
    return unsafe.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// --- Helper: In-memory state only (localStorage REMOVED) ---
// loadState(), saveState(), clearState() functions removed
// State resets on page refresh (by design)

function updateProgressUI() {
    const count = downloadState.chapters.length;
    const total = downloadState.totalChapters;
    const range = rangeInput?.value?.trim() || '';
    const { start, end } = parseChapterRange(range, total);
    if (progressText) {
        progressText.textContent = `${count}/${total} | ${start}-${end}`;
    }
    if (toggleBtnEl) {
        toggleBtnEl.textContent = isDownloading ? "⏸ Pause" : "▶ Start";
        toggleBtnEl.style.background = isDownloading ? "#dc3545" : "#28a745";
    }
}

function stopDownload() {
    isDownloading = false;
    stopRequested = true;
    updateProgressUI();
}

function clearState() {
    // In-memory clear only
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

downloadState.novelId = id;
downloadState.novelTitle = novelTitle;
// loadState() REMOVED

// Fetch Chapter List
const chaptersResp = await fetch(`https://wtr-lab.com/api/chapters/${id}`, { credentials: "include" });
const chaptersJson = await chaptersResp.json();
const allChapters = chaptersJson.chapters;
downloadState.totalChapters = allChapters.length;

// --- Parse Chapter Range ---
function parseChapterRange(rangeStr, total) {
    if (!rangeStr || rangeStr.trim() === '') {
        return { start: 1, end: total };
    }
    const match = rangeStr.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (match) {
        let start = parseInt(match[1], 10);
        let end = parseInt(match[2], 10);
        start = Math.max(1, Math.min(start, total));
        end = Math.max(start, Math.min(end, total));
        return { start, end };
    }
    return { start: 1, end: total };
}

function getChaptersInRange(rangeStr) {
    const { start, end } = parseChapterRange(rangeStr, allChapters.length);
    return allChapters.filter(ch => ch.order >= start && ch.order <= end);
}

// --- 2. Menu UI ---
const menu = document.createElement("div");
menu.style.cssText = `
position: fixed; top: 60px; right: 20px; background: #fff; border-radius: 12px;
padding: 0; max-height: 80vh; overflow-y: auto; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
display: none; width: 380px; font-family: sans-serif;
`;

menu.innerHTML = `
<div id="menuHeader" style="position: sticky; top: 0; background: #fff; z-index: 10; padding: 12px; border-bottom: 1px solid #ddd;">
<h3 style="margin: 0 0 8px 0;">📚 JSON/EPUB Downloader</h3>
<div style="font-size:12px; color:#666; margin-bottom:10px;" id="progressText">Ready</div>

<div style="margin-bottom:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
    <label style="font-size:12px; font-weight:500;">Chapters:</label>
    <input type="text" id="rangeInput" placeholder="e.g., 1-100 or 400-700" 
           style="flex:1; min-width:120px; padding:4px 8px; border:1px solid #ccc; border-radius:4px; font-size:12px;">
    <span style="font-size:11px; color:#888;">(default: all)</span>
</div>

<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px;">
    <button id="toggleDownloadBtn" style="flex:1; min-width:70px; background:#28a745; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-size:12px;">Start</button>
    <button id="downloadJsonBtn" style="flex:1; min-width:70px; background:#007bff; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-size:12px;">JSON</button>
    <button id="downloadEpubBtn" style="flex:1; min-width:70px; background:#6f42c1; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-size:12px;">EPUB</button>
    <button id="clearBtn" style="background:#dc3545; color:#fff; border:none; padding:6px 10px; border-radius:4px; cursor:pointer; font-size:12px;">Clear</button>
</div>
</div>
<div id="chaptersList" style="padding:10px; max-height:50vh; overflow-y:auto;">
${allChapters.map(ch => `
<div style="padding:4px 0; border-bottom:1px solid #eee; font-size:13px;" data-order="${ch.order}">
    <span style="color:#666;">${ch.order}:</span> ${ch.title}
</div>
`).join("")}
</div>
`;

document.body.appendChild(menu);

// Toggle Menu Button
const toggleBtn = document.createElement("button");
toggleBtn.textContent = "📥 Download";
toggleBtn.style.cssText = `position: fixed; top: 10px; right: 10px; z-index: 999999; padding: 8px 12px; background: #333; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size:13px;`;
toggleBtn.onclick = () => menu.style.display = menu.style.display === "none" ? "block" : "none";
document.body.appendChild(toggleBtn);

// --- EPUB Metadata Modal ---
const epubModal = document.createElement("div");
epubModal.style.cssText = `
position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
background: rgba(0,0,0,0.5); z-index: 100000; display: none; 
justify-content: center; align-items: center;
`;
epubModal.innerHTML = `
<div style="background:#fff; border-radius:12px; padding:20px; width:90%; max-width:500px; box-shadow:0 8px 32px rgba(0,0,0,0.3);">
    <h3 style="margin:0 0 15px 0; border-bottom:1px solid #eee; padding-bottom:10px;">📖 EPUB Export Settings</h3>
    
    <div style="margin-bottom:12px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Cover Image URL</label>
        <input type="url" id="epubCover" placeholder="https://example.com/cover.jpg" 
               style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px;">
        <small style="color:#666;font-size:11px;">Image will be embedded in EPUB (JPG/PNG)</small>
    </div>
    
    <div style="margin-bottom:12px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Book Title</label>
        <input type="text" id="epubTitle" value="${novelTitle}" 
               style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px;">
    </div>
    
    <div style="margin-bottom:12px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Author</label>
        <input type="text" id="epubAuthor" placeholder="Author name" 
               style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px;">
    </div>
    
    <div style="margin-bottom:12px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Description</label>
        <textarea id="epubDesc" rows="3" placeholder="Brief description..." 
                  style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px; resize:vertical;"></textarea>
    </div>
    
    <div style="margin-bottom:15px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Tags (comma-separated)</label>
        <input type="text" id="epubTags" placeholder="fantasy, romance, cultivation" 
               style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px;">
    </div>
    
    <div style="display:flex; gap:10px; justify-content:flex-end;">
        <button id="epubCancel" style="padding:8px 20px; background:#6c757d; color:#fff; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
        <button id="epubConfirm" style="padding:8px 20px; background:#6f42c1; color:#fff; border:none; border-radius:4px; cursor:pointer;">Generate EPUB</button>
    </div>
</div>
`;
document.body.appendChild(epubModal);

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
    try {
        json = await res.json();
    } catch {
        throw new Error("Invalid JSON");
    }
    if (!json?.data?.data?.body) {
        throw new Error("Missing body");
    }
    
    const tempDiv = document.createElement("div");
    let imgCounter = 0;
    
    json.data.data.body.forEach(el => {
        if (el === "[image]") {
            const src = json.data.data?.images?.[imgCounter++] ?? "";
            if (src) {
                const img = document.createElement("img");
                img.src = src;
                img.alt = "Chapter image";
                img.style.maxWidth = "100%";
                tempDiv.appendChild(img);
            }
        } else {
            const pnode = document.createElement("p");
            const wrapper = document.createElement("div");
            wrapper.innerHTML = el;
            pnode.textContent = wrapper.textContent || wrapper.innerText;
            
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
const rangeInput = document.getElementById("rangeInput");

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
    if(confirm("Clear all downloaded chapters (in-memory)?")) {
        clearState();
        stopDownload();
    }
};

// JSON Download
document.getElementById("downloadJsonBtn").onclick = () => {
    if (downloadState.chapters.length === 0) {
        alert("No chapters downloaded yet.");
        return;
    }
    const range = rangeInput.value.trim();
    const { start, end } = parseChapterRange(range, downloadState.totalChapters);
    const filename = (start === 1 && end === downloadState.totalChapters) 
        ? `${downloadState.novelTitle}.json` 
        : `${downloadState.novelTitle} ${start}-${end}.json`;
    
    const blob = new Blob([JSON.stringify(downloadState, null, 2)], { type: 'application/json' });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    if(confirm("Download complete. Clear downloaded chapters?")) {
        clearState();
    }
};

// EPUB Modal Handlers
document.getElementById("downloadEpubBtn").onclick = () => {
    if (downloadState.chapters.length === 0) {
        alert("No chapters downloaded yet.");
        return;
    }
    const range = rangeInput.value.trim();
    if (range) {
        const { start, end } = parseChapterRange(range, downloadState.totalChapters);
        if (start !== 1 || end !== downloadState.totalChapters) {
            document.getElementById("epubTitle").value = `${downloadState.novelTitle} ${start}-${end}`;
        }
    }
    epubModal.style.display = "flex";
};

document.getElementById("epubCancel").onclick = () => {
    epubModal.style.display = "none";
};

document.getElementById("epubConfirm").onclick = async () => {
    epubModal.style.display = "none";
    
    const metadata = {
        cover: document.getElementById("epubCover").value.trim(),
        title: document.getElementById("epubTitle").value.trim() || downloadState.novelTitle,
        author: document.getElementById("epubAuthor").value.trim() || "Unknown",
        description: document.getElementById("epubDesc").value.trim(),
        tags: document.getElementById("epubTags").value.trim().split(',').map(t => t.trim()).filter(t => t)
    };
    
    const range = rangeInput.value.trim();
    const { start, end } = parseChapterRange(range, downloadState.totalChapters);
    
    try {
        await generateAndDownloadEpub(metadata, start, end);
        if(confirm("EPUB generated! Clear downloaded chapters?")) {
            clearState();
        }
    } catch (err) {
        console.error("EPUB generation failed:", err);
        alert("Failed to generate EPUB: " + err.message);
    }
};

// --- Helper: Fetch image as Blob ---
async function fetchImageAsBlob(url) {
    try {
        const response = await fetch(url, { mode: 'cors' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        // Validate it's an image
        if (!blob.type.startsWith('image/')) {
            throw new Error(`Not an image: ${blob.type}`);
        }
        return blob;
    } catch (err) {
        console.warn("Cover fetch failed, using placeholder:", err);
        return null;
    }
}

// --- Helper: Get file extension from URL or MIME type ---
function getImageExtension(url, mimeType) {
    if (mimeType) {
        const extMap = {
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp'
        };
        if (extMap[mimeType.toLowerCase()]) return extMap[mimeType.toLowerCase()];
    }
    // Fallback to URL parsing
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'jpg';
        if (pathname.endsWith('.png')) return 'png';
        if (pathname.endsWith('.gif')) return 'gif';
        if (pathname.endsWith('.webp')) return 'webp';
    } catch {}
    return 'jpg'; // default fallback
}

// --- EPUB Generation ---
async function generateAndDownloadEpub(metadata, startOrder, endOrder) {
    const chapters = downloadState.chapters
        .filter(c => c.order >= startOrder && c.order <= endOrder)
        .sort((a, b) => a.order - b.order);
    
    if (chapters.length === 0) {
        throw new Error("No chapters in selected range");
    }
    
    // Load JSZip dynamically
    if (typeof JSZip === 'undefined') {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error("Failed to load JSZip"));
            document.head.appendChild(script);
        });
    }
    
    const zip = new JSZip();
    const timestamp = new Date().toISOString().split('T')[0];
    const uid = `urn:uuid:${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // 1. mimetype (must be first, uncompressed)
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    
    // 2. container.xml
    zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);
    
    const oebps = zip.folder("OEBPS");
    
    // 3. CSS
    oebps.file("styles.css", `body{font-family:serif;line-height:1.6;margin:1em}h1.chapter-title{text-align:center;margin:2em 0 1em}img{max-width:100%;height:auto}`);
    
    let manifestItems = '';
    let spineItems = '';
    
    // 4. Cover Image Handling (FIXED: embed image instead of hotlinking)
    let coverFilename = null;
    let coverMediaType = 'image/jpeg';
    
    if (metadata.cover) {
        progressText.textContent = `Fetching cover image...`;
        const coverBlob = await fetchImageAsBlob(metadata.cover);
        
        if (coverBlob) {
            coverMediaType = coverBlob.type || 'image/jpeg';
            const ext = getImageExtension(metadata.cover, coverMediaType);
            coverFilename = `cover.${ext}`;
            
            // Add image to EPUB
            oebps.file(coverFilename, coverBlob, { binary: true });
            
            // Add to manifest with cover-image property
            manifestItems += `<item id="cover-img" href="${coverFilename}" media-type="${coverMediaType}" properties="cover-image"/>\n`;
        }
    }
    
    // Cover page XHTML
    const coverContent = coverFilename 
        ? `<img src="${coverFilename}" alt="Cover" style="max-width:100%;max-height:100vh;display:block;margin:0 auto"/>`
        : `<div style="margin-top:40vh;text-align:center"><h1>${escapeXml(metadata.title)}</h1>${metadata.author ? `<p style="margin-top:1em">by ${escapeXml(metadata.author)}</p>` : ''}</div>`;
    
    oebps.file("cover.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Cover</title><style>body{margin:0;padding:0;text-align:center;background:#fff}</style></head>
<body>${coverContent}</body></html>`);
    
    manifestItems += '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n';
    manifestItems += '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n';
    spineItems += '<itemref idref="cover"/>\n';
    
    // 5. Chapters
    for (const ch of chapters) {
        const escapedContent = ch.content
            .split('\n')
            .map(line => escapeXml(line.trim()))
            .filter(line => line)
            .join('</p><p>');
        
        const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
    <title>${escapeXml(ch.title)}</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
    <h1 class="chapter-title">${escapeXml(ch.title)}</h1>
    <p>${escapedContent || ' '}</p>
</body>
</html>`;
        
        const filename = `chapter_${String(ch.order).padStart(4, '0')}.xhtml`;
        oebps.file(filename, xhtml);
        manifestItems += `<item id="ch${ch.order}" href="${filename}" media-type="application/xhtml+xml"/>\n`;
        spineItems += `<itemref idref="ch${ch.order}"/>\n`;
    }
    
    // 6. content.opf
    const safeTitle = escapeXml(metadata.title);
    const safeAuthor = escapeXml(metadata.author || 'Unknown');
    const safeDesc = metadata.description ? escapeXml(metadata.description) : '';
    const tagsXml = metadata.tags
        .filter(t => t)
        .map(tag => `<dc:subject>${escapeXml(tag)}</dc:subject>`)
        .join('\n    ');
    
    oebps.file("content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uid}</dc:identifier>
    <dc:title>${safeTitle}</dc:title>
    <dc:creator>${safeAuthor}</dc:creator>
    <dc:language>en</dc:language>
    <dc:date>${timestamp}</dc:date>
    ${safeDesc ? `<dc:description>${safeDesc}</dc:description>` : ''}
    ${tagsXml ? tagsXml : ''}
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`);
    
    // 7. toc.ncx
    const navPoints = chapters.map((ch, idx) => `
    <navPoint id="navpoint-${idx+1}" playOrder="${idx+1}">
      <navLabel><text>${escapeXml(ch.title)}</text></navLabel>
      <content src="chapter_${String(ch.order).padStart(4, '0')}.xhtml"/>
    </navPoint>`).join('');
    
    oebps.file("toc.ncx", `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${uid}"/>
  </head>
  <docTitle><text>${safeTitle}</text></docTitle>
  <docAuthor><text>${safeAuthor}</text></docAuthor>
  <navMap>${navPoints}
  </navMap>
</ncx>`);
    
    // 8. nav.xhtml
    const navItems = chapters.map(ch => 
        `<li><a href="chapter_${String(ch.order).padStart(4, '0')}.xhtml">${escapeXml(ch.title)}</a></li>`
    ).join('\n');
    
    oebps.file("nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Table of Contents</title></head>
<body>
  <nav epub:type="toc">
    <h1>Chapters</h1>
    <ol>${navItems}
    </ol>
  </nav>
</body>
</html>`);
    
    // 9. Generate EPUB
    const filename = `${metadata.title.replace(/[^a-z0-9\-_]/gi, '_')}.epub`;
    
    progressText.textContent = `Compressing EPUB...`;
    
    const blob = await zip.generateAsync({ 
        type: "blob", 
        mimeType: "application/epub+zip", 
        compression: "DEFLATE",
        compressionOptions: { level: 9 }
    });
    
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    
    progressText.textContent = `EPUB ready!`;
}

// --- Main Download Loop ---
async function runDownloadLoop() {
    const range = rangeInput.value.trim();
    const chaptersToDownload = getChaptersInRange(range);
    const existingOrders = new Set(downloadState.chapters.map(c => c.order));
    const remaining = chaptersToDownload.filter(ch => !existingOrders.has(ch.order));

    if (remaining.length === 0) {
        alert("All chapters in range already downloaded!");
        isDownloading = false;
        updateProgressUI();
        return;
    }

    for (const ch of remaining) {
        if (stopRequested || !isDownloading) {
            break;
        }

        if (progressText) progressText.textContent = `Fetching #${ch.order}...`;
        try {
            const data = await fetchChapterContent(ch.order);
            if (!downloadState.chapters.some(c => c.order === data.order)) {
                downloadState.chapters.push(data);
                // saveState() REMOVED - in-memory only
                updateProgressUI();
            }
        } catch (err) {
            if (progressText) progressText.textContent = `Error at #${ch.order}`;
            stopDownload();
            alert(`Failed chapter ${ch.order}: ${err.message}`);
            break;
        }

        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    if (isDownloading && !stopRequested) {
        alert(`Download Complete! ${downloadState.chapters.length} chapters.`);
        isDownloading = false;
        updateProgressUI();
    }
}

// Initialize
updateProgressUI();

// Range highlight
if (rangeInput) {
    rangeInput.addEventListener('input', () => {
        const { start, end } = parseChapterRange(rangeInput.value.trim(), allChapters.length);
        document.querySelectorAll('#chaptersList > div').forEach(div => {
            const order = parseInt(div.dataset.order, 10);
            div.style.background = (order >= start && order <= end) ? '#e8f4fd' : 'transparent';
        });
        updateProgressUI();
    });
}

})();
