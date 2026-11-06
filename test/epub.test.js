'use strict';
// Parsers: ZIP, XML, the EPUB package, the sanitizer, Markdown export and the Book on the generated samples.
const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('fflate');
const Z = require('../src/core/zip');
const X = require('../src/core/xml');
const E = require('../src/core/epub');
const S = require('../src/core/sanitize');
const { Book, fold } = require('../src/core/book');
const M = require('../scripts/make-samples.js');

const open = (u8) => Book.open(Z.bufferSource(u8));
const san = (body, extra = {}) => S.sanitize(`<html><body>${body}</body></html>`, { path: 'OEBPS/ch1.xhtml', self: 1, spineIndex: (p) => ({ 'OEBPS/ch2.xhtml': 2, 'OEBPS/notes.xhtml': 5 }[p] ?? -1), ...extra });
const html = (body) => S.toHtml(san(body).tree, (p) => `data:image/png;base64,AAAA#${p}`);

test('zip: stored and deflated entries, case-insensitive lookup, damaged and non-zip input', async () => {
  const z = zipSync({ 'a.txt': [strToU8('hello'), { level: 0 }], 'Dir/B.xhtml': [strToU8('x'.repeat(5000)), { level: 9 }] });
  const r = await Z.ZipReader.open(Z.bufferSource(z));
  assert.equal(await r.text('a.txt'), 'hello');
  assert.equal((await r.read('dir/b.xhtml')).length, 5000);
  await assert.rejects(r.read('nope'), /no file named/);
  await assert.rejects(Z.ZipReader.open(Z.bufferSource(strToU8('not a zip at all, just some text'))), /not a ZIP archive/);
  await assert.rejects(Z.ZipReader.open(Z.bufferSource(new Uint8Array(5))), /too small/);
  const bad = Uint8Array.from(z); const cd = bad.length - 22; bad[cd + 16] = 0xff; bad[cd + 17] = 0xff; bad[cd + 18] = 0x00;
  await assert.rejects(Z.ZipReader.open(Z.bufferSource(bad)), /damaged/);
});

test('zip: an entry that inflates past its declared size is cut at the declared size (zip bomb guard)', async () => {
  const z = Uint8Array.from(zipSync({ 'big.txt': [new Uint8Array(1e6).fill(65), { level: 9 }] }));
  // Lie about the uncompressed size in the central directory: 1 MB -> 1000 bytes.
  const dv = new DataView(z.buffer);
  for (let i = z.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint32(i + 24, 1000, true); break; }
  const r = await Z.ZipReader.open(Z.bufferSource(z));
  assert.equal((await r.read('big.txt')).length, 1000);
  await assert.rejects(r.read('big.txt', 500), /over the limit/);
});

