// Level-meter scramble: on hover a label's letters turn into meter bars of
// random height and settle back into the word from left to right.
//
// The bars are drawn in CSS over each letter while the letter itself is made
// transparent (scramble.css). Nothing about the text changes, so the label
// never reflows, never changes width and never falls back to another font --
// the usual causes of a scramble looking glitchy.

const DURATION = 440; // ms until the last letter has settled
const SWAP_EVERY = 70; // ms between new bar heights; faster reads as flicker

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {HTMLElement} el      element whose text is scrambled (text only)
 * @param {HTMLElement} trigger element whose hover / keyboard focus starts it
 */
export function scramble(el, trigger = el) {
  const text = el.textContent;
  el.textContent = '';
  const letters = [];
  for (const ch of text) {
    const span = document.createElement('span');
    span.textContent = ch;
    if (/[\p{L}\p{N}]/u.test(ch)) {
      span.className = 'scr';
      letters.push(span);
    }
    el.appendChild(span);
  }

  let running = false;
  const run = () => {
    if (running || reduced() || !letters.length) return;
    running = true;
    const t0 = performance.now();
    let lastSwap = -Infinity;
    const step = (now) => {
      const p = (now - t0) / DURATION;
      const swap = now - lastSwap >= SWAP_EVERY;
      if (swap) lastSwap = now;
      letters.forEach((span, i) => {
        // everything scrambles at once, then settles left to right
        const settleAt = 0.2 + (0.8 * (i + 1)) / letters.length;
        if (p >= settleAt) {
          span.classList.remove('bar');
        } else {
          span.classList.add('bar');
          if (swap) span.style.setProperty('--lvl', (0.25 + Math.random() * 0.75).toFixed(2));
        }
      });
      if (p < 1) requestAnimationFrame(step);
      else {
        letters.forEach((span) => span.classList.remove('bar'));
        running = false;
      }
    };
    requestAnimationFrame(step);
  };

  trigger.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') run(); });
  trigger.addEventListener('focusin', () => { if (trigger.matches(':focus-visible') || el.matches(':focus-visible')) run(); });
}
