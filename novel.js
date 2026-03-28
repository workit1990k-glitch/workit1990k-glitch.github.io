(async function WTRJsonDownloader() {
"use strict";

const DELAY_MS = 12000;

// --- State (in-memory only, no localStorage) ---
let isDownloading = false;
let stopRequested = false;
let downloadState = {
    novelTitle: '',
    novelId: '',
    chapters: [],
    totalChapters: 0,
    lastUpdated: Date.now()
};

// --- Global term caches (fetched once per session) ---
let userTermsCache = null;
let storyTermsCache = null;

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

// --- UI Helpers ---
function updateProgressUI() {
    const count = downloadState.chapters.length;
    const total = downloadState.totalChapters;
    const range = rangeInput?.value?.trim() || '';
    const { start, end } = parseChapterRange(range, total);
    if (progressText) progressText.textContent = `${count}/${total} | ${start}-${end}`;
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
    downloadState = { novelTitle: '', novelId: '', chapters: [], totalChapters: 0, lastUpdated: Date.now() };
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

const chaptersResp = await fetch(`https://wtr-lab.com/api/chapters/${id}`, { credentials: "include" });
const chaptersJson = await chaptersResp.json();
const allChapters = chaptersJson.chapters;
downloadState.totalChapters = allChapters.length;

// --- Parse Chapter Range ---
function parseChapterRange(rangeStr, total) {
    if (!rangeStr || rangeStr.trim() === '') return { start: 1, end: total };
    const match = rangeStr.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (match) {
        let start = parseInt(match[1], 10), end = parseInt(match[2], 10);
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
menu.id = "wtrDownloaderMenu";
menu.style.cssText = `position: fixed; top: 60px; right: 20px; background: #fff; border-radius: 12px;
padding: 0; max-height: 80vh; overflow-y: auto; z-index: 4000; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
display: none; width: 380px; font-family: sans-serif;`;

menu.innerHTML = `
<div id="menuHeader" style="position: sticky; top: 0; background: #fff; z-index: 10; padding: 12px; border-bottom: 1px solid #ddd;">
<h3 style="margin: 0 0 8px 0;">📚 JSON/EPUB Downloader</h3>
<div style="font-size:12px; color:#666; margin-bottom:10px;" id="progressText">Ready</div>
<div style="margin-bottom:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
    <label style="font-size:12px; font-weight:500;">Chapters:</label>
    <input type="text" id="rangeInput" placeholder="e.g., 1-100" style="flex:1; min-width:120px; padding:4px 8px; border:1px solid #ccc; border-radius:4px; font-size:12px;">
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
${allChapters.map(ch => `<div style="padding:4px 0; border-bottom:1px solid #eee; font-size:13px;" data-order="${ch.order}"><span style="color:#666;">${ch.order}:</span> ${ch.title}</div>`).join("")}
</div>`;
document.body.appendChild(menu);

// Toggle Menu Button - higher z-index so always clickable
const toggleBtn = document.createElement("button");
toggleBtn.textContent = "📥 Download";
toggleBtn.style.cssText = `position: fixed; top: 10px; right: 10px; z-index: 6000; padding: 8px 12px; background: #333; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size:13px;`;
toggleBtn.onclick = () => {
    menu.style.display = menu.style.display === "none" ? "block" : "none";
    if (epubModal) epubModal.style.display = "none";
};
document.body.appendChild(toggleBtn);

// --- EPUB Modal - Centered, lower z-index, allows text selection ---
const epubModal = document.createElement("div");
epubModal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.4); z-index: 5000; display: none;
    justify-content: center; align-items: center; pointer-events: none;
`;
epubModal.innerHTML = `
<div style="background:#fff; border-radius:12px; padding:20px; width:90%; max-width:500px; 
    box-shadow:0 8px 32px rgba(0,0,0,0.3); pointer-events: auto; max-height: 90vh; overflow-y: auto;">
    <h3 style="margin:0 0 15px 0; border-bottom:1px solid #eee; padding-bottom:10px;">📖 EPUB Export Settings</h3>
    
    <div style="margin-bottom:12px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Cover Image URL (Optional)</label>
        <input type="url" id="epubCover" placeholder="https://example.com/cover.jpg or leave blank" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px;">
        <small style="color:#666;font-size:11px;">Proxied via wsrv.nl to bypass CORS. Leave blank for text cover.</small>
    </div>
    
    <div style="margin-bottom:12px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Book Title</label>
        <input type="text" id="epubTitle" value="${novelTitle}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px;">
    </div>
    
    <div style="margin-bottom:12px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Author</label>
        <input type="text" id="epubAuthor" placeholder="Author name" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px;">
    </div>
    
    <div style="margin-bottom:12px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Description</label>
        <textarea id="epubDesc" rows="3" placeholder="Brief description..." style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px; resize:vertical;"></textarea>
    </div>
    
    <div style="margin-bottom:15px;">
        <label style="display:block; font-size:13px; font-weight:500; margin-bottom:4px;">Tags (comma-separated)</label>
        <input type="text" id="epubTags" placeholder="fantasy, romance, cultivation" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-size:13px;">
    </div>
    
    <div style="display:flex; gap:10px; justify-content:flex-end;">
        <button id="epubCancel" style="padding:8px 20px; background:#6c757d; color:#fff; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
        <button id="epubConfirm" style="padding:8px 20px; background:#6f42c1; color:#fff; border:none; border-radius:4px; cursor:pointer;">Generate EPUB</button>
    </div>
</div>`;
document.body.appendChild(epubModal);

epubModal.addEventListener('click', (e) => {
    if (e.target === epubModal) epubModal.style.display = "none";
});

// --- 3. Term Fetching Functions ---

async function fetchUserTerms() {
    if (userTermsCache !== null) return userTermsCache;
    try {
        const resp = await fetch("https://wtr-lab.com/api/v2/user/config", {
            credentials: "include", headers: { "Content-Type": "application/json" }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const terms = json?.config?.terms || [];
        const filtered = terms.filter(a => a[4] == null || (Array.isArray(a[4]) && a[4].includes(downloadState.novelId)));
        userTermsCache = [];
        for (const term of filtered) {
            if (term[2] && term[1]) {
                const fromList = term[2].split("|");
                for (const from of fromList) {
                    if (from?.trim()) userTermsCache.push({ from: from.trim(), to: term[1] });
                }
            }
        }
        console.log(`✓ Loaded ${userTermsCache.length} user terms`);
        return userTermsCache;
    } catch (e) {
        console.debug("User terms fetch failed:", e.message);
        userTermsCache = [];
        return [];
    }
}

async function fetchStoryTerms(novelId) {
    if (storyTermsCache !== null) return storyTermsCache;
    try {
        const resp = await fetch(`https://wtr-lab.com/api/v2/reader/terms/${novelId}.json`, { credentials: "include" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const glossaries = json?.glossaries || [];
        storyTermsCache = [];
        for (const glossary of glossaries) {
            const terms = glossary?.data?.terms || [];
            for (const term of terms) {
                if (term?.[1]?.trim() && term?.[0]?.[0]?.trim()) {
                    storyTermsCache.push({ from: term[1].trim(), to: term[0][0].trim() });
                }
            }
        }
        console.log(`✓ Loaded ${storyTermsCache.length} story terms`);
        return storyTermsCache;
    } catch (e) {
        console.debug("Story terms fetch failed:", e.message);
        storyTermsCache = [];
        return [];
    }
}

function applyTermReplacements(text, chapterTerms, storyTerms, userTerms, patches) {
    let result = text;
    const termMap = {};
    
    // Chapter terms (placeholder index → replacement)
    if (Array.isArray(chapterTerms)) {
        for (let i = 0; i < chapterTerms.length; i++) {
            const placeholderKey = chapterTerms[i]?.[1];
            const replacement = chapterTerms[i]?.[0];
            if (placeholderKey && replacement) termMap[placeholderKey] = replacement;
        }
    }
    // Story terms override chapter
    for (const term of storyTerms) {
        if (term.from && term.to) termMap[term.from] = term.to;
    }
    // User terms override all
    for (const term of userTerms) {
        if (term.from && term.to) termMap[term.from] = term.to;
    }
    
    // Replace placeholders ※0⛬ with merged terms
    if (Array.isArray(chapterTerms)) {
        for (let i = 0; i < chapterTerms.length; i++) {
            const placeholderKey = chapterTerms[i]?.[1];
            const finalTerm = termMap[placeholderKey] || chapterTerms[i]?.[0];
            if (finalTerm) {
                result = result.replaceAll(`※${i}⛬`, finalTerm);
                result = result.replaceAll(`※${i}〓`, finalTerm);
            }
        }
    }
    // Direct user term replacements
    for (const term of userTerms) {
        if (term.from && term.to) result = result.replaceAll(term.from, term.to);
    }
    // Apply patches
    if (Array.isArray(patches)) {
        for (const patch of patches) {
            if (patch?.zh && patch?.en) result = result.replaceAll(patch.zh, ` ${patch.en}`);
        }
    }
    return result;
}

// --- 4. Fetch Chapter Content (with full term support) ---
async function fetchChapterContent(order) {
    const formData = { translate: "ai", language: leaves[novelIndex - 1], raw_id: id, chapter_no: order };
    const res = await fetch("https://wtr-lab.com/api/reader/get", {
        method: "POST", headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify(formData), credentials: "include"
    });
    let json;
    try { json = await res.json(); } catch { throw new Error("Invalid JSON"); }
    if (!json?.data?.data?.body) throw new Error("Missing body");
    
    // Fetch terms (cached)
    const [userTerms, storyTerms] = await Promise.all([fetchUserTerms(), fetchStoryTerms(id)]);
    const chapterTerms = json?.data?.data?.glossary_data?.terms || [];
    const patches = json?.data?.data?.patch || [];
    
    const tempDiv = document.createElement("div");
    let imgCounter = 0;
    
    json.data.data.body.forEach(el => {
        if (el === "[image]") {
            const src = json.data.data?.images?.[imgCounter++] ?? "";
            if (src) {
                const img = document.createElement("img");
                img.src = src; img.alt = "Chapter image"; img.style.maxWidth = "100%";
                tempDiv.appendChild(img);
            }
        } else {
            const wrapper = document.createElement("div");
            wrapper.innerHTML = el;
            let text = wrapper.textContent || wrapper.innerText || "";
            text = applyTermReplacements(text, chapterTerms, storyTerms, userTerms, patches);
            const pnode = document.createElement("p");
            pnode.textContent = text.trim();
            tempDiv.appendChild(pnode);
        }
    });
    
    const contentText = Array.from(tempDiv.querySelectorAll("p")).map(p => p.textContent).filter(t => t).join("\n").trim();
    return { order, title: json.chapter?.title ?? `Chapter ${order}`, content: contentText };
}

// --- 5. Download Logic ---
const toggleBtnEl = document.getElementById("toggleDownloadBtn");
const progressText = document.getElementById("progressText");
const rangeInput = document.getElementById("rangeInput");

toggleBtnEl.onclick = () => {
    if (isDownloading) stopDownload();
    else { isDownloading = true; stopRequested = false; updateProgressUI(); runDownloadLoop(); }
};

document.getElementById("clearBtn").onclick = () => {
    if(confirm("Clear all downloaded chapters?")) { clearState(); stopDownload(); }
};

document.getElementById("downloadJsonBtn").onclick = () => {
    if (downloadState.chapters.length === 0) { alert("No chapters downloaded yet."); return; }
    const range = rangeInput.value.trim();
    const { start, end } = parseChapterRange(range, downloadState.totalChapters);
    const filename = (start === 1 && end === downloadState.totalChapters) 
        ? `${downloadState.novelTitle}.json` : `${downloadState.novelTitle} ${start}-${end}.json`;
    const blob = new Blob([JSON.stringify(downloadState, null, 2)], { type: 'application/json' });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    if(confirm("Download complete. Clear chapters?")) clearState();
};

document.getElementById("downloadEpubBtn").onclick = () => {
    if (downloadState.chapters.length === 0) { alert("No chapters downloaded yet."); return; }
    const range = rangeInput.value.trim();
    if (range) {
        const { start, end } = parseChapterRange(range, downloadState.totalChapters);
        if (start !== 1 || end !== downloadState.totalChapters)
            document.getElementById("epubTitle").value = `${downloadState.novelTitle} ${start}-${end}`;
    }
    // Auto-fill cover from __NEXT_DATA__ (optional, user can override)
    const currentCover = document.getElementById("epubCover").value.trim();
    if (!currentCover) {
        const autoCover = getCoverFromNextData();
        if (autoCover) document.getElementById("epubCover").value = autoCover;
    }
    epubModal.style.display = "flex";
};

document.getElementById("epubCancel").onclick = () => epubModal.style.display = "none";

document.getElementById("epubConfirm").onclick = async () => {
    epubModal.style.display = "none";
    const userCover = document.getElementById("epubCover").value.trim();
    const metadata = {
        cover: userCover ? getProxyCoverUrl(userCover) : null,
        title: document.getElementById("epubTitle").value.trim() || downloadState.novelTitle,
        author: document.getElementById("epubAuthor").value.trim() || "Unknown",
        description: document.getElementById("epubDesc").value.trim(),
        tags: document.getElementById("epubTags").value.trim().split(',').map(t => t.trim()).filter(t => t)
    };
    const range = rangeInput.value.trim();
    const { start, end } = parseChapterRange(range, downloadState.totalChapters);
    try {
        await generateAndDownloadEpub(metadata, start, end);
        if(confirm("EPUB generated! Clear chapters?")) clearState();
    } catch (err) {
        console.error("EPUB generation failed:", err);
        alert("Failed to generate EPUB: " + err.message);
    }
};

// --- 🎨 Cover: Extract from __NEXT_DATA__ ---
function getCoverFromNextData() {
    try {
        const script = document.querySelector('script#__NEXT_DATA__');
        if (!script?.textContent) return null;
        const json = JSON.parse(script.textContent);
        return json?.props?.pageProps?.serie?.serie_data?.data?.image || null;
    } catch { return null; }
}

// --- 🔗 wsrv.nl CORS Proxy Wrapper ---
function getProxyCoverUrl(userUrl) {
    if (!userUrl) return null;
    return `https://wsrv.nl/?url=${encodeURIComponent(userUrl)}&output=jpg&maxage=7d`;
}

// --- 🖼️ Fetch cover via proxy ---
async function tryEmbedCover(proxyUrl) {
    if (!proxyUrl) return null;
    try {
        const resp = await fetch(proxyUrl, { mode: 'cors', cache: 'force-cache' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        if (blob?.type?.startsWith('image/') && blob.size > 500) {
            console.log(`✓ Cover fetched via wsrv.nl: ${blob.type}, ${blob.size} bytes`);
            return blob;
        }
    } catch (e) { console.debug("wsrv.nl fetch failed:", e.message); }
    return null;
}

// --- Helper: Get file extension ---
function getImageExtension(url, mimeType) {
    if (mimeType?.startsWith('image/')) {
        const map = { 'image/jpeg':'jpg', 'image/jpg':'jpg', 'image/png':'png', 'image/gif':'gif', 'image/webp':'webp' };
        if (map[mimeType]) return map[mimeType];
    }
    try {
        const p = new URL(url).pathname.toLowerCase();
        if (p.endsWith('.jpg')||p.endsWith('.jpeg')) return 'jpg';
        if (p.endsWith('.png')) return 'png';
        if (p.endsWith('.gif')) return 'gif';
        if (p.endsWith('.webp')) return 'webp';
    } catch {}
    return 'jpg';
}

// --- Helper: Sanitize filename - dashes only, NO underscores ---
function sanitizeFilename(str) {
    return str.replace(/[^a-z0-9\-]/gi, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'novel';
}

// --- EPUB Generation ---
async function generateAndDownloadEpub(metadata, startOrder, endOrder) {
    const chapters = downloadState.chapters.filter(c => c.order >= startOrder && c.order <= endOrder).sort((a,b) => a.order - b.order);
    if (chapters.length === 0) throw new Error("No chapters in selected range");
    
    if (typeof JSZip === 'undefined') {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            script.onload = resolve; script.onerror = () => reject(new Error("Failed to load JSZip"));
            document.head.appendChild(script);
        });
    }
    
    const zip = new JSZip();
    const timestamp = new Date().toISOString().split('T')[0];
    const uid = `urn:uuid:${Date.now()}-${Math.random().toString(36).substr(2,9)}`;
    
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
    
    const oebps = zip.folder("OEBPS");
    oebps.file("styles.css", `body{font-family:serif;line-height:1.6;margin:1em}h1.chapter-title{text-align:center;margin:2em 0 1em}img{max-width:100%;height:auto}`);
    
    let manifestItems = '', spineItems = '';
    let coverFilename = null;
    
    if (metadata.cover) {
        if (progressText) progressText.textContent = `Fetching cover via proxy...`;
        const coverBlob = await tryEmbedCover(metadata.cover);
        if (coverBlob) {
            const ext = getImageExtension(metadata.cover, coverBlob.type);
            coverFilename = `cover.${ext}`;
            oebps.file(coverFilename, coverBlob, { binary: true, compression: 'DEFLATE' });
            manifestItems += `<item id="cover-img" href="${coverFilename}" media-type="${coverBlob.type||'image/jpeg'}" properties="cover-image"/>\n`;
        }
    }
    
    const coverContent = coverFilename 
        ? `<div style="margin:0;padding:0;text-align:center;background:#fff"><img src="${coverFilename}" alt="Cover" style="max-width:100%;max-height:100vh;display:block;margin:0 auto"/></div>`
        : `<div style="margin-top:35vh;text-align:center;padding:20px"><h1 style="font-size:1.8em;margin-bottom:0.5em">${escapeXml(metadata.title)}</h1>${metadata.author ? `<p style="font-size:1.2em;color:#555">by ${escapeXml(metadata.author)}</p>` : ''}${metadata.description ? `<p style="margin-top:1.5em;font-style:italic;color:#666">${escapeXml(metadata.description.slice(0,200))}${metadata.description.length>200?'...':''}</p>`:''}</div>`;
    
    oebps.file("cover.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Cover</title><style>body{margin:0;padding:0;text-align:center;background:#fff;font-family:serif}</style></head><body>${coverContent}</body></html>`);
    
    manifestItems += '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n';
    manifestItems += '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n';
    spineItems += '<itemref idref="cover"/>\n';
    
    for (const ch of chapters) {
        const escapedContent = ch.content.split('\n').map(line => escapeXml(line.trim())).filter(line => line).join('</p><p>');
        const xhtml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${escapeXml(ch.title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body><h1 class="chapter-title">${escapeXml(ch.title)}</h1><p>${escapedContent || ' '}</p></body></html>`;
        const filename = `chapter_${String(ch.order).padStart(4, '0')}.xhtml`;
        oebps.file(filename, xhtml);
        manifestItems += `<item id="ch${ch.order}" href="${filename}" media-type="application/xhtml+xml"/>\n`;
        spineItems += `<itemref idref="ch${ch.order}"/>\n`;
    }
    
    const safeTitle = escapeXml(metadata.title), safeAuthor = escapeXml(metadata.author || 'Unknown');
    const safeDesc = metadata.description ? escapeXml(metadata.description) : '';
    const tagsXml = metadata.tags.filter(t => t).map(tag => `<dc:subject>${escapeXml(tag)}</dc:subject>`).join('\n    ');
    
    oebps.file("content.opf", `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${uid}</dc:identifier><dc:title>${safeTitle}</dc:title><dc:creator>${safeAuthor}</dc:creator><dc:language>en</dc:language><dc:date>${timestamp}</dc:date>${safeDesc ? `<dc:description>${safeDesc}</dc:description>` : ''}${tagsXml ? '\n    ' + tagsXml : ''}</metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="styles.css" media-type="text/css"/>${manifestItems}</manifest><spine toc="ncx">${spineItems}</spine></package>`);
    
    const navPoints = chapters.map((ch, idx) => `\n    <navPoint id="navpoint-${idx+1}" playOrder="${idx+1}"><navLabel><text>${escapeXml(ch.title)}</text></navLabel><content src="chapter_${String(ch.order).padStart(4, '0')}.xhtml"/></navPoint>`).join('');
    oebps.file("toc.ncx", `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uid}"/></head><docTitle><text>${safeTitle}</text></docTitle><docAuthor><text>${safeAuthor}</text></docAuthor><navMap>${navPoints}\n  </navMap></ncx>`);
    
    const navItems = chapters.map(ch => `<li><a href="chapter_${String(ch.order).padStart(4, '0')}.xhtml">${escapeXml(ch.title)}</a></li>`).join('\n');
    oebps.file("nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Table of Contents</title></head><body><nav epub:type="toc"><h1>Chapters</h1><ol>${navItems}</ol></nav></body></html>`);
    
    const safeFilename = sanitizeFilename(metadata.title);
    const filename = `${safeFilename}.epub`;
    
    if (progressText) progressText.textContent = `Compressing EPUB...`;
    const blob = await zip.generateAsync({ type: "blob", mimeType: "application/epub+zip", compression: "DEFLATE", compressionOptions: { level: 9 } });
    
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
    if (progressText) progressText.textContent = `✓ EPUB ready!`;
}

// --- Main Download Loop ---
async function runDownloadLoop() {
    const range = rangeInput.value.trim();
    const chaptersToDownload = getChaptersInRange(range);
    const existingOrders = new Set(downloadState.chapters.map(c => c.order));
    const remaining = chaptersToDownload.filter(ch => !existingOrders.has(ch.order));
    
    if (remaining.length === 0) { alert("All chapters in range already downloaded!"); isDownloading = false; updateProgressUI(); return; }
    
    for (const ch of remaining) {
        if (stopRequested || !isDownloading) break;
        if (progressText) progressText.textContent = `Fetching #${ch.order}...`;
        try {
            const data = await fetchChapterContent(ch.order);
            if (!downloadState.chapters.some(c => c.order === data.order)) {
                downloadState.chapters.push(data);
                updateProgressUI();
            }
        } catch (err) {
            if (progressText) progressText.textContent = `Error at #${ch.order}`;
            stopDownload(); alert(`Failed chapter ${ch.order}: ${err.message}`); break;
        }
        await new Promise(r => setTimeout(r, DELAY_MS));
    }
    if (isDownloading && !stopRequested) { alert(`Download Complete! ${downloadState.chapters.length} chapters.`); isDownloading = false; updateProgressUI(); }
}

// Initialize
updateProgressUI();
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

console.log("🔍 WTR Downloader loaded - Full term support, wsrv.nl cover proxy, modal fixed");

})();
