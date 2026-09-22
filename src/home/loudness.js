// Loudness weight: each letter of the headline is as heavy as a sound peak
// passing through the word. The peak follows the pointer; with no pointer
// nearby it drifts slowly back and forth on its own.

const MIN_W = 250;
const MAX_W = 900;

export function loudness(h1) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const text = h1.textContent;
  h1.setAttribute('aria-label', text);
  h1.textContent = '';
  const spans = [...text].map((ch) => {
    const s = document.createElement('span');
    s.textContent = ch;
    s.setAttribute('aria-hidden', 'true');
    h1.appendChild(s);
    return s;
  });
  h1.classList.add('loudness');

  // Letter centres are measured once at an even weight rather than every frame:
  // reading layout while writing weights would force a reflow per frame.
  let centres = [];
  let width = 1;
  const measure = () => {
    spans.forEach((s) => s.style.setProperty('--w', 575));
    const box = h1.getBoundingClientRect();
    width = Math.max(1, box.width);
    centres = spans.map((s) => {
      const r = s.getBoundingClientRect();
      return r.left + r.width / 2 - box.left;
    });
  };

  let pointerX = null; // relative to the headline, or null when far away
  let peak = 0.5; // eased peak position, 0..1 across the headline
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const box = h1.getBoundingClientRect();
    const near = e.clientY > box.top - 160 && e.clientY < box.bottom + 160;
    pointerX = near ? (e.clientX - box.left) / width : null;
  });
  document.addEventListener('pointerleave', () => { pointerX = null; });

  let visible = true;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(h1);

  const t0 = performance.now();
  const frame = (now) => {
    requestAnimationFrame(frame);
    if (!visible || !centres.length) return;
    const sweep = 0.5 + 0.55 * Math.sin((now - t0) / 1500);
    const target = pointerX ?? sweep;
    peak += (target - peak) * 0.14; // eased, so pointer <-> sweep never jumps
    const x = peak * width;
    const spread = Math.max(60, width * 0.2);
    spans.forEach((s, i) => {
      const d = (centres[i] - x) / spread;
      s.style.setProperty('--w', Math.round(MIN_W + (MAX_W - MIN_W) * Math.exp(-d * d * 2)));
    });
  };

  const start = () => {
    measure();
    requestAnimationFrame(frame);
  };
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(start);
  let t = 0;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(measure, 150); });
}
