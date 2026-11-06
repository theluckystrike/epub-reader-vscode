'use strict';
// Turns one chapter (XHTML from the book) into safe HTML for the webview. Allow-list only: scripts, styles,
// forms, frames, event handlers, inline styles and every remote URL are removed here, and the webview CSP
// blocks them again. Also gives the plain text (for search) and Markdown (for export) of the same tree.
const X = require('./xml');
const { resolveHref, isRemote } = require('./epub');

const KEEP = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'caption', 'colgroup', 'col', 'hr', 'br', 'address', 'hgroup', 'details', 'summary',
  'span', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'small', 'cite', 'q', 'code', 'kbd', 'samp', 'var', 'abbr',
  'dfn', 'mark', 'time', 'ruby', 'rt', 'rp', 'rb', 'bdi', 'bdo', 'del', 'ins', 'wbr', 'img',
  'math', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mrow', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
  'munderover', 'mtable', 'mtr', 'mtd', 'mspace', 'mstyle', 'mpadded', 'mphantom', 'menclose', 'semantics', 'mmultiscripts',
  'mprescripts', 'none',
]);
const RENAME = { center: 'div', big: 'span', tt: 'code', strike: 's', listing: 'pre', xmp: 'pre', plaintext: 'pre', acronym: 'abbr' };
const DROP = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input',
  'button', 'select', 'textarea', 'option', 'optgroup', 'canvas', 'video', 'audio', 'source', 'track', 'head', 'title', 'link',
  'meta', 'base', 'annotation', 'annotation-xml', 'case', 'param', 'map', 'area', 'portal', 'dialog',
]);
const MATH_ATTRS = new Set(['display', 'mathvariant', 'linethickness', 'stretchy', 'fence', 'separator', 'accent', 'accentunder', 'notation', 'columnalign', 'rowalign']);
const VOID_OUT = new Set(['br', 'hr', 'img', 'col', 'wbr']);
const IMG_DATA = /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif|bmp);base64,[A-Za-z0-9+/=\s]+$/i;
const MAX_DATA_URI = 2 * 1024 * 1024;

function idOut(id) { return 'e-' + String(id).replace(/[^\w\-.:]/g, '_'); }

/**
 * ctx: { path: chapter path in the ZIP, spineIndex(path) -> number (-1 when not in the spine), self: this chapter's index }
 * Returns { tree, images: Set of ZIP paths, blocked: counts, title }.
 */
