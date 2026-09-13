import GUI from 'lil-gui';
import { Relief } from './relief.js';
import { PRESETS, DEFAULT_STOPS } from './presets.js';
import { makeDemo } from './demo.js';
import { imageLevels, imagePixels } from './shape.js';
import { encodeWav } from './wav.js';
import { LiveInput } from './live.js';

/* --------------------------------------------------------------- state -- */

const S = {
  // analysis — time resolution is chosen automatically from the source
  quality: 'high',
  cols: 900,
  fmin: 30,
  fmax: 18000,
  scale: 'log',
  // shaping
  range: 68,
  tilt: 1.5,
  gamma: 1.25,
  cut: 0,
  smooth: 2,
  // geometry
  ridges: 260,
  height: 3.4,
  width: 10,
  depth: 6,
  reverse: false,
  // waterfall
  waterfall: false,
  windowSec: 4,
  loop: true,
  // look — seeded from the default preset so the two can't drift apart
  preset: 'Blueprint',
  ...PRESETS['Blueprint'],
  stops: DEFAULT_STOPS.slice(),
  shadowLen: 1.4,
  shadowSteps: 8,
  renderScale: 1,
  autoMove: false,
  motionSpeed: 1,
  view: 'reference',
  // live
  liveDevice: '',
  // image
  invert: false,
  terrainFrom: 'Image pixels',
  synthDuration: 12,
  synthRange: 55,
  synthRows: 512,
  // playback
  playMode: 'cursor',
};

// Taken before anything mutates S, so Reset always has a true baseline.
const DEFAULTS = structuredClone(S);

const src = { kind: null, name: '', bitmap: null, audioBuffer: null, wavBlob: null, duration: 0 };
const live = new LiveInput();
let dataDims = null; // { slices, cols } of whatever matrix the worker is holding

/* ------------------------------------------------------------- helpers -- */

const $ = (id) => document.getElementById(id);
const relief = new Relief($('view'));

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

let busy = 0;
function setBusy(on, label) {
  busy = Math.max(0, busy + (on ? 1 : -1));
  const el = $('loading');
  el.hidden = busy === 0;
  if (label) el.querySelector('.lbl').textContent = label;
  if (busy === 0) el.querySelector('.bar i').style.width = '0%';
}
const setProgress = (v) => {
  $('loading').querySelector('.bar i').style.width = `${Math.round(v * 100)}%`;
};

const showEmpty = (show) => { $('empty').hidden = !show; };

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* -------------------------------------------------------------- worker -- */

const worker = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
let jobId = 0;
const pending = new Map();

worker.onmessage = (e) => {
  const m = e.data;
  const job = pending.get(m.id);
  if (!job) return;
  if (m.type === 'progress') { job.onProgress?.(m.value); return; }
  pending.delete(m.id);
  if (m.type === 'error') job.reject(new Error(m.message));
  else job.resolve(m);
};

function call(msg, transfer, onProgress) {
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}

/* ------------------------------------------------------------ analysis -- */

/**
 * How many time slices to analyse. The full view can never show more detail than
 * the ridges it draws, so it stays cheap; a waterfall window shows only a
 * fraction of the file at a time and needs proportionally more.
 */
function autoSlices() {
  const d = src.duration || 12;
  if (S.waterfall) return Math.max(240, Math.min(3000, Math.ceil((d / S.windowSec) * S.ridges)));
  return Math.max(200, Math.min(1000, Math.round(S.ridges * 1.8)));
}

let analyzing = false;
let analyzeQueued = false;

async function requestAnalysis() {
  if (!src.audioBuffer) return;
  if (analyzing) { analyzeQueued = true; return; }
  analyzing = true;
  setBusy(true, 'Analyzing audio…');
  try {
    const r = await call(
      {
        type: 'analyze',
        params: {
          slices: autoSlices(), cols: S.cols, fmin: S.fmin, fmax: S.fmax,
          scale: S.scale, quality: S.quality,
        },
      },
      [],
      setProgress
    );
    dataDims = { slices: r.slices, cols: r.cols };
    await applyShape();
  } catch (err) {
    toast(`Analysis failed: ${err.message}`);
  } finally {
    setBusy(false);
    analyzing = false;
    if (analyzeQueued) { analyzeQueued = false; requestAnalysis(); }
  }
}

