import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Colours are authored in sRGB and written straight out; no working-space conversion.
THREE.ColorManagement.enabled = false;

// Heights live in a float texture rather than vertex attributes. That makes the
// waterfall window a single uniform, lets the display density differ from the
// analysis density, and gives the shader neighbour lookups for normals + shadows.
const VERT = /* glsl */ `
uniform sampler2D uHeights;
uniform vec2 uDataSize;
uniform float uW, uHt, uD, uReverse, uWinStart, uWinSpan, uSkirt;
uniform vec3 uLightDir;
uniform float uShadowStr, uShadowLen, uShadowSteps;

varying vec3 vN, vView;
varying float vH, vCrest, vY, vV, vDist, vShadow;

float hAt(vec2 uv) {
  return texture2D(uHeights, clamp(uv, vec2(0.0005), vec2(0.9995))).r;
}

void main() {
  float u = position.x;
  float top = position.y;
  float v = position.z;
  float dv = uWinStart + v * uWinSpan;

  float h = hAt(vec2(u, dv));
  float crest = h * uHt;
  float baseY = uSkirt > 0.0 ? max(0.0, crest - uSkirt * uHt) : 0.0;
  float y = mix(baseY, crest, top);

  float vv = mix(v, 1.0 - v, uReverse);
  float zs = mix(1.0, -1.0, uReverse);
  vec3 p = vec3((u - 0.5) * uW, y, (vv - 0.5) * uD);

  float du = 1.0 / uDataSize.x;
  float dvv = 1.0 / uDataSize.y;
  float gu = (hAt(vec2(u + du, dv)) - hAt(vec2(u - du, dv))) * 0.5 * uDataSize.x;
  float gv = (hAt(vec2(u, dv + dvv)) - hAt(vec2(u, dv - dvv))) * 0.5 * uDataSize.y;
  float dhdx = gu / max(uW, 1e-4);
  float dhdz = gv * uWinSpan * zs / max(uD, 1e-4);
  vN = normalize(vec3(-dhdx * uHt, 1.0, -dhdz * uHt));

  // march toward the light and see if the terrain occludes this crest
  float occ = 0.0;
  if (uShadowStr > 0.001) {
    vec3 L = normalize(uLightDir);
    for (int i = 1; i <= 12; i++) {
      if (float(i) > uShadowSteps) break;
      float t = uShadowLen * float(i) / uShadowSteps;
      vec2 sp = vec2(u + L.x * t / max(uW, 1e-4), dv + L.z * t * uWinSpan * zs / max(uD, 1e-4));
      float hh = hAt(sp) * uHt;
      float ry = crest + L.y * t;
      occ = max(occ, clamp((hh - ry) / (0.3 * uHt + 1e-4), 0.0, 1.0));
    }
  }
  vShadow = 1.0 - occ * uShadowStr;

  vH = h;
  vCrest = crest - y;
  vY = y;
  vV = v;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDist = length(mv.xyz);
  vView = cameraPosition - p;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uBg, uShadow, uHighlight, uLine, uAccent, uLightDir;
uniform vec3 uStops[5];
uniform float uColorMode, uAmbient, uFillMix, uLineW, uLineOpacity, uRim;
uniform float uCrestShade, uCrestLen, uBaseFade, uFog, uFogNear, uFogFar;
uniform float uPlay, uPlayMode, uRidges, uSurface, uHt;

varying vec3 vN, vView;
varying float vH, vCrest, vY, vV, vDist, vShadow;

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  float i = floor(min(t, 3.0));
  float f = t - i;
  vec3 a = uStops[0], b = uStops[1];
  if (i > 2.5) { a = uStops[3]; b = uStops[4]; }
  else if (i > 1.5) { a = uStops[2]; b = uStops[3]; }
  else if (i > 0.5) { a = uStops[1]; b = uStops[2]; }
  return mix(a, b, f);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.0, 289.0))) * 43758.5453);
}

void main() {
  float rg = max(uRidges, 2.0);
  if (uPlayMode > 1.5 && vV > uPlay + 0.5 / rg) discard;

  vec3 n = normalize(vN);
  float lam = max(dot(n, normalize(uLightDir)), 0.0) * vShadow;
  float shade = uAmbient + (1.0 - uAmbient) * lam;

  vec3 col = (uColorMode < 0.5)
    ? mix(uShadow, uHighlight, shade)
    : ramp(vH) * (0.45 + 0.75 * shade);

  // darker the further a fragment sits below its crest (self-shadowing feel)
  float below = clamp(vCrest / max(uCrestLen * uHt, 1e-4), 0.0, 1.0);
  col = mix(col, uShadow, below * uCrestShade);

  col = mix(uBg, col, uFillMix);

  // grazing-angle sheen picks the crests out of the mass
  if (uRim > 0.0) {
    float rim = pow(1.0 - clamp(dot(n, normalize(vView)), 0.0, 1.0), 3.0);
    col = mix(col, uHighlight, rim * uRim);
  }

  float d, px;
  if (uSurface > 0.5) {
    float s = vV * (rg - 1.0);
    d = abs(fract(s + 0.5) - 0.5);
    px = max(fwidth(s), 1e-5);
  } else {
    d = vCrest;
    px = max(fwidth(vCrest), 1e-6);
  }
  float lw = max(uLineW, 0.0) * 0.5;
  float line = 1.0 - smoothstep(max(lw - 0.5, 0.0) * px, (lw + 0.5) * px, d);
  col = mix(col, uLine, line * uLineOpacity);

  // the cursor rides the crest only, so a near ribbon can't flood the frame
  if (uPlayMode > 0.5) {
    float dd = abs(vV - uPlay) * (rg - 1.0);
    float near = 1.0 - smoothstep(0.5, 1.8, dd);
    float atCrest = 1.0 - smoothstep(0.0, 0.12 * uHt, vCrest);
    col = mix(col, uAccent, near * atCrest * 0.9);
  }

  if (uBaseFade > 0.0) col = mix(uBg, col, smoothstep(0.0, uBaseFade * uHt, vY));

  col = mix(col, uBg, clamp(smoothstep(uFogNear, uFogFar, vDist) * uFog, 0.0, 1.0));
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}
`;

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class Relief {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.linearFloat = this.renderer.extensions.has('OES_texture_float_linear');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 1000);

    this.dims = { W: 10, H: 3.4, D: 6 };
    this.disp = { ridges: 260, cols: 0 };
    this.renderScale = 1;
    this.mode = 'ridges';
    this.tex = null;
    this.mesh = null;
    this.tween = null;
    this.onFrame = null;

    // Auto move: a steady orbit with elevation sway and a slow zoom. It is applied
    // as per-frame deltas, so it drifts around the framing you chose instead of
    // snapping to a preset path.
    this.auto = { on: false, speed: 1, ramp: 0, t: 0, idleUntil: 0, last: performance.now() };
    this.userActive = false;
    this._off = new THREE.Vector3();
    this._sph = new THREE.Spherical();

    this.uniforms = {
      uHeights: { value: null },
      uDataSize: { value: new THREE.Vector2(1, 1) },
      uWinStart: { value: 0 },
      uWinSpan: { value: 1 },
      uSkirt: { value: 0 },
      uW: { value: 10 },
      uHt: { value: 3.4 },
      uD: { value: 6 },
      uReverse: { value: 0 },
      uRidges: { value: 260 },
      uSurface: { value: 0 },
      uBg: { value: new THREE.Color('#cdb697') },
      uShadow: { value: new THREE.Color('#4a4740') },
      uHighlight: { value: new THREE.Color('#dcd6c9') },
      uLine: { value: new THREE.Color('#2f2c27') },
      uAccent: { value: new THREE.Color('#8a3b12') },
      uLightDir: { value: new THREE.Vector3(-0.5, 0.6, 0.6) },
      uStops: { value: [0, 1, 2, 3, 4].map(() => new THREE.Color('#ffffff')) },
      uColorMode: { value: 0 },
      uAmbient: { value: 0.42 },
      uFillMix: { value: 1 },
      uLineW: { value: 0.9 },
      uLineOpacity: { value: 0.16 },
      uCrestShade: { value: 0.35 },
      uCrestLen: { value: 0.45 },
      uBaseFade: { value: 0.1 },
      uRim: { value: 0.12 },
      uShadowStr: { value: 0.45 },
      uShadowLen: { value: 1.4 },
      uShadowSteps: { value: 8 },
      uFog: { value: 0.62 },
      uFogNear: { value: 1 },
      uFogFar: { value: 40 },
      uPlay: { value: 0 },
      uPlayMode: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
    });

    this.makeControls(new THREE.Vector3(0, 1, 0));
    this.resize(); // aspect must be known before the view is framed
    this.setView('reference', false);
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  makeControls(up) {
    const prev = this.controls;
    const target = prev ? prev.target.clone() : new THREE.Vector3(0, 1, 0);
    if (prev) prev.dispose();
    this.camera.up.copy(up);
    const c = new OrbitControls(this.camera, this.canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.screenSpacePanning = true;
    c.rotateSpeed = 0.75;
    c.zoomSpeed = 0.9;
    c.minDistance = 0.6;
    c.maxDistance = 300;
    c.target.copy(target);
    // Give the camera back the moment it is touched, and only ease auto move
    // back in once the user has let go for a moment.
    c.addEventListener('start', () => { this.userActive = true; this.auto.ramp = 0; });
    c.addEventListener('end', () => {
      this.userActive = false;
      this.auto.idleUntil = performance.now() + 1800;
    });
    this.controls = c;
  }

  /* ------------------------------------------------------------ data --- */

  setData(h, slices, cols) {
    const fit = this.linearFloat ? THREE.LinearFilter : THREE.NearestFilter;
    if (!this.tex || this.tex.image.width !== cols || this.tex.image.height !== slices) {
      if (this.tex) this.tex.dispose();
      this.tex = new THREE.DataTexture(h, cols, slices, THREE.RedFormat, THREE.FloatType);
      this.tex.minFilter = fit;
      this.tex.magFilter = fit;
      this.tex.wrapS = THREE.ClampToEdgeWrapping;
      this.tex.wrapT = THREE.ClampToEdgeWrapping;
      this.uniforms.uHeights.value = this.tex;
      this.uniforms.uDataSize.value.set(cols, slices);
    } else {
      this.tex.image.data.set(h);
    }
    this.tex.needsUpdate = true;
    this.dataSlices = slices;
    this.dataCols = cols;
    if (this.disp.cols !== cols || !this.mesh) {
      this.disp.cols = cols;
      this.rebuild();
    }
  }

  /** Ridge count is the display density, independent of the analysis. */
  setRidges(n) {
    n = Math.max(2, Math.round(n));
    if (n === this.disp.ridges) return;
    this.disp.ridges = n;
    this.uniforms.uRidges.value = n;
    this.rebuild();
  }

  /** Visible slice of the data, as normalised start + span. */
  setWindow(start, span) {
    this.uniforms.uWinStart.value = start;
    this.uniforms.uWinSpan.value = span;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const wasSurface = this.mode === 'surface';
    this.mode = mode;
    this.uniforms.uSurface.value = mode === 'surface' ? 1 : 0;
    this.uniforms.uFillMix.value = mode === 'lines' ? 0 : 1;
    if (wasSurface !== (mode === 'surface')) this.rebuild();
  }

  rebuild() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const cols = this.disp.cols;
    const rows = this.disp.ridges;
    if (!cols || !this.tex) return;

    const ridge = this.mode !== 'surface';
    const vpc = ridge ? 2 : 1;
    const pos = new Float32Array(rows * cols * vpc * 3);
    let p = 0;
    for (let k = 0; k < rows; k++) {
      const v = rows > 1 ? k / (rows - 1) : 0.5;
      for (let c = 0; c < cols; c++) {
        const u = cols > 1 ? c / (cols - 1) : 0.5;
        pos[p++] = u; pos[p++] = 1; pos[p++] = v;            // crest
        if (ridge) { pos[p++] = u; pos[p++] = 0; pos[p++] = v; } // skirt
      }
    }

    const quads = ridge ? rows * (cols - 1) : (rows - 1) * (cols - 1);
    const idx = new Uint32Array(quads * 6);
    let q = 0;
    if (ridge) {
      for (let k = 0; k < rows; k++) {
        const base = k * cols * 2;
        for (let c = 0; c < cols - 1; c++) {
          const a = base + c * 2;
          idx[q++] = a; idx[q++] = a + 1; idx[q++] = a + 2;
          idx[q++] = a + 2; idx[q++] = a + 1; idx[q++] = a + 3;
        }
      }
    } else {
      for (let k = 0; k < rows - 1; k++) {
        for (let c = 0; c < cols - 1; c++) {
          const i = k * cols + c;
          idx[q++] = i; idx[q++] = i + cols; idx[q++] = i + 1;
          idx[q++] = i + 1; idx[q++] = i + cols; idx[q++] = i + cols + 1;
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.uniforms.uRidges.value = rows;
  }

  /* ---------------------------------------------------------- look ----- */

  set(values) {
    const u = this.uniforms;
    for (const [key, val] of Object.entries(values)) {
      const uni = u[key];
      if (!uni) continue;
      if (uni.value && uni.value.isColor) uni.value.set(val);
      else if (Array.isArray(val) && uni.value[0] && uni.value[0].isColor) {
        val.forEach((v, i) => uni.value[i] && uni.value[i].set(v));
      } else uni.value = val;
    }
    if (values.uBg !== undefined) this.renderer.setClearColor(u.uBg.value, 1);
  }

  setDims({ W, H, D }) {
    if (W !== undefined) { this.dims.W = W; this.uniforms.uW.value = W; }
    if (H !== undefined) { this.dims.H = H; this.uniforms.uHt.value = H; }
    if (D !== undefined) { this.dims.D = D; this.uniforms.uD.value = D; }
  }

  setLight(azDeg, elDeg) {
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    this.uniforms.uLightDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  }

  setPlayhead(v, mode) {
    this.uniforms.uPlay.value = v;
    this.uniforms.uPlayMode.value = mode;
  }

  setRenderScale(s) {
    this.renderScale = s;
    this.resize();
  }

  /* -------------------------------------------------------- camera ----- */

  setView(name, animate = true) {
    const { W, H, D } = this.dims;
    let up = new THREE.Vector3(0, 1, 0);
    let pos;
    let tgt = new THREE.Vector3(0, H * 0.35, 0);
    switch (name) {
      case 'front':
        pos = new THREE.Vector3(0, H * 0.85, D * 0.5 + W * 1.6);
        break;
      case 'side':
        pos = new THREE.Vector3(W * 0.5 + D * 1.8, H * 1.4, 0.001);
        break;
      case 'low':
        pos = new THREE.Vector3(-W * 0.62, H * 0.55, D * 0.5 + W * 1.0);
        tgt = new THREE.Vector3(0, H * 0.28, 0);
        break;
      case 'top':
        up = new THREE.Vector3(1, 0, 0);
        pos = new THREE.Vector3(0, Math.max(W, D) * 1.9, 0);
        tgt = new THREE.Vector3(0, 0, 0);
        break;
      case 'reference':
      default:
        pos = new THREE.Vector3(-W * 0.08, H * 1.25 + D * 0.25, D * 0.55 + W * 1.5);
        break;
    }
    // a narrow viewport needs more distance to fit the same width
    const fit = Math.max(1, 1.55 / Math.max(this.camera.aspect, 0.35));
    pos.sub(tgt).multiplyScalar(fit).add(tgt);

    if (!this.camera.up.equals(up)) {
      this.makeControls(up);
      animate = false;
    }
    if (animate) {
      this.tween = {
        p0: this.camera.position.clone(),
        t0: this.controls.target.clone(),
        p1: pos,
        t1: tgt,
        start: performance.now(),
        dur: 650,
      };
    } else {
      this.camera.position.copy(pos);
      this.controls.target.copy(tgt);
      this.controls.update();
    }
  }

  setAutoMove(on, speed) {
    if (on && !this.auto.on) this.auto.ramp = 0;
    this.auto.on = on;
    if (speed !== undefined) this.auto.speed = speed;
  }

  driftCamera(dt) {
    const a = this.auto;
    a.ramp = Math.min(1, a.ramp + dt / 1.6);
    const ease = a.ramp * a.ramp * (3 - 2 * a.ramp); // velocity eases in, so nothing lurches
    const step = dt * a.speed * ease;
    const t0 = a.t;
    const t1 = (a.t += step);

    const TAU = Math.PI * 2;
    const sway = (t) => 0.17 * Math.sin((t * TAU) / 21); // elevation, about +/-10 degrees
    const breathe = (t) => 0.12 * Math.sin((t * TAU) / 29 + 1.3); // distance, +/-12%

    // Differences of bounded curves telescope, so the camera can never wander off.
    const off = this._off.copy(this.camera.position).sub(this.controls.target);
    const sph = this._sph.setFromVector3(off);
    sph.theta += step * (TAU / 30); // one full orbit every 30s at speed 1
    sph.phi = Math.min(Math.PI - 0.05, Math.max(0.05, sph.phi - (sway(t1) - sway(t0))));
    sph.radius *= (1 + breathe(t1)) / (1 + breathe(t0));
    off.setFromSpherical(sph);
    this.camera.position.copy(this.controls.target).add(off);
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    const pr = Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
    this.renderer.setPixelRatio(Math.min(pr, 3));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.start) / this.tween.dur);
      const e = easeInOut(t);
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, e);
      this.controls.target.lerpVectors(this.tween.t0, this.tween.t1, e);
      if (t >= 1) this.tween = null;
    }

    const now = performance.now();
    const dt = Math.min(0.1, (now - this.auto.last) / 1000);
    this.auto.last = now;
    const canDrift =
      this.auto.on && !this.tween && !this.userActive && now >= this.auto.idleUntil && this.camera.up.y > 0.5;
    if (canDrift) this.driftCamera(dt);
    else this.auto.ramp = 0;

    this.controls.update();

    const ext = Math.max(this.dims.W, this.dims.D);
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.uniforms.uFogNear.value = dist - ext * 0.3;
    this.uniforms.uFogFar.value = dist + ext * 0.8;

    if (this.onFrame) this.onFrame();
    this.renderer.render(this.scene, this.camera);
  }
}
