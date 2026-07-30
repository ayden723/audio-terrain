/* ============================================================
   terrain.js — build the 3D landscape from the spectrogram grid
   ------------------------------------------------------------
   Axes (as a landscape, with "up" = loudness):
     X = time        (left -> right)
     Y = amplitude   (height of the terrain)
     Z = frequency   (depth: front = low, back = high)
   ============================================================ */

import * as THREE from 'three';
import { PALETTES, rampColor } from './palettes.js';

// World size of the terrain. WIDTH (time) is decided per-file from the
// duration so long tracks spread out instead of getting crushed.
const MIN_WIDTH = 220;
const MAX_WIDTH = 1600;
const PX_PER_SEC = 6;     // how much X length each second of audio gets
const DEPTH  = 130;       // along Z (frequency)
const HEIGHT = 34;        // max amplitude in Y

/* A soft round sprite texture for the glowing playhead marker. */
function makeGlowTexture() {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(200,245,255,0.7)');
  g.addColorStop(1.0, 'rgba(160,230,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this.spec = null;        // keep the grid so we can recolor instantly
    this.geo = null;
    this.W = 0; this.H = 0;
    this.worldWidth = MIN_WIDTH;
    this.duration = 1;
    this.palette = 'aurora';

    // highlight objects
    this.contour = null;     // bright line tracing the surface at the playhead
    this.sheet = null;       // faint vertical context plane
    this.marker = null;      // glowing dot at the top of the playhead column
  }

  /** Build (or rebuild) the landscape from a spectrogram grid. */
  build(spec, duration) {
    this.dispose();
    this.spec = spec;
    this.duration = duration || 1;
    this.W = spec.width;
    this.H = spec.height;

    // longer tracks get a wider landscape so waves aren't compressed
    this.worldWidth = Math.max(
      MIN_WIDTH, Math.min(MAX_WIDTH, this.duration * PX_PER_SEC)
    );

    const W = this.W, H = this.H;
    const geo = new THREE.PlaneGeometry(this.worldWidth, DEPTH, W - 1, H - 1);
    geo.rotateX(-Math.PI / 2); // lay it flat: plane's Y -> world Z
    this.geo = geo;

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const ix = i % W;            // time index
      const iy = Math.floor(i / W);// freq index
      const v = spec.data[iy * W + ix];
      pos.setY(i, Math.pow(v, 1.15) * HEIGHT);
    }
    geo.setAttribute('color',
      new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.12,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);

    this._applyColors();
    this._buildHighlight();
    this.setProgress(0);
  }

  /**
   * Update heights + colors from a new grid WITHOUT rebuilding the mesh,
   * so the camera and everything else stay put. Used for live painting
   * (Composer). Falls back to a full build() if the grid size changed.
   */
  updateFromGrid(spec, skipNormals = false) {
    if (!this.mesh || this.W !== spec.width || this.H !== spec.height) {
      this.build(spec, this.duration);
      return;
    }
    this.spec = spec;
    const W = this.W;
    const pos = this.geo.attributes.position;
    const data = spec.data;
    for (let i = 0; i < pos.count; i++) {
      const ix = i % W, iy = Math.floor(i / W);
      pos.setY(i, Math.pow(data[iy * W + ix], 1.15) * HEIGHT);
    }
    pos.needsUpdate = true;
    // Normal recompute is the expensive part — skip it during a live drag
    // (heights still move) and do it once when the stroke ends.
    if (!skipNormals) this.geo.computeVertexNormals();
    this._applyColors();
  }

  /** Recolor the existing mesh with the named palette (no re-analysis). */
  setPalette(name) {
    if (!PALETTES[name]) return;
    this.palette = name;
    if (this.mesh) this._applyColors();
  }

  static get paletteNames() { return Object.keys(PALETTES); }

  _applyColors() {
    const stops = PALETTES[this.palette];
    const W = this.W, data = this.spec.data;
    const colAttr = this.geo.attributes.color;
    const col = new THREE.Color();
    for (let i = 0; i < colAttr.count; i++) {
      const ix = i % W, iy = Math.floor(i / W);
      rampColor(stops, data[iy * W + ix], col);
      colAttr.setXYZ(i, col.r, col.g, col.b);
    }
    colAttr.needsUpdate = true;
  }

  /* ---------- Live playback highlight ---------- */
  _buildHighlight() {
    const H = this.H;

    // 1) Bright contour line that rides the surface at the current time.
    const cgeo = new THREE.BufferGeometry();
    cgeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(H * 3), 3));
    const cmat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.contour = new THREE.Line(cgeo, cmat);
    this.contour.renderOrder = 2;
    this.scene.add(this.contour);

    // 2) Faint vertical sheet for spatial context.
    const sgeo = new THREE.PlaneGeometry(DEPTH, HEIGHT * 1.3);
    sgeo.rotateY(Math.PI / 2);
    const smat = new THREE.MeshBasicMaterial({
      color: 0x9fe9ff,
      transparent: true,
      opacity: 0.10,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.sheet = new THREE.Mesh(sgeo, smat);
    this.sheet.position.y = HEIGHT * 0.5;
    this.scene.add(this.sheet);

    // 3) Glowing playhead marker that floats above the loudest part.
    const mmat = new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.marker = new THREE.Sprite(mmat);
    this.marker.scale.set(14, 14, 1);
    this.scene.add(this.marker);
  }

  /**
   * Move the highlight to progress (0..1). `pulse` (optional) is a 0..1
   * value used to gently animate the marker/sheet so playback feels alive.
   */
  setProgress(progress, pulse = 0.5) {
    if (!this.contour) return;
    const W = this.W, H = this.H;
    const ix = Math.max(0, Math.min(W - 1, Math.round(progress * (W - 1))));
    const x = (progress - 0.5) * this.worldWidth;

    // trace the surface at this time column
    const src = this.geo.attributes.position;
    const dst = this.contour.geometry.attributes.position;
    let topY = -Infinity, topZ = 0;
    for (let r = 0; r < H; r++) {
      const idx = r * W + ix;
      const y = src.getY(idx);
      dst.setXYZ(r, x, y + 0.5, src.getZ(idx));
      if (y > topY) { topY = y; topZ = src.getZ(idx); }
    }
    dst.needsUpdate = true;

    this.sheet.position.x = x;
    this.sheet.material.opacity = 0.07 + 0.06 * pulse;

    this.marker.position.set(x, topY + 4, topZ);
    const s = 12 + 4 * pulse;
    this.marker.scale.set(s, s, 1);
  }

  /** Show/hide the whole landscape (used by the mode toggle). */
  setVisible(v) {
    for (const obj of [this.mesh, this.contour, this.sheet, this.marker]) {
      if (obj) obj.visible = v;
    }
  }

  /** Convert a world-space X (e.g. from a raycast) into 0..1 progress. */
  xToProgress(x) {
    return Math.max(0, Math.min(1, x / this.worldWidth + 0.5));
  }

  get size() {
    return { WIDTH: this.worldWidth, DEPTH, HEIGHT };
  }

  dispose() {
    for (const obj of [this.mesh, this.contour, this.sheet, this.marker]) {
      if (!obj) continue;
      this.scene.remove(obj);
      obj.geometry?.dispose();
      obj.material?.dispose();
      if (obj.material?.map) obj.material.map.dispose();
    }
    this.mesh = this.contour = this.sheet = this.marker = null;
    this.geo = this.spec = null;
  }
}
