/* ============================================================
   main.js — Composer: paint a spectrogram, hear it, see it in 3D
   ------------------------------------------------------------
   One PaintGrid feeds BOTH the live 3D terrain (terrain.js) and the
   audio (shared additive synth) — no duplicate data models.
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { Terrain } from '../../terrain/js/terrain.js';
import { gridToAudioBuffer, encodeWav } from '../../shared/gridsynth.js';
import { PaintGrid } from './grid.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ---------- fixed grid (time × frequency) ---------- */
const GW = 768, GH = 288;   // columns (time), rows (frequency)
const DUR = 8;              // seconds of audio the width represents
const MIN_F = 55, MAX_F = 8000;
const LOG_MIN = Math.log(MIN_F), LOG_MAX = Math.log(MAX_F);
const rowToFreq = r => Math.exp(LOG_MIN + (LOG_MAX - LOG_MIN) * (r / (GH - 1)));
const freqToRow = f => (Math.log(f) - LOG_MIN) / (LOG_MAX - LOG_MIN) * (GH - 1);

const grid = new PaintGrid(GW, GH);

// A fixed speckle field the noise brush multiplies into — static per cell so
// overlapping dabs keep the texture instead of averaging it smooth.
const noiseTex = new Float32Array(GW * GH);
for (let i = 0; i < noiseTex.length; i++) noiseTex[i] = 0.1 + 0.9 * Math.random();

/* ---------- amplitude → colour ramp (dark → cyan → white) ---------- */
const LUT = new Uint8Array(256 * 3);
(() => {
  const stops = [[8, 10, 20], [16, 60, 110], [40, 150, 200], [110, 226, 232], [255, 255, 255]];
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const a = Math.min(stops.length - 2, Math.floor(t)), f = t - a;
    for (let c = 0; c < 3; c++) LUT[i * 3 + c] = Math.round(stops[a][c] + (stops[a + 1][c] - stops[a][c]) * f);
  }
})();

/* ---------- display ---------- */
const paint = $('paint');
const pctx = paint.getContext('2d');
const off = document.createElement('canvas');
off.width = GW; off.height = GH;
const octx = off.getContext('2d');
const img = octx.createImageData(GW, GH);

let scale = 1, panX = 0, panY = 0;

function fitView() {
  const w = window.innerWidth, h = window.innerHeight;
  scale = Math.min(w / GW, h / GH) * 0.82;
  panX = (w - GW * scale) / 2;
  panY = (h - GH * scale) / 2;
}

// Only rewrite the changed rectangle into the offscreen image (cheap).
function rebuildImage() {
  const r = grid.dirtyRect;
  if (r.x1 < r.x0 || r.y1 < r.y0) { grid.clearDirty(); return; }
  const d = img.data, data = grid.data;
  for (let row = r.y0; row <= r.y1; row++) {
    const y = GH - 1 - row;
    const srcBase = row * GW, dstBase = y * GW;
    for (let col = r.x0; col <= r.x1; col++) {
      const li = (clamp(data[srcBase + col], 0, 1) * 255) | 0;
      const p = (dstBase + col) * 4;
      d[p] = LUT[li * 3]; d[p + 1] = LUT[li * 3 + 1]; d[p + 2] = LUT[li * 3 + 2]; d[p + 3] = 255;
    }
  }
  const iy0 = GH - 1 - r.y1;
  octx.putImageData(img, 0, 0, r.x0, iy0, (r.x1 - r.x0) + 1, (r.y1 - r.y0) + 1);
  grid.clearDirty();
}

let cursor = { x: -999, y: -999, over: false };

function toImage(sx, sy) { return { x: (sx - panX) / scale, y: (sy - panY) / scale }; }

/* ---------- brush state ---------- */
let tool = 'brush';                       // 'brush' | 'eraser'
let type = 'tone';                        // 'tone' | 'harmonic' | 'noise'
let snap = false;
const brush = { size: 16, hardness: 0.3, opacity: 0.6 };

