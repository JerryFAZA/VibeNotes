/**
 * Generates app/assets/icon.png (64x64) without any dependency.
 * Design: dark rounded square + white "notch" bar + note lines + accent dot.
 * Run: node gen-icon.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 64;

// --- pixel helpers ---------------------------------------------------------
function clampByte(v) { return Math.max(0, Math.min(255, Math.round(v))); }

function insideRoundedRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return false;
  const cx = Math.max(rx + r, Math.min(x, rx + rw - 1 - r));
  const cy = Math.max(ry + r, Math.min(y, ry + rh - 1 - r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= rx + r && x < rx + rw - r) || (y >= ry + r && y < ry + rh - r);
}

function blend(base, top, alpha) {
  return base * (1 - alpha) + top * alpha;
}

function pixel(x, y) {
  let r = 13, g = 13, b = 18, a = 0;

  // main rounded square (24px radius feel -> radius 16 at 64px)
  if (insideRoundedRect(x, y, 2, 2, 60, 60, 16)) {
    r = 16; g = 16; b = 21; a = 1;
  }

  // soft top edge light
  if (a === 1 && y < 10) {
    const k = 1 - y / 10;
    r = blend(r, 60, k * 0.25); g = blend(g, 60, k * 0.25); b = blend(b, 70, k * 0.25);
  }

  // the "notch": centered white bar touching the top
  if (insideRoundedRect(x, y, 22, 2, 20, 11, 4)) {
    r = blend(r, 242, 0.95); g = blend(g, 242, 0.95); b = blend(b, 246, 0.95);
  }

  // note line 1
  if (insideRoundedRect(x, y, 14, 26, 36, 6, 3)) {
    r = blend(r, 235, 0.8); g = blend(g, 235, 0.8); b = blend(b, 240, 0.8);
  }
  // note line 2
  if (insideRoundedRect(x, y, 14, 38, 24, 6, 3)) {
    r = blend(r, 235, 0.5); g = blend(g, 235, 0.5); b = blend(b, 240, 0.5);
  }
  // accent cursor block (soft blue)
  if (insideRoundedRect(x, y, 42, 38, 8, 6, 3)) {
    r = blend(r, 127, 0.95); g = blend(g, 180, 0.95); b = blend(b, 255, 0.95);
  }

  return [clampByte(r), clampByte(g), clampByte(b), clampByte(a * 255)];
}

// --- PNG encoding ----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = pixel(x, y);
    const p = rowStart + 1 + x * 4;
    raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('icon written:', out, png.length, 'bytes');
