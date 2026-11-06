'use strict';
// Builds the webview HTML. Kept free of the vscode module so tests can check the CSP.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The policy. Book images arrive as data: URLs. No connect-src, no frame-src, no media-src, no remote origin. */
function csp(cspSource, nonce) {
  return [
    "default-src 'none'", `style-src ${cspSource} 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`, `font-src ${cspSource}`, "base-uri 'none'", "form-action 'none'",
  ].join('; ');
}

/**
 * @param {{cspSource:string, scriptUri:string, styleUri:string, title:string, nonce?:string, showSupportLinks?:boolean}} p
 * showSupportLinks false hides the small Sponsor and More free viewers line (setting epubReader.showSupportLinks).
 */
function buildHtml(p) {
  const n = p.nonce || crypto.randomBytes(24).toString('base64url');
  const footer = footerHtml('epubReader', p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}\n.status .zovo-support{padding:0;font-family:var(--vscode-font-family)}</style>` : ''}
<title>${escapeAttr(p.title)}</title>
</head>
<body>
<div id="app"><p class="loading">Opening the book...</p></div>
${footer}
<script nonce="${n}" src="${escapeAttr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, escapeAttr, csp };
