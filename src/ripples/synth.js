// The instrument: a dark, distorted, industrial synth.
//
// Every voice is a pair of detuned sawtooths (plus a square an octave down on
// chords) through a resonant low-pass whose envelope snaps shut, all summed
// into one overdriven bus. Distorting the sum rather than each voice is what
// makes it growl: the notes of a chord grind against each other. A clean sub
// sine and an 808-style thump sit beside the distortion so the low end stays
// deep instead of turning to fizz.
//
// Two things play it: chords from the keyboard (chordOn / chordOff), and the
// water, where each buoy is a voice that swells as ripples pass under it. The
// buoys get lighter grit on a bus of their own, so the water's echo of a chord
// sits behind the chord rather than saturating as loud as it.

function driveCurve(n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // tanh saturation with a little asymmetry for even harmonics (the growl)
    c[i] = Math.tanh(2.6 * x + 0.35 * x * x) / Math.tanh(2.6 + 0.35);
  }
  return c;
}

/** A few seconds of decaying stereo noise: a dark concrete room. */
function impulse(ctx, seconds = 2.6) {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += ((Math.random() * 2 - 1) - lp) * 0.35; // darker than white noise
      d[i] = lp * Math.pow(1 - t, 3) * (1 - Math.exp(-i / 300));
    }
  }
  return buf;
}

/** Stop an envelope where it is right now, so a release never jumps. */
function hold(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else {
    param.setValueAtTime(param.value, t);
    param.cancelScheduledValues(t + 1e-4);
  }
}

export const DEFAULTS = {
  drive: 0.6, // 0..1
  cutoff: 900, // Hz, where the filter settles after its snap
  resonance: 7,
  sub: 0.8,
  punch: 0.6,
  release: 0.5, // seconds
  detune: 14, // cents between the two saws
};

export class RippleSynth {
  constructor() {
    this.ctx = null;
    this.buoys = [];
    this.chords = new Map();
    this.muted = false;
    this.volume = 0.8;
    this.p = { ...DEFAULTS };
  }

  get started() {
    return !!this.ctx;
  }

  /** Must be called from a click, tap or key press: browsers only start audio on a gesture. */
  start(buoyFreqs, pans) {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    // dirty bus: the chords, overdriven together
    this.dirty = ctx.createGain();
    this.pre = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = driveCurve();
    this.shaper.oversample = '2x';
    this.post = ctx.createGain();
    this.tone = ctx.createBiquadFilter(); // tames the fizz the distortion adds up top
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 5200;
    this.tone.Q.value = 0.5;
    this.dirty.connect(this.pre);
    this.pre.connect(this.shaper);
    this.shaper.connect(this.post);
    this.post.connect(this.tone);

    // buoy bus: the water's echo of the chords, with lighter grit of its own
    // so it sits behind the chords instead of saturating as loud as them
    this.buoyBus = ctx.createGain();
    this.buoyBus.gain.value = 2.5;
    const buoyShaper = ctx.createWaveShaper();
    buoyShaper.curve = this.shaper.curve;
    const buoyPost = ctx.createGain();
    buoyPost.gain.value = 0.22;
    this.buoyBus.connect(buoyShaper);
    buoyShaper.connect(buoyPost);
    buoyPost.connect(this.tone);

    // clean bus: sub, thump and water drops, kept out of the distortion
    this.clean = ctx.createGain();

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -20;
    this.comp.knee.value = 6;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.tone.connect(this.comp);
    this.clean.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.3;
    this.tone.connect(this.reverb);
    this.reverb.connect(this.wet);
    this.wet.connect(this.comp);

    this.applyDrive();
    this.buoys = buoyFreqs.map((f, i) => this.makeBuoy(f, pans[i] || 0));
  }

  applyDrive() {
    if (!this.ctx) return;
    const d = this.p.drive;
    const t = this.ctx.currentTime;
    this.pre.gain.setTargetAtTime(1 + d * 22, t, 0.03);
    this.post.gain.setTargetAtTime(0.9 / (1 + d * 2.2), t, 0.03);
  }

  /** A buoy: detuned saws that stay silent until the water moves them. */
  makeBuoy(freq, pan) {
    const ctx = this.ctx;
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.type = b.type = 'sawtooth';
    a.frequency.value = b.frequency.value = freq;
    a.detune.value = -this.p.detune / 2;
    b.detune.value = this.p.detune / 2;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 200;
    filter.Q.value = this.p.resonance * 0.6;
    const vca = ctx.createGain();
    vca.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    a.connect(filter);
    b.connect(filter);
    filter.connect(vca);
    vca.connect(panner);
    panner.connect(this.buoyBus);
    a.start();
    b.start();
    return { a, b, filter, vca };
  }

