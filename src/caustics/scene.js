import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Colours are authored in sRGB and written straight out; no working-space conversion.
THREE.ColorManagement.enabled = false;

// A spectrogram rendered like a water surface: a wireframe height field with
// light refracted through it onto a floor below. The caustics follow Evan
// Wallace's method (as used in Amanda Ghassaei's gpu-io wave2d example): a grid
// of light rays is bent by the surface normal, and each little triangle's
// brightness is how much it shrank on the way down.
//
// Everything lives in one unit square: u (0..1) runs across frequency along
// world x, v (0..1) runs along time along world z, with v = 1 nearest the camera.

const HEIGHT_VERT = /* glsl */ `
uniform sampler2D uHeight;
uniform float uHeightScale, uRows, uScroll;
varying float vH;

// v = 1 shows the newest row; uScroll slides the rows back smoothly between pushes
float heightAt(vec2 uv) {
  float r = uv.y * (uRows - 2.0) + 1.0 - uScroll;
  return texture2D(uHeight, vec2(uv.x, (r + 0.5) / uRows)).r;
}

void main() {
  float h = heightAt(uv);
  vH = h;
  vec3 p = vec3(uv.x - 0.5, h * uHeightScale, uv.y - 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const COLOR_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vH;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
}
`;

// One ray per vertex, refracted through the surface and followed to the floor.
const CAUSTIC_VERT = /* glsl */ `
uniform sampler2D uHeight;
uniform float uHeightScale, uRows, uScroll, uDepth, uMaxSlope, uSoft;
uniform vec2 uTexel;
varying vec2 vOld;
varying vec2 vNew;

float heightAt(vec2 uv) {
  float r = uv.y * (uRows - 2.0) + 1.0 - uScroll;
  return texture2D(uHeight, vec2(uv.x, (r + 0.5) / uRows)).r * uHeightScale;
}

void main() {
  vec2 uv = position.xy + 0.5;
  float h = heightAt(uv);
  // Normals from a few texels apart: single-bin bumps in the spectrum would
  // otherwise scatter the light into grain instead of clean lines.
  vec2 d = uTexel * uSoft;
  vec2 g = vec2(heightAt(uv + vec2(d.x, 0.0)) - heightAt(uv - vec2(d.x, 0.0)),
                heightAt(uv + vec2(0.0, d.y)) - heightAt(uv - vec2(0.0, d.y))) / (2.0 * d);
  // steep spectral peaks would throw light off the floor entirely; cap the slope
  g *= min(uMaxSlope / max(length(g), 1e-6), 1.0);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 r = refract(vec3(0.0, -1.0, 0.0), n, 1.0 / 1.33);
  float travel = (uDepth + h) / max(-r.y, 1e-3);
  vec2 hit = uv + r.xz * travel;
  vOld = uv;
  vNew = hit;
  gl_Position = vec4(hit * 2.0 - 1.0, 0.0, 1.0);
}
`;

const CAUSTIC_FRAG = /* glsl */ `
uniform float uStrength;
varying vec2 vOld;
varying vec2 vNew;
void main() {
  float oldArea = abs(dFdx(vOld.x) * dFdy(vOld.y));
  float newArea = abs(dFdx(vNew.x) * dFdy(vNew.y));
  float a = oldArea / max(newArea, 1e-10);
  gl_FragColor = vec4(vec3(min(a, 40.0) * uStrength), 1.0);
}
`;

