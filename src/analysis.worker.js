// Multi-resolution STFT analysis + additive image-to-audio synthesis.
// Everything here runs off the main thread.

const QUALITY = {
  standard: { sizes: [4096], overlap: 4 },
  high: { sizes: [2048, 8192], overlap: 4 },
  ultra: { sizes: [1024, 4096, 16384], overlap: 8 },
};
const MAX_FRAMES_PER_SIZE = 100000;
// Averaging more than a handful of frames per slice is visually indistinguishable
// but scales the cost linearly, which is what made long songs slow.
const MAX_FRAMES_PER_SLICE = 10;

let audio = null; // { samples: Float32Array, sampleRate }
let data = null;  // { values: Float32Array, slices, cols, freqs, isDb }
// Stand-in audio for what-if previews while nothing is loaded, with its analyses
// cached by parameters so hovering a setting twice costs nothing.
let specimen = null;
const specimenCache = new Map();

/* ---------------------------------------------------------------- FFT ---- */

class FFT {
  constructor(n) {
    this.n = n;
    this.levels = Math.log2(n) | 0;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < this.levels; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  // In-place complex forward transform.
  transform(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const l = i + j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[i + j] - tre;
          im[l] = im[i + j] - tim;
          re[i + j] += tre;
          im[i + j] += tim;
        }
      }
    }
  }
}

const fftCache = new Map();
const winCache = new Map();

function getFFT(n) {
  let f = fftCache.get(n);
  if (!f) { f = new FFT(n); fftCache.set(n, f); }
  return f;
}

// Blackman-Harris: very low sidelobes, so the noise floor stays clean.
function getWindow(n) {
  let w = winCache.get(n);
  if (!w) {
    const a = [0.35875, 0.48829, 0.14128, 0.01168];
    const arr = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = (2 * Math.PI * i) / (n - 1);
      const v = a[0] - a[1] * Math.cos(x) + a[2] * Math.cos(2 * x) - a[3] * Math.cos(3 * x);
      arr[i] = v;
      sum += v;
    }
    w = { arr, sum };
    winCache.set(n, w);
  }
  return w;
}

/* -------------------------------------------------------- frequency map -- */

function freqMap(scale, fmin, fmax) {
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

/** For one FFT size, how each output column reads the spectrum. */
function columnMap(N, sr, edges, centers, cols) {
  const binw = sr / N;
  const nb = N >> 1;
  const lo = new Int32Array(cols);
  const hi = new Int32Array(cols);
  const frac = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const a = edges[c] / binw;
    const b = edges[c + 1] / binw;
    const i0 = Math.ceil(a);
    const i1 = Math.floor(b);
    if (i1 >= i0 && i1 >= 0 && i0 <= nb) {
      lo[c] = Math.max(0, i0);
      hi[c] = Math.min(nb, i1);
      frac[c] = -1; // band average
    } else {
      const x = Math.min(nb - 1, Math.max(0, centers[c] / binw));
      lo[c] = Math.floor(x);
      hi[c] = Math.min(nb, lo[c] + 1);
      frac[c] = x - lo[c]; // interpolate
    }
  }
  return { lo, hi, frac };
}

function fillFrame(dst, samples, start, win, N) {
  const n = samples.length;
  for (let i = 0; i < N; i++) {
    const j = start + i;
    dst[i] = j >= 0 && j < n ? samples[j] * win[i] : 0;
  }
}

function accumulate(power, map, acc, cols) {
  const { lo, hi, frac } = map;
  for (let c = 0; c < cols; c++) {
    if (frac[c] < 0) {
      let s = 0;
      const a = lo[c];
      const b = hi[c];
      for (let i = a; i <= b; i++) s += power[i];
      acc[c] += s / (b - a + 1);
    } else {
      const f = frac[c];
      acc[c] += power[lo[c]] * (1 - f) + power[hi[c]] * f;
    }
  }
}

/* ------------------------------------------------------------- analyse --- */

