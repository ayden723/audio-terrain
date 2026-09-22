// A short synthetic "music-like" bed so the app has something to show on load:
// four chords of harmonic tones, a kick pulse and hat noise.

export function makeDemo(sampleRate = 44100, duration = 14) {
  const n = Math.round(sampleRate * duration);
  const out = new Float32Array(n);
  const chords = [
    [48, 55, 60, 64, 72],
    [45, 52, 57, 60, 69],
    [41, 48, 53, 57, 65],
    [43, 50, 55, 59, 67],
  ];
  const bar = duration / chords.length;

  for (let ci = 0; ci < chords.length; ci++) {
    const t0 = ci * bar;
    const s0 = Math.round(t0 * sampleRate);
    const s1 = Math.min(n, Math.round((t0 + bar * 1.04) * sampleRate));
    for (const midi of chords[ci]) {
      const f0 = 440 * Math.pow(2, (midi - 69) / 12);
      const partials = Math.max(4, Math.min(24, Math.floor(sampleRate * 0.45 / f0)));
      for (let h = 1; h <= partials; h++) {
        const f = f0 * h;
        if (f > sampleRate * 0.47) break;
        const amp = 0.16 / Math.pow(h, 1.35) / chords[ci].length;
        const w = (2 * Math.PI * f) / sampleRate;
        const vibW = (2 * Math.PI * (4.5 + (h % 3))) / sampleRate;
        const vibD = 0.0025 * h;
        const phase0 = Math.random() * Math.PI * 2;
        for (let i = s0; i < s1; i++) {
          const t = (i - s0) / sampleRate;
          const env = Math.min(1, t / 0.04) * Math.exp(-t * (0.5 + h * 0.06));
          if (env < 1e-4) break;
          out[i] += amp * env * Math.sin(w * (i - s0) + phase0 + vibD * Math.sin(vibW * (i - s0)));
        }
      }
    }
  }

  // kick every half second
  for (let t = 0; t < duration; t += 0.5) {
    const s0 = Math.round(t * sampleRate);
    let ph = 0;
    for (let i = 0; i < sampleRate * 0.4 && s0 + i < n; i++) {
      const tt = i / sampleRate;
      const f = 45 + 95 * Math.exp(-tt * 28);
      ph += (2 * Math.PI * f) / sampleRate;
      out[s0 + i] += 0.5 * Math.exp(-tt * 7) * Math.sin(ph);
    }
  }

  // hats on the offbeat
  let hp = 0;
  for (let t = 0.25; t < duration; t += 0.5) {
    const s0 = Math.round(t * sampleRate);
    for (let i = 0; i < sampleRate * 0.09 && s0 + i < n; i++) {
      const tt = i / sampleRate;
      const nz = Math.random() * 2 - 1;
      const hi = nz - hp;
      hp = nz;
      out[s0 + i] += 0.12 * Math.exp(-tt * 52) * hi;
    }
  }

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) {
    const g = 0.92 / peak;
    for (let i = 0; i < n; i++) out[i] *= g;
  }
  return { samples: out, sampleRate };
}
