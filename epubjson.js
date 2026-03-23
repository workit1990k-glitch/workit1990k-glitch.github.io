class EpubGenerator {
  constructor(novelData) {
    this.novelData = novelData;
    this.workerUrl = 'https://curly-pond-9050.yuush.workers.dev';
  }

  async generate(logCallback = console.log) {
    const log = msg => logCallback(msg);
    const zip = new JSZip();

    // Escape helpers
    function escapeXML(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    }

    // UPDATED: safer HTML escaping for EPUB XML
    function escapeHTMLContent(str) {
      if (!str) return '';

      const htmlEntities = {
        '&nbsp;': '&#160;', '&iexcl;': '&#161;', '&cent;': '&#162;', '&pound;': '&#163;',
        '&curren;': '&#164;', '&yen;': '&#165;', '&brvbar;': '&#166;', '&sect;': '&#167;',
        '&uml;': '&#168;', '&copy;': '&#169;', '&ordf;': '&#170;', '&laquo;': '&#171;',
        '&not;': '&#172;', '&shy;': '&#173;', '&reg;': '&#174;', '&macr;': '&#175;',
        '&deg;': '&#176;', '&plusmn;': '&#177;', '&sup2;': '&#178;', '&sup3;': '&#179;',
        '&acute;': '&#180;', '&micro;': '&#181;', '&para;': '&#182;', '&middot;': '&#183;',
        '&cedil;': '&#184;', '&sup1;': '&#185;', '&ordm;': '&#186;', '&raquo;': '&#187;',
        '&frac14;': '&#188;', '&frac12;': '&#189;', '&frac34;': '&#190;', '&iquest;': '&#191;',
        '&times;': '&#215;', '&divide;': '&#247;', '&ndash;': '&#8211;', '&mdash;': '&#8212;',
        '&lsquo;': '&#8216;', '&rsquo;': '&#8217;', '&ldquo;': '&#8220;', '&rdquo;': '&#8221;',
        '&bull;': '&#8226;', '&hellip;': '&#8230;', '&trade;': '&#8482;', '&euro;': '&#8364;',
        '&emsp;': '&#8195;', '&ensp;': '&#8194;', '&thinsp;': '&#8201;',
      };

      return String(str)
        .replace(/&[a-z0-9]+;/gi, match => htmlEntities[match.toLowerCase()] || match)
        .replace(/&(?![a-z0-9#]+;)/gi, '&amp;')
        .replace(/<br\s*>/gi, '<br />')
        .replace(/<hr\s*>/gi, '<hr />');
    }

    function getImageExtension(url) {
      const match = url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i);
      return match ? '.' + match[1].toLowerCase() : '.jpg';
    }

    /* 1. mimetype */
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    /* 2. META-INF */
    const meta = zip.folder('META-INF');
    meta.file('container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    const oebps = zip.folder('OEBPS');
    const toc = [];

    /* 3. cover image */
    let coverFileName = '';
    if (this.novelData.metadata.cover) {
      try {
        const res = await fetch(`${this.workerUrl}/api/raw?url=${encodeURIComponent(this.novelData.metadata.cover)}`);
        if (!res.ok) throw new Error('cover fetch failed');
        const blob = await res.blob();
        coverFileName = 'cover.jpg';
        oebps.file(coverFileName, blob, { compression: 'DEFLATE' });
      } catch (e) {
        log('Cover skipped: ' + e.message);
      }
    }

    /* 3b. other works images */
    if (Array.isArray(this.novelData.metadata.otherworks)) {
      for (let i = 0; i < this.novelData.metadata.otherworks.length; i++) {
        const work = this.novelData.metadata.otherworks[i];
        if (work.cover) {
          try {
            const imgRes = await fetch(`${this.workerUrl}/api/raw?url=${encodeURIComponent(work.cover)}`);
            if (!imgRes.ok) throw new Error(`cover fetch failed for ${work.title}`);
            const imgBlob = await imgRes.blob();
            const imgFileName = `images/otherwork_${i}${getImageExtension(work.cover)}`;
            oebps.file(imgFileName, imgBlob, { compression: 'DEFLATE' });
            this.novelData.metadata.otherworks[i].cover = imgFileName;
          } catch (err) {
            log(`Other works image skipped for ${work.title}: ${err.message}`);
          }
        }
      }
    }

    /* 3c. cover page */
    if (coverFileName) {
      const coverPage = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXML(this.novelData.metadata.title)}</title><meta charset="utf-8"/></head>
<body style="margin:0; text-align:center;">
  <img style="height:auto;width:100%;border-radius:5px;" src="${escapeXML(coverFileName)}" alt="Cover"/>
  <h1>${escapeXML(this.novelData.metadata.title)}</h1>
  <p><strong>Author:</strong> ${this.novelData.metadata.author}</p>
</body></html>`;
      oebps.file('cover.xhtml', coverPage);
      toc.push({ id: 'cover-page', href: 'cover.xhtml', title: 'Cover', isCover: true });
    }

    /* 4. Information page */
    const infoPage = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Information</title><meta charset="utf-8"/></head>
<body>
  <h1>${escapeXML(this.novelData.metadata.title)}</h1>
  <p><strong>Author:</strong> ${this.novelData.metadata.author}</p>
  <p><strong>Status:</strong> ${escapeXML(this.novelData.metadata.status)}</p>
  ${this.novelData.metadata.altitile ? `<p><strong>Alternative Title:</strong> ${
    Array.isArray(this.novelData.metadata.altitile)
      ? this.novelData.metadata.altitile.map(escapeHTMLContent).join(', ') // UPDATED
      : escapeHTMLContent(this.novelData.metadata.altitile) // UPDATED
  }</p>` : ''}
  ${this.novelData.metadata.date ? `<p><strong>Year:</strong> ${escapeXML(this.novelData.metadata.date)}</p>` : ''}
  ${this.novelData.metadata.language ? `<p><strong>Original Language:</strong> ${escapeXML(this.novelData.metadata.language)}</p>` : ''}
  ${this.novelData.metadata.originalPublisher ? `<p><strong>Original Publisher:</strong> ${escapeXML(this.novelData.metadata.originalPublisher)}</p>` : ''}
  ${this.novelData.metadata.statuscoo ? `<p><strong>Original Status:</strong> ${escapeXML(this.novelData.metadata.statuscoo)}</p>` : ''}
  ${this.novelData.metadata.genres.length ? `<p><strong>Genres:</strong> ${this.novelData.metadata.genres.map(escapeHTMLContent).join(', ')}</p>` : ''} 
  ${this.novelData.metadata.totalChapters ? `<p><strong>Chapters:</strong> ${escapeXML(this.novelData.metadata.totalChapters)}</p>` : ''}

  <h3>Description</h3>
  <p>${escapeHTMLContent(this.novelData.metadata.description)}</p>

${Array.isArray(this.novelData.metadata.otherworks) && this.novelData.metadata.otherworks.length ? `
  <h3>Other Works by ${this.novelData.metadata.author}</h3>
  <ul style="list-style-type: none; padding-left: 0;">
    ${this.novelData.metadata.otherworks.map((work, index) => `
      <li>
        <div style="display: flex; align-items: flex-start;flex-direction:column;">
          ${work.cover 
            ? `<img src="${escapeXML(work.cover)}" alt="${escapeHTMLContent(work.title)}" style="margin-right: 15px;" />` // UPDATED
            : '<div style="margin-right: 15px;"></div>'}
          <div>
            <strong>${escapeHTMLContent(work.title)}</strong><br /> <!-- UPDATED -->
            ${work.genres && work.genres.length ? `<em>${work.genres.map(escapeHTMLContent).join(', ')}</em>` : ''} <!-- UPDATED -->
          </div>
        </div>
        ${work.description 
          ? `<div style="margin-top: 10px;">${escapeHTMLContent(work.description)}</div>` // UPDATED
          : ''}
      </li>
      ${index < this.novelData.metadata.otherworks.length - 1 
        ? '<hr style="width: 80%; margin: 10px auto; border: 0; border-top: 1px solid #eee;" />' 
        : ''}
    `).join('')}
  </ul>
` : ''}
</body>
</html>`;

    oebps.file('info.xhtml', infoPage);
    toc.push({ id: 'info-page', href: 'info.xhtml', title: 'Information' });

    /* 5. Chapters */
    log('Processing chapters for EPUB...');
    this.novelData.chapters.forEach((ch, idx) => {
      const file = `chap${idx + 1}.xhtml`;
      const processedContent = escapeHTMLContent(ch.content || 'Content not found.'); // UPDATED

      const html = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${escapeHTMLContent(ch.title)}</title> <!-- UPDATED -->
  <meta charset="utf-8"/>
</head>
<body>
  <h1>${escapeHTMLContent(ch.title)}</h1> <!-- UPDATED -->
  ${processedContent}
</body>
</html>`;
      oebps.file(file, html);
      toc.push({ id: `ch-${idx + 1}`, href: file, title: escapeHTMLContent(ch.title) }); // UPDATED
    });

    /* 5a. TOC page */
    const tocPage = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Table of Contents</title>
  <meta charset="utf-8"/>
  <style type="text/css">
    body { font-family: sans-serif; line-height: 1.5; }
    h1 { text-align: center; }
    li { margin: 0.5em 0; }
  </style>
</head>
<body>
  <h1>Table of Contents</h1>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="cover.xhtml">Cover</a></li>
      <li><a href="info.xhtml">Information</a></li>
      <li><a href="toc.xhtml">Table of Contents</a></li>
      ${this.novelData.chapters.map((ch, idx) => 
        `<li><a href="chap${idx + 1}.xhtml">${escapeHTMLContent(ch.title)}</a></li>` // UPDATED
      ).join('\n      ')}
    </ol>
  </nav>
</body>
</html>`;

    oebps.file('toc.xhtml', tocPage);
    toc.push({ id: 'toc-page', href: 'toc.xhtml', title: 'Table of Contents' });

    /* 7. NCX */
    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${'urn:uuid:' + Date.now()}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeHTMLContent(this.novelData.metadata.title)}</text></docTitle> <!-- UPDATED -->
  <navMap>
    ${toc.map((t, i) => `<navPoint id="${escapeXML(t.id)}" playOrder="${i + 1}">
      <navLabel><text>${escapeHTMLContent(t.title)}</text></navLabel> <!-- UPDATED -->
      <content src="${escapeXML(t.href)}"/>
    </navPoint>`).join('\n  ')}
  </navMap>
</ncx>`;
    oebps.file('toc.ncx', ncx);

    /* 6. OPF */
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${escapeHTMLContent(this.novelData.metadata.title)}</dc:title> <!-- UPDATED -->
    <dc:creator>${this.novelData.metadata.author}</dc:creator> <!-- UPDATED -->
    <dc:language>en</dc:language>
${this.novelData.metadata.genres.map(genre => `<dc:subject>${escapeHTMLContent(genre)}</dc:subject>`).join('\n')}
<dc:identifier id="BookId">urn:uuid:${crypto.randomUUID()}</dc:identifier>
    <dc:description>${escapeHTMLContent(this.novelData.metadata.description || '')}</dc:description> <!-- UPDATED -->
      <meta property="dcterms:modified">${new Date().toISOString()}</meta>
    <meta property="nav">toc.xhtml</meta>
    ${coverFileName ? '<meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    <item id="nav" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav-page" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  ${coverFileName ? `<item id="cover-image" href="${escapeXML(coverFileName)}" media-type="image/jpg"/>` : ''}
  <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>
  ${toc.map(t => `<item id="${escapeXML(t.id)}" href="${escapeXML(t.href)}" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine toc="nav">
    <itemref idref="cover-page"/>
    <itemref idref="info-page"/>
    <itemref idref="toc-page"/>    
  ${toc.map(t => `<itemref idref="${escapeXML(t.id)}"/>`).join('\n    ')}
  </spine>
</package>`;
    oebps.file('content.opf', opf);

    /* 8. Generate EPUB file */
    log('Generating EPUB file, please wait...');
    return await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/epub+zip',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });
  }

  async download(logCallback = console.log) {
    const blob = await this.generate(logCallback);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${this.novelData.metadata.title.replace(/[^a-z0-9]/gi, '_')}.epub`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    logCallback('EPUB download initiated!');
  }
} 
