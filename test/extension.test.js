'use strict';
// The extension host on a mocked VS Code API with the generated sample books.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const M = require('../scripts/make-samples.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-ext-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(__dirname, '..');
const light = path.join(tmp, 'light.epub'); fs.writeFileSync(light, M.lighthouse());
const notes = path.join(tmp, 'notes.epub'); fs.writeFileSync(notes, M.fieldNotes());
const junk = path.join(tmp, 'junk.epub'); fs.writeFileSync(junk, 'this is not a zip file at all');

const state = { config: {}, updates: [], sizeOverride: null, reads: 0, commands: [], watchers: [], written: new Map(), dirs: [], saveTo: null, shown: [], external: [], untitled: [], cfgHandlers: [] };
function uriOf(p, scheme = 'file') { return { scheme, fsPath: p, path: p, with(o) { return uriOf(o.path || p, scheme); }, toString() { return scheme + '://' + p; } }; }
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.posix.join(u.path, ...s), u.scheme), parse: (s) => ({ parsed: s, toString: () => s }) },
  ViewColumn: { Beside: -2 }, ConfigurationTarget: { Global: 1 },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d), update: async (k, v, t) => { state.updates.push([k, v, t]); } }),
    onDidChangeConfiguration: (h) => { state.cfgHandlers.push(h); return { dispose() { state.cfgHandlers = state.cfgHandlers.filter((x) => x !== h); } }; },
    createFileSystemWatcher: (p) => { const w = { p, on: {}, onDidChange(h) { w.on.change = h; }, onDidCreate(h) { w.on.create = h; }, dispose() { w.disposed = true; } }; state.watchers.push(w); return w; },
    fs: {
      stat: async (u) => ({ size: state.sizeOverride ?? fs.statSync(u.fsPath).size }),
      readFile: async (u) => { state.reads++; return fs.readFileSync(u.fsPath); },
      writeFile: async (u, data) => { state.written.set(u.fsPath, Buffer.from(data)); },
      createDirectory: async (u) => { state.dirs.push(u.fsPath); },
    },
    openTextDocument: async (o) => { state.untitled.push(o); return o; },
    isTrusted: true,
  },
  window: {
    registered: [], state: { focused: true },
    registerCustomEditorProvider(id, p, o) { this.registered.push([id, p, o]); return { dispose() {} }; },
    showInformationMessage: async () => undefined,
    showSaveDialog: async (o) => { state.saveDialog = o; return state.saveTo; },
    showTextDocument: async (d) => { state.shown.push(d); },
  },
  commands: { list: [], registerCommand(id) { this.list.push(id); return { dispose() {} }; }, executeCommand: async (...a) => { state.commands.push(a); } },
  env: { sessionId: 's1', openExternal: async (u) => { state.external.push(u.parsed); return true; } },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');

function fakePanel() {
  const sent = []; let handler = null; let dispose = null;
  const panel = {
    active: true,
    webview: { options: null, html: '', cspSource: 'https://csp', asWebviewUri: (u) => 'https://res' + u.path, postMessage: async (m) => { sent.push(m); return true; }, onDidReceiveMessage: (h) => { handler = h; } },
    onDidDispose: (h) => { dispose = h; },
  };
  return { panel, sent, send: (m) => handler(m), close: () => dispose() };
}
const globalState = { data: new Map(), get(k) { return this.data.get(k); }, async update(k, v) { this.data.set(k, v); }, keys() { return [...this.data.keys()]; } };
const ctxOf = () => ({ extensionUri: uriOf(root), subscriptions: [], globalState });
async function open(file, scheme = 'file') {
  const prov = new ext.EpubEditorProvider(ctxOf());
  const f = fakePanel();
  await prov.resolveCustomEditor({ uri: uriOf(file, scheme) }, f.panel);
  return f;
}
const of = (f, type) => f.sent.filter((m) => m.type === type);
const last = (f, type) => of(f, type).pop();

test('activate registers the custom editor and the commands that package.json declares', () => {
  const ctx = ctxOf();
  ext.activate(ctx);
  assert.equal(vscodeMock.window.registered[0][0], 'epubReader.book');
  assert.equal(vscodeMock.window.registered[0][2].webviewOptions.retainContextWhenHidden, true);
  const declared = require('../package.json').contributes.commands.map((c) => c.command).sort();
  assert.deepEqual([...vscodeMock.commands.list].sort(), declared);
});

