/**
 * Generate the PWA PNG icons (192/512) with a dependency-free PNG encoder:
 * a rounded-square shell with an accent chevron and radio arcs, supersampled
 * for antialiasing. Run: node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── minimal PNG encoder ────────────────────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ── drawing ────────────────────────────────────────────────────────────────
const clamp01 = (value) => Math.min(1, Math.max(0, value));
const smooth = (distance, halfWidth) => clamp01(0.5 + (halfWidth - distance)); // ~1px soft edge

/** Signed distance-ish coverage of a rounded rectangle in 0..1 space. */
function roundedRectCoverage(px, py, radius) {
  const cx = clamp01(px) === px ? px : clamp01(px);
  const cy = clamp01(py) === py ? py : clamp01(py);
  const dx = Math.abs(px - cx);
  const dy = Math.abs(py - cy);
  const inside = px >= 0 && px <= 1 && py >= 0 && py <= 1;
  const corner = Math.hypot(dx - (1 - radius), dy - (1 - radius));
  if (inside && (dx <= 1 - radius || dy <= 1 - radius || corner <= 0)) return 1;
  const dist = inside ? Math.max(corner, 0) : Math.hypot(px - cx, py - cy);
  return smooth(dist, 0.008);
}

function segmentCoverage(px, py, ax, ay, bx, by, width) {
  const abx = bx - ax;
  const aby = by - ay;
  const length2 = abx * abx + aby * aby;
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / length2);
  const dist = Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
  return smooth(dist, width / 2);
}

function paint(x, y) {
  // shell background
  const bg = roundedRectCoverage(x, y, 0.22);
  // shell border
  const outer = roundedRectCoverage((x - 0.046) / 0.908, (y - 0.046) / 0.908, 0.2);
  const inner = roundedRectCoverage((x - 0.085) / 0.83, (y - 0.085) / 0.83, 0.18);
  const border = Math.max(0, outer - inner);
  // chevron strokes
  const chev = Math.max(
    segmentCoverage(x, y, 0.42, 0.3, 0.62, 0.5, 0.095),
    segmentCoverage(x, y, 0.62, 0.5, 0.42, 0.7, 0.095),
  );
  // radio arcs + dot
  const arc1 = Math.max(
    segmentCoverage(x, y, 0.72, 0.25, 0.86, 0.16, 0.05),
    segmentCoverage(x, y, 0.72, 0.25, 0.82, 0.22, 0.05),
  );
  const arc2 = Math.max(
    segmentCoverage(x, y, 0.78, 0.21, 0.92, 0.1, 0.05),
    segmentCoverage(x, y, 0.78, 0.21, 0.9, 0.17, 0.05),
  );
  const dot = smooth(Math.hypot(x - 0.78, y - 0.32), 0.028);

  let r = 0.07;
  let g = 0.1;
  let b = 0.13;
  let a = bg;
  // border → accent
  const accent = border * 0.9;
  r += accent * (0.3 - r);
  g += accent * (0.62 - g);
  b += accent * (1 - b);
  // chevron → accent
  const chevColor = chev * 0.95;
  r += chevColor * (0.3 - r);
  g += chevColor * (0.62 - g);
  b += chevColor * (1 - b);
  // arcs → muted
  const arcColor = (arc1 * 0.9 + arc2 * 0.75 + dot) * 0.85;
  r += arcColor * (0.55 - r);
  g += arcColor * (0.6 - g);
  b += arcColor * (0.65 - b);
  return [r, g, b, a];
}

function render(size, samples = 3) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const [pr, pg, pb, pa] = paint(
            (x + (sx + 0.5) / samples) * step,
            (y + (sy + 0.5) / samples) * step,
          );
          r += pr;
          g += pg;
          b += pb;
          a += pa;
        }
      }
      const count = samples * samples;
      const index = (y * size + x) * 4;
      rgba[index] = Math.round((r / count) * 255);
      rgba[index + 1] = Math.round((g / count) * 255);
      rgba[index + 2] = Math.round((b / count) * 255);
      rgba[index + 3] = Math.round((a / count) * 255);
    }
  }
  return rgba;
}

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
mkdirSync(distDir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(distDir, `icon-${size}.png`), encodePng(size, size, render(size)));
  console.log(`wrote icon-${size}.png`);
}
