import GUI from 'lil-gui';
import { CausticScene, LOOKS } from './scene.js';
import { LiveInput } from '../live.js';
import { scramble } from '../shared/scramble.js';
import { wipeIn, wipeLink } from '../shared/wipe.js';

wipeIn();

// Frequency runs across the surface, time along it, newest at the front.
const COLS = 192;
const ROWS = 128;
const FMIN = 40;
const FMAX = 16000;

const S = {
  look: 'Reference',
  height: 0.12,
  depth: 0.35,
  strength: 1,
  slope: 0.9,
  soft: 2.5,
  history: 6, // seconds of sound on the surface
  smooth: 2.5,
  range: 60,
  tilt: 3,
  gamma: 1.3,
  surface: true,
  wireframe: true,
};

const $ = (id) => document.getElementById(id);
const scene = new CausticScene($('view'), { cols: COLS, rows: ROWS });
const live = new LiveInput();

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

/* -------------------------------------------------------------- audio -- */

let ctx = null;
const ensureCtx = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

// A file plays through `bus`, which the analysers listen to.
const player = { buffer: null, node: null, bus: null, startedAt: 0, offset: 0, playing: false };
let source = 'idle'; // 'idle' | 'file' | 'mic'

function play() {
  if (!player.buffer) return;
  const c = ensureCtx();
  c.resume();
  const node = c.createBufferSource();
  node.buffer = player.buffer;
  node.loop = true;
  node.connect(player.bus);
  node.start(0, player.offset % player.buffer.duration);
  player.node = node;
  player.startedAt = c.currentTime - player.offset;
  player.playing = true;
  $('btn-play').textContent = 'Pause';
}

function pause() {
  if (!player.node) return;
  player.offset = (ensureCtx().currentTime - player.startedAt) % player.buffer.duration;
  player.node.stop();
  player.node.disconnect();
  player.node = null;
  player.playing = false;
  $('btn-play').textContent = 'Play';
}

async function loadFile(file) {
  if (!file) return;
  try {
    $('srcname').textContent = `Decoding ${file.name}…`;
    const c = ensureCtx();
    const buffer = await c.decodeAudioData(await file.arrayBuffer());
    stopMic();
    pause();
    if (!player.bus) {
      player.bus = c.createGain();
      player.bus.connect(c.destination);
    }
    player.buffer = buffer;
    player.offset = 0;
    await live.attach(c, player.bus, file.name);
    live.buildMap(COLS, FMIN, FMAX, 'log');
    resetLevels();
    source = 'file';
    $('srcname').textContent = file.name;
    $('btn-play').hidden = false;
    play();
  } catch (err) {
    $('srcname').textContent = source === 'idle' ? 'idle preview · drop an audio file' : live.label;
    toast(`Could not play ${file.name}: ${err.message}`);
  }
}

async function startMic() {
  if (!LiveInput.supported) { toast('This browser cannot capture audio'); return; }
  try {
    pause();
    const label = await live.start('device');
    ctx = live.ctx;
    live.buildMap(COLS, FMIN, FMAX, 'log');
    live.onended = stopMic;
    resetLevels();
    source = 'mic';
    $('srcname').textContent = `live · ${label}`;
    $('btn-mic').classList.add('on');
    $('btn-play').hidden = true;
  } catch (err) {
    const denied = /denied|NotAllowed/i.test(String(err.name) + String(err.message));
    toast(denied ? 'Microphone permission was denied' : err.message);
  }
}

function stopMic() {
  if (source !== 'mic') return;
  live.stop();
  source = 'idle';
  $('btn-mic').classList.remove('on');
  $('srcname').textContent = 'idle preview · drop an audio file';
}

/* ----------------------------------------------------- spectrum -> rows -- */

const db = new Float32Array(COLS);
const sm = new Float32Array(COLS).fill(-140);
const tmp = new Float32Array(COLS);
const row = new Float32Array(COLS);
const oct = new Float32Array(COLS);
for (let c = 0; c < COLS; c++) {
  const f = FMIN * Math.pow(FMAX / FMIN, (c + 0.5) / COLS);
  oct[c] = Math.log2(f / 1000);
}
let top = -40; // running peak, so quiet passages still fill the height

function resetLevels() {
  sm.fill(-140);
  top = -40;
}

