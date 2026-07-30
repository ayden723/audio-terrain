/* ============================================================
   grid.js — the painting canvas's data model (single source of truth)
   ------------------------------------------------------------
   One Float32Array of amplitudes (0..1), row 0 = LOW frequency:
       data[row * W + col]
   The brush lays down a smooth radial falloff. Blending is "paint up
   to a level" (max), not additive — so a stroke keeps its soft volume
   gradient across its width instead of saturating to a flat slab.
   A dirty rectangle is tracked so the display only redraws what moved.
   ============================================================ */

export class PaintGrid {
  constructor(width, height) {
    this.W = width;
    this.H = height;
    this.data = new Float32Array(width * height);
    this.undoStack = [];
    this.redoStack = [];
    this.MAX_UNDO = 24;
    this.dirty = true;
    // dirty rectangle in STORAGE coords (col, row). Start = whole grid.
    this.dx0 = 0; this.dy0 = 0; this.dx1 = width - 1; this.dy1 = height - 1;
  }

  _mark(col, row) {
    if (col < this.dx0) this.dx0 = col;
    if (col > this.dx1) this.dx1 = col;
    if (row < this.dy0) this.dy0 = row;
    if (row > this.dy1) this.dy1 = row;
    this.dirty = true;
  }
  markAllDirty() { this.dx0 = 0; this.dy0 = 0; this.dx1 = this.W - 1; this.dy1 = this.H - 1; this.dirty = true; }
  clearDirty() { this.dx0 = this.W; this.dy0 = this.H; this.dx1 = -1; this.dy1 = -1; this.dirty = false; }
  get dirtyRect() { return { x0: this.dx0, y0: this.dy0, x1: this.dx1, y1: this.dy1 }; }

  clearAll() { this.data.fill(0); this.markAllDirty(); }

  /* ---------------- undo / redo ---------------- */
  snapshot() {
    this.undoStack.push(this.data.slice());
    if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.data.slice());
    this.data = this.undoStack.pop();
    this.markAllDirty();
    return true;
  }
  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.data.slice());
    this.data = this.redoStack.pop();
    this.markAllDirty();
    return true;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /* ---------------- the soft brush ----------------
     imgX / imgY are in IMAGE space (y = 0 top = HIGH freq). radius in
     cells. hardness sets the full-strength core; outside it a raised
     cosine ramps smoothly to zero — a continuous volume slope, no hard
     rim. opts.erase subtracts; opts.noise speckles for broadband texture. */
  stamp(imgX, imgY, radius, hardness, strength, opts = {}) {
    const { W, H, data } = this;
    const erase = !!opts.erase, noise = !!opts.noise;
    const noiseTex = opts.noiseTex || null;   // static per-cell texture for broadband
    const R = Math.max(0.6, radius);
    const inner = R * hardness;
    const x0 = Math.max(0, Math.floor(imgX - R));
    const x1 = Math.min(W - 1, Math.ceil(imgX + R));
    const y0 = Math.max(0, Math.floor(imgY - R));
    const y1 = Math.min(H - 1, Math.ceil(imgY + R));

    for (let py = y0; py <= y1; py++) {
      const gridRow = H - 1 - py;
      const dy = py - imgY;
      const base = gridRow * W;
      for (let px = x0; px <= x1; px++) {
        const dx = px - imgX;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= R) continue;

        let w;
        if (d <= inner) w = 1;
        else {
          const k = (d - inner) / (R - inner);       // 0..1
          w = 0.5 * (1 + Math.cos(Math.PI * k));      // 1 -> 0, smooth slope
        }

        const i = base + px;
        const nf = noise ? (noiseTex ? noiseTex[i] : (0.3 + 0.7 * Math.random())) : 1;
        const val = strength * w * nf;
        if (erase) {
          const v = data[i] - val;
          data[i] = v < 0 ? 0 : v;
        } else if (val > data[i]) {                    // paint UP TO a level
          data[i] = val > 1 ? 1 : val;
        }
        this._mark(px, gridRow);
      }
    }
  }

  get spec() { return { data: this.data, width: this.W, height: this.H }; }

  get isEmpty() {
    const d = this.data;
    for (let i = 0; i < d.length; i++) if (d[i] > 0.002) return false;
    return true;
  }
}
