// Minimal 16-bit PCM mono WAV encoder.
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * 2, true);

  let off = 44;
  for (let i = 0; i < n; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
