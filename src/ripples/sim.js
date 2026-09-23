// The water: a 2D wave equation on a square grid, with everything outside a
// circle held still, so the pool has a round wall that reflects the ripples
// (and focuses them back towards the middle). Runs on the CPU: at this size
// it is cheap, and the synth can read the water directly.

export class RippleSim {
  constructor(n = 160, radius = 0.47) {
    this.n = n;
    this.radius = radius; // in uv units, where the square is 0..1
    this.cur = new Float32Array(n * n);
    this.prev = new Float32Array(n * n);
    this.next = new Float32Array(n * n);
    this.inside = new Uint8Array(n * n);
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const u = (x + 0.5) / n - 0.5;
        const v = (y + 0.5) / n - 0.5;
        this.inside[y * n + x] = Math.hypot(u, v) < radius ? 1 : 0;
      }
    }
  }

  /**
   * One time step. `c2` is (wave speed)^2 in grid units and must stay below
   * about 0.35 to be stable; `damp` bleeds a little energy each step.
   */
  step(c2, damp) {
    const { n, cur: h, prev, next, inside } = this;
    for (let y = 1; y < n - 1; y++) {
      let i = y * n + 1;
      for (let x = 1; x < n - 1; x++, i++) {
        if (!inside[i]) { next[i] = 0; continue; }
        // 9-point Laplacian: rings stay round instead of turning square
        const lap = (4 * (h[i - 1] + h[i + 1] + h[i - n] + h[i + n]) +
          h[i - n - 1] + h[i - n + 1] + h[i + n - 1] + h[i + n + 1] - 20 * h[i]) / 6;
        next[i] = (2 * h[i] - prev[i] + c2 * lap) * damp;
      }
    }
    this.prev = h;
    this.cur = next;
    this.next = prev;
  }

  /**
   * A drop landing at (u, v): a dip with a raised lip around it. The shape
   * holds exactly as much water as it moves, so drops never raise or lower
   * the pool as a whole (which would set it sloshing and never settle).
   */
  disturb(u, v, radius, amount) {
    const { n, cur, inside } = this;
    const cx = u * n - 0.5;
    const cy = v * n - 0.5;
    const r = radius * n;
    const reach = Math.ceil(r * 2.5);
    for (let y = Math.max(1, Math.floor(cy - reach)); y <= Math.min(n - 2, Math.ceil(cy + reach)); y++) {
      for (let x = Math.max(1, Math.floor(cx - reach)); x <= Math.min(n - 2, Math.ceil(cx + reach)); x++) {
        const i = y * n + x;
        if (!inside[i]) continue;
        const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
        cur[i] -= amount * (1 - d2) * Math.exp(-d2);
      }
    }
  }

  /** Keep the pool's average level at zero, in both time steps. */
  settle() {
    const { cur, prev, inside } = this;
    let a = 0, b = 0, n = 0;
    for (let i = 0; i < cur.length; i++) {
      if (inside[i]) { a += cur[i]; b += prev[i]; n++; }
    }
    a /= n;
    b /= n;
    for (let i = 0; i < cur.length; i++) {
      if (inside[i]) { cur[i] -= a; prev[i] -= b; }
    }
  }

  /** Height at (u, v), bilinear. */
  sample(u, v) {
    const { n, cur } = this;
    const x = Math.min(n - 2, Math.max(0, u * n - 0.5));
    const y = Math.min(n - 2, Math.max(0, v * n - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const i = y0 * n + x0;
    return (cur[i] * (1 - fx) + cur[i + 1] * fx) * (1 - fy) + (cur[i + n] * (1 - fx) + cur[i + n + 1] * fx) * fy;
  }

  isInside(u, v) {
    return Math.hypot(u - 0.5, v - 0.5) < this.radius - 0.01;
  }
}
