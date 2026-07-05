/* ============================================================
   audio.js — stereo audio for the vector scope
   ------------------------------------------------------------
   Two sources can feed the scope:

   1. A decoded audio file:
        source ─┬─ splitter ─┬─ analyserL   (left  → X)
                │            └─ analyserR   (right → Y)
                └─ gain ─ destination       (what you hear)

   2. The lissajous synth — two oscillators:
        oscX ─ gainX ─┬─ analyserL ─ merger(L) ─ master ─ out
        oscY ─ delay ─┴─ analyserR ─ merger(R) ─┘
      oscX is heard in the left ear and drives X; oscY in the
      right ear drives Y. A DelayNode gives oscY its phase
      offset (delay = phase / (2π·f), a pure phase shift for
      a sine of frequency f).

   Play/pause bookkeeping is the same trick as the terrain tool:
   current position = offset + (now − startTime) while playing.
   ============================================================ */

const FFT_SIZE = 4096; // must be ≥ the largest framesize (3072)

export class ScopeAudio {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    // The two analysers the scope reads. Everything routes through them.
    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    this.analyserL.fftSize = FFT_SIZE;
    this.analyserR.fftSize = FFT_SIZE;
    // No smoothing — the scope wants the raw waveform, not an average.
    this.dataL = new Float32Array(FFT_SIZE);
    this.dataR = new Float32Array(FFT_SIZE);

    // --- file playback chain ---
    this.buffer = null;
    this.source = null;
    this.splitter = this.ctx.createChannelSplitter(2);
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);

    this.offset = 0;
    this.startTime = 0;
    this.playing = false;
    this.onEnded = null;

    // --- synth chain (built lazily on first start) ---
    this.synthRunning = false;
    this.oscX = null;
    this.oscY = null;
    this.phaseDelay = null;
    this.synthGain = null;

    this._playThroughSilentSwitch();
  }

  /* iOS: play through the hardware silent switch, like a media app. */
  _playThroughSilentSwitch() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (_) { /* older browsers: leave default behavior */ }
  }

  /* ---------------- file mode ---------------- */

  async load(file) {
    const arrayBuffer = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.offset = 0;
    this.playing = false;
    return this.buffer;
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }

  getTime() {
    if (!this.buffer) return 0;
    if (this.playing) {
      const t = this.offset + (this.ctx.currentTime - this.startTime);
      return Math.min(t, this.duration);
    }
    return this.offset;
  }

  play() {
    if (!this.buffer || this.playing) return;
    this._playThroughSilentSwitch();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;

    // Stereo files: split into L/R. Mono files: the same signal drives
    // both axes, which correctly draws mono as a diagonal line.
    if (this.buffer.numberOfChannels >= 2) {
      this.source.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
    } else {
      this.source.connect(this.analyserL);
      this.source.connect(this.analyserR);
    }
    this.source.connect(this.gain);

    this.source.onended = () => {
      if (!this.playing) return;
      if (this.getTime() >= this.duration - 0.05) {
        this.playing = false;
        this.offset = 0;
        if (this.onEnded) this.onEnded();
      }
    };

    this.source.start(0, this.offset);
    this.startTime = this.ctx.currentTime;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.getTime();
    this.playing = false;
    this._stopSource();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(seconds) {
    const t = Math.max(0, Math.min(seconds, this.duration));
    const wasPlaying = this.playing;
    if (wasPlaying) this._stopSource();
    this.offset = t;
    this.playing = false;
    if (wasPlaying) this.play();
  }

  _stopSource() {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch (_) {}
      this.source.disconnect();
      this.source = null;
    }
  }

  /* ---------------- synth (lissajous) mode ---------------- */

  startSynth({ freq, ratio, phaseDeg, volume }) {
    if (this.synthRunning) this.stopSynth();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this._playThroughSilentSwitch();

    // The synth's *picture* is drawn from the equations directly (see
    // main.js) — these oscillators are only the sound. X leans into the
    // left ear, Y into the right; 70% pan keeps it comfortable on
    // headphones instead of hard-split.
    this.synthGain = this.ctx.createGain();
    this.synthGain.gain.value = volume;

    this.oscX = this.ctx.createOscillator();
    this.oscY = this.ctx.createOscillator();
    this.oscX.frequency.value = freq;
    this.oscY.frequency.value = freq * ratio;

    // Phase offset for Y: a short delay. For a sine at frequency f,
    // delaying by phase/(2π·f) shifts it by exactly that phase.
    this.phaseDelay = this.ctx.createDelay(1);
    this._setPhase(phaseDeg, freq * ratio);

    this.panX = this.ctx.createStereoPanner();
    this.panY = this.ctx.createStereoPanner();
    this.panX.pan.value = -0.7;
    this.panY.pan.value = 0.7;

    this.oscX.connect(this.panX);
    this.oscY.connect(this.phaseDelay);
    this.phaseDelay.connect(this.panY);
    this.panX.connect(this.synthGain);
    this.panY.connect(this.synthGain);
    this.synthGain.connect(this.ctx.destination);

    this.oscX.start();
    this.oscY.start();
    this.synthRunning = true;
  }

  updateSynth({ freq, ratio, phaseDeg, volume }) {
    if (!this.synthRunning) return;
    const t = this.ctx.currentTime;
    const fy = freq * ratio;
    // setTargetAtTime = smooth, click-free parameter changes
    this.oscX.frequency.setTargetAtTime(freq, t, 0.02);
    this.oscY.frequency.setTargetAtTime(fy, t, 0.02);
    this.synthGain.gain.setTargetAtTime(volume, t, 0.02);
    this._setPhase(phaseDeg, fy);
  }

  _setPhase(phaseDeg, freqY) {
    const seconds = (phaseDeg / 360) / Math.max(freqY, 1);
    this.phaseDelay.delayTime.setTargetAtTime(seconds, this.ctx.currentTime, 0.02);
  }

  stopSynth() {
    if (!this.synthRunning) return;
    try { this.oscX.stop(); this.oscY.stop(); } catch (_) {}
    this.oscX.disconnect();
    this.oscY.disconnect();
    this.phaseDelay.disconnect();
    this.panX.disconnect();
    this.panY.disconnect();
    this.synthGain.disconnect();
    this.oscX = this.oscY = this.phaseDelay = this.panX = this.panY = this.synthGain = null;
    this.synthRunning = false;
  }

  /* ---------------- what the scope reads ---------------- */

  /** Fills and returns the latest L/R waveforms (−1..1 per sample). */
  getWaveforms() {
    this.analyserL.getFloatTimeDomainData(this.dataL);
    this.analyserR.getFloatTimeDomainData(this.dataR);
    return { left: this.dataL, right: this.dataR };
  }
}
