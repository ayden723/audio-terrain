// The instrument: a dark, warm synth with a little grit.
//
// Chords are detuned sawtooths through a low-pass whose envelope opens on
// the attack and settles back, over a clean sub on the bass note. Everything
// melodic is summed into one bus with gentle saturation (warmth, not fuzz),
// and an optional soft thump marks each chord. Single notes are a plucky lead
// voice on the same bus.
//
// The water plays it too: each buoy is a voice that swells as ripples pass
// under it, on a quieter bus of its own so the water's echo of a chord sits
// behind the chord.

function saturation(n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(1.4 * x) / Math.tanh(1.4); // soft: unity-ish near zero, rounds off peaks
  }
  return c;
}

/** A few seconds of decaying stereo noise: a dark room. */
function impulse(ctx, seconds = 2.8) {
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
  drive: 0.2, // 0..1, gentle saturation
  cutoff: 1500, // Hz, where the filter settles after the attack
  resonance: 2,
  sub: 0.6,
  punch: 0.2,
  release: 0.9, // seconds
  detune: 10, // cents between the two saws
};

export class RippleSynth {
  constructor() {
    this.ctx = null;
    this.buoys = [];
    this.held = new Map();
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

    // main bus: chords and notes, saturated together
    this.bus = ctx.createGain();
    this.pre = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = saturation();
    this.shaper.oversample = '4x';
    this.post = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 6000;
    this.tone.Q.value = 0.5;
    this.bus.connect(this.pre);
    this.pre.connect(this.shaper);
    this.shaper.connect(this.post);
    this.post.connect(this.tone);

    // buoy bus: the water's echo, quieter, same colour
    this.buoyBus = ctx.createGain();
    this.buoyBus.gain.value = 0.5;
    this.buoyBus.connect(this.tone);

    // clean bus: sub, thump and water drops
    this.clean = ctx.createGain();

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 10;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.01;
    this.comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.tone.connect(this.comp);
    this.clean.connect(this.comp);
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.35;
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
    this.pre.gain.setTargetAtTime(1 + d * 5, t, 0.03);
    this.post.gain.setTargetAtTime(1 / (1 + d * 1.6), t, 0.03);
  }

  /** A buoy: two detuned saws that stay silent until the water moves them. */
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
    filter.Q.value = 1;
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
      v.vca.gain.setTargetAtTime(l * l * 0.09, t, 0.03);
      v.filter.frequency.setTargetAtTime(300 + 2400 * l, t, 0.04);
      const cents = (tilts[i] || 0) * 14;
      v.a.detune.setTargetAtTime(cents - this.p.detune / 2, t, 0.03);
      v.b.detune.setTargetAtTime(cents + this.p.detune / 2, t, 0.03);
    });
  }

  /** One saw-pair voice through its own filter and envelope, into the main bus. */
  voice(freq, { level, cutoff, snap, attack }) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const p = this.p;
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.type = b.type = 'sawtooth';
    a.frequency.value = b.frequency.value = freq;
    a.detune.value = -p.detune / 2;
    b.detune.value = p.detune / 2;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = p.resonance;
    filter.frequency.setValueAtTime(Math.min(15000, cutoff * snap), t);
    filter.frequency.exponentialRampToValueAtTime(cutoff, t + 0.45);
    const vca = ctx.createGain();
    vca.gain.setValueAtTime(0.0001, t);
    vca.gain.exponentialRampToValueAtTime(level, t + attack);
    vca.gain.setTargetAtTime(level * 0.75, t + attack, 0.3);
    a.connect(filter);
    b.connect(filter);
    filter.connect(vca);
    vca.connect(this.bus);
    a.start(t);
    b.start(t);
    return { oscs: [a, b], filter, vca, nodes: [a, b, filter, vca] };
  }

  /** Start a held chord: frequencies with the bass first. `id` releases it later. */
  chordOn(id, freqs) {
    if (!this.ctx) return;
    this.noteOff(id, true);
    const t = this.ctx.currentTime;
    const p = this.p;
    const voices = freqs.map((f, i) =>
      this.voice(f, { level: i === 0 ? 0.11 : 0.075, cutoff: p.cutoff, snap: 2.5, attack: 0.012 })
    );

    // sub: a clean sine under the bass note
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = Math.max(30, freqs[0] / 2);
    const subVca = this.ctx.createGain();
    subVca.gain.setValueAtTime(0.0001, t);
    subVca.gain.exponentialRampToValueAtTime(0.0001 + 0.35 * p.sub, t + 0.02);
    sub.connect(subVca);
    subVca.connect(this.clean);
    sub.start(t);
    voices.push({ oscs: [sub], vca: subVca, nodes: [sub, subVca] });

    // a soft thump on the attack
    if (p.punch > 0.01) {
      const k = this.ctx.createOscillator();
      k.type = 'sine';
      k.frequency.setValueAtTime(120, t);
      k.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      const kg = this.ctx.createGain();
      kg.gain.setValueAtTime(0.0001, t);
      kg.gain.exponentialRampToValueAtTime(0.6 * p.punch, t + 0.005);
      kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      k.connect(kg);
      kg.connect(this.clean);
      k.start(t);
      k.stop(t + 0.4);
      k.onended = () => { k.disconnect(); kg.disconnect(); };
    }

    this.held.set(id, voices);
  }

  /** Start a held single note: a plucky lead. */
  noteOn(id, freq) {
    if (!this.ctx) return;
    this.noteOff(id, true);
    const v = this.voice(freq, { level: 0.1, cutoff: Math.min(4000, this.p.cutoff * 1.6), snap: 2.2, attack: 0.006 });
    v.vca.gain.setTargetAtTime(0.055, this.ctx.currentTime + 0.05, 0.25); // settles lower: a pluck, then a tail
    this.held.set(id, [v]);
  }

  /** Release whatever `id` started (a chord or a note). */
  noteOff(id, fast = false) {
    const voices = this.held.get(id);
    if (!voices || !this.ctx) return;
    this.held.delete(id);
    const t = this.ctx.currentTime;
    const rel = fast ? 0.03 : Math.max(0.03, this.p.release);
    voices.forEach((v) => {
      hold(v.vca.gain, t);
      v.vca.gain.setTargetAtTime(0, t, rel / 4);
      if (v.filter) {
        hold(v.filter.frequency, t);
        v.filter.frequency.setTargetAtTime(Math.max(120, this.p.cutoff * 0.5), t, rel / 3);
      }
      v.oscs.forEach((o) => o.stop(t + rel * 1.6));
      v.oscs[0].onended = () => v.nodes.forEach((n) => n.disconnect());
    });
  }

  releaseAll() {
    [...this.held.keys()].forEach((id) => this.noteOff(id));
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
    g.gain.exponentialRampToValueAtTime(0.14 * s + 0.01, t + 0.004);
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
    if ('drive' in values) this.applyDrive();
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
