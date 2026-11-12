// Drawing a height grid the way a topographic map does: elevation tints,
// hillshading from the north-west, and contour lines. Grids are rows x cols,
// row 0 = north; `water` marks cells that are sea (or silent).

import { cellMetres } from './geo.js';

// Classic hypsometric tints, spread over the area's own height range.
const TINTS = [
  [0.0, [92, 134, 78]],
  [0.15, [138, 168, 98]],
  [0.35, [214, 206, 148]],
  [0.55, [196, 160, 112]],
  [0.75, [150, 116, 88]],
  [0.9, [184, 170, 154]],
  [1.0, [236, 230, 220]],
];
const WATER = [150, 190, 221];
const VOID = [205, 205, 200];

function tint(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < TINTS.length; i++) {
    const [t1, c1] = TINTS[i];
    if (t <= t1) {
      const [t0, c0] = TINTS[i - 1];
      const u = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
    }
  }
  return TINTS[TINTS.length - 1][1];
}

/** Tinted, hillshaded relief as RGBA pixels, one per cell. */
export function reliefPixels(h, water, rows, cols, box, lo, hi) {
  const px = new Uint8ClampedArray(rows * cols * 4);
  const span = hi - lo || 1;
  // sun in the north-west (azimuth 315), 45 degrees up; x = east, y = north
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  const lx = Math.sin(az) * Math.cos(alt);
  const ly = Math.cos(az) * Math.cos(alt);
  const lz = Math.sin(alt);
  const at = (x, y) => h[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))];
  for (let y = 0; y < rows; y++) {
    const d = cellMetres(box, rows, y);
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const o = i * 4;
      px[o + 3] = 255;
      if (water[i]) {
        px[o] = WATER[0]; px[o + 1] = WATER[1]; px[o + 2] = WATER[2];
        continue;
      }
      const v = h[i];
      if (!Number.isFinite(v)) {
        px[o] = VOID[0]; px[o + 1] = VOID[1]; px[o + 2] = VOID[2];
        continue;
      }
      const dzdx = (at(x + 1, y) - at(x - 1, y)) / (2 * d);
      const dzdy = (at(x, y - 1) - at(x, y + 1)) / (2 * d); // +y = north
      // surface normal (-dz/dx, -dz/dy, 1) against the sun; flat ground = 1
      const shade = Math.max(0, (-dzdx * lx - dzdy * ly + lz) / Math.hypot(dzdx, dzdy, 1)) / lz;
      const k = Math.min(1.3, 0.35 + 0.65 * shade);
      const c = tint((v - lo) / span);
      px[o] = c[0] * k;
      px[o + 1] = c[1] * k;
      px[o + 2] = c[2] * k;
    }
  }
  return px;
}

/** Differences in metres: blue = too low, red = too high, white = exact. */
export function diffPixels(diff, water, rows, cols, scale) {
  const px = new Uint8ClampedArray(rows * cols * 4);
  for (let i = 0; i < rows * cols; i++) {
    const o = i * 4;
    px[o + 3] = 255;
    if (water[i]) {
      px[o] = 214; px[o + 1] = 222; px[o + 2] = 230;
      continue;
    }
    const t = Math.max(-1, Math.min(1, diff[i] / scale));
    const a = Math.abs(t);
    if (t >= 0) {
      px[o] = 255 - 40 * a; px[o + 1] = 255 - 200 * a; px[o + 2] = 255 - 210 * a;
    } else {
      px[o] = 255 - 215 * a; px[o + 1] = 255 - 150 * a; px[o + 2] = 255 - 40 * a;
    }
  }
  return px;
}

/** A round contour interval giving roughly `target` lines over the relief. */
export function contourStep(relief, target = 24) {
  const raw = Math.max(relief, 1) / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** A growing list of line segments, four numbers (x0, y0, x1, y1) each. */
class Segments {
  constructor() {
    this.data = new Float32Array(4096);
    this.length = 0;
  }

  push(x0, y0, x1, y1) {
    if (this.length + 4 > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    const d = this.data;
    const n = this.length;
    d[n] = x0; d[n + 1] = y0; d[n + 2] = x1; d[n + 3] = y1;
    this.length = n + 4;
  }

  done() {
    return this.data.slice(0, this.length);
  }
}

/**
 * Contour segments by marching squares, in cell-centre coordinates (cell x
 * spans x..x+1, its centre is x+0.5). Returns [{ index, segs }], where segs is
 * a Float32Array of x0, y0, x1, y1 and index lines (every fifth) are drawn
 * heavier, as on printed maps.
 */
export function contours(h, water, rows, cols, step) {
  const thin = new Segments();
  const thick = new Segments();
  for (let y = 0; y < rows - 1; y++) {
    const cy = y + 0.5;
    for (let x = 0; x < cols - 1; x++) {
      const i = y * cols + x;
      if (water[i] || water[i + 1] || water[i + cols] || water[i + cols + 1]) continue;
      const a = h[i];            // top-left
      const b = h[i + 1];        // top-right
      const c = h[i + cols + 1]; // bottom-right
      const d = h[i + cols];     // bottom-left
      const mn = Math.min(a, b, c, d);
      const mx = Math.max(a, b, c, d);
      const cx = x + 0.5;
      for (let k = Math.ceil(mn / step); k * step < mx; k++) {
        const lv = k * step;
        const code = (a >= lv ? 8 : 0) | (b >= lv ? 4 : 0) | (c >= lv ? 2 : 0) | (d >= lv ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const out = k % 5 === 0 ? thick : thin;
        // where the level crosses each side of the cell
        const topX = cx + (lv - a) / (b - a);
        const rightY = cy + (lv - b) / (c - b);
        const bottomX = cx + (lv - d) / (c - d);
        const leftY = cy + (lv - a) / (d - a);
        switch (code) {
          case 1: case 14: out.push(cx, leftY, bottomX, cy + 1); break;
          case 2: case 13: out.push(bottomX, cy + 1, cx + 1, rightY); break;
          case 3: case 12: out.push(cx, leftY, cx + 1, rightY); break;
          case 4: case 11: out.push(topX, cy, cx + 1, rightY); break;
          case 6: case 9: out.push(topX, cy, bottomX, cy + 1); break;
          case 7: case 8: out.push(cx, leftY, topX, cy); break;
          case 5: out.push(cx, leftY, topX, cy); out.push(bottomX, cy + 1, cx + 1, rightY); break;
          case 10: out.push(topX, cy, cx + 1, rightY); out.push(cx, leftY, bottomX, cy + 1); break;
        }
      }
    }
  }
  return [{ index: false, segs: thin.done() }, { index: true, segs: thick.done() }];
}