/* one dab, with note-snap + harmonics + noise applied */
function paintDab(imgX, imgY) {
  const erase = tool === 'eraser';
  let iy = imgY;
  if (snap && !erase) {
    const f = rowToFreq(clamp(GH - 1 - iy, 0, GH - 1));
    const nf = 440 * Math.pow(2, Math.round(12 * Math.log2(f / 440)) / 12);
    iy = (GH - 1) - freqToRow(nf);
  }
  grid.stamp(imgX, iy, brush.size, brush.hardness, brush.opacity,
    { erase, noise: type === 'noise' && !erase, noiseTex });

  if (type === 'harmonic' && !erase) {
    const fund = rowToFreq(clamp(GH - 1 - iy, 0, GH - 1));
    for (let k = 2; k <= 5; k++) {
      const hr = freqToRow(fund * k);
      if (hr > GH - 1) break;
      grid.stamp(imgX, (GH - 1) - hr, brush.size * 0.75, brush.hardness, brush.opacity / k, { erase: false });
    }
  }
}

/* ---------- painting (the 2D drawing space is fixed — no zoom/pan) ---------- */
let painting = false, last = null;

function stampAt(sx, sy) { const p = toImage(sx, sy); paintDab(p.x, p.y); }
function strokeTo(sx, sy) {
  if (!last) { stampAt(sx, sy); last = { x: sx, y: sy }; scheduleSync(); return; }
  const dx = sx - last.x, dy = sy - last.y, dist = Math.hypot(dx, dy);
  const step = Math.max(1, brush.size * scale * 0.28);
  const n = Math.max(1, Math.floor(dist / step));
  for (let i = 1; i <= n; i++) stampAt(last.x + dx * (i / n), last.y + dy * (i / n));
  last = { x: sx, y: sy };
  scheduleSync();
}

paint.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  paint.setPointerCapture(e.pointerId);
  cursor = { x: e.clientX, y: e.clientY, over: true };
  audioResume();
  grid.snapshot();
  painting = true; last = null;
  strokeTo(e.clientX, e.clientY);
});
paint.addEventListener('pointermove', e => {
  cursor = { x: e.clientX, y: e.clientY, over: true };
  if (painting) strokeTo(e.clientX, e.clientY);
});
function endStroke() { if (painting) { painting = false; last = null; syncNow(); } }
paint.addEventListener('pointerup', endStroke);
paint.addEventListener('pointercancel', endStroke);
paint.addEventListener('pointerleave', () => { cursor.over = false; });
paint.addEventListener('contextmenu', e => e.preventDefault());

/* ---------- 3D inset (reuses terrain.js) ---------- */
const mini = $('mini');
const mrenderer = new THREE.WebGLRenderer({ canvas: mini, antialias: true, powerPreference: 'high-performance' });
mrenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
mrenderer.outputColorSpace = THREE.SRGBColorSpace;
mrenderer.toneMapping = THREE.ACESFilmicToneMapping;
mrenderer.toneMappingExposure = 1.05;

const mscene = new THREE.Scene();
mscene.fog = new THREE.Fog(0x05060f, 260, 620);
const mcam = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
mcam.position.set(0, 175, 235);
const mctrl = new OrbitControls(mcam, mini);
mctrl.enableDamping = true; mctrl.dampingFactor = 0.08;
mctrl.maxPolarAngle = Math.PI * 0.495;
mctrl.target.set(0, 4, 0);

mscene.add(new THREE.AmbientLight(0x2a3170, 0.7));
const mkey = new THREE.DirectionalLight(0xfff4e0, 1.2); mkey.position.set(120, 180, 80); mscene.add(mkey);
const mrim = new THREE.DirectionalLight(0x6a4fd6, 0.6); mrim.position.set(-140, 60, -120); mscene.add(mrim);

