// Live audio capture and real-time spectrum.
//
// Two AnalyserNodes are read per column and blended by frequency: the short
// window keeps transients sharp at the top end, the long one actually resolves
// bass. That mirrors the multi-resolution STFT the offline path uses, so live
// terrain looks like file terrain rather than a different instrument.

const SHORT = 4096;
const LONG = 16384;
const FLOOR_DB = -140;

function freqMap(scale, fmin, fmax) {
  if (scale === 'linear') return (u) => fmin + (fmax - fmin) * u;
  if (scale === 'mel') {
    const m = (f) => 2595 * Math.log10(1 + f / 700);
    const m0 = m(fmin);
    const m1 = m(fmax);
    return (u) => 700 * (Math.pow(10, (m0 + (m1 - m0) * u) / 2595) - 1);
  }
  const r = fmax / fmin;
  return (u) => fmin * Math.pow(r, u);
}

/** How each output column reads one analyser's linear bins. */
function colMap(N, sr, edges, centers, cols) {
  const binw = sr / N;
  const nb = N >> 1;
  const lo = new Int32Array(cols);
  const hi = new Int32Array(cols);
  const frac = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const i0 = Math.ceil(edges[c] / binw);
    const i1 = Math.floor(edges[c + 1] / binw);
    if (i1 >= i0 && i1 >= 0 && i0 <= nb) {
      lo[c] = Math.max(0, i0);
      hi[c] = Math.min(nb - 1, i1);
      frac[c] = -1;
    } else {
      const x = Math.min(nb - 2, Math.max(0, centers[c] / binw));
      lo[c] = Math.floor(x);
      hi[c] = Math.min(nb - 1, lo[c] + 1);
      frac[c] = x - lo[c];
    }
  }
  return { lo, hi, frac };
}

function pick(buf, map, c) {
  const { lo, hi, frac } = map;
  if (frac[c] < 0) {
    let s = 0;
    const a = lo[c];
    const b = hi[c];
    for (let i = a; i <= b; i++) {
      const v = buf[i];
      s += v > FLOOR_DB ? v : FLOOR_DB;
    }
    return s / (b - a + 1);
  }
  const f = frac[c];
  const a = buf[lo[c]] > FLOOR_DB ? buf[lo[c]] : FLOOR_DB;
  const b = buf[hi[c]] > FLOOR_DB ? buf[hi[c]] : FLOOR_DB;
  return a * (1 - f) + b * f;
}

export class LiveInput {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.nodes = null;
    this.map = null;
    this.label = '';
    this.active = false;
    this.onended = null;
  }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  /** mode: 'device' (getUserMedia) or 'share' (getDisplayMedia). */
  async start(mode, deviceId) {
    this.stop();

    // Leave the signal alone — these would otherwise reshape the spectrum.
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream;
    if (mode === 'share') {
      // Chrome only offers the audio checkbox when video is requested too; the
      // video track is kept (stopping it can end the session) but never read.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio });
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('No audio was shared — tick "Share tab audio" / "Share system audio" in the picker');
      }
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId }, ...audio } : audio,
      });
    }

    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.label = track.label || (mode === 'share' ? 'shared audio' : 'input device');
    track.addEventListener('ended', () => this.onended?.());

    const ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    await ctx.resume();

    this.wire(ctx.createMediaStreamSource(stream), true);
    return this.label;
  }

  /**
   * Analyse a node that is already playing (a file player's output) instead of
   * capturing a device. The node keeps its own connections; only the analysers
   * are attached to it, and detached again by stop().
   */
  async attach(ctx, node, label) {
    this.stop();
    this.ctx = ctx;
    await ctx.resume();
    this.label = label || 'audio';
    this.wire(node, false);
    return this.label;
  }

  wire(source, owned) {
    const ctx = this.ctx;
    const short = ctx.createAnalyser();
    const long = ctx.createAnalyser();
    short.fftSize = SHORT;
    long.fftSize = LONG;
    short.smoothingTimeConstant = 0; // smoothing is ours to control
    long.smoothingTimeConstant = 0;
    short.minDecibels = FLOOR_DB;
    long.minDecibels = FLOOR_DB;
    source.connect(short);
    source.connect(long);

    // Keeps the graph pulled without monitoring the input back out of the
    // speakers, which would feed back when the source is a microphone.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    short.connect(mute);
    mute.connect(ctx.destination);

    this.nodes = { source, short, long, mute, owned };
    this.bufShort = new Float32Array(short.frequencyBinCount);
    this.bufLong = new Float32Array(long.frequencyBinCount);
    this.map = null;
    this.active = true;
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.nodes) {
      const { source, short, long, mute, owned } = this.nodes;
      if (owned) source.disconnect();
      else {
        source.disconnect(short);
        source.disconnect(long);
      }
      short.disconnect();
      long.disconnect();
      mute.disconnect();
    }
    this.stream = null;
    this.nodes = null;
    this.active = false;
  }

  buildMap(cols, fmin, fmax, scale) {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const hi = Math.min(fmax, sr * 0.4975);
    const lo = Math.max(2, Math.min(fmin, hi * 0.5));
    const toF = freqMap(scale, lo, hi);

    const edges = new Float64Array(cols + 1);
    for (let c = 0; c <= cols; c++) edges[c] = toF(c / cols);
    const centers = new Float32Array(cols);
    for (let c = 0; c < cols; c++) centers[c] = toF((c + 0.5) / cols);

    const w = new Float32Array(cols);
    const l0 = Math.log2(SHORT);
    const l1 = Math.log2(LONG);
    for (let c = 0; c < cols; c++) {
      const bw = Math.max(1e-6, edges[c + 1] - edges[c]);
      const ideal = Math.log2((2 * sr) / bw);
      w[c] = ideal <= l0 ? 0 : ideal >= l1 ? 1 : (ideal - l0) / (l1 - l0);
    }
    this.map = { short: colMap(SHORT, sr, edges, centers, cols), long: colMap(LONG, sr, edges, centers, cols), w, centers, cols };
  }

  /** Latest spectrum as dB per column, into `out`. */
  read(out) {
    if (!this.active || !this.map) return false;
    const { short: ms, long: ml, w, cols } = this.map;
    this.nodes.short.getFloatFrequencyData(this.bufShort);
    this.nodes.long.getFloatFrequencyData(this.bufLong);
    for (let c = 0; c < cols; c++) {
      const a = pick(this.bufShort, ms, c);
      const b = pick(this.bufLong, ml, c);
      const v = a + (b - a) * w[c];
      out[c] = isFinite(v) ? v : FLOOR_DB;
    }
    return true;
  }
}
