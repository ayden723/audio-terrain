// Landscape: frame an area on a real map, turn its elevation into sound, and
// draw the map back from that sound.
//
// Pipeline: frame -> Web Mercator box -> elevation grid in metres (dem.js) ->
// heights mapped linearly to decibels -> matched synthesis, then analysis of
// the very audio that plays (dsp.js, in a worker) -> decibels mapped back to
// metres -> drawn as a topographic map (render.js), with the round-trip error
// measured against the source.
//
// Axes: time runs west -> east, frequency south (low) -> north (high), so the
// spectrogram reads like the map, north up.

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre finds its worker beside its own file, which bundling breaks. Hand
// it over as a Vite worker (a plain ?url import gets Vite's page client
// injected in development, which kills the worker).
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { loadDem, lonToMerc, latToMerc, mercToLon, mercToLat, cellMetres } from './dem.js';
import { plan } from './dsp.js';
import { reliefPixels, diffPixels, contours, contourStep } from './render.js';
import { Relief } from '../relief.js';
import { PRESETS, DEFAULT_STOPS, lookUniforms } from '../presets.js';
import { encodeWav } from '../wav.js';
import { scramble } from '../shared/scramble.js';
import { wipeIn } from '../shared/wipe.js';

wipeIn();

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------ settings -- */

const DEFAULTS = {
  source: 'auto', detail: 384, precision: 1, range: 60, sea: true, basemap: 'topo', overlay: 0,
  // the 3D view
  dim: '3d', look: 'Inferno', mode: 'preset', ridges: '100', vscale: 'auto', cam: 'reference', orbit: false,
};
const S = { ...DEFAULTS };
try {
  Object.assign(S, JSON.parse(localStorage.getItem('landscape-settings') || '{}'));
} catch { /* no storage: defaults */ }
const saveSettings = () => {
  try { localStorage.setItem('landscape-settings', JSON.stringify(S)); } catch { /* fine */ }
};

const PLACES = [
  ['Grand Canyon, Arizona', -112.113, 36.098, 11.2],
  ['Mount St. Helens, Washington', -122.19, 46.2, 12],
  ['Yosemite Valley, California', -119.57, 37.735, 12.4],
  ['Mauna Kea, Hawaii', -155.47, 19.82, 10.5],
  ['Denali, Alaska', -151.0, 63.07, 10.3],
  ['Matterhorn, Switzerland', 7.658, 45.976, 12.6],
  ['Mount Everest, Nepal', 86.925, 27.988, 11.6],
  ['Mount Fuji, Japan', 138.727, 35.361, 11.3],
  ['Table Mountain, South Africa', 18.41, -33.962, 12.3],
  ['Kilimanjaro, Tanzania', 37.355, -3.068, 11],
  ['Torres del Paine, Chile', -73.0, -50.97, 11.3],
  ['Eyjafjallajökull, Iceland', -19.62, 63.63, 11.3],
];

