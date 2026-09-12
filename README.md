# Spectral Relief

A 3D spectrogram built for looks rather than measurement: layered ridges of sound
rendered as terrain you can orbit, in the style of an old plotted relief map.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Using it

Drop an audio file or an image anywhere on the window (or use **Open audio / image**).
Drag to orbit, right-drag to pan, scroll to zoom. Space toggles playback.

### Audio

The file is analysed off the main thread with a multi-resolution STFT: wide FFT
windows where the display columns are narrow (low frequencies) and short windows
where they are wide (high frequencies), blended per column. Every slice averages
several overlapping frames, which is what keeps the surface smooth instead of
noisy. **FFT quality** trades time for fidelity — *Ultra* uses 1024/4096/16384
point windows at 8x overlap.

### Images

Dropping an image does two things at once: the picture becomes terrain, and it is
**always synthesized into audio automatically**, so it can be played back and
saved as a WAV without pressing anything.

**Source → Terrain from** picks which one you are looking at:

- **Image pixels** — brightness becomes height directly, the crisper of the two.
  Image x is time (the depth axis), image y is frequency, so the picture reads
  upright from the **Top down** camera view.
- **Synthesized audio** — the terrain is analysed back out of the generated
  audio, so what you see is literally what you hear.

The audio is a bank of sine partials, one per image row, log-spaced across the
frequency range. `Audio length`, `Synth dynamics` and `Synth partials` control it
and re-synthesize on change; `Min Hz` / `Max Hz` / `Frequency scale` are shared
with the analysis so the picture and its sound line up.

### Live input

**Source → Live: microphone / input** captures an input device; **Live: share tab
/ system** opens the browser's picker so you can share a tab or your whole system
audio. The terrain then generates continuously as sound arrives, newest ridge at
the front, and you can orbit and pan while it runs.

To visualise something already playing on the machine — Spotify, a game, a video
call — use the share option and tick *share system audio*, or capture a loopback
input device ("Stereo Mix", or a virtual cable). Note that a DRM-protected source
such as the Spotify *web player* tab may come through silent; the desktop app via
system audio does not have that problem.

The live path reads two `AnalyserNode`s per column — 4096 and 16384 — and blends
them by frequency, mirroring the multi-resolution STFT the offline path uses, so
the short window keeps transients sharp while the long one resolves bass. Level is
auto-gained against a running peak, so quiet passages still fill the height range.
**Window (s)** sets how much time the visible terrain spans, which is also what
sets the scroll rate. Both capture APIs need a secure context (localhost or HTTPS).

### Waterfall

**Waterfall → Scroll with audio** switches from showing the whole file at once to
a moving window that scrolls as the audio plays, newest ridge at the front. You
can still orbit and pan freely while it runs. **Loop** restarts playback at the
end so the waterfall runs continuously.

Because a window shows only part of the file, turning it on raises the analysis
time resolution automatically so one window still holds a full stack of ridges.
That resolution is capped at 3000 slices, so a very long track gets a coarser
window than a short one.

### Playback

The transport bar syncs a playhead through the terrain — **Cursor** highlights the
slice currently sounding, **Reveal** draws the terrain in as it plays. In
waterfall mode the leading edge is the playhead, so no cursor is drawn.

## Controls worth knowing

Most controls live under **Advanced**; the panel itself keeps only the ones that
change the picture a lot.

| Control | What it does |
| --- | --- |
| Ridge count | How many ridges are *drawn*, independent of the analysis. |
| Ridge depth | How far each ridge hangs below its own crest. 0 extrudes it to the floor. |
| Dynamic range | dB below the peak that maps to the floor. Lower = only the loud parts. |
| Tilt | dB per octave lift on high frequencies, to counter music's natural rolloff. |
| Contrast | Gamma on the heights. Above 1 flattens the quiet parts. |
| Cast shadows | Terrain self-shadowing, marched toward the light in the vertex shader. |
| Rim light | Grazing-angle sheen that picks crests out of the mass. |
| Render mode | Ridges (reference look), Lines (Joy Division), Surface (continuous mesh). |
| Render quality | Supersampling multiplier for crisper edges. |
| Frequency detail | Columns across the frequency axis (Advanced). |

## How it is put together

Heights live in a float texture rather than in vertex attributes. That is what
makes the waterfall cheap — scrolling is one uniform instead of re-uploading the
mesh — and it lets the drawn ridge count differ from the analysis resolution,
with smooth interpolation between slices.

Three things keep a full-length song workable:

- **Time resolution is automatic.** The full view never analyses more detail than
  the ridges it draws; only a waterfall window asks for more.
- **Frames per slice are capped at 10.** Averaging 60+ FFT frames per slice looks
  identical and costs six times as much.
- **Shaping runs in the worker** against a matrix that stays there, so dragging a
  slider never blurs millions of cells on the main thread, and nothing large is
  copied between threads.

A 4-minute track measures ~11s to load, analyse and draw, holding 49-62fps.

- `src/analysis.worker.js` — FFT, multi-resolution STFT, additive synthesis
- `src/relief.js` — Three.js scene, geometry and the relief shader
- `src/live.js` — live capture and the real-time dual-analyser spectrum
- `src/shape.js` — image sampling (canvas-bound, so it stays on the main thread)
- `src/presets.js` — look presets
- `src/main.js` — UI, sources, playback