test('zip: text decoding honors UTF-16 BOMs and an ISO-8859-1 declaration', () => {
  assert.equal(Z.decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0, 0x42, 0])), 'AB');
  assert.equal(Z.decodeText(Uint8Array.from(Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><p>caf\xe9</p>', 'latin1'))), '<?xml version="1.0" encoding="ISO-8859-1"?><p>café</p>');
  assert.equal(Z.decodeText(Uint8Array.from(Buffer.from('﻿<p>é</p>'))), '<p>é</p>');
});

test('xml: entities, CDATA, comments, unclosed and stray tags, quoted > in attributes', () => {
  const t = X.parse('<!DOCTYPE html><!-- c --><p title="a > b" class=x>Fish &amp; chips &eacute;t&eacute; &#x2014; &#8212; &unknown; <![CDATA[<raw>]]><b>bold</p></i><img src="a.png">tail');
  const p = X.find(t, 'p');
  assert.equal(p.attrs.title, 'a > b');
  assert.equal(p.attrs.class, 'x');
  assert.equal(X.textOf(p), 'Fish & chips été — — &unknown; <raw>bold');
  assert.equal(X.find(t, 'img').attrs.src, 'a.png');
  assert.equal(X.decodeEntities('&#0; &#xD800; &#x1F600;'), '� � 😀');
  // In XML mode <meta> keeps its text (OPF refines), in HTML mode it is a void element.
  assert.equal(X.textOf(X.find(X.parse('<meta property="role">aut</meta>', { xml: true }), 'meta')), 'aut');
  assert.equal(X.textOf(X.find(X.parse('<meta charset="x">aut'), 'meta')), '');
});

test('epub: hrefs resolve against the referring file, with fragments and %-escapes', () => {
  assert.deepEqual(E.resolveHref('OEBPS/text/ch1.xhtml', '../images/a%20b.png'), { path: 'OEBPS/images/a b.png', frag: '' });
  assert.deepEqual(E.resolveHref('OEBPS/ch1.xhtml', '#n1'), { path: 'OEBPS/ch1.xhtml', frag: 'n1' });
  assert.deepEqual(E.resolveHref('OEBPS/ch1.xhtml', 'ch2.xhtml#sec-2'), { path: 'OEBPS/ch2.xhtml', frag: 'sec-2' });
  assert.deepEqual(E.resolveHref('content.opf', 'ch1.xhtml'), { path: 'ch1.xhtml', frag: '' });
  assert.ok(E.isRemote('https://x.org/a.png') && E.isRemote('//cdn/x.js') && E.isRemote('javascript:alert(1)') && !E.isRemote('images/a.png'));
});

test('epub: ISBN from scheme, urn:isbn:, a bare 13 or 10 digit identifier, or an EPUB 3 identifier-type', () => {
  const opf = (ids, extra = '') => `<package version="3.0" unique-identifier="u"><metadata>${ids}${extra}<dc:title>T</dc:title></metadata><manifest/><spine/></package>`;
  assert.equal(E.parseOpf(opf('<dc:identifier id="u" opf:scheme="ISBN">0-306-40615-2</dc:identifier>'), 'c.opf').meta.isbn, '0-306-40615-2');
  assert.equal(E.parseOpf(opf('<dc:identifier id="u">urn:isbn:9780000000002</dc:identifier>'), 'c.opf').meta.isbn, '9780000000002');
  assert.equal(E.parseOpf(opf('<dc:identifier id="u">urn:uuid:1</dc:identifier><dc:identifier>978-1-4028-9462-6</dc:identifier>'), 'c.opf').meta.isbn, '978-1-4028-9462-6');
  assert.equal(E.parseOpf(opf('<dc:identifier id="u">urn:uuid:1</dc:identifier><dc:identifier id="i2">12345</dc:identifier>', '<meta refines="#i2" property="identifier-type" scheme="onix:codelist5">15</meta>'), 'c.opf').meta.isbn, '12345');
  assert.equal(E.parseOpf(opf('<dc:identifier id="u">urn:uuid:1</dc:identifier>'), 'c.opf').meta.isbn, '');
});

test('epub: DRM is detected from encryption.xml, while font obfuscation is not DRM', () => {
  const enc = (alg, uri) => `<encryption><EncryptedData><EncryptionMethod Algorithm="${alg}"/><CipherData><CipherReference URI="${uri}"/></CipherData></EncryptedData></encryption>`;
  assert.deepEqual(E.drmFiles(enc('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'OEBPS/ch1.xhtml')), ['OEBPS/ch1.xhtml']);
  assert.deepEqual(E.drmFiles(enc('http://www.idpf.org/2008/embedding', 'OEBPS/fonts/a.otf')), []);
  assert.deepEqual(E.drmFiles(enc('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'OEBPS/fonts/a.woff')), []);
});

test('sample EPUB 3: metadata, nested nav, spine titles and cover', async () => {
  const b = await open(M.lighthouse());
  const i = b.info();
  assert.equal(i.version, '3.0');
  assert.equal(i.tocSource, 'nav');
  assert.equal(i.meta.title, "The Lighthouse Keeper's Log");
  assert.equal(i.meta.subtitle, 'A Year on the North Coast');
  assert.deepEqual(i.meta.authors, ['Mara Ellison']);
  assert.deepEqual(i.meta.contributors, ['Tomas Reed (ill)']);
  assert.equal(i.meta.language, 'en');
  assert.equal(i.meta.isbn, M.ISBN);
  assert.equal(i.meta.publisher, 'Zovo Sample Press');
  assert.equal(i.meta.description, "A made-up keeper's year on a made-up coast. Sample text for EPUB Reader.");
  assert.equal(i.spine.length, 7);
  assert.deepEqual(i.toc.map((e) => [e.label, e.index]), [['Part One. Arrival', -1], ['Part Two. The Sea', -1], ['Part Three. Leaving', -1]]);
  assert.deepEqual(i.toc[1].children[0].children.map((e) => [e.label, e.index, e.frag]), [['Charts', 3, 'charts'], ['The Tide Table', 3, 'tide-table']]);
  assert.equal(i.spine[1].title, 'Chapter 1. The Station');
  assert.ok(i.hasCover);
  assert.match(await b.cover(), /^data:image\/svg\+xml;base64,/);
  await b.close();
});

test('sample EPUB 3: unsafe content is removed, notes and links are mapped, images become data URLs', async () => {
  const b = await open(M.lighthouse());
  const c = await b.chapter(1);
  assert.doesNotMatch(c.html, /<script|onclick=|style=|https:\/\/example\.com|innerHTML/);
  assert.deepEqual({ s: c.blocked.scripts, r: c.blocked.remote, h: c.blocked.handlers, i: c.blocked.inlineStyles }, { s: 1, r: 1, h: 1, i: 1 });
  assert.match(c.html, /<a data-epub-type="noteref" id="e-ref1" data-to="1#e-fn1" href="#">1<\/a>/);
  assert.match(c.html, /<aside data-epub-type="footnote" id="e-fn1">/);
  assert.match(c.html, /data-to="5#e-letter-3"/);
  assert.match(c.html, /data-ext="https:\/\/example.org\/lighthouses"/);
  const cover = await b.chapter(0);
  assert.match(cover.html, /<img alt="" src="data:image\/svg\+xml;base64,/);
  const ch3 = await b.chapter(3);
  assert.match(ch3.html, /<img alt="Chart of the north coast" width="640" height="380" src="data:image\/png;base64,iVBOR/);
  assert.match(ch3.html, /<math><mi>h<\/mi><mo>=<\/mo>/);
  assert.match(ch3.html, /<table><thead><tr><th>Day<\/th>/);
  await b.close();
});

test('sample EPUB 2: NCX with a nested entry, ISBN-10, Latin-1 chapter, endnotes file, non-linear item', async () => {
  const b = await open(M.fieldNotes());
  const i = b.info();
  assert.equal(i.version, '2.0');
  assert.equal(i.tocSource, 'ncx');
  assert.deepEqual(i.meta.authors, ['June Okafor']);
  assert.equal(i.meta.language, 'en-GB');
  assert.equal(i.meta.isbn, '0-306-40615-2');
  assert.deepEqual(i.toc[2].children.map((e) => [e.label, e.index, e.frag]), [['Species seen', 2, 'list']]);
  assert.equal(i.spine.length, 7);
  assert.equal(i.spine[6].linear, false);
  const c3 = await b.chapter(3);
  assert.match(c3.html, /Café notes, written on the naïve old typewriter: été, garçon, über\./);
  const c1 = await b.chapter(1);
  assert.match(c1.html, /<a href="#" data-to="5#e-n1" id="e-r1"><sup>1<\/sup><\/a>|<a id="e-r1" data-to="5#e-n1" href="#"><sup>1<\/sup><\/a>/);
  const c2 = await b.chapter(2);
  assert.match(c2.html, /<ol start="3">/);
  assert.match(c2.html, /<pre>wall {2}north/);
  assert.match(await b.cover(), /^data:image\/png;base64,iVBOR/);
  await b.close();
});

test('sanitizer: drops scripts, styles, frames, forms, handlers, javascript: links and remote URLs', () => {
  const out = html(`<p onclick="x()" onmouseover="y()" style="color:red" id="a b">Hi <a href="javascript:alert(1)">js</a></p>
<script>alert(1)</script><style>p{}</style><iframe src="https://evil"></iframe><object data="x.swf"></object><embed src="x"/>
<form action="https://x"><input value="v"/><button>b</button></form><video src="v.mp4"></video><audio src="a.mp3"></audio>
<img src="http://x.org/t.gif" alt="t"/><img src="data:text/html;base64,PHNjcmlwdD4=" alt="h"/><img src="data:image/png;base64,iVBORw0K" alt="ok"/>
<a href="ftp://x">ftp</a><a href="file:///etc/passwd">f</a><a href="mailto:a@b.c">mail</a><a href="ch2.xhtml#s1">next</a><a href="outside.xhtml">o</a>
<svg><circle r="3"/></svg><svg xmlns:xlink="x"><image xlink:href="../images/c.png"/></svg>
<epub:switch><epub:case required-namespace="m"><b>case</b></epub:case><epub:default><i>fallback</i></epub:default></epub:switch>
<font color="red">font</font><center>c</center><custom-tag>kept text</custom-tag><pre>\nline1\n</pre>`);
  for (const bad of ['onclick', 'onmouseover', 'style=', '<script', 'alert', '<style', '<iframe', 'evil', '<object', '<embed', '<form', '<input', '<button', '<video', '<audio', 'http://x.org', 'data:text/html', 'ftp:', 'file:', '<svg', '<circle', '<b>case', '<font']) {
    assert.ok(!out.includes(bad), `${bad} should be removed:\n${out}`);
  }
  assert.match(out, /<p id="e-a_b">Hi <a>js<\/a><\/p>/);
  assert.match(out, /<img alt="ok" src="data:image\/png;base64,iVBORw0K">/);
  assert.match(out, /<a data-ext="mailto:a@b.c" href="#">mail<\/a>/);
  assert.match(out, /<a data-to="2#e-s1" href="#">next<\/a>/);
  assert.match(out, /<a>o<\/a>/);
  assert.match(out, /src="data:image\/png;base64,AAAA#images\/c.png"/);
  assert.match(out, /<i>fallback<\/i>/);
  assert.match(out, /<div>c<\/div>kept text<pre>line1\n<\/pre>/);
  const s = san('<script></script><p style="x" onclick="y">a</p><img src="https://t/x.png"/><link href="x.css"/>');
  assert.deepEqual([s.blocked.scripts, s.blocked.inlineStyles, s.blocked.handlers, s.blocked.remote], [1, 1, 1, 1]);
});

test('sanitizer: escapes text and attributes, and missing images show their alt text', () => {
  const s = san('<p title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&lt;script&gt;alert(1)&lt;/script&gt;</p><img src="missing.png" alt="A map"/>');
  const out = S.toHtml(s.tree, () => '');
  assert.equal(out, '<p title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&lt;script&gt;alert(1)&lt;/script&gt;</p><span class="ep-noimg">[A map]</span>');
  assert.equal(S.textOf(s.tree), '<script>alert(1)</script>');
});

test('markdown: headings, emphasis, lists, quotes, code, tables, links and images', () => {
  const s = san(`<h1>Title</h1><p>Some <em>soft</em> and <strong>hard</strong> text with a * star and <code>x</code>.</p>
<blockquote><p>Quoted line.</p></blockquote><ul><li>One</li><li>Two <b>bold</b></li></ul><ol start="4"><li>Four</li><li>Five</li></ol>
<pre>a  b\nc</pre><table><tr><th>K</th><th>V</th></tr><tr><td>a|b</td><td>2</td></tr></table>
<p><a href="https://x.org/a b">site</a> and <a href="ch2.xhtml">next</a></p><p><img src="images/m.png" alt="Map"/></p><hr/>`);
  const md = S.toMarkdown(s.tree, (p) => 'img/' + p.split('/').pop());
  assert.equal(md, [
    '# Title', '', 'Some *soft* and **hard** text with a \\* star and `x`.', '', '> Quoted line.', '', '- One', '- Two **bold**', '', '4. Four', '5. Five', '',
    '```', 'a  b', 'c', '```', '', '| K | V |', '| --- | --- |', '| a\\|b | 2 |', '', '[site](https://x.org/a%20b) and next', '', '![Map](img/m.png)', '', '---', '',
  ].join('\n'));
});

test('book: search is case-insensitive with per-chapter occurrence numbers, and Markdown lists images', async () => {
  const b = await open(M.lighthouse());
  const r = await b.search('THE LAMP');
  assert.ok(r.total > 10);
  const perChapter = {};
  for (const x of r.results) { assert.equal(x.k, perChapter[x.index] || 0); perChapter[x.index] = x.k + 1; assert.equal(x.match.toLowerCase(), 'the lamp'); }
  assert.equal((await b.search('high water')).results[0].index, 3);
  assert.equal((await b.search('zzzz-not-there')).total, 0);
  const capped = await b.search('the', 5);
  assert.equal(capped.results.length, 5);
  assert.ok(capped.truncated);
  const m = await b.markdown(3, 'ch3-images');
  assert.match(m.md, /^# Chapter 3\. Soundings\n/);
  assert.match(m.md, /!\[Chart of the north coast\]\(ch3-images\/chart\.png\)/);
  assert.match(m.md, /\| Day \| High water \| Low water \| Range \(m\) \|/);
  assert.deepEqual(m.images, [{ path: 'OEBPS/images/chart.png', name: 'chart.png' }]);
  assert.equal(fold('İSTANBUL Straße'), 'İstanbul straße'.replace('i̇', 'İ'));
  await b.close();
});

test('book: a ZIP without container.xml falls back to the .opf, and junk gets a clear message', async () => {
  const opf = '<package version="2.0"><metadata><dc:title>Bare</dc:title></metadata><manifest><item id="a" href="a.html" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>';
  const b = await open(zipSync({ 'book.opf': strToU8(opf), 'a.html': strToU8('<p>Only page</p>') }));
  assert.equal(b.info().meta.title, 'Bare');
  assert.equal(b.info().tocSource, 'spine');
  assert.match((await b.chapter(0)).html, /Only page/);
  await assert.rejects(open(zipSync({ 'x.txt': strToU8('x') })), /not an EPUB/);
  await assert.rejects(open(zipSync({ 'META-INF/container.xml': strToU8(M.CONTAINER) })), /package file OEBPS\/content.opf is missing/);
  const drm = zipSync({ 'META-INF/container.xml': strToU8(M.CONTAINER), 'META-INF/encryption.xml': strToU8('<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><CipherData><CipherReference URI="OEBPS/c1.xhtml"/></CipherData></EncryptedData></encryption>'), 'OEBPS/content.opf': strToU8(opf) });
  await assert.rejects(open(drm), /protected with DRM/);
  const empty = zipSync({ 'META-INF/container.xml': strToU8(M.CONTAINER), 'OEBPS/content.opf': strToU8('<package version="3.0"><metadata/><manifest/><spine/></package>') });
  await assert.rejects(open(empty), /no readable chapters/);
});

test('book: random bytes and truncated books never hang and give an error', async () => {
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed & 255; };
  for (let n = 0; n < 30; n++) {
    const u = Uint8Array.from({ length: 200 + n * 37 }, rnd);
    await assert.rejects(open(u));
  }
  const good = M.lighthouse();
  for (const cut of [100, 5000, good.length - 30]) await assert.rejects(open(good.subarray(0, cut)));
  // Garbage XHTML still renders without throwing.
  for (let n = 0; n < 50; n++) {
    const s = Array.from({ length: 400 }, () => '<>/="\'&;ab p'[rnd() % 13]).join('');
    assert.equal(typeof S.toHtml(san(s).tree, () => ''), 'string');
  }
});

test('book: a 200-chapter book opens fast and a full-text search stays quick', async () => {
  const u = M.atlas(200, 60);
  const t0 = Date.now();
  const b = await open(u);
  const openMs = Date.now() - t0;
  assert.equal(b.length, 200);
  const t1 = Date.now();
  await b.chapter(0);
  const chMs = Date.now() - t1;
  const t2 = Date.now();
  const r = await b.search('the lamp');
  const searchMs = Date.now() - t2;
  console.log(`atlas ${(u.length / 1048576).toFixed(1)} MB: open ${openMs} ms, first chapter ${chMs} ms, search ${searchMs} ms, ${r.total} hits`);
  assert.ok(openMs < 1500 && chMs < 1500 && searchMs < 8000);
  await b.close();
});
