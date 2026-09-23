// Chords for the letter keys, built from the current key and mode.
// Home row: the seven triads of the key. Top row: the same degrees as
// seventh chords. Bottom row: power chords (root, fifth, octave), an
// octave lower, for the heavy end.

export const MODES = {
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  'Harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Major: [0, 2, 4, 5, 7, 9, 11],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
};

export const KEYS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// Physical key positions (KeyboardEvent.code), so the layout holds on any keyboard language.
export const ROWS = [
  { kind: 'seventh', codes: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU'] },
  { kind: 'triad', codes: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'] },
  { kind: 'power', codes: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'] },
];

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * The chord for one key: its notes as MIDI numbers and a name like "Dm7".
 * `key` is a pitch class (0 = C), `octave` shifts everything by octaves.
 */
export function chordFor(kind, index, mode, key, octave) {
  const s = MODES[mode] || MODES.Minor;
  const degree = index % 7;
  const up = index >= 7 ? 12 : 0; // the eighth home-row key: the home chord an octave up
  const at = (d) => s[d % 7] + 12 * Math.floor(d / 7);
  const base = 48 + key + 12 * octave + up; // C3 + key
  const root = base + at(degree);

  let notes;
  if (kind === 'power') {
    const r = root - 12;
    notes = [r, base - 12 + at(degree + 4), r + 12];
  } else {
    notes = [root, base + at(degree + 2), base + at(degree + 4)];
    if (kind === 'seventh') notes.push(base + at(degree + 6));
  }
  return { notes, freqs: notes.map(midiToHz), name: nameOf(kind, notes), degree };
}

function nameOf(kind, notes) {
  const rootName = KEYS[((notes[0] % 12) + 12) % 12];
  if (kind === 'power') return `${rootName}5`;
  const third = notes[1] - notes[0];
  const fifth = notes[2] - notes[0];
  let q = third === 3 ? (fifth === 6 ? '°' : 'm') : fifth === 8 ? '+' : '';
  if (kind === 'seventh') {
    const sev = notes[3] - notes[0];
    if (q === '') q = sev === 11 ? 'maj7' : '7';
    else if (q === 'm') q = sev === 11 ? 'm(maj7)' : 'm7';
    else if (q === '°') q = sev === 9 ? '°7' : 'ø7';
    else q = sev === 11 ? '+maj7' : '+7';
  }
  return rootName + q;
}

export const keyLabel = (code) => code.replace('Key', '');