function sanitize(src, ctx) {
  const doc = X.parse(src);
  const blocked = { scripts: 0, styles: 0, remote: 0, forms: 0, media: 0, handlers: 0, inlineStyles: 0, svg: 0 };
  const images = new Set();
  let title = '';
  const body = X.find(doc, 'body') || doc;

  function imgFrom(href, alt, w, h) {
    if (!href) return null;
    const a = { alt: alt || '' };
    if (/^\d{1,5}$/.test(w || '')) a.width = w;
    if (/^\d{1,5}$/.test(h || '')) a.height = h;
    if (/^data:/i.test(href)) {
      if (href.length > MAX_DATA_URI || !IMG_DATA.test(href)) { blocked.remote++; return null; }
      a.src = href.replace(/\s+/g, '');
      return { t: 'el', tag: 'img', attrs: a, kids: [] };
    }
    if (isRemote(href)) { blocked.remote++; return null; }
    const p = resolveHref(ctx.path, href).path;
    images.add(p);
    a['data-path'] = p;
    return { t: 'el', tag: 'img', attrs: a, kids: [] };
  }

  function attrsFor(el, tag) {
    const out = {};
    for (const [k0, v] of Object.entries(el.attrs || {})) {
      const k = k0.toLowerCase();
      if (/^on/.test(k)) { blocked.handlers++; continue; }
      if (k === 'style') { blocked.inlineStyles++; continue; }
      if (k === 'id' || k === 'xml:id') { out.id = idOut(v); continue; }
      if (k === 'title' || k === 'dir') { out[k] = v; continue; }
      if (k === 'lang' || k === 'xml:lang') { if (/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(v)) out.lang = v; continue; }
      if (k === 'epub:type') { out['data-epub-type'] = v.replace(/[^\w\s:-]/g, ''); continue; }
      if (k === 'role') { out.role = v.replace(/[^\w\s-]/g, ''); continue; }
      if (k === 'class') { if (/\b(footnote|endnote|noteref|fnref|note)\b/i.test(v)) out['data-note-class'] = '1'; continue; }
      if ((k === 'colspan' || k === 'rowspan' || k === 'span') && /^\d{1,3}$/.test(v)) { out[k] = v; continue; }
      if (k === 'scope' && /^(row|col|rowgroup|colgroup)$/i.test(v)) { out.scope = v; continue; }
      if (tag === 'ol' && (k === 'start' && /^-?\d{1,6}$/.test(v))) { out.start = v; continue; }
      if (tag === 'ol' && k === 'reversed') { out.reversed = ''; continue; }
      if (tag === 'ol' && k === 'type' && /^[1aAiI]$/.test(v)) { out.type = v; continue; }
      if (tag === 'li' && k === 'value' && /^-?\d{1,6}$/.test(v)) { out.value = v; continue; }
      if (tag === 'time' && k === 'datetime') { out.datetime = v; continue; }
      if (MATH_ATTRS.has(k)) { out[k] = v.replace(/[^\w\s.%-]/g, ''); continue; }
    }
    return out;
  }

  function linkAttrs(el, out) {
    const href = X.attr(el, 'href', 'xlink:href');
    if (!href) return;
    const h = href.trim();
    if (/^(https?:|mailto:)/i.test(h)) { out['data-ext'] = h; out.href = '#'; return; }
    if (isRemote(h)) { if (/^\s*javascript:/i.test(h)) blocked.scripts++; return; }
    const r = resolveHref(ctx.path, h);
    const idx = r.path === ctx.path ? ctx.self : ctx.spineIndex(r.path);
    if (idx < 0) return;
    out['data-to'] = `${idx}#${r.frag ? idOut(r.frag) : ''}`;
    out.href = '#';
  }

  function walk(node, out, inPre) {
    for (const c of node.children || []) {
      if (c.type === 'text') { out.push({ t: 'text', v: c.text }); continue; }
      if (c.type !== 'el') continue;
      const name = c.local;
      if (name === 'switch') { // epub:switch: show the fallback
        const def = X.children(c, 'default')[0];
        if (def) walk(def, out, inPre);
        continue;
      }
      if (DROP.has(name)) {
        if (name === 'script') blocked.scripts++;
        else if (name === 'style' || name === 'link') blocked.styles++;
        else if (/^(form|input|button|select|textarea)$/.test(name)) blocked.forms++;
        else if (/^(video|audio|iframe|object|embed|canvas|frame|applet)$/.test(name)) blocked.media++;
        continue;
      }
      if (name === 'svg') {
        const im = X.findAll(c, 'image')[0];
        const img = im ? imgFrom(X.attr(im, 'xlink:href', 'href'), X.clean(X.attr(c, 'aria-label') || ''), '', '') : null;
        if (img) out.push(img); else blocked.svg++;
        continue;
      }
      if (name === 'img' || name === 'image') {
        const img = imgFrom(X.attr(c, 'src', 'xlink:href', 'href'), X.attr(c, 'alt'), X.attr(c, 'width'), X.attr(c, 'height'));
        if (img) out.push(img);
        continue;
      }
      const tag = RENAME[name] || name;
      if (!KEEP.has(tag)) { walk(c, out, inPre); continue; } // unknown element: keep its children
      const attrs = attrsFor(c, tag);
      if (tag === 'a') linkAttrs(c, attrs);
      const el = { t: 'el', tag, attrs, kids: [] };
      walk(c, el.kids, inPre || tag === 'pre');
      if (tag === 'pre' && el.kids[0] && el.kids[0].t === 'text') el.kids[0].v = el.kids[0].v.replace(/^\r?\n/, '');
      if (!title && /^h[1-3]$/.test(tag)) title = X.clean(textOf(el));
      out.push(el);
    }
  }
  const tree = { t: 'root', kids: [] };
  walk(body, tree.kids, false);
  return { tree, images, blocked, title };
}

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Serialize. imageUrl(path) gives the data URL of a book image, or '' to show its alt text instead. */
function toHtml(tree, imageUrl) {
  let s = '';
  const emit = (n) => {
    if (n.t === 'text') { s += escText(n.v); return; }
    if (n.t === 'root') { n.kids.forEach(emit); return; }
    const a = { ...n.attrs };
    if (n.tag === 'img' && a['data-path']) {
      const url = imageUrl ? imageUrl(a['data-path']) : '';
      if (!url) { s += `<span class="ep-noimg">${escText(a.alt ? `[${a.alt}]` : '[image]')}</span>`; return; }
      a.src = url;
      delete a['data-path'];
    }
    s += '<' + n.tag;
    for (const [k, v] of Object.entries(a)) s += v === '' && k === 'reversed' ? ` ${k}` : ` ${k}="${escAttr(v)}"`;
    s += '>';
    if (VOID_OUT.has(n.tag)) return;
    n.kids.forEach(emit);
    s += `</${n.tag}>`;
  };
  emit(tree);
  return s;
}

function textOf(n) {
  if (n.t === 'text') return n.v;
  let s = '';
  for (const k of n.kids || []) s += textOf(k);
  return s;
}

// ---- Markdown export ----

