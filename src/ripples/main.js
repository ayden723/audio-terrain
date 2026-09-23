import GUI from 'lil-gui';
import * as THREE from 'three';
import { RippleSim } from './sim.js';
import { RippleSynth, SCALES, ROOTS, scaleNotes } from './synth.js';
import { PoolScene, LOOKS } from './pool.js';
import { scramble } from '../shared/scramble.js';
import { wipeIn, wipeLink } from '../shared/wipe.js';

wipeIn();

// Tap the water and the ripple rings every buoy it passes. Buoys nearer the
// drop sound first, so where you tap sets the order of the notes, and the
// round wall sends each ring back for a quieter second pass.

const N = 160;
const RADIUS = 0.47;
const STEPS_PER_SEC = 120;

const S = {
  look: 'Ember',
  scale: 'Major pentatonic',
  root: 'D',
  speed: 0.22, // wave speed squared, in grid units per step
  life: 0.993, // energy kept per step
  rain: 1.1, // drops per second while rain is on
  height: 0.05,
  depth: 0.3,
  strength: 1,
  soft: 1.5,
  dispersion: 0.5,
  volume: 0.8,
  reverb: 0.45,
  sensitivity: 4,
};

// One buoy in the middle holds the root; seven more circle it, rising up the
// scale as they go round.
const BUOYS = [{ u: 0.5, v: 0.5 }];
for (let i = 0; i < 7; i++) {
  const a = -Math.PI / 2 + (i / 7) * Math.PI * 2;
  BUOYS.push({ u: 0.5 + 0.26 * Math.cos(a), v: 0.5 + 0.26 * Math.sin(a) });
}
const PANS = BUOYS.map((b) => (b.u - 0.5) * 1.8);

const $ = (id) => document.getElementById(id);
const sim = new RippleSim(N, RADIUS);
const pool = new PoolScene($('view'), { n: N, radius: RADIUS, buoys: BUOYS });
const synth = new RippleSynth();

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
let notes = [];
let noteNames = [];
function retune() {
  notes = scaleNotes(S.scale, S.root, BUOYS.length);
  noteNames = notes.map((f) => {
    const m = Math.round(12 * Math.log2(f / 440)) + 57;
    return `${NAMES[m % 12]}${Math.floor(m / 12)}`;
  });
  synth.setNotes(notes);
}
retune();

/* -------------------------------------------------------------- sound -- */

let rain = true;

function startSound() {
  if (synth.started) return;
  synth.start(notes, PANS);
  synth.setVolume(S.volume);
  synth.setReverb(S.reverb);
  setSoundButton();
}

function setSoundButton() {
  const on = synth.started && !synth.muted;
  const b = $('btn-sound');
  b.textContent = on ? 'Sound on' : 'Sound off';
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
}

function drop(u, v, amount, radius, loud) {
  sim.disturb(u, v, radius, amount);
  synth.plip(loud, (u - 0.5) * 1.8);
}

/* ------------------------------------------------------------ pointer -- */

// A left press on the water plays it; anywhere else (or a right drag) turns the view.
pool.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
let stroke = null;

$('stage').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const hit = pool.pick(e.clientX, e.clientY);
  if (!hit || !sim.isInside(hit.u, hit.v)) return;
  startSound();
  pool.controls.enabled = false; // this press is for the water, not the camera
  $('view').setPointerCapture(e.pointerId);
  drop(hit.u, hit.v, 1.4, 0.016, 1);
  stroke = { id: e.pointerId, u: hit.u, v: hit.v, lastPlip: performance.now() };
}, { capture: true });

$('view').addEventListener('pointermove', (e) => {
  if (!stroke || e.pointerId !== stroke.id) return;
  const hit = pool.pick(e.clientX, e.clientY);
  if (!hit) return;
  // a wake: small pushes along the path, and a quiet plip now and then
  const du = hit.u - stroke.u, dv = hit.v - stroke.v;
  const len = Math.hypot(du, dv);
  const steps = Math.min(40, Math.floor(len / 0.01));
  for (let i = 1; i <= steps; i++) {
    const u = stroke.u + (du * i) / steps, v = stroke.v + (dv * i) / steps;
    if (sim.isInside(u, v)) sim.disturb(u, v, 0.012, 0.22);
  }
  if (steps > 0) { stroke.u = hit.u; stroke.v = hit.v; }
  const now = performance.now();
  if (len > 0.004 && now - stroke.lastPlip > 110 && sim.isInside(hit.u, hit.v)) {
    stroke.lastPlip = now;
    synth.plip(0.35, (hit.u - 0.5) * 1.8);
  }
});

function endStroke(e) {
  if (!stroke || e.pointerId !== stroke.id) return;
  stroke = null;
  pool.controls.enabled = true;
}
$('view').addEventListener('pointerup', endStroke);
$('view').addEventListener('pointercancel', endStroke);

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.target.closest('input, select, textarea, button')) return;
  e.preventDefault();
  startSound();
  const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.38;
  drop(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), 1.4, 0.016, 1);
});

