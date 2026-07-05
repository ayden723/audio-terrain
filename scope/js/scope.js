/* ============================================================
   scope.js — draws the XY trace on a 2D canvas
   ------------------------------------------------------------
   Each frame:
     1. Paint a translucent navy rectangle over everything.
        Old traces show through and fade — that's the phosphor
        "shadow trail". Trail 0% = full clear every frame.
     2. Map the last N samples to points:
        x = center + left[i]·zoom·radius, y = center − right[i]·…
     3. Draw them in the chosen style.
   ============================================================ */

const BG = { r: 5, g: 6, b: 15 };   // must match --navy in style.css

export class ScopeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');

    // Scope settings (wired to the panel sliders in main.js)
    this.zoom = 1;
    this.framesize = 1024;
    this.trail = 0.6;         // 0..0.95
    this.lineWidth = 2;
    this.style = 'strip';     // strip | lines | points | triangles
    this.color = '#4fd6e0';

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.dpr = dpr;
    // A resize wipes the canvas; repaint the background solid.
    this.ctx2d.fillStyle = `rgb(${BG.r},${BG.g},${BG.b})`;
    this.ctx2d.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Draw one frame from the latest left/right waveforms. */
  render(left, right) {
    const n = Math.min(this.framesize, left.length);
    const start = left.length - n;              // newest samples
    this._paint(i => left[start + i], i => right[start + i], n);
  }

  /** Draw one frame from arbitrary −1..1 X/Y arrays (synth mode). */
  renderXY(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    this._paint(i => xs[i], i => ys[i], n);
  }

  _paint(getX, getY, n) {
    const c = this.ctx2d;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // 1. fade the previous frame (the shadow trail)
    c.fillStyle = `rgba(${BG.r},${BG.g},${BG.b},${(1 - this.trail).toFixed(3)})`;
    c.fillRect(0, 0, w, h);

    // 2. map samples → screen points
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.45 * this.zoom;

    c.strokeStyle = this.color;
    c.fillStyle = this.color;
    c.lineWidth = this.lineWidth * this.dpr;
    c.lineJoin = 'round';
    c.lineCap = 'round';

    // A touch of same-color glow — flat color, no gradients.
    c.shadowColor = this.color;
    c.shadowBlur = 6 * this.dpr;

    const px = i => cx + getX(i) * radius;
    const py = i => cy - getY(i) * radius;

    // 3. draw in the selected style
    if (this.style === 'points') {
      const s = Math.max(this.lineWidth * this.dpr, 1.5);
      for (let i = 0; i < n; i++) c.fillRect(px(i) - s / 2, py(i) - s / 2, s, s);

    } else if (this.style === 'lines') {
      // disconnected segments between sample pairs
      c.beginPath();
      for (let i = 0; i + 1 < n; i += 2) {
        c.moveTo(px(i), py(i));
        c.lineTo(px(i + 1), py(i + 1));
      }
      c.stroke();

    } else if (this.style === 'triangles') {
      c.globalAlpha = 0.28;
      for (let i = 0; i + 2 < n; i += 3) {
        c.beginPath();
        c.moveTo(px(i), py(i));
        c.lineTo(px(i + 1), py(i + 1));
        c.lineTo(px(i + 2), py(i + 2));
        c.closePath();
        c.fill();
      }
      c.globalAlpha = 1;

    } else { // 'strip' — one continuous polyline (the classic look)
      c.beginPath();
      c.moveTo(px(0), py(0));
      for (let i = 1; i < n; i++) c.lineTo(px(i), py(i));
      c.stroke();
    }

    c.shadowBlur = 0;
  }
}
