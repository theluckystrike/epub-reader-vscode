'use strict';
// One open book: the ZIP, the package, chapter rendering with images as data URLs, search and Markdown export.
// No vscode import, so tests run it directly on the generated sample books.
const path = require('path');
const { ZipReader, decodeText } = require('./zip');
const { loadPackage } = require('./epub');
const { sanitize, toHtml, toMarkdown, textOf } = require('./sanitize');

const MAX_IMAGE = 20 * 1024 * 1024;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' };

/** Lower-case one UTF-16 unit at a time so indexes stay the same (the webview uses the same fold). */
function fold(s) {
  const l = s.toLowerCase();
  if (l.length === s.length) return l;
  let o = '';
  for (const c of s) { const x = c.toLowerCase(); o += x.length === c.length ? x : c; }
  return o;
}

class Book {
  constructor(zip, pkg) {
    this.zip = zip;
    this.pkg = pkg;
    this.trees = new Map(); // spine index -> sanitized result (small cache)
    this.texts = new Map(); // spine index -> plain text (kept for search)
    this.byPath = new Map(pkg.spine.map((s, i) => [s.path, i]));
    this.byPathLower = new Map(pkg.spine.map((s, i) => [s.path.toLowerCase(), i]));
  }

  static async open(source) {
    const zip = await ZipReader.open(source);
    try {
      const pkg = await loadPackage(zip);
      return new Book(zip, pkg);
    } catch (e) { await zip.close(); throw e; }
  }

  get length() { return this.pkg.spine.length; }

  spineIndex(p) {
    if (this.byPath.has(p)) return this.byPath.get(p);
    const l = this.byPathLower.get(String(p).toLowerCase());
    return l === undefined ? -1 : l;
  }

  info() {
    const p = this.pkg;
    return {
      version: p.version, meta: p.meta, toc: p.toc, tocSource: p.tocSource,
      spine: p.spine.map((s) => ({ title: s.title, size: s.size, linear: s.linear })),
      hasCover: !!p.coverPath,
    };
  }

  async tree(i) {
    if (this.trees.has(i)) return this.trees.get(i);
    const s = this.pkg.spine[i];
    if (!s) throw new Error(`There is no chapter ${i + 1}.`);
    let r;
    if (/^image\//.test(s.type)) {
      r = { tree: { t: 'root', kids: [{ t: 'el', tag: 'img', attrs: { alt: s.title || '', 'data-path': s.path }, kids: [] }] }, images: new Set([s.path]), blocked: {}, title: '' };
    } else {
      const src = decodeText(await this.zip.read(s.path));
      r = sanitize(src, { path: s.path, self: i, spineIndex: (p) => this.spineIndex(p) });
    }
    this.trees.set(i, r);
    if (this.trees.size > 6) this.trees.delete(this.trees.keys().next().value);
    return r;
  }

  mimeOf(p) {
    for (const it of this.pkg.manifest.values()) if (it.path === p && /^image\//.test(it.type)) return it.type;
    return MIME[path.posix.extname(p).slice(1).toLowerCase()] || '';
  }

  async imageUrl(p) {
    const e = this.zip.find(p);
    const mime = this.mimeOf(p);
    if (!e || !mime || e.size > MAX_IMAGE) return '';
    try {
      const b = await this.zip.read(p, MAX_IMAGE);
      return `data:${mime};base64,${Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')}`;
    } catch { return ''; }
  }

  async chapter(i) {
    const r = await this.tree(i);
    const urls = new Map();
    for (const p of r.images) urls.set(p, await this.imageUrl(p));
    const html = toHtml(r.tree, (p) => urls.get(p) || '');
    if (!this.texts.has(i)) this.texts.set(i, textOf(r.tree));
    return { index: i, html, title: this.pkg.spine[i].title || r.title, blocked: r.blocked };
  }

  async text(i) {
    if (this.texts.has(i)) return this.texts.get(i);
    const t = textOf((await this.tree(i)).tree);
    this.texts.set(i, t);
    return t;
  }

  /** Case-insensitive search over all chapters. k is the occurrence number inside its chapter. */
  async search(query, max = 500) {
    const q = fold(String(query || ''));
    const results = [];
    let total = 0;
    if (!q.trim()) return { results, total, truncated: false };
    for (let i = 0; i < this.length; i++) {
      const t = await this.text(i);
      const f = fold(t);
      let k = 0;
      for (let at = f.indexOf(q); at >= 0; at = f.indexOf(q, at + q.length)) {
        total++;
        if (results.length < max) {
          const before = t.slice(Math.max(0, at - 50), at).replace(/\s+/g, ' ');
          const after = t.slice(at + q.length, at + q.length + 70).replace(/\s+/g, ' ');
          results.push({ index: i, k, title: this.pkg.spine[i].title || `Section ${i + 1}`, before: (at > 50 ? '…' : '') + before.trimStart(), match: t.slice(at, at + q.length), after });
        }
        k++;
      }
    }
    return { results, total, truncated: total > results.length };
  }

  /** Markdown for one chapter. Images are listed so the caller can write them next to the .md file. */
  async markdown(i, imageDir) {
    const r = await this.tree(i);
    const images = [];
    const used = new Map();
    const md = toMarkdown(r.tree, (p) => {
      if (!this.zip.find(p)) return '';
      if (!used.has(p)) {
        let name = path.posix.basename(p).replace(/[^\w.-]/g, '_');
        while ([...used.values()].includes(name)) name = '_' + name;
        used.set(p, name);
        images.push({ path: p, name });
      }
      return imageDir ? `${imageDir}/${used.get(p)}` : used.get(p);
    });
    return { md, images, title: this.pkg.spine[i].title || r.title };
  }

  async cover() { return this.pkg.coverPath ? this.imageUrl(this.pkg.coverPath) : ''; }

  close() { return this.zip.close(); }
}

module.exports = { Book, fold };
