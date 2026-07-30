/* ============================================================
   gridsynth.js — turn a 2D loudness GRID into AUDIO (shared)
   ------------------------------------------------------------
   Additive synthesis: every frequency ROW of the grid becomes one
   sine oscillator, and the row's values across TIME become that
   oscillator's loudness envelope. Sum them all -> the waveform.

   This is the one audio pipeline for the whole site. The grid is a
   Float32Array in ROW-MAJOR order, row 0 = LOW frequency (matching
   the spectrogram / terrain convention), values 0..1:

       grid[row * width + col]

   Both the Composer (painted grid) and the terrain tool's image
   synth (an image resampled to a grid) call this — no duplicate
   synthesis logic.
   ============================================================ */

/**
 * @param {Float32Array} grid   row-major [row*width+col], row 0 = low freq
 * @param {number} width        columns (time)
 * @param {number} height       rows (frequency)
 * @param {AudioContext} audioCtx
 * @param {object} params
 *   duration  seconds of audio (default 6)
 *   minFreq   Hz of the bottom row (default 55)
 *   maxFreq   Hz of the top row (default 8000, capped at Nyquist)
 *   contrast  amplitude gamma; >1 = punchier (default 1)
 * @returns {AudioBuffer}
 */
export function gridToAudioBuffer(grid, width, height, audioCtx, params = {}) {
  const duration = Math.max(0.25, params.duration ?? 6);
  const minFreq  = Math.max(20, params.minFreq ?? 55);
  const contrast = Math.max(0.2, params.contrast ?? 1);
  const sr = audioCtx.sampleRate;
  const maxFreq = Math.min(sr / 2 - 1, params.maxFreq ?? 8000);

  const N = Math.round(duration * sr);
  const out = new Float32Array(N);

  // Which two columns each output sample sits between (linear glide).
  const col0 = new Int32Array(N);
  const colFrac = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const cf = (n / Math.max(1, N - 1)) * (width - 1);
    const c0 = Math.min(width - 2, Math.floor(cf));
    col0[n] = c0;
    colFrac[n] = cf - c0;
  }

  const logMin = Math.log(minFreq);
  const logMax = Math.log(maxFreq);
  const twoPiOverSr = (2 * Math.PI) / sr;

  for (let r = 0; r < height; r++) {
    const base = r * width;

    // Skip silent rows entirely — a mostly-empty painting stays cheap.
    let rowMax = 0;
    for (let c = 0; c < width; c++) { const v = grid[base + c]; if (v > rowMax) rowMax = v; }
    if (rowMax < 0.002) continue;

    const t = height > 1 ? r / (height - 1) : 0;
    const freq = Math.exp(logMin + (logMax - logMin) * t);
    const inc = twoPiOverSr * freq;
    let phase = Math.random() * 2 * Math.PI; // random start so peaks don't stack

    for (let n = 0; n < N; n++) {
      const c = base + col0[n];
      const f = colFrac[n];
      let amp = grid[c] + (grid[c + 1] - grid[c]) * f;
      if (contrast !== 1) amp = Math.pow(amp, contrast);
      out[n] += amp * Math.sin(phase);
      phase += inc;
    }
  }

  // Normalize to ~0.9 peak so it's loud but never clips.
  let peak = 0;
  for (let n = 0; n < N; n++) { const a = Math.abs(out[n]); if (a > peak) peak = a; }
  if (peak > 0) {
    const g = 0.9 / peak;
    for (let n = 0; n < N; n++) out[n] *= g;
  }

  const buffer = audioCtx.createBuffer(1, N, sr);
  buffer.copyToChannel(out, 0);
  return buffer;
}

/** Encode mono Float32 samples as a 16-bit PCM WAV Blob (download-ready). */
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
