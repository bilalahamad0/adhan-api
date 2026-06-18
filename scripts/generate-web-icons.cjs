#!/usr/bin/env node
/**
 * Dependency-free web/PWA icon generator for the Adhan Operations Dashboard.
 *
 * Renders the same crescent + sparkle on a green square as the Adhan Caster Pro
 * Chrome extension (icons/generate-icons.cjs in the adhan-ce repo) so the
 * dashboard's browser-tab favicon and iPhone Home-Screen icon match the brand.
 *
 * Two variants per size:
 *   - "round"  : rounded-rect with transparent corners  -> browser favicons
 *   - "opaque" : full-bleed opaque square               -> apple-touch-icon &
 *                PWA manifest icons (iOS ignores alpha and masks corners itself)
 *
 * Re-run with `node scripts/generate-web-icons.cjs`. Uses only Node's zlib.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// CRC32 (PNG chunk integrity)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
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
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Per-subpixel color in normalized [0,1] coords -> [r,g,b,a].
// `opaque` fills the whole square (no rounded transparent corners).
function sample(u, v, opaque) {
  if (!opaque) {
    const rr = 0.22; // corner radius
    const dx = Math.abs(u - 0.5) - (0.5 - rr);
    const dy = Math.abs(v - 0.5) - (0.5 - rr);
    const ox = Math.max(dx, 0);
    const oy = Math.max(dy, 0);
    const dist = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - rr;
    if (dist > 0) return [0, 0, 0, 0]; // outside rounded rect -> transparent
  }

  // green vertical gradient
  const top = [31, 138, 91];
  const bot = [11, 107, 67];
  let r = top[0] + (bot[0] - top[0]) * v;
  let g = top[1] + (bot[1] - top[1]) * v;
  let b = top[2] + (bot[2] - top[2]) * v;

  // crescent: inside outer circle, outside offset inner circle
  const distO = Math.hypot(u - 0.46, v - 0.5);
  const distI = Math.hypot(u - 0.59, v - 0.45);
  const inCrescent = distO <= 0.3 && distI >= 0.265;

  // 4-point sparkle star (union of two thin perpendicular ellipses)
  const sx = u - 0.72;
  const sy = v - 0.3;
  const a = 0.022;
  const bb = 0.11;
  const e1 = (sx * sx) / (a * a) + (sy * sy) / (bb * bb);
  const e2 = (sx * sx) / (bb * bb) + (sy * sy) / (a * a);
  const inStar = e1 <= 1 || e2 <= 1;

  if (inCrescent || inStar) return [250, 250, 250, 255];
  return [Math.round(r), Math.round(g), Math.round(b), 255];
}

function renderPNG(size, opaque) {
  const ss = 4; // supersample factor for anti-aliasing
  const N = size * ss;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x * ss + sx + 0.5) / N;
          const v = (y * ss + sy + 0.5) / N;
          const px = sample(u, v, opaque);
          r += px[0]; g += px[1]; b += px[2]; a += px[3];
        }
      }
      const n = ss * ss;
      const o = rowStart + 1 + x * 4;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
      raw[o + 3] = Math.round(a / n);
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Build a favicon.ico that embeds PNG images (ICO supports PNG payloads).
function buildICO(entries /* [{size, png}] */) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  const dirParts = [];
  entries.forEach((e, i) => {
    const o = 0;
    const entry = Buffer.alloc(16);
    entry[0] = e.size >= 256 ? 0 : e.size; // width
    entry[1] = e.size >= 256 ? 0 : e.size; // height
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(e.png.length, 8); // size of PNG
    entry.writeUInt32LE(offset, 12); // offset
    offset += e.png.length;
    entry.copy(dir, 16 * i, o);
    dirParts.push(entry);
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

const ICONS_DIR = path.join(__dirname, '..', 'icons');
const ROOT = path.join(__dirname, '..');
fs.mkdirSync(ICONS_DIR, { recursive: true });

// Rounded/transparent favicons
for (const size of [16, 32, 48]) {
  const out = path.join(ICONS_DIR, `icon-${size}.png`);
  fs.writeFileSync(out, renderPNG(size, false));
  console.log(`wrote ${out} (${size}x${size}, round)`);
}

// Opaque full-bleed icons for iOS Home Screen + PWA manifest
const opaqueSizes = { 180: 'apple-touch-icon.png', 192: 'icon-192.png', 512: 'icon-512.png' };
for (const [size, name] of Object.entries(opaqueSizes)) {
  const out = path.join(ICONS_DIR, name);
  fs.writeFileSync(out, renderPNG(Number(size), true));
  console.log(`wrote ${out} (${size}x${size}, opaque)`);
}

// favicon.ico at web root (16/32/48 PNG-in-ICO)
const ico = buildICO([16, 32, 48].map((size) => ({ size, png: renderPNG(size, false) })));
const icoOut = path.join(ROOT, 'favicon.ico');
fs.writeFileSync(icoOut, ico);
console.log(`wrote ${icoOut} (16/32/48 ICO)`);
