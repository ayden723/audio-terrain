// Live audio capture and real-time spectrum.
//
// Two AnalyserNodes are read per column and blended by frequency: the short
// window keeps transients sharp at the top end, the long one actually resolves
// bass. That mirrors the multi-resolution STFT the offline path uses, so live
// terrain looks like file terrain rather than a different instrument.

import { bandAxis, columnMap, sizeBlend } from './shared/freq.js';

const SHORT = 4096;
const LONG = 16384;
export const FLOOR_DB = -140;

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

    const source = ctx.createMediaStreamSource(stream);
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

    this.nodes = { source, short, long, mute };
    this.bufShort = new Float32Array(short.frequencyBinCount);
    this.bufLong = new Float32Array(long.frequencyBinCount);
    this.map = null;
    this.active = true;
    return this.label;
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.nodes) {
      const { source, short, long, mute } = this.nodes;
      source.disconnect();
      short.disconnect();
      long.disconnect();
      mute.disconnect();
    }
    this.stream = null;
    this.nodes = null;
    this.active = false;
    // nothing is listening any more, so stop the audio clock (start() resumes it)
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  buildMap(cols, fmin, fmax, scale) {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const { edges, centers } = bandAxis(cols, scale, fmin, fmax, sr);
    // an AnalyserNode has no Nyquist bin, so its highest is N/2 - 1
    this.map = {
      short: columnMap(SHORT, sr, edges, centers, cols, SHORT / 2 - 1),
      long: columnMap(LONG, sr, edges, centers, cols, LONG / 2 - 1),
      w: sizeBlend([SHORT, LONG], sr, edges, cols),
      centers,
      cols,
    };
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