const STYLES = {
  topo: {
    version: 8,
    sources: {
      otm: {
        type: 'raster',
        tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
        tileSize: 256,
        maxzoom: 17,
        attribution:
          'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      },
    },
    layers: [{ id: 'otm', type: 'raster', source: 'otm' }],
  },
  streets: 'https://tiles.openfreemap.org/styles/liberty',
};

const CREDITS = {
  '3dep': 'Elevation: USGS 3D Elevation Program.',
  copernicus:
    'Elevation: Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA.',
};

// Audio Terrain's looks, plus one tinted like a printed topographic map.
const LOOKS = {
  ...PRESETS,
  Topographic: {
    mode: 'surface',
    colorMode: 'ramp',
    bg: '#e9e4d8',
    shadow: '#3c3a33',
    highlight: '#f4f1ea',
    line: '#5c381e',
    accent: '#c25a22',
    stops: ['#5c864e', '#a3b46e', '#d8c991', '#a37a55', '#efeae2'],
    skirt: 0.3,
    lineWidth: 0.8,
    lineOpacity: 0.14,
    fog: 0.35,
    baseFade: 0.04,
    crestShade: 0,
    crestLen: 0.3,
    ambient: 0.5,
    rim: 0.06,
    shadowStr: 0.5,
    lightAz: -45,
    lightEl: 38,
    grain: true,
  },
};
if (!LOOKS[S.look]) S.look = DEFAULTS.look;

/* ----------------------------------------------------------------- map -- */

let view = { lng: PLACES[0][1], lat: PLACES[0][2], zoom: PLACES[0][3] };
try {
  const v = JSON.parse(localStorage.getItem('landscape-view') || 'null');
  if (v && Number.isFinite(v.lng) && Number.isFinite(v.lat) && Number.isFinite(v.zoom)) view = v;
} catch { /* fine */ }

maplibregl.setWorkerUrl(mapWorkerUrl);

const map = new maplibregl.Map({
  container: 'map',
  style: STYLES[S.basemap] || STYLES.topo,
  center: [view.lng, view.lat],
  zoom: view.zoom,
  // north stays up: the spectrogram's frequency axis is north-south
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  maxPitch: 0,
  renderWorldCopies: false,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

map.on('moveend', () => {
  const c = map.getCenter();
  try { localStorage.setItem('landscape-view', JSON.stringify({ lng: c.lng, lat: c.lat, zoom: map.getZoom() })); } catch { /* fine */ }
  updateEstimate();
  markStale();
});

// The frame: an inset rectangle in the map, clear of the zoom buttons on the
// right and the scale bar along the bottom.
function frameRect() {
  const el = $('map');
  const w = el.clientWidth;
  const h = el.clientHeight;
  const m = { l: 20, r: 52, t: 20, b: 36 };
  return { x: m.l, y: m.t, w: Math.max(40, w - m.l - m.r), h: Math.max(40, h - m.t - m.b) };
}
function layoutFrame() {
  const f = frameRect();
  Object.assign($('frame').style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
}

/** The framed area as a Web Mercator box (the map is north-up with no tilt). */
function frameBox() {
  const f = frameRect();
  const nw = map.unproject([f.x, f.y]);
  const se = map.unproject([f.x + f.w, f.y + f.h]);
  return { minX: lonToMerc(nw.lng), maxX: lonToMerc(se.lng), minY: latToMerc(se.lat), maxY: latToMerc(nw.lat) };
}

function gridSize() {
  const f = frameRect();
  const rows = S.detail;
  const cols = Math.max(16, Math.min(rows * 3, Math.round((rows * f.w) / f.h)));
  return { rows, cols };
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtM = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${m >= 10 ? Math.round(m) : m.toFixed(1)} m`);

function updateEstimate() {
  const { rows, cols } = gridSize();
  const p = plan(rows, cols, S.precision);
  const box = frameBox();
  const cell = cellMetres(box, rows, rows / 2);
  $('estimate').textContent = `${cols}×${rows} cells · ${fmtM(cell)} each · ≈ ${fmtTime(p.duration)} of audio`;
}

/* ------------------------------------------------------------ pipeline -- */

const worker = new Worker(new URL('./sound.worker.js', import.meta.url), { type: 'module' });
let jobId = 0;
let abort = null;
let area = null;   // { box, rows, cols, heights, label, source, key }
let result = null; // { plan, samples, rec, wet, src, sea, lo, hi, stats, images }

function busy(label, f) {
  $('busy').hidden = label == null;
  if (label != null) {
    $('busy').querySelector('.lbl').textContent = label;
    $('busy').querySelector('.bar i').style.width = `${Math.round((f || 0) * 100)}%`;
  }
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

const areaKey = (box, rows, cols, source) => [box.minX, box.minY, box.maxX, box.maxY, rows, cols, source].map(String).join('|');

function markStale() {
  if (!area) return;
  const { rows, cols } = gridSize();
  const stale = area.key !== areaKey(frameBox(), rows, cols, S.source);
  $('capture').classList.toggle('stale', stale);
}

async function capture() {
  const box = frameBox();
  const { rows, cols } = gridSize();
  const key = areaKey(box, rows, cols, S.source);
  if (area && area.key === key) return voice();

  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  const id = ++jobId;
  stop();
  busy('Reading elevation…', 0);
  try {
    const dem = await loadDem(box, rows, cols, S.source, { signal, onStatus: (s) => busy(s, 0.05) });
    if (id !== jobId) return;
    area = { box, rows, cols, key, heights: dem.heights, label: dem.label, source: dem.source };
    $('capture').classList.remove('stale');
    await voice();
  } catch (err) {
    if (err.name === 'AbortError' || id !== jobId) return;
    busy(null);
    toast(`Could not read elevation: ${err.message}`);
  }
}

function runWorker(rows, cols, precision, amps) {
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') {
        busy(`${m.stage}…`, m.stage === 'Synthesizing' ? 0.1 + 0.6 * m.f : 0.7 + 0.3 * m.f);
        return;
      }
      worker.removeEventListener('message', onMsg);
      if (m.type === 'done') resolve(m);
      else reject(new Error(m.message));
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ id, rows, cols, precision, amps }, [amps.buffer]);
  }).then((m) => (id === jobId ? m : null));
}

/** Heights -> sound -> heights, then draw everything. */
async function voice() {
  if (!area) return;
  stop();
  const { rows, cols, heights: src } = area;
  const n = rows * cols;
  const range = S.range;

  // the floor: lowest land when the sea is silent, else the lowest point
  const sea = new Uint8Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (S.sea && src[i] <= 0) { sea[i] = 1; continue; }
    if (src[i] < lo) lo = src[i];
    if (src[i] > hi) hi = src[i];
  }
  if (!(hi >= lo)) {
    busy(null);
    toast('This area is all sea, so it would be silent. Move the frame over land, or turn off "Sea is silent".');
    return;
  }
  const span = hi - lo || 1;

  // linear in decibels: lowest -> -range dB, highest -> 0 dB; row 0 = south
  const amps = new Float32Array(n);
  for (let y = 0; y < rows; y++) {
    const r = rows - 1 - y;
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      amps[r * cols + x] = sea[i] ? 0 : Math.pow(10, (-range + (range * (src[i] - lo)) / span) / 20);
    }
  }

  const p = plan(rows, cols, S.precision);
  busy('Synthesizing…', 0.1);
  let out;
  try {
    out = await runWorker(rows, cols, S.precision, amps);
  } catch (err) {
    busy(null);
    toast(`Synthesis failed: ${err.message}`);
    return;
  }
  if (!out) return;

  // decibels -> metres; anything clearly under the floor is silence
  const rec = new Float32Array(n);
  const wet = new Uint8Array(n);
  for (let y = 0; y < rows; y++) {
    const r = rows - 1 - y;
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const db = 20 * Math.log10(out.measured[r * cols + x] + 1e-12);
      if (db < -range - 6) { wet[i] = 1; rec[i] = lo; continue; }
      rec[i] = lo + ((db + range) / range) * span;
    }
  }

  // round-trip error over land both agree on
  const diff = new Float32Array(n);
  let se = 0;
  let count = 0;
  let max = 0;
  let misread = 0;
  const abs = [];
  for (let i = 0; i < n; i++) {
    if (sea[i] !== wet[i]) { misread++; continue; }
    if (sea[i]) continue;
    const d = rec[i] - src[i];
    diff[i] = d;
    se += d * d;
    count++;
    max = Math.max(max, Math.abs(d));
    if ((i & 7) === 0) abs.push(Math.abs(d));
  }
  abs.sort((a, b) => a - b);
  const p99 = abs.length ? abs[Math.floor(abs.length * 0.99)] : 0;
  const stats = { rms: count ? Math.sqrt(se / count) : 0, max, misread, p99 };

  const both = new Uint8Array(n);
  for (let i = 0; i < n; i++) both[i] = sea[i] | wet[i];
  const step = contourStep(span);
  const images = {
    sound: gridCanvas(reliefPixels(rec, wet, rows, cols, area.box, lo, hi), rows, cols),
    source: gridCanvas(reliefPixels(src, sea, rows, cols, area.box, lo, hi), rows, cols),
    diff: gridCanvas(diffPixels(diff, both, rows, cols, Math.max(0.5, p99)), rows, cols),
  };
  const lines = {
    sound: contours(rec, wet, rows, cols, step),
    source: contours(src, sea, rows, cols, step),
  };

  // For the 3D view: Relief reads slices (time = map columns, west -> east) of
  // frequency columns (map rows, south -> north), heights 0..1 over lo..hi.
  const h3d = new Float32Array(n);
  for (let x = 0; x < cols; x++) {
    for (let r = 0; r < rows; r++) {
      const i = (rows - 1 - r) * cols + x;
      h3d[x * rows + r] = wet[i] ? 0 : Math.min(1, Math.max(0, (rec[i] - lo) / span));
    }
  }

  result = { plan: p, samples: out.samples, stats, lo, hi, step, images, lines, diffScale: Math.max(0.5, p99), area, h3d };
  audioBuffer = null;
  position = 0;
  busy(null);
  $('empty').hidden = true;
  for (const id of ['play', 'seek', 'wav']) $(id).disabled = false;
  $('tdur').textContent = fmtTime(p.duration);
  showStats();
  drawSpec();
  show3d(true);
  updateOverlay();
}

function gridCanvas(px, rows, cols) {
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  c.getContext('2d').putImageData(new ImageData(px, cols, rows), 0, 0);
  return c;
}

function showStats() {
  const r = result;
  const a = r.area;
  const cell = cellMetres(a.box, a.rows, a.rows / 2);
  const fine = a.source === 'copernicus' && cell < 30 ? ' (finer than the 30 m data, so interpolated)' : '';
  const credit = a.source === 'mixed' ? `${CREDITS['3dep']} ${CREDITS.copernicus}` : CREDITS[a.source] || '';
  const misread = r.stats.misread ? ` · <b>${r.stats.misread.toLocaleString()}</b> cells misread as sea / land` : '';
  $('stats').classList.remove('idle');
  $('stats').innerHTML =
    `<div class="acc"><span class="k">Round trip</span> <b>${r.stats.rms.toFixed(2)} m</b> RMS · 99% within <b>${r.stats.p99.toFixed(1)} m</b> · worst <b>${r.stats.max.toFixed(1)} m</b>${misread}</div>` +
    `<div class="meta">${a.label} · ${fmtM(cell)} cells${fine} · ${Math.round(r.lo).toLocaleString()}–${Math.round(r.hi).toLocaleString()} m · contours every ${r.step} m` +
    ` · ${Math.round(r.plan.hz(0))}–${Math.round(r.plan.hz(a.rows - 1)).toLocaleString()} Hz</div>` +
    `<div class="attr" title="${credit}">${credit || '&nbsp;'}</div>`;
}

/* --------------------------------------------------------- spectrogram -- */

let viewMode = 'sound';
let plot = null; // where the image sits on the canvas, in CSS pixels

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function drawSpec() {
  const cv = $('spec');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!result) { plot = null; return; }

  const { rows, cols } = result.area;
  const m = { l: 62, r: 16, t: 20, b: 44 };
  const aw = Math.max(10, W - m.l - m.r);
  const ah = Math.max(10, H - m.t - m.b);
  const s = Math.min(aw / cols, ah / rows);
  const pw = cols * s;
  const ph = rows * s;
  plot = { x: m.l + (aw - pw) / 2, y: m.t + (ah - ph) / 2, w: pw, h: ph };

  g.imageSmoothingEnabled = s < 1 || viewMode === 'diff' ? true : false;
  g.imageSmoothingQuality = 'high';
  // cells are drawn as cells when magnified, so nothing is invented between them
  g.drawImage(result.images[viewMode], plot.x, plot.y, pw, ph);

  if (viewMode !== 'diff') {
    for (const set of result.lines[viewMode]) {
      g.strokeStyle = set.index ? 'rgba(92, 56, 30, 0.75)' : 'rgba(92, 56, 30, 0.42)';
      g.lineWidth = set.index ? 1.1 : 0.6;
      g.beginPath();
      const a = set.segs;
      for (let i = 0; i < a.length; i += 4) {
        g.moveTo(plot.x + a[i] * s, plot.y + a[i + 1] * s);
        g.lineTo(plot.x + a[i + 2] * s, plot.y + a[i + 3] * s);
      }
      g.stroke();
    }
  }
  g.strokeStyle = 'rgba(42, 38, 32, 0.5)';
  g.lineWidth = 1;
  g.strokeRect(plot.x + 0.5, plot.y + 0.5, pw - 1, ph - 1);

  drawAxes(g, s);
  placePlayhead();
}

function drawAxes(g, s) {
  const p = result.plan;
  const { rows, box } = result.area;
  g.fillStyle = '#4b453b';
  g.strokeStyle = 'rgba(42, 38, 32, 0.45)';
  g.font = '11px ui-sans-serif, system-ui, sans-serif';

  // frequency, low at the bottom (south)
  const f0 = p.hz(0);
  const f1 = p.hz(rows - 1);
  const fs = niceStep((f1 - f0) / 6);
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let f = Math.ceil(f0 / fs) * fs; f <= f1; f += fs) {
    const r = ((f * p.n) / p.sampleRate - p.k0) / p.spacing;
    const y = plot.y + ((rows - 0.5 - r) / rows) * plot.h;
    g.beginPath();
    g.moveTo(plot.x - 5, y);
    g.lineTo(plot.x, y);
    g.stroke();
    g.fillText(f >= 1000 ? `${+(f / 1000).toFixed(2)}k` : `${f}`, plot.x - 8, y);
  }
  g.save();
  g.translate(14, plot.y + plot.h / 2);
  g.rotate(-Math.PI / 2);
  g.textAlign = 'center';
  g.fillText('Frequency, Hz  ·  north ↑', 0, 0);
  g.restore();

  // time, west to east
  const ts = niceStep(p.duration / 7);
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (let t = 0; t <= p.duration + 1e-9; t += ts) {
    const x = plot.x + (t / p.duration) * plot.w;
    g.beginPath();
    g.moveTo(x, plot.y + plot.h);
    g.lineTo(x, plot.y + plot.h + 5);
    g.stroke();
    g.fillText(ts < 1 ? `${t.toFixed(1)} s` : fmtTime(t), x, plot.y + plot.h + 8);
  }
  g.fillText('Time  ·  west → east', plot.x + plot.w / 2, plot.y + plot.h + 25);

  // ground scale bar, top right of the plot
  const mpp = cellMetres(box, rows, rows / 2) / s;
  const len = niceStep((plot.w / 5) * mpp);
  const px = len / mpp;
  const bx = plot.x + plot.w - px - 10;
  const by = plot.y + 14;
  g.fillStyle = 'rgba(255, 255, 255, 0.75)';
  g.fillRect(bx - 6, by - 10, px + 12, 22);
  g.fillStyle = '#2a2620';
  g.fillRect(bx, by + 4, px, 3);
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.fillText(fmtM(len), bx + px / 2, by + 3);

  if (viewMode === 'diff') {
    const d = result.diffScale;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.fillRect(plot.x + 8, plot.y + 8, 210, 22);
    g.fillStyle = '#2a2620';
    g.fillText(`blue −${d.toFixed(1)} m · white exact · red +${d.toFixed(1)} m`, plot.x + 14, plot.y + 19);
  }
}

/* ------------------------------------------------------------ 3D view -- */

const relief = new Relief($('view3d'));

/**
 * Proportions from the ground itself: width (north-south) and depth (east-
 * west) follow the grid, and at x1 a metre up is a metre across. Auto lifts
 * flat places until the relief is readable, and says by how much.
 */
function dims3d() {
  const { rows, cols, box } = result.area;
  const big = Math.max(rows, cols);
  const ground = big * cellMetres(box, rows, rows / 2);
  const trueH = (10 * (result.hi - result.lo || 1)) / ground;
  // auto aims for Audio Terrain's default height (3.4 against a width of 10)
  const auto = Math.min(8, Math.max(1, Math.round((3.4 / trueH) * 10) / 10));
  $('vscale').options[0].textContent = `Height: auto (×${auto})`;
  const k = S.vscale === 'auto' ? auto : Number(S.vscale);
  return { W: (10 * rows) / big, D: (10 * cols) / big, H: trueH * k };
}

function applyLook() {
  const L = { shadowLen: 1.4, shadowSteps: 8, ...LOOKS[S.look] };
  L.stops = (L.stops || DEFAULT_STOPS).slice();
  const mode = S.mode === 'preset' ? L.mode : S.mode;
  relief.setMode(mode);
  relief.set(lookUniforms({ ...L, mode }));
  relief.setLight(L.lightAz, L.lightEl);
  $('grain').classList.toggle('off', !L.grain);
  $('stage3d').style.background = L.bg;
}

// Ridges are drawn along time; past a couple of hundred they blur into moiré,
// so "every column" is there for checking, not for looking.
function applyRidges() {
  if (!result) return;
  const cols = result.area.cols;
  relief.setRidges(S.ridges === 'all' ? cols : Math.min(cols, Number(S.ridges)));
}

/** Hand the decoded heights to the renderer; `fresh` replays the draw-in. */
function show3d(fresh) {
  if (!result) return;
  const { rows, cols } = result.area;
  relief.setData(result.h3d, cols, rows);
  applyRidges();
  relief.setDims(dims3d());
  applyLook();
  if (fresh) {
    relief.setView(S.cam, false);
    relief.playIntro();
  } else relief.reframe(false);
}

function setDim(dim) {
  S.dim = dim;
  saveSettings();
  for (const b of $('dim').querySelectorAll('button')) b.classList.toggle('on', b.dataset.dim === dim);
  $('spec-pane').classList.toggle('flat', dim === '2d');
  $('spec').hidden = dim !== '2d';
  if (dim === '2d') drawSpec();
  placePlayhead();
}

/* -------------------------------------------------------- map overlay -- */

let overlayUrl = null;

function boxCorners(box) {
  const w = mercToLon(box.minX);
  const e = mercToLon(box.maxX);
  const n = mercToLat(box.maxY);
  const s = mercToLat(box.minY);
  return [[w, n], [e, n], [e, s], [w, s]];
}

// isStyleLoaded() is also false while tiles are still loading, so just try
// and, if the style isn't ready, come back once the map settles.
function addOverlayLayers() {
  if (!result || !overlayUrl) return;
  try {
    addLayers();
  } catch {
    map.once('idle', addOverlayLayers);
  }
}

function addLayers() {
  const coordinates = boxCorners(result.area.box);
  if (map.getSource('sound')) {
    map.getSource('sound').updateImage({ url: overlayUrl, coordinates });
  } else {
    map.addSource('sound', { type: 'image', url: overlayUrl, coordinates });
    map.addLayer({ id: 'sound', type: 'raster', source: 'sound', paint: { 'raster-opacity': S.overlay / 100, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } });
  }
  if (!map.getSource('playhead')) {
    map.addSource('playhead', { type: 'geojson', data: playheadLine() });
    map.addLayer({ id: 'playhead', type: 'line', source: 'playhead', paint: { 'line-color': '#c25a22', 'line-width': 2 } });
  }
}

/** The sound's own map, with contours, as an image laid over the real one. */
function updateOverlay() {
  const { rows, cols } = result.area;
  const k = Math.max(1, Math.min(4, Math.floor(2048 / Math.max(rows, cols))));
  const c = document.createElement('canvas');
  c.width = cols * k;
  c.height = rows * k;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(result.images.sound, 0, 0, c.width, c.height);
  for (const set of result.lines.sound) {
    g.strokeStyle = set.index ? 'rgba(92, 56, 30, 0.8)' : 'rgba(92, 56, 30, 0.45)';
    g.lineWidth = set.index ? 1.4 : 0.8;
    g.beginPath();
    const a = set.segs;
    for (let i = 0; i < a.length; i += 4) {
      g.moveTo(a[i] * k, a[i + 1] * k);
      g.lineTo(a[i + 2] * k, a[i + 3] * k);
    }
    g.stroke();
  }
  c.toBlob((blob) => {
    if (overlayUrl) URL.revokeObjectURL(overlayUrl);
    overlayUrl = URL.createObjectURL(blob);
    addOverlayLayers();
  });
}

map.on('style.load', addOverlayLayers);

/* ------------------------------------------------------------ playback -- */

let ctx = null;
let audioBuffer = null;
let node = null;
let startedAt = 0;
let position = 0;

const playing = () => node != null;
const now = () => (playing() ? ctx.currentTime - startedAt : position);

function play() {
  if (!result) return;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  if (!audioBuffer) {
    audioBuffer = ctx.createBuffer(1, result.samples.length, result.plan.sampleRate);
    audioBuffer.copyToChannel(result.samples, 0);
  }
  if (position >= result.plan.duration - 0.01) position = 0;
  node = ctx.createBufferSource();
  node.buffer = audioBuffer;
  node.connect(ctx.destination);
  const me = node;
  node.onended = () => {
    if (node !== me) return;
    node = null;
    position = 0;
    $('play').classList.remove('playing');
  };
  node.start(0, position);
  startedAt = ctx.currentTime - position;
  $('play').classList.add('playing');
  tick();
}

function stop() {
  if (node) {
    position = now();
    const n = node;
    node = null;
    n.stop();
  }
  $('play').classList.remove('playing');
}

function seek(t) {
  const was = playing();
  stop();
  position = Math.max(0, Math.min(result.plan.duration, t));
  if (was) play();
  else showTime();
}

function playheadLine() {
  if (!result) return { type: 'FeatureCollection', features: [] };
  const { box } = result.area;
  const f = now() / result.plan.duration;
  const lon = mercToLon(box.minX + f * (box.maxX - box.minX));
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[lon, mercToLat(box.maxY)], [lon, mercToLat(box.minY)]] },
  };
}

function placePlayhead() {
  const ph = $('playhead');
  if (!result || !plot || S.dim !== '2d' || (!playing() && position === 0)) { ph.hidden = true; return; }
  ph.hidden = false;
  const f = now() / result.plan.duration;
  Object.assign(ph.style, { left: `${plot.x + f * plot.w}px`, top: `${plot.y}px`, height: `${plot.h}px` });
}

let lastCol = -1;
function showTime() {
  if (!result) return;
  const t = now();
  $('tcur').textContent = fmtTime(t);
  $('seek').value = String(Math.round((t / result.plan.duration) * 1000));
  placePlayhead();
  // the 3D cursor rides the ridge that is sounding now
  relief.setPlayhead(t / result.plan.duration, playing() || position > 0 ? 1 : 0);
  const col = Math.floor((t / result.plan.duration) * result.area.cols);
  if (col !== lastCol) {
    lastCol = col;
    map.getSource('playhead')?.setData(playheadLine());
  }
}

function tick() {
  showTime();
  if (playing()) requestAnimationFrame(tick);
}

/* ---------------------------------------------------------------- wire -- */

function bindSelect(id, key, parse, after) {
  const el = $(id);
  el.value = String(S[key]);
  el.addEventListener('change', () => {
    S[key] = parse(el.value);
    saveSettings();
    after();
  });
}

// what is fetched depends on these, so they wait for the next capture
const refetch = () => { updateEstimate(); markStale(); };
// these only change the sound, so an area already loaded is re-voiced at once
const revoice = () => { updateEstimate(); if (area) voice(); };

bindSelect('source', 'source', String, refetch);
bindSelect('detail', 'detail', Number, refetch);
bindSelect('precision', 'precision', Number, revoice);
bindSelect('range', 'range', Number, revoice);

$('sea').checked = S.sea;
$('sea').addEventListener('change', () => { S.sea = $('sea').checked; saveSettings(); revoice(); });

bindSelect('basemap', 'basemap', String, () => map.setStyle(STYLES[S.basemap] || STYLES.topo));

$('overlay').value = String(S.overlay);
$('overlay').addEventListener('input', () => {
  S.overlay = Number($('overlay').value);
  saveSettings();
  if (map.getLayer('sound')) map.setPaintProperty('sound', 'raster-opacity', S.overlay / 100);
});

for (const [name] of PLACES) {
  const o = document.createElement('option');
  o.textContent = name;
  o.value = name;
  $('place').appendChild(o);
}
$('place').addEventListener('change', () => {
  const p = PLACES.find(([n]) => n === $('place').value);
  if (p) map.jumpTo({ center: [p[1], p[2]], zoom: p[3] });
  $('place').value = '';
});

$('capture').addEventListener('click', capture);
$('play').addEventListener('click', () => (playing() ? stop() : play()));
$('seek').addEventListener('input', () => result && seek((Number($('seek').value) / 1000) * result.plan.duration));
$('spec').addEventListener('click', (e) => {
  if (!result || !plot) return;
  const r = $('spec').getBoundingClientRect();
  const f = (e.clientX - r.left - plot.x) / plot.w;
  if (f >= 0 && f <= 1) seek(f * result.plan.duration);
});

for (const name of Object.keys(LOOKS)) {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name;
  $('look').appendChild(o);
}
bindSelect('look', 'look', String, applyLook);
bindSelect('mode', 'mode', String, applyLook);
bindSelect('ridges', 'ridges', String, applyRidges);
bindSelect('vscale', 'vscale', String, () => { if (result) { relief.setDims(dims3d()); relief.reframe(); } });
bindSelect('cam', 'cam', String, () => relief.setView(S.cam));
$('orbit').checked = S.orbit;
relief.setAutoMove(S.orbit, 1);
$('orbit').addEventListener('change', () => { S.orbit = $('orbit').checked; saveSettings(); relief.setAutoMove(S.orbit, 1); });
for (const b of $('dim').querySelectorAll('button')) b.addEventListener('click', () => setDim(b.dataset.dim));
applyLook();
setDim(S.dim);

for (const b of $('view').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    viewMode = b.dataset.view;
    for (const o of $('view').querySelectorAll('button')) o.classList.toggle('on', o === b);
    drawSpec();
  });
}

$('wav').addEventListener('click', () => {
  if (!result) return;
  const blob = encodeWav(result.samples, result.plan.sampleRate);
  const { box } = result.area;
  const lat = mercToLat((box.minY + box.maxY) / 2).toFixed(3);
  const lon = mercToLon((box.minX + box.maxX) / 2).toFixed(3);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `landscape_${lat}_${lon}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !result) return;
  const t = e.target;
  if (t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type !== 'range') || t instanceof HTMLButtonElement) return;
  e.preventDefault();
  if (playing()) stop();
  else play();
});

new ResizeObserver(() => {
  layoutFrame();
  updateEstimate();
  markStale();
  drawSpec();
}).observe(document.body);

layoutFrame();
updateEstimate();
scramble(document.querySelector('.brand-txt'), document.querySelector('.brand'));
