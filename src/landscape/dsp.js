// Matched synthesis and analysis. The two are designed as a pair, so analysing
// the audio gives back the grid that went in:
//
// - Every grid row is one sine partial placed exactly on an analysis bin, and
//   partials sit at least two bins apart. A Hann window sees an on-bin sine in
//   only its own bin and the two beside it, so steady neighbours never leak
//   into each other.
// - Every grid column is exactly one analysis frame of N samples, centred on
//   the column. Between column centres each partial's amplitude crossfades
//   with a raised cosine, so there are no clicks or kinks to splatter energy.
// - A frame measures the window-weighted average of that crossfade, which
//   blurs each column slightly into its neighbours. The blur is a known
//   three-tap filter, so synthesis undoes it in advance (deconvolution).
//
// Because every partial is on a bin of N, a column's steady sound repeats
// every N samples, so it is built with one inverse FFT per column instead of
// one oscillator per row.

import { fft } from './fft.js';

export const SAMPLE_RATE = 48000;
const MIN_HZ = 40;       // lowest partial
const TOP = 0.45;        // highest partial, as a fraction of the sample rate (21.6 kHz)

/**
 * Pick the frame size for a grid. `precision` (1, 2 or 4) doubles the frame
 * per step: longer audio, partials further apart, cleaner separation.
 */
export function plan(rows, cols, precision = 1) {
  const fit = (n) => {
    const k0 = Math.max(4, Math.ceil((MIN_HZ * n) / SAMPLE_RATE));
    const spacing = rows > 1 ? Math.floor((Math.floor(TOP * n) - k0) / (rows - 1)) : 2;
    return { k0, spacing };
  };
  let n = 256;
  while (fit(n).spacing < 2) n *= 2;
  n *= precision;
  const { k0, spacing } = fit(n);
  return {
    rows,
    cols,
    n,
    k0,
    spacing,
    sampleRate: SAMPLE_RATE,
    duration: (cols * n) / SAMPLE_RATE,
    hz: (r) => ((k0 + r * spacing) * SAMPLE_RATE) / n,
  };
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// Sample offset of column c's centre: frames are [c*n, (c+1)*n).
const centre = (c, n) => c * n + n / 2;
// Weight of the current column at fraction u (0..1) of the way to the next centre.
const fade = (u) => 0.5 + 0.5 * Math.cos(Math.PI * u);

/**
 * How much of each neighbouring column one analysis frame picks up: the frame
 * measures (1 - 2b) * own + b * (left + right). Computed from the actual
 * window and crossfade rather than a formula, so it is exact for them.
 */
function blurWeight(n) {
  const w = hann(n);
  let sum = 0;
  let side = 0;
  const mid = n / 2;
  for (let i = 0; i < n; i++) {
    sum += w[i];
    if (i >= mid) side += w[i] * (1 - fade((i - mid) / n));
  }
  return side / sum;
}

/**
 * Solve (1-2b) a[c] + b (a[c-1] + a[c+1]) = m[c] for a (Thomas algorithm).
 * Before the first and after the last centre the amplitude holds, so the end
 * rows see their own value instead of a missing neighbour.
 */
function deblur(m, b, out, cp, dp) {
  const len = m.length;
  if (len === 1) { out[0] = m[0]; return; }
  const diag = (c) => (c === 0 || c === len - 1 ? 1 - b : 1 - 2 * b);
  cp[0] = b / diag(0);
  dp[0] = m[0] / diag(0);
  for (let c = 1; c < len; c++) {
    const den = diag(c) - b * cp[c - 1];
    cp[c] = b / den;
    dp[c] = (m[c] - b * dp[c - 1]) / den;
  }
  out[len - 1] = dp[len - 1];
  for (let c = len - 2; c >= 0; c--) out[c] = dp[c] - cp[c] * out[c + 1];
}

// Small seeded PRNG so the same grid always makes the same sound.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthesize audio whose analysis is `amps`: Float32Array rows*cols of linear
 * amplitudes (0..1), row 0 = lowest partial. Returns { samples, gain }, where
 * gain is the factor the audio was scaled by to peak at -1 dBFS.
 */
export function synthesize(p, amps, onProgress) {
  const { rows, cols, n, k0, spacing } = p;
  const b = blurWeight(n);

  // undo the analysis blur, row by row
  const pre = new Float32Array(rows * cols);
  const m = new Float64Array(cols);
  const a = new Float64Array(cols);
  const cp = new Float64Array(cols);
  const dp = new Float64Array(cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) m[c] = amps[r * cols + c];
    deblur(m, b, a, cp, dp);
    for (let c = 0; c < cols; c++) pre[r * cols + c] = a[c];
  }

  const rand = rng(0x51ab);
  const cosP = new Float64Array(rows);
  const sinP = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const phi = rand() * 2 * Math.PI;
    cosP[r] = Math.cos(phi);
    sinP[r] = Math.sin(phi);
  }

  // One period of column c's steady sound: sum of a*cos(2*pi*k*i/n + phi).
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const period = (c, out) => {
    re.fill(0);
    im.fill(0);
    for (let r = 0; r < rows; r++) {
      const k = k0 + r * spacing;
      const v = pre[r * cols + c];
      re[k] = v * cosP[r];
      im[k] = -v * sinP[r];
    }
    fft(re, im); // conj trick: Re(fft(conj Z)) = Re(ifft-sum of Z)
    for (let i = 0; i < n; i++) out[i] = re[i];
  };

  const total = cols * n;
  const out = new Float32Array(total);
  let cur = new Float64Array(n);
  let next = new Float64Array(n);
  period(0, cur);
  // hold the first column up to its centre
  for (let i = 0; i < n / 2; i++) out[i] = cur[i % n];
  for (let c = 0; c < cols; c++) {
    const t0 = centre(c, n);
    if (c === cols - 1) {
      for (let i = t0; i < total; i++) out[i] = cur[i % n];
      break;
    }
    period(c + 1, next);
    for (let j = 0; j < n; j++) {
      const i = t0 + j;
      const g = fade(j / n);
      out[i] = g * cur[i % n] + (1 - g) * next[i % n];
    }
    [cur, next] = [next, cur];
    if (onProgress && (c & 31) === 0) onProgress(c / cols);
  }

  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  const gain = peak > 0 ? 0.891 / peak : 1;
  for (let i = 0; i < total; i++) out[i] *= gain;
  return { samples: out, gain };
}

/**
 * Analyse audio made by synthesize() back into linear amplitudes, with the
 * same frames and bins. `gain` is the calibration synthesize() returned.
 */
export function analyse(p, samples, gain, onProgress) {
  const { rows, cols, n, k0, spacing } = p;
  const w = hann(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) wsum += w[i];
  const scale = 2 / (wsum * gain);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const out = new Float32Array(rows * cols);
  for (let c = 0; c < cols; c++) {
    const off = c * n;
    for (let i = 0; i < n; i++) {
      re[i] = (samples[off + i] || 0) * w[i];
      im[i] = 0;
    }
    fft(re, im);
    // frames start at a multiple of n, so bin phases line up with synthesis
    for (let r = 0; r < rows; r++) {
      const k = k0 + r * spacing;
      out[r * cols + c] = Math.hypot(re[k], im[k]) * scale;
    }
    if (onProgress && (c & 31) === 0) onProgress(c / cols);
  }
  return out;
}
