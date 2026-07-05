/* ============================================================
   knob.js — turns every panel slider into an OP-1-style knob
   ------------------------------------------------------------
   Finds each `.ctl input[type=range]`, hides it, and puts a
   rotary knob in its place. The hidden input stays the source
   of truth: the knob writes to it and fires `input` events, so
   every tool's existing wiring keeps working untouched.

   Interactions: drag up/down · mouse wheel · double-click resets.
   ============================================================ */

// A tool can set window.KNOB_COLORS (in its main.js, which loads first)
// to theme its knobs; otherwise these OP-1-ish defaults apply.
const COLORS = window.KNOB_COLORS ||
  ['#3d6be0', '#c9a087', '#8e9096', '#ff4b19']; // blue/tan/gray/orange

function knobify(input, color) {
  const ctl = input.closest('.ctl');
  if (!ctl || ctl.classList.contains('knobified')) return;
  ctl.classList.add('knobified');

  const labelSpan = ctl.querySelector('span');

  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.style.background = color;
  const dot = document.createElement('div');
  dot.className = 'knob-dot';
  knob.appendChild(dot);

  const text = document.createElement('div');
  text.className = 'knob-text';
  if (labelSpan) text.appendChild(labelSpan);

  ctl.insertBefore(knob, ctl.firstChild);
  ctl.appendChild(text);
  input.classList.add('knob-input');
  const ticks = ctl.querySelector('.ticks');
  if (ticks) ticks.remove();

  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const step = parseFloat(input.step) || 1;
  const initial = parseFloat(input.value);
  const decimals = (String(input.step).split('.')[1] || '').length;

  // pointer notch sweeps 270°, from 7 o'clock to 5 o'clock
  function paint() {
    const t = (parseFloat(input.value) - min) / (max - min);
    dot.style.transform = `rotate(${-135 + 270 * t}deg)`;
  }
  paint();
  input.addEventListener('input', paint);

  function setValue(v) {
    v = Math.round(v / step) * step;
    v = Math.max(min, Math.min(max, v));
    input.value = v.toFixed(decimals);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  let dragging = false, startY = 0, startV = 0;
  knob.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startV = parseFloat(input.value);
    knob.setPointerCapture(e.pointerId);
    knob.classList.add('dragging');
  });
  knob.addEventListener('pointermove', e => {
    if (!dragging) return;
    // a 150px vertical drag covers the whole range
    setValue(startV + ((startY - e.clientY) / 150) * (max - min));
  });
  const end = () => { dragging = false; knob.classList.remove('dragging'); };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  knob.addEventListener('wheel', e => {
    e.preventDefault();
    setValue(parseFloat(input.value) + (e.deltaY < 0 ? step : -step));
  }, { passive: false });
  knob.addEventListener('dblclick', () => setValue(initial));
}

let i = 0;
for (const input of document.querySelectorAll('.ctl input[type="range"]')) {
  knobify(input, COLORS[i++ % COLORS.length]);
}
