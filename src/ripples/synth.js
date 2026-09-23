// The instrument. Each buoy is a voice that is silent until water moves under
// it: the wave's size opens its volume and filter and bends its pitch a hair,
// so a ripple passing a buoy is heard as that buoy's note swelling and fading.
// Drops make a short "plip" of their own so a tap answers straight away,
// before its ripple has reached any buoy.

export const SCALES = {
  'Major pentatonic': [0, 2, 4, 7, 9],
  'Minor pentatonic': [0, 3, 5, 7, 10],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  'Whole tone': [0, 2, 4, 6, 8, 10],
};

export const ROOTS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Note frequencies for `count` voices: the root, then up the scale. */
export function scaleNotes(scale, root, count, baseOctave = 3) {
  const steps = SCALES[scale] || SCALES['Major pentatonic'];
  const out = [];
  for (let i = 0; i < count; i++) {
    const oct = Math.floor(i / steps.length);
    const semis = 12 * (baseOctave + oct) + (ROOTS[root] ?? 2) + steps[i % steps.length];
    out.push(440 * Math.pow(2, (semis - 57) / 12)); // 57 semitones above C0 is A4 = 440 Hz
  }
  return out;
}

/** A few seconds of decaying stereo noise: a soft, watery room. */
function impulse(ctx, seconds = 3.2) {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * (1 - Math.exp(-i / 400));
    }
  }
  return buf;
}

export class RippleSynth {
  constructor() {
    this.ctx = null;
    this.voices = [];
    this.muted = false;
  }

  get started() {
    return !!this.ctx;
  }

  /** Must be called from a click or tap: browsers only start audio on a gesture. */
  start(notes, pans) {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.45;
    this.reverb.connect(this.wet);
    this.wet.connect(this.master);

    this.voices = notes.map((f, i) => this.makeVoice(f, pans[i] || 0));
  }

  makeVoice(freq, pan) {
    const ctx = this.ctx;
    const a = ctx.createOscillator();
    a.type = 'sine';
    a.frequency.value = freq;
    const b = ctx.createOscillator();
    b.type = 'triangle';
    b.frequency.value = freq * 2;
    b.detune.value = 4;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.22;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 0.7;
    const vca = ctx.createGain();
    vca.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;

    a.connect(filter);
    b.connect(bGain);
    bGain.connect(filter);
    filter.connect(vca);
    vca.connect(panner);
    panner.connect(this.master);
    panner.connect(this.reverb);
    a.start();
    b.start();
    return { a, b, filter, vca, panner };
  }

  setNotes(notes) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.voices.forEach((v, i) => {
      v.a.frequency.setTargetAtTime(notes[i], t, 0.05);
      v.b.frequency.setTargetAtTime(notes[i] * 2, t, 0.05);
    });
  }

  /** Per frame: how much each buoy is moving (0..1) and which way (-1..1). */
  update(levels, tilts) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.voices.forEach((v, i) => {
      const g = this.muted ? 0 : levels[i] * 0.3;
      v.vca.gain.setTargetAtTime(g, t, 0.035);
      v.filter.frequency.setTargetAtTime(350 + 4200 * levels[i], t, 0.05);
      // the water's slope bends the note slightly, like a wobble on the surface
      const cents = (tilts[i] || 0) * 18;
      v.a.detune.setTargetAtTime(cents, t, 0.03);
      v.b.detune.setTargetAtTime(4 + cents, t, 0.03);
    });
  }

  /** A water drop: a sine that falls fast in pitch, with a click of noise. */
  plip(strength, pan) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = Math.min(1, strength);
    const f0 = 900 + Math.random() * 900;

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.32, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * s + 0.02, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    o.connect(g);
    g.connect(p);
    p.connect(this.master);
    p.connect(this.reverb);
    o.start(t);
    o.stop(t + 0.2);
    o.onended = () => { o.disconnect(); g.disconnect(); p.disconnect(); };
  }

  setMuted(m) {
    this.muted = m;
  }

  setVolume(v) {
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setReverb(v) {
    if (this.wet) this.wet.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }
}
