/* ============================================================
   main.js — wires the map, the scanner, and the sonifier
   ============================================================ */

import { scanView } from './elevation.js';
import { terrainToAudioBuffer, encodeWav } from './sonify.js';

const $ = id => document.getElementById(id);

// Working grid: enough detail to hear ridgelines, cheap to synthesize.
const COLS = 420;   // time steps west → east
const ROWS = 110;   // oscillators north → south

/* ---------------- the map ---------------- */

// Start over the Alps — instant mountains.
const map = L.map('map', { worldCopyJump: true, zoomControl: true })
  .setView([46.4, 9.8], 9);

// --- three stacked layers so you can SEE the terrain before scanning ---

// 1. Dark base (land/water shapes, no text).
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

// 2. Shaded relief — the actual mountains — screened onto the dark base
//    so ridges and valleys glow through without washing the map flat.
map.createPane('hillshade');
const hsPane = map.getPane('hillshade');
hsPane.style.zIndex = 250;
hsPane.style.mixBlendMode = 'screen';
hsPane.style.pointerEvents = 'none';
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
  pane: 'hillshade',
  maxNativeZoom: 16,
  maxZoom: 19,
  opacity: 0.55,
  attribution: 'Hillshade &copy; <a href="https://www.esri.com/">Esri</a>',
}).addTo(map);

// 3. City names, roads, and borders on top, so they stay readable.
map.createPane('labels');
const lblPane = map.getPane('labels');
lblPane.style.zIndex = 350;
lblPane.style.pointerEvents = 'none';
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
  pane: 'labels',
  subdomains: 'abcd',
  maxZoom: 19,
  attribution: 'elevation <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen/AWS</a>',
}).addTo(map);

// Move the zoom buttons out from under our panel.
map.zoomControl.setPosition('bottomright');

/* ---------------- status helper ---------------- */

const statusEl = $('status');
function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  statusEl.classList.remove('hidden');
}
function hideStatus() { statusEl.classList.add('hidden'); }

/* ---------------- scan ---------------- */

let scan = null;        // { grid, cols, rows, minElev, maxElev }
let scanStale = false;  // map moved since the scan → hide the map sweep

$('scan-btn').addEventListener('click', async () => {
  stopPlayback();
  try {
    scan = await scanView(map, COLS, ROWS, showStatus);
    scanStale = false;
    hideStatus();
    $('result').classList.remove('hidden');
    const lo = Math.round(scan.minElev), hi = Math.round(scan.maxElev);
    $('elev-stats').textContent = `elevation ${lo} m … ${hi} m`;
    rebuildAudio();     // synthesize + paint preview
  } catch (err) {
    showStatus(`Scan failed (${err.message}). Are you online?`, true);
    setTimeout(hideStatus, 4000);
  }
});

map.on('movestart', () => { scanStale = true; });

/* ---------------- synthesis + preview ---------------- */

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let rendered = null;    // { buffer, amps }
let dirty = false;      // params changed while playing → rebuild on play

function synthParams() {
  return {
    duration: parseFloat($('duration').value),
    minFreq: parseFloat($('lowfreq').value),
    contrast: parseFloat($('contrast').value),
    seaSilent: $('sea-silent').checked,
  };
}

function rebuildAudio() {
  if (!scan) return;
  rendered = terrainToAudioBuffer(
    scan.grid, scan.cols, scan.rows, scan.minElev, scan.maxElev,
    audioCtx, synthParams());
  dirty = false;
  paintPreview(rendered.amps);
}

/* Paint the loudness grid, cyan-on-navy — what you'll hear is what you see. */
function paintPreview(amps) {
  const cv = $('preview');
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(scan.cols, scan.rows);
  for (let i = 0; i < amps.length; i++) {
    const v = amps[i];
    img.data[i * 4]     = Math.round(v * 0x58);
    img.data[i * 4 + 1] = Math.round(v * 0xc6);
    img.data[i * 4 + 2] = Math.round(v * 0x9d);
    img.data[i * 4 + 3] = 255;
  }
  // Draw at grid size on a temp canvas, then stretch onto the preview.
  const tmp = document.createElement('canvas');
  tmp.width = scan.cols;
  tmp.height = scan.rows;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(tmp, 0, 0, cv.width, cv.height);
}

/* ---------------- playback + sweep line ---------------- */

let source = null;
let playStart = 0;
let raf = 0;

function stopPlayback() {
  if (source) {
    source.onended = null;
    try { source.stop(); } catch (_) {}
    source = null;
  }
  cancelAnimationFrame(raf);
  $('playhead').classList.add('hidden');
  $('play-btn').textContent = 'Play the terrain';
  $('play-btn').classList.remove('playing');
}

$('play-btn').addEventListener('click', () => {
  if (source) { stopPlayback(); return; }
  if (!rendered || dirty) rebuildAudio();
  if (!rendered) return;

  if (audioCtx.state === 'suspended') audioCtx.resume();
  source = audioCtx.createBufferSource();
  source.buffer = rendered.buffer;
  source.connect(audioCtx.destination);
  source.onended = stopPlayback;
  source.start();
  playStart = audioCtx.currentTime;

  $('play-btn').textContent = 'Stop';
  $('play-btn').classList.add('playing');
  if (!scanStale) $('playhead').classList.remove('hidden');
  sweep();
});

function sweep() {
  if (!source) return;
  const t = (audioCtx.currentTime - playStart) / rendered.buffer.duration;
  // Line sweeps the window west → east (the scan was this exact view).
  if (!scanStale) {
    $('playhead').style.left = `${Math.min(t, 1) * window.innerWidth}px`;
  } else {
    $('playhead').classList.add('hidden');
  }
  raf = requestAnimationFrame(sweep);
}

/* ---------------- hand off to Audio Terrain ----------------
   A page can't carry a file across navigation, so we park the WAV
   in IndexedDB and the terrain tool picks it up on arrival. */

function stashForTerrain(blob) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('soundlab', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handoff');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('handoff', 'readwrite');
      tx.objectStore('handoff').put(blob, 'earth-audio');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

$('explore-btn').addEventListener('click', async () => {
  if (!rendered || dirty) rebuildAudio();
  if (!rendered) return;
  showStatus('Opening in Audio Terrain...');
  try {
    const wav = encodeWav(rendered.buffer.getChannelData(0), audioCtx.sampleRate);
    await stashForTerrain(wav);
    location.href = '../terrain/?from=earth';
  } catch (err) {
    showStatus(`Could not hand the sound over (${err.message})`, true);
    setTimeout(hideStatus, 4000);
  }
});

/* ---------------- download ---------------- */

$('download-btn').addEventListener('click', () => {
  if (!rendered || dirty) rebuildAudio();
  if (!rendered) return;
  const wav = encodeWav(rendered.buffer.getChannelData(0), audioCtx.sampleRate);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(wav);
  a.download = 'hear-the-earth.wav';
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------------- controls ---------------- */

function bindSlider(id, valId, fmt) {
  const el = $(id);
  const val = $(valId);
  const update = () => { val.textContent = fmt(parseFloat(el.value)); dirty = true; };
  el.addEventListener('input', update);
  val.textContent = fmt(parseFloat(el.value));
}

bindSlider('duration', 'dur-val', v => `${Math.round(v)} s`);
bindSlider('lowfreq', 'lowf-val', v => `${Math.round(v)} Hz`);
bindSlider('contrast', 'contrast-val', v => v.toFixed(2).replace(/0$/, ''));
$('sea-silent').addEventListener('change', () => { dirty = true; });

// Debug handle
window.__earth = { map, get scan() { return scan; }, get rendered() { return rendered; } };
