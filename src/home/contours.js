// Contour reveal for the Landscape card: on hover the green drains away one
// contour band at a time, peaks first, to show a topographic map underneath
// with the tool's orange capture frame around the high ground. Leaving fills
// it back in from the valleys up.

const BANDS = 16; // contour interval; the reveal steps through one band at a time
const STEP_MS = 26; // per band, so a full reveal takes about 0.4 s
const GREEN = [62, 91, 52]; // the tile's own colour, so the cover is invisible at rest
const GROUND = '#1d2b18';
const LINE = '226, 240, 214'; // rgb, the tile's text colour
const FRAME = '#C25A22';
const GRID = 5; // CSS px between contour samples

// A made-up but plausible massif: high ground to the lower right, away from
// the card's heading, with uneven slopes so the contours wander.
function height(u, v, aspect) {
  const peak = (cx, cy, r, a) => {
    const dx = (u - cx) * aspect;
    const dy = v - cy;
    return a * Math.exp(-(dx * dx + dy * dy) / (r * r));
  };
  return (
    peak(0.74, 0.78, 0.3, 1) +
    peak(0.46, 0.98, 0.22, 0.62) +
    peak(0.95, 0.42, 0.2, 0.5) +
    peak(0.2, 0.82, 0.24, 0.34) +
    0.28 * v +
    0.07 * Math.sin(u * 13 + v * 7) * Math.sin(v * 11 - u * 5) +
    0.035 * Math.sin(u * 31 - v * 23)
  );
}

function sampler(w, h) {
  const aspect = w / h;
  // normalise to 0..1 over the card
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j <= 40; j++) {
    for (let i = 0; i <= 40; i++) {
      const z = height(i / 40, j / 40, aspect);
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
  }
  const span = hi - lo || 1;
  return (x, y) => (height(x / w, y / h, aspect) - lo) / span;
}

// Contour lines by marching squares over a coarse grid, one path per level.
function drawMap(canvas, w, h, d, z) {
  canvas.width = Math.max(1, Math.round(w * d));
  canvas.height = Math.max(1, Math.round(h * d));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, w, h);

  const nx = Math.ceil(w / GRID) + 1;
  const ny = Math.ceil(h / GRID) + 1;
  const g = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) g[j * nx + i] = z(i * GRID, j * GRID);

  const lerp = (a, b, l) => (l - a) / (b - a);
  for (let k = 1; k < BANDS; k++) {
    const l = k / BANDS;
    const major = k % 4 === 0; // index contours, every fourth line
    ctx.beginPath();
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = g[j * nx + i];
        const b = g[j * nx + i + 1];
        const c = g[(j + 1) * nx + i + 1];
        const e = g[(j + 1) * nx + i];
        const x = i * GRID;
        const y = j * GRID;
        // edge crossings: top, right, bottom, left
        const p = [];
        if ((a < l) !== (b < l)) p.push([x + GRID * lerp(a, b, l), y]);
        if ((b < l) !== (c < l)) p.push([x + GRID, y + GRID * lerp(b, c, l)]);
        if ((e < l) !== (c < l)) p.push([x + GRID * lerp(e, c, l), y + GRID]);
        if ((a < l) !== (e < l)) p.push([x, y + GRID * lerp(a, e, l)]);
        for (let s = 0; s + 1 < p.length; s += 2) {
          ctx.moveTo(p[s][0], p[s][1]);
          ctx.lineTo(p[s + 1][0], p[s + 1][1]);
        }
      }
    }
    // low ground sits under the text, so it is drawn fainter
    ctx.strokeStyle = `rgba(${LINE}, ${(major ? 0.3 : 0.12) + 0.3 * l})`;
    ctx.lineWidth = major ? 1.3 : 0.8;
    ctx.stroke();
  }

  // the capture frame, as on the Landscape page, around the summit
  const fw = Math.min(w * 0.42, h * 0.56);
  const fh = fw * 0.72;
  const fx = Math.min(w - fw - 18, w * 0.74 - fw / 2);
  const fy = Math.min(h - fh - 18, h * 0.76 - fh / 2);
  const t = 12;
  ctx.strokeStyle = FRAME;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(fx, fy, fw, fh);
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [cx, cy, sx, sy] of [[fx, fy, 1, 1], [fx + fw, fy, -1, 1], [fx, fy + fh, 1, -1], [fx + fw, fy + fh, -1, -1]]) {
    ctx.moveTo(cx, cy + sy * t);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + sx * t, cy);
  }
  ctx.stroke();
}