function analyze(source, p, id) {
  const { samples, sampleRate: sr } = source;
  const slices = Math.max(2, p.slices | 0);
  const cols = Math.max(8, p.cols | 0);
  const fmax = Math.min(p.fmax, sr * 0.4975);
  const fmin = Math.max(2, Math.min(p.fmin, fmax * 0.5));
  const toF = freqMap(p.scale, fmin, fmax);

  const edges = new Float64Array(cols + 1);
  for (let c = 0; c <= cols; c++) edges[c] = toF(c / cols);
  const centers = new Float32Array(cols);
  for (let c = 0; c < cols; c++) centers[c] = toF((c + 0.5) / cols);

  const q = QUALITY[p.quality] || QUALITY.high;
  const L = samples.length / slices;
  const capPerSlice = Math.max(1, Math.floor(MAX_FRAMES_PER_SIZE / slices));

  const plans = q.sizes.map((N) => {
    let m = Math.max(1, Math.ceil(L / (N / q.overlap)));
    m = Math.min(m, capPerSlice, MAX_FRAMES_PER_SLICE);
    if (m > 1 && m % 2) m++;
    return { N, m, map: columnMap(N, sr, edges, centers, cols) };
  });

  const totalFrames = plans.reduce((s, pl) => s + pl.m * slices, 0);
  let done = 0;
  let lastPost = 0;

  const results = [];
  for (const plan of plans) {
    const { N, m, map } = plan;
    const fft = getFFT(N);
    const win = getWindow(N);
    const norm = N / (win.sum * win.sum);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const nb = N >> 1;
    const pa = new Float64Array(nb + 1);
    const pb = new Float64Array(nb + 1);
    const acc = new Float64Array(cols);
    const out = new Float32Array(slices * cols);

    for (let k = 0; k < slices; k++) {
      acc.fill(0);
      const s0 = k * L;
      let count = 0;
      for (let j = 0; j < m; j += 2) {
        fillFrame(re, samples, Math.round(s0 + ((j + 0.5) * L) / m - N / 2), win.arr, N);
        const paired = j + 1 < m;
        if (paired) fillFrame(im, samples, Math.round(s0 + ((j + 1.5) * L) / m - N / 2), win.arr, N);
        else im.fill(0);

        fft.transform(re, im);

        // Two real frames packed into one complex transform.
        for (let b = 0; b <= nb; b++) {
          const nbk = (N - b) & (N - 1);
          const sr1 = re[b] + re[nbk];
          const dr = re[b] - re[nbk];
          const si = im[b] + im[nbk];
          const di = im[b] - im[nbk];
          pa[b] = (sr1 * sr1 + di * di) * 0.25 * norm;
          if (paired) pb[b] = (si * si + dr * dr) * 0.25 * norm;
        }

        accumulate(pa, map, acc, cols);
        count++;
        if (paired) { accumulate(pb, map, acc, cols); count++; }

        done += paired ? 2 : 1;
        const now = performance.now();
        if (id != null && now - lastPost > 120) {
          lastPost = now;
          self.postMessage({ type: 'progress', id, value: done / totalFrames, size: N });
        }
      }
      const base = k * cols;
      for (let c = 0; c < cols; c++) out[base + c] = 10 * Math.log10(acc[c] / count + 1e-30);
    }
    results.push(out);
  }

  // Blend the resolutions: wide FFTs where columns are narrow (low frequencies),
  // short FFTs where columns are wide (high frequencies).
  const db = new Float32Array(slices * cols);
  const log2s = plans.map((pl) => Math.log2(pl.N));
  for (let c = 0; c < cols; c++) {
    const bw = Math.max(1e-6, edges[c + 1] - edges[c]);
    const ideal = Math.log2((2 * sr) / bw);
    let i0 = 0;
    let i1 = 0;
    let t = 0;
    if (ideal >= log2s[log2s.length - 1]) {
      i0 = i1 = log2s.length - 1;
    } else if (ideal > log2s[0]) {
      for (let i = 0; i < log2s.length - 1; i++) {
        if (ideal >= log2s[i] && ideal <= log2s[i + 1]) {
          i0 = i;
          i1 = i + 1;
          t = (ideal - log2s[i]) / (log2s[i + 1] - log2s[i]);
          break;
        }
      }
    }
    const A = results[i0];
    const B = results[i1];
    for (let k = 0; k < slices; k++) {
      const idx = k * cols + c;
      db[idx] = A[idx] * (1 - t) + B[idx] * t;
    }
  }

  return { values: db, slices, cols, freqs: centers, isDb: true };
}

