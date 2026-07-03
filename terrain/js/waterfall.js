/* ============================================================
   waterfall.js — live "waterfall" spectrogram
   ------------------------------------------------------------
   Driven by the AnalyserNode in real time. Every frame we read the
   current spectrum, add it as a fresh row at the FRONT edge, and scroll
   all older rows backward — so the landscape grows out of the sound and
   flows away from you.

   Axes here:
     X = frequency (log scale, spread wide)
     Y = amplitude (height)
     Z = time      (front = now, back = a few seconds ago)
   ============================================================ */

import * as THREE from 'three';
import { PALETTES, rampColor } from './palettes.js';

const WIDTH  = 320;   // X (frequency)
const DEPTH  = 280;   // Z (time history)
const HEIGHT = 34;    // Y (amplitude)
const COLS   = 256;   // frequency resolution
const ROWS    = 220;  // time resolution (history length)

export class Waterfall {
  constructor(scene) {
    this.scene = scene;
    this.palette = 'aurora';
    this.bands = null;
    this.history = new Float32Array(ROWS * COLS); // row 0 = oldest (back)
    this.row = new Float32Array(COLS);            // scratch for newest row

    this._build();
    this.setVisible(false);
  }

  _build() {
    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, COLS - 1, ROWS - 1);
    geo.rotateX(-Math.PI / 2);
    this.geo = geo;
    geo.setAttribute('color',
      new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.6, metalness: 0.12, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);

    // bright crest line tracing the newest (front) row — the "now" edge
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COLS * 3), 3));
    this.line = new THREE.Line(lgeo, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.line.renderOrder = 2;
    this.scene.add(this.line);
  }

  /* Precompute, once per file, which analyser bins fall into each column. */
  _buildBands(sampleRate, binCount) {
    const nyquist = sampleRate / 2;
    const binHz = nyquist / binCount;
    const fMin = Math.max(20, binHz), fMax = nyquist;
    const logMin = Math.log(fMin), logMax = Math.log(fMax);
    const bands = [];
    for (let c = 0; c < COLS; c++) {
      const f0 = Math.exp(logMin + (logMax - logMin) * (c / COLS));
      const f1 = Math.exp(logMin + (logMax - logMin) * ((c + 1) / COLS));
      let b0 = Math.max(1, Math.floor(f0 / binHz));
      let b1 = Math.min(binCount, Math.max(b0 + 1, Math.ceil(f1 / binHz)));
      bands.push([b0, b1]);
    }
    this.bands = bands;
  }

  /** Clear the history (called when a track loads or the mode opens). */
  reset(sampleRate, binCount) {
    if (sampleRate && binCount) this._buildBands(sampleRate, binCount);
    this.history.fill(0);
    this._render();
  }

  setVisible(v) {
    this.mesh.visible = v;
    this.line.visible = v;
  }

  setPalette(name) {
    if (!PALETTES[name]) return;
    this.palette = name;
    this._render();
  }

  /** Push one live spectrum frame (Uint8Array 0..255 from the analyser). */
  pushFrame(freqData) {
    if (!this.bands) return;
    // collapse the analyser bins into COLS log-spaced columns
    for (let c = 0; c < COLS; c++) {
      const [b0, b1] = this.bands[c];
      let m = 0;
      for (let b = b0; b < b1; b++) if (freqData[b] > m) m = freqData[b];
      this.row[c] = m / 255;
    }
    // scroll history back by one row, write the new row at the front
    this.history.copyWithin(0, COLS);
    this.history.set(this.row, (ROWS - 1) * COLS);
    this._render();
  }

  /* Rewrite vertex heights + colors from the history buffer. */
  _render() {
    const pos = this.geo.attributes.position;
    const colAttr = this.geo.attributes.color;
    const stops = PALETTES[this.palette];
    const col = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const c = i % COLS;          // frequency
      const r = Math.floor(i / COLS); // time row (0 oldest .. ROWS-1 newest)
      const v = this.history[r * COLS + c];
      pos.setY(i, Math.pow(v, 1.15) * HEIGHT);
      rampColor(stops, v, col);
      colAttr.setXYZ(i, col.r, col.g, col.b);
    }
    pos.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.geo.computeVertexNormals();

    // crest line along the newest row (front edge)
    const lp = this.line.geometry.attributes.position;
    const base = (ROWS - 1) * COLS;
    for (let c = 0; c < COLS; c++) {
      const idx = base + c;
      lp.setXYZ(c, pos.getX(idx), pos.getY(idx) + 0.5, pos.getZ(idx));
    }
    lp.needsUpdate = true;
  }

  get size() { return { WIDTH, DEPTH, HEIGHT }; }
}
