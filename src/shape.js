// Image sampling. These need a canvas, so they stay on the main thread; the
// heavy dB -> height shaping lives in the worker.

function drawScaled(src, w, h) {
  // Progressive halving keeps detail when shrinking a large photo a lot.
  let cur = src;
  let cw = src.width;
  let ch = src.height;
  while (cw > w * 2 || ch > h * 2) {
    const nw = Math.max(w, Math.round(cw / 2));
    const nh = Math.max(h, Math.round(ch / 2));
    const c = document.createElement('canvas');
    c.width = nw;
    c.height = nh;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(cur, 0, 0, nw, nh);
    cur = c;
    cw = nw;
    ch = nh;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(cur, 0, 0, w, h);
  return cx.getImageData(0, 0, w, h);
}

/**
 * Image luminance sampled as a spectrogram: image x -> time slice,
 * image y -> frequency column (bottom row = lowest frequency).
 */
export function imageLevels(bitmap, slices, cols, invert) {
  const img = drawScaled(bitmap, slices, cols);
  const d = img.data;
  const out = new Float32Array(slices * cols);
  for (let k = 0; k < slices; k++) {
    for (let c = 0; c < cols; c++) {
      const y = cols - 1 - c;
      const i = (y * slices + k) * 4;
      const a = d[i + 3] / 255;
      let v = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      if (invert) v = 1 - v;
      out[k * cols + c] = v * a;
    }
  }
  return out;
}

/** Image brightness as a [rows][cols] matrix for additive synthesis (row 0 = top = high freq). */
export function imagePixels(bitmap, rows, cols, invert) {
  const img = drawScaled(bitmap, cols, rows);
  const d = img.data;
  const out = new Float32Array(rows * cols);
  for (let i = 0, p = 0; i < rows * cols; i++, p += 4) {
    const a = d[p + 3] / 255;
    let v = (0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) / 255;
    if (invert) v = 1 - v;
    out[i] = v * a;
  }
  return out;
}
