'use strict';
// Writes synthetic sample books. All text is made up here from a fixed seed (no real book text).
// usage: node scripts/make-samples.js <outDir>
// The lighthouse book (EPUB 3) also carries a <script>, an onclick, inline styles, a remote image and a remote
// stylesheet on purpose, so tests and the release check can prove they are blocked.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { zipSync, strToU8 } = require('fflate');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const SUBJ = ['The keeper', 'The tide', 'A gull', 'The lamp', 'Old Brannock', 'The north wind', 'The harbour bell', 'A fishing boat', 'The fog', 'Mara', 'The ferryman', 'The cartographer'];
const VERB = ['watched', 'carried', 'counted', 'remembered', 'circled', 'crossed', 'polished', 'answered', 'followed', 'measured', 'waited for', 'mended'];
const OBJ = ['the long grey water', 'the brass fittings', 'a lantern of salt glass', 'the rocks below the cliff', 'every passing sail', 'the tide tables', 'the slow turn of the light', 'a letter from the mainland', 'the gulls on the rail', 'the narrow stair', 'the shape of the coast', 'the soundings in the logbook'];
const TAIL = ['before the evening came in', 'as the weather turned', 'without a word', 'while the stove ticked', 'until the glass was clear', 'the way it had for forty years', 'under a pale sky', 'and wrote it down', 'twice, to be sure', 'as the boats came home'];
function sentence(r) {
  const p = (a) => a[Math.floor(r() * a.length)];
  return `${p(SUBJ)} ${p(VERB)} ${p(OBJ)} ${p(TAIL)}.`;
}
function para(r, n = 4 + Math.floor(r() * 4)) { return Array.from({ length: n }, () => sentence(r)).join(' '); }

// ---- tiny PNG writer (RGB) ----
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A made-up coastline chart: sea, land with contour bands and a lighthouse dot. */
function chartPng(w = 640, h = 380) {
  return png(w, h, (x, y) => {
    const land = 120 + 60 * Math.sin(x / 47) + 35 * Math.sin(x / 13 + 1) + 20 * Math.cos(y / 29);
    const d = Math.hypot(x - 455, y - 150);
    if (d < 9) return [230, 70, 60];
    if (d < 14) return [250, 240, 200];
    if (y < land) { const band = Math.floor((land - y) / 22) % 2; return band ? [196, 178, 128] : [176, 160, 112]; }
    const depth = Math.min(1, (y - land) / 200);
    return [Math.round(150 - 90 * depth), Math.round(196 - 90 * depth), Math.round(214 - 60 * depth)];
  });
}
function coverPng(w = 600, h = 900) {
  return png(w, h, (x, y) => {
    if (Math.abs(x - 300) < 22 && y > 300 && y < 720) return y < 340 ? [250, 220, 120] : (Math.floor(y / 60) % 2 ? [210, 60, 50] : [240, 240, 235]);
    if (y > 720) return [70, 90, 80];
    const t = y / h; return [Math.round(30 + 40 * t), Math.round(50 + 50 * t), Math.round(90 + 60 * t)];
  });
}
const coverSvg = (title, author) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2b4a"/><stop offset="1" stop-color="#3f6a8a"/></linearGradient></defs>
<rect width="600" height="900" fill="url(#g)"/>
<rect x="278" y="330" width="44" height="400" fill="#efece4"/><rect x="278" y="420" width="44" height="40" fill="#c8463c"/><rect x="278" y="540" width="44" height="40" fill="#c8463c"/>
<polygon points="262,330 338,330 300,290" fill="#2a2f3a"/><circle cx="300" cy="312" r="12" fill="#ffd877"/>
<polygon points="300,312 600,250 600,370" fill="#ffd877" opacity="0.25"/>
<rect y="730" width="600" height="170" fill="#28403a"/>
<text x="300" y="140" font-family="Georgia, serif" font-size="46" fill="#f4efe3" text-anchor="middle">${title}</text>
<text x="300" y="200" font-family="Georgia, serif" font-size="26" fill="#cfd8e3" text-anchor="middle">${author}</text>
</svg>`;

function isbn13(first12) {
  const d = first12.split('').map(Number);
  const s = d.reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0);
  return first12 + ((10 - (s % 10)) % 10);
}

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function xhtml(title, body, { epub3 = true, head = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"${epub3 ? ' xmlns:epub="http://www.idpf.org/2007/ops"' : ''} xml:lang="en" lang="en">
<head><meta charset="UTF-8"/><title>${title}</title><link rel="stylesheet" type="text/css" href="styles.css"/>${head}</head>
<body>
${body}
</body>
</html>`;
}

