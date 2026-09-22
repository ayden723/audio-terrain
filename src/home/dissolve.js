// Pixel dissolve for the Audio Terrain card: on hover the orange breaks into
// square pixels (the same chunky pixels as the background shader) and falls
// away to show a blueprint terrain underneath, drawn in the spectrogram's
// default Blueprint colours.

const CELL = 52; // target pixel size in CSS px; the grid rounds to fit the card
const BLUE = '#10365e';
const LINE = '216, 236, 255'; // rgb; far ridges are fainter so the card's text stays readable

// A made-up but plausible spectrum: energy in the middle bands, uneven peaks.
function ridge(x, k) {
  const env = Math.exp(-Math.pow((x - 0.45) / 0.3, 2));
  const a = 0.55 + 0.45 * Math.sin(x * 21 + k * 1.37);
  const b = 0.6 + 0.4 * Math.sin(x * 53 - k * 2.11);
  const c = 0.5 + 0.5 * Math.sin(x * 9 + k * 0.6);
  return env * a * b * (0.45 + 0.55 * c);
}

function drawTerrain(canvas) {
  const r = canvas.getBoundingClientRect();
  const d = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * d));
  const h = Math.max(1, Math.round(r.height * d));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BLUE;
  ctx.fillRect(0, 0, w, h);

  // Hidden-line ridges, back to front, so nearer ridges cover the ones behind.
  const n = 22;
  const top = h * 0.44;
  const bottom = h * 1.02;
  const steps = 140;
  const pts = new Float32Array((steps + 1) * 2);
  ctx.lineWidth = d;
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1);
    const y0 = top + (bottom - top) * Math.pow(f, 1.5);
    const amp = h * 0.22 * (0.35 + 0.65 * f);
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      pts[i * 2] = x * w;
      pts[i * 2 + 1] = y0 - amp * ridge(x, k);
    }
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 1; i <= steps; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = BLUE;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 1; i <= steps; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
    ctx.strokeStyle = `rgba(${LINE}, ${(0.12 + 0.43 * f).toFixed(3)})`;
    ctx.stroke();
  }
}

function buildCells(grid, card) {
  const cols = Math.max(4, Math.round(card.clientWidth / CELL));
  const rows = Math.max(4, Math.round(card.clientHeight / CELL));
  if (grid.childElementCount === cols * rows && grid.style.getPropertyValue('--cols') === String(cols)) return;
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--rows', rows);
  grid.textContent = '';
  for (let i = 0; i < cols * rows; i++) {
    const cell = document.createElement('i');
    const d = Math.random();
    cell.style.setProperty('--out', `${Math.round(d * 320)}ms`);
    cell.style.setProperty('--in', `${Math.round((1 - d) * 200)}ms`); // reverse order on the way back
    grid.appendChild(cell);
  }
}

export function dissolve(card) {
  const under = document.createElement('canvas');
  under.className = 'card-under';
  under.setAttribute('aria-hidden', 'true');
  const grid = document.createElement('div');
  grid.className = 'card-cells';
  grid.setAttribute('aria-hidden', 'true');
  card.prepend(under, grid);

  const layout = () => {
    buildCells(grid, card);
    drawTerrain(under);
  };
  layout();
  let t = 0;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(layout, 100); }).observe(card);

  // Touch has no hover: show the terrain as the tap sends you through.
  return () => card.classList.add('is-open');
}
