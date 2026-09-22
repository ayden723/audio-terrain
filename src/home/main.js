import './bg.js';
import { dissolve } from './dissolve.js';
import { loudness } from './loudness.js';
import { scramble } from '../shared/scramble.js';
import { wipeIn, wipeLink } from '../shared/wipe.js';

wipeIn();

loudness(document.querySelector('.hero h1'));

const card = document.querySelector('.tile-terrain');
const open = dissolve(card);
scramble(card.querySelector('.tool-footer span'), card);
wipeLink(card, open);

// Back from the spectrogram via the browser cache: show the card as it was.
window.addEventListener('pageshow', (e) => { if (e.persisted) card.classList.remove('is-open'); });
