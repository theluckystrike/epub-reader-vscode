'use strict';
// Webview message protocol, settings checks, the size plan, saved positions, CSP, source scans and the manifest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/core/protocol');
const { buildHtml, csp } = require('../src/html');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('size plan: over the limit gives the exact message and the file is not read', () => {
  assert.deepEqual(P.sizePlan(10 * P.MB, 200), { load: true, limitMB: 200 });
  const p = P.sizePlan(300 * P.MB, 200);
  assert.equal(p.load, false);
  assert.equal(p.message, 'This book is 300.0 MB. EPUB Reader opens books up to 200.0 MB so VS Code stays responsive (setting epubReader.maxFileMB). The file was not read.');
  assert.equal(P.sizePlan(1, -5).limitMB, 200);
  assert.equal(P.sizePlan(1, 99999).limitMB, 2048);
  assert.equal(P.fmtSize(1536), '1.5 KB');
});

test('protocol: known messages pass with checked fields, everything else is dropped', () => {
  const ok = (m, n) => P.validateWebviewMessage(m, n);
  assert.deepEqual(ok({ type: 'ready', extra: 1 }), { ok: true, msg: { type: 'ready' } });
  assert.deepEqual(ok({ type: 'chapter', index: 3 }, 7), { ok: true, msg: { type: 'chapter', index: 3, purpose: 'show' } });
  assert.deepEqual(ok({ type: 'chapter', index: 3, purpose: 'note' }, 7).msg.purpose, 'note');
  for (const bad of [{ type: 'chapter', index: 7 }, { type: 'chapter', index: -1 }, { type: 'chapter', index: 1.5 }, { type: 'chapter', index: '2' }]) assert.equal(ok(bad, 7).ok, false);
  assert.deepEqual(ok({ type: 'search', query: 'lamp', seq: 4 }), { ok: true, msg: { type: 'search', query: 'lamp', seq: 4 } });
  for (const q of ['', '   ', 'x'.repeat(201), 5]) assert.equal(ok({ type: 'search', query: q }).ok, false);
  assert.deepEqual(ok({ type: 'position', index: 1, el: 12, frac: 0.5 }, 3).msg, { type: 'position', index: 1, el: 12, frac: 0.5 });
  for (const bad of [{ el: -1, frac: 0 }, { el: 1, frac: 1.5 }, { el: 1, frac: NaN }, { el: 1.2, frac: 0 }]) assert.equal(ok({ type: 'position', index: 0, ...bad }, 3).ok, false);
  assert.equal(ok({ type: 'setPref', key: 'fontSize', value: 22 }).ok, true);
  assert.equal(ok({ type: 'setPref', key: 'theme', value: 'sepia' }).ok, true);
  assert.equal(ok({ type: 'setPref', key: 'flow', value: 'scrolled' }).ok, true);
  for (const bad of [['fontSize', 9], ['fontSize', 41], ['fontSize', '20'], ['theme', 'neon'], ['flow', 'x'], ['maxFileMB', 9999], ['__proto__', 1]]) assert.equal(ok({ type: 'setPref', key: bad[0], value: bad[1] }).ok, false);
  assert.equal(ok({ type: 'openExternal', url: 'https://example.org/a?b=c' }).ok, true);
  assert.equal(ok({ type: 'openExternal', url: 'mailto:a@b.c' }).ok, true);
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'command:workbench.action.terminal.new', 'vscode://x', 'https://a b', 'x'.repeat(3000)]) assert.equal(ok({ type: 'openExternal', url: u }).ok, false);
  assert.equal(ok({ type: 'exportMarkdown', index: 0 }, 1).ok, true);
  assert.equal(ok({ type: 'exportMarkdown', index: 1 }, 1).ok, false);
  for (const bad of [null, 'ready', { type: 'eval' }, { type: 'copy', text: 'x' }, {}]) assert.equal(ok(bad).ok, false);
});

test('prefs: settings are clamped to known values', () => {
  assert.deepEqual(P.cleanPrefs({}), { fontSize: 18, flow: 'paged', theme: 'auto', fontFamily: 'serif', footnotePopups: true });
  assert.deepEqual(P.cleanPrefs({ fontSize: 99, flow: 'x', theme: 'sepia', fontFamily: 'sans', footnotePopups: false }), { fontSize: 18, flow: 'paged', theme: 'sepia', fontFamily: 'sans', footnotePopups: false });
});

test('positions: one per book, newest kept, bad saved data ignored', () => {
  let m = {};
  for (let i = 0; i < 305; i++) m = P.rememberPosition(m, `file:///b${i}.epub`, { index: 1, el: i, frac: 0.1 }, 1000 + i);
  assert.equal(Object.keys(m).length, 300);
  assert.equal(m['file:///b0.epub'], undefined);
  assert.deepEqual(P.savedPosition(m, 'file:///b304.epub', 5), { index: 1, el: 304, frac: 0.1 });
  assert.equal(P.savedPosition(m, 'file:///b304.epub', 1), null); // the book now has fewer chapters
  assert.equal(P.savedPosition({ k: { index: 'x' } }, 'k', 3), null);
  assert.deepEqual(P.savedPosition({ k: { index: 2, el: -4, frac: 7 } }, 'k', 3), { index: 2, el: 0, frac: 0 });
  assert.equal(P.savedPosition(null, 'k', 3), null);
});

