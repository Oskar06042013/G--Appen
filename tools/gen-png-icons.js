/**
 * Generates PNG icons for iOS (apple-touch-icon) and PWA without npm deps.
 * Run from project root: node tools/gen-png-icons.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PURPLE = [124, 92, 255];
const MINT = [46, 229, 157];
const BG = [11, 16, 32];
const SHIELD = [11, 16, 32];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpRgb(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

function insideRoundRect(x, y, w, h, rad) {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  if (x < rad) {
    if (y < rad) return (x - rad) ** 2 + (y - rad) ** 2 <= rad * rad;
    if (y >= h - rad) return (x - rad) ** 2 + (y - (h - rad)) ** 2 <= rad * rad;
  } else if (x >= w - rad) {
    if (y < rad) return (x - (w - rad)) ** 2 + (y - rad) ** 2 <= rad * rad;
    if (y >= h - rad) return (x - (w - rad)) ** 2 + (y - (h - rad)) ** 2 <= rad * rad;
  }
  return true;
}

/** Quadratic bezier point at t in [0,1] */
function qbez(p0, p1, p2, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function minDistToQBezier(px, py, p0, p1, p2, samples = 48) {
  let m = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const [x, y] = qbez(p0, p1, p2, t);
    m = Math.min(m, dist2(px, py, x, y));
  }
  return Math.sqrt(m);
}

function insideShield(px, py, w, h) {
  const nx = (px - w * 0.5) / (w * 0.34);
  const ny = (py - h * 0.52) / (h * 0.38);
  const d = nx * nx + ny * ny * 0.92;
  return d < 1;
}

function pixelColor(x, y, size) {
  const w = size;
  const h = size;
  const margin = Math.max(2, Math.floor(size * 0.06));
  const iw = w - 2 * margin;
  const ih = h - 2 * margin;
  const rad = Math.floor(Math.min(iw, ih) * 0.26);
  const lx = x - margin;
  const ly = y - margin;

  if (!insideRoundRect(lx, ly, iw, ih, rad)) {
    return [...BG, 255];
  }

  const t = (lx / Math.max(1, iw - 1) + ly / Math.max(1, ih - 1)) / 2;
  let [r, g, b] = lerpRgb(PURPLE, MINT, Math.max(0, Math.min(1, t)));

  if (insideShield(x, y, w, h)) {
    const a = 0.32;
    r = Math.round(r * (1 - a) + SHIELD[0] * a);
    g = Math.round(g * (1 - a) + SHIELD[1] * a);
    b = Math.round(b * (1 - a) + SHIELD[2] * a);
  }

  const p0 = [margin + iw * 0.12, margin + ih * 0.72];
  const p1 = [margin + iw * 0.48, margin + ih * 0.38];
  const p2 = [margin + iw * 0.88, margin + ih * 0.18];
  const d = minDistToQBezier(x, y, p0, p1, p2, size > 256 ? 80 : 48);
  const halfW = Math.max(4.5, size * 0.032);
  const tLine = Math.max(0, Math.min(1, 1 - (d - (halfW - 2)) / 4));
  const smooth = tLine * tLine * (3 - 2 * tLine);
  if (smooth > 0.01) {
    const br = 255;
    const alpha = 0.45 + 0.55 * smooth;
    r = Math.round(r * (1 - alpha) + br * alpha);
    g = Math.round(g * (1 - alpha) + br * alpha);
    b = Math.round(b * (1 - alpha) + br * alpha);
  }

  return [r, g, b, 255];
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(typeStr, data) {
  const type = Buffer.from(typeStr, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcIn = Buffer.concat([type, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcIn), 0);
  return Buffer.concat([len, type, data, crc]);
}

function encodePng(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelColor(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const root = path.join(__dirname, "..");
const iconsDir = path.join(root, "icons");
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

const sizes = [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
];

for (const [name, sz] of sizes) {
  const buf = encodePng(sz);
  fs.writeFileSync(path.join(iconsDir, name), buf);
  console.log("Wrote icons/" + name + " (" + sz + "×" + sz + ")");
}