const FLOOR_VERT = /* glsl */ `
uniform float uDepth;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = vec3(uv.x - 0.5, -uDepth, uv.y - 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FLOOR_FRAG = /* glsl */ `
uniform sampler2D uCaustics;
uniform vec3 uFloor, uLight;
varying vec2 vUv;
void main() {
  float a = texture2D(uCaustics, vUv).r;   // 1.0 where the light is spread evenly
  vec3 col = uFloor * (0.35 + 0.65 * min(a, 1.4));
  col += uLight * smoothstep(1.0, 3.2, a) * 0.9;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const LOOKS = {
  Reference: { bg: '#dddddd', surface: '#ffffff', surfaceOpacity: 0.7, lines: '#000000', floor: '#367a95', light: '#e8fbff' },
  Night: { bg: '#0b0b0d', surface: '#15151a', surfaceOpacity: 0.55, lines: '#d8ecff', floor: '#10365e', light: '#ffd8a8' },
};

export class CausticScene {
  constructor(canvas, { cols, rows }) {
    this.canvas = canvas;
    this.cols = cols;
    this.rows = rows;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.scene = new THREE.Scene();
    // A long lens from far away, like the reference: near-orthographic depth.
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(7, 7, 7);
    this.camera.zoom = 7;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.target.set(0, -0.12, 0);

    // Height field: one float per cell, rows oldest -> newest.
    this.data = new Float32Array(cols * rows);
    const floatLinear = this.renderer.extensions.has('OES_texture_float_linear');
    this.half = !floatLinear;
    this.halfData = this.half ? new Uint16Array(cols * rows) : null;
    this.heightTex = new THREE.DataTexture(
      this.half ? this.halfData : this.data, cols, rows, THREE.RedFormat,
      this.half ? THREE.HalfFloatType : THREE.FloatType
    );
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.needsUpdate = true;

    const shared = {
      uHeight: { value: this.heightTex },
      uHeightScale: { value: 0.12 },
      uRows: { value: rows },
      uScroll: { value: 0 },
    };
    this.shared = shared;

    // --- surface: translucent fill plus a black quad grid on top
    const N = 128;
    const plane = new THREE.PlaneGeometry(1, 1, N, N); // only its uvs and indices are used
    this.fillMat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uColor: { value: new THREE.Color() }, uOpacity: { value: 0.7 } },
      vertexShader: HEIGHT_VERT,
      fragmentShader: COLOR_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.fill = new THREE.Mesh(plane, this.fillMat);
    this.fill.frustumCulled = false;
    this.fill.renderOrder = 1; // fill first, so the grid lines draw over it

    this.lineMat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uColor: { value: new THREE.Color() }, uOpacity: { value: 1 } },
      vertexShader: HEIGHT_VERT,
      fragmentShader: COLOR_FRAG,
      transparent: true,
    });
    this.gridN = N;
    this.lines = new THREE.LineSegments(quadGrid(N), this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;

    // --- caustics: a dense ray grid drawn additively into a texture
    const RT = 768;
    this.causticTarget = new THREE.WebGLRenderTarget(RT, RT, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.causticMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uDepth: { value: 0.35 },
        uMaxSlope: { value: 0.9 },
        uSoft: { value: 2.5 },
        uStrength: { value: 1 },
        uTexel: { value: new THREE.Vector2(1 / cols, 1 / rows) },
      },
      vertexShader: CAUSTIC_VERT,
      fragmentShader: CAUSTIC_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const rays = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 320, 320), this.causticMat);
    rays.frustumCulled = false;
    this.causticScene = new THREE.Scene();
    this.causticScene.add(rays);
    this.causticCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // --- floor, lit by the caustics
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uCaustics: { value: this.causticTarget.texture },
        uDepth: this.causticMat.uniforms.uDepth,
        uFloor: { value: new THREE.Color() },
        uLight: { value: new THREE.Color() },
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      side: THREE.DoubleSide,
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), this.floorMat);
    this.floor.frustumCulled = false;

    this.scene.add(this.floor, this.fill, this.lines);

    this.setLook('Reference');
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.renderer.setAnimationLoop(() => this.frame());
    this.onFrame = null;
  }

  setLook(name) {
    const L = LOOKS[name] || LOOKS.Reference;
    this.bg = L.bg;
    this.fillMat.uniforms.uColor.value.set(L.surface);
    this.fillMat.uniforms.uOpacity.value = L.surfaceOpacity;
    this.lineMat.uniforms.uColor.value.set(L.lines);
    this.floorMat.uniforms.uFloor.value.set(L.floor);
    this.floorMat.uniforms.uLight.value.set(L.light);
    document.documentElement.dataset.look = name;
  }

  set({ height, depth, strength, slope, soft, surface, wireframe }) {
    if (soft !== undefined) this.causticMat.uniforms.uSoft.value = soft;
    if (height !== undefined) this.shared.uHeightScale.value = height;
    if (depth !== undefined) this.causticMat.uniforms.uDepth.value = depth;
    if (strength !== undefined) this.causticMat.uniforms.uStrength.value = strength;
    if (slope !== undefined) this.causticMat.uniforms.uMaxSlope.value = slope;
    if (surface !== undefined) this.fill.visible = surface;
    if (wireframe !== undefined) this.lines.visible = wireframe;
  }

  /** Append the newest row (0..1 heights) and drop the oldest. */
  pushRow(row) {
    const { cols, data } = this;
    data.copyWithin(0, cols);
    data.set(row, data.length - cols);
    if (this.half) {
      for (let i = 0; i < data.length; i++) this.halfData[i] = THREE.DataUtils.toHalfFloat(data[i]);
    }
    this.heightTex.needsUpdate = true;
  }

  /** 0..1: how far the rows have slid back since the last push. */
  setScroll(f) {
    this.shared.uScroll.value = f;
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the whole square in view on narrow screens
    this.camera.zoom = 7 * Math.min(1, (w / h) / 1.1);
    this.camera.updateProjectionMatrix();

    // Fewer grid lines on small screens, or the surface turns solid black.
    const n = Math.max(40, Math.min(128, Math.round(Math.min(w, h) / 6)));
    if (n !== this.gridN) {
      this.gridN = n;
      this.lines.geometry.dispose();
      this.lines.geometry = quadGrid(n);
    }
  }

  frame() {
    if (this.onFrame) this.onFrame();
    this.controls.update();
    const r = this.renderer;
    r.setRenderTarget(this.causticTarget);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.causticScene, this.causticCam);
    r.setRenderTarget(null);
    r.setClearColor(this.bg, 1);
    r.render(this.scene, this.camera);
  }
}

/** Grid lines along both axes (a quad grid, not triangles), as uv positions. */
function quadGrid(n) {
  const verts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    for (let j = 0; j < n; j++) {
      const a = j / n, b = (j + 1) / n;
      verts.push(a, t, b, t); // along u
      verts.push(t, a, t, b); // along v
    }
  }
  const uv = new Float32Array(verts);
  const g = new THREE.BufferGeometry();
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((uv.length / 2) * 3), 3));
  return g;
}
