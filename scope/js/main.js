/* ============================================================
   main.js — wires the UI, audio, and renderer together
   ============================================================ */

import { ScopeAudio } from './audio.js';
import { ScopeRenderer } from './scope.js';

const $ = id => document.getElementById(id);

const audio = new ScopeAudio();
const scope = new ScopeRenderer($('scene'));

// Debug handle (handy in devtools: __scope.audio.ctx.state, etc.)
window.__scope = { audio, scope, frames: 0 };

// Theme the shared knobs with this tool's muted palette (knob.js reads this).
window.KNOB_COLORS = ['#58C69D', '#ACCBE1', '#F093AF', '#FFC07F', '#FFCF99'];

/* ---------------- status helper ---------------- */

const statusEl = $('status');
function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  statusEl.classList.remove('hidden');
}
function hideStatus() { statusEl.classList.add('hidden'); }

/* ---------------- file loading ---------------- */

const dropHint = $('drop-hint');

async function loadFile(file) {
  if (!file) return;
  try {
    showStatus(`Decoding ${file.name}…`);
    if (audio.synthRunning) stopSynthUI();
    audio.pause();
    await audio.load(file);
    hideStatus();
    dropHint.classList.add('hidden');
    $('transport').classList.remove('hidden');
    $('deck').classList.remove('hidden');
    $('osc-section').classList.add('hidden'); // file mode: scope controls only
    $('time-total').textContent = fmtTime(audio.duration);
    audio.play();
    updatePlayIcon();
  } catch (err) {
    showStatus(`Couldn't decode that file (${err.message || 'unsupported format'})`, true);
    setTimeout(hideStatus, 4000);
  }
}

$('file-input').addEventListener('change', e => loadFile(e.target.files[0]));
$('file-input-2').addEventListener('change', e => loadFile(e.target.files[0]));

// drag & drop
window.addEventListener('dragover', e => {
  e.preventDefault();
  dropHint.classList.add('dragover');
});
window.addEventListener('dragleave', () => dropHint.classList.remove('dragover'));
window.addEventListener('drop', e => {
  e.preventDefault();
  dropHint.classList.remove('dragover');
  loadFile(e.dataTransfer.files[0]);
});

$('drop-close').addEventListener('click', () => { location.href = '../'; });

/* ---------------- transport ---------------- */

const transport = $('transport');
const seek = $('seek');
let seeking = false;

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}
function updatePlayIcon() {
  transport.classList.toggle('playing', audio.playing);
}

$('play-btn').addEventListener('click', () => {
  audio.toggle();
  updatePlayIcon();
});

seek.addEventListener('input', () => { seeking = true; });
seek.addEventListener('change', () => {
  audio.seek((seek.value / 1000) * audio.duration);
  seeking = false;
  updatePlayIcon();
});

audio.onEnded = () => {
  updatePlayIcon();
  seek.value = 0;
};

/* ---------------- scope controls ---------------- */

function bindSlider(id, valId, fmt, apply) {
  const el = $(id);
  const val = $(valId);
  const update = () => {
    val.textContent = fmt(parseFloat(el.value));
    apply(parseFloat(el.value));
  };
  el.addEventListener('input', update);
  update();
}

bindSlider('zoom', 'zoom-val', v => `${v.toFixed(2).replace(/0$/, '')}×`, v => { scope.zoom = v; });
bindSlider('framesize', 'frame-val', v => `${Math.round(v)}`, v => { scope.framesize = Math.round(v); });
bindSlider('trail', 'trail-val', v => `${Math.round(v)}%`, v => { scope.trail = v / 100; });
bindSlider('linewidth', 'width-val', v => `${Math.round(v)}`, v => { scope.lineWidth = v; });

$('drawstyle').addEventListener('change', e => { scope.style = e.target.value; });
$('trace-color').addEventListener('change', e => { scope.color = e.target.value; });

$('deck-close').addEventListener('click', () => $('deck').classList.add('hidden'));

/* ---------------- synth (lissajous) controls ---------------- */

const synthToggle = $('synth-toggle');

/* --- the pattern sequencer -------------------------------------
   Each step is [noteMult, ratio]: the X tone plays base×noteMult,
   the Y tone plays base×noteMult×ratio. The RATIO decides the
   figure's shape, the MULT decides the musical note — so every
   step jumps the picture AND the melody at once. */
const PATTERNS = {
  orbits: [[1, 1], [1, 2], [1, 1.5], [1, 3], [1, 4 / 3], [1, 2], [1, 1.25], [1, 4]],
  melody: [[1, 1.5], [9 / 8, 1.5], [5 / 4, 1.5], [3 / 2, 1.5], [5 / 3, 1.5], [2, 1.5], [5 / 3, 1.5], [5 / 4, 1.5]],
  bounce: [[1, 1], [3 / 2, 2], [1, 3], [2, 1.5], [1, 2], [3 / 2, 1], [1, 4], [2, 2]],
};
const RAND_MULTS = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
const RAND_RATIOS = [1, 1.25, 4 / 3, 1.5, 2, 3];