const terrain = new Terrain(mscene);
terrain.duration = DUR;
terrain.build(grid.spec, DUR);
terrain.setPalette('aurora');
for (const o of [terrain.contour, terrain.sheet, terrain.marker]) if (o) o.visible = false;
mctrl.update();

function miniSize() {
  const r = mini.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio, 1.75);
  mrenderer.setSize(r.width, r.height, false);
  mini.width = Math.round(r.width * dpr); mini.height = Math.round(r.height * dpr);
  mcam.aspect = r.width / Math.max(1, r.height);
  mcam.updateProjectionMatrix();
}
function collapseMini() { $('mini-wrap').classList.remove('expanded'); requestAnimationFrame(miniSize); }
function toggleMini() { $('mini-wrap').classList.toggle('expanded'); requestAnimationFrame(miniSize); }
$('mini-expand').addEventListener('click', toggleMini);

/* ---------- audio ---------- */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const master = audioCtx.createGain(); master.gain.value = 0.9; master.connect(audioCtx.destination);
let buffer = null, source = null, playing = false, bufferStale = true, playStart = 0;

function audioResume() { if (audioCtx.state === 'suspended') audioCtx.resume(); }
function regenBuffer() {
  if (grid.isEmpty) { buffer = null; bufferStale = false; return; }
  buffer = gridToAudioBuffer(grid.data, GW, GH, audioCtx, { duration: DUR, minFreq: MIN_F, maxFreq: MAX_F });
  bufferStale = false;
}
function startSource() {
  stopSource();
  if (!buffer) return;
  source = audioCtx.createBufferSource();
  source.buffer = buffer; source.loop = true; source.connect(master); source.start();
  playStart = audioCtx.currentTime;
}
function stopSource() { if (source) { try { source.stop(); } catch (_) {} source.disconnect(); source = null; } }

function togglePlay() {
  audioResume();
  if (playing) { playing = false; stopSource(); $('play-btn').classList.remove('playing'); return; }
  if (bufferStale) regenBuffer();
  if (!buffer) return;
  playing = true; startSource(); $('play-btn').classList.add('playing');
}
$('play-btn').addEventListener('click', togglePlay);

/* ---------- sync scheduler ---------- */
let syncPending = false, lastTerrainSync = 0, audioTimer = 0;
function scheduleSync() { syncPending = true; bufferStale = true; }
function maybeLiveTerrain(now) {
  if (syncPending && now - lastTerrainSync > 110) {
    terrain.updateFromGrid(grid.spec, true);   // skip normals while dragging
    lastTerrainSync = now;
  }
}
function syncNow() {
  terrain.updateFromGrid(grid.spec, false);      // full quality on release
  syncPending = false;
  clearTimeout(audioTimer);
  audioTimer = setTimeout(() => { regenBuffer(); if (playing) startSource(); }, 160);
}

/* ---------- toolbar + settings ---------- */
function setTool(t) {
  tool = t;
  $('tool-brush').classList.toggle('active', t === 'brush');
  $('tool-eraser').classList.toggle('active', t === 'eraser');
}
$('tool-brush').addEventListener('click', () => setTool('brush'));
$('tool-eraser').addEventListener('click', () => setTool('eraser'));

function setType(t) {
  type = t;
  for (const n of ['tone', 'harmonic', 'noise']) $('type-' + n).classList.toggle('active', n === t);
}
$('type-tone').addEventListener('click', () => setType('tone'));
$('type-harmonic').addEventListener('click', () => setType('harmonic'));
$('type-noise').addEventListener('click', () => setType('noise'));
$('snap').addEventListener('change', e => { snap = e.target.checked; });

function updateUndoRedo() { $('act-undo').disabled = !grid.canUndo; $('act-redo').disabled = !grid.canRedo; }
$('act-undo').addEventListener('click', () => { if (grid.undo()) syncNow(); updateUndoRedo(); });
$('act-redo').addEventListener('click', () => { if (grid.redo()) syncNow(); updateUndoRedo(); });
$('act-clear').addEventListener('click', () => { grid.snapshot(); grid.clearAll(); syncNow(); updateUndoRedo(); });

