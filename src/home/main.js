import './bg.js';
import { dissolve } from './dissolve.js';
import { contours } from './contours.js';
import { scramble } from '../shared/scramble.js';
import { wipeIn, wipeLink } from '../shared/wipe.js';

wipeIn();

const card = document.querySelector('.tile-terrain');
const open = dissolve(card);
scramble(card.querySelector('.tool-footer span'), card);
wipeLink(card, open);

const land = document.querySelector('.tile-landscape');
const drain = contours(land);
scramble(land.querySelector('.tool-footer span'), land);
wipeLink(land, drain);

// Back from a tool via the browser cache: show the card as it was.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  card.classList.remove('is-open');
  drain.reset();
});
