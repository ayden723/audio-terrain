import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Colours are authored in sRGB and written straight out; no working-space conversion.
THREE.ColorManagement.enabled = false;

// A round pool seen from above: a glassy water surface ruled with rings and
// spokes like record grooves, and an engraved floor below it lit by the light
// the ripples focus. The caustics use Evan Wallace's area-ratio method, run
// three times with slightly different refractive indices so the light splits
// into coloured fringes, the way it does through a prism.
//
// Coordinates: the pool sits in the unit square, u across world x and v along
// world z, centred on the origin. The water rests at y = 0, the floor at -depth.

const HEIGHT_FN = /* glsl */ `
uniform sampler2D uHeight;
uniform float uHeightScale;
uniform vec2 uTexel;
float heightAt(vec2 uv) { return texture2D(uHeight, uv).r * uHeightScale; }
vec2 slopeAt(vec2 uv, float spread) {
  vec2 d = uTexel * spread;
  return vec2(heightAt(uv + vec2(d.x, 0.0)) - heightAt(uv - vec2(d.x, 0.0)),
              heightAt(uv + vec2(0.0, d.y)) - heightAt(uv - vec2(0.0, d.y))) / (2.0 * d);
}
`;

const SURFACE_VERT = /* glsl */ `
${HEIGHT_FN}
varying vec3 vN;
varying vec3 vWorld;
void main() {
  float h = heightAt(uv);
  vec2 g = slopeAt(uv, 1.0);
  vN = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 p = vec3(uv.x - 0.5, h, uv.y - 0.5);
  vWorld = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

// Glassy fill: mostly see-through, brighter at grazing angles and where a
// ripple catches the light.
const FILL_FRAG = /* glsl */ `
uniform vec3 uColor, uSpec;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(vec3(-0.35, 1.0, 0.25));
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  float spec = pow(max(dot(reflect(-L, n), V), 0.0), 80.0);
  gl_FragColor = vec4(uColor + uSpec * (spec * 1.4 + fres * 0.2), uOpacity + spec * 0.6 + fres * 0.25);
}
`;

const LINE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() { gl_FragColor = vec4(uColor, uOpacity); }
`;

const CAUSTIC_VERT = /* glsl */ `
${HEIGHT_FN}
uniform float uDepth, uMaxSlope, uSoft, uEta, uRadius;
varying vec2 vOld;
varying vec2 vNew;
varying float vInside;
void main() {
  vec2 uv = position.xy + 0.5;
  vInside = step(length(uv - 0.5), uRadius);
  float h = heightAt(uv);
  vec2 g = slopeAt(uv, uSoft);
  g *= min(uMaxSlope / max(length(g), 1e-6), 1.0);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 r = refract(vec3(0.0, -1.0, 0.0), n, uEta);
  vec2 hit = uv + r.xz * (uDepth + h) / max(-r.y, 1e-3);
  vOld = uv;
  vNew = hit;
  gl_Position = vec4(hit * 2.0 - 1.0, 0.0, 1.0);
}
`;

const CAUSTIC_FRAG = /* glsl */ `
uniform vec3 uTint;
uniform float uStrength;
varying vec2 vOld;
varying vec2 vNew;
varying float vInside;
void main() {
  float oldArea = abs(dFdx(vOld.x) * dFdy(vOld.y));
  float newArea = abs(dFdx(vNew.x) * dFdy(vNew.y));
  float a = min(oldArea / max(newArea, 1e-10), 30.0) * uStrength * vInside;
  gl_FragColor = vec4(uTint * a, 1.0);
}
`;

