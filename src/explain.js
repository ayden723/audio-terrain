// Plain-language help for the control panel. Every control gets a sentence. The
// ones that change the picture also get a card of what-if renders, drawn by the
// real renderer from the real data, so a thumbnail cannot disagree with what the
// setting does. Where the control is a choice rather than a slider, each render
// is a button that makes that choice.

const MARK = '#ff2bd6';

// preview: 'ends' (the slider's extremes, or the values in `ends`), 'options'
// (one per choice), 'toggle' (off / on) or 'mark' (the colour swapped for pink,
// to show where it lands). zoom moves the camera in for fine detail; reframe
// refits it, as the app does when the terrain changes size; play shows the
// playhead; also pins other settings for the drawing, and caption says so. No
// preview means the sentence goes to the hint line instead.
export const EXPLAIN = {
  // source
  open: { text: 'Load an audio file to turn into terrain, or an image to turn into both terrain and sound.' },
  mic: { text: 'Draw the terrain live from a microphone or audio input. New sound arrives at one edge and older sound rolls away.' },
  share: { text: 'Draw the terrain live from a browser tab or system audio that you choose to share.' },
  liveDevice: { text: 'Which microphone or input the live terrain listens to.' },
  stop: { text: 'Stop listening and clear the live terrain.' },
  invert: { text: 'Swaps light and dark, so dark pixels become the peaks instead of bright ones.', preview: 'toggle' },
  terrainFrom: { text: 'Image pixels builds the terrain straight from brightness. Synthesized audio builds it by analysing the sound the image was turned into.' },
  synthDuration: { text: 'How long the image takes to play, from its left edge to its right.' },
  d: { text: 'Save the sound made from the image as a WAV file.' },

  // look
  preset: { text: 'A complete look in one pick: colours, lighting, lines and render mode. It never touches the analysis or the shape.', preview: 'options' },
  mode: { text: 'Ridges are separate ribbons, one per slice of time. Lines keeps only their outlines. Surface joins the slices into one sheet.', preview: 'options' },
  ridges: { text: 'How many slices of time are drawn. Fewer is bold and graphic, more is fine and dense.', preview: 'ends' },
  skirt: { text: 'How far each ribbon hangs below its own crest. At 0 every ribbon is a solid wall down to the floor.', preview: 'ends', ends: [0, 0.1, 1.2], zoom: 1.5 },
  height: { text: 'How tall the loudest sounds stand.', preview: 'ends' },
  smooth: { text: 'Blurs the terrain across pitch, and a little across time. Low keeps every spike, high gives rolling hills.', preview: 'ends', zoom: 1.4 },
  range: { text: 'How far below the loudest sound the floor sits. Low shows only the loudest peaks, high lifts quiet detail out of the floor.', preview: 'ends', unit: ' dB' },
  gamma: { text: 'Bends the height curve. Low lifts quiet sounds toward the peaks, high sinks them so only the loudest stand out.', preview: 'ends' },

  // waterfall
  waterfall: { text: 'Shows a moving window of the audio that scrolls as it plays, instead of the whole file at once.' },
  windowSec: { text: 'How many seconds of sound are visible at once while scrolling.' },

  // camera
  view: { text: 'Jumps the camera to a set angle. Timeline lays time out left to right, which suits whole songs.', preview: 'options', reframe: true },
  autoMove: { text: 'Slowly orbits, sways and zooms the camera by itself. Dragging the view takes it back.' },
  motionSpeed: { text: 'How fast Auto move drifts. At 1, a full orbit takes 30 seconds.' },

  // analysis
  quality: { text: 'How many FFT sizes are blended together. Higher is sharper in both pitch and timing, and slower to analyse.' },
  cols: { text: 'How many pitch columns each slice has. More separates closer pitches, and costs more to draw.', preview: 'ends', zoom: 1.6 },
  fmin: { text: 'The lowest pitch shown, at the low edge of the terrain. Raise it to crop out rumble.', preview: 'ends', unit: ' Hz' },
  fmax: { text: 'The highest pitch shown, at the high edge. Lower it to zoom in on the bass and mids.', preview: 'ends', unit: ' Hz' },
  scale: { text: 'How pitch is spread across the width. Logarithmic gives every octave equal room, Mel follows the ear, Linear gives every hertz equal room and squeezes the bass.', preview: 'options' },

  // shape
  tilt: { text: 'Raises treble and lowers bass by this many dB per octave, pivoting at 1 kHz. Below zero does the reverse. Evens out music, whose highs are naturally quieter.', preview: 'ends', unit: ' dB/oct' },
  cut: { text: 'Flattens everything below this level to the floor and stretches the rest to fit, clearing away low-level haze.', preview: 'ends' },
  width: { text: 'How wide the terrain is along the pitch axis.', preview: 'ends', reframe: true },
  depth: { text: 'How long the terrain is along the time axis.', preview: 'ends', reframe: true },
  reverse: { text: 'Flips which end of the terrain is the start of the audio.', preview: 'toggle' },

  // colour & light
  colorMode: { text: 'Lit relief shades between the Shadow and Highlight colours by how the light falls. Colour ramp colours by loudness instead.', preview: 'options' },
  bg: { text: 'The paper behind the terrain, and the colour that distance fades into.', preview: 'mark' },
  shadow: { text: 'The colour of slopes facing away from the light, and of ribbon faces below the crest.', preview: 'mark' },
  highlight: { text: 'The colour of slopes facing the light, and of the rim light.', preview: 'mark' },
  line: { text: 'The line drawn along every crest, or the grid lines in Surface mode. Line strength sets how visible it is.', preview: 'mark', also: { lineOpacity: 1 }, caption: 'In pink, at full strength: its lines' },
  accent: { text: 'The playhead that rides the terrain during playback, and the seek bar.', preview: 'mark', play: true },
  lineOpacity: { text: 'How strongly the crest lines are drawn, or the grid lines in Surface mode. 0 hides them.', preview: 'ends', zoom: 1.7 },
  crestShade: { text: 'Darkens each ribbon face toward the Shadow colour the further it drops below its crest.', preview: 'ends', zoom: 1.7 },
  shadowStr: { text: 'How dark the shadows are that peaks throw across the terrain on the side away from the light.', preview: 'ends', zoom: 1.4 },
  rim: { text: 'A sheen in the Highlight colour on slopes seen edge-on, which picks crests out of the mass.', preview: 'ends', zoom: 1.7 },
  fog: { text: 'Fades the far side of the terrain into the background colour.', preview: 'ends' },
  ambient: { text: 'How much light reaches slopes that face away from the light. At 1 the shading goes flat.', preview: 'ends', zoom: 1.4 },
  lightAz: { text: 'The compass direction the light comes from: 0 is the front, 90 the high-pitch side, 180 behind. Moves the highlights and cast shadows around the peaks.', preview: 'ends', ends: [-90, 0, 90], unit: '°', zoom: 1.4 },
  lightEl: { text: 'How high the light sits. Low rakes across and throws long shadows, high lights everything evenly.', preview: 'ends', unit: '°', zoom: 1.4 },
  grain: { text: 'A paper texture and soft vignette laid over the whole picture. Always hidden while presenting.' },
  renderScale: { text: 'Pixels drawn per screen pixel. Higher is crisper and heavier on the graphics card.' },

  // image synthesis
  synthRange: { text: 'How much quieter dark pixels sound than bright ones. Low keeps the whole image audible, high lets only the brightest parts through.' },
  synthRows: { text: 'How many sine tones are stacked to make the sound, one per row of the image. More is richer and slower to build.' },
  s: { text: 'Rebuild the sound from the image with the current settings.' },
};

