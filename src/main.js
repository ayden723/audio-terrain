import GUI from 'lil-gui';
import { Relief } from './relief.js';
import { PRESETS, DEFAULT_STOPS } from './presets.js';
import { makeDemo } from './demo.js';
import { imageLevels, imagePixels } from './shape.js';
import { encodeWav } from './wav.js';
import { LiveInput } from './live.js';
import { scramble } from './shared/scramble.js';
import { wipeIn, wipeLink } from './shared/wipe.js';
import { initExplain } from './explain.js';

wipeIn();

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
let drawing = false; // the draw-in keeps the loading line up after the work is done
function setBusy(on, label) {
  busy = Math.max(0, busy + (on ? 1 : -1));
  const el = $('loading');
  el.hidden = busy === 0 && !drawing;
  if (label) el.querySelector('.lbl').textContent = label;
  if (busy === 0 && !drawing) el.querySelector('.bar i').style.width = '0%';
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
  if (m.type === 'progress') { job.onProgress?.(m.value, m); return; }
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
  // One slice per drawn ridge: each ridge then shows the average of exactly its
  // own stretch of time. Analysing more slices than ridges only aliased.
  return Math.max(24, Math.round(S.ridges));
}

const analysisParams = (s, slices) => ({
  slices, cols: s.cols, fmin: s.fmin, fmax: s.fmax, scale: s.scale, quality: s.quality,
});
const shapeParams = (s) => ({
  tilt: s.tilt, smoothF: s.smooth, smoothT: s.smooth * 0.3, range: s.range, cut: s.cut, gamma: s.gamma,
});

let analyzing = false;
let analyzeQueued = false;

