import GUI from 'lil-gui';
import { Relief } from './relief.js';
import { PRESETS, DEFAULT_STOPS } from './presets.js';
import { makeDemo } from './demo.js';
import { imageLevels, imagePixels } from './shape.js';
import { encodeWav } from './wav.js';

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
  preset: 'Sepia Paper',
  ...PRESETS['Sepia Paper'],
  stops: DEFAULT_STOPS.slice(),
  shadowLen: 1.4,
  shadowSteps: 8,
  renderScale: 1,
  autoRotate: false,
  view: 'reference',
  // image
  invert: false,
  terrainFrom: 'Image pixels',
  synthDuration: 12,
  synthRange: 55,
  synthRows: 512,
  // playback
  playMode: 'cursor',
};

const src = { kind: null, name: '', bitmap: null, audioBuffer: null, wavBlob: null, duration: 0 };
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
  if (src.kind === 'image' && S.terrainFrom === 'Image pixels') buildImageTerrain();
  else requestAnalysis();
}

// Shaping runs in the worker against the resident matrix, so dragging a slider
// never blocks the main thread and nothing large is copied between them.
let shaping = false;
let shapeQueued = false;

async function applyShape() {
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

function loadDemo() {
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

function refreshGui() {
  gui?.controllersRecursive().forEach((c) => c.updateDisplay());
}
function showImageControls(show) {
  imgControllers.forEach((c) => (show ? c.show() : c.hide()));
}

/** Ridge count and window size feed autoSlices(), so they can need a re-analysis. */
function maybeReanalyze() {
  if (S.waterfall) rebuildTerrain();
}

function buildGui() {
  gui = new GUI({ container: $('panel'), title: 'Controls' });

  const fSrc = gui.addFolder('Source');
  fSrc.add({ open: () => $('file').click() }, 'open').name('Open audio / image…');
  fSrc.add({ demo: loadDemo }, 'demo').name('Load demo audio');
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
  fCam.add(S, 'autoRotate').name('Auto rotate').onChange((v) => { relief.controls.autoRotate = v; });

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
$('btn-demo').addEventListener('click', loadDemo);
$('play').addEventListener('click', togglePlay);
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

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/input|select|textarea/i.test(e.target.tagName)) {
    e.preventDefault();
    togglePlay();
  }
});

/* ----------------------------------------------------------------- go --- */

buildGui();
applyLook();
updateTransportEnabled();
loadDemo();

// Test hook: drives the app without going through file dialogs.
window.__app = {
  handleFile,
  synthesize,
  loadDemo,
  togglePlay,
  requestAnalysis,
  seek,
  autoSlices,
  S,
  relief,
  get dims() { return dataDims; },
  get src() { return src; },
};
