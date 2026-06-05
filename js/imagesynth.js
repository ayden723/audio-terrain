/* ============================================================
   imagesynth.js — turn an IMAGE into AUDIO (Coagula-style)
   ------------------------------------------------------------
   We read the image as a spectrogram:
     - X (columns) = time, left -> right
     - Y (rows)    = frequency, image TOP = HIGH freq, bottom = low
     - pixel brightness = how loud that frequency is at that moment

   Then we rebuild the sound by ADDITIVE SYNTHESIS: every image row
   becomes one sine oscillator whose loudness over time follows the
   brightness across that row. Sum all the oscillators -> the waveform.

   The rows are placed on a LOG frequency scale (low notes get lots of
   room, high notes get a little) to match how spectrogram.js / the
   waterfall analyse sound, so the picture shows up undistorted in all
   three view modes.
   ============================================================ */

// Working grid the image is resampled to before synthesis.
const COLS = 512;  // time resolution (how many "moments" across the image)
const ROWS = 300;  // frequency resolution (how many oscillators we sum)

/**
 * Convert an uploaded image File into an AudioBuffer.
 * @param {File} file
 * @param {AudioContext} audioCtx
 * @param {object} params
 *   duration  seconds of audio to make (default 5)
 *   minFreq   lowest frequency in Hz (default 40)
 *   contrast  brightness curve / gamma; >1 = more contrast (default 1.6)
 *   invert    if true, DARK pixels are loud instead of bright (default false)
 * @returns {Promise<AudioBuffer>}
 */
export async function imageToAudioBuffer(file, audioCtx, params = {}) {
  const duration = Math.max(1, params.duration ?? 5);
  const minFreq  = Math.max(20, params.minFreq ?? 40);
  const contrast = Math.max(0.2, params.contrast ?? 1.6);
  const invert   = !!params.invert;

  const sr = audioCtx.sampleRate;
  // Top of the image maps here; cap at 16 kHz so detail isn't crammed up
  // near Nyquist where it would be inaudible / aliased.
  const maxFreq = Math.min(sr / 2 - 1, 16000);

  // ---- 1. Decode the image to a small grid of luminance values ----
  // createImageBitmap + canvas keeps us CSP-safe (no <img src="blob:">).
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = COLS;
  canvas.height = ROWS;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Draw the whole image scaled into our COLS x ROWS grid.
  ctx.drawImage(bitmap, 0, 0, COLS, ROWS);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, COLS, ROWS).data; // RGBA bytes

  // lum[row * COLS + col] in 0..1, already contrast/invert shaped.
  const lum = new Float32Array(ROWS * COLS);
  for (let i = 0; i < ROWS * COLS; i++) {
    const p = i * 4;
    // Rec. 709 luminance from sRGB bytes.
    let v = (0.2126 * pixels[p] + 0.7152 * pixels[p + 1] + 0.0722 * pixels[p + 2]) / 255;
    if (invert) v = 1 - v;
    lum[i] = Math.pow(v, contrast); // gamma: pushes mid-tones down for punch
  }

  // ---- 2. Frequency for each row (log scale, top = high) ----
  const logMin = Math.log(minFreq);
  const logMax = Math.log(maxFreq);
  const rowFreq = new Float32Array(ROWS);
  for (let r = 0; r < ROWS; r++) {
    // r = 0 is the top of the image -> highest frequency.
    const t = r / (ROWS - 1);
    rowFreq[r] = Math.exp(logMax - (logMax - logMin) * t);
  }

  // ---- 3. Precompute, for each sample, which two image columns it sits
  //         between (linear interpolation makes amplitudes glide smoothly). ----
  const N = Math.round(duration * sr);
  const col0 = new Int32Array(N);
  const colFrac = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const cf = (n / Math.max(1, N - 1)) * (COLS - 1);
    const c0 = Math.min(COLS - 2, Math.floor(cf));
    col0[n] = c0;
    colFrac[n] = cf - c0;
  }

  // ---- 4. Additive synthesis ----
  const out = new Float32Array(N);
  const twoPiOverSr = (2 * Math.PI) / sr;
  for (let r = 0; r < ROWS; r++) {
    const base = r * COLS;
    const inc = twoPiOverSr * rowFreq[r];
    let phase = Math.random() * 2 * Math.PI; // random start so peaks don't stack
    for (let n = 0; n < N; n++) {
      const c = base + col0[n];
      const f = colFrac[n];
      // amplitude = brightness, interpolated between the two columns
      const amp = lum[c] + (lum[c + 1] - lum[c]) * f;
      out[n] += amp * Math.sin(phase);
      phase += inc;
    }
  }

  // ---- 5. Normalize to ~0.9 peak so it's loud but never clips ----
  let peak = 0;
  for (let n = 0; n < N; n++) {
    const a = Math.abs(out[n]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const g = 0.9 / peak;
    for (let n = 0; n < N; n++) out[n] *= g;
  }

  // ---- 6. Wrap the samples in an AudioBuffer for the rest of the app ----
  const audioBuffer = audioCtx.createBuffer(1, N, sr);
  audioBuffer.copyToChannel(out, 0);
  return audioBuffer;
}

/**
 * Encode mono Float32 samples as a 16-bit PCM WAV Blob (download-ready).
 * @param {Float32Array} float32
 * @param {number} sampleRate
 * @returns {Blob}
 */
export function encodeWav(float32, sampleRate) {
  const numSamples = float32.length;
  const bytesPerSample = 2;            // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF header
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  // fmt chunk
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);        // chunk size
  view.setUint16(20, 1, true);         // PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true);              // block align
  view.setUint16(34, 16, true);        // bits per sample
  // data chunk
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // Samples: clamp to [-1, 1] then scale to signed 16-bit.
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = float32[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
