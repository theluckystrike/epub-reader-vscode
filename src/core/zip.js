'use strict';
// A small read-only ZIP reader. It reads the central directory first and inflates one entry at a time,
// so opening a book reads only the parts it needs. Inflate is fflate (MIT). No vscode import here.
const { inflateSync } = require('fflate');

const MB = 1024 * 1024;
const MAX_ENTRY = 256 * MB; // one entry never inflates past this (zip bomb guard)

class ZipError extends Error {}

/** Source over an in-memory buffer. */
function bufferSource(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return {
    size: u8.length,
    async read(off, len) { return u8.subarray(off, Math.min(u8.length, off + len)); },
    async close() {},
  };
}

/** Source over a local file. Reads byte ranges on demand and never loads the whole file. */
async function fileSource(fsPath) {
  const fsp = require('fs').promises;
  const fh = await fsp.open(fsPath, 'r');
  const st = await fh.stat();
  return {
    size: st.size,
    async read(off, len) {
      const n = Math.max(0, Math.min(len, st.size - off));
      const b = Buffer.alloc(n);
      let got = 0;
      while (got < n) {
        const { bytesRead } = await fh.read(b, got, n - got, off + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return new Uint8Array(b.buffer, b.byteOffset, got);
    },
    async close() { try { await fh.close(); } catch { /* already closed */ } },
  };
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

function decodeName(bytes, utf8) {
  // Most EPUB tools write UTF-8 names even without the flag, so UTF-8 is tried first.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* fall through */ }
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  return Array.from(bytes, (c) => String.fromCharCode(c)).join('');
}

class ZipReader {
  constructor(source, entries) {
    this.source = source;
    this.entries = entries; // Map name -> entry
    this.lower = new Map();
    for (const k of entries.keys()) if (!this.lower.has(k.toLowerCase())) this.lower.set(k.toLowerCase(), k);
  }

  static async open(source) {
    if (source.size < 22) throw new ZipError('The file is too small to be an EPUB.');
    const tailLen = Math.min(source.size, 65557);
    const tail = await source.read(source.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError('This file is not a ZIP archive, so it is not an EPUB.');
    const count = u16(tail, eocd + 10);
    const cdSize = u32(tail, eocd + 12);
    const cdOff = u32(tail, eocd + 16);
    if (cdOff === 0xffffffff || count === 0xffff) throw new ZipError('This EPUB uses ZIP64, which is not supported.');
    if (cdOff + cdSize > source.size) throw new ZipError('The ZIP directory of this file is damaged.');
    const cd = await source.read(cdOff, cdSize);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (u32(cd, p) !== 0x02014b50) throw new ZipError('The ZIP directory of this file is damaged.');
      const flags = u16(cd, p + 8);
      const method = u16(cd, p + 10);
      const csize = u32(cd, p + 20);
      const size = u32(cd, p + 24);
      const nlen = u16(cd, p + 28);
      const xlen = u16(cd, p + 30);
      const clen = u16(cd, p + 32);
      const off = u32(cd, p + 42);
      const name = decodeName(cd.subarray(p + 46, p + 46 + nlen), (flags & 0x800) !== 0);
      if (!name.endsWith('/')) entries.set(name, { name, flags, method, csize, size, off });
      p += 46 + nlen + xlen + clen;
    }
    return new ZipReader(source, entries);
  }

  /** Exact name first, then a case-insensitive match (some books differ in case from their manifest). */
  find(name) {
    if (this.entries.has(name)) return this.entries.get(name);
    const k = this.lower.get(String(name).toLowerCase());
    return k ? this.entries.get(k) : null;
  }

  has(name) { return !!this.find(name); }

  names() { return [...this.entries.keys()]; }

  async read(name, maxBytes = MAX_ENTRY) {
    const e = this.find(name);
    if (!e) throw new ZipError(`The book has no file named ${name}.`);
    if (e.flags & 1) throw new ZipError(`${name} is encrypted in the ZIP.`);
    if (e.size > maxBytes) throw new ZipError(`${name} is ${Math.round(e.size / MB)} MB, over the limit for one part of a book.`);
    const head = await this.source.read(e.off, 30);
    if (head.length < 30 || u32(head, 0) !== 0x04034b50) throw new ZipError(`The ZIP entry ${name} is damaged.`);
    const start = e.off + 30 + u16(head, 26) + u16(head, 28);
    const data = await this.source.read(start, e.csize);
    if (e.method === 0) return data.subarray(0, Math.min(data.length, e.size || data.length));
    if (e.method === 8) {
      // The output buffer has the declared size, so a lying entry can't inflate past it.
      const out = inflateSync(data, { out: new Uint8Array(e.size) });
      return out;
    }
    throw new ZipError(`${name} uses ZIP method ${e.method}, which is not supported.`);
  }

  async text(name) {
    return decodeText(await this.read(name));
  }

  close() { return this.source.close(); }
}

/** XML/HTML bytes to a string. Honors a UTF-16 BOM and an encoding="..." declaration for common 8-bit sets. */
function decodeText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const head = Array.from(bytes.subarray(0, 200), (c) => String.fromCharCode(c)).join('');
  const m = /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head) || /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  const enc = m ? m[1].toLowerCase() : 'utf-8';
  if (enc !== 'utf-8' && enc !== 'utf8') {
    try { return new TextDecoder(enc).decode(bytes); } catch { /* unknown label: use UTF-8 */ }
  }
  let s = new TextDecoder('utf-8').decode(bytes);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

module.exports = { ZipReader, ZipError, bufferSource, fileSource, decodeText, MAX_ENTRY };
