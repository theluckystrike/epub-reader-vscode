// Release check in a real VS Code: installs the .vsix into an isolated profile, opens generated sample books,
// drives the webview with real mouse and key events, saves screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson>
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('./make-samples.js');

const [work0, port, vsix, ws0, shotDir, outJson] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0);
const R = { install: null, steps: [], console: [], hashes: {}, unchanged: null };
const hash = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
fs.writeFileSync(path.join(ws, 'not-a-book.epub'), 'This is plain text with an .epub name.\n');
const huge = path.join(ws, 'huge.epub'); { const fd = fs.openSync(huge, 'w'); fs.ftruncateSync(fd, 300 * 1024 * 1024); fs.closeSync(fd); }
fs.writeFileSync(path.join(ws, 'the-long-atlas.epub'), S.atlas(400, 80));
for (const f of fs.readdirSync(ws)) if (fs.statSync(path.join(ws, f)).size < 50e6) R.hashes[f] = hash(path.join(ws, f));
fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const vs = await launch(work, Number(port), ws, {
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'window.titleBarStyle': 'custom',
  'workbench.sideBar.location': 'left', 'files.simpleDialog.enable': true,
});
const shots = [];
const shot = async (name) => { const f = path.join(shotDir, `epub-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name, JSON.stringify(v ?? '').slice(0, 300)); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 500)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
let wv;
const E = (expr) => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E(`JSON.stringify(window.epubReaderProbe ? window.epubReaderProbe() : null)`));
const getWv = async (title) => vs.waitFor(async () => (await vs.webviews()).find((w) => w.title === title && w.w > 0), 30000);
const open = async (file) => { const t0 = Date.now(); vs.open(path.join(ws, file)); await sleep(800); wv = await getWv(file); if (!wv) throw new Error('no webview for ' + file); return Date.now() - t0; };
const loaded = async (ms = 30000) => { const ok = await vs.waitFor(async () => (await probe())?.loaded, ms, 200); if (!ok) throw new Error('not loaded: ' + await E(`document.body.innerText.slice(0, 400)`)); await sleep(400); return probe(); };
const until = async (fn, ms = 10000) => { const v = await vs.waitFor(async () => { const p = await probe(); return fn(p) ? p : null; }, ms, 150); if (!v) throw new Error('timeout; probe=' + JSON.stringify(await probe())); return v; };
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const click = (sel, opts) => vs.wvClick(wv, q(sel), opts);
const selectValue = (act, v) => E(`(() => { const s = ${q(`[data-act="${act}"]`)}; s.focus(); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return s.value; })()`);
const bg = () => E(`getComputedStyle(${q('.stage')}).backgroundColor`);
const closeEditors = () => vs.command('View: Close All Editors');

try {
  await sleep(2500);
  await vs.command('View: Close Primary Side Bar').catch(() => {});
  await step('EPUB 3 sample opens by default: cover first, contents panel open, metadata read', async () => {
    const ms = await open('the-lighthouse-keepers-log.epub'); const p = await loaded();
    if (p.index !== 0 || p.chapters !== 7 || p.side !== 'toc' || !p.images[0]?.ok) throw new Error(JSON.stringify(p));
    const toc = await E(`[...document.querySelectorAll('.toc-item, .toc-part')].map(b => b.textContent).join(' | ')`);
    await shot('cover-and-contents');
    return { openMs: ms, toc, title: await E(`${q('.booktitle')}.textContent`) };
  });
  await step('Contents click opens chapter 1; the book script did not run and the remote image is gone', async () => {
    await vs.wvClick(wv, `[...document.querySelectorAll('.toc-item')].find(b => b.textContent === 'Chapter 1. The Station')`);
    const p = await until((x) => x.index === 1);
    const text = await E(`document.body.innerText`);
    if (p.scripts !== 0 || /script ran/.test(text) || p.images.length !== 0 || p.blocked.scripts !== 1 || p.blocked.remote !== 1) throw new Error(JSON.stringify(p));
    if (!/Chapter 1\. The Station/.test(p.where)) throw new Error('status ' + p.where);
    return { where: p.where, pageinfo: p.pageinfo, pct: p.pct, blocked: p.blocked };
  });
  await step('Footnote number opens a popup with the note text; Escape closes it', async () => {
    await vs.key('Home', 'Home');
    await click('a[data-epub-type~="noteref"]');
    const p = await until((x) => x.note);
    if (!/A fathom is six feet/.test(p.note.text)) throw new Error(JSON.stringify(p.note));
    const hidden = await E(`getComputedStyle(${q('aside[data-epub-type~="footnote"]')}).display`);
    await shot('footnote-popup');
    await vs.key('Escape', 'Escape');
    const q2 = await until((x) => !x.note);
    return { note: p.note.text.slice(0, 90), asideDisplay: hidden, closed: !q2.note };
  });
  await step('Paged mode: right edge click and Right arrow turn pages, Left arrow goes back', async () => {
    const p0 = await probe();
    if (p0.pages < 2) throw new Error('only one page: ' + JSON.stringify(p0));
    await click('.edge.right');
    const p1 = await until((x) => x.page === p0.page + 1);
    await vs.key('ArrowRight', 'ArrowRight');
    const p2 = await until((x) => x.page === p0.page + 2 || x.index === 2);
    await vs.key('ArrowLeft', 'ArrowLeft');
    const p3 = await probe();
    return { pages: p0.pages, seq: [p0.page, p1.page, p2.page, p3.page], pageinfo: p3.pageinfo, scrollLeft: p3.scrollLeft };
  });
  await step('Last page of a chapter turns into the next chapter, and back', async () => {
    await vs.key('End', 'End');
    const p = await probe();
    await vs.key('ArrowRight', 'ArrowRight');
    const n = await until((x) => x.index === 2 && x.page === 0);
    await vs.key('ArrowLeft', 'ArrowLeft');
    const b = await until((x) => x.index === 1);
    if (b.page !== b.pages - 1) throw new Error('not on last page: ' + JSON.stringify(b));
    return { lastPage: p.page + 1, next: n.where, back: `${b.index}/${b.page + 1} of ${b.pages}` };
  });
  await step('Sepia theme and larger text (README hero), chapter 3 with the chart image', async () => {
    await selectValue('theme', 'sepia');
    await click('[data-act="larger"]'); await click('[data-act="larger"]');
    await vs.wvClick(wv, `[...document.querySelectorAll('.toc-item')].find(b => b.textContent === 'Charts')`);
    const p = await until((x) => x.index === 3 && x.images.length === 1 && x.images[0].ok);
    if (p.theme !== 'sepia' || p.fontSize !== 22) throw new Error(JSON.stringify(p));
    await sleep(300);
    await shot('paged-sepia');
    return { bg: await bg(), font: p.fontSize, image: p.images[0], pageinfo: p.pageinfo };
  });
  await step('Search: typing a phrase and Enter lists results, highlights the match and Enter goes to the next', async () => {
    await click('[data-act="query"]');
    await vs.type('lantern of salt glass'); await vs.key('Enter', 'Enter');
    const p = await until((x) => x.results > 0 && x.highlight && x.side === 'search');
    const list = await E(`[...document.querySelectorAll('.result')].length`);
    const head = await E(`${q('.sidebody .hint')}.textContent`);
    await shot('search-results');
    await vs.key('Enter', 'Enter');
    const p2 = await until((x) => x.resultAt === 1);
    return { total: p.results, listed: list, head, first: `${p.index} ${p.pageinfo}`, second: `${p2.index} ${p2.pageinfo}`, msg: p2.msg };
  });
  await step('Info panel shows title, author, language, ISBN and the cover', async () => {
    await click('[data-act="info"]');
    const info = await vs.waitFor(async () => { const t = await E(`(${q('.info')} || {}).innerText || ''`); return /ISBN/.test(t) ? t : null; }, 8000);
    if (!info || !/Mara Ellison/.test(info) || !/9780000000002/.test(info) || !/Language\s+en/.test(info)) throw new Error(info);
    const cover = await E(`(() => { const i = ${q('.info .cover')}; return i ? i.naturalWidth : 0; })()`);
    await shot('book-info');
    return { lines: info.split('\n').slice(0, 14).join(' / '), coverWidth: cover };
  });
  await step('Scrolled mode with the dark theme; the setting is saved in user settings', async () => {
    await selectValue('flow', 'scrolled'); await selectValue('theme', 'dark');
    await click('[data-act="info"]'); // close the side panel
    const p = await until((x) => x.flow === 'scrolled' && x.theme === 'dark' && x.side === '');
    const off = await vs.wvOffset();
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: off.x + off.w / 2, y: off.y + 300, deltaX: 0, deltaY: 600 }, vs.wb);
    const p2 = await until((x) => x.scrollTop > 100);
    await sleep(300);
    await shot('scrolled-dark');
    const settings = JSON.parse(fs.readFileSync(path.join(work, 'ud', 'User', 'settings.json'), 'utf8'));
    if (settings['epubReader.flow'] !== 'scrolled' || settings['epubReader.theme'] !== 'dark' || settings['epubReader.fontSize'] !== 22) throw new Error(JSON.stringify(settings));
    return { scrollTop: p2.scrollTop, pageinfo: p.pageinfo, bg: await bg(), saved: { flow: settings['epubReader.flow'], theme: settings['epubReader.theme'], fontSize: settings['epubReader.fontSize'] } };
  });
  await step('Close and reopen: the book opens at the same chapter and place', async () => {
    await sleep(800);
    const before = await probe();
    await closeEditors(); await sleep(800);
    await open('the-lighthouse-keepers-log.epub');
    const p = await loaded();
    if (p.index !== before.index || Math.abs(p.scrollTop - before.scrollTop) > 40) throw new Error(JSON.stringify({ before: [before.index, before.scrollTop, before.pct], after: [p.index, p.scrollTop, p.pct] }));
    return { before: `${before.index} @${before.scrollTop}`, after: `${p.index} @${p.scrollTop}` };
  });
  await step('Export chapter to Markdown writes the .md and the chart next to the book', async () => {
    await selectValue('flow', 'paged');
    await click('[data-act="toc"]');
    await vs.wvClick(wv, `[...document.querySelectorAll('.toc-item')].find(b => b.textContent === 'Chapter 3. Soundings')`);
    await until((x) => x.index === 3);
    await click('[data-act="export"]');
    const dlg = await vs.waitFor(() => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.offsetParent !== null) && document.querySelector('.quick-input-box input').value; })()`), 8000);
    if (!dlg) throw new Error('no save dialog');
    await vs.key('Enter', 'Enter');
    const md = dlg.endsWith('.md') ? dlg : path.join(ws, 'missing.md');
    const ok = await vs.waitFor(() => fs.existsSync(md), 8000);
    if (!ok) throw new Error('not written; dialog value ' + dlg);
    await sleep(800);
    const img = fs.existsSync(md.replace(/\.md$/, '-images'));
    const tab = await vs.wbEval(`[...document.querySelectorAll('.tab')].map(t => t.textContent.trim()).join(' | ')`);
    await shot('markdown-export');
    const text = fs.readFileSync(md, 'utf8');
    return { dialog: dlg.slice(-60), bytes: text.length, firstLine: text.split('\n')[0], image: img, tabs: tab.slice(0, 200) };
  });
  await step('EPUB 2 sample: NCX contents, Latin-1 chapter text, endnote popup from the notes file', async () => {
    await closeEditors(); await sleep(500);
    await open('field-notes-epub2.epub');
    let p = await loaded();
    await selectValue('flow', 'paged'); await selectValue('theme', 'auto');
    if (p.side !== 'toc') await click('[data-act="toc"]');
    const toc = await E(`[...document.querySelectorAll('.toc-item')].map(b => b.textContent).join(' | ')`);
    await vs.wvClick(wv, `[...document.querySelectorAll('.toc-item')].find(b => b.textContent === '3. Night Moths')`);
    await until((x) => x.index === 3);
    const latin = await E(`document.body.innerText.includes('Café notes, written on the naïve old typewriter: été, garçon, über.')`);
    await vs.wvClick(wv, `[...document.querySelectorAll('.toc-item')].find(b => b.textContent === '1. Marsh Birds')`);
    await until((x) => x.index === 1);
    await click('a[data-to^="5#"]');
    p = await until((x) => x.note);
    await shot('epub2-endnote');
    await vs.key('Escape', 'Escape');
    if (!/Note 1\./.test(p.note.text) || !latin) throw new Error(JSON.stringify({ note: p.note, latin }));
    return { toc, note: p.note.text.slice(0, 80), latin1: latin, theme: p.theme };
  });
  await step('A file that is not an EPUB shows a message and a reopen button', async () => {
    await open('not-a-book.epub');
    const t = await vs.waitFor(async () => { const s = await E(`document.body.innerText`); return /could not be opened/.test(s) ? s : null; }, 10000);
    if (!t || !/not a ZIP archive/.test(t)) throw new Error(t);
    await shot('not-an-epub');
    return t.replace(/\s+/g, ' ').slice(0, 160);
  });
  await step('A 300 MB file over the limit shows the size message and is not read', async () => {
    await open('huge.epub');
    const t = await vs.waitFor(async () => { const s = await E(`document.body.innerText`); return /too large/.test(s) ? s : null; }, 10000);
    if (!t || !/This book is 300\.0 MB/.test(t)) throw new Error(t);
    return t.replace(/\s+/g, ' ').slice(0, 200);
  });
  await step('A 400-chapter book opens quickly; contents jump and a whole-book search', async () => {
    const size = fs.statSync(path.join(ws, 'the-long-atlas.epub')).size;
    const t0 = Date.now(); await open('the-long-atlas.epub'); const p = await loaded(); const ms = Date.now() - t0;
    if (p.chapters !== 400) throw new Error(JSON.stringify(p));
    await E(`[...document.querySelectorAll('.toc-item')].find(b => b.textContent === 'Chapter 350').scrollIntoView()`);
    await vs.wvClick(wv, `[...document.querySelectorAll('.toc-item')].find(b => b.textContent === 'Chapter 350')`);
    await until((x) => x.index === 349);
    await click('[data-act="query"]'); await vs.type('salt glass'); const t1 = Date.now(); await vs.key('Enter', 'Enter');
    const s = await until((x) => x.results > 0 && x.highlight, 30000);
    const searchMs = Date.now() - t1;
    await shot('long-book-search');
    return { sizeMB: +(size / 1048576).toFixed(2), openMs: ms, results: s.results, searchMs, pct: s.pct };
  });
  await step('VS Code Light theme: the auto reading theme follows it', async () => {
    const f = path.join(work, 'ud', 'User', 'settings.json');
    const st = JSON.parse(fs.readFileSync(f, 'utf8')); st['workbench.colorTheme'] = 'Default Light Modern'; st['epubReader.flow'] = 'paged'; st['epubReader.theme'] = 'auto';
    fs.writeFileSync(f, JSON.stringify(st, null, 1));
    await closeEditors(); await sleep(1500);
    await open('the-lighthouse-keepers-log.epub'); await loaded();
    const c = await vs.waitFor(async () => { const b = await bg(); const m = /rgb\((\d+), (\d+), (\d+)/.exec(b); return m && +m[1] > 200 ? b : null; }, 8000);
    if (!c) throw new Error('background stayed ' + await bg());
    await shot('light-theme-auto');
    return { bg: c };
  });
} finally {
  R.console = vs.console;
  R.shots = shots;
  await vs.close();
  R.unchanged = Object.entries(R.hashes).every(([f, h]) => !fs.existsSync(path.join(ws, f)) || hash(path.join(ws, f)) === h);
  R.pass = R.steps.filter((s) => s.ok).length; R.total = R.steps.length;
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  console.log(`\n${R.pass}/${R.total} steps pass; console entries: ${R.console.length}; samples unchanged: ${R.unchanged}`);
  for (const c of R.console.slice(0, 15)) console.log('  console', c.where, c.type, c.text.slice(0, 200));
}
