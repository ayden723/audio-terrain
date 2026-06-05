/* ============================================================
   main.js — the conductor: scene setup + wiring the UI together
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { AudioEngine } from './audio.js';
import { computeSpectrogram } from './spectrogram.js';
import { Terrain } from './terrain.js';
import { Waterfall } from './waterfall.js';
import { PrintModel } from './printmodel.js';
import { createAtmosphere } from './atmosphere.js';

/* ---------- Grab UI elements ---------- */
const canvas      = document.getElementById('scene');
const dropHint    = document.getElementById('drop-hint');
const statusEl    = document.getElementById('status');
const transport   = document.getElementById('transport');
const playBtn     = document.getElementById('play-btn');
const seek        = document.getElementById('seek');
const timeCurrent = document.getElementById('time-current');
const timeTotal   = document.getElementById('time-total');
const fileInput   = document.getElementById('file-input');
const fileInput2  = document.getElementById('file-input-2');
const paletteSel  = document.getElementById('palette');
const modeSel     = document.getElementById('mode');
const printPanel  = document.getElementById('print-panel');
const sizeRange   = document.getElementById('print-size');
const smoothRange = document.getElementById('print-smooth');
const sizeVal     = document.getElementById('print-size-val');
const smoothVal   = document.getElementById('print-smooth-val');
const printDims   = document.getElementById('print-dims');
const exportBtn   = document.getElementById('print-export');

/* ---------- Three.js scene ---------- */
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x05060f, 240, 480);

const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.1, 4000
);
camera.position.set(150, 120, 200);

const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance',
});
// Cap pixel ratio: 2 on desktop, 1.5 on phones (mobile GPUs + bloom).
function pixelCap() {
  const small = window.innerWidth < 768 ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  return small ? 1.5 : 2;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelCap()));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // filmic, graded colors
renderer.toneMappingExposure = 1.05;

/* ---------- Post-processing: bloom ---------- */
const renderTarget = new THREE.WebGLRenderTarget(
  window.innerWidth, window.innerHeight, { samples: 2 } // light MSAA
);
const composer = new EffectComposer(renderer, renderTarget);
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.85,  // strength
  0.55,  // radius
  0.55   // threshold: only bright crests/marker glow
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;       // smooth, natural motion
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.6;
controls.zoomSpeed = 0.9;
controls.minDistance = 60;
controls.maxDistance = 600;
controls.maxPolarAngle = Math.PI * 0.495; // don't drop below the terrain
controls.target.set(0, 6, 0);

/* ---------- Lighting (atmospheric, colored) ---------- */
scene.add(new THREE.AmbientLight(0x2a3170, 0.6));

const key = new THREE.DirectionalLight(0xfff4e0, 1.15);
key.position.set(120, 180, 80);
scene.add(key);

const rim = new THREE.DirectionalLight(0x6a4fd6, 0.7);
rim.position.set(-140, 60, -120);
scene.add(rim);

const hemi = new THREE.HemisphereLight(0x88aaff, 0x05060f, 0.35);
scene.add(hemi);

/* ---------- Atmosphere (gradient sky + particles) ---------- */
const atmosphere = createAtmosphere(scene);

/* ---------- App objects ---------- */
const audio = new AudioEngine();
const terrain = new Terrain(scene);
const waterfall = new Waterfall(scene);
const printModel = new PrintModel(scene);
let hasTrack = false;
let mode = 'landscape';  // 'landscape' | 'waterfall' | 'print'

audio.onEnded = () => {
  // In waterfall mode, loop seamlessly: keep the existing scroll going and
  // just restart the audio, so new frames flow in without blanking out.
  if (mode === 'waterfall' && hasTrack) {
    audio.play();
    transport.classList.add('playing');
    seek.value = 0;
    timeCurrent.textContent = formatTime(0);
    return;
  }
  // Landscape mode: stop and reset to the start.
  transport.classList.remove('playing');
  terrain.setProgress(0);
  seek.value = 0;
  timeCurrent.textContent = formatTime(0);
};

/* ---------- File loading ---------- */
async function handleFile(file) {
  if (!file) return;
  showStatus(`Decoding “${file.name}” …`);
  try {
    const buffer = await audio.load(file);
    showStatus('Building terrain …');
    await new Promise(r => setTimeout(r, 30)); // let the status paint

    const spec = computeSpectrogram(buffer);
    terrain.build(spec, buffer.duration);
    waterfall.reset(audio.sampleRate, audio.analyser.frequencyBinCount);
    printModel.build(spec, file.name);

    hasTrack = true;
    dropHint.classList.add('hidden');
    hideStatus();
    transport.classList.remove('hidden');
    transport.classList.remove('playing');

    seek.value = 0;
    timeCurrent.textContent = formatTime(0);
    timeTotal.textContent = formatTime(buffer.duration);

    applyMode();
  } catch (err) {
    console.error(err);
    showStatus(`Could not load this file. ${err.message || ''}`, true);
  }
}

