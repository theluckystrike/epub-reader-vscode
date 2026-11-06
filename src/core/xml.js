'use strict';
// A forgiving XML/XHTML reader that builds a small tree. It never runs code and never fetches anything:
// it only splits text into tags and text. Used for the OPF, NCX, nav and chapter files.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡', bull: '•',
  hellip: '…', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', middot: '·',
  para: '¶', sect: '§', cent: '¢', pound: '£', euro: '€', yen: '¥', iexcl: '¡', iquest: '¿',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', ordf: 'ª',
  ordm: 'º', not: '¬', macr: '¯', acute: '´', cedil: '¸', uml: '¨', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', harr: '↔', minus: '−', le: '≤', ge: '≥', ne: '≠', infin: '∞',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', mu: 'μ',
  szlig: 'ß', aelig: 'æ', AElig: 'Æ', oelig: 'œ', OElig: 'Œ', oslash: 'ø', Oslash: 'Ø',
  aring: 'å', Aring: 'Å', ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ', eth: 'ð', thorn: 'þ',
};
// Accented letters: &eacute; &Agrave; and so on.
const ACC = { grave: '̀', acute: '́', circ: '̂', tilde: '̃', uml: '̈' };
function accented(name) {
  const m = /^([A-Za-z])(grave|acute|circ|tilde|uml)$/.exec(name);
  return m ? (m[1] + ACC[m[2]]).normalize('NFC') : null;
}

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
      return String.fromCodePoint(n);
    }
    if (Object.prototype.hasOwnProperty.call(NAMED, e)) return NAMED[e];
    return accented(e) || all;
  });
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const k = m[1];
    if (Object.prototype.hasOwnProperty.call(attrs, k)) continue;
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[k] = decodeEntities(v);
  }
  return attrs;
}

/** Index of the '>' that ends a tag starting at i, skipping quoted values. */
function tagEnd(src, i) {
  let q = 0;
  for (let j = i; j < src.length; j++) {
    const c = src.charCodeAt(j);
    if (q) { if (c === q) q = 0; } else if (c === 34 || c === 39) q = c; else if (c === 62) return j;
  }
  return -1;
}

/**
 * Parse into { type:'root', children }. Elements: { type:'el', name (lower-case, prefix kept), local, attrs, children }.
 * Text: { type:'text', text } with entities decoded. Unclosed tags are closed at the end; stray end tags are ignored.
 */
function parse(src, opts = {}) {
  const xmlMode = opts.xml === true; // package files: <meta> and <link> can have content there
  const root = { type: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const addText = (t) => { if (t) top().children.push({ type: 'text', text: decodeEntities(t) }); };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(src.slice(i)); break; }
    if (lt > i) addText(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      const t = src.slice(lt + 9, e < 0 ? n : e);
      if (t) top().children.push({ type: 'text', text: t });
      i = e < 0 ? n : e + 3; continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') { const e = src.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e < 0 ? n : e).trim().toLowerCase();
      i = e < 0 ? n : e + 1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      continue;
    }
    if (!/[A-Za-z_]/.test(src[lt + 1] || '')) { addText('<'); i = lt + 1; continue; }
    const e = tagEnd(src, lt + 1);
    if (e < 0) { addText(src.slice(lt)); break; }
    let inner = src.slice(lt + 1, e);
    const self = /\/\s*$/.test(inner);
    if (self) inner = inner.replace(/\/\s*$/, '');
    const sp = inner.search(/[\s/]/);
    const name = (sp < 0 ? inner : inner.slice(0, sp)).toLowerCase();
    const attrs = sp < 0 ? {} : parseAttrs(inner.slice(sp));
    const el = { type: 'el', name, local: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name, attrs, children: [] };
    top().children.push(el);
    i = e + 1;
    if (self || (!xmlMode && VOID.has(el.local))) continue;
    if (RAW.has(el.local)) {
      // Raw text up to the matching end tag. Script and style bodies are kept as text but never rendered.
      const close = src.toLowerCase().indexOf(`</${name}`, i);
      const t = src.slice(i, close < 0 ? n : close);
      if (t) el.children.push({ type: 'text', text: el.local === 'title' || el.local === 'textarea' ? decodeEntities(t) : t });
      const ce = close < 0 ? -1 : src.indexOf('>', close);
      i = ce < 0 ? n : ce + 1;
      continue;
    }
    stack.push(el);
  }
  return root;
}

function attr(el, ...names) {
  if (!el || !el.attrs) return undefined;
  for (const nm of names) {
    for (const k of Object.keys(el.attrs)) if (k.toLowerCase() === nm) return el.attrs[k];
  }
  return undefined;
}

/** All descendant elements with a given local name (any prefix). */
function findAll(node, local, out = []) {
  for (const c of node.children || []) {
    if (c.type !== 'el') continue;
    if (local === '*' || c.local === local) out.push(c);
    findAll(c, local, out);
  }
  return out;
}

function find(node, local) {
  for (const c of node.children || []) {
    if (c.type !== 'el') continue;
    if (c.local === local) return c;
    const r = find(c, local);
    if (r) return r;
  }
  return null;
}

function children(node, local) {
  return (node.children || []).filter((c) => c.type === 'el' && (!local || c.local === local));
}

function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  let s = '';
  for (const c of node.children || []) {
    if (c.type === 'el' && (c.local === 'script' || c.local === 'style')) continue;
    s += textOf(c);
  }
  return s;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

module.exports = { parse, decodeEntities, attr, find, findAll, children, textOf, clean };
