# Sound Labs

The home page (`index.html`, with the animated background in `bg.js`) links to
one tool: **Spectral Relief**, a 3D spectrogram that turns audio, live input or
an image into orbitable relief terrain. It is served from `terrain/`.

## Where `terrain/` comes from

`terrain/` is a **build output**, not hand-written code. The source lives in
[ayden723/spectral-relief](https://github.com/ayden723/spectral-relief). To
update the live site after changing it, build it into this folder with
relative paths and commit the result:

```bash
# from the spectral-relief checkout
npx vite build --base=./ --outDir ../audio-terrain/terrain --emptyOutDir
```

Then commit `terrain/` here and push to `main`; Cloudflare Workers Builds
deploys it.

## Running it locally

No build step for this repo; any static server works:

```bash
python -m http.server 8000
```

Then open <http://127.0.0.1:8000>.
