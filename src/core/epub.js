'use strict';
// EPUB 2 and EPUB 3 package reading: container.xml, the OPF (metadata, manifest, spine) and the table of
// contents from the EPUB 3 nav document or the EPUB 2 NCX. Pure functions plus one async loader.
const X = require('./xml');

class EpubError extends Error {}

/** Resolve href against the folder of `base` (a path inside the ZIP). Returns { path, frag }. */
function resolveHref(base, href) {
  const raw = String(href || '').trim();
  const hash = raw.indexOf('#');
  const frag = hash >= 0 ? safeDecode(raw.slice(hash + 1)) : '';
  let p = hash >= 0 ? raw.slice(0, hash) : raw;
  const q = p.indexOf('?'); if (q >= 0) p = p.slice(0, q);
  p = safeDecode(p);
  if (!p) return { path: base, frag };
  const parts = p.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return { path: parts.join('/'), frag };
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

/** True for http:, https:, ftp:, //host and other remote or scheme URLs. */
function isRemote(href) { return /^\s*([a-z][a-z0-9+.-]*:|\/\/)/i.test(String(href || '')); }

function containerPath(xml) {
  const t = X.parse(xml, { xml: true });
  const rfs = X.findAll(t, 'rootfile');
  const pick = rfs.find((r) => /oebps-package/i.test(X.attr(r, 'media-type') || '')) || rfs[0];
  const p = pick && X.attr(pick, 'full-path');
  if (!p) throw new EpubError('META-INF/container.xml does not name the package file.');
  return p.replace(/^\/+/, '');
}

function isbnOf(s) {
  const v = String(s || '').replace(/^urn:isbn:/i, '').replace(/^isbn[:\s]*/i, '').trim();
  const d = v.replace(/[\s-]/g, '');
  if (/^97[89]\d{10}$/.test(d) || /^\d{9}[\dXx]$/.test(d)) return v;
  return null;
}

/** Parse the OPF text. opfPath is its path in the ZIP (hrefs are relative to it). */
function parseOpf(xml, opfPath) {
  const t = X.parse(xml, { xml: true });
  const pkg = X.find(t, 'package');
  if (!pkg) throw new EpubError(`${opfPath} is not an EPUB package file.`);
  const version = X.attr(pkg, 'version') || '2.0';
  const md = X.find(pkg, 'metadata') || { children: [] };
  const all = X.findAll(md, '*');
  const byLocal = (n) => all.filter((e) => e.local === n);
  const refines = {};
  for (const m of byLocal('meta')) {
    const r = X.attr(m, 'refines');
    const prop = X.attr(m, 'property');
    if (r && prop) (refines[r.replace(/^#/, '')] ||= {})[prop] = X.clean(X.textOf(m));
  }
  const titles = byLocal('title').map((e) => ({ text: X.clean(X.textOf(e)), id: X.attr(e, 'id') })).filter((x) => x.text);
  const main = titles.find((x) => x.id && refines[x.id] && refines[x.id]['title-type'] === 'main') || titles[0];
  const sub = titles.find((x) => x.id && refines[x.id] && refines[x.id]['title-type'] === 'subtitle');
  const creators = byLocal('creator').map((e) => {
    const id = X.attr(e, 'id');
    const role = X.attr(e, 'opf:role', 'role') || (id && refines[id] && refines[id].role) || '';
    return { name: X.clean(X.textOf(e)), role };
  }).filter((c) => c.name);
  const authors = creators.filter((c) => !c.role || c.role === 'aut').map((c) => c.name);
  const identifiers = byLocal('identifier').map((e) => ({ value: X.clean(X.textOf(e)), scheme: X.attr(e, 'opf:scheme', 'scheme') || '' }));
  let isbn = '';
  for (const id of identifiers) {
    if (/isbn/i.test(id.scheme) || /^urn:isbn:/i.test(id.value)) { isbn = id.value.replace(/^urn:isbn:/i, ''); break; }
  }
  if (!isbn) for (const id of identifiers) { const v = isbnOf(id.value); if (v) { isbn = v; break; } }
  for (const m of byLocal('meta')) {
    // EPUB 3 puts the scheme in a refines meta: <meta refines="#id" property="identifier-type" scheme="onix:codelist5">15</meta>
    if (isbn) break;
    if (X.attr(m, 'property') === 'identifier-type' && /^(15|02|isbn)$/i.test(X.clean(X.textOf(m)))) {
      const target = identifiers.find((_, i) => X.attr(byLocal('identifier')[i], 'id') === (X.attr(m, 'refines') || '').replace(/^#/, ''));
      if (target) isbn = target.value.replace(/^urn:isbn:/i, '');
    }
  }
  const uidRef = X.attr(pkg, 'unique-identifier');
  const uidEl = byLocal('identifier').find((e) => X.attr(e, 'id') === uidRef);
  const first = (n) => { const e = byLocal(n)[0]; return e ? X.clean(X.textOf(e)) : ''; };
  let description = first('description');
  if (/<[a-z]/i.test(description)) description = X.clean(X.textOf(X.parse(description)));
  let modified = '';
  for (const m of byLocal('meta')) if (X.attr(m, 'property') === 'dcterms:modified') modified = X.clean(X.textOf(m));
  let coverId = '';
  for (const m of byLocal('meta')) if ((X.attr(m, 'name') || '').toLowerCase() === 'cover') coverId = X.attr(m, 'content') || '';
  let layout = '';
  for (const m of byLocal('meta')) if (X.attr(m, 'property') === 'rendition:layout') layout = X.clean(X.textOf(m));

  const manifest = new Map();
  const mf = X.find(pkg, 'manifest') || { children: [] };
  for (const it of X.children(mf, 'item')) {
    const id = X.attr(it, 'id');
    const href = X.attr(it, 'href');
    if (!id || !href) continue;
    const r = resolveHref(opfPath, href);
    manifest.set(id, { id, href, path: r.path, type: (X.attr(it, 'media-type') || '').toLowerCase(), props: (X.attr(it, 'properties') || '').split(/\s+/).filter(Boolean) });
  }
  const spineEl = X.find(pkg, 'spine') || { children: [], attrs: {} };
  const spine = [];
  for (const ir of X.children(spineEl, 'itemref')) {
    const item = manifest.get(X.attr(ir, 'idref'));
    if (!item) continue;
    spine.push({ id: item.id, path: item.path, type: item.type, linear: (X.attr(ir, 'linear') || 'yes') !== 'no' });
  }
  const items = [...manifest.values()];
  const navItem = items.find((i) => i.props.includes('nav'));
  const ncxId = X.attr(spineEl, 'toc');
  const ncxItem = (ncxId && manifest.get(ncxId)) || items.find((i) => i.type === 'application/x-dtbncx+xml');
  let cover = items.find((i) => i.props.includes('cover-image'));
  if (!cover && coverId) cover = manifest.get(coverId) || items.find((i) => i.href === coverId);
  if (!cover) cover = items.find((i) => /^image\//.test(i.type) && /cover/i.test(i.id + ' ' + i.href));
  const langs = byLocal('language').map((e) => X.clean(X.textOf(e))).filter(Boolean);
  return {
    version, opfPath,
    meta: {
      title: main ? main.text : '', subtitle: sub ? sub.text : '', authors,
      contributors: creators.filter((c) => c.role && c.role !== 'aut').map((c) => `${c.name} (${c.role})`),
      language: langs.join(', '), isbn, identifier: uidEl ? X.clean(X.textOf(uidEl)) : (identifiers[0] ? identifiers[0].value : ''),
      publisher: first('publisher'), date: first('date'), modified, description, rights: first('rights'),
      subjects: byLocal('subject').map((e) => X.clean(X.textOf(e))).filter(Boolean), layout,
    },
    manifest, spine, navPath: navItem ? navItem.path : '', ncxPath: ncxItem ? ncxItem.path : '', coverPath: cover && /^image\//.test(cover.type) ? cover.path : '',
    coverType: cover ? cover.type : '',
  };
}

/** EPUB 3 nav document: the <nav epub:type="toc"> list. Returns [{ label, path, frag, children }]. */
function parseNav(xhtml, navPath) {
  const t = X.parse(xhtml);
  const navs = X.findAll(t, 'nav');
  const toc = navs.find((n) => /(^|\s)toc(\s|$)/.test(X.attr(n, 'epub:type') || X.attr(n, 'role') || '')) || navs.find((n) => /toc/i.test(X.attr(n, 'role') || X.attr(n, 'id') || '')) || navs[0];
  if (!toc) return [];
  const walkOl = (ol) => X.children(ol, 'li').map((li) => {
    const a = X.children(li).find((c) => c.local === 'a' || c.local === 'span');
    const sub = X.children(li, 'ol')[0] || X.children(li, 'ul')[0];
    const href = a && a.local === 'a' ? X.attr(a, 'href') : '';
    const r = href && !isRemote(href) ? resolveHref(navPath, href) : { path: '', frag: '' };
    return { label: X.clean(X.textOf(a)) || X.clean(X.attr(a, 'title')) || '', path: r.path, frag: r.frag, children: sub ? walkOl(sub) : [] };
  }).filter((e) => e.label || e.children.length);
  const ol = X.findAll(toc, 'ol')[0] || X.findAll(toc, 'ul')[0];
  return ol ? walkOl(ol) : [];
}

/** EPUB 2 NCX: navMap/navPoint. */
function parseNcx(xml, ncxPath) {
  const t = X.parse(xml, { xml: true });
  const map = X.find(t, 'navmap');
  if (!map) return [];
  const walk = (node) => X.children(node, 'navpoint').map((np) => {
    const label = X.clean(X.textOf(X.find(X.children(np, 'navlabel')[0] || np, 'text')));
    const content = X.children(np, 'content')[0];
    const src = content ? X.attr(content, 'src') : '';
    const r = src && !isRemote(src) ? resolveHref(ncxPath, src) : { path: '', frag: '' };
    return { label, path: r.path, frag: r.frag, children: walk(np) };
  });
  return walk(map);
}

/** Give each TOC entry the spine index of its file (-1 when it is not in the spine). */
function linkToc(toc, spine) {
  const idx = new Map(spine.map((s, i) => [s.path, i]));
  const lower = new Map(spine.map((s, i) => [s.path.toLowerCase(), i]));
  const walk = (list) => list.map((e) => ({
    label: e.label, frag: e.frag,
    index: e.path ? (idx.has(e.path) ? idx.get(e.path) : (lower.has(e.path.toLowerCase()) ? lower.get(e.path.toLowerCase()) : -1)) : -1,
    children: walk(e.children || []),
  }));
  return walk(toc);
}

/** A title for each spine item from the TOC (first entry that points to it). */
function spineTitles(toc, n) {
  const out = new Array(n).fill('');
  const walk = (list) => { for (const e of list) { if (e.index >= 0 && !out[e.index]) out[e.index] = e.label; walk(e.children); } };
  walk(toc);
  return out;
}

/** Content files that encryption.xml lists, other than obfuscated fonts. Any of them means DRM. */
function drmFiles(encXml) {
  if (!encXml) return [];
  const t = X.parse(encXml, { xml: true });
  const out = [];
  for (const ed of X.findAll(t, 'encrypteddata')) {
    const m = X.find(ed, 'encryptionmethod');
    const alg = m ? X.attr(m, 'algorithm') || '' : '';
    const ref = X.find(ed, 'cipherreference');
    const uri = ref ? X.attr(ref, 'uri') || '' : '';
    if (/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/i.test(alg)) continue; // font obfuscation only
    if (/\.(otf|ttf|woff2?)$/i.test(uri)) continue;
    if (uri) out.push(uri);
  }
  return out;
}

/** Load the package from an open ZipReader. */
async function loadPackage(zip) {
  if (!zip.has('META-INF/container.xml')) {
    const opf = zip.names().find((n) => /\.opf$/i.test(n));
    if (!opf) throw new EpubError('This ZIP file has no META-INF/container.xml and no .opf file, so it is not an EPUB.');
    return finish(zip, opf);
  }
  return finish(zip, containerPath(await zip.text('META-INF/container.xml')));
}

async function finish(zip, opfPath) {
  if (!zip.has(opfPath)) throw new EpubError(`The package file ${opfPath} is missing from the book.`);
  const enc = zip.has('META-INF/encryption.xml') ? await zip.text('META-INF/encryption.xml') : '';
  const drm = drmFiles(enc);
  if (drm.length) throw new EpubError('This book is protected with DRM, so its text is encrypted and cannot be shown. Open it in the reader app it was bought for.');
  const pkg = parseOpf(await zip.text(opfPath), opfPath);
  let toc = [];
  let tocSource = 'none';
  if (pkg.navPath && zip.has(pkg.navPath)) {
    try { toc = parseNav(await zip.text(pkg.navPath), pkg.navPath); tocSource = 'nav'; } catch { toc = []; }
  }
  if (!toc.length && pkg.ncxPath && zip.has(pkg.ncxPath)) {
    try { toc = parseNcx(await zip.text(pkg.ncxPath), pkg.ncxPath); tocSource = 'ncx'; } catch { toc = []; }
  }
  const spine = pkg.spine.filter((s) => zip.has(s.path));
  if (!spine.length) throw new EpubError('The book has no readable chapters in its spine.');
  let linked = linkToc(toc, spine);
  const anyLinked = (list) => list.some((e) => e.index >= 0 || anyLinked(e.children));
  if (!anyLinked(linked)) { linked = []; tocSource = 'spine'; }
  const titles = spineTitles(linked, spine.length);
  for (let i = 0; i < spine.length; i++) {
    const e = zip.find(spine[i].path);
    spine[i].size = e ? e.size : 0;
    spine[i].title = titles[i];
  }
  return { ...pkg, spine, toc: linked, tocSource };
}

module.exports = { EpubError, resolveHref, isRemote, containerPath, parseOpf, parseNav, parseNcx, linkToc, spineTitles, drmFiles, loadPackage, isbnOf };