test('ready opens the book from disk by ranges and posts init with metadata, contents and settings', async () => {
  state.reads = 0;
  const f = await open(light);
  assert.match(f.panel.webview.html, /Content-Security-Policy/);
  assert.deepEqual(f.panel.webview.options.localResourceRoots.map((u) => path.basename(u.path)), ['dist', 'media']);
  await f.send({ type: 'ready' });
  const init = last(f, 'init');
  assert.equal(init.info.meta.title, "The Lighthouse Keeper's Log");
  assert.equal(init.info.spine.length, 7);
  assert.equal(init.info.tocSource, 'nav');
  assert.deepEqual(init.prefs, { fontSize: 18, flow: 'paged', theme: 'auto', fontFamily: 'serif', footnotePopups: true });
  assert.equal(init.position, null);
  assert.equal(state.reads, 0, 'local books are read by byte ranges, not with readFile');
  await new Promise((r) => setTimeout(r, 30));
  assert.match(last(f, 'cover').url, /^data:image\/svg\+xml;base64,/);
  f.close();
});

test('chapter, search and bad messages', async () => {
  const f = await open(light);
  await f.send({ type: 'ready' });
  await f.send({ type: 'chapter', index: 3 });
  const c = last(f, 'chapter');
  assert.equal(c.index, 3);
  assert.equal(c.purpose, 'show');
  assert.match(c.html, /src="data:image\/png;base64,/);
  await f.send({ type: 'search', query: 'keeper', seq: 7 });
  const s = last(f, 'searchResults');
  assert.equal(s.seq, 7);
  assert.ok(s.total > 0 && s.results[0].match.toLowerCase() === 'keeper');
  const n = f.sent.length;
  await f.send({ type: 'chapter', index: 99 });
  await f.send({ type: 'eval', code: 'x' });
  await f.send({ type: 'openExternal', url: 'file:///etc/passwd' });
  assert.equal(f.sent.length, n);
  await f.send({ type: 'openExternal', url: 'https://example.org/lighthouses' });
  assert.deepEqual(state.external, ['https://example.org/lighthouses']);
  f.close();
});

test('the reading position is saved per book and restored when the book opens again', async () => {
  const a = await open(notes);
  await a.send({ type: 'ready' });
  await a.send({ type: 'position', index: 3, el: 5, frac: 0.4 });
  a.close();
  const b = await open(notes);
  await b.send({ type: 'ready' });
  assert.deepEqual(last(b, 'init').position, { index: 3, el: 5, frac: 0.4 });
  b.close();
  const other = await open(light);
  await other.send({ type: 'ready' });
  assert.equal(last(other, 'init').position, null);
  other.close();
  state.config.rememberPosition = false;
  try {
    const c = await open(notes);
    await c.send({ type: 'ready' });
    assert.equal(last(c, 'init').position, null);
    c.close();
  } finally { delete state.config.rememberPosition; }
});

test('toolbar settings go to the user settings, and a settings change is sent back', async () => {
  const f = await open(light);
  await f.send({ type: 'ready' });
  await f.send({ type: 'setPref', key: 'theme', value: 'sepia' });
  await f.send({ type: 'setPref', key: 'fontSize', value: 22 });
  await f.send({ type: 'setPref', key: 'maxFileMB', value: 5000 });
  assert.deepEqual(state.updates.slice(-2), [['theme', 'sepia', 1], ['fontSize', 22, 1]]);
  state.config.theme = 'dark';
  for (const h of state.cfgHandlers) h({ affectsConfiguration: (s) => s === 'epubReader' });
  assert.equal(last(f, 'prefs').prefs.theme, 'dark');
  delete state.config.theme;
  f.close();
  assert.equal(state.cfgHandlers.length, 0);
});

test('a book over the size limit is never read', async () => {
  state.sizeOverride = 300 * 1024 * 1024; state.reads = 0;
  try {
    const f = await open(light);
    await f.send({ type: 'ready' });
    assert.match(last(f, 'tooBig').message, /^This book is 300.0 MB\. EPUB Reader opens books up to 200.0 MB/);
    assert.equal(of(f, 'init').length, 0);
    assert.equal(state.reads, 0);
    f.close();
  } finally { state.sizeOverride = null; }
});

test('a file that is not an EPUB gets an error message and a reopen button works', async () => {
  const f = await open(junk);
  await f.send({ type: 'ready' });
  assert.match(last(f, 'error').message, /not a ZIP archive/);
  await f.send({ type: 'reopenWith' });
  assert.deepEqual(state.commands.pop(), ['workbench.action.reopenWithEditor']);
  f.close();
});

test('books on other file systems are read with workspace.fs', async () => {
  state.reads = 0;
  const f = await open(notes, 'vscode-remote');
  await f.send({ type: 'ready' });
  assert.equal(last(f, 'init').info.meta.title, 'Field Notes from a Small Garden');
  assert.equal(state.reads, 1);
  f.close();
});

test('export to Markdown writes the .md and its images after the save dialog', async () => {
  const f = await open(light);
  await f.send({ type: 'ready' });
  state.saveTo = uriOf(path.join(tmp, 'out', 'soundings.md'));
  await f.send({ type: 'exportMarkdown', index: 3 });
  assert.equal(path.basename(state.saveDialog.defaultUri.path), "light - Chapter 3. Soundings.md");
  const md = state.written.get(path.join(tmp, 'out', 'soundings.md')).toString('utf8');
  assert.match(md, /^# Chapter 3\. Soundings/);
  assert.match(md, /!\[Chart of the north coast\]\(soundings-images\/chart\.png\)/);
  const png = state.written.get(path.join(tmp, 'out', 'soundings-images', 'chart.png'));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(last(f, 'exported'), { type: 'exported', path: path.join(tmp, 'out', 'soundings.md'), images: 1 });
  const n = state.written.size;
  state.saveTo = undefined; // the user cancelled
  await f.send({ type: 'exportMarkdown', index: 2 });
  assert.equal(state.written.size, n);
  f.close();
  // Not a local file: the chapter opens as an untitled Markdown document instead.
  const g = await open(notes, 'vscode-remote');
  await g.send({ type: 'ready' });
  await g.send({ type: 'exportMarkdown', index: 1 });
  assert.equal(state.untitled.pop().language, 'markdown');
  assert.equal(last(g, 'exported').untitled, true);
  g.close();
});

test('the rating counts one success per tab, and commands reach the tab in front', async () => {
  const f = await open(light);
  await f.send({ type: 'ready' });
  await f.send({ type: 'rendered' });
  await f.send({ type: 'rendered' });
  const st = globalState.get('zovo.rating.v1');
  assert.equal(st.count, 1);
  const handlers = {};
  const ctx = ctxOf();
  const reg = vscodeMock.commands.registerCommand;
  vscodeMock.commands.registerCommand = (id, h) => { handlers[id] = h; return { dispose() {} }; };
  try { ext.activate(ctx); } finally { vscodeMock.commands.registerCommand = reg; }
  handlers['epubReader.exportChapter']();
  handlers['epubReader.search']();
  assert.deepEqual(of(f, 'command').map((m) => m.action), ['export', 'search']);
  f.close();
});

test('a change on disk reloads the book at the same place, and nothing is posted after close', async () => {
  const f = await open(light);
  await f.send({ type: 'ready' });
  await f.send({ type: 'position', index: 4, el: 2, frac: 0.2 });
  const w = state.watchers[state.watchers.length - 1];
  w.on.change();
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(of(f, 'changed').length, 1);
  assert.equal(of(f, 'init').length, 2);
  assert.deepEqual(last(f, 'init').position, { index: 4, el: 2, frac: 0.2 });
  f.close();
  assert.ok(w.disposed);
  const n = f.sent.length;
  await f.send({ type: 'chapter', index: 1 });
  assert.equal(f.sent.length, n);
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = require('../package.json');
  const support = require('../src/support');
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.equal(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map((c) => c.command);
  assert.ok(ids.includes('epubReader.supportDeveloper') && ids.includes('epubReader.moreViewers'));
  assert.equal(pkg.contributes.configuration.properties['epubReader.showSupportLinks'].default, true);
  assert.ok(support.otherProducts(ext.EXT_ID).every((p) => p.id !== ext.EXT_ID));
  assert.ok(fs.readFileSync(path.join(root, '.github', 'FUNDING.yml'), 'utf8').includes('github: theluckystrike'));
});

test('support: the footer shows by default and epubReader.showSupportLinks=false hides it', async () => {
  for (const [value, shown] of [[undefined, true], [false, false]]) {
    if (value === undefined) delete state.config.showSupportLinks; else state.config.showSupportLinks = value;
    try {
      const f = await open(light);
      assert.equal(/id="zovo-support"/.test(f.panel.webview.html), shown, String(value));
      assert.equal(f.panel.webview.html.includes('command:epubReader.moreViewers'), shown);
      assert.deepEqual(f.panel.webview.options.enableCommandUris, ['epubReader.supportDeveloper', 'epubReader.moreViewers', 'workbench.action.openSettings']);
      f.close();
    } finally { delete state.config.showSupportLinks; }
  }
});