let stepIndex = 0;
let nextStepAt = 0;     // ms timestamps (performance.now)
let lastStepAt = 0;
let curMult = 1;
let curRatio = 1;
let stepTimer = 0;

/* The sequencer runs on a timer, NOT inside the draw loop — browsers
   pause requestAnimationFrame in background tabs, and the melody
   should keep stepping even when the tab isn't visible. */
function startStepper() {
  clearInterval(stepTimer);
  stepTimer = setInterval(() => {
    if (!audio.synthRunning) return;
    const now = performance.now();
    if (now >= nextStepAt) {
      pickStep();
      audio.updateSynth(synthParams());
      lastStepAt = now;
      nextStepAt = now + 1000 / parseFloat($('speed').value);
    }
  }, 50);
}
function stopStepper() {
  clearInterval(stepTimer);
  stepTimer = 0;
}

function pickStep() {
  const name = $('pattern').value;
  if (name === 'random') {
    curMult = RAND_MULTS[Math.floor(Math.random() * RAND_MULTS.length)];
    curRatio = RAND_RATIOS[Math.floor(Math.random() * RAND_RATIOS.length)];
  } else {
    const pat = PATTERNS[name];
    [curMult, curRatio] = pat[stepIndex % pat.length];
    stepIndex++;
  }
}

function synthParams() {
  return {
    freq: parseFloat($('freq').value) * curMult,
    ratio: curRatio,
    phaseDeg: 90,                                  // fixed quarter turn: fullest shapes
    volume: parseFloat($('volume').value) / 100,
  };
}

$('synth-open').addEventListener('click', () => {
  dropHint.classList.add('hidden');
  $('deck').classList.remove('hidden');
  $('osc-section').classList.remove('hidden');
});

function stopSynthUI() {
  stopStepper();
  audio.stopSynth();
  synthToggle.textContent = 'Start oscillators';
  synthToggle.classList.remove('running');
}

synthToggle.addEventListener('click', () => {
  if (audio.synthRunning) {
    stopSynthUI();
  } else {
    audio.pause();          // one sound source at a time
    updatePlayIcon();
    stepIndex = 0;
    pickStep();             // land on the pattern's first shape
    lastStepAt = performance.now();
    nextStepAt = lastStepAt + 1000 / parseFloat($('speed').value);
    audio.startSynth(synthParams());
    startStepper();
    synthToggle.textContent = 'Stop oscillators';
    synthToggle.classList.add('running');
  }
});

bindSlider('freq', 'freq-val', v => `${Math.round(v)} Hz`, () => audio.updateSynth(synthParams()));
bindSlider('speed', 'speed-val', v => `${Math.round(v)} /s`, () => {});
bindSlider('volume', 'vol-val', v => `${Math.round(v)}%`, () => audio.updateSynth(synthParams()));
$('pattern').addEventListener('change', () => { stepIndex = 0; nextStepAt = 0; });

/* ---------------- lissajous curve (synth mode draws pure math) ----------------
   x = sin(s + π/2), y = sin(r·s). No drift, no auto-motion: the shape
   holds still, then JUMPS when the sequencer steps. The ratio eases
   toward its new target over a few frames (a quick morph, not a cut)
   and each jump lands with a little "pop" of scale. */

let lissX = new Float32Array(0);
let lissY = new Float32Array(0);
let displayRatio = 1;   // eases toward curRatio for a snappy morph

function lissajousPoints(ratio, n, pop) {
  if (lissX.length !== n) {
    lissX = new Float32Array(n);
    lissY = new Float32Array(n);
  }
  const HALF_PI = Math.PI / 2;
  // s spans several full turns so every preset ratio closes its loop
  const span = Math.PI * 2 * 6;
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * span;
    lissX[i] = Math.sin(s + HALF_PI) * pop;
    lissY[i] = Math.sin(ratio * s) * pop;
  }
  return { x: lissX, y: lissY };
}

/* ---------------- render loop ---------------- */

function frame() {
  window.__scope.frames++;
  if (audio.synthRunning) {
    const now = performance.now();
    displayRatio += (curRatio - displayRatio) * 0.22;
    const pop = 0.82 + 0.16 * Math.exp(-(now - lastStepAt) / 140);
    const pts = lissajousPoints(displayRatio, scope.framesize, pop);
    scope.renderXY(pts.x, pts.y);
  } else {
    const { left, right } = audio.getWaveforms();
    scope.render(left, right);
  }

  if (audio.playing && !seeking) {
    seek.value = (audio.getTime() / audio.duration) * 1000 || 0;
    $('time-current').textContent = fmtTime(audio.getTime());
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