test('webview HTML: strict CSP with a nonce, no remote origin, escaped title, support footer optional', () => {
  const html = buildHtml({ cspSource: 'https://res.test', scriptUri: 'https://res.test/w.js', styleUri: 'https://res.test/s.css', title: '<b>"x"</b>.epub', nonce: 'N0NCE' });
  const c = /content="([^"]+)"/.exec(html)[1];
  assert.equal(c, csp('https://res.test', 'N0NCE'));
  assert.match(c, /^default-src 'none'; style-src https:\/\/res.test 'nonce-N0NCE'; script-src 'nonce-N0NCE'; img-src https:\/\/res.test data:; font-src https:\/\/res.test; base-uri 'none'; form-action 'none'$/);
  assert.doesNotMatch(c, /unsafe|connect-src|frame-src|media-src|\*/);
  assert.match(html, /<title>&lt;b&gt;&quot;x&quot;&lt;\/b&gt;.epub<\/title>/);
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.match(html, /<script nonce="N0NCE" src=/);
  assert.match(html, /id="zovo-support"/);
  assert.doesNotMatch(buildHtml({ cspSource: 'x', scriptUri: 'a', styleUri: 'b', title: 't', showSupportLinks: false }), /zovo-support/);
});

test('source scan: the webview never uses innerHTML, eval or network, and every posted type is accepted by the host', () => {
  const wv = read('src/webview/main.js');
  for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /https?:\/\//, /setAttribute\(\s*['"]style/, /\.src\s*=/]) {
    assert.doesNotMatch(wv, bad, `webview uses ${bad}`);
  }
  const posted = new Set([...wv.matchAll(/post\(\{ type: '(\w+)'/g)].map((m) => m[1]));
  assert.ok(posted.size >= 8, [...posted].join());
  const sample = { chapter: { index: 0 }, exportMarkdown: { index: 0 }, search: { query: 'q' }, position: { index: 0, el: 0, frac: 0 }, setPref: { key: 'flow', value: 'paged' }, openExternal: { url: 'https://x.org' } };
  for (const t of posted) assert.equal(P.validateWebviewMessage({ type: t, ...(sample[t] || {}) }, 2).ok, true, t);
  // DOMParser is the only way book HTML enters the page, and it never runs scripts.
  assert.match(wv, /new DOMParser\(\)\.parseFromString/);
});

test('source scan: the extension host has no network modules and writes files only on export', () => {
  for (const f of ['src/extension.js', 'src/core/book.js', 'src/core/epub.js', 'src/core/zip.js', 'src/core/xml.js', 'src/core/sanitize.js', 'src/core/protocol.js']) {
    const s = read(f);
    assert.doesNotMatch(s, /require\(['"](https?|net|tls|dgram|child_process|http2)['"]\)/, f);
    assert.doesNotMatch(s, /\bfetch\(/, f);
  }
  const ext = read('src/extension.js');
  const writes = [...ext.matchAll(/fs\.writeFile\(/g)].length;
  assert.equal(writes, 2); // the .md file and its images, after the save dialog
  assert.match(ext, /showSaveDialog/);
});

test('manifest: custom editor, settings, commands, 30 keywords, short unique name', () => {
  assert.equal(pkg.name, 'zovo-epub-reader');
  assert.equal(pkg.publisher, 'zovo');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/); // monetize.py rollouts bump it
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.ok(pkg.displayName.length <= 45 && /^EPUB Reader/.test(pkg.displayName));
  assert.equal(pkg.keywords.length, 30);
  assert.equal(new Set(pkg.keywords).size, 30);
  const ed = pkg.contributes.customEditors[0];
  assert.deepEqual([ed.viewType, ed.priority, ed.selector[0].filenamePattern], ['epubReader.book', 'default', '*.epub']);
  const props = pkg.contributes.configuration.properties;
  for (const k of ['flow', 'theme', 'fontSize', 'fontFamily', 'footnotePopups', 'rememberPosition', 'maxFileMB', 'askForRating', 'showSupportLinks']) assert.ok(props[`epubReader.${k}`], k);
  assert.deepEqual(props['epubReader.theme'].enum, ['auto', 'light', 'sepia', 'dark']);
  const cmds = pkg.contributes.commands.map((c) => c.command);
  for (const c of ['epubReader.openWith', 'epubReader.search', 'epubReader.showInfo', 'epubReader.exportChapter', 'epubReader.supportDeveloper', 'epubReader.moreViewers']) assert.ok(cmds.includes(c), c);
  assert.ok(fs.existsSync(path.join(root, pkg.contributes.walkthroughs[0].steps[0].media.image)));
  const ignore = read('.vscodeignore');
  assert.match(ignore, /^samples\/\*\*$/m);
  assert.match(ignore, /^\.github\/\*\*$/m);
});
