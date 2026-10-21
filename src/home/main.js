import './bg.js';
import { dissolve } from './dissolve.js';
import { waves } from './waves.js';
import { scramble } from '../shared/scramble.js';
import { wipeIn, wipeLink } from '../shared/wipe.js';

wipeIn();

const card = document.querySelector('.tile-terrain');
const open = dissolve(card);
scramble(card.querySelector('.tool-footer span'), card);
wipeLink(card, open);

const land = document.querySelector('.tile-landscape');
scramble(land.querySelector('.tool-footer span'), land);
wipeLink(land);

// absent while Ripples is hidden (see SHOW_RIPPLES in vite.config.js)
const pool = document.querySelector('.tile-ripples');
if (pool) {
  const splash = waves(pool);
  scramble(pool.querySelector('.tool-footer span'), pool);
  wipeLink(pool, splash);
}

// Back from a tool via the browser cache: show the card as it was.
window.addEventListener('pageshow', (e) => { if (e.persisted) card.classList.remove('is-open'); });