const FLOOR_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vUv = w.xz + 0.5;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// The floor is engraved like a dial: faint grooves, and one tick per buoy note
// around the rim. Where the water focuses light it glows; under a sounding
// buoy it glows in the buoy's colour.
const FLOOR_FRAG = /* glsl */ `
#define BUOYS 8
uniform sampler2D uCaustics;
uniform vec3 uFloor, uEngrave, uLight, uGlow;
uniform float uRadius;
uniform vec4 uBuoys[BUOYS];
varying vec2 vUv;

float line(float x, float w) { return 1.0 - smoothstep(0.0, w, abs(x)); }

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) / uRadius;
  float ang = atan(p.y, p.x) / 6.28318530718 + 0.5;
  float px = fwidth(r);

  float grooves = line(fract(r * 14.0 + 0.5) - 0.5, px * 14.0 * 1.2) * step(r, 0.86);
  float ring = line(r - 0.9, px * 1.5) + line(r - 0.985, px * 2.0);
  float tick = line(fract(ang * 48.0 + 0.5) - 0.5, fwidth(ang * 48.0) * 1.2) * step(0.9, r) * step(r, 0.96);
  float major = line(fract(ang * 8.0 + 0.5) - 0.5, fwidth(ang * 8.0) * 1.6) * step(0.87, r) * step(r, 0.975);
  vec3 col = uFloor + uEngrave * (grooves * 0.35 + ring * 0.8 + tick * 0.5 + major * 0.9);

  vec3 c = texture2D(uCaustics, vUv).rgb; // 1.0 per channel where light falls evenly
  float lum = dot(c, vec3(1.0 / 3.0));
  col *= 0.35 + 0.65 * min(lum, 1.3);
  vec3 extra = max(c - 1.0, 0.0);
  float e = dot(extra, vec3(1.0 / 3.0));
  col += uLight * e * 0.55 + (extra - e) * 0.55; // light, plus its coloured fringes

  for (int i = 0; i < BUOYS; i++) {
    vec2 d = vUv - uBuoys[i].xy;
    col += uGlow * uBuoys[i].z * exp(-dot(d, d) / 0.0016) * 0.9;
  }

  col *= mix(0.55, 1.0, smoothstep(1.0, 0.75, r)); // the wall's shadow at the edge
  gl_FragColor = vec4(col, 1.0);
}
`;

export const LOOKS = {
  Ember: {
    bg: '#0b0b0d', fill: '#0f0f13', fillOpacity: 0.34, spec: '#ffe9cc', lines: '#f1e4d4', lineOpacity: 0.3,
    floor: '#17110d', engrave: '#4a3426', light: '#ffb25a', glow: '#ff8a3c', buoy: '#3b3530', buoyOn: '#ffc078', ink: 'light',
  },
  Blueprint: {
    bg: '#081626', fill: '#0c2440', fillOpacity: 0.32, spec: '#d8ecff', lines: '#d8ecff', lineOpacity: 0.32,
    floor: '#10365e', engrave: '#2c6aa6', light: '#dff4ff', glow: '#7fd0ff', buoy: '#1d3c5e', buoyOn: '#e8f6ff', ink: 'light',
  },
  Terracotta: {
    bg: '#efe7d8', fill: '#fff8ee', fillOpacity: 0.4, spec: '#ffffff', lines: '#5a2a14', lineOpacity: 0.34,
    floor: '#b24f1d', engrave: '#e08a55', light: '#fff1d6', glow: '#ffe2a8', buoy: '#6b3a22', buoyOn: '#fff4dc', ink: 'dark',
  },
};

