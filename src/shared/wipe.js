// Scanline wipe between the home page and the spectrogram: horizontal bands,
// like the scanlines in the home shader, close over the page, the next page
// loads underneath them, and they open onto it.

const BARS = 8;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function makeBars(closed) {
  const wrap = document.createElement('div');
  wrap.className = 'wipe' + (closed ? ' closed' : '');
  wrap.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < BARS; i++) {
    const bar = document.createElement('i');
    bar.style.top = `${(i * 100) / BARS}%`;
    wrap.appendChild(bar);
  }
  document.body.appendChild(wrap);
  return { wrap, bars: [...wrap.children] };
}

/** Close the bars, then navigate. */
export function wipeTo(url) {
  if (reduced()) {
    window.location.href = url;
    return;
  }
  const { wrap, bars } = makeBars(false);
  const closing = bars.map((bar, i) =>
    bar.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], {
      duration: 260,
      delay: i * 35,
      easing: 'cubic-bezier(.7,0,.3,1)',
      fill: 'forwards',
    }).finished
  );
  // Coming back with the Back button can restore this page from the cache
  // exactly as it was left, bars and all, so take them away then.
  window.addEventListener('pageshow', (e) => { if (e.persisted) wrap.remove(); }, { once: true });
  Promise.all(closing).then(() => {
    try { sessionStorage.setItem('sl-wipe', String(Date.now())); } catch { /* no storage: no wipe-in */ }
    window.location.href = url;
  });
}

/** Open the bars if public/wipe-in.js covered this page on arrival. */
export function wipeIn() {
  const root = document.documentElement;
  if (!root.classList.contains('wipe-in')) return;
  const { wrap, bars } = makeBars(true);
  root.classList.remove('wipe-in');
  const opening = bars.map((bar, i) =>
    bar.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(0)' }], {
      duration: 300,
      delay: 80 + i * 35,
      easing: 'cubic-bezier(.7,0,.3,1)',
      fill: 'forwards',
    }).finished
  );
  Promise.all(opening).then(() => wrap.remove());
}

/** Send a plain left-click on this link through the wipe; leave new-tab clicks alone. */
export function wipeLink(link, before) {
  link.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (link.target && link.target !== '_self') return;
    e.preventDefault();
    if (before) before();
    wipeTo(link.href);
  });
}