const CARD_INNER = 312;
const GAP = 6;
const fmt = (v) => String(+Number(v).toFixed(2));

/**
 * inert(key) says why a setting does nothing right now (or null), canPreview(key)
 * whether a what-if can be drawn for it, and render(canvas, key, value, spec)
 * draws one and resolves to whether it could.
 */
export function initExplain({ gui, panel, card, hint, inert, canPreview, render }) {
  const idle = hint.textContent;
  const wide = window.matchMedia('(min-width: 760px)');
  const elTitle = card.querySelector('.ex-title');
  const elThumbs = card.querySelector('.ex-thumbs');
  const elText = card.querySelector('.ex-text');
  let current = null;
  let picking = false; // the card's thumbnails are buttons for the control's choices
  let cells = [];
  let drawTimer = 0;
  let hideTimer = 0;
  let run = 0;

  const controllerAt = (el) => gui.controllersRecursive().find((c) => c.domElement.contains(el));

  function setHint(text) {
    hint.textContent = text || idle;
    hint.classList.toggle('on', !!text);
  }

  function variants(c, spec) {
    if (spec.preview === 'options') return c._values.map((value, i) => ({ value, label: String(c._names[i]) }));
    if (spec.preview === 'toggle') return [{ value: false, label: 'Off' }, { value: true, label: 'On' }];
    if (spec.preview === 'mark') return [{ value: MARK, label: spec.caption || 'In pink: everything this colour paints' }];
    return (spec.ends || [c._min, c._max]).map((value) => ({ value, label: fmt(value) + (spec.unit || '') }));
  }

  function markCurrent() {
    if (!picking) return;
    const v = current?.getValue();
    cells.forEach((cell) => {
      const on = cell.value === v;
      cell.el.classList.toggle('cur', on);
      cell.el.setAttribute('aria-pressed', String(on));
    });
  }

  function place(c) {
    const row = c.domElement.getBoundingClientRect();
    card.style.right = `${window.innerWidth - panel.getBoundingClientRect().left + 8}px`;
    card.style.top = `${Math.max(56, Math.min(row.top - 8, window.innerHeight - card.offsetHeight - 12))}px`;
  }

  function hide() {
    current = null;
    run++;
    clearTimeout(drawTimer);
    card.hidden = true;
    setHint(null);
  }

  function show(c) {
    clearTimeout(hideTimer);
    if (c === current) return;
    const key = c.property;
    const spec = EXPLAIN[key];
    if (!spec) { hide(); return; }
    current = c;
    clearTimeout(drawTimer);
    const id = ++run;

    const note = inert(key);
    const list = spec.preview && !note && wide.matches && canPreview(key) ? variants(c, spec) : null;
    if (!list) {
      card.hidden = true;
      setHint(`${c._name}: ${spec.text}${note ? ` ${note}` : ''}`);
      return;
    }

    setHint(null);
    picking = spec.preview === 'options' || spec.preview === 'toggle';
    card.classList.toggle('pick', picking);
    elTitle.textContent = c._name;
    elText.textContent = spec.text;
    const n = list.length;
    const perRow = Math.min(n, 3);
    const cw = Math.floor((CARD_INNER - GAP * (perRow - 1)) / perRow);
    const ch = Math.round(cw / (n === 1 ? 2 : 1.6));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    elThumbs.hidden = false;
    elThumbs.style.gridTemplateColumns = `repeat(${perRow}, ${cw}px)`;
    cells = list.map(({ value, label }) => {
      const el = document.createElement(picking ? 'button' : 'figure');
      el.className = 'ex-cell';
      if (picking) {
        el.type = 'button';
        el.addEventListener('click', () => c.setValue(value));
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
      const cap = document.createElement(picking ? 'span' : 'figcaption');
      cap.className = 'ex-cap';
      cap.textContent = label;
      el.append(canvas, cap);
      return { el, canvas, value };
    });
    elThumbs.replaceChildren(...cells.map((cell) => cell.el));
    markCurrent();
    card.hidden = false;
    place(c);

    // Wait a beat, so skimming down the panel does not queue a render per row.
    drawTimer = setTimeout(async () => {
      for (const cell of cells) {
        const ok = await render(cell.canvas, key, cell.value, spec);
        if (id !== run) return;
        if (!ok) { elThumbs.hidden = true; place(c); return; } // nothing to draw: the sentence still stands
      }
    }, 140);
  }

  // long enough to cross the gap from a row to the card's buttons
  const hideSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 220); };
  const stay = () => clearTimeout(hideTimer);
  const over = () => panel.matches(':hover') || card.matches(':hover');
  const inside = (el) => el instanceof Node && (panel.contains(el) || card.contains(el));

  panel.addEventListener('pointerover', (e) => {
    const c = controllerAt(e.target);
    if (c) show(c);
  });
  panel.addEventListener('focusin', (e) => {
    const c = controllerAt(e.target);
    if (c) show(c);
  });
  // A slider drag can wander off the panel, and a finger lifting is not leaving.
  panel.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch' && !e.buttons) hideSoon();
  });
  panel.addEventListener('pointerenter', stay);
  panel.addEventListener('focusout', () => {
    if (!over()) hideSoon();
  });
  card.addEventListener('pointerenter', stay);
  card.addEventListener('focusin', stay);
  card.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') hideSoon();
  });
  card.addEventListener('focusout', () => {
    if (!over()) hideSoon();
  });
  window.addEventListener('pointerup', () => {
    if (current && !over()) hideSoon();
  });
  window.addEventListener('pointerdown', (e) => {
    if (current && !inside(e.target)) hide();
  });

  // Anything outside the panel can borrow the hint line with a data-hint attribute.
  document.querySelectorAll('[data-hint]').forEach((el) => {
    const on = () => setHint(el.dataset.hint);
    const off = () => setHint(null);
    el.addEventListener('pointerenter', on);
    el.addEventListener('pointerleave', off);
    el.addEventListener('focus', on);
    el.addEventListener('blur', off);
  });

  return {
    /** A control's value moved: keep the card's "in use" outline on the right thumbnail. */
    changed(c) {
      if (c === current) markCurrent();
    },
  };
}