export class PoolScene {
  constructor(canvas, { n, radius, buoys }) {
    this.canvas = canvas;
    this.radius = radius;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camera.position.set(0, 1.95, 2.05);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minPolarAngle = 0.05;
    this.controls.maxPolarAngle = 1.35;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 8;
    this.controls.target.set(0, -0.12, 0);

    // height texture, filled from the simulation every frame
    this.half = !this.renderer.extensions.has('OES_texture_float_linear');
    this.texData = this.half ? new Uint16Array(n * n) : new Float32Array(n * n);
    this.heightTex = new THREE.DataTexture(this.texData, n, n, THREE.RedFormat, this.half ? THREE.HalfFloatType : THREE.FloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.needsUpdate = true;

    const shared = {
      uHeight: { value: this.heightTex },
      uHeightScale: { value: 0.05 },
      uTexel: { value: new THREE.Vector2(1 / n, 1 / n) },
    };
    this.shared = shared;

    // --- water surface: polar mesh, grooves and spokes on top
    const fillGeo = polarDisk(radius, 80, 192);
    this.fillMat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uColor: { value: new THREE.Color() }, uSpec: { value: new THREE.Color() }, uOpacity: { value: 0.3 } },
      vertexShader: SURFACE_VERT,
      fragmentShader: FILL_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.fill = new THREE.Mesh(fillGeo, this.fillMat);
    this.fill.frustumCulled = false;
    this.fill.renderOrder = 2;

    this.lineMat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uColor: { value: new THREE.Color() }, uOpacity: { value: 0.3 } },
      vertexShader: SURFACE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(polarLines(radius, 80, 192, 4, 8), this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;

    // --- caustics: three refractions (red, green, blue) added into one texture
    this.causticTarget = new THREE.WebGLRenderTarget(768, 768, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.causticShared = {
      ...shared,
      uDepth: { value: 0.3 },
      uMaxSlope: { value: 1.2 },
      uSoft: { value: 1.5 },
      uStrength: { value: 1 },
      uRadius: { value: radius },
    };
    const rayGeo = new THREE.PlaneGeometry(1, 1, 260, 260);
    this.causticScene = new THREE.Scene();
    this.channels = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ].map((tint) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...this.causticShared, uEta: { value: 1 / 1.33 }, uTint: { value: new THREE.Vector3(...tint) } },
        vertexShader: CAUSTIC_VERT,
        fragmentShader: CAUSTIC_FRAG,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(rayGeo, mat);
      m.frustumCulled = false;
      this.causticScene.add(m);
      return mat;
    });
    this.causticCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // --- floor and the two rims of the pool
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uCaustics: { value: this.causticTarget.texture },
        uFloor: { value: new THREE.Color() },
        uEngrave: { value: new THREE.Color() },
        uLight: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color() },
        uRadius: { value: radius },
        uBuoys: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0.5, 0.5, 0, 0)) },
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      side: THREE.DoubleSide,
    });
    const floorGeo = new THREE.CircleGeometry(radius, 160);
    floorGeo.rotateX(-Math.PI / 2);
    this.floor = new THREE.Mesh(floorGeo, this.floorMat);

    this.rimMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 });
    const circle = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 161 }, (_, i) => {
        const a = (i / 160) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius);
      })
    );
    this.rimTop = new THREE.Line(circle, this.rimMat);
    this.rimBottom = new THREE.Line(circle, this.rimMat);

    // --- buoys
    this.buoyGeo = new THREE.SphereGeometry(0.009, 20, 14);
    this.buoys = buoys.map((b) => {
      const m = new THREE.Mesh(this.buoyGeo, new THREE.MeshBasicMaterial());
      m.userData = { u: b.u, v: b.v };
      this.scene.add(m);
      return m;
    });
    this.buoyOff = new THREE.Color();
    this.buoyOn = new THREE.Color();

    this.scene.add(this.floor, this.rimTop, this.rimBottom, this.fill, this.lines);

    this.raycaster = new THREE.Raycaster();
    this.setLook('Ember');
    this.set({ depth: 0.3, dispersion: 0.5 });
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.onFrame = null;
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setLook(name) {
    const L = LOOKS[name] || LOOKS.Ember;
    this.bg = L.bg;
    this.fillMat.uniforms.uColor.value.set(L.fill);
    this.fillMat.uniforms.uSpec.value.set(L.spec);
    this.fillMat.uniforms.uOpacity.value = L.fillOpacity;
    this.lineMat.uniforms.uColor.value.set(L.lines);
    this.lineMat.uniforms.uOpacity.value = L.lineOpacity;
    this.rimMat.color.set(L.lines);
    const f = this.floorMat.uniforms;
    f.uFloor.value.set(L.floor);
    f.uEngrave.value.set(L.engrave);
    f.uLight.value.set(L.light);
    f.uGlow.value.set(L.glow);
    this.buoyOff.set(L.buoy);
    this.buoyOn.set(L.buoyOn);
    document.documentElement.dataset.look = name;
    document.documentElement.dataset.ink = L.ink;
  }

  set({ height, depth, strength, soft, dispersion }) {
    if (height !== undefined) this.shared.uHeightScale.value = height;
    if (depth !== undefined) {
      this.causticShared.uDepth.value = depth;
      this.floor.position.y = -depth;
      this.rimBottom.position.y = -depth;
    }
    if (strength !== undefined) this.causticShared.uStrength.value = strength;
    if (soft !== undefined) this.causticShared.uSoft.value = soft;
    if (dispersion !== undefined) {
      // red bends least, blue most; exaggerated so the fringes read
      const spread = 0.045 * dispersion;
      this.channels[0].uniforms.uEta.value = 1 / (1.33 - spread);
      this.channels[1].uniforms.uEta.value = 1 / 1.33;
      this.channels[2].uniforms.uEta.value = 1 / (1.33 + spread);
    }
  }

  /** Copy the simulation's heights into the texture. */
  upload(heights) {
    if (this.half) {
      for (let i = 0; i < heights.length; i++) this.texData[i] = THREE.DataUtils.toHalfFloat(heights[i]);
    } else {
      this.texData.set(heights);
    }
    this.heightTex.needsUpdate = true;
  }

  /** Place the buoys on the water and light them (and the floor under them) by level. */
  updateBuoys(heights, levels) {
    const scale = this.shared.uHeightScale.value;
    const glow = this.floorMat.uniforms.uBuoys.value;
    this.buoys.forEach((m, i) => {
      const { u, v } = m.userData;
      m.position.set(u - 0.5, heights[i] * scale + 0.009, v - 0.5);
      m.material.color.copy(this.buoyOff).lerp(this.buoyOn, Math.min(1, levels[i] * 1.4));
      m.scale.setScalar(1 + levels[i] * 0.6);
      glow[i].set(u, v, levels[i], 0);
    });
  }

  /** Where a pointer at (clientX, clientY) meets the resting water, as uv; null if it misses. */
  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin: o, direction: d } = this.raycaster.ray;
    if (Math.abs(d.y) < 1e-6) return null;
    const t = -o.y / d.y;
    if (t <= 0) return null;
    return { u: o.x + t * d.x + 0.5, v: o.z + t * d.z + 0.5 };
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // narrow screens: widen the lens just enough that the pool still fits across
    this.camera.fov = Math.min(55, 30 * Math.max(1, 0.75 / (w / h)));
    this.camera.updateProjectionMatrix();
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

