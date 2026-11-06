'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { Book } = require('./core/book');
const { fileSource, bufferSource } = require('./core/zip');
const P = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const VIEW_TYPE = 'epubReader.book';
const EXT_ID = 'zovo.zovo-epub-reader';
const POS_KEY = 'epubReader.positions.v1';
let rating = { success() {} };
const panels = new Set(); // { panel, post }

function prefs() {
  const c = vscode.workspace.getConfiguration('epubReader');
  return P.cleanPrefs({
    fontSize: c.get('fontSize', 18), flow: c.get('flow', 'paged'), theme: c.get('theme', 'auto'),
    fontFamily: c.get('fontFamily', 'serif'), footnotePopups: c.get('footnotePopups', true),
  });
}
const conf = (k, d) => vscode.workspace.getConfiguration('epubReader').get(k, d);

function safeName(s) {
  return String(s || 'chapter').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chapter';
}

class EpubEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('epubReader') };
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'epubReader'),
    });
    let disposed = false;
    let counted = false; // one success per opened tab, for the rating prompt
    let book = null;
    let opening = null;
    let lastPos = null;
    const key = uri.toString();
    const post = (m) => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));
    const entry = { panel, post };
    panels.add(entry);

    const open = async (reloading) => {
      const old = book; book = null;
      if (old) await old.close();
      const stat = await vscode.workspace.fs.stat(uri);
      const plan = P.sizePlan(stat.size, conf('maxFileMB', 200));
      if (!plan.load) { await post({ type: 'tooBig', name, message: plan.message }); return; }
      const t0 = Date.now();
      const src = uri.scheme === 'file' ? await fileSource(uri.fsPath) : bufferSource(await vscode.workspace.fs.readFile(uri));
      let b;
      try { b = await Book.open(src); } catch (e) { await src.close(); throw e; }
      if (disposed) { await b.close(); return; }
      book = b;
      const saved = conf('rememberPosition', true) ? P.savedPosition(ctx.globalState.get(POS_KEY), key, b.length) : null;
      const position = reloading && lastPos && lastPos.index < b.length ? lastPos : saved;
      await post({ type: 'init', name, size: stat.size, sizeText: P.fmtSize(stat.size), info: b.info(), prefs: prefs(), position, ms: Date.now() - t0 });
      b.cover().then((url) => { if (url && book === b) post({ type: 'cover', url }); }).catch(() => {});
    };
    const start = (reloading) => {
      opening = open(reloading).catch((e) => post({ type: 'error', message: e && e.message ? e.message : String(e) }));
      return opening;
    };
    const need = async () => { if (opening) await opening; if (!book) throw new Error('The book is not open.'); return book; };

    const exportMarkdown = async (index) => {
      const b = await need();
      const title = b.pkg.spine[index].title || `Section ${index + 1}`;
      const base = safeName(`${name.replace(/\.epub$/i, '')} - ${title}`);
      if (uri.scheme !== 'file') {
        const { md } = await b.markdown(index, '');
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
        await vscode.window.showTextDocument(doc, { preview: false });
        return { untitled: true };
      }
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(uri, '..', `${base}.md`), filters: { Markdown: ['md'] }, title: 'Export chapter to Markdown',
      });
      if (!target) return null;
      const imgDir = `${path.posix.basename(target.path).replace(/\.md$/i, '')}-images`;
      const { md, images } = await b.markdown(index, imgDir);
      await vscode.workspace.fs.writeFile(target, Buffer.from(md, 'utf8'));
      if (images.length) {
        const dir = vscode.Uri.joinPath(target, '..', imgDir);
        await vscode.workspace.fs.createDirectory(dir);
        for (const im of images) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, im.name), await b.zip.read(im.path));
      }
      await vscode.window.showTextDocument(target, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      return { path: target.fsPath, images: images.length };
    };

    // Rebuilt books (for example from an EPUB build script) reload at the same place.
    let changeTimer = null;
    const watcher = uri.scheme === 'file'
      ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), name))
      : null;
    if (watcher) {
      const onChange = () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => { if (!disposed) { post({ type: 'changed' }); start(true); } }, 700); };
      watcher.onDidChange(onChange); watcher.onDidCreate(onChange);
    }
    const cfgSub = vscode.workspace.onDidChangeConfiguration
      ? vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('epubReader')) post({ type: 'prefs', prefs: prefs() }); })
      : null;

    panel.webview.onDidReceiveMessage(async (raw) => {
      const v = P.validateWebviewMessage(raw, book ? book.length : 1e6);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready') { await start(false); return; }
        if (msg.type === 'rendered') { if (!counted) { counted = true; rating.success(); } return; }
        if (msg.type === 'chapter') { const b = await need(); await post({ type: 'chapter', purpose: msg.purpose, ...(await b.chapter(msg.index)) }); return; }
        if (msg.type === 'search') {
          const b = await need(); const t0 = Date.now();
          await post({ type: 'searchResults', seq: msg.seq, query: msg.query, ...(await b.search(msg.query)), ms: Date.now() - t0 });
          return;
        }
        if (msg.type === 'position') {
          lastPos = { index: msg.index, el: msg.el, frac: msg.frac };
          if (conf('rememberPosition', true)) await ctx.globalState.update(POS_KEY, P.rememberPosition(ctx.globalState.get(POS_KEY), key, lastPos, Date.now()));
          return;
        }
        if (msg.type === 'setPref') { await vscode.workspace.getConfiguration('epubReader').update(msg.key, msg.value, vscode.ConfigurationTarget.Global); return; }
        if (msg.type === 'exportMarkdown') { const r = await exportMarkdown(msg.index); if (r) await post({ type: 'exported', ...r }); return; }
        if (msg.type === 'openExternal') { await vscode.env.openExternal(vscode.Uri.parse(msg.url)); return; }
        if (msg.type === 'reopenWith') { await vscode.commands.executeCommand('workbench.action.reopenWithEditor'); }
      } catch (e) {
        await post({ type: 'error', message: e && e.message ? e.message : String(e), soft: true });
      }
    });
    panel.onDidDispose(() => {
      disposed = true; panels.delete(entry); clearTimeout(changeTimer);
      if (watcher) watcher.dispose();
      if (cfgSub) cfgSub.dispose();
      if (book) book.close();
    });
  }
}

/** Send a toolbar action to the book tab that is in front. */
function toActive(action) {
  for (const p of panels) if (p.panel.active) { p.post({ type: 'command', action }); return true; }
  vscode.window.showInformationMessage('Open an EPUB book first.');
  return false;
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'epubReader', message: (n) => `EPUB Reader has opened ${n} books for you. A rating helps other people find it.` });
  registerSupport({ vscode, context, prefix: 'epubReader', selfId: EXT_ID });
  const provider = new EpubEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('epubReader.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#epubReader.start`, false)),
    vscode.commands.registerCommand('epubReader.openWith', async (uri) => {
      const target = uri instanceof vscode.Uri ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('epubReader.search', () => toActive('search')),
    vscode.commands.registerCommand('epubReader.showInfo', () => toActive('info')),
    vscode.commands.registerCommand('epubReader.exportChapter', () => toActive('export')),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, EpubEditorProvider, VIEW_TYPE, EXT_ID, safeName };