  /** Retune the buoys (they glide there). */
  setBuoyNotes(freqs) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.buoys.forEach((v, i) => {
      v.a.frequency.setTargetAtTime(freqs[i], t, 0.04);
      v.b.frequency.setTargetAtTime(freqs[i], t, 0.04);
    });
  }

  /** Per frame: how much each buoy is moving (0..1) and which way the water tilts (-1..1). */
  update(levels, tilts) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.buoys.forEach((v, i) => {
      // gated, so a buoy only sings when a ripple clearly passes
      const l = Math.max(0, (levels[i] - 0.15) / 0.85);
      v.vca.gain.setTargetAtTime(l * l * 0.35, t, 0.03);
      v.filter.frequency.setTargetAtTime(160 + 3200 * l * l, t, 0.04);
      const cents = (tilts[i] || 0) * 20;
      v.a.detune.setTargetAtTime(cents - this.p.detune / 2, t, 0.03);
      v.b.detune.setTargetAtTime(cents + this.p.detune / 2, t, 0.03);
    });
  }

  /** Start a held chord. `id` is whatever releases it later (the key). */
  chordOn(id, freqs) {
    if (!this.ctx) return;
    this.chordOff(id, true);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const p = this.p;
    const nodes = [];
    const voices = [];

    freqs.forEach((f, i) => {
      const a = ctx.createOscillator();
      const b = ctx.createOscillator();
      const low = ctx.createOscillator();
      a.type = b.type = 'sawtooth';
      low.type = 'square';
      a.frequency.value = b.frequency.value = f;
      low.frequency.value = f / 2;
      a.detune.value = -p.detune / 2;
      b.detune.value = p.detune / 2;
      const lowGain = ctx.createGain();
      lowGain.gain.value = i === 0 ? 0.45 : 0.2;

      // the acid snap: the filter opens wide and falls back to the cutoff
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = p.resonance;
      filter.frequency.setValueAtTime(Math.min(16000, p.cutoff * 7), t);
      filter.frequency.exponentialRampToValueAtTime(p.cutoff, t + 0.32);

      const vca = ctx.createGain();
      vca.gain.setValueAtTime(0.0001, t);
      vca.gain.exponentialRampToValueAtTime(0.13, t + 0.008);
      vca.gain.setTargetAtTime(0.095, t + 0.03, 0.25);

      a.connect(filter);
      b.connect(filter);
      low.connect(lowGain);
      lowGain.connect(filter);
      filter.connect(vca);
      vca.connect(this.dirty);
      [a, b, low].forEach((o) => o.start(t));
      nodes.push(a, b, low, lowGain, filter, vca);
      voices.push({ oscs: [a, b, low], vca, filter });
    });

    // sub: a clean sine an octave under the root
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = Math.max(30, freqs[0] / 2);
    const subVca = ctx.createGain();
    subVca.gain.setValueAtTime(0.0001, t);
    subVca.gain.exponentialRampToValueAtTime(0.0001 + 0.5 * p.sub, t + 0.012);
    sub.connect(subVca);
    subVca.connect(this.clean);
    sub.start(t);
    nodes.push(sub, subVca);

    // thump: an 808-style falling sine on the attack
    if (p.punch > 0.01) {
      const k = ctx.createOscillator();
      k.type = 'sine';
      k.frequency.setValueAtTime(150, t);
      k.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      const kg = ctx.createGain();
      kg.gain.setValueAtTime(0.0001, t);
      kg.gain.exponentialRampToValueAtTime(0.9 * p.punch, t + 0.004);
      kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      k.connect(kg);
      kg.connect(this.clean);
      k.start(t);
      k.stop(t + 0.5);
      k.onended = () => { k.disconnect(); kg.disconnect(); };
    }

    this.chords.set(id, { voices, sub, subVca, nodes });
  }

  /** Release a held chord. */
  chordOff(id, fast = false) {
    const c = this.chords.get(id);
    if (!c || !this.ctx) return;
    this.chords.delete(id);
    const t = this.ctx.currentTime;
    const rel = fast ? 0.03 : Math.max(0.03, this.p.release);
    c.voices.forEach((v) => {
      hold(v.vca.gain, t);
      v.vca.gain.setTargetAtTime(0, t, rel / 4);
      hold(v.filter.frequency, t);
      v.filter.frequency.setTargetAtTime(Math.max(80, this.p.cutoff * 0.4), t, rel / 3);
      v.oscs.forEach((o) => o.stop(t + rel * 1.6));
    });
    hold(c.subVca.gain, t);
    c.subVca.gain.setTargetAtTime(0, t, rel / 4);
    c.sub.stop(t + rel * 1.6);
    c.sub.onended = () => c.nodes.forEach((n) => n.disconnect());
  }

  releaseAll() {
    [...this.chords.keys()].forEach((id) => this.chordOff(id));
  }

  /** A water drop: a sine that falls fast in pitch. Stays clean. */
  plip(strength, pan) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = Math.min(1, strength);
    const f0 = 700 + Math.random() * 700;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.3, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * s + 0.01, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    const pn = ctx.createStereoPanner();
    pn.pan.value = Math.max(-1, Math.min(1, pan));
    o.connect(g);
    g.connect(pn);
    pn.connect(this.clean);
    o.start(t);
    o.stop(t + 0.2);
    o.onended = () => { o.disconnect(); g.disconnect(); pn.disconnect(); };
  }

  /** Sound-shaping settings; see DEFAULTS. */
  set(values) {
    Object.assign(this.p, values);
    if (!this.ctx) return;
    if ('drive' in values) this.applyDrive();
    const t = this.ctx.currentTime;
    if ('resonance' in values) this.buoys.forEach((v) => v.filter.Q.setTargetAtTime(this.p.resonance * 0.6, t, 0.05));
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setReverb(v) {
    if (this.wet) this.wet.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }
}
