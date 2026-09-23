import GUI from 'lil-gui';
import * as THREE from 'three';
import { RippleSim } from './sim.js';
import { RippleSynth, DEFAULTS as SYNTH } from './synth.js';
import { MODES, KEYS, ROWS, chordFor, keyLabel } from './chords.js';
import { PoolScene, LOOKS } from './pool.js';
import { scramble } from '../shared/scramble.js';
import { wipeIn, wipeLink } from '../shared/wipe.js';

wipeIn();

// Play chords on the letter keys and the water answers: each chord drops a
// stone and retunes the buoys to its notes, so the ripples arpeggiate what
// you play. Tapping the water works too.

const N = 160;
const RADIUS = 0.47;
const STEPS_PER_SEC = 120;

const S = {
  look: 'Ember',
  mode: 'Minor',
  key: 'D',
  octave: 0,
  speed: 0.22, // wave speed squared, in grid units per step
  life: 0.993, // energy kept per step
  rain: 0.8, // drops per second while rain is on
  height: 0.05,
  depth: 0.3,
  strength: 1,
  soft: 1.5,
  dispersion: 0.5,
  volume: 0.8,
  reverb: 0.3,
  sensitivity: 4,
  ...SYNTH,
};

// One buoy in the middle holds the chord's root; seven more circle it,
// climbing through the chord's notes as they go round.
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

