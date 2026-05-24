#!/usr/bin/env node
/**
 * Dependency-free PNG icon generator for Adhan Caster Pro.
 * Renders a crescent + sparkle on a green rounded square at 16/48/128 px
 * using only Node's built-in zlib. Re-run with `node generate-icons.cjs`.
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

// Per-subpixel color in normalized [0,1] coords -> [r,g,b,a]
function sample(u, v) {
  const rr = 0.22; // corner radius
  const dx = Math.abs(u - 0.5) - (0.5 - rr);
  const dy = Math.abs(v - 0.5) - (0.5 - rr);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  const dist = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - rr;
  if (dist > 0) return [0, 0, 0, 0]; // outside rounded rect -> transparent

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

function renderPNG(size) {
  const ss = 4; // supersample factor for anti-aliasing
  const N = size * ss;
  // RGBA raw with a 0 filter byte per row
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
          const px = sample(u, v);
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

for (const size of [16, 48, 128]) {
  const out = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(out, renderPNG(size));
  console.log(`wrote ${out} (${size}x${size})`);
}
