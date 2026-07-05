# Sound Lab

A playground of audio-visual tools. The home page (`index.html`) is a
coolors-style grid of tool cards; each tool lives in its own folder.

| Tool | Folder | Status |
|------|--------|--------|
| Audio Terrain | `terrain/` | live |
| Vector Scope (XY oscilloscope + lissajous synth) | `scope/` | live |
| Hear the Earth (real elevation → sound) | `earth/` | live |

## Audio Terrain

Upload an audio file and explore it as a 3D landscape sculpted from sound.

- **X axis** = time
- **Y axis (height)** = amplitude / loudness
- **Z axis (depth)** = frequency (logarithmic scale)
- **Color** = loudness, on a smooth *navy → purple → cyan → yellow → white* gradient

Everything runs locally in your browser. The audio never leaves your machine.

## Running it

You need a local web server (browsers block ES modules and audio decoding
over `file://`). Python is the simplest:

```bash
cd audio_terrain
python -m http.server 8000
```

Then open <http://127.0.0.1:8000> and drop in an audio file
(WAV, MP3, FLAC, M4A, OGG — whatever your browser can decode).

## Controls

- **Drag** to orbit the camera
- **Scroll** to zoom
- **Play / pause**, **seek bar**, and the glowing **playback cursor** that
  sweeps across the terrain show where the sound currently is
- **View mode** dropdown:
  - **Landscape** — the whole track precomputed as one explorable terrain
  - **Waterfall** — a live view that generates the spectrogram in real time
    as the audio plays; new sound appears at the front edge and flows backward
    (loops automatically when the track ends)
  - **Print model** — a watertight relief tile you can export and 3D print
- **Color mode** dropdown — Aurora, Magma, Ice, Ember, Moonlight

## 3D printing

Switch to **Print model** to preview the exact solid that will print: a flat
plinth with the spectrogram raised on top, sealed into a watertight,
manifold (genus-0) mesh — so it prints base-down with no supports.

- **Size** slider sets the real width in millimetres (depth/height scale with it)
- **Smoothing** slider rounds off thin spikes so features are printable
- **Export STL** downloads a binary STL that drops straight into any slicer
  (Cura, PrusaSlicer, Bambu Studio) at real-world size

## Visual style

- Bloom (cinematic glow on bright peaks and the playhead)
- ACES filmic tone mapping for richer, graded color
- Gradient sky + drifting particles for atmospheric depth

## How it's built

No build step, no framework — just HTML, CSS, and a few small JS modules.
All paths below live inside `terrain/`.

| File | Job |
|------|-----|
| `index.html` | Page structure, UI, and the Three.js import map |
| `style.css` | Dark, minimal interface |
| `js/audio.js` | Load / decode / play / pause / seek + live analyser |
| `js/spectrogram.js` | FFT → log-frequency loudness grid (the analysis) |
| `js/terrain.js` | Landscape mesh, height displacement, and cursor |
| `js/waterfall.js` | Live scrolling spectrogram (waterfall mode) |
| `js/printmodel.js` | Watertight relief-tile solid + binary STL export |
| `js/palettes.js` | Shared color ramps used by both views |
| `js/atmosphere.js` | Gradient sky + particle field |
| `js/main.js` | Scene, bloom, tone mapping, and wiring it all together |
| `vendor/` | Three.js + addons (vendored so it works offline) |

### Things you might want to tweak

- **Colors** — the `STOPS` array in `js/terrain.js`
- **Terrain size / height** — `WIDTH`, `DEPTH`, `HEIGHT` in `js/terrain.js`
- **Detail vs. speed** — `TIME_STEPS` and `FREQ_BINS` in `js/spectrogram.js`
  (larger = more detail but heavier; the defaults render any file smoothly)
- **Lighting / fog / camera** — near the top of `js/main.js`
