// Hover effect for the Ripples card: rings spread from under the pointer
// across the card, fading as they grow, the way the pool answers a drop.

const RING_EVERY = 110; // ms between new rings while the pointer moves
const LIFE = 1.8; // seconds a ring lasts
const SPEED = 170; // CSS px per second

export function waves(card, colour = '211, 236, 255') {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

  const canvas = document.createElement('canvas');
  canvas.className = 'card-under';
  canvas.setAttribute('aria-hidden', 'true');
  card.prepend(canvas);
  const ctx = canvas.getContext('2d');

  let rings = [];
  let running = false;
  let lastRing = 0;
  let last = 0;

  const size = () => {
    const d = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(card.clientWidth * d));
    canvas.height = Math.max(1, Math.round(card.clientHeight * d));
    ctx.setTransform(d, 0, 0, d, 0, 0);
  };
  size();
  new ResizeObserver(size).observe(card);

  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, card.clientWidth, card.clientHeight);
    rings = rings.filter((r) => (r.age += dt) < LIFE);
    for (const r of rings) {
      const t = r.age / LIFE;
      const radius = 6 + r.age * SPEED;
      // each drop is a few rings, like the real thing
      for (let k = 0; k < 3; k++) {
        const rr = radius - k * 14;
        if (rr <= 0) continue;
        ctx.beginPath();
        ctx.arc(r.x, r.y, rr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${colour}, ${((1 - t) * (1 - k * 0.3) * 0.55 * r.strength).toFixed(3)})`;
        ctx.lineWidth = 1.5 - k * 0.3;
        ctx.stroke();
      }
    }
    if (rings.length) requestAnimationFrame(frame);
    else running = false;
  };

  const ring = (e, strength = 1) => {
    const box = card.getBoundingClientRect();
    rings.push({ x: e.clientX - box.left, y: e.clientY - box.top, age: 0, strength });
    if (!running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    }
  };

  card.addEventListener('pointerenter', (e) => ring(e));
  card.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastRing < RING_EVERY) return;
    lastRing = now;
    ring(e, 0.6);
  });
  card.addEventListener('pointerdown', (e) => ring(e, 1.2));

  // a drop in the middle, for when the card is opened without a pointer (keyboard)
  return () => {
    const box = card.getBoundingClientRect();
    ring({ clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }, 1.2);
  };
}
