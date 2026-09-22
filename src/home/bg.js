/* ============================================================
   bg.js — animated background for the home page
   ------------------------------------------------------------
   The spiral from David A Roberts' 2016 Shadertoy piece
   (https://davidar.io), black & white, on a 10 second loop.
   Rendered on a plain 2D canvas at low resolution and scaled
   up, so it works on every machine with no WebGL involved.
   The chunky pixels are part of the look.
   ============================================================ */

(function () {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.style.imageRendering = 'pixelated';

  const PI = Math.PI;
  let W = 220, H = 130, img = null, aspect = 1;

  function resize() {
    // A tab opened in the background can report a 0x0 window; keep the last
    // aspect until it has a real size.
    if (window.innerWidth > 0 && window.innerHeight > 0) {
      aspect = window.innerWidth / window.innerHeight;
    }
    W = 220;
    H = Math.max(60, Math.round(W / aspect));
    canvas.width = W;
    canvas.height = H;
    img = ctx.createImageData(W, H);
    // fill alpha once; we only rewrite RGB each frame
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  }
  window.addEventListener('resize', resize);
  resize();

  const wrap = (v, m) => ((v % m) + m) % m;

  const start = performance.now();
  const PERIOD = 16; // seconds per loop — slower is calmer

  function frame() {
    paint(((performance.now() - start) / 1000) % PERIOD);
    requestAnimationFrame(frame);
  }

  function paint(t) {
    // Every motion is a sine/cosine of the loop angle, so the frames at
    // t = 0 and t = PERIOD are identical: the loop is perfectly seamless
    // with no jitter and no pixelate trick needed.
    const angle = (2 * PI * t) / PERIOD;
    const zoom = 1.0 + 0.16 * Math.sin(angle);   // gentle breathe
    const driftX = 4 * Math.cos(angle);          // sample point orbits
    const driftY = 4 * Math.sin(angle);

    const d = img.data;
    let i = 0;
    for (let y = 0; y < H; y++) {
      const uvY = 1 - y / H;
      const rowShade = (y & 1) ? 0.82 : 1;       // subtle scanline
      const vY = uvY * (1 - uvY);
      for (let x = 0; x < W; x++, i += 4) {
        const uvX = x / W;

        const px = ((50 * uvX - 25) * zoom + driftX) * aspect;
        const py = (50 * uvY - 25) * zoom + driftY;

        // the spiral, in three tones
        const z = Math.hypot(px, py) - 3.5 * Math.atan2(py, px) +
                  Math.sin(px) + Math.cos(py);
        let v;
        if (wrap(z, 7 * PI) < PI / 2) v = 0.45;
        else if (wrap(z, PI) < PI / 2) v = 0;
        else v = 1;

        // vignette
        const vig = Math.min(1, Math.pow(16 * uvX * (1 - uvX) * vY, 0.3));

        const g = Math.round(v * vig * rowShade * 255);
        d[i] = g; d[i + 1] = g; d[i + 2] = g;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  requestAnimationFrame(frame);

  // paint one frame at time t on demand (debugging hook)
  window.__bgDraw = function (t) { paint(t); return { w: W, h: H }; };
})();