const mdEsc = (s) => s.replace(/([\\`*_[\]])/g, '\\$1');
const BLOCK = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'hr', 'address', 'hgroup', 'details', 'summary', 'caption', 'math']);

/** imageRef(path, alt) returns the link target for an image in the Markdown, or '' to write the alt text only. */
function toMarkdown(tree, imageRef) {
  const inline = (n) => {
    if (n.t === 'text') return mdEsc(n.v.replace(/\s+/g, ' '));
    const inner = () => n.kids.map(inline).join('');
    switch (n.tag) {
      case 'em': case 'i': case 'cite': case 'dfn': case 'var': { const t = inner().trim(); return t ? `*${t}*` : ''; }
      case 'strong': case 'b': { const t = inner().trim(); return t ? `**${t}**` : ''; }
      case 'code': case 'kbd': case 'samp': { const t = textOf(n); return t ? '`' + t.replace(/`/g, 'ˋ') + '`' : ''; }
      case 's': case 'del': { const t = inner().trim(); return t ? `~~${t}~~` : ''; }
      case 'br': return '  \n';
      case 'sup': { const t = inner().trim(); return t ? `<sup>${t}</sup>` : ''; }
      case 'sub': { const t = inner().trim(); return t ? `<sub>${t}</sub>` : ''; }
      case 'img': {
        const alt = (n.attrs.alt || '').replace(/[[\]]/g, '');
        const ref = n.attrs['data-path'] && imageRef ? imageRef(n.attrs['data-path'], alt) : '';
        return ref ? `![${alt}](${ref.replace(/ /g, '%20')})` : (alt ? `[${alt}]` : '');
      }
      case 'a': {
        const t = inner().trim();
        if (n.attrs['data-ext'] && t) return `[${t}](${n.attrs['data-ext'].replace(/[()\s]/g, encodeURIComponent)})`;
        return t;
      }
      default:
        if (BLOCK.has(n.tag)) return ' ' + block(n, '').trim() + ' ';
        return inner();
    }
  };
  const lines = (s, pre) => s.split('\n').map((l) => (l ? pre + l : pre.trimEnd())).join('\n');
  const inl = (kids) => kids.map(inline).join('').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  function blockKids(n, ctx) {
    const out = [];
    let run = [];
    const flush = () => { const t = inl(run); if (t) out.push(t); run = []; };
    for (const k of n.kids) {
      if (k.t === 'el' && BLOCK.has(k.tag)) { flush(); const b = block(k, ctx); if (b.trim()) out.push(b); } else run.push(k);
    }
    flush();
    return out.join('\n\n');
  }
  function block(n, ctx) {
    switch (n.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return '#'.repeat(Number(n.tag[1])) + ' ' + inl(n.kids).replace(/\n/g, ' ');
      case 'hr': return '---';
      case 'pre': return '```\n' + textOf(n).replace(/\n+$/, '') + '\n```';
      case 'blockquote': return lines(blockKids(n, ctx), '> ');
      case 'ul': case 'ol': {
        let i = n.tag === 'ol' ? Number(n.attrs.start || 1) : 0;
        return n.kids.filter((k) => k.t === 'el' && k.tag === 'li').map((li) => {
          const mark = n.tag === 'ol' ? `${i++}. ` : '- ';
          const body = blockKids(li, ctx) || '';
          return mark + body.split('\n').map((l, j) => (j === 0 ? l : (l ? ' '.repeat(mark.length) + l : ''))).join('\n');
        }).join('\n');
      }
      case 'dl': return n.kids.filter((k) => k.t === 'el').map((k) => (k.tag === 'dt' ? `**${inl(k.kids)}**` : ': ' + blockKids(k, ctx))).join('\n');
      case 'table': {
        const rows = [];
        const collect = (x) => { for (const k of x.kids || []) { if (k.t !== 'el') continue; if (k.tag === 'tr') rows.push(k); else if (/^(thead|tbody|tfoot)$/.test(k.tag)) collect(k); } };
        collect(n);
        if (!rows.length) return blockKids(n, ctx);
        const cells = rows.map((r) => r.kids.filter((k) => k.t === 'el' && (k.tag === 'td' || k.tag === 'th')).map((c) => inl(c.kids).replace(/\|/g, '\\|').replace(/\n/g, ' ')));
        const w = Math.max(...cells.map((c) => c.length), 1);
        const row = (c) => '| ' + Array.from({ length: w }, (_, j) => c[j] || '').join(' | ') + ' |';
        return [row(cells[0]), '|' + ' --- |'.repeat(w), ...cells.slice(1).map(row)].join('\n');
      }
      case 'math': return textOf(n).replace(/\s+/g, ' ').trim();
      case 'figure': case 'div': case 'section': case 'article': case 'aside': case 'header': case 'footer': case 'nav': case 'main':
      case 'hgroup': case 'details': case 'li': case 'dd': case 'address':
        return blockKids(n, ctx);
      default: return blockKids(n, ctx) || inl(n.kids);
    }
  }
  return blockKids(tree, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

module.exports = { sanitize, toHtml, toMarkdown, textOf, idOut, escText, escAttr };
