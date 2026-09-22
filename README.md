# Audio Terrain

A 3D spectrogram built for looks rather than measurement: layered ridges of sound
rendered as terrain you can orbit, in the style of an old plotted relief map.
It is part of **Sound Labs**: the home page at `/` (with the animated background)
links to the spectrogram at `/terrain/`.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173 for the home page, or http://localhost:5173/terrain/
for the spectrogram.

## Deploying

Push to `main`. Cloudflare Workers Builds installs the dependencies and runs
`npx wrangler deploy`, which first runs the build in `wrangler.jsonc`
(`npm run build`) and then publishes `dist/` to the `audio-terrain` Worker. There is nothing to copy by hand.

## Using it

Drop an audio file or an image anywhere on the window (or use **Open audio / image**).
Drag to orbit, right-drag to pan, scroll to zoom. `Space` plays and pauses; `P` toggles presentation mode.

### Audio

The file is analysed off the main thread with a multi-resolution STFT: wide FFT
windows where the display columns are narrow (low frequencies) and short windows
where they are wide (high frequencies), blended per column. Every slice averages
several overlapping frames, which is what keeps the surface smooth instead of
noisy. **FFT quality** trades time for fidelity — *Ultra* uses 1024/4096/16384
point windows at 8x overlap.

### Long files

A loaded audio file is fitted to its length. Up to about 20 seconds the defaults
are kept as they are. Past that, the ridge count and the depth of the time axis
grow with the song (gently, so a ten-minute track doesn't turn into a corridor),
each ridge is analysed as exactly its own slice of time, and anything longer than
45 seconds opens in the **Timeline** view: time runs left to right across the
screen with the bass range behind it, so the shape of the whole song reads at a
glance. A 3-minute song gets about 420 ridges over a depth of 20.

Only the ridge count, depth and view are fitted. Change any of them by hand and
it stays yours: later fits leave it alone until **Reset settings**. Live input
and images are never fitted, and switching to them returns those settings to
what they were before the file was loaded. The camera is always framed from the
terrain's actual bounds, and changing width or depth reframes it without
changing your viewing angle.

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

### Presentation mode

**Present** (or `P`) hides every control and shows only the terrain, for a
projector or a second screen. It goes fullscreen, keeps the display awake with
the Screen Wake Lock API where the browser supports it, hides the cursor after two
seconds without movement, and drops the paper grain and vignette, which only crush
shadow detail that projectors already struggle to show. `Esc` or `P` again leaves
it; `Space` still plays and pauses. Tune the look first — presentation mode shows
exactly what you set.

### Auto move

**Camera → Auto move** orbits the terrain while also swaying the elevation and
slowly breathing the zoom, so the view keeps changing rather than just spinning.
At the default speed it orbits once every 30 seconds; **Motion speed** scales all
of it together. The motion is applied as small per-frame changes around whatever
framing you chose, eases in instead of starting abruptly, and hands the camera
back the moment you drag, resuming a couple of seconds after you let go.

### Loading

Loading names each step (decoding, then each FFT size as it runs) and a newly
loaded source draws itself in: ridges rise one after another, nearest first.
Changing a setting afterwards updates the terrain in place.

### Reset

**Reset settings** restores every look and analysis setting to its default
without unloading your source, then offers **Undo** for a few seconds — including
the camera position.

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

- `index.html`, `src/home/` — the Sound Labs home page: animated background
  and the card's pixel dissolve
- `src/shared/` — the level-meter label scramble and the scanline wipe between pages
- `public/wipe-in.js` — covers a page before first paint when it is reached through the wipe
- `terrain/index.html` — the spectrogram page
- `public/_headers` — security headers applied to every response
- `src/analysis.worker.js` — FFT, multi-resolution STFT, additive synthesis
- `src/relief.js` — Three.js scene, geometry and the relief shader
- `src/live.js` — live capture and the real-time dual-analyser spectrum
- `src/shape.js` — image sampling (canvas-bound, so it stays on the main thread)
- `src/presets.js` — look presets
- `src/main.js` — UI, sources, playback