function buildImageTerrain() {
  if (!src.bitmap) return;
  const slices = autoSlices();
  const values = imageLevels(src.bitmap, slices, S.cols, S.invert);
  dataDims = { slices, cols: S.cols };
  worker.postMessage({ type: 'setLevels', values, slices, cols: S.cols }, [values.buffer]);
  applyShape();
}

/** Re-run whichever source feeds the terrain. */
function rebuildTerrain() {
  if (src.kind === 'live') { resetLive(); return; }
  if (src.kind === 'image' && S.terrainFrom === 'Image pixels') buildImageTerrain();
  else requestAnalysis();
}

// Shaping runs in the worker against the resident matrix, so dragging a slider
// never blocks the main thread and nothing large is copied between them.
let shaping = false;
let shapeQueued = false;

async function applyShape() {
  // live shapes each column as it arrives, so sliders take effect on the next one
  if (src.kind === 'live') return;
  if (!dataDims) return;
  if (shaping) { shapeQueued = true; return; }
  shaping = true;
  try {
    const r = await call({
      type: 'shape',
      params: {
        tilt: S.tilt, smoothF: S.smooth, smoothT: S.smooth * 0.3,
        range: S.range, cut: S.cut, gamma: S.gamma,
      },
    });
    relief.setData(r.heights, dataDims.slices, dataDims.cols);
  } catch (err) {
    toast(`Shaping failed: ${err.message}`);
  } finally {
    shaping = false;
    if (shapeQueued) { shapeQueued = false; applyShape(); }
  }
}

/* ------------------------------------------------------------- sources -- */

let actx = null;
const ensureCtx = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());