function bindSlider(id, valId, fmt, apply) {
  const el = $(id), val = $(valId);
  const update = () => { const v = parseFloat(el.value); val.textContent = fmt(v); apply(v); };
  el.addEventListener('input', update); update();
}
bindSlider('brush-size', 'size-val', v => `${Math.round(v)}`, v => { brush.size = v; });
bindSlider('brush-hardness', 'hard-val', v => `${Math.round(v * 100)}%`, v => { brush.hardness = v; });
bindSlider('brush-opacity', 'op-val', v => `${Math.round(v * 100)}%`, v => { brush.opacity = v; });

$('export-wav').addEventListener('click', () => {
  if (bufferStale) regenBuffer();
  if (!buffer) return;
  const wav = encodeWav(buffer.getChannelData(0), audioCtx.sampleRate);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(wav); a.download = 'composer.wav'; a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------- keyboard: space play/stop, ctrl+z ---------- */
addEventListener('keydown', e => {
  if (e.code === 'Escape') {
    if ($('mini-wrap').classList.contains('expanded')) { collapseMini(); return; }
  }
  if (e.code === 'Space' && !e.repeat) {
    if (e.target.tagName === 'INPUT') return;
    e.preventDefault(); togglePlay(); return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) { if (grid.redo()) syncNow(); } else { if (grid.undo()) syncNow(); }
    updateUndoRedo();
  }
});

/* ---------- resize + main loop ---------- */
function onResize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  paint.width = window.innerWidth * dpr;
  paint.height = window.innerHeight * dpr;
  paint.style.width = window.innerWidth + 'px';
  paint.style.height = window.innerHeight + 'px';
  paint._dpr = dpr;
  fitView();          // keep the fixed drawing space centered & fitted
  miniSize();
}
window.addEventListener('resize', onResize);

function drawBrushPreview() {
  if (!cursor.over) return;
  const r = brush.size * scale;
  pctx.beginPath();
  pctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
  pctx.strokeStyle = tool === 'eraser' ? 'rgba(255,140,140,0.9)' : 'rgba(255,255,255,0.9)';
  pctx.lineWidth = 1.5; pctx.stroke();
  pctx.beginPath();
  pctx.arc(cursor.x, cursor.y, Math.max(1, r * brush.hardness), 0, Math.PI * 2);
  pctx.strokeStyle = 'rgba(255,255,255,0.25)'; pctx.stroke();
}

function drawPlayhead() {
  if (!playing || !buffer) return;
  const prog = ((audioCtx.currentTime - playStart) % DUR) / DUR;
  const x = panX + prog * GW * scale;
  pctx.strokeStyle = 'rgba(255,255,255,0.9)';
  pctx.lineWidth = 1.5;
  pctx.beginPath(); pctx.moveTo(x, panY); pctx.lineTo(x, panY + GH * scale); pctx.stroke();
}

function draw() {
  const dpr = paint._dpr || 1;
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.fillStyle = '#05060f';
  pctx.fillRect(0, 0, paint.width / dpr, paint.height / dpr);
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = 'high';
  pctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * panX, dpr * panY);
  pctx.drawImage(off, 0, 0);
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.strokeStyle = 'rgba(140,160,255,0.25)';
  pctx.lineWidth = 1;
  pctx.strokeRect(panX + 0.5, panY + 0.5, GW * scale, GH * scale);
  drawPlayhead();
  drawBrushPreview();
}

function frame(now) {
  requestAnimationFrame(frame);
  if (grid.dirty) rebuildImage();
  maybeLiveTerrain(now);
  updateUndoRedo();
  draw();
  mctrl.update();
  mrenderer.render(mscene, mcam);
}

fitView();
onResize();
miniSize();
setTool('brush');
setType('tone');
requestAnimationFrame(frame);

window.__composer = { grid, get buffer() { return buffer; }, terrain };
