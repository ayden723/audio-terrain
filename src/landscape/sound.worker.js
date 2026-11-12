// Off the main thread: heights -> sound -> heights, and everything drawn from
// them. The page hands over the elevation grid and gets back the audio, what
// that audio says the heights are, how far that is from the source, and the
// pictures of all three, so nothing heavy runs where it could freeze the page.

import { plan, synthesize, analyse } from './dsp.js';
import { reliefPixels, diffPixels, contours, contourStep } from './render.js';

self.onmessage = (e) => {
  const { id, rows, cols, precision, range, seaSilent, box, heights: src } = e.data;
  try {
    const progress = (stage, f) => self.postMessage({ id, type: 'progress', stage, f });
    const n = rows * cols;

    // the floor: lowest land when the sea is silent, else the lowest point
    const sea = new Uint8Array(n);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (seaSilent && src[i] <= 0) { sea[i] = 1; continue; }
      if (src[i] < lo) lo = src[i];
      if (src[i] > hi) hi = src[i];
    }
    if (!(hi >= lo)) {
      self.postMessage({ id, type: 'silent' }); // nothing but sea
      return;
    }
    const span = hi - lo || 1;

    // linear in decibels: lowest -> -range dB, highest -> 0 dB; row 0 = south
    const amps = new Float32Array(n);
    for (let y = 0; y < rows; y++) {
      const r = rows - 1 - y;
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        amps[r * cols + x] = sea[i] ? 0 : Math.pow(10, (-range + (range * (src[i] - lo)) / span) / 20);
      }
    }

    const p = plan(rows, cols, precision);
    const { samples, gain } = synthesize(p, amps, (f) => progress('Synthesizing', f));
    const measured = analyse(p, samples, gain, (f) => progress('Analysing the audio', f));
    progress('Drawing the map', 0);

    // decibels -> metres; anything clearly under the floor is silence
    const rec = new Float32Array(n);
    const wet = new Uint8Array(n);
    for (let y = 0; y < rows; y++) {
      const r = rows - 1 - y;
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const db = 20 * Math.log10(measured[r * cols + x] + 1e-12);
        if (db < -range - 6) { wet[i] = 1; rec[i] = lo; continue; }
        rec[i] = lo + ((db + range) / range) * span;
      }
    }

    // round-trip error over land both agree on
    const diff = new Float32Array(n);
    const abs = new Float64Array((n >> 3) + 1);
    let kept = 0;
    let se = 0;
    let count = 0;
    let max = 0;
    let misread = 0;
    for (let i = 0; i < n; i++) {
      if (sea[i] !== wet[i]) { misread++; continue; }
      if (sea[i]) continue;
      const d = rec[i] - src[i];
      diff[i] = d;
      se += d * d;
      count++;
      max = Math.max(max, Math.abs(d));
      if ((i & 7) === 0) abs[kept++] = Math.abs(d);
    }
    const sorted = abs.subarray(0, kept).sort();
    const p99 = kept ? sorted[Math.floor(kept * 0.99)] : 0;
    const stats = { rms: count ? Math.sqrt(se / count) : 0, max, misread, p99 };
    const diffScale = Math.max(0.5, p99);

    const both = new Uint8Array(n);
    for (let i = 0; i < n; i++) both[i] = sea[i] | wet[i];
    const step = contourStep(span);
    const px = {
      sound: reliefPixels(rec, wet, rows, cols, box, lo, hi),
      source: reliefPixels(src, sea, rows, cols, box, lo, hi),
      diff: diffPixels(diff, both, rows, cols, diffScale),
    };
    progress('Drawing the map', 0.6);
    const lines = {
      sound: contours(rec, wet, rows, cols, step),
      source: contours(src, sea, rows, cols, step),
    };

    // For the 3D view: Relief reads slices (time = map columns, west -> east) of
    // frequency columns (map rows, south -> north), heights 0..1 over lo..hi.
    const h3d = new Float32Array(n);
    for (let x = 0; x < cols; x++) {
      for (let r = 0; r < rows; r++) {
        const i = (rows - 1 - r) * cols + x;
        h3d[x * rows + r] = wet[i] ? 0 : Math.min(1, Math.max(0, (rec[i] - lo) / span));
      }
    }

    self.postMessage(
      { id, type: 'done', samples, stats, lo, hi, step, diffScale, px, lines, h3d },
      [
        samples.buffer,
        h3d.buffer,
        px.sound.buffer,
        px.source.buffer,
        px.diff.buffer,
        ...lines.sound.map((l) => l.segs.buffer),
        ...lines.source.map((l) => l.segs.buffer),
      ]
    );
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err.message });
  }
};
