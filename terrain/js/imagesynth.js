/* ============================================================
   imagesynth.js — turn an IMAGE into AUDIO (Coagula-style)
   ------------------------------------------------------------
   We read the image as a spectrogram (X = time, Y = frequency,
   brightness = loudness), resample it to a loudness grid, then hand
   that grid to the shared additive synthesizer in gridsynth.js —
   the same engine the Composer paints into. This file only does the
   image-specific part: decode + resample + contrast/invert shaping.
   ============================================================ */

import { gridToAudioBuffer, encodeWav } from '../../shared/gridsynth.js';

// Re-export so existing importers (main.js) keep working unchanged.
export { encodeWav };

// Working grid the image is resampled to before synthesis.
const COLS = 512;  // time resolution
const ROWS = 300;  // frequency resolution (oscillators)

/**
 * Convert an uploaded image File into an AudioBuffer.
 * Image TOP = HIGH frequency (the usual spectrogram convention).
 */
export async function imageToAudioBuffer(file, audioCtx, params = {}) {
  const duration = Math.max(1, params.duration ?? 5);
  const minFreq  = Math.max(20, params.minFreq ?? 40);
  const contrast = Math.max(0.2, params.contrast ?? 1.6);
  const invert   = !!params.invert;
  const maxFreq  = Math.min(audioCtx.sampleRate / 2 - 1, 16000);

  // ---- Decode the image to a small grid of luminance values ----
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = COLS;
  canvas.height = ROWS;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, COLS, ROWS);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, COLS, ROWS).data; // RGBA bytes

  // Build the synthesis grid in gridsynth's convention: row 0 = LOW freq.
  // The image's TOP row (py = 0) should be the HIGHEST frequency, so it
  // lands in the LAST grid row.
  const grid = new Float32Array(ROWS * COLS);
  for (let py = 0; py < ROWS; py++) {
    const gridRow = ROWS - 1 - py;          // image top -> high freq (last row)
    for (let col = 0; col < COLS; col++) {
      const p = (py * COLS + col) * 4;
      // Rec. 709 luminance from sRGB bytes.
      let v = (0.2126 * pixels[p] + 0.7152 * pixels[p + 1] + 0.0722 * pixels[p + 2]) / 255;
      if (invert) v = 1 - v;
      grid[gridRow * COLS + col] = Math.pow(v, contrast); // gamma for punch
    }
  }

  // The grid is already contrast-shaped, so pass contrast = 1 downstream.
  return gridToAudioBuffer(grid, COLS, ROWS, audioCtx, {
    duration, minFreq, maxFreq, contrast: 1,
  });
}
