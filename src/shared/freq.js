// The frequency axis both spectrum paths share: the offline STFT in the
// worker and the live analysers. Keeping it in one place is what makes live
// terrain line up with file terrain.

/** Position 0..1 across the display -> frequency in Hz. */
export function freqMap(scale, fmin, fmax) {
  if (scale === 'linear') return (u) => fmin + (fmax - fmin) * u;
  if (scale === 'mel') {
    const m = (f) => 2595 * Math.log10(1 + f / 700);
    const m0 = m(fmin);
    const m1 = m(fmax);
    return (u) => 700 * (Math.pow(10, (m0 + (m1 - m0) * u) / 2595) - 1);
  }
  const r = fmax / fmin;
  return (u) => fmin * Math.pow(r, u);
}

/** Band edges and centres for `cols` display columns, clamped to what `sr` can hold. */
export function bandAxis(cols, scale, fmin, fmax, sr) {
  const hi = Math.min(fmax, sr * 0.4975);
  const lo = Math.max(2, Math.min(fmin, hi * 0.5));
  const toF = freqMap(scale, lo, hi);
  const edges = new Float64Array(cols + 1);
  for (let c = 0; c <= cols; c++) edges[c] = toF(c / cols);
  const centers = new Float32Array(cols);
  for (let c = 0; c < cols; c++) centers[c] = toF((c + 0.5) / cols);
  return { edges, centers };
}

/**
 * For one FFT size, how each display column reads the spectrum: the average of
 * the bins inside its band (frac = -1), or, where the band is narrower than a
 * bin, an interpolation between the two bins around its centre. `top` is the
 * highest bin that exists: N/2 for our own FFT, N/2 - 1 for an AnalyserNode.
 */
export function columnMap(N, sr, edges, centers, cols, top = N >> 1) {
  const binw = sr / N;
  const lo = new Int32Array(cols);
  const hi = new Int32Array(cols);
  const frac = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const i0 = Math.ceil(edges[c] / binw);
    const i1 = Math.floor(edges[c + 1] / binw);
    if (i1 >= i0 && i1 >= 0 && i0 <= top) {
      lo[c] = Math.max(0, i0);
      hi[c] = Math.min(top, i1);
      frac[c] = -1;
    } else {
      const x = Math.min(top - 1, Math.max(0, centers[c] / binw));
      lo[c] = Math.floor(x);
      hi[c] = Math.min(top, lo[c] + 1);
      frac[c] = x - lo[c];
    }
  }
  return { lo, hi, frac };
}

/**
 * Which FFT size suits each column, as a position along `sizes` (ascending):
 * 0 = the shortest, sizes.length - 1 = the longest, fractions blend two
 * neighbours. Wide FFTs where columns are narrow (bass), short ones where
 * columns are wide (treble).
 */
export function sizeBlend(sizes, sr, edges, cols) {
  const log2s = sizes.map((n) => Math.log2(n));
  const last = log2s.length - 1;
  const out = new Float64Array(cols);
  for (let c = 0; c < cols; c++) {
    const bw = Math.max(1e-6, edges[c + 1] - edges[c]);
    const ideal = Math.log2((2 * sr) / bw);
    if (ideal >= log2s[last]) { out[c] = last; continue; }
    if (ideal <= log2s[0]) continue;
    for (let i = 0; i < last; i++) {
      if (ideal >= log2s[i] && ideal <= log2s[i + 1]) {
        out[c] = i + (ideal - log2s[i]) / (log2s[i + 1] - log2s[i]);
        break;
      }
    }
  }
  return out;
}
