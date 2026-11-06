// EPUB Reader webview. Book HTML arrives already cleaned by the extension host (allow-list sanitizer) and is
// parsed here with DOMParser, which never runs scripts. All UI text goes in with textContent, and styles go
// through CSSOM, so the strict CSP (no inline styles, no inline scripts) holds.
/* global acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const support = document.getElementById('zovo-support');
  const post = (m) => vscode.postMessage(m);

  // ---------- helpers ----------
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') e.textContent = v;
      else if (k === 'cls') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  function fold(s) {
    const l = s.toLowerCase();
    if (l.length === s.length) return l;
    let o = '';
    for (const c of s) { const x = c.toLowerCase(); o += x.length === c.length ? x : c; }
    return o;
  }
  const parseBook = (html) => new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
  const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,figure,img,tr,dt,dd,figcaption,hr,aside,math,table';
  const NOTE_TEXT = /^\s*[[(]?\s*(\d{1,4}|[*†‡§¶#]{1,3}|[a-z]|[ivxl]{1,6})\s*[\])]?\.?\s*$/i;

  // ---------- state ----------
  const st = {
    info: null, prefs: null, name: '', size: '', ms: 0, index: 0, page: 0, pages: 1, loaded: false, rendered: false,
    cache: new Map(), blockedBy: new Map(), waiting: new Map(), weights: [], cum: [], total: 1, blocked: {}, cover: '',
    seq: 0, query: '', results: null, resultAt: -1, side: 'toc', sideOpen: false, note: null, titles: [], posTimer: 0,
  };
  let ui = null;

  function requestChapter(i, purpose) {
    if (st.cache.has(i)) return Promise.resolve(st.cache.get(i));
    if (st.waiting.has(i)) return st.waiting.get(i).p;
    let res; let rej;
    const p = new Promise((a, b) => { res = a; rej = b; });
    st.waiting.set(i, { p, res, rej });
    post({ type: 'chapter', index: i, purpose: purpose || 'show' });
    return p;
  }

  // ---------- layout ----------
  function build() {
    const sel = (act, opts, title) => h('select', { 'data-act': act, title }, opts.map(([v, t]) => h('option', { value: v, text: t })));
    const btn = (act, text, title) => h('button', { 'data-act': act, title, 'aria-label': title, text });
    const toolbar = h('div', { cls: 'toolbar' },
      btn('toc', '☰', 'Contents'), btn('prev', '‹', 'Previous page (Left arrow)'), btn('next', '›', 'Next page (Right arrow)'),
      h('span', { cls: 'booktitle', text: (st.info.meta.title || st.name) }),
      h('span', { cls: 'spacer' }),
      h('input', { 'data-act': 'query', type: 'search', placeholder: 'Search in book', 'aria-label': 'Search in book', spellcheck: 'false' }),
      btn('smaller', 'A−', 'Smaller text'), btn('larger', 'A+', 'Larger text'),
      sel('flow', [['paged', 'Paged'], ['scrolled', 'Scrolled']], 'Page layout'),
      sel('theme', [['auto', 'Theme: VS Code'], ['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']], 'Reading theme'),
      btn('info', 'Info', 'Book details'), btn('export', 'Markdown', 'Export this chapter to Markdown'));
    const tabs = h('div', { cls: 'tabs', role: 'tablist' });
    for (const [k, t] of [['toc', 'Contents'], ['search', 'Search'], ['info', 'Info']]) tabs.append(h('button', { 'data-tab': k, text: t }));
    const side = h('aside', { cls: 'side' }, tabs, h('div', { cls: 'sidebody' }));
    const page = h('article', { cls: 'page book', id: 'page', lang: (st.info.meta.language || '').split(',')[0] || undefined });
    const viewport = h('div', { cls: 'viewport', id: 'viewport' }, page);
    const stage = h('div', { cls: 'stage' }, viewport, h('div', { cls: 'edge left', 'data-act': 'prev', title: 'Previous page' }), h('div', { cls: 'edge right', 'data-act': 'next', title: 'Next page' }));
    const status = h('div', { cls: 'status' }, h('span', { cls: 'where' }), h('span', { cls: 'msg', role: 'status' }), h('span', { cls: 'spacer' }), h('span', { cls: 'pageinfo' }), h('span', { cls: 'pct' }));
    const note = h('div', { cls: 'note-pop', hidden: true, role: 'dialog', 'aria-label': 'Footnote' });
    const root = h('div', { cls: 'reader' }, toolbar, h('div', { cls: 'main' }, side, stage), status, note);
    app.replaceChildren(root);
    if (support) status.append(support);
    ui = {
      root, toolbar, side, sidebody: side.querySelector('.sidebody'), tabs, page, viewport, stage, status, note,
      where: status.querySelector('.where'), msg: status.querySelector('.msg'), pageinfo: status.querySelector('.pageinfo'), pct: status.querySelector('.pct'),
      query: toolbar.querySelector('[data-act="query"]'), flow: toolbar.querySelector('[data-act="flow"]'), theme: toolbar.querySelector('[data-act="theme"]'),
    };
    toolbar.addEventListener('click', onToolbar);
    stage.addEventListener('click', onStageClick);
    tabs.addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) openSide(t.dataset.tab, true); });
    ui.flow.addEventListener('change', () => setPref('flow', ui.flow.value));
    ui.theme.addEventListener('change', () => setPref('theme', ui.theme.value));
    ui.query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(ui.query.value, e.shiftKey); }
      if (e.key === 'Escape') { ui.query.blur(); }
    });
    viewport.addEventListener('scroll', () => { if (st.prefs.flow === 'scrolled') { updateStatus(); savePosSoon(); } }, { passive: true });
    viewport.addEventListener('wheel', onWheel, { passive: false });
    new ResizeObserver(() => relayout()).observe(viewport);
  }

  function applyPrefs() {
    const p = st.prefs;
    ui.root.classList.toggle('flow-paged', p.flow === 'paged');
    ui.root.classList.toggle('flow-scrolled', p.flow === 'scrolled');
    for (const t of ['auto', 'light', 'sepia', 'dark']) ui.root.classList.toggle('theme-' + t, p.theme === t);
    ui.root.classList.toggle('font-sans', p.fontFamily === 'sans');
    ui.root.classList.toggle('notes-popup', p.footnotePopups !== false);
    ui.page.style.fontSize = p.fontSize + 'px';
    ui.flow.value = p.flow; ui.theme.value = p.theme;
  }

  function setPref(key, value) {
    if (st.prefs[key] === value) return;
    const keep = anchor();
    st.prefs[key] = value;
    applyPrefs();
    relayout(keep);
    post({ type: 'setPref', key, value });
  }

  function columns() {
    // One column, or two in a wide editor. Lines stay under about 36 em, wider space becomes margin.
    const vw = ui.viewport.clientWidth;
    const fs = st.prefs.fontSize;
    const cols = vw >= Math.max(1000, fs * 52) ? 2 : 1;
    let gap = vw < 520 ? 32 : 64;
    let colW = (vw - cols * gap) / cols;
    const maxCol = fs * 36;
    if (colW > maxCol) { gap = (vw - cols * maxCol) / cols; colW = maxCol; }
    return { vw, vh: ui.viewport.clientHeight, cols, gap, colW: Math.max(120, colW) };
  }

  /** Lay the chapter out again (font, size or mode changed) and stay at the same element. */
  function relayout(keep) {
    if (!ui || !st.loaded) return;
    const k = keep || anchor();
    const s = ui.page.style;
    if (st.prefs.flow === 'paged') {
      const c = columns();
      s.height = c.vh + 'px'; s.width = c.vw + 'px'; s.columnWidth = c.colW + 'px'; s.columnGap = c.gap + 'px';
      s.paddingLeft = s.paddingRight = (c.gap / 2) + 'px';
      s.setProperty('--page-h', c.vh + 'px');
      ui.viewport.scrollTop = 0;
      st.pages = countPages();
    } else {
      s.height = ''; s.width = ''; s.columnWidth = ''; s.columnGap = ''; s.paddingLeft = ''; s.paddingRight = '';
      s.setProperty('--page-h', ui.viewport.clientHeight + 'px');
      ui.viewport.scrollLeft = 0;
      st.pages = 1;
    }
    if (k) restore(k);
    updateStatus();
  }

  function countPages() {
    const end = ui.page.querySelector('.ep-end');
    if (!end) return 1;
    const vw = ui.viewport.clientWidth;
    const r = end.getBoundingClientRect();
    const vr = ui.viewport.getBoundingClientRect();
    return Math.max(1, Math.floor((r.left - vr.left + ui.viewport.scrollLeft - 1) / vw) + 1);
  }

  function blocks() { return Array.from(ui.page.querySelectorAll(BLOCKS)); }

  /** The first visible block element and how far through the chapter we are. */
  function anchor() {
    if (!ui || !st.loaded || !ui.page.firstChild) return null;
    const vr = ui.viewport.getBoundingClientRect();
    const list = blocks();
    let el = 0; let off = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (st.prefs.flow === 'paged' ? (r.right > vr.left + 2 && r.left < vr.right) : r.bottom > vr.top + 4) {
        el = i; off = r.height > 0 ? Math.max(0, Math.min(1, (vr.top - r.top) / r.height)) : 0; break;
      }
    }
    // off (how far into that element the top of the view is) keeps scrolled mode steady on relayout; not saved.
    return { index: st.index, el, frac: fraction(), off };
  }

  function fraction() {
    if (st.prefs.flow === 'paged') return st.pages > 1 ? Math.min(1, st.page / (st.pages - 1)) : 0;
    const v = ui.viewport; const max = v.scrollHeight - v.clientHeight;
    return max > 0 ? Math.min(1, v.scrollTop / max) : 0;
  }

  function goPage(n) {
    st.page = Math.max(0, Math.min(st.pages - 1, n));
    ui.viewport.scrollLeft = st.page * ui.viewport.clientWidth;
    updateStatus(); savePosSoon(); closeNote();
  }

  function pageOfRect(r) {
    const vr = ui.viewport.getBoundingClientRect();
    return Math.floor((r.left - vr.left + ui.viewport.scrollLeft + 1) / ui.viewport.clientWidth);
  }

  function scrollToRect(r) {
    if (st.prefs.flow === 'paged') goPage(pageOfRect(r));
    else { const vr = ui.viewport.getBoundingClientRect(); ui.viewport.scrollTop += r.top - vr.top - 24; }
  }

  function restore(k) {
    if (k.exact && st.prefs.flow === 'scrolled') { const v = ui.viewport; v.scrollTop = (k.frac || 0) * (v.scrollHeight - v.clientHeight); return; }
    const list = blocks();
    const el = list[Math.min(k.el || 0, list.length - 1)];
    if (st.prefs.flow === 'paged') {
      if (el && k.el) goPage(pageOfRect(el.getClientRects()[0] || el.getBoundingClientRect()));
      else goPage(Math.round((k.frac || 0) * (st.pages - 1)));
    } else if (el && (k.el || k.off)) {
      const r = el.getBoundingClientRect(); const vr = ui.viewport.getBoundingClientRect();
      if (k.off !== undefined) ui.viewport.scrollTop += r.top - vr.top + k.off * r.height; else scrollToRect(r);
    }
    else { const v = ui.viewport; v.scrollTop = (k.frac || 0) * (v.scrollHeight - v.clientHeight); }
  }

  // ---------- chapters ----------
  async function show(index, opts = {}) {
    const n = st.info.spine.length;
    if (index < 0 || index >= n) return;
    closeNote();
    let html;
    try { html = await requestChapter(index); } catch (e) { toast(e.message || String(e)); return; }
    const doc = parseBook(html);
    const end = h('span', { cls: 'ep-end', 'aria-hidden': 'true' });
    ui.page.replaceChildren(...Array.from(doc.body.childNodes), end);
    st.index = index; st.page = 0; st.loaded = true; st.blocked = st.blockedBy.get(index) || {};
    if (st.sideOpen && st.side === 'info') renderInfo();
    if (CSS.highlights) CSS.highlights.delete('search');
    await Promise.all(Array.from(ui.page.querySelectorAll('img')).map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
    relayout({ index, el: 0, frac: 0 });
    if (opts.frag) {
      const t = ui.page.querySelector('#' + CSS.escape(opts.frag));
      if (t) scrollToRect(t.getClientRects()[0] || t.getBoundingClientRect());
    } else if (opts.k !== undefined) {
      highlight(opts.query, opts.k);
    } else if (opts.at === 'end') {
      if (st.prefs.flow === 'paged') goPage(st.pages - 1); else ui.viewport.scrollTop = ui.viewport.scrollHeight;
    } else if (opts.el || opts.frac) restore(opts);
    else if (st.prefs.flow === 'scrolled') ui.viewport.scrollTop = 0;
    markToc();
    updateStatus();
    savePosSoon();
    if (!st.rendered) { st.rendered = true; post({ type: 'rendered' }); }
    // Read the next chapter ahead so page turns stay quick.
    if (index + 1 < n) requestChapter(index + 1).catch(() => {});
  }

  function next() {
    if (st.prefs.flow === 'paged' && st.page < st.pages - 1) { goPage(st.page + 1); return; }
    if (st.prefs.flow === 'scrolled') {
      const v = ui.viewport;
      if (v.scrollTop + v.clientHeight < v.scrollHeight - 4) { v.scrollTop += v.clientHeight - 40; return; }
    }
    if (st.index + 1 < st.info.spine.length) show(st.index + 1);
  }
  function prev() {
    if (st.prefs.flow === 'paged' && st.page > 0) { goPage(st.page - 1); return; }
    if (st.prefs.flow === 'scrolled' && ui.viewport.scrollTop > 4) { ui.viewport.scrollTop -= ui.viewport.clientHeight - 40; return; }
    if (st.index > 0) show(st.index - 1, { at: 'end' });
  }

  function chapterTitle(i) {
    return st.titles[i] || (st.info.spine[i] && st.info.spine[i].title) || `Section ${i + 1}`;
  }

  function updateStatus() {
    if (!ui || !st.loaded) return;
    const h1 = ui.page.querySelector('h1,h2,h3');
    if (!st.info.spine[st.index].title && h1 && !st.titles[st.index]) st.titles[st.index] = h1.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
    ui.where.textContent = chapterTitle(st.index);
    ui.pageinfo.textContent = st.prefs.flow === 'paged' ? `Page ${st.page + 1} of ${st.pages}` : '';
    const f = fraction();
    const pct = Math.min(100, Math.round(((st.cum[st.index] || 0) + f * (st.weights[st.index] || 0)) / st.total * 100));
    ui.pct.textContent = `${pct}%`;
    ui.pct.title = `Chapter ${st.index + 1} of ${st.info.spine.length}`;
  }

  function savePosSoon() {
    clearTimeout(st.posTimer);
    st.posTimer = setTimeout(() => { const a = anchor(); if (a) post({ type: 'position', index: a.index, el: a.el, frac: a.frac }); }, 400);
  }

  // ---------- side panel ----------
  function openSide(tab, toggle) {
    if (toggle && st.sideOpen && st.side === tab) { st.sideOpen = false; } else { st.sideOpen = true; st.side = tab; }
    ui.root.classList.toggle('side-open', st.sideOpen);
    for (const b of ui.tabs.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === st.side);
    if (st.side === 'toc') renderToc();
    if (st.side === 'search') renderResults();
    if (st.side === 'info') renderInfo();
    requestAnimationFrame(() => relayout());
  }

  function renderToc() {
    const mk = (list, depth) => h('ul', { cls: 'toc-list' }, list.map((e) => h('li', {},
      e.index >= 0
        ? h('button', { cls: 'toc-item', 'data-index': String(e.index), 'data-frag': e.frag ? 'e-' + e.frag.replace(/[^\w\-.:]/g, '_') : '', title: e.label, text: e.label })
        : h('span', { cls: 'toc-part', text: e.label }),
      e.children && e.children.length ? mk(e.children, depth + 1) : null)));
    const toc = st.info.toc.length ? st.info.toc : st.info.spine.map((s, i) => ({ label: chapterTitle(i), index: i, frag: '', children: [] }));
    const body = h('div', { cls: 'toc' }, mk(toc, 0));
    body.addEventListener('click', (e) => {
      const b = e.target.closest('.toc-item');
      if (b) show(Number(b.dataset.index), { frag: b.dataset.frag || undefined });
    });
    ui.sidebody.replaceChildren(body);
    markToc();
  }

  function markToc() {
    if (!ui || st.side !== 'toc') return;
    let first = true;
    for (const b of ui.sidebody.querySelectorAll('.toc-item')) {
      const on = Number(b.dataset.index) === st.index && !b.dataset.frag && first;
      if (on) first = false;
      b.classList.toggle('current', on);
    }
  }

  function renderInfo() {
    const m = st.info.meta;
    const rows = [
      ['Title', m.title], ['Subtitle', m.subtitle], ['Author', m.authors.join(', ')], ['Contributors', m.contributors.join(', ')],
      ['Language', m.language], ['ISBN', m.isbn], ['Identifier', m.identifier !== m.isbn && m.identifier !== `urn:isbn:${m.isbn}` ? m.identifier : ''],
      ['Publisher', m.publisher], ['Published', m.date], ['Modified', m.modified], ['Subjects', m.subjects.join(', ')], ['Rights', m.rights],
      ['EPUB version', st.info.version], ['Layout', m.layout === 'pre-paginated' ? 'Fixed layout (shown as reflowable text)' : ''],
      ['Chapters', String(st.info.spine.length)], ['Contents from', { nav: 'EPUB 3 nav document', ncx: 'EPUB 2 NCX', spine: 'reading order (the book has no table of contents)' }[st.info.tocSource] || ''],
      ['File', `${st.name}, ${st.size}`], ['Opened in', `${st.ms} ms`],
    ].filter((r) => r[1]);
    const b = st.blocked || {};
    const blockedText = [['scripts', 'script'], ['remote', 'remote resource'], ['styles', 'style sheet'], ['handlers', 'event handler'], ['forms', 'form control'], ['media', 'audio or video element']]
      .filter(([k]) => b[k]).map(([k, w]) => `${b[k]} ${w}${b[k] > 1 ? 's' : ''}`).join(', ');
    const body = h('div', { cls: 'info' },
      st.cover ? h('img', { cls: 'cover', src: st.cover, alt: 'Cover' }) : null,
      h('dl', {}, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      m.description ? h('p', { cls: 'desc', text: m.description }) : null,
      h('p', { cls: 'blocked', text: blockedText ? `Blocked in this chapter: ${blockedText}. Book scripts never run, and nothing is loaded from the internet.` : 'Book scripts never run, and nothing is loaded from the internet.' }));
    ui.sidebody.replaceChildren(body);
  }

  // ---------- search ----------
  function runSearch(q, back) {
    const query = q.trim();
    if (!query) return;
    if (st.results && st.query === query && st.results.results.length) {
      const n = st.results.results.length;
      st.resultAt = (st.resultAt + (back ? n - 1 : 1)) % n;
      goResult(st.resultAt);
      return;
    }
    st.query = query; st.results = null; st.resultAt = -1; st.seq++;
    openSide('search');
    post({ type: 'search', query, seq: st.seq });
  }

  function renderResults() {
    if (!st.query) { ui.sidebody.replaceChildren(h('p', { cls: 'hint', text: 'Type in the search box and press Enter. Press Enter again for the next result.' })); return; }
    if (!st.results) { ui.sidebody.replaceChildren(h('p', { cls: 'hint', text: `Searching for “${st.query}”...` })); return; }
    const r = st.results;
    const chapters = new Set(r.results.map((x) => x.index)).size;
    const head = h('p', { cls: 'hint', text: r.total ? `${r.total} result${r.total > 1 ? 's' : ''} in ${chapters} chapter${chapters > 1 ? 's' : ''}${r.truncated ? ` (first ${r.results.length} shown)` : ''}` : `No results for “${st.query}”.` });
    const list = h('ol', { cls: 'results' }, r.results.map((x, i) => h('li', {}, h('button', { cls: 'result' + (i === st.resultAt ? ' current' : ''), 'data-i': String(i) },
      h('span', { cls: 'rtitle', text: x.title || chapterTitle(x.index) }),
      h('span', { cls: 'snip' }, x.before, h('mark', { text: x.match }), x.after)))));
    list.addEventListener('click', (e) => { const b = e.target.closest('.result'); if (b) { st.resultAt = Number(b.dataset.i); goResult(st.resultAt); } });
    ui.sidebody.replaceChildren(head, list);
  }

  function goResult(i) {
    const x = st.results.results[i];
    if (!x) return;
    for (const b of ui.sidebody.querySelectorAll('.result')) b.classList.toggle('current', Number(b.dataset.i) === i);
    if (x.index === st.index) highlight(st.query, x.k); else show(x.index, { query: st.query, k: x.k });
    toast(`Result ${i + 1} of ${st.results.results.length}`);
  }

  /** Highlight the k-th match in the shown chapter and turn to its page. */
  function highlight(query, k) {
    const q = fold(query);
    const walker = document.createTreeWalker(ui.page, NodeFilter.SHOW_TEXT);
    const nodes = []; let text = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, text.length]); text += n.nodeValue; }
    const f = fold(text);
    let at = -1;
    for (let i = 0, from = 0; i <= k; i++) { at = f.indexOf(q, from); if (at < 0) break; from = at + q.length; }
    if (at < 0) return false;
    const locate = (pos) => { let lo = 0; for (let i = 0; i < nodes.length; i++) if (nodes[i][1] <= pos) lo = i; else break; return [nodes[lo][0], pos - nodes[lo][1]]; };
    const range = document.createRange();
    const [sn, so] = locate(at); const [en, eo] = locate(at + q.length - 1);
    range.setStart(sn, so); range.setEnd(en, eo + 1);
    if (CSS.highlights && typeof Highlight === 'function') CSS.highlights.set('search', new Highlight(range));
    scrollToRect(range.getClientRects()[0] || range.getBoundingClientRect());
    st.hl = { query, k };
    return true;
  }

  // ---------- footnotes ----------
  function isNoteRef(a) {
    const t = a.getAttribute('data-epub-type') || '';
    if (/\bnoteref\b/.test(t) || /doc-noteref/.test(a.getAttribute('role') || '') || a.hasAttribute('data-note-class')) return true;
    return NOTE_TEXT.test(a.textContent || '') && (!!a.closest('sup') || !!a.querySelector('sup') || /^\s*[[(]?\d{1,4}[\])]?\s*$/.test(a.textContent));
  }

  function noteBlock(el) {
    if (!el) return null;
    if (/^(ASIDE|LI|P|DD|BLOCKQUOTE|DIV|SECTION)$/.test(el.tagName) && (el.textContent || '').trim().length > 3) return el;
    const b = el.closest('aside,li,p,dd,dt,blockquote,div');
    return b && b !== ui.page ? b : el.parentElement;
  }

  async function showNote(a, index, frag) {
    let target = null; let hiddenTarget = false;
    if (index === st.index) target = ui.page.querySelector('#' + CSS.escape(frag));
    else {
      try { const doc = parseBook(await requestChapter(index, 'note')); target = doc.getElementById(frag); } catch { target = null; }
    }
    const block = noteBlock(target);
    if (!block) { show(index, { frag }); return; }
    hiddenTarget = !!block.closest('aside[data-epub-type~="footnote"]');
    const clone = block.cloneNode(true);
    for (const x of clone.querySelectorAll('[id]')) x.removeAttribute('id');
    clone.removeAttribute('id');
    // A back-link in the note ("1.") would only jump to where the reader already is: keep it as plain text.
    for (const x of clone.querySelectorAll('a[data-to]')) { const s = document.createElement('span'); s.textContent = x.textContent; x.replaceWith(s); }
    const body = h('div', { cls: 'note-body book' }, clone);
    const close = h('button', { cls: 'note-close', title: 'Close (Escape)', 'aria-label': 'Close', text: '×', onclick: closeNote });
    const go = hiddenTarget ? null : h('button', { cls: 'note-go', text: index === st.index ? 'Go to the note' : `Go to the note in ${chapterTitle(index)}`, onclick: () => { closeNote(); show(index, { frag }); } });
    ui.note.replaceChildren(...[close, body, go].filter(Boolean));
    ui.note.hidden = false;
    const r = a.getBoundingClientRect();
    const W = Math.min(440, window.innerWidth - 24);
    const x = Math.max(12, Math.min(window.innerWidth - W - 12, r.left - 40));
    ui.note.style.width = W + 'px';
    ui.note.style.left = x + 'px';
    const below = r.bottom + 8;
    ui.note.style.top = '0px';
    const ht = ui.note.getBoundingClientRect().height;
    ui.note.style.top = (below + ht > window.innerHeight - 30 ? Math.max(8, r.top - ht - 8) : below) + 'px';
    st.note = { index, frag, text: body.textContent.trim().slice(0, 300) };
  }

  function closeNote() { if (ui && !ui.note.hidden) { ui.note.hidden = true; st.note = null; } }

  // ---------- events ----------
  function onToolbar(e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'toc') openSide('toc', true);
    else if (act === 'info') openSide('info', true);
    else if (act === 'prev') prev();
    else if (act === 'next') next();
    else if (act === 'smaller') setPref('fontSize', Math.max(10, st.prefs.fontSize - 2));
    else if (act === 'larger') setPref('fontSize', Math.min(40, st.prefs.fontSize + 2));
    else if (act === 'export') { post({ type: 'exportMarkdown', index: st.index }); toast('Exporting this chapter...'); }
  }

  function onStageClick(e) {
    const edge = e.target.closest('.edge');
    if (edge) { if (edge.dataset.act === 'next') next(); else prev(); return; }
    const a = e.target.closest('a');
    if (a && ui.page.contains(a)) {
      e.preventDefault();
      const ext = a.getAttribute('data-ext');
      if (ext) { post({ type: 'openExternal', url: ext }); return; }
      const to = a.getAttribute('data-to');
      if (!to) return;
      const hash = to.indexOf('#');
      const index = Number(to.slice(0, hash)); const frag = to.slice(hash + 1);
      if (frag && st.prefs.footnotePopups !== false && isNoteRef(a)) { showNote(a, index, frag); return; }
      if (index === st.index && frag) { const t = ui.page.querySelector('#' + CSS.escape(frag)); if (t) scrollToRect(t.getClientRects()[0] || t.getBoundingClientRect()); return; }
      show(index, { frag: frag || undefined });
      return;
    }
    if (!ui.note.hidden && !ui.note.contains(e.target)) closeNote();
  }

  let wheelLock = 0; let wheelSum = 0;
  function onWheel(e) {
    if (st.prefs.flow !== 'paged') return;
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Date.now() < wheelLock) return;
    wheelSum += d;
    if (Math.abs(wheelSum) < 40) return;
    if (wheelSum > 0) next(); else prev();
    wheelSum = 0; wheelLock = Date.now() + 350;
  }

  document.addEventListener('keydown', (e) => {
    if (!ui || !st.loaded) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); ui.query.focus(); ui.query.select(); return; }
    if (e.key === 'Escape') { if (!ui.note.hidden) closeNote(); else if (st.sideOpen) openSide(st.side, true); return; }
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.altKey || e.ctrlKey || e.metaKey) return;
    const paged = st.prefs.flow === 'paged';
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey && paged)) { e.preventDefault(); if (paged || e.key === 'PageDown') next(); else if (st.index + 1 < st.info.spine.length) show(st.index + 1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey && paged)) { e.preventDefault(); if (paged || e.key === 'PageUp') prev(); else if (st.index > 0) show(st.index - 1); return; }
    if (e.key === 'Home' && paged) { e.preventDefault(); goPage(0); return; }
    if (e.key === 'End' && paged) { e.preventDefault(); goPage(st.pages - 1); }
  });

  function toast(text) {
    if (!ui) return;
    ui.msg.textContent = text;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { ui.msg.textContent = ''; }, 5000);
  }

  function message(title, text, reopen) {
    app.replaceChildren(h('div', { cls: 'message' }, h('h2', { text: title }), h('p', { text }),
      reopen ? h('button', { text: 'Reopen with another editor', onclick: () => post({ type: 'reopenWith' }) }) : null));
    if (support) app.append(support);
  }

  // ---------- messages from the extension ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'init') {
      const first = !ui;
      st.info = m.info; st.prefs = m.prefs; st.name = m.name; st.size = m.sizeText; st.ms = m.ms;
      st.cache.clear(); st.titles = [];
      for (const w of st.waiting.values()) w.rej(new Error('The book was reloaded.'));
      st.waiting.clear();
      st.weights = st.info.spine.map((s) => Math.max(1, s.size || 1));
      st.cum = []; let c = 0; for (const w of st.weights) { st.cum.push(c); c += w; } st.total = c || 1;
      build(); applyPrefs();
      const pos = m.position;
      const startAt = pos ? pos.index : Math.max(0, st.info.spine.findIndex((s) => s.linear !== false));
      if (first && st.info.toc.length && !pos) openSide('toc');
      show(startAt, pos ? { el: pos.el, frac: pos.frac, exact: true } : {});
      return;
    }
    if (m.type === 'chapter') {
      st.cache.set(m.index, m.html);
      if (st.cache.size > 10) { const k = st.cache.keys().next().value; if (k !== st.index) st.cache.delete(k); }
      st.blockedBy.set(m.index, m.blocked || {});
      const w = st.waiting.get(m.index);
      if (w) { st.waiting.delete(m.index); w.res(m.html); }
      return;
    }
    if (m.type === 'cover') { st.cover = m.url; if (st.side === 'info' && st.sideOpen) renderInfo(); return; }
    if (m.type === 'searchResults') {
      if (m.seq !== st.seq) return;
      st.results = m; st.resultAt = -1;
      if (st.side === 'search') renderResults();
      if (m.results.length) { st.resultAt = 0; goResult(0); }
      return;
    }
    if (m.type === 'prefs') {
      if (!st.prefs) return;
      const keep = anchor();
      const changed = JSON.stringify(m.prefs) !== JSON.stringify(st.prefs);
      st.prefs = m.prefs; applyPrefs();
      if (changed) relayout(keep);
      return;
    }
    if (m.type === 'command') {
      if (!ui) return;
      if (m.action === 'search') { ui.query.focus(); ui.query.select(); }
      if (m.action === 'info') openSide('info');
      if (m.action === 'export') { post({ type: 'exportMarkdown', index: st.index }); toast('Exporting this chapter...'); }
      return;
    }
    if (m.type === 'exported') { toast(m.untitled ? 'The chapter opened as a new Markdown file.' : `Saved ${m.path}${m.images ? ` and ${m.images} image${m.images > 1 ? 's' : ''}` : ''}.`); return; }
    if (m.type === 'changed') { toast('The book changed on disk. Reloading...'); return; }
    if (m.type === 'tooBig') { message('This book is too large', m.message, true); return; }
    if (m.type === 'error') {
      for (const w of st.waiting.values()) w.rej(new Error(m.message));
      st.waiting.clear();
      if (m.soft && ui) { toast(m.message); return; }
      message('This file could not be opened', m.message, true);
    }
  });

  // A small read-only probe for the release check script.
  window.epubReaderProbe = () => ({
    loaded: st.loaded, index: st.index, page: st.page, pages: st.pages, chapters: st.info ? st.info.spine.length : 0,
    flow: st.prefs && st.prefs.flow, theme: st.prefs && st.prefs.theme, fontSize: st.prefs && st.prefs.fontSize,
    where: ui ? ui.where.textContent : '', pct: ui ? ui.pct.textContent : '', pageinfo: ui ? ui.pageinfo.textContent : '',
    side: st.sideOpen ? st.side : '', results: st.results ? st.results.total : null, resultAt: st.resultAt,
    highlight: !!(window.CSS && CSS.highlights && CSS.highlights.has('search')), note: st.note,
    images: ui ? Array.from(ui.page.querySelectorAll('img')).map((i) => ({ ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth, alt: i.alt })) : [],
    scripts: ui ? ui.page.querySelectorAll('script').length : 0, blocked: st.blocked, msg: ui ? ui.msg.textContent : '',
    scrollTop: ui ? ui.viewport.scrollTop : 0, scrollLeft: ui ? ui.viewport.scrollLeft : 0,
  });

  post({ type: 'ready' });
}());