async function requestAnalysis() {
  if (!src.audioBuffer) return;
  if (analyzing) { analyzeQueued = true; return; }
  analyzing = true;
  setBusy(true, 'Analysing…');
  try {
    const r = await call(
      { type: 'analyze', params: analysisParams(S, autoSlices()) },
      [],
      (v, m) => {
        setProgress(v);
        if (m.size) $('loading').querySelector('.lbl').textContent = `Analysing · ${m.size}-point FFT`;
      }
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

// A newly loaded source draws itself in, ridge by ridge, nearest first. Later
// reshapes (dragging a slider) update in place instead.
let introPending = false;

async function drawIn() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = $('loading');
  const bar = el.querySelector('.bar i');
  drawing = true;
  el.hidden = false;
  el.querySelector('.lbl').textContent = `Drawing ${relief.disp.ridges} ridges`;
  bar.style.width = '0%';
  const done = relief.playIntro();
  const tick = () => {
    if (!relief.intro) return;
    bar.style.width = `${Math.round(relief.intro.progress * 100)}%`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await done;
  drawing = false;
  if (busy === 0) {
    el.hidden = true;
    bar.style.width = '0%';
  }
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
    const r = await call({ type: 'shape', params: shapeParams(S) });
    relief.setData(r.heights, dataDims.slices, dataDims.cols);
    if (introPending) { introPending = false; drawIn(); }
  } catch (err) {
    toast(`Shaping failed: ${err.message}`);
  } finally {
    shaping = false;
    if (shapeQueued) { shapeQueued = false; applyShape(); }
  }
}

/* ------------------------------------------------------------- auto-fit -- */

// The settings the auto-fit may change. Everything else stays as you set it.
const FIT_KEYS = ['ridges', 'depth', 'view'];

// Geometry a source chose for itself rather than you: `source` is 'audio' (the
// fit below) or 'image' (depth from the picture's proportions). `base` holds the
// values it replaced and `owned` the keys it still controls; a key you change by
// hand stops being owned, so it is never overridden. Switching source hands the
// owned keys back, so neither an image's shape nor a song's fit leaks into the
// next file or into live input.
let fit = null;

const pickKeys = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/** Seconds of audio the terrain shows at once. */
function visibleSpan(settings = S) {
  if (!src.duration) return 0;
  return settings.waterfall ? Math.min(settings.windowSec, src.duration) : src.duration;
}

/**
 * Presentation for a span of audio. Up to ~20 s the defaults already look right.
 * Past that, a fixed ridge count makes each ridge average ever more time and a
 * fixed depth crams the song together, so both grow -- sub-linearly, so that a
 * ten-minute track does not turn into a corridor -- and long spans switch to the
 * timeline view, where the song reads left to right.
 */
function fitFor(span, base) {
  const r = Math.max(1, span / 20);
  return {
    ridges: Math.round(Math.min(600, base.ridges * Math.pow(r, 0.22))),
    depth: +Math.min(30, base.depth * Math.pow(r, 0.55)).toFixed(1),
    view: span > 45 ? 'timeline' : base.view,
  };
}

/** Fit the geometry to the loaded audio file. Live input and images are never fitted. */
function applyFit() {
  if (src.kind !== 'audio' || !src.duration) return;
  if (fit && fit.source !== 'audio') releaseFit();
  if (!fit) fit = { source: 'audio', base: pickKeys(S, FIT_KEYS), owned: new Set(FIT_KEYS) };
  if (!fit.owned.size) return;
  const next = fitFor(visibleSpan(), { ...pickKeys(S, FIT_KEYS), ...fit.base });
  for (const k of fit.owned) S[k] = next[k];
  applyLook();
  refreshGui();
  if (fit.owned.has('view')) relief.setView(S.view, false);
  else relief.reframe(false);
}

/** Hand the fitted keys back to their pre-fit values (switching to live or an image). */
function releaseFit() {
  if (!fit) return;
  const restore = pickKeys(fit.base, [...fit.owned]);
  fit = null;
  Object.assign(S, restore);
  applyLook();
  refreshGui();
  relief.setView(S.view, false);
}

/** A setting changed by hand is yours from then on. */
function own(key) {
  if (!fit) return;
  fit.owned.delete(key);
  delete fit.base[key];
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
  applyFit();
  introPending = true;
  requestAnalysis();
}

async function loadAudioFile(file) {
  setBusy(true, `Decoding ${file.name}`);
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
    applyFit();
    syncInert();
    introPending = true;
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
    releaseFit();
    fit = { source: 'image', base: { depth: S.depth }, owned: new Set(['depth']) };
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
    introPending = true;
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
    releaseFit();
    allocLive();
    syncInert();
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
    syncInert();
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

function syncLoop() {
  $('loop').setAttribute('aria-pressed', String(S.loop));
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

/** Shader uniforms for a set of settings: the screen's, or a what-if's. */
function lookUniforms(s) {
  return {
    uBg: s.bg,
    uShadow: s.shadow,
    uHighlight: s.highlight,
    uLine: s.line,
    uAccent: s.accent,
    uStops: s.stops,
    uColorMode: s.colorMode === 'ramp' ? 1 : 0,
    uAmbient: s.ambient,
    uFillMix: s.mode === 'lines' ? 0 : 1,
    uSkirt: s.skirt,
    uLineW: s.lineWidth,
    uLineOpacity: s.lineOpacity,
    uCrestShade: s.crestShade,
    uCrestLen: s.crestLen,
    uBaseFade: s.baseFade,
    uRim: s.rim,
    uShadowStr: s.shadowStr,
    uShadowLen: s.shadowLen,
    uShadowSteps: s.shadowSteps,
    uFog: s.fog,
  };
}

function applyLook() {
  relief.setMode(S.mode);
  relief.setRidges(S.ridges);
  relief.set(lookUniforms(S));
  relief.setReverse(S.reverse);
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

/* ------------------------------------------------------------- what-if -- */

// The explainer card shows a setting's effect by drawing the terrain with that
// one setting changed. These work out what such a drawing needs.

const ANALYSIS_KEYS = ['quality', 'cols', 'fmin', 'fmax', 'scale'];
const SHAPE_KEYS = ['tilt', 'smooth', 'range', 'cut', 'gamma'];
// Everything Lines mode paints over with the background colour.
const SHADING_KEYS = ['colorMode', 'shadow', 'ambient', 'shadowStr', 'crestShade', 'lightAz', 'lightEl'];
const PITCH_KEYS = ['fmin', 'fmax', 'scale'];
const PREVIEW_MAX_SLICES = 512;

const fromPixels = () => src.kind === 'image' && S.terrainFrom === 'Image pixels';

/** Why a setting changes nothing right now, or null when it does. */
function inertReason(key) {
  if (S.mode === 'surface' && (key === 'skirt' || key === 'crestShade')) return 'No effect in Surface mode, which has no ribbons.';
  if (S.mode === 'lines' && SHADING_KEYS.includes(key)) return 'No effect in Lines mode, which draws no shading.';
  if (key === 'motionSpeed' && !S.autoMove) return 'Only used while Auto move is on.';
  if (key === 'windowSec' && !S.waterfall && src.kind !== 'live') return 'Only used while Scroll with audio is on, or with live input.';
  if (key === 'waterfall' && src.kind === 'live') return 'Live input always scrolls.';
  if (fromPixels()) {
    if (['range', 'tilt', 'quality'].includes(key)) return 'No effect on terrain built from image pixels.';
    if (PITCH_KEYS.includes(key)) return 'With image pixels this changes the sound, not the terrain.';
  }
  return null;
}

/** Grey out whatever does nothing right now. Pitch still shapes an image's sound, so it stays live. */
function syncInert() {
  gui?.controllersRecursive().forEach((c) => {
    c.enable(PITCH_KEYS.includes(c.property) || !inertReason(c.property));
  });
}

function canPreview(key) {
  if (!src.kind) return true;
  if (!dataDims) return false;
  // live input is shaped as it arrives and then forgotten, so it cannot be redone
  if (src.kind === 'live') return !ANALYSIS_KEYS.includes(key) && !SHAPE_KEYS.includes(key);
  return true;
}

let specimenSent = false;

/**
 * Heights for the settings `s`, when `changed` is something only the worker can
 * answer. Null means the texture already on screen will do.
 */
function whatIfHeights(s, changed) {
  const shape = shapeParams(s);
  if (!src.kind) {
    // nothing loaded: show the effect on the built-in demo instead
    if (!specimenSent) {
      const { samples, sampleRate } = makeDemo();
      worker.postMessage({ type: 'setSpecimen', samples, sampleRate }, [samples.buffer]);
      specimenSent = true;
    }
    return call({ type: 'preview', specimen: true, analysis: analysisParams(s, Math.max(24, Math.round(s.ridges))), shape });
  }
  if (src.kind === 'live') return null;
  if (fromPixels()) {
    if (changed === 'cols' || changed === 'invert') {
      const values = imageLevels(src.bitmap, dataDims.slices, s.cols, s.invert);
      return call({ type: 'preview', levels: { values, slices: dataDims.slices, cols: s.cols }, shape }, [values.buffer]);
    }
  } else if (ANALYSIS_KEYS.includes(changed)) {
    const slices = Math.min(dataDims.slices, PREVIEW_MAX_SLICES);
    return call({ type: 'preview', analysis: analysisParams(s, slices), shape });
  }
  if (SHAPE_KEYS.includes(changed)) return call({ type: 'preview', shape });
  return null;
}

/** Draw the terrain as it would look with one setting changed. Resolves to whether it could. */
async function renderWhatIf(canvas, key, value, spec) {
  const preset = key === 'preset' && PRESETS[value];
  const s = { ...S, ...(preset ? { ...preset, stops: preset.stops || DEFAULT_STOPS } : { [key]: value }), ...spec.also };
  try {
    const r = await whatIfHeights(s, key);
    return relief.snapshot(canvas, {
      uniforms: lookUniforms(s),
      heights: r && { data: r.heights, slices: r.slices, cols: r.cols },
      mode: s.mode,
      ridges: s.ridges,
      dims: { W: s.width, H: s.height, D: s.depth },
      light: [s.lightAz, s.lightEl],
      reverse: s.reverse,
      view: key === 'view' ? value : null,
      reframe: spec.reframe,
      zoom: spec.zoom,
      play: spec.play,
    });
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- GUI -- */

let gui;
let imgControllers = [];
let stopCtrl = null;
let deviceCtrl = null;
let presetCtrl = null;

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
  syncInert();
}

// An image's sound is built from these, so changing one rebuilds the sound too;
// otherwise the terrain and what you hear drift apart.
function invertChanged() {
  if (fromPixels()) buildImageTerrain();
  synthesize();
}
function pitchChanged() {
  if (src.kind === 'image') synthesize();
  else rebuildTerrain();
}

// Everything a preset sets. Changing one by hand means the look is no longer that preset.
const PRESET_KEYS = new Set(Object.values(PRESETS).flatMap(Object.keys));
let explain = null;

function onGuiChange(e) {
  if (PRESET_KEYS.has(e.property) && S.preset !== 'Custom') {
    S.preset = 'Custom';
    presetCtrl.updateDisplay();
  }
  syncInert();
  explain?.changed(e.controller);
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
    fSrc.add(S, 'invert').name('Invert image').onChange(invertChanged),
    fSrc.add(S, 'terrainFrom', ['Image pixels', 'Synthesized audio']).name('Terrain from').onChange(() => { rebuildTerrain(); syncInert(); }),
    fSrc.add(S, 'synthDuration', 2, 60, 0.5).name('Audio length (s)').onFinishChange(synthesize),
    fSrc.add({ d: downloadWav }, 'd').name('Download WAV'),
  ];
  showImageControls(false);

  const fLook = gui.addFolder('Look');
  presetCtrl = fLook.add(S, 'preset', Object.keys(PRESETS)).name('Preset').onChange(applyPreset);
  fLook.add(S, 'mode', { Ridges: 'ridges', Lines: 'lines', Surface: 'surface' }).name('Render mode').onChange(applyLook);
  fLook.add(S, 'ridges', 24, 600, 1).name('Ridge count').onChange(() => { own('ridges'); applyLook(); }).onFinishChange(maybeReanalyze);
  fLook.add(S, 'skirt', 0, 1.2, 0.01).name('Ridge depth').onChange(applyLook);
  fLook.add(S, 'height', 0.2, 9, 0.05).name('Height').onChange(applyLook);
  fLook.add(S, 'smooth', 0, 8, 0.1).name('Smoothing').onChange(applyShape);
  fLook.add(S, 'range', 20, 120, 1).name('Quiet detail (dB)').onChange(applyShape);
  fLook.add(S, 'gamma', 0.3, 3, 0.01).name('Contrast').onChange(applyShape);

  const fFall = gui.addFolder('Waterfall');
  fFall.add(S, 'waterfall').name('Scroll with audio').onChange(() => { applyFit(); rebuildTerrain(); });
  fFall.add(S, 'windowSec', 0.5, 30, 0.5).name('Window (s)').onFinishChange(() => { if (S.waterfall) applyFit(); maybeReanalyze(); });

  const fCam = gui.addFolder('Camera');
  fCam.add(S, 'view', {
    Reference: 'reference', Timeline: 'timeline', Front: 'front', Side: 'side', 'Low angle': 'low', 'Top down': 'top',
  }).name('View').onChange((v) => { own('view'); relief.setView(v); });
  fCam.add(S, 'autoMove').name('Auto move').onChange((v) => relief.setAutoMove(v, S.motionSpeed));
  fCam.add(S, 'motionSpeed', 0.25, 3, 0.05).name('Motion speed').onChange((v) => relief.setAutoMove(S.autoMove, v));

  const fAdv = gui.addFolder('Advanced');

  const fAna = fAdv.addFolder('Analysis');
  fAna.add(S, 'quality', { Standard: 'standard', High: 'high', 'Ultra (slow)': 'ultra' }).name('Analysis quality').onChange(rebuildTerrain);
  fAna.add(S, 'cols', 128, 2048, 16).name('Frequency detail').onFinishChange(rebuildTerrain);
  fAna.add(S, 'fmin', 10, 500, 1).name('Min Hz').onFinishChange(pitchChanged);
  fAna.add(S, 'fmax', 1000, 22050, 100).name('Max Hz').onFinishChange(pitchChanged);
  fAna.add(S, 'scale', { Logarithmic: 'log', Mel: 'mel', Linear: 'linear' }).name('Frequency scale').onChange(pitchChanged);

  const fShape = fAdv.addFolder('Shape');
  fShape.add(S, 'tilt', -6, 9, 0.1).name('Treble lift (dB/oct)').onChange(applyShape);
  fShape.add(S, 'cut', 0, 0.6, 0.005).name('Noise cut').onChange(applyShape);
  fShape.add(S, 'width', 3, 24, 0.1).name('Width').onChange(applyLook).onFinishChange(() => relief.reframe());
  fShape.add(S, 'depth', 2, 40, 0.1).name('Depth').onChange(() => { own('depth'); applyLook(); }).onFinishChange(() => relief.reframe());
  fShape.add(S, 'reverse').name('Reverse time').onChange(applyLook);

  const fCol = fAdv.addFolder('Colour & light');
  fCol.add(S, 'colorMode', { 'Lit relief': 'lit', 'Colour ramp': 'ramp' }).name('Shading').onChange(applyLook);
  fCol.addColor(S, 'bg').name('Background').onChange(applyLook);
  fCol.addColor(S, 'shadow').name('Shadow').onChange(applyLook);
  fCol.addColor(S, 'highlight').name('Highlight').onChange(applyLook);
  fCol.addColor(S, 'line').name('Lines').onChange(applyLook);
  fCol.addColor(S, 'accent').name('Playhead').onChange(applyLook);
  fCol.add(S, 'lineOpacity', 0, 1, 0.01).name('Line strength').onChange(applyLook);
  fCol.add(S, 'crestShade', 0, 1, 0.01).name('Crest shading').onChange(applyLook);
  fCol.add(S, 'shadowStr', 0, 1, 0.01).name('Cast shadows').onChange(applyLook);
  fCol.add(S, 'rim', 0, 0.6, 0.01).name('Rim light').onChange(applyLook);
  fCol.add(S, 'fog', 0, 1, 0.01).name('Depth fade').onChange(applyLook);
  fCol.add(S, 'ambient', 0, 1, 0.01).name('Ambient light').onChange(applyLook);
  fCol.add(S, 'lightAz', -180, 179, 1).name('Light angle').onChange(applyLook);
  fCol.add(S, 'lightEl', 2, 88, 1).name('Light height').onChange(applyLook);
  fCol.add(S, 'grain').name('Paper grain').onChange(applyLook);
  fCol.add(S, 'renderScale', 0.5, 2, 0.25).name('Render quality').onChange((v) => relief.setRenderScale(v));

  const fSyn = fAdv.addFolder('Image synthesis');
  fSyn.add(S, 'synthRange', 20, 90, 1).name('Synth dynamics (dB)').onFinishChange(synthesize);
  fSyn.add(S, 'synthRows', 128, 1024, 32).name('Synth partials').onFinishChange(synthesize);
  fSyn.add({ s: synthesize }, 's').name('Re-synthesize audio');

  // on a phone the open panel would cover the terrain it controls
  if (window.matchMedia('(max-width: 640px)').matches) gui.close();
  gui.onChange(onGuiChange);

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
$('loop').addEventListener('click', () => { S.loop = !S.loop; syncLoop(); });
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
  const resynth = src.kind === 'image' && ['invert', ...PITCH_KEYS].some((k) => S[k] !== next[k]);
  Object.assign(S, next);
  applyLook();
  relief.setRenderScale(S.renderScale);
  relief.setAutoMove(S.autoMove, S.motionSpeed);
  $('pmode').value = S.playMode;
  syncLoop();
  refreshGui();
  if (rebuild) rebuildTerrain();
  else applyShape();
  if (resynth) synthesize();
}

function resetSettings() {
  undoSnapshot = {
    fit: fit && { source: fit.source, base: { ...fit.base }, owned: [...fit.owned] },
    settings: structuredClone(S),
    cam: relief.camera.position.clone(),
    target: relief.controls.target.clone(),
  };
  const next = structuredClone(DEFAULTS);
  for (const k of SOURCE_KEYS) next[k] = S[k];
  // an image keeps its own proportions rather than the default depth
  fit = null;
  if (src.kind === 'image' && src.bitmap) {
    fit = { source: 'image', base: { depth: next.depth }, owned: new Set(['depth']) };
    next.depth = Math.min(26, Math.max(3, (next.width * src.bitmap.width) / src.bitmap.height));
  }
  if (src.kind === 'audio' && src.duration) {
    fit = { source: 'audio', base: pickKeys(next, FIT_KEYS), owned: new Set(FIT_KEYS) };
    Object.assign(next, fitFor(visibleSpan(next), fit.base));
  }
  applySettings(next);
  relief.setView(S.view);
  showNotice('Settings reset', 'Undo', undoReset);
}

function undoReset() {
  if (!undoSnapshot) return;
  const { settings, cam, target, fit: savedFit } = undoSnapshot;
  undoSnapshot = null;
  fit = savedFit && { source: savedFit.source, base: savedFit.base, owned: new Set(savedFit.owned) };
  applySettings(settings);
  relief.setView(S.view, false); // restores the view's time direction before the camera
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

// Level-meter scramble on the top bar's labels
scramble(document.querySelector('.brand-txt'), document.querySelector('.brand'));
scramble($('btn-open'));
scramble($('btn-reset'));
scramble($('btn-present'));
wipeLink(document.querySelector('.brand'));

// Starts empty on purpose: no sample audio is loaded until you give it one.
buildGui();
explain = initExplain({ gui, panel: $('panel'), card: $('explain'), hint: $('hint'), inert: inertReason, canPreview, render: renderWhatIf });
applyLook();
syncInert();
syncLoop();
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
  applyFit,
  fitFor,
  get fit() { return fit; },
  get gui() { return gui; },
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
