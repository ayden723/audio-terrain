// Off the main thread: turn amplitudes into audio, then analyse that audio
// straight back, so the page shows what the sound actually contains.

import { plan, synthesize, analyse } from './dsp.js';

self.onmessage = (e) => {
  const { id, rows, cols, precision, amps } = e.data;
  try {
    const p = plan(rows, cols, precision);
    const progress = (stage, f) => self.postMessage({ id, type: 'progress', stage, f });
    const { samples, gain } = synthesize(p, amps, (f) => progress('Synthesizing', f));
    const measured = analyse(p, samples, gain, (f) => progress('Analysing the audio', f));
    self.postMessage({ id, type: 'done', samples, measured }, [samples.buffer, measured.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err.message });
  }
};
