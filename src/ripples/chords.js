// What the keys play. Deliberately small, so everything sounds good together:
//
// - five chord keys (left hand) play a progression that works in any order,
//   voiced close together around middle C over a bass note, so moving between
//   them is smooth rather than jumpy;
// - five note keys (right hand) play the pentatonic scale of the same key,
//   which fits over every one of those chords.

export const MOODS = {
  // i  VI  III  VII  iv   (Dm B♭ F C Gm in D)
  Minor: { scale: [0, 2, 3, 5, 7, 8, 10], degrees: [0, 5, 2, 6, 3], penta: [0, 3, 5, 7, 10] },
  // I  V  vi  IV  ii     (D A Bm G Em in D)
  Major: { scale: [0, 2, 4, 5, 7, 9, 11], degrees: [0, 4, 5, 3, 1], penta: [0, 2, 4, 7, 9] },
};

export const KEYS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// Physical key positions (KeyboardEvent.code), so the layout holds on any keyboard language.
export const CHORD_KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG'];
export const NOTE_KEYS = ['KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'];

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const midiName = (m) => `${KEYS[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
export const keyLabel = (code) => (code === 'Semicolon' ? ';' : code.replace('Key', ''));

/** The i-th chord key: a bass note plus three close voices, and a name like "Dm". */
export function chordAt(i, mood, key) {
  const m = MOODS[mood] || MOODS.Minor;
  const d = m.degrees[i];
  const pcs = [0, 2, 4].map((step) => (key + m.scale[(d + step) % 7]) % 12);

  // each chord tone goes to whichever octave sits closest to middle C,
  // which keeps every chord in the same place under the hands
  const upper = pcs.map((pc) => {
    let n = 60 + pc;
    while (n - 62 > 6) n -= 12;
    while (62 - n > 6) n += 12;
    return n;
  }).sort((a, b) => a - b);
  let bass = 36 + pcs[0];
  if (bass > 47) bass -= 12;

  const third = (pcs[1] - pcs[0] + 12) % 12;
  const fifth = (pcs[2] - pcs[0] + 12) % 12;
  const quality = third === 3 ? (fifth === 6 ? '°' : 'm') : '';
  return { notes: [bass, ...upper], root: pcs[0], name: KEYS[pcs[0]] + quality, index: i };
}

/** The i-th note key: the pentatonic scale, from the key's root around middle C upwards. */
export function noteAt(i, mood, key) {
  const m = MOODS[mood] || MOODS.Minor;
  let base = 60 + key;
  if (key > 6) base -= 12;
  const n = base + m.penta[i];
  return { note: n, name: midiName(n), index: i };
}