export function contours(card) {
  const under = document.createElement('canvas');
  under.className = 'card-under';
  under.setAttribute('aria-hidden', 'true');
  const cover = document.createElement('canvas');
  cover.className = 'card-cover';
  cover.setAttribute('aria-hidden', 'true');
  card.prepend(under, cover);
  const ctx = cover.getContext('2d');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0;
  let H = 0;
  let zs = null; // height per device pixel of the cover
  let gi = null; // 1 / slope, so the drained edge is antialiased to one pixel
  let img = null;
  let pos = 0; // bands drained, 0 (all green) .. BANDS (all map)
  let want = 0;
  let timer = 0;

  const paint = () => {
    if (!img) return;
    const level = pos === 0 ? 2 : pos === BANDS ? -1 : 1 - pos / BANDS;
    const px = img.data;
    for (let n = 0, q = 3; n < zs.length; n++, q += 4) {
      const a = (level - zs[n]) * gi[n] + 0.5;
      px[q] = a <= 0 ? 0 : a >= 1 ? 255 : a * 255;
    }
    ctx.putImageData(img, 0, 0);
  };

  const layout = () => {
    const w = card.clientWidth;
    const h = card.clientHeight;
    if (w === W && h === H) return;
    W = w;
    H = h;
    const d = Math.min(2, window.devicePixelRatio || 1);
    const z = sampler(w, h);
    drawMap(under, w, h, d, z);

    const cw = Math.max(1, Math.round(w * d));
    const ch = Math.max(1, Math.round(h * d));
    cover.width = cw;
    cover.height = ch;
    zs = new Float32Array(cw * ch);
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) zs[j * cw + i] = z(i / d, j / d);
    gi = new Float32Array(cw * ch);
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        const n = j * cw + i;
        const gx = zs[n + (i < cw - 1 ? 1 : 0)] - zs[n - (i > 0 ? 1 : 0)];
        const gy = zs[n + (j < ch - 1 ? cw : 0)] - zs[n - (j > 0 ? cw : 0)];
        gi[n] = 2 / Math.max(1e-6, Math.hypot(gx, gy));
      }
    }
    img = ctx.createImageData(cw, ch);
    for (let q = 0; q < img.data.length; q += 4) {
      img.data[q] = GREEN[0];
      img.data[q + 1] = GREEN[1];
      img.data[q + 2] = GREEN[2];
    }
    paint();
  };

  const step = () => {
    timer = 0;
    if (pos === want) return;
    pos += want > pos ? 1 : -1;
    paint();
    timer = setTimeout(step, STEP_MS);
  };
  const go = (open) => {
    want = open ? BANDS : 0;
    if (still) {
      pos = want;
      paint();
    } else if (!timer) step();
  };

  layout();
  let t = 0;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(layout, 100); }).observe(card);

  card.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') go(true); });
  card.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') go(false); });
  card.addEventListener('focus', () => { if (card.matches(':focus-visible')) go(true); });
  card.addEventListener('blur', () => go(false));

  // Touch has no hover: drain it as the tap sends you through. Returns a
  // reset for coming back to the page from the browser cache.
  const open = () => go(true);
  open.reset = () => {
    clearTimeout(timer);
    timer = 0;
    pos = want = 0;
    paint();
  };
  return open;
}
