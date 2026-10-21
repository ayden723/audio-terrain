/* ============================================================
   bg.js — animated background for the home page
   ------------------------------------------------------------
   A spectrogram scrolling up the screen: an eight-note phrase,
   each note a stack of harmonics that fades as it rings,
   dithered to one bit, on a seamless 16 second loop. The
   pointer plays into it too: wherever it goes it leaves its
   own harmonics, which drift up with the rest and fade.

   Rendered on a plain 2D canvas at about a third of the
   screen's resolution and scaled up, so it works on every
   machine with no WebGL involved.
   ============================================================ */

(function () {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.style.imageRendering = 'pixelated';

  const TAU = 2 * Math.PI;
  const PERIOD = 16;                        // seconds per loop — slower is calmer
  const NOTES = [0, 7, 3, 10, 5, 12, 3, 8]; // semitones above the root
  const OCTAVES = 4.8;                      // across the full width
  const WIDTH = 7;                          // 1 / width of a harmonic, in octaves
  const HARMONICS = 8;

  // 4x4 ordered-dither thresholds: a fixed grain that never flickers
  const BAYER = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((b) => (b + 0.5) / 16));

  let W, H, img, vig, trail, spectra, hiss;

  // A note's harmonic stack across every column. The picture only ever needs
  // sixteen of these (eight notes, and each an octave down), so they are
  // worked out once per size and the per-pixel work is just a lookup.
  function spectrum(note) {
    const row = new Float32Array(W);
    const root = 1.2 + note / 12;
    for (let x = 0; x < W; x++) {
      const oct = (x / W) * OCTAVES;
      let n = 0;
      for (let h = 1; h <= HARMONICS; h++) {
        const d = (oct - root - Math.log2(h)) * WIDTH;
        n += Math.exp(-d * d) / Math.sqrt(h);
      }
      row[x] = n;
    }
    return row;
  }

  function resize() {
    // A tab opened in the background can report a 0x0 window; keep the last
    // size until it has a real one.
    if (!(window.innerWidth > 0 && window.innerHeight > 0) && img) return;
    const cw = window.innerWidth || 1280, ch = window.innerHeight || 720;
    W = Math.max(220, Math.min(520, Math.round(cw / 3)));
    H = Math.max(60, Math.round((W * ch) / cw));
    canvas.width = W;
    canvas.height = H;
    img = ctx.createImageData(W, H);
    // fill alpha once; we only rewrite RGB each frame
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;

    vig = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const uvY = 1 - y / H, vY = uvY * (1 - uvY);
      const rowShade = (y & 1) ? 0.82 : 1;       // subtle scanline
      for (let x = 0; x < W; x++) {
        const uvX = x / W;
        vig[y * W + x] = rowShade * Math.min(1, Math.pow(16 * uvX * (1 - uvX) * vY, 0.3));
      }
    }

    spectra = new Map();
    for (const n of NOTES) {
      if (!spectra.has(n)) spectra.set(n, spectrum(n));
      if (!spectra.has(n - 12)) spectra.set(n - 12, spectrum(n - 12));
    }
    // a faint hiss along the bottom of the spectrum
    hiss = new Float32Array(W);
    for (let x = 0; x < W; x++) hiss[x] = 0.12 * Math.exp(-(x / W) * OCTAVES * 0.6);

    trail = new Float32Array(W * H);
    pointer.stack = null;
  }

  /* ---------------------------------------------------------- pointer --- */

  const pointer = { x: 0, y: 0, on: false, speed: 0, stack: null, col: -1 };

  window.addEventListener('pointermove', (e) => {
    const x = (e.clientX / window.innerWidth) * W, y = (e.clientY / window.innerHeight) * H;
    if (pointer.on) pointer.speed += Math.hypot(x - pointer.x, y - pointer.y);
    pointer.x = x; pointer.y = y; pointer.on = true;
  }, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.on = false; });
  window.addEventListener('blur', () => { pointer.on = false; });

  // The pointer's own harmonic stack, rooted at the column it is over.
  function pointerStack(col) {
    if (pointer.col === col && pointer.stack) return pointer.stack;
    const row = new Float32Array(W);
    const root = (col / W) * OCTAVES;
    for (let x = 0; x < W; x++) {
      const oct = (x / W) * OCTAVES;
      let n = 0;
      for (let h = 1; h <= 4; h++) {
        const d = (oct - root - Math.log2(h)) * WIDTH * 1.4;
        n += Math.exp(-d * d) / h;
      }
      row[x] = n;
    }
    pointer.col = col;
    pointer.stack = row;
    return row;
  }

  // Scroll the trail up in step with the picture, fade it, and lay down the
  // pointer's harmonics where it is now. Faster movement plays louder.
  let scrolled = 0;
  function updateTrail(rows) {
    const shift = rows - scrolled;
    scrolled = rows;
    if (shift >= H) trail.fill(0);
    else if (shift > 0) {
      trail.copyWithin(0, shift * W);
      trail.fill(0, (H - shift) * W);
    }
    for (let i = 0; i < trail.length; i++) trail[i] *= 0.985;

    if (!pointer.on) { pointer.speed = 0; return; }
    const gain = 0.25 + Math.min(1.2, pointer.speed * 0.08);
    pointer.speed = 0;
    const stack = pointerStack(Math.round(pointer.x));
    const cy = pointer.y;
    for (let y = Math.max(0, Math.floor(cy - 2)); y <= Math.min(H - 1, Math.ceil(cy + 2)); y++) {
      const dy = y - cy, g = gain * Math.exp(-dy * dy * 0.5);
      const base = y * W;
      for (let x = 0; x < W; x++) trail[base + x] = Math.min(2, trail[base + x] + stack[x] * g);
    }
  }

  /* ------------------------------------------------------------ paint --- */

  function paint(t) {
    const d = img.data;
    const shift = t / PERIOD;
    let i = 0;
    for (let y = 0; y < H; y++) {
      // the phrase repeats once per loop, newest notes arriving at the bottom
      const p = (((y / H + shift) % 1) + 1) % 1;
      const step = Math.floor(p * 8), age = p * 8 - step;
      const now = spectra.get(NOTES[step]);
      const prev = spectra.get(NOTES[(step + 7) % 8] - 12); // still ringing an octave down
      const g1 = Math.exp(-age * 1.6), g2 = 0.7 * Math.exp(-(age + 1) * 1.6);
      const bayerRow = (y & 3) * 4;
      for (let x = 0; x < W; x++, i += 4) {
        const k = y * W + x;
        const e = (now[x] * g1 + prev[x] * g2 + hiss[x]) * 1.2 + trail[k];
        const g = Math.min(1, e) > BAYER[bayerRow + (x & 3)] ? Math.round(vig[k] * 255) : 0;
        d[i] = g; d[i + 1] = g; d[i + 2] = g;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  window.addEventListener('resize', resize);
  resize();

  const start = performance.now();
  function frame() {
    const t = (performance.now() - start) / 1000;
    updateTrail(Math.floor((t / PERIOD) * H));
    paint(t % PERIOD);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // paint one frame at time t on demand (debugging hook)
  window.__bgDraw = function (t) { paint(t); return { w: W, h: H }; };
})();