function monoMix(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  if (buffer.numberOfChannels > 1) {
    const g = 1 / buffer.numberOfChannels;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return out;
}

function adoptAudio(buffer, name) {
  stopPlayback();
  src.audioBuffer = buffer;
  src.duration = buffer.duration;
  if (name) src.name = name;
  const mono = monoMix(buffer);
  worker.postMessage({ type: 'setAudio', samples: mono, sampleRate: buffer.sampleRate }, [mono.buffer]);
  updateTransportEnabled();
}

function samplesToBuffer(samples, sampleRate) {
  const buf = ensureCtx().createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  return buf;
}

// Kept for development and the test hook; deliberately not in the UI.
function loadDemo() {
  showEmpty(false);
  const { samples, sampleRate } = makeDemo();
  src.kind = 'audio';
  src.bitmap = null;
  src.wavBlob = null;
  src.name = 'demo tone bed';
  $('srcname').textContent = src.name;
  adoptAudio(samplesToBuffer(samples, sampleRate), src.name);
  showImageControls(false);
  requestAnalysis();
}

async function loadAudioFile(file) {
  setBusy(true, 'Decoding audio…');
  try {
    const ab = await file.arrayBuffer();
    const buffer = await ensureCtx().decodeAudioData(ab);
    src.kind = 'audio';
    src.bitmap = null;
    src.wavBlob = null;
    src.name = file.name;
    $('srcname').textContent = `${file.name} · ${fmtTime(buffer.duration)}`;
    adoptAudio(buffer, file.name);
    showImageControls(false);
    await requestAnalysis();
  } catch (err) {
    toast(`Could not decode ${file.name}: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

async function loadImageFile(file) {
  setBusy(true, 'Reading image…');
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    stopPlayback();
    src.kind = 'image';
    src.bitmap = bitmap;
    src.audioBuffer = null;
    src.wavBlob = null;
    src.name = file.name;
    src.duration = 0;
    $('srcname').textContent = `${file.name} · ${bitmap.width}×${bitmap.height}`;
    // keep the picture's proportions: image height -> frequency (width), image width -> time (depth)
    S.depth = Math.min(26, Math.max(3, (S.width * bitmap.width) / bitmap.height));
    relief.setDims({ D: S.depth });
    showImageControls(true);
    updateTransportEnabled();
    refreshGui();
    buildImageTerrain();
  } catch (err) {
    toast(`Could not read image: ${err.message}`);
    setBusy(false);
    return;
  }
  setBusy(false);
  // an image is always given a voice, so it can be played back straight away
  await synthesize();
}

function handleFile(file) {
  if (!file) return;
  showEmpty(false);
  const t = file.type || '';
  const ext = file.name.split('.').pop().toLowerCase();
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext)) loadImageFile(file);
  else loadAudioFile(file);
}

/* ----------------------------------------------------------- synthesis -- */

async function synthesize() {
  if (!src.bitmap) { toast('Load an image first'); return; }
  setBusy(true, 'Synthesizing audio…');
  try {
    const rows = S.synthRows;
    const cols = Math.max(64, Math.min(4000, Math.round(S.synthDuration * 120)));
    const pixels = imagePixels(src.bitmap, rows, cols, S.invert);
    const r = await call(
      {
        type: 'synth',
        rows,
        cols,
        pixels,
        params: {
          duration: S.synthDuration,
          fmin: S.fmin,
          fmax: S.fmax,
          scale: S.scale,
          sampleRate: 44100,
          dbRange: S.synthRange,
          threshold: 0.015,
        },
      },
      [],
      setProgress
    );
    src.wavBlob = encodeWav(r.samples, r.sampleRate);
    adoptAudio(samplesToBuffer(r.samples, r.sampleRate), src.name);
    if (S.terrainFrom === 'Synthesized audio') await requestAnalysis();
  } catch (err) {
    toast(`Synthesis failed: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

function downloadWav() {
  if (!src.wavBlob) { toast('Synthesize the audio first'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(src.wavBlob);
  a.download = `${src.name.replace(/\.[^.]+$/, '')}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}


/* ----------------------------------------------------------------- live -- */

let liveRing = null;   // [slices][cols] heights, oldest row first
let liveDb = null;     // newest raw column, dB
let liveSm = null;     // time-smoothed column, dB
let liveTmp = null;
let liveOct = null;    // log2(f / 1000) per column, for tilt
let liveTop = -40;     // running reference level (auto-gain)
let liveAccum = 0;
let liveLast = 0;

function allocLive() {
  const slices = Math.max(8, Math.round(S.ridges));
  const cols = S.cols;
  liveRing = new Float32Array(slices * cols);
  liveDb = new Float32Array(cols);
  liveSm = new Float32Array(cols).fill(-140);
  liveTmp = new Float32Array(cols);
  liveTop = -40;
  liveAccum = 0;
  liveLast = performance.now();
  dataDims = { slices, cols };

  live.buildMap(cols, S.fmin, S.fmax, S.scale);
  const centers = live.map ? live.map.centers : null;
  liveOct = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    liveOct[c] = Math.log2(Math.max(centers ? centers[c] : 1000, 1) / 1000);
  }

  relief.setData(liveRing, slices, cols);
  relief.setWindow(0, 1);
}

function resetLive() {
  if (src.kind === 'live' && live.active) allocLive();
}

function smoothColumn(arr, cols, sigma) {
  if (sigma < 0.3) return;
  const r = Math.max(1, Math.round(sigma));
  liveTmp.set(arr.subarray(0, cols));
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    let n = 0;
    for (let i = -r; i <= r; i++) {
      const j = c + i;
      if (j >= 0 && j < cols) { sum += liveTmp[j]; n++; }
    }
    arr[c] = sum / n;
  }
}

/** Roll the ring back one row and shape the newest spectrum into the front. */
function pushLiveColumn() {
  if (!live.read(liveDb)) return;
  const slices = dataDims.slices;
  const cols = dataDims.cols;

  // time smoothing, as a one-pole toward the new reading
  const a = 1 / (1 + S.smooth * 0.9);
  for (let c = 0; c < cols; c++) liveSm[c] += (liveDb[c] - liveSm[c]) * a;

  smoothColumn(liveSm, cols, S.smooth);

  // auto-gain: jump to peaks, fall back slowly, so quiet passages still read
  let mx = -200;
  for (let c = 0; c < cols; c++) if (liveSm[c] > mx) mx = liveSm[c];
  liveTop = Math.max(mx, liveTop - 0.06);

  const lo = liveTop - S.range;
  const span = Math.max(1e-6, S.range);
  const cut = Math.min(0.95, Math.max(0, S.cut));
  const g = Math.max(0.05, S.gamma);

  liveRing.copyWithin(0, cols); // drop the oldest row
  const base = (slices - 1) * cols;
  for (let c = 0; c < cols; c++) {
    let h = (liveSm[c] + S.tilt * liveOct[c] - lo) / span;
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    if (cut > 0) h = Math.max(0, (h - cut) / (1 - cut));
    liveRing[base + c] = Math.pow(h, g);
  }
  relief.setData(liveRing, slices, cols);
}

async function startLive(mode, deviceId) {
  if (!LiveInput.supported) { toast('This browser has no audio capture API'); return; }
  try {
    setBusy(true, mode === 'share' ? 'Waiting for you to pick a source...' : 'Requesting microphone...');
    const label = await live.start(mode, deviceId);
    stopPlayback();
    src.kind = 'live';
    src.bitmap = null;
    src.audioBuffer = null;
    src.wavBlob = null;
    src.duration = 0;
    src.name = label;
    showEmpty(false);
    showImageControls(false);
    updateTransportEnabled();
    $('srcname').textContent = 'live · ' + label;
    live.onended = () => stopLive();
    allocLive();
    await populateDevices();
    showLiveControls(true);
  } catch (err) {
    const denied = /denied|NotAllowed/i.test(String(err.name) + String(err.message));
    toast(denied ? 'Permission denied for audio capture' : err.message);
  } finally {
    setBusy(false);
  }
}

function stopLive() {
  live.stop();
  live.onended = null;
  showLiveControls(false);
  if (src.kind === 'live') {
    src.kind = null;
    src.name = '';
    $('srcname').textContent = 'no source';
    dataDims = null;
    showEmpty(true);
    relief.setData(new Float32Array(4), 2, 2);
  }
}

/* ------------------------------------------------------------ playback -- */

const player = { node: null, startedAt: 0, offset: 0, playing: false };

function playerTime() {
  if (!src.audioBuffer) return 0;
  const t = player.playing ? ensureCtx().currentTime - player.startedAt : player.offset;
  return Math.min(src.duration, Math.max(0, t));
}

function startPlayback() {
  if (!src.audioBuffer) return;
  const ctx = ensureCtx();
  ctx.resume();
  if (player.offset >= src.duration - 0.01) player.offset = 0;
  const node = ctx.createBufferSource();
  node.buffer = src.audioBuffer;
  node.connect(ctx.destination);
  node.onended = () => {
    if (player.node !== node) return;
    player.node = null;
    player.playing = false;
    player.offset = 0;
    if (S.loop) startPlayback();
    else $('play').classList.remove('playing');
  };
  node.start(0, player.offset);
  player.node = node;
  player.startedAt = ctx.currentTime - player.offset;
  player.playing = true;
  $('play').classList.add('playing');
}

function stopPlayback() {
  if (player.node) {
    player.node.onended = null;
    try { player.node.stop(); } catch { /* already stopped */ }
    player.node = null;
  }
  if (player.playing) player.offset = playerTime();
  player.playing = false;
  $('play').classList.remove('playing');
}

function togglePlay() {
  if (!src.audioBuffer) return;
  if (player.playing) stopPlayback();
  else startPlayback();
}

function seek(t) {
  player.offset = Math.max(0, Math.min(src.duration, t));
  if (player.playing) { stopPlayback(); startPlayback(); }
}

function updateTransportEnabled() {
  $('transport').classList.toggle('disabled', !src.audioBuffer);
  $('tdur').textContent = fmtTime(src.duration);
}

let seeking = false;
relief.onFrame = () => {
  if (src.kind === 'live' && live.active && dataDims) {
    const now = performance.now();
    const dt = Math.min(0.25, (now - liveLast) / 1000);
    liveLast = now;
    liveAccum += dt * (dataDims.slices / Math.max(0.2, S.windowSec));
    let n = Math.min(6, Math.floor(liveAccum)); // cap catch-up after a stall
    liveAccum -= n;
    while (n-- > 0) pushLiveColumn();
    relief.setWindow(0, 1);
    relief.setPlayhead(1, 0);
    return;
  }
  if (!src.audioBuffer || src.duration <= 0) {
    relief.setWindow(0, 1);
    relief.setPlayhead(0, 0);
    return;
  }
  const t = playerTime();
  const dataV = t / src.duration;
  if (!seeking) {
    $('seek').value = String(Math.round(dataV * 1000));
    $('tcur').textContent = fmtTime(t);
  }
  const active = player.playing || t > 0.001;
  const mode = S.playMode === 'off' ? 0 : S.playMode === 'reveal' ? 2 : 1;

  if (S.waterfall) {
    const span = Math.min(1, S.windowSec / src.duration);
    const start = Math.max(0, Math.min(1 - span, dataV - span));
    relief.setWindow(start, span);
    // in waterfall the leading edge *is* the playhead, so no cursor is drawn
    relief.setPlayhead(span > 0 ? (dataV - start) / span : 1, 0);
  } else {
    relief.setWindow(0, 1);
    relief.setPlayhead(dataV, active ? mode : 0);
  }
};

/* ---------------------------------------------------------------- look -- */

function applyLook() {
  relief.setMode(S.mode);
  relief.setRidges(S.ridges);
  relief.set({
    uBg: S.bg,
    uShadow: S.shadow,
    uHighlight: S.highlight,
    uLine: S.line,
    uAccent: S.accent,
    uStops: S.stops,
    uColorMode: S.colorMode === 'ramp' ? 1 : 0,
    uAmbient: S.ambient,
    uFillMix: S.mode === 'lines' ? 0 : 1,
    uSkirt: S.skirt,
    uLineW: S.lineWidth,
    uLineOpacity: S.lineOpacity,
    uCrestShade: S.crestShade,
    uCrestLen: S.crestLen,
    uBaseFade: S.baseFade,
    uRim: S.rim,
    uShadowStr: S.shadowStr,
    uShadowLen: S.shadowLen,
    uShadowSteps: S.shadowSteps,
    uFog: S.fog,
    uReverse: S.reverse ? 1 : 0,
  });
  relief.setLight(S.lightAz, S.lightEl);
  relief.setDims({ W: S.width, H: S.height, D: S.depth });
  document.documentElement.style.setProperty('--paper', S.bg);
  document.documentElement.style.setProperty('--accent', S.accent);
  const c = S.bg.replace('#', '');
  const lum =
    (0.2126 * parseInt(c.slice(0, 2), 16) + 0.7152 * parseInt(c.slice(2, 4), 16) + 0.0722 * parseInt(c.slice(4, 6), 16)) / 255;
  document.documentElement.style.setProperty('--ink', lum > 0.5 ? '#2b2925' : '#efe7d8');
  $('grain').classList.toggle('off', !S.grain);
}

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  Object.assign(S, p);
  if (!p.stops) S.stops = DEFAULT_STOPS.slice();
  applyLook();
  refreshGui();
}

/* ----------------------------------------------------------------- GUI -- */

let gui;
let imgControllers = [];
let stopCtrl = null;
let deviceCtrl = null;

function showLiveControls(show) {
  [stopCtrl, deviceCtrl].forEach((c) => c && (show ? c.show() : c.hide()));
}

/** Device labels are blank until capture permission is granted, so the list is
 *  refreshed after a successful start rather than up front. */
async function populateDevices() {
  if (!deviceCtrl) return;
  const list = await live.listInputs();
  const opts = { 'System default': '' };
  list.forEach((d, i) => { opts[d.label || ('Input ' + (i + 1))] = d.deviceId; });
  deviceCtrl = deviceCtrl
    .options(opts)
    .name('Input device')
    .onChange((v) => startLive('device', v));
}

function refreshGui() {
  gui?.controllersRecursive().forEach((c) => c.updateDisplay());
}
function showImageControls(show) {
  imgControllers.forEach((c) => (show ? c.show() : c.hide()));
}

/** Ridge count and window size feed autoSlices(), so they can need a re-analysis. */
function maybeReanalyze() {
  if (src.kind === 'live') { resetLive(); return; }
  if (S.waterfall) rebuildTerrain();
}

function buildGui() {
  gui = new GUI({ container: $('panel'), title: 'Controls' });

  const fSrc = gui.addFolder('Source');
  fSrc.add({ open: () => { stopLive(); $('file').click(); } }, 'open').name('Open audio / image…');
  fSrc.add({ mic: () => startLive('device') }, 'mic').name('Live: microphone / input');
  fSrc.add({ share: () => startLive('share') }, 'share').name('Live: share tab / system');
  deviceCtrl = fSrc.add(S, 'liveDevice', { 'System default': '' }).name('Input device');
  stopCtrl = fSrc.add({ stop: stopLive }, 'stop').name('Stop live input');
  showLiveControls(false);
  imgControllers = [
    fSrc.add(S, 'invert').name('Invert image').onChange(rebuildTerrain),
    fSrc.add(S, 'terrainFrom', ['Image pixels', 'Synthesized audio']).name('Terrain from').onChange(rebuildTerrain),
    fSrc.add(S, 'synthDuration', 2, 60, 0.5).name('Audio length (s)').onFinishChange(synthesize),
    fSrc.add({ d: downloadWav }, 'd').name('Download WAV'),
  ];
  showImageControls(false);

  const fLook = gui.addFolder('Look');
  fLook.add(S, 'preset', Object.keys(PRESETS)).name('Preset').onChange(applyPreset);
  fLook.add(S, 'mode', { Ridges: 'ridges', Lines: 'lines', Surface: 'surface' }).name('Render mode').onChange(applyLook);
  fLook.add(S, 'ridges', 24, 600, 1).name('Ridge count').onChange(applyLook).onFinishChange(maybeReanalyze);
  fLook.add(S, 'skirt', 0, 1.2, 0.01).name('Ridge depth').onChange(applyLook);
  fLook.add(S, 'height', 0.2, 9, 0.05).name('Height').onChange(applyLook);
  fLook.add(S, 'smooth', 0, 8, 0.1).name('Smoothing').onChange(applyShape);
  fLook.add(S, 'range', 20, 120, 1).name('Dynamic range (dB)').onChange(applyShape);
  fLook.add(S, 'gamma', 0.3, 3, 0.01).name('Contrast').onChange(applyShape);

  const fFall = gui.addFolder('Waterfall');
  fFall.add(S, 'waterfall').name('Scroll with audio').onChange(rebuildTerrain);
  fFall.add(S, 'loop').name('Loop');
  fFall.add(S, 'windowSec', 0.5, 30, 0.5).name('Window (s)').onFinishChange(maybeReanalyze);

  const fCam = gui.addFolder('Camera');
  fCam.add(S, 'view', {
    Reference: 'reference', Front: 'front', Side: 'side', 'Low angle': 'low', 'Top down': 'top',
  }).name('View').onChange((v) => relief.setView(v));
  fCam.add(S, 'autoMove').name('Auto move').onChange((v) => relief.setAutoMove(v, S.motionSpeed));
  fCam.add(S, 'motionSpeed', 0.25, 3, 0.05).name('Motion speed').onChange((v) => relief.setAutoMove(S.autoMove, v));

  const fAdv = gui.addFolder('Advanced');

  const fAna = fAdv.addFolder('Analysis');
  fAna.add(S, 'quality', { Standard: 'standard', High: 'high', 'Ultra (slow)': 'ultra' }).name('FFT quality').onChange(rebuildTerrain);
  fAna.add(S, 'cols', 128, 2048, 16).name('Frequency detail').onFinishChange(rebuildTerrain);
  fAna.add(S, 'fmin', 10, 500, 1).name('Min Hz').onFinishChange(rebuildTerrain);
  fAna.add(S, 'fmax', 1000, 22050, 100).name('Max Hz').onFinishChange(rebuildTerrain);
  fAna.add(S, 'scale', { Logarithmic: 'log', Mel: 'mel', Linear: 'linear' }).name('Frequency scale').onChange(rebuildTerrain);

  const fShape = fAdv.addFolder('Shape');
  fShape.add(S, 'tilt', -6, 9, 0.1).name('Tilt (dB/oct)').onChange(applyShape);
  fShape.add(S, 'cut', 0, 0.6, 0.005).name('Floor cut').onChange(applyShape);
  fShape.add(S, 'width', 3, 24, 0.1).name('Width').onChange(applyLook);
  fShape.add(S, 'depth', 2, 30, 0.1).name('Depth').onChange(applyLook);
  fShape.add(S, 'reverse').name('Reverse time').onChange(applyLook);

  const fCol = fAdv.addFolder('Colour & light');
  fCol.add(S, 'colorMode', { 'Lit relief': 'lit', 'Colour ramp': 'ramp' }).name('Shading').onChange(applyLook);
  fCol.addColor(S, 'bg').name('Background').onChange(applyLook);
  fCol.addColor(S, 'shadow').name('Shadow').onChange(applyLook);
  fCol.addColor(S, 'highlight').name('Highlight').onChange(applyLook);
  fCol.addColor(S, 'line').name('Crest line').onChange(applyLook);
  fCol.addColor(S, 'accent').name('Playhead').onChange(applyLook);
  fCol.add(S, 'lineOpacity', 0, 1, 0.01).name('Edge lines').onChange(applyLook);
  fCol.add(S, 'crestShade', 0, 1, 0.01).name('Crest shading').onChange(applyLook);
  fCol.add(S, 'shadowStr', 0, 1, 0.01).name('Cast shadows').onChange(applyLook);
  fCol.add(S, 'rim', 0, 0.6, 0.01).name('Rim light').onChange(applyLook);
  fCol.add(S, 'fog', 0, 1, 0.01).name('Depth fade').onChange(applyLook);
  fCol.add(S, 'ambient', 0, 1, 0.01).name('Ambient light').onChange(applyLook);
  fCol.add(S, 'lightAz', -180, 180, 1).name('Light angle').onChange(applyLook);
  fCol.add(S, 'lightEl', 2, 88, 1).name('Light height').onChange(applyLook);
  fCol.add(S, 'grain').name('Paper grain').onChange(applyLook);
  fCol.add(S, 'renderScale', 0.5, 2, 0.25).name('Render quality').onChange((v) => relief.setRenderScale(v));

  const fSyn = fAdv.addFolder('Image synthesis');
  fSyn.add(S, 'synthRange', 20, 90, 1).name('Synth dynamics (dB)').onFinishChange(synthesize);
  fSyn.add(S, 'synthRows', 128, 1024, 32).name('Synth partials').onFinishChange(synthesize);
  fSyn.add({ s: synthesize }, 's').name('Re-synthesize audio');

  fAdv.close();
  fAna.close();
  fShape.close();
  fCol.close();
  fSyn.close();
}

/* -------------------------------------------------------------- events -- */

$('file').addEventListener('change', (e) => {
  handleFile(e.target.files[0]);
  e.target.value = '';
});
$('btn-open').addEventListener('click', () => $('file').click());
$('empty-open').addEventListener('click', () => $('file').click());
$('play').addEventListener('click', togglePlay);
$('btn-reset').addEventListener('click', resetSettings);
$('btn-present').addEventListener('click', enterPresentation);
$('pmode').addEventListener('change', (e) => { S.playMode = e.target.value; });
$('seek').addEventListener('pointerdown', () => { seeking = true; });
$('seek').addEventListener('pointerup', () => { seeking = false; });
$('seek').addEventListener('input', (e) => {
  const t = (Number(e.target.value) / 1000) * src.duration;
  $('tcur').textContent = fmtTime(t);
  seek(t);
});

let dragDepth = 0;
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true; });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  handleFile(e.dataTransfer.files[0]);
});

// Only fields you actually type into keep their keys. Checkboxes, sliders,
// dropdowns and buttons do not, which is what used to swallow the space bar.
const TYPING_INPUTS = new Set(['text', 'search', 'email', 'number', 'password', 'url', 'tel']);
function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TYPING_INPUTS.has(el.type);
}

window.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return;
  if (e.code === 'Space') {
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) togglePlay();
    // Drop focus from whatever was clicked last (often the play button itself),
    // otherwise the browser also "presses" it and the toggle cancels out.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  } else if (e.code === 'KeyP' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (presenting) exitPresentation();
    else enterPresentation();
  } else if (e.code === 'Escape' && presenting) {
    exitPresentation();
  }
}, true);

// Buttons and checkboxes activate on keyup, so that has to be stopped too.
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !isTyping(e.target)) e.preventDefault();
}, true);

/* ---------------------------------------------------------------- reset -- */

// A reset is to how it looks, not what it is showing, so these stay put.
const SOURCE_KEYS = ['liveDevice', 'terrainFrom', 'synthDuration', 'synthRange', 'synthRows'];
// Changing any of these means the terrain has to be re-derived, not just reshaped.
const REBUILD_KEYS = ['quality', 'cols', 'fmin', 'fmax', 'scale', 'waterfall', 'windowSec', 'ridges', 'invert'];

let undoSnapshot = null;
let noticeTimer = 0;

function applySettings(next) {
  const rebuild = REBUILD_KEYS.some((k) => S[k] !== next[k]);
  Object.assign(S, next);
  applyLook();
  relief.setRenderScale(S.renderScale);
  relief.setAutoMove(S.autoMove, S.motionSpeed);
  $('pmode').value = S.playMode;
  refreshGui();
  if (rebuild) rebuildTerrain();
  else applyShape();
}

function resetSettings() {
  undoSnapshot = {
    settings: structuredClone(S),
    cam: relief.camera.position.clone(),
    target: relief.controls.target.clone(),
  };
  const next = structuredClone(DEFAULTS);
  for (const k of SOURCE_KEYS) next[k] = S[k];
  // an image keeps its own proportions rather than the default depth
  if (src.kind === 'image' && src.bitmap) {
    next.depth = Math.min(26, Math.max(3, (next.width * src.bitmap.width) / src.bitmap.height));
  }
  applySettings(next);
  relief.setView(S.view);
  showNotice('Settings reset', 'Undo', undoReset);
}

function undoReset() {
  if (!undoSnapshot) return;
  const { settings, cam, target } = undoSnapshot;
  undoSnapshot = null;
  applySettings(settings);
  relief.tween = null;
  relief.camera.position.copy(cam);
  relief.controls.target.copy(target);
  relief.controls.update();
  hideNotice();
}

function showNotice(text, action, fn) {
  const el = $('notice');
  el.querySelector('.txt').textContent = text;
  const btn = el.querySelector('button');
  btn.textContent = action;
  btn.onclick = fn;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideNotice, 6000);
}

function hideNotice() {
  $('notice').hidden = true;
}

/* --------------------------------------------------------- presentation -- */

let presenting = false;
let wakeLock = null;
let cursorTimer = 0;
let hintTimer = 0;

async function acquireWakeLock() {
  // keeps a projector laptop from dimming or sleeping mid-show
  try {
    wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null;
  } catch {
    wakeLock = null;
  }
}

function hideCursorSoon() {
  document.body.classList.remove('cursor-hidden');
  clearTimeout(cursorTimer);
  if (presenting) cursorTimer = setTimeout(() => document.body.classList.add('cursor-hidden'), 2000);
}

async function enterPresentation() {
  if (presenting) return;
  presenting = true;
  hideNotice();
  document.body.classList.add('presenting');
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    /* fullscreen refused (e.g. embedded) -- the UI is still hidden */
  }
  acquireWakeLock();
  const hint = $('present-hint');
  hint.hidden = false;
  hint.classList.remove('fade');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hint.classList.add('fade'), 2200);
  hideCursorSoon();
}

function exitPresentation() {
  if (!presenting) return;
  presenting = false;
  document.body.classList.remove('presenting', 'cursor-hidden');
  clearTimeout(cursorTimer);
  clearTimeout(hintTimer);
  $('present-hint').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// The browser swallows Esc to leave fullscreen, so follow that rather than the key.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) exitPresentation();
});
// A wake lock is dropped whenever the tab is hidden; take it back on return.
document.addEventListener('visibilitychange', () => {
  if (presenting && document.visibilityState === 'visible') acquireWakeLock();
});
window.addEventListener('pointermove', () => {
  if (presenting) hideCursorSoon();
});

/* ----------------------------------------------------------------- go --- */

// Starts empty on purpose: no sample audio is loaded until you give it one.
buildGui();
applyLook();
updateTransportEnabled();
showEmpty(true);

// Test hook: drives the app without going through file dialogs.
window.__app = {
  handleFile,
  synthesize,
  loadDemo,
  togglePlay,
  requestAnalysis,
  seek,
  autoSlices,
  resetSettings,
  undoReset,
  enterPresentation,
  exitPresentation,
  get presenting() { return presenting; },
  startLive,
  stopLive,
  live,
  S,
  relief,
  get dims() { return dataDims; },
  get src() { return src; },
};
