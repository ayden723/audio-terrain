/* ============================================================
   spectrogram.js — turn audio samples into a 2D loudness grid
   ------------------------------------------------------------
   We compute a Short-Time Fourier Transform (STFT): slide a window
   along the audio, run an FFT on each window, and keep the magnitude
   of each frequency. The result is a grid:  loudness[freq][time].

   To keep every file fast and consistent we render to a FIXED grid
   (TIME_STEPS x FREQ_BINS) and use a LOG frequency scale so bass gets
   room and the landscape looks musical rather than bottom-heavy.
   ============================================================ */

const FFT_SIZE   = 2048; // samples per analysis window (power of two)
const TIME_STEPS = 1024; // columns in the output grid (time resolution)
const FREQ_BINS  = 384;  // rows in the output grid (frequency resolution)
const DB_FLOOR   = -90;  // anything quieter than this maps to 0

/* ---------- A small in-place radix-2 FFT (Cooley–Tukey) ---------- */
function fft(re, im) {
  const n = re.length;

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/* ---------- Mix all channels down to a single mono track ---------- */
function toMono(buffer) {
  const n = buffer.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += data[i];
  }
  const inv = 1 / buffer.numberOfChannels;
  for (let i = 0; i < n; i++) mono[i] *= inv;
  return mono;
}

/* ---------- Precompute which FFT bins fall into each log band ---------- */
function buildLogBands(sampleRate) {
  const nyquist = sampleRate / 2;
  const half = FFT_SIZE / 2;            // number of usable FFT bins
  const binHz = nyquist / half;         // Hz per linear FFT bin
  const fMin = Math.max(20, binHz);     // start of lowest log band
  const fMax = nyquist;
  const logMin = Math.log(fMin);
  const logMax = Math.log(fMax);

  // For each output row, the [startBin, endBin) range of FFT bins it covers.
  const bands = [];
  for (let r = 0; r < FREQ_BINS; r++) {
    const f0 = Math.exp(logMin + (logMax - logMin) * (r / FREQ_BINS));
    const f1 = Math.exp(logMin + (logMax - logMin) * ((r + 1) / FREQ_BINS));
    let b0 = Math.floor(f0 / binHz);
    let b1 = Math.ceil(f1 / binHz);
    b0 = Math.max(1, Math.min(half - 1, b0));
    b1 = Math.max(b0 + 1, Math.min(half, b1));
    bands.push([b0, b1]);
  }
  return bands;
}

/**
 * Compute the spectrogram.
 * @param {AudioBuffer} buffer
 * @returns {{ data: Float32Array, width: number, height: number }}
 *   data is row-major [freq * width + time], normalized to 0..1.
 */
export function computeSpectrogram(buffer) {
  const mono = toMono(buffer);
  const N = mono.length;
  const bands = buildLogBands(buffer.sampleRate);

  // Hann window reduces spectral smearing between frames.
  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }

  // Hop so that we land exactly TIME_STEPS frames across the file.
  const maxStart = Math.max(1, N - FFT_SIZE);
  const hop = maxStart / (TIME_STEPS - 1);

  const out = new Float32Array(TIME_STEPS * FREQ_BINS);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mag = new Float32Array(FFT_SIZE / 2);

  let maxDb = -Infinity;

  for (let t = 0; t < TIME_STEPS; t++) {
    const start = Math.floor(t * hop);

    // windowed frame -> re/im
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = start + i;
      re[i] = s < N ? mono[s] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);

    // magnitude of each usable bin
    for (let b = 0; b < FFT_SIZE / 2; b++) {
      mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
    }

    // aggregate linear bins into log bands (take the peak in each band)
    for (let r = 0; r < FREQ_BINS; r++) {
      const [b0, b1] = bands[r];
      let m = 0;
      for (let b = b0; b < b1; b++) if (mag[b] > m) m = mag[b];
      const db = 20 * Math.log10(m + 1e-9);
      if (db > maxDb) maxDb = db;
      out[r * TIME_STEPS + t] = db;
    }
  }

  // Normalize dB -> 0..1 using [DB_FLOOR + maxDb, maxDb] as the range,
  // so the visualization adapts to quiet and loud recordings alike.
  const top = maxDb;
  const bottom = maxDb + DB_FLOOR;
  const range = Math.max(1e-6, top - bottom);
  for (let i = 0; i < out.length; i++) {
    let v = (out[i] - bottom) / range;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  return { data: out, width: TIME_STEPS, height: FREQ_BINS };
}