function specimenData(p) {
  const key = JSON.stringify(p);
  let d = specimenCache.get(key);
  if (!d) {
    if (specimenCache.size >= 8) specimenCache.delete(specimenCache.keys().next().value);
    d = analyze(specimen, p, null);
    specimenCache.set(key, d);
  }
  return d;
}

/* ------------------------------------------------------------ synthesis -- */

function synth(msg, id) {
  const p = msg.params;
  const rows = msg.rows;
  const cols = msg.cols;
  const px = msg.pixels;
  const sr = p.sampleRate;
  const n = Math.max(1, Math.round(p.duration * sr));
  const out = new Float64Array(n);
  const toF = freqMap(p.scale, p.fmin, Math.min(p.fmax, sr * 0.47));
  const thr = p.threshold;
  const amps = new Float64Array(cols);

  for (let r = 0; r < rows; r++) {
    const u = 1 - (r + 0.5) / rows;
    const f = toF(u);
    if (!(f > 0) || f >= sr * 0.49) continue;

    let any = false;
    for (let x = 0; x < cols; x++) {
      const b = px[r * cols + x];
      const a = b <= thr ? 0 : Math.pow(10, ((b - 1) * p.dbRange) / 20);
      amps[x] = a;
      if (a > 0) any = true;
    }
    if (!any) continue;

    const w = (2 * Math.PI * f) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const phi = Math.random() * Math.PI * 2;
    let yr = Math.cos(phi);
    let yi = Math.sin(phi);

    // One segment per pixel column, amplitude ramped linearly across it.
    for (let x = 0; x <= cols; x++) {
      const c0 = (x - 0.5) / cols;
      const c1 = (x + 0.5) / cols;
      const s0 = Math.max(0, Math.round(c0 * n));
      const s1 = Math.min(n, Math.round(c1 * n));
      if (s1 <= s0) continue;
      const a0 = amps[Math.min(cols - 1, Math.max(0, x - 1))];
      const a1 = amps[Math.min(cols - 1, Math.max(0, x))];
      const segA = x === 0 ? 0 : a0;
      const segB = x === cols ? 0 : a1;

      if (segA === 0 && segB === 0) {
        const ph = w * (s1 - s0);
        const c = Math.cos(ph);
        const s = Math.sin(ph);
        const nr = yr * c - yi * s;
        yi = yr * s + yi * c;
        yr = nr;
        continue;
      }
      const inv = 1 / (s1 - s0);
      for (let i = s0; i < s1; i++) {
        const t = (i - s0) * inv;
        out[i] += (segA + (segB - segA) * t) * yi;
        const nr = yr * cw - yi * sw;
        yi = yr * sw + yi * cw;
        yr = nr;
      }
      const mag = Math.hypot(yr, yi) || 1;
      yr /= mag;
      yi /= mag;
    }

    if (r % 8 === 0) self.postMessage({ type: 'progress', id, value: r / rows });
  }

  const res = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const g = peak > 0 ? 0.89 / peak : 0;
  const fade = Math.min(Math.round(sr * 0.008), n >> 1);
  for (let i = 0; i < n; i++) {
    let v = out[i] * g;
    if (i < fade) v *= i / fade;
    if (i > n - fade) v *= (n - i) / fade;
    res[i] = v;
  }
  return res;
}


/* -------------------------------------------------------------- shape --- */

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, r };
}