/* -------------------------------------------------------------- frame -- */

const heights = new Float32Array(BUOYS.length);
const slow = new Float32Array(BUOYS.length); // each buoy's recent average height
const levels = new Float32Array(BUOYS.length);
const tilts = new Float32Array(BUOYS.length);
let stepAcc = 0;
let nextRain = 0.4;
let last = performance.now();
let statusShown = '';

pool.onFrame = () => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (rain) {
    nextRain -= dt;
    if (nextRain <= 0) {
      nextRain = -Math.log(1 - Math.random()) / Math.max(0.05, S.rain); // random, averaging S.rain per second
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.42;
      const loud = 0.25 + Math.random() * 0.35;
      drop(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), 0.35 + Math.random() * 0.5, 0.01 + Math.random() * 0.008, loud);
    }
  }

  stepAcc += dt * STEPS_PER_SEC;
  let n = Math.min(6, Math.floor(stepAcc));
  stepAcc -= n;
  while (n-- > 0) sim.step(S.speed, S.life);
  sim.settle();
  pool.upload(sim.cur);

  // Each buoy's level follows how far the water under it is moving away from
  // its recent average: a passing wavefront rings it, slow drift does not.
  const fall = Math.exp(-dt / 0.3);
  const track = 1 - Math.exp(-dt / 0.25);
  const playing = [];
  BUOYS.forEach((b, i) => {
    const h = sim.sample(b.u, b.v);
    heights[i] = h;
    slow[i] += (h - slow[i]) * track;
    const target = Math.min(1, Math.max(0, Math.abs(h - slow[i]) * S.sensitivity - 0.08));
    levels[i] = Math.max(levels[i] * fall, target);
    tilts[i] = Math.max(-1, Math.min(1, (sim.sample(b.u + 0.01, b.v) - sim.sample(b.u - 0.01, b.v)) * 6));
    if (levels[i] > 0.12) playing.push(noteNames[i]);
  });
  synth.update(levels, tilts);
  pool.updateBuoys(heights, levels);

  const status = !synth.started ? 'tap the water to play' : playing.length ? playing.map((s) => `<b>${s}</b>`).join(' ') : S.scale + ' in ' + S.root;
  if (status !== statusShown) {
    statusShown = status;
    $('status').innerHTML = status;
  }
};

/* ----------------------------------------------------------------- ui -- */

function applyLook() {
  pool.set({ height: S.height, depth: S.depth, strength: S.strength, soft: S.soft, dispersion: S.dispersion });
}

const gui = new GUI({ container: $('panel'), title: 'Ripples' });
gui.add(S, 'look', Object.keys(LOOKS)).name('Look').onChange((v) => pool.setLook(v));
const fMusic = gui.addFolder('Music');
fMusic.add(S, 'scale', Object.keys(SCALES)).name('Scale').onChange(retune);
fMusic.add(S, 'root', Object.keys(ROOTS)).name('Key').onChange(retune);
fMusic.add(S, 'sensitivity', 1, 8, 0.1).name('Buoy sensitivity');
fMusic.add(S, 'volume', 0, 1.2, 0.01).name('Volume').onChange((v) => synth.setVolume(v));
fMusic.add(S, 'reverb', 0, 1, 0.01).name('Reverb').onChange((v) => synth.setReverb(v));
const fWater = gui.addFolder('Water');
fWater.add(S, 'speed', 0.05, 0.34, 0.01).name('Wave speed');
fWater.add(S, 'life', 0.985, 0.999, 0.0005).name('Ripple life');
fWater.add(S, 'rain', 0.2, 4, 0.1).name('Rain (drops/s)');
fWater.add(S, 'height', 0.01, 0.12, 0.005).name('Wave height').onChange(applyLook);
const fLight = gui.addFolder('Light');
fLight.add(S, 'depth', 0.08, 0.8, 0.01).name('Pool depth').onChange(applyLook);
fLight.add(S, 'strength', 0.3, 2.5, 0.05).name('Brightness').onChange(applyLook);
fLight.add(S, 'soft', 1, 4, 0.1).name('Softness').onChange(applyLook);
fLight.add(S, 'dispersion', 0, 1.5, 0.05).name('Colour split').onChange(applyLook);
if (window.innerWidth > 0 && window.innerWidth < 640) gui.close();
applyLook();

$('btn-rain').addEventListener('click', () => {
  rain = !rain;
  const b = $('btn-rain');
  b.classList.toggle('on', rain);
  b.setAttribute('aria-pressed', String(rain));
});
$('btn-sound').addEventListener('click', () => {
  if (!synth.started) startSound();
  else synth.setMuted(!synth.muted);
  setSoundButton();
});

scramble(document.querySelector('.brand-txt'), document.querySelector('.brand'));
wipeLink(document.querySelector('.brand'));

// test hook
window.__ripples = { sim, pool, synth, S, drop, levels, BUOYS };