function zip(files) {
  // mimetype first and stored, as the EPUB spec asks.
  const entries = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  for (const [k, v] of Object.entries(files)) entries[k] = [typeof v === 'string' ? strToU8(v) : new Uint8Array(v), { level: /\.(png|jpe?g)$/.test(k) ? 0 : 6 }];
  return zipSync(entries);
}

const ISBN = isbn13('978000000000'); // a made-up ISBN with a valid check digit

/** EPUB 3: nested nav, footnote asides, a chart image, a table, MathML, an internal link and planted unsafe content. */
function lighthouse() {
  const r = rng(7);
  const ch = [];
  const notes = [
    'A fathom is six feet. The keepers sounded the channel with a lead line marked in fathoms.',
    'The lamp burned colza oil until the station changed to paraffin in the second winter.',
    'Spring tides follow the new and the full moon. Neap tides follow the quarter moons.',
    'The logbook used a cross for fog and a circle for a clear night.',
  ];
  const chapters = [
    { id: 'ch1', title: 'Chapter 1. The Station', part: 1 },
    { id: 'ch2', title: 'Chapter 2. Lamp Oil', part: 1 },
    { id: 'ch3', title: 'Chapter 3. Soundings', part: 2, sections: ['Charts', 'The Tide Table'] },
    { id: 'ch4', title: 'Chapter 4. Fog', part: 2 },
    { id: 'ch5', title: 'Chapter 5. Letters', part: 3 },
    { id: 'ch6', title: 'Chapter 6. The Last Watch', part: 3 },
  ];
  for (const [n, c] of chapters.entries()) {
    let b = `<section epub:type="chapter" id="${c.id}-top">\n<h1>${c.title}</h1>\n`;
    b += `<p>${para(r)} <a epub:type="noteref" href="#fn${n + 1}" id="ref${n + 1}">${n + 1}</a></p>\n`;
    for (let k = 0; k < 7; k++) b += `<p>${para(r)}</p>\n`;
    if (n === 0) {
      b += '<p onclick="alert(1)" style="color:red">This paragraph had an onclick handler and an inline style. Both are removed.</p>\n';
      b += '<script>document.body.innerHTML = "script ran";</script>\n';
      b += '<p>A remote picture follows. It is never loaded: <img src="https://example.com/tracker.png" alt="remote tracker"/></p>\n';
      b += '<p>The station was built from <em>local granite</em> and <strong>imported brass</strong>. See <a href="ch5.xhtml#letter-3">the third letter</a> or the <a href="https://example.org/lighthouses">lighthouse list</a>.</p>\n';
      b += '<blockquote><p>Keep the glass clean and the wick trimmed, and the light will keep the ships.</p></blockquote>\n';
      b += '<ul><li>Trim the wick at dusk.</li><li>Wind the clockwork every four hours.</li><li>Write the weather in the log.</li></ul>\n';
    }
    if (n === 2) {
      b += `<h2 id="charts">Charts</h2>\n<figure><img src="images/chart.png" alt="Chart of the north coast" width="640" height="380"/><figcaption>Figure 1. The north coast with the station light.</figcaption></figure>\n`;
      for (let k = 0; k < 3; k++) b += `<p>${para(r)}</p>\n`;
      b += '<h2 id="tide-table">The Tide Table</h2>\n<table><thead><tr><th>Day</th><th>High water</th><th>Low water</th><th>Range (m)</th></tr></thead><tbody>';
      for (let d = 1; d <= 7; d++) b += `<tr><td>${d}</td><td>0${(d + 3) % 10}:${10 + d * 6}</td><td>${(d + 9) % 24}:${(d * 7) % 60 < 10 ? '0' : ''}${(d * 7) % 60}</td><td>${(3.1 + d * 0.2).toFixed(1)}</td></tr>`;
      b += '</tbody></table>\n';
      b += '<p>The height of the tide at hour <i>t</i> was worked out as <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>h</mi><mo>=</mo><mi>A</mi><mo>&#x2062;</mo><mi>cos</mi><mo>(</mo><mfrac><mrow><mn>2</mn><mi>&#x3c0;</mi><mi>t</mi></mrow><mn>12.42</mn></mfrac><mo>)</mo></math>, which was close enough for the keepers.</p>\n';
    }
    if (n === 4) b += `<h2 id="letter-3">The Third Letter</h2>\n<p>${para(r)}</p>\n`;
    b += `<aside epub:type="footnote" id="fn${n + 1}"><p><a href="#ref${n + 1}">${n + 1}.</a> ${notes[n % notes.length]}</p></aside>\n`;
    b += '</section>';
    ch.push({ ...c, file: `${c.id}.xhtml`, xhtml: xhtml(c.title, b) });
  }
  const cover = xhtml('Cover', '<div class="cover"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" viewBox="0 0 600 900"><image width="600" height="900" xlink:href="images/cover.svg"/></svg></div>');
  const li = (c) => `<li><a href="${c.file}">${c.title}</a>${c.sections ? `<ol>${c.sections.map((s) => `<li><a href="${c.file}#${s === 'Charts' ? 'charts' : 'tide-table'}">${s}</a></li>`).join('')}</ol>` : ''}</li>`;
  const parts = ['Part One. Arrival', 'Part Two. The Sea', 'Part Three. Leaving'];
  const nav = xhtml('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${parts.map((p, i) => `<li><span>${p}</span><ol>${ch.filter((c) => c.part === i + 1).map(li).join('')}</ol></li>`).join('\n')}
</ol></nav>
<nav epub:type="landmarks" hidden=""><ol><li><a epub:type="bodymatter" href="ch1.xhtml">Start</a></li></ol></nav>`);
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="pub-id">urn:isbn:${ISBN}</dc:identifier>
  <dc:title id="t1">The Lighthouse Keeper's Log</dc:title>
  <meta refines="#t1" property="title-type">main</meta>
  <dc:title id="t2">A Year on the North Coast</dc:title>
  <meta refines="#t2" property="title-type">subtitle</meta>
  <dc:creator id="c1">Mara Ellison</dc:creator>
  <meta refines="#c1" property="role" scheme="marc:relators">aut</meta>
  <dc:creator id="c2">Tomas Reed</dc:creator>
  <meta refines="#c2" property="role" scheme="marc:relators">ill</meta>
  <dc:language>en</dc:language>
  <dc:publisher>Zovo Sample Press</dc:publisher>
  <dc:date>2026-11-06</dc:date>
  <dc:description>&lt;p&gt;A made-up keeper's year on a made-up coast. Sample text for EPUB Reader.&lt;/p&gt;</dc:description>
  <dc:subject>Sample books</dc:subject>
  <meta property="dcterms:modified">2026-11-06T12:00:00Z</meta>
</metadata>
<manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml" properties="svg"/>
  <item id="cover-img" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>
  <item id="chart" href="images/chart.png" media-type="image/png"/>
  <item id="css" href="styles.css" media-type="text/css"/>
${ch.map((c) => `  <item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"${c.id === 'ch1' ? ' properties="scripted remote-resources"' : ''}/>`).join('\n')}
</manifest>
<spine>
  <itemref idref="cover-page" linear="yes"/>
${ch.map((c) => `  <itemref idref="${c.id}"/>`).join('\n')}
</spine>
</package>`;
  const files = {
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/nav.xhtml': nav,
    'OEBPS/cover.xhtml': cover,
    'OEBPS/styles.css': '@import url("https://example.com/remote.css");\nbody { font-family: serif; }\n',
    'OEBPS/images/cover.svg': coverSvg('The Lighthouse Keeper’s Log', 'Mara Ellison'),
    'OEBPS/images/chart.png': chartPng(),
  };
  for (const c of ch) files[`OEBPS/${c.file}`] = c.xhtml;
  return zip(files);
}

/** EPUB 2: NCX table of contents, endnotes in their own file, a Latin-1 chapter, a PNG cover, a non-linear item. */
function fieldNotes() {
  const r = rng(11);
  const chapters = ['Marsh Birds', 'Lichens on the Wall', 'Night Moths', 'The Weather Diary'];
  const files = {};
  const notes = [];
  chapters.forEach((t, i) => {
    let b = `<h1 id="top">${i + 1}. ${t}</h1>\n`;
    for (let k = 0; k < 9; k++) {
      let p = para(r);
      if (k === 2) { const n = notes.length + 1; notes.push({ n, ch: i, text: `Note ${n}. ${sentence(r)} The count was made at first light.` }); p += ` <a href="notes.html#n${n}" id="r${n}"><sup>${n}</sup></a>`; }
      b += `<p>${p}</p>\n`;
    }
    if (i === 1) b += '<h2 id="list">Species seen</h2>\n<ol start="3"><li>Crustose lichen on the north wall</li><li>Foliose lichen on the gate</li><li>Moss in the gutter</li></ol>\n<pre>\nwall  north  42 cm2\ngate  east   17 cm2\n</pre>\n';
    if (i === 2) b += '<p>Café notes, written on the naïve old typewriter: été, garçon, über.</p>\n';
    const doc = xhtml(t, b, { epub3: false });
    files[`OEBPS/chapter${i + 1}.html`] = i === 2 ? Buffer.from(doc.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace('<meta charset="UTF-8"/>', ''), 'latin1') : doc;
  });
  files['OEBPS/notes.html'] = xhtml('Notes', '<h1>Notes</h1>\n' + notes.map((n) => `<p id="n${n.n}"><a href="chapter${n.ch + 1}.html#r${n.n}">${n.n}.</a> ${n.text}</p>`).join('\n'), { epub3: false });
  files['OEBPS/about.html'] = xhtml('About this sample', '<h1>About this sample</h1><p>This page is outside the reading order (linear="no").</p>', { epub3: false });
  const nav = chapters.map((t, i) => `<navPoint id="np${i + 1}" playOrder="${i + 2}"><navLabel><text>${i + 1}. ${t}</text></navLabel><content src="chapter${i + 1}.html"/>${i === 1 ? '<navPoint id="np2a" playOrder="99"><navLabel><text>Species seen</text></navLabel><content src="chapter2.html#list"/></navPoint>' : ''}</navPoint>`).join('\n');
  files['OEBPS/toc.ncx'] = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="isbn-0306406152"/></head>
<docTitle><text>Field Notes from a Small Garden</text></docTitle>
<navMap>
<navPoint id="np0" playOrder="1"><navLabel><text>Cover</text></navLabel><content src="cover.html"/></navPoint>
${nav}
<navPoint id="npn" playOrder="${chapters.length + 2}"><navLabel><text>Notes</text></navLabel><content src="notes.html"/></navPoint>
</navMap></ncx>`;
  files['OEBPS/cover.html'] = xhtml('Cover', '<div><img src="images/cover.png" alt="Cover"/></div>', { epub3: false });
  files['OEBPS/images/cover.png'] = coverPng();
  files['OEBPS/content.opf'] = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
  <dc:title>Field Notes from a Small Garden</dc:title>
  <dc:creator opf:role="aut" opf:file-as="Okafor, June">June Okafor</dc:creator>
  <dc:language>en-GB</dc:language>
  <dc:identifier id="BookId" opf:scheme="ISBN">0-306-40615-2</dc:identifier>
  <dc:publisher>Zovo Sample Press</dc:publisher>
  <dc:date>2025-04-01</dc:date>
  <meta name="cover" content="cover-image"/>
</metadata>
<manifest>
  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  <item id="cover" href="cover.html" media-type="application/xhtml+xml"/>
  <item id="cover-image" href="images/cover.png" media-type="image/png"/>
${chapters.map((_, i) => `  <item id="c${i + 1}" href="chapter${i + 1}.html" media-type="application/xhtml+xml"/>`).join('\n')}
  <item id="notes" href="notes.html" media-type="application/xhtml+xml"/>
  <item id="about" href="about.html" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx">
  <itemref idref="cover"/>
${chapters.map((_, i) => `  <itemref idref="c${i + 1}"/>`).join('\n')}
  <itemref idref="notes"/>
  <itemref idref="about" linear="no"/>
</spine>
</package>`;
  files['META-INF/container.xml'] = CONTAINER;
  return zip(files);
}

/** A long book for speed checks: n chapters of m paragraphs with a chart every 10 chapters. */
function atlas(n = 200, m = 60) {
  const r = rng(3);
  const files = { 'META-INF/container.xml': CONTAINER, 'OEBPS/images/chart.png': chartPng() };
  const items = [];
  for (let i = 1; i <= n; i++) {
    let b = `<h1>Chapter ${i}</h1>\n`;
    for (let k = 0; k < m; k++) b += `<p>${para(r)}</p>\n`;
    if (i % 10 === 0) b += '<p><img src="images/chart.png" alt="Chart"/></p>';
    files[`OEBPS/c${i}.xhtml`] = xhtml(`Chapter ${i}`, b);
    items.push(i);
  }
  files['OEBPS/nav.xhtml'] = xhtml('Contents', `<nav epub:type="toc"><ol>${items.map((i) => `<li><a href="c${i}.xhtml">Chapter ${i}</a></li>`).join('')}</ol></nav>`);
  files['OEBPS/content.opf'] = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:uuid:00000000-0000-4000-8000-000000000001</dc:identifier><dc:title>The Long Atlas</dc:title><dc:creator>Sample Author</dc:creator><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="img" href="images/chart.png" media-type="image/png"/>
${items.map((i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest>
<spine>${items.map((i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`;
  return zip(files);
}

const SAMPLES = { 'the-lighthouse-keepers-log.epub': lighthouse, 'field-notes-epub2.epub': fieldNotes };

if (require.main === module) {
  const out = path.resolve(process.argv[2] || 'samples');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, fn] of Object.entries(SAMPLES)) {
    const b = fn();
    if (b.length > 5 * 1024 * 1024) throw new Error(`${name} is over 5 MB`);
    fs.writeFileSync(path.join(out, name), b);
    console.log(name, b.length, 'bytes');
  }
}

module.exports = { lighthouse, fieldNotes, atlas, chartPng, coverPng, isbn13, ISBN, SAMPLES, zip, xhtml, CONTAINER };
