/* ============================================================
   audio.js — load, decode, and play audio with the Web Audio API
   ------------------------------------------------------------
   The Web Audio API has no built-in "pause" for a playing buffer,
   so we track time manually:
     - `offset`    = where in the track we are (seconds)
     - `startTime` = the AudioContext clock value when playback began
   Current position = offset + (now - startTime) while playing.
   ============================================================ */

export class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.buffer = null;     // decoded AudioBuffer
    this.source = null;     // current BufferSource (recreated on each play)
    this.gain = this.ctx.createGain();

    // Live FFT for the waterfall mode. The analyser sits between the
    // source and the output, so it always "hears" what is playing now.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;             // -> 1024 frequency bins
    this.analyser.smoothingTimeConstant = 0.6;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);

    this.offset = 0;        // seconds into the track
    this.startTime = 0;     // ctx.currentTime when play() was called
    this.playing = false;

    this.onEnded = null;    // callback when track finishes naturally
  }

  /** Decode a File / Blob into an AudioBuffer. Returns the buffer. */
  async load(file) {
    const arrayBuffer = await file.arrayBuffer();
    // decodeAudioData supports whatever the browser supports
    // (WAV, MP3, M4A everywhere; FLAC/OGG in modern Chrome & Firefox).
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.offset = 0;
    this.playing = false;
    return this.buffer;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /** Current playback position in seconds. */
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
    if (this.ctx.state === 'suspended') this.ctx.resume();

    // A BufferSource is single-use, so we make a fresh one each time.
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.analyser);

    this.source.onended = () => {
      // Fires both on natural end and on manual stop(); only the
      // natural end should reset us, so we check the clock.
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

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  /** Jump to a position (seconds), keeping play/pause state. */
  seek(seconds) {
    const t = Math.max(0, Math.min(seconds, this.duration));
    const wasPlaying = this.playing;
    if (wasPlaying) this._stopSource();
    this.offset = t;
    this.playing = false;
    if (wasPlaying) this.play();
  }

  /** Live frequency spectrum (0..255 per bin) for the current moment. */
  getFrequencyData() {
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }

  get sampleRate() { return this.ctx.sampleRate; }

  _stopSource() {
    if (this.source) {
      this.source.onended = null; // avoid firing our handler on manual stop
      try { this.source.stop(); } catch (_) {}
      this.source.disconnect();
      this.source = null;
    }
  }
}
