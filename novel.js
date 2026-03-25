(async function WTREpubDownloader() {
"use strict";

// --- Configuration ---
const STORAGE_KEY = 'wtr_epub_data';
const DELAY_MS = 12000; // 12 seconds

// --- Load JSZip dynamically ---
async function loadJSZip() {
    if (typeof JSZip !== 'undefined') return JSZip;
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        script.onload = () => resolve(JSZip);
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// --- State ---
let isDownloading = false;
let stopRequested = false;
let downloadState = {
    novelTitle: '',
    novelId: '',
    chapters: [], // { order, title, content }
    totalChapters: 0,
    lastUpdated: Date.now(),
    metadata: {} // { cover, author, description, genres }
};

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
        chapters: [],
        totalChapters: 0,
        lastUpdated: Date.now(),
        metadata: {}
    };
    updateProgressUI();
}

// --- Extract Novel Metadata from Main Page ---
async function fetchNovelMetadata(novelId, language) {
    try {
        const novelUrl = `https://wtr-lab.com/${language}/novel/${novelId}`;
        const resp = await fetch(novelUrl, { credentials: "include" });
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        // Cover image
        const coverImg = doc.querySelector('.image-wrap img');
        const coverUrl = coverImg?.src ? `https://wtr-lab.com${coverImg.src}` : null;
        
        // Title (first <li> in title-list)
        const titleList = doc.querySelector('ul.title-list li');
        const title = titleList?.textContent?.trim() || "Unknown Novel";
        
        // Description
        const descEl = doc.querySelector('span.description p');
        const description = descEl?.textContent?.trim() || "";
        
        // Genres (only genre tags)
        const genreTags = doc.querySelectorAll('a.genre.tag');
        const genres = Array.from(genreTags).map(el => el.textContent.trim()).filter(g => g);
        
        // Author
        const authorEl = doc.querySelector('.sig-author a');
        const author = authorEl?.textContent?.trim() || "Unknown Author";
        
        return { cover: coverUrl, title, description, genres, author };
    } catch (e) {
        console.error("Failed to fetch metadata", e);
        return { cover: null, title: "Unknown Novel", description: "", genres: [], author: "Unknown" };
    }
}

// --- DOM Setup ---
const dom = document;
const leaves = dom.baseURI.split("/");
const novelIndex = leaves.indexOf("novel");
const id = leaves[novelIndex + 1];
const language = leaves[novelIndex - 1] || 'en';

// Try to get title from menu-button first, fallback to current method
const menuButton = document.querySelector('a.menu-button[href*="/novel/"]');
const novelTitle = menuButton 
    ? menuButton.querySelector('.title')?.textContent?.trim().replace(/[\/\\?%*:|"<>]/g, '-') || "Unknown Novel"
    : (document.querySelector('a[href*="/novel/"]')?.textContent?.trim().replace(/[\/\\?%*:|"<>]/g, '-') || "Unknown Novel");

// Initialize State
downloadState.novelId = id;
downloadState.novelTitle = novelTitle;
loadState();

// Fetch Chapter List
const chaptersResp = await fetch(`https://wtr-lab.com/api/chapters/${id}`, { credentials: "include" });
const chaptersJson = await chaptersResp.json();
const chapters = chaptersJson.chapters;
downloadState.totalChapters = chapters.length;

// Fetch metadata if not already loaded
if (!downloadState.metadata?.author) {
    const meta = await fetchNovelMetadata(id, language);
    downloadState.metadata = meta;
    saveState();
}

// --- Menu UI ---
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
<h3 style="margin: 0 0 6px 0;">EPUB Downloader</h3>
<div style="font-size:12px; color:#666; margin-bottom:8px;" id="progressText">Ready</div>
<div style="display:flex; gap:8px; flex-wrap:wrap;">
    <button id="toggleDownloadBtn" style="flex:1; background:#28a745; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Start</button>
    <button id="downloadEpubBtn" style="flex:1; background:#007bff; color:#fff; border:none; padding:6px; border-radius:4px; cursor:pointer;">Save EPUB</button>
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
toggleBtn.textContent = "📚 EPUB Download";
toggleBtn.style.cssText = `position: fixed; top: 10px; right: 10px; z-index: 999999; padding: 8px 12px; background: #333; color: #fff; border: none; border-radius: 4px; cursor: pointer;`;
toggleBtn.onclick = () => menu.style.display = menu.style.display === "none" ? "block" : "none";
document.body.appendChild(toggleBtn);

// --- Fetch Chapter Content (Same as original) ---
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

// --- EPUB Generation Functions ---
function escapeXml(unsafe) {
    return unsafe.replace(/[<>&'"]/g, c => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
    })[c]);
}

function generateMimetype() {
    return "application/epub+zip";
}

function generateContainerXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function generateContentOpf(metadata, chapters) {
    const { title, author, description, genres, cover } = metadata;
    const uid = `wtr-${downloadState.novelId}`;
    const date = new Date().toISOString().split('T')[0];
    
    // Generate manifest items
    let manifestItems = `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>`;
    
    chapters.forEach((ch, idx) => {
        const fname = `chapter_${String(idx).padStart(3, '0')}.xhtml`;
        manifestItems += `\n    <item id="chap${idx}" href="${fname}" media-type="application/xhtml+xml"/>`;
    });
    
    if (cover) {
        manifestItems += `\n    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>`;
    }
    
    // Generate spine
    let spineItems = chapters.map((_, idx) => `<itemref idref="chap${idx}"/>`).join('\n      ');
    
    // Generate metadata
    const authorList = Array.isArray(author) ? author : [author];
    const authorXml = authorList.map(a => `<dc:creator opf:role="aut">${escapeXml(a)}</dc:creator>`).join('\n      ');
    const genreXml = genres.map(g => `<dc:subject>${escapeXml(g)}</dc:subject>`).join('\n      ');
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="uid" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="uid">${uid}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    ${authorXml}
    <dc:language>en</dc:language>
    <dc:date>${date}</dc:date>
    <dc:publisher>wtr-lab.com</dc:publisher>
    ${description ? `<dc:description>${escapeXml(description)}</dc:description>` : ''}
    ${genreXml}
    ${cover ? '<meta property="dcterms:modified">' + date + '</meta>' : ''}
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;
}

function generateTocNcx(metadata, chapters) {
    const { title } = metadata;
    const uid = `wtr-${downloadState.novelId}`;
    
    let navPoints = chapters.map((ch, idx) => `
    <navPoint id="navpoint-${idx}" playOrder="${idx + 1}">
      <navLabel><text>${escapeXml(ch.title)}</text></navLabel>
      <content src="OEBPS/chapter_${String(idx).padStart(3, '0')}.xhtml"/>
    </navPoint>`).join('');
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<ncx version="2005-1" xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <head>
    <meta name="dtb:uid" content="${uid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`;
}

function generateTocXhtml(metadata, chapters) {
    const { title } = metadata;
    
    let navItems = chapters.map((ch, idx) => `
      <li><a href="chapter_${String(idx).padStart(3, '0')}.xhtml">${escapeXml(ch.title)}</a></li>`).join('');
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
  <style>
    body { font-family: sans-serif; padding: 1em; }
    nav ol { list-style: none; padding-left: 0; }
    nav li { margin: 0.5em 0; }
    nav a { text-decoration: none; color: #333; }
  </style>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
      ${navItems}
    </ol>
  </nav>
</body>
</html>`;
}

function generateChapterXhtml(chapter, index) {
    const { title, content } = chapter;
    // Convert plain text to simple XHTML paragraphs
    const paragraphs = content.split('\n\n').filter(p => p.trim()).map(p => 
        `<p>${escapeXml(p.trim())}</p>`
    ).join('\n');
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeXml(title)}</title>
  <style>
    body { font-family: serif; line-height: 1.6; padding: 1em; max-width: 40em; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 1.5em; }
    p { text-indent: 1.5em; margin: 0 0 1em 0; }
    p:first-of-type { text-indent: 0; }
  </style>
</head>
<body>
  <h1>${escapeXml(title)}</h1>
  ${paragraphs}
</body>
</html>`;
}

async function fetchCoverImage(url) {
    if (!url) return null;
    try {
        const resp = await fetch(url);
        const blob = await resp.blob();
        return await blob.arrayBuffer();
    } catch (e) {
        console.warn("Failed to fetch cover image", e);
        return null;
    }
}

// --- Download Logic ---
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

document.getElementById("downloadEpubBtn").onclick = async () => {
    if (downloadState.chapters.length === 0) {
        alert("No chapters downloaded yet.");
        return;
    }
    
    progressText.textContent = "Generating EPUB...";
    
    try {
        const JSZip = await loadJSZip();
        const zip = new JSZip();
        const { title, author, description, genres, cover: coverUrl } = downloadState.metadata;
        
        // Add mimetype (must be first, uncompressed)
        zip.file("mimetype", generateMimetype(), { compression: "STORE" });
        
        // Add META-INF/container.xml
        zip.file("META-INF/container.xml", generateContainerXml());
        
        // Add OEBPS files
        const oebps = zip.folder("OEBPS");
        oebps.file("content.opf", generateContentOpf(downloadState.metadata, downloadState.chapters));
        oebps.file("toc.ncx", generateTocNcx(downloadState.metadata, downloadState.chapters));
        oebps.file("toc.xhtml", generateTocXhtml(downloadState.metadata, downloadState.chapters));
        
        // Add chapter files
        downloadState.chapters.forEach((ch, idx) => {
            const fname = `chapter_${String(idx).padStart(3, '0')}.xhtml`;
            oebps.file(fname, generateChapterXhtml(ch, idx));
        });
        
        // Add cover image if available
        if (coverUrl) {
            const coverBuffer = await fetchCoverImage(coverUrl);
            if (coverBuffer) {
                oebps.folder("images").file("cover.jpg", coverBuffer);
            }
        }
        
        // Generate EPUB blob
        const blob = await zip.generateAsync({ 
            type: "blob",
            mimeType: "application/epub+zip",
            compression: "DEFLATE"
        });
        
        // Trigger download
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${downloadState.novelTitle.replace(/[^\w\-]+/g, '_')}.epub`;
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
        console.error("EPUB generation failed", err);
        alert("Failed to generate EPUB. Check console for details.");
        updateProgressUI();
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
        alert("Download Complete! Click 'Save EPUB' to export.");
        isDownloading = false;
        updateProgressUI();
    }
}

updateProgressUI();
})();