function blur2d(a, slices, cols, sigmaCols, sigmaSlices) {
  if (sigmaCols > 0.05) {
    const { k, r } = gaussKernel(sigmaCols);
    const row = new Float32Array(cols);
    for (let s = 0; s < slices; s++) {
      const base = s * cols;
      row.set(a.subarray(base, base + cols));
      for (let c = 0; c < cols; c++) {
        let v = 0;
        for (let i = -r; i <= r; i++) v += row[Math.min(cols - 1, Math.max(0, c + i))] * k[i + r];
        a[base + c] = v;
      }
    }
  }
  if (sigmaSlices > 0.05 && slices > 2) {
    const { k, r } = gaussKernel(sigmaSlices);
    const col = new Float32Array(slices);
    for (let c = 0; c < cols; c++) {
      for (let s = 0; s < slices; s++) col[s] = a[s * cols + c];
      for (let s = 0; s < slices; s++) {
        let v = 0;
        for (let i = -r; i <= r; i++) v += col[Math.min(slices - 1, Math.max(0, s + i))] * k[i + r];
        a[s * cols + c] = v;
      }
    }
  }
  return a;
}

function percentile(a, p) {
  const step = Math.max(1, Math.floor(a.length / 40000));
  const n = Math.floor(a.length / step);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = a[i * step];
  s.sort();
  return s[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
}

/** dB (or image luminance) -> 0..1 heights. */
function shapeHeights(d, p) {
  if (!d) throw new Error('nothing to shape yet');
  const { slices, cols, isDb } = d;
  const a = Float32Array.from(d.values);

  if (isDb && p.tilt && d.freqs) {
    for (let c = 0; c < cols; c++) {
      const t = p.tilt * Math.log2(Math.max(d.freqs[c], 1) / 1000);
      for (let s = 0; s < slices; s++) a[s * cols + c] += t;
    }
  }

  blur2d(a, slices, cols, p.smoothF, p.smoothT);

  let lo = 0;
  let span = 1;
  if (isDb) {
    lo = percentile(a, 0.995) - p.range;
    span = Math.max(1e-6, p.range);
  }

  const cut = Math.min(0.95, Math.max(0, p.cut));
  const g = Math.max(0.05, p.gamma);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let h = (a[i] - lo) / span;
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    if (cut > 0) h = Math.max(0, (h - cut) / (1 - cut));
    out[i] = Math.pow(h, g);
  }
  return out;
}

/* -------------------------------------------------------------- router -- */

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'setAudio') {
      audio = { samples: m.samples, sampleRate: m.sampleRate };
      return;
    }
    if (m.type === 'analyze') {
      if (!audio) throw new Error('no audio loaded');
      data = analyze(audio, m.params, m.id);
      self.postMessage({ type: 'analyzed', id: m.id, slices: data.slices, cols: data.cols });
      return;
    }
    if (m.type === 'setLevels') {
      data = { values: m.values, slices: m.slices, cols: m.cols, isDb: false };
      return;
    }
    if (m.type === 'shape') {
      const heights = shapeHeights(data, m.params);
      self.postMessage({ type: 'heights', id: m.id, heights }, [heights.buffer]);
      return;
    }
    if (m.type === 'setSpecimen') {
      specimen = { samples: m.samples, sampleRate: m.sampleRate };
      specimenCache.clear();
      return;
    }
    if (m.type === 'preview') {
      // A what-if for the explainer card. It never replaces the resident matrix.
      let d = data;
      if (m.levels) d = { ...m.levels, isDb: false };
      else if (m.specimen) d = specimenData(m.analysis);
      else if (m.analysis) {
        if (!audio) throw new Error('no audio loaded');
        d = analyze(audio, m.analysis, null);
      }
      const heights = shapeHeights(d, m.shape);
      self.postMessage({ type: 'preview', id: m.id, heights, slices: d.slices, cols: d.cols }, [heights.buffer]);
      return;
    }
    if (m.type === 'synth') {
      const samples = synth(m, m.id);
      self.postMessage(
        { type: 'audio', id: m.id, samples, sampleRate: m.params.sampleRate },
        [samples.buffer]
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