/* ---------- View / mode handling ---------- */
function frameView(size) {
  const span = Math.max(size.WIDTH, size.DEPTH);
  camera.position.set(span * 0.32, Math.max(140, span * 0.34), span * 0.78 + 120);
  camera.far = span * 4 + 1500;
  camera.updateProjectionMatrix();

  controls.target.set(0, 12, 0);
  controls.maxDistance = span * 2.5 + 400;
  controls.update();

  scene.fog.near = span * 0.6 + 140;
  scene.fog.far  = span * 2.2 + 500;
}

function applyMode() {
  terrain.setVisible(mode === 'landscape');
  waterfall.setVisible(mode === 'waterfall');
  printModel.setVisible(mode === 'print');

  if (mode === 'waterfall') waterfall.reset(); // start the live view fresh
  printPanel.classList.toggle('hidden', mode !== 'print');
  if (mode === 'print') updatePrintReadout();

  const size = mode === 'waterfall' ? waterfall.size
             : mode === 'print'     ? printModel.size
             : terrain.size;
  frameView(size);
}

function updatePrintReadout() {
  const d = printModel.dims;
  if (d) {
    printDims.textContent =
      `${d.w.toFixed(0)} × ${d.d.toFixed(0)} × ${d.h.toFixed(0)} mm · ` +
      `${(printModel.triangleCount / 1000).toFixed(0)}k triangles`;
  }
}

modeSel.addEventListener('change', () => {
  mode = modeSel.value;
  applyMode();
});

/* ---------- Transport wiring ---------- */
playBtn.addEventListener('click', () => {
  if (!hasTrack) return;
  audio.toggle();
  transport.classList.toggle('playing', audio.playing);
});

seek.addEventListener('input', () => {
  if (!hasTrack) return;
  const t = (seek.value / 1000) * audio.duration;
  audio.seek(t);
  if (mode === 'landscape') terrain.setProgress(seek.value / 1000, 0.5);
  timeCurrent.textContent = formatTime(t);
  transport.classList.toggle('playing', audio.playing);
});

/* Color mode selector — recolor both views */
paletteSel.addEventListener('change', () => {
  terrain.setPalette(paletteSel.value);
  waterfall.setPalette(paletteSel.value);
});

/* Print-model controls */
sizeRange.addEventListener('input', () => {
  sizeVal.textContent = `${sizeRange.value} mm`;
  printModel.setSize(parseFloat(sizeRange.value));
  frameView(printModel.size);
  updatePrintReadout();
});
smoothRange.addEventListener('input', () => {
  smoothVal.textContent = smoothRange.value;
  printModel.setSmoothing(parseFloat(smoothRange.value));
  updatePrintReadout();
});
exportBtn.addEventListener('click', () => printModel.exportSTL());

/* ---------- File inputs + drag & drop ---------- */
fileInput.addEventListener('change', e => handleFile(e.target.files[0]));
fileInput2.addEventListener('change', e => handleFile(e.target.files[0]));

window.addEventListener('dragover', e => {
  e.preventDefault();
  if (!hasTrack) dropHint.classList.add('dragover');
});
window.addEventListener('dragleave', e => {
  if (e.target === document.documentElement) dropHint.classList.remove('dragover');
});
window.addEventListener('drop', e => {
  e.preventDefault();
  dropHint.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

/* ---------- Status helpers ---------- */
function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
  statusEl.classList.toggle('error', isError);
}
function hideStatus() { statusEl.classList.add('hidden'); }

function formatTime(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

/* ---------- Resize ---------- */
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelCap()));
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

/* Sync app state to whatever the dropdowns currently show (covers the
   case where the browser restores previous selections after a reload). */
mode = modeSel.value || 'landscape';
terrain.setPalette(paletteSel.value);
waterfall.setPalette(paletteSel.value);

/* ---------- Render loop ---------- */
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  atmosphere.update();

  if (hasTrack && audio.playing) {
    const t = audio.getTime();
    const p = t / audio.duration;

    if (mode === 'landscape') {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
      terrain.setProgress(p, pulse);
    } else {
      waterfall.pushFrame(audio.getFrequencyData());
    }

    seek.value = Math.round(p * 1000);
    timeCurrent.textContent = formatTime(t);
  }

  composer.render();
}
animate();
