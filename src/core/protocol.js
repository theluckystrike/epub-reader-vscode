'use strict';
// Message checks, settings checks and the size plan. Shared by the extension host and the tests. No vscode import.

const MB = 1024 * 1024;

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

/** Books over the limit get a clear message and are never read. */
function sizePlan(size, maxFileMB) {
  const limitMB = Number.isFinite(maxFileMB) && maxFileMB > 0 ? Math.min(maxFileMB, 2048) : 200;
  if (size > limitMB * MB) {
    return {
      load: false, limitMB,
      message: `This book is ${fmtSize(size)}. EPUB Reader opens books up to ${fmtSize(limitMB * MB)} so VS Code stays responsive (setting epubReader.maxFileMB). The file was not read.`,
    };
  }
  return { load: true, limitMB };
}

const FLOWS = ['paged', 'scrolled'];
const THEMES = ['auto', 'light', 'sepia', 'dark'];
const FONTS = ['serif', 'sans'];
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Settings from the configuration, clamped to known values. */
function cleanPrefs(p) {
  const o = p || {};
  return {
    fontSize: isInt(o.fontSize, 10, 40) ? o.fontSize : 18,
    flow: FLOWS.includes(o.flow) ? o.flow : 'paged',
    theme: THEMES.includes(o.theme) ? o.theme : 'auto',
    fontFamily: FONTS.includes(o.fontFamily) ? o.fontFamily : 'serif',
    footnotePopups: o.footnotePopups !== false,
  };
}

function validPref(key, value) {
  if (key === 'fontSize') return isInt(value, 10, 40);
  if (key === 'flow') return FLOWS.includes(value);
  if (key === 'theme') return THEMES.includes(value);
  if (key === 'fontFamily') return FONTS.includes(value);
  return false;
}

/** Only known webview messages pass, with checked fields. Everything else is dropped. */
function validateWebviewMessage(m, chapters = 1e6) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return { ok: false };
  const idx = (v) => isInt(v, 0, Math.max(0, chapters - 1));
  switch (m.type) {
    case 'ready':
    case 'rendered':
    case 'reopenWith':
      return { ok: true, msg: { type: m.type } };
    case 'chapter':
      return idx(m.index) ? { ok: true, msg: { type: 'chapter', index: m.index, purpose: m.purpose === 'note' ? 'note' : 'show' } } : { ok: false };
    case 'exportMarkdown':
      return idx(m.index) ? { ok: true, msg: { type: 'exportMarkdown', index: m.index } } : { ok: false };
    case 'search':
      if (typeof m.query !== 'string' || !m.query.trim() || m.query.length > 200) return { ok: false };
      return { ok: true, msg: { type: 'search', query: m.query, seq: isInt(m.seq, 0, 1e9) ? m.seq : 0 } };
    case 'position':
      if (!idx(m.index) || !isInt(m.el, 0, 1e7) || typeof m.frac !== 'number' || !(m.frac >= 0 && m.frac <= 1)) return { ok: false };
      return { ok: true, msg: { type: 'position', index: m.index, el: m.el, frac: m.frac } };
    case 'setPref':
      return validPref(m.key, m.value) ? { ok: true, msg: { type: 'setPref', key: m.key, value: m.value } } : { ok: false };
    case 'openExternal':
      if (typeof m.url !== 'string' || m.url.length > 2000 || !/^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(m.url)) return { ok: false };
      return { ok: true, msg: { type: 'openExternal', url: m.url } };
    default:
      return { ok: false };
  }
}

/** Saved reading positions: { [bookKey]: { index, el, frac, at } }, newest kept, at most `max`. */
function rememberPosition(map, key, pos, now, max = 300) {
  const out = { ...(map && typeof map === 'object' ? map : {}) };
  out[key] = { index: pos.index, el: pos.el, frac: pos.frac, at: now };
  const keys = Object.keys(out);
  if (keys.length > max) {
    keys.sort((a, b) => (out[a].at || 0) - (out[b].at || 0));
    for (const k of keys.slice(0, keys.length - max)) delete out[k];
  }
  return out;
}

function savedPosition(map, key, chapters) {
  const p = map && typeof map === 'object' ? map[key] : null;
  if (!p || !isInt(p.index, 0, chapters - 1)) return null;
  return { index: p.index, el: isInt(p.el, 0, 1e7) ? p.el : 0, frac: typeof p.frac === 'number' && p.frac >= 0 && p.frac <= 1 ? p.frac : 0 };
}

module.exports = { fmtSize, sizePlan, cleanPrefs, validPref, validateWebviewMessage, rememberPosition, savedPosition, MB };