/** Shape the newest spectrum into 0..1 heights, smoothed in time and frequency. */
function spectrumRow() {
  if (!live.read(db)) return null;
  const a = 1 / (1 + S.smooth);
  for (let c = 0; c < COLS; c++) sm[c] += (db[c] - sm[c]) * a;
  // a small blur across frequency keeps single bins from spiking the surface
  const r = 2;
  let mx = -200;
  for (let c = 0; c < COLS; c++) {
    let s = 0, n = 0;
    for (let i = -r; i <= r; i++) {
      const j = c + i;
      if (j >= 0 && j < COLS) { s += sm[j]; n++; }
    }
    tmp[c] = s / n + S.tilt * oct[c];
    if (tmp[c] > mx) mx = tmp[c];
  }
  top = Math.max(mx, top - 0.08);
  const lo = top - S.range;
  for (let c = 0; c < COLS; c++) {
    const h = Math.min(1, Math.max(0, (tmp[c] - lo) / S.range));
    row[c] = Math.pow(h, S.gamma);
  }
  return row;
}

/** With nothing loaded: a few slow, drifting "notes" so the surface is alive. */
function idleRow(t) {
  for (let c = 0; c < COLS; c++) {
    const x = c / COLS;
    let h = 0;
    for (let k = 0; k < 4; k++) {
      const centre = 0.18 + 0.17 * k + 0.05 * Math.sin(t * (0.23 + k * 0.07) + k * 1.9);
      const amp = 0.35 + 0.25 * Math.sin(t * (0.9 + k * 0.31) + k);
      h += amp * Math.exp(-Math.pow((x - centre) / (0.025 + 0.01 * k), 2));
    }
    row[c] = Math.min(1, h * 0.9);
  }
  return row;
}

/* ------------------------------------------------------------- frames -- */

// Start with a full surface rather than a flat sheet filling up.
{
  const t0 = performance.now() / 1000;
  const rate = (ROWS - 2) / S.history;
  for (let k = ROWS; k > 0; k--) scene.pushRow(idleRow(t0 - k / rate));
}

let acc = 0;
let last = performance.now();
scene.onFrame = () => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const listening = source === 'mic' || (source === 'file' && player.playing);
  if (source === 'file' && !player.playing) return; // paused: the surface holds still
  const rate = (ROWS - 2) / S.history;
  acc += dt * rate;
  let n = Math.min(6, Math.floor(acc)); // cap catch-up after a stall
  acc -= n;
  while (n-- > 0) {
    const r = listening ? spectrumRow() : idleRow(now / 1000);
    if (r) scene.pushRow(r);
  }
  scene.setScroll(Math.min(1, acc));
};

/* ----------------------------------------------------------------- ui -- */

function apply() {
  scene.set({
    height: S.height, depth: S.depth, strength: S.strength, slope: S.slope, soft: S.soft,
    surface: S.surface, wireframe: S.wireframe,
  });
}

const gui = new GUI({ container: $('panel'), title: 'Caustics' });
gui.add(S, 'look', Object.keys(LOOKS)).name('Look').onChange((v) => scene.setLook(v));
const fS = gui.addFolder('Surface');
fS.add(S, 'height', 0.02, 0.4, 0.005).name('Height').onChange(apply);
fS.add(S, 'surface').name('Show surface').onChange(apply);
fS.add(S, 'wireframe').name('Show grid').onChange(apply);
const fL = gui.addFolder('Light');
fL.add(S, 'depth', 0.05, 1.2, 0.01).name('Floor distance').onChange(apply);
fL.add(S, 'strength', 0.2, 3, 0.05).name('Caustic strength').onChange(apply);
fL.add(S, 'slope', 0.1, 3, 0.05).name('Max slope').onChange(apply);
fL.add(S, 'soft', 1, 6, 0.1).name('Light softness').onChange(apply);
const fA = gui.addFolder('Sound');
fA.add(S, 'history', 2, 20, 0.5).name('Seconds shown');
fA.add(S, 'smooth', 0, 8, 0.1).name('Smoothing');
fA.add(S, 'range', 20, 100, 1).name('Dynamic range (dB)');
fA.add(S, 'tilt', 0, 6, 0.1).name('Tilt (dB/oct)');
fA.add(S, 'gamma', 0.5, 3, 0.05).name('Contrast');
if (window.innerWidth > 0 && window.innerWidth < 640) gui.close();
apply();

$('btn-open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
$('btn-mic').addEventListener('click', () => (source === 'mic' ? stopMic() : startMic()));
$('btn-play').addEventListener('click', () => (player.playing ? pause() : play()));
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.target.closest('input, select, textarea, button')) return;
  e.preventDefault();
  if (source === 'file') (player.playing ? pause() : play());
});

// drag and drop anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  loadFile(e.dataTransfer.files[0]);
});

scramble(document.querySelector('.brand-txt'), document.querySelector('.brand'));
scramble($('btn-open'));
scramble($('btn-mic'));
wipeLink(document.querySelector('.brand'));

// test hook
window.__caustics = { scene, S, loadFile, live, get source() { return source; } };