/** Triangles for a disk, as uvs: a centre point and `rings` rings of `segs` points. */
function polarDisk(R, rings, segs) {
  const uv = [0.5, 0.5];
  for (let k = 1; k <= rings; k++) {
    const rr = (R * k) / rings;
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      uv.push(0.5 + rr * Math.cos(a), 0.5 + rr * Math.sin(a));
    }
  }
  const idx = [];
  const at = (k, s) => 1 + (k - 1) * segs + (s % segs);
  for (let s = 0; s < segs; s++) idx.push(0, at(1, s + 1), at(1, s));
  for (let k = 1; k < rings; k++) {
    for (let s = 0; s < segs; s++) {
      const a = at(k, s), b = at(k, s + 1), c = at(k + 1, s), d = at(k + 1, s + 1);
      idx.push(a, b, c, b, d, c);
    }
  }
  return withUv(new Float32Array(uv), idx);
}

/** Ring and spoke lines over the disk: every `ringEvery`th ring, every `spokeEvery`th spoke. */
function polarLines(R, rings, segs, ringEvery, spokeEvery) {
  const uv = [];
  const pt = (rr, a) => [0.5 + rr * Math.cos(a), 0.5 + rr * Math.sin(a)];
  for (let k = ringEvery; k <= rings; k += ringEvery) {
    const rr = (R * k) / rings;
    for (let s = 0; s < segs; s++) {
      uv.push(...pt(rr, (s / segs) * Math.PI * 2), ...pt(rr, ((s + 1) / segs) * Math.PI * 2));
    }
  }
  for (let s = 0; s < segs; s += spokeEvery) {
    const a = (s / segs) * Math.PI * 2;
    for (let k = 0; k < rings; k++) {
      uv.push(...pt((R * k) / rings, a), ...pt((R * (k + 1)) / rings, a));
    }
  }
  return withUv(new Float32Array(uv));
}

function withUv(uv, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((uv.length / 2) * 3), 3));
  if (index) g.setIndex(index);
  return g;
}
