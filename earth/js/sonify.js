/* ============================================================
   sonify.js — turn an elevation grid into AUDIO
   ------------------------------------------------------------
   Same idea as the terrain tool's image synth (imagesynth.js),
   with height standing in for brightness:

     - columns = time, west → east
     - rows    = frequency, NORTH edge = HIGH notes (log scale)
     - normalized elevation = how loud that "row" plays

   Every row becomes one sine oscillator whose loudness follows
   the ground profile along that latitude line. Sum them all and
   the landscape becomes a chord that changes as you sweep east.
   ============================================================ */

/**
 * @param {Float32Array} grid  meters, row 0 = north (from elevation.js)
 * @param {number} cols
 * @param {number} rows
 * @param {number} minElev
 * @param {number} maxElev
 * @param {AudioContext} audioCtx
 * @param {object} params  { duration, minFreq, contrast, seaSilent }
 * @returns {{ buffer: AudioBuffer, amps: Float32Array }}
 *          amps = the 0..1 loudness grid (for painting the preview)
 */
export function terrainToAudioBuffer(grid, cols, rows, minElev, maxElev, audioCtx, params) {
  const duration = Math.max(1, params.duration ?? 12);
  const minFreq  = Math.max(20, params.minFreq ?? 60);
  const contrast = Math.max(0.2, params.contrast ?? 1.5);
  const seaSilent = !!params.seaSilent;

  const sr = audioCtx.sampleRate;
  const maxFreq = Math.min(sr / 2 - 1, 12000);

  // ---- 1. Normalize elevation to a 0..1 loudness grid ----
  // With "ocean stays silent" everything at or below sea level is 0 and
  // the land is stretched over the full range. If the whole view is
  // under water we fall back to the raw range so you can hear seafloor.
  let lo = minElev, hi = maxElev;
  if (seaSilent && maxElev > 0) lo = Math.max(0, minElev);
  if (hi - lo < 1) hi = lo + 1;               // dead-flat view: avoid ÷0

  const amps = new Float32Array(rows * cols);
  for (let i = 0; i < amps.length; i++) {
    const e = grid[i];
    let v = (e - lo) / (hi - lo);
    if (seaSilent && maxElev > 0 && e <= 0) v = 0;
    v = Math.max(0, Math.min(1, v));
    amps[i] = Math.pow(v, contrast);
  }

  // ---- 2. Frequency for each row (log scale, north/top = high) ----
  const logMin = Math.log(minFreq);
  const logMax = Math.log(maxFreq);
  const rowFreq = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    rowFreq[r] = Math.exp(logMax - (logMax - logMin) * t);
  }

  // ---- 3. Column interpolation table (smooth glides between steps) ----
  const N = Math.round(duration * sr);
  const col0 = new Int32Array(N);
  const colFrac = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const cf = (n / Math.max(1, N - 1)) * (cols - 1);
    const c0 = Math.min(cols - 2, Math.floor(cf));
    col0[n] = c0;
    colFrac[n] = cf - c0;
  }

  // ---- 4. Additive synthesis ----
  const out = new Float32Array(N);
  const twoPiOverSr = (2 * Math.PI) / sr;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    const inc = twoPiOverSr * rowFreq[r];
    let phase = Math.random() * 2 * Math.PI;
    for (let n = 0; n < N; n++) {
      const c = base + col0[n];
      const f = colFrac[n];
      const amp = amps[c] + (amps[c + 1] - amps[c]) * f;
      out[n] += amp * Math.sin(phase);
      phase += inc;
    }
  }

  // ---- 5. Normalize to ~0.9 peak ----
  let peak = 0;
  for (let n = 0; n < N; n++) {
    const a = Math.abs(out[n]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const g = 0.9 / peak;
    for (let n = 0; n < N; n++) out[n] *= g;
  }

  const buffer = audioCtx.createBuffer(1, N, sr);
  buffer.copyToChannel(out, 0);
  return { buffer, amps };
}

/** Encode mono Float32 samples as a 16-bit PCM WAV Blob. */
export function encodeWav(float32, sampleRate) {
  const numSamples = float32.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = float32[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
