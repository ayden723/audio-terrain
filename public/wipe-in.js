// Runs in <head>, before first paint. If this page was reached through the
// scanline wipe, cover it with the closed bars straight away so it never
// flashes; src/shared/wipe.js then opens them once the page's code runs.
// Kept as a plain file (not bundled) so it can block rendering.
(function () {
  try {
    var t = Number(sessionStorage.getItem('sl-wipe'));
    sessionStorage.removeItem('sl-wipe');
    if (!t || Date.now() - t > 4000) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var root = document.documentElement;
    root.classList.add('wipe-in');
    // never leave the page covered if its code fails to load
    setTimeout(function () { root.classList.remove('wipe-in'); }, 2500);
  } catch (e) {
    /* storage blocked: just skip the effect */
  }
})();