const keyIndex = () => KEYS.indexOf(S.key);
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const midiName = (m) => `${KEYS[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

/* -------------------------------------------------------------- buoys -- */

let buoyMidi = [];
let buoyNames = [];

/** Spread a chord's notes over the buoys, climbing from its root. */
function tuneBuoys(chordNotes) {
  const pcs = [...new Set(chordNotes.map((n) => ((n % 12) + 12) % 12))];
  let m = 48 + (((chordNotes[0] % 12) + 12) % 12); // the root, in octave 3
  const out = [m];
  while (out.length < BUOYS.length) {
    m++;
    if (pcs.includes(m % 12)) out.push(m);
  }
  buoyMidi = out;
  buoyNames = out.map(midiName);
  synth.setBuoyNotes(out.map(midiToHz));
}
tuneBuoys(chordFor('triad', 0, S.mode, keyIndex(), 0).notes);

/* -------------------------------------------------------------- sound -- */

let rain = true;

function startSound() {
  if (synth.started) return;
  synth.start(buoyMidi.map(midiToHz), PANS);
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

/* ------------------------------------------------------------- chords -- */

const LAYOUT = new Map(); // code -> { kind, index }
ROWS.forEach((row) => row.codes.forEach((code, index) => LAYOUT.set(code, { kind: row.kind, index })));
const held = new Map(); // code -> chord
let lastChord = '';

function chordOf(code) {
  const { kind, index } = LAYOUT.get(code);
  return chordFor(kind, index, S.mode, keyIndex(), S.octave);
}

function press(code) {
  if (held.has(code)) return;
  startSound();
  const chord = chordOf(code);
  held.set(code, chord);
  synth.chordOn(code, chord.freqs);
  tuneBuoys(chord.notes);
  // a stone for each chord, placed by its degree, so each chord ripples its own way
  const a = -Math.PI / 2 + (chord.degree / 7) * Math.PI * 2 + 0.3;
  const heavy = LAYOUT.get(code).kind === 'power';
  sim.disturb(0.5 + 0.3 * Math.cos(a), 0.5 + 0.3 * Math.sin(a), heavy ? 0.02 : 0.016, heavy ? 1.3 : 1);
  lastChord = chord.name;
  capFor(code)?.classList.add('down');
}

function release(code) {
  if (!held.has(code)) return;
  held.delete(code);
  synth.chordOff(code);
  capFor(code)?.classList.remove('down');
}

function releaseAll() {
  [...held.keys()].forEach(release);
}

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (LAYOUT.has(e.code)) {
    e.preventDefault();
    if (!e.repeat) press(e.code);
    return;
  }
  if (e.repeat) return;
  const shift = { ArrowUp: ['octave', 1], ArrowDown: ['octave', -1], ArrowRight: ['key', 1], ArrowLeft: ['key', -1] }[e.code];
  if (shift) {
    e.preventDefault();
    if (shift[0] === 'octave') S.octave = Math.max(-2, Math.min(1, S.octave + shift[1]));
    else S.key = KEYS[(keyIndex() + shift[1] + 12) % 12];
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    relabel();
    return;
  }
  if (e.code === 'Space' && !e.target.closest('button')) {
    e.preventDefault();
    startSound();
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.38;
    drop(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), 1.4, 0.016, 1);
  }
});
window.addEventListener('keyup', (e) => { if (LAYOUT.has(e.code)) release(e.code); });
window.addEventListener('blur', releaseAll);

/* ------------------------------------------------ on-screen keyboard -- */

const ROW_NAMES = { seventh: '7ths', triad: 'chords', power: 'power' };
const caps = new Map();
const keysEl = $('keys');
ROWS.forEach((row) => {
  const r = document.createElement('div');
  r.className = `row row-${row.kind}`;
  const tag = document.createElement('span');
  tag.className = 'row-name';
  tag.textContent = ROW_NAMES[row.kind];
  r.appendChild(tag);
  row.codes.forEach((code) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cap';
    b.innerHTML = `<span class="k">${keyLabel(code)}</span><span class="c"></span>`;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); press(code); });
    const up = () => release(code);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    caps.set(code, b);
    r.appendChild(b);
  });
  keysEl.appendChild(r);
});
const capFor = (code) => caps.get(code);

function relabel() {
  caps.forEach((b, code) => {
    const c = chordOf(code);
    b.querySelector('.c').textContent = c.name;
    b.title = `${c.name} (${keyLabel(code)})`;
  });
  const o = S.octave === 0 ? '' : ` · oct ${S.octave > 0 ? '+' : ''}${S.octave}`;
  $('keyname').textContent = `${S.key} ${S.mode.toLowerCase()}${o}`;
}
relabel();

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
  const ringing = [];
  BUOYS.forEach((b, i) => {
    const h = sim.sample(b.u, b.v);
    heights[i] = h;
    slow[i] += (h - slow[i]) * track;
    const target = Math.min(1, Math.max(0, Math.abs(h - slow[i]) * S.sensitivity - 0.08));
    levels[i] = Math.max(levels[i] * fall, target);
    tilts[i] = Math.max(-1, Math.min(1, (sim.sample(b.u + 0.01, b.v) - sim.sample(b.u - 0.01, b.v)) * 6));
    if (levels[i] > 0.12) ringing.push(buoyNames[i]);
  });
  synth.update(levels, tilts);
  pool.updateBuoys(heights, levels);

  const chords = [...held.values()].map((c) => c.name);
  let status;
  if (!synth.started) status = 'play chords on your keyboard, or tap the water';
  else if (chords.length) status = chords.map((c) => `<b>${c}</b>`).join(' ') + (ringing.length ? ` · ${ringing.join(' ')}` : '');
  else if (ringing.length) status = ringing.join(' ');
  else status = lastChord ? `last: ${lastChord}` : '';
  if (status !== statusShown) {
    statusShown = status;
    $('status').innerHTML = status;
  }
};

/* ----------------------------------------------------------------- ui -- */

function applyLook() {
  pool.set({ height: S.height, depth: S.depth, strength: S.strength, soft: S.soft, dispersion: S.dispersion });
}
const applySynth = () => synth.set({
  drive: S.drive, cutoff: S.cutoff, resonance: S.resonance, sub: S.sub, punch: S.punch, release: S.release, detune: S.detune,
});

const gui = new GUI({ container: $('panel'), title: 'Ripples' });
gui.add(S, 'look', Object.keys(LOOKS)).name('Look').onChange((v) => pool.setLook(v));
const fKeys = gui.addFolder('Chords');
fKeys.add(S, 'key', KEYS).name('Key (← →)').onChange(relabel);
fKeys.add(S, 'mode', Object.keys(MODES)).name('Mode').onChange(relabel);
fKeys.add(S, 'octave', -2, 1, 1).name('Octave (↑ ↓)').onChange(relabel);
const fSynth = gui.addFolder('Synth');
fSynth.add(S, 'drive', 0, 1, 0.01).name('Drive').onChange(applySynth);
fSynth.add(S, 'cutoff', 150, 4000, 10).name('Filter').onChange(applySynth);
fSynth.add(S, 'resonance', 0.5, 18, 0.1).name('Resonance').onChange(applySynth);
fSynth.add(S, 'detune', 0, 40, 1).name('Detune (cents)').onChange(applySynth);
fSynth.add(S, 'sub', 0, 1.2, 0.01).name('Sub').onChange(applySynth);
fSynth.add(S, 'punch', 0, 1.2, 0.01).name('Punch').onChange(applySynth);
fSynth.add(S, 'release', 0.05, 3, 0.01).name('Release (s)').onChange(applySynth);
fSynth.add(S, 'volume', 0, 1.2, 0.01).name('Volume').onChange((v) => synth.setVolume(v));
fSynth.add(S, 'reverb', 0, 1, 0.01).name('Reverb').onChange((v) => synth.setReverb(v));
const fWater = gui.addFolder('Water');
fWater.add(S, 'sensitivity', 1, 8, 0.1).name('Buoy sensitivity');
fWater.add(S, 'speed', 0.05, 0.34, 0.01).name('Wave speed');
fWater.add(S, 'life', 0.985, 0.999, 0.0005).name('Ripple life');
fWater.add(S, 'rain', 0.2, 4, 0.1).name('Rain (drops/s)');
fWater.add(S, 'height', 0.01, 0.12, 0.005).name('Wave height').onChange(applyLook);
const fLight = gui.addFolder('Light');
fLight.add(S, 'depth', 0.08, 0.8, 0.01).name('Pool depth').onChange(applyLook);
fLight.add(S, 'strength', 0.3, 2.5, 0.05).name('Brightness').onChange(applyLook);
fLight.add(S, 'soft', 1, 4, 0.1).name('Softness').onChange(applyLook);
fLight.add(S, 'dispersion', 0, 1.5, 0.05).name('Colour split').onChange(applyLook);
fWater.close();
fLight.close();
if (window.innerWidth > 0 && window.innerWidth < 640) gui.close();
applyLook();
applySynth();

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
window.__ripples = { sim, pool, synth, S, drop, levels, BUOYS, press, release, held, get buoyNames() { return buoyNames; } };
