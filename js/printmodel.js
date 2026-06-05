/* ============================================================
   printmodel.js — turn the spectrogram into a 3D-PRINTABLE solid
   ------------------------------------------------------------
   The on-screen terrain is just a thin draped surface. A printer needs a
   watertight, manifold SOLID. So we build a "relief tile": a flat plinth
   with the spectrogram raised on top, sealed with side walls and a bottom.

   Because it's a heightfield (one height per X,Z cell) it prints base-down
   with no true overhangs. Positions are authored directly in millimetres,
   so the exported STL drops straight into a slicer at real size.
   ============================================================ */

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

const PW = 220;          // print grid columns (time)
const PH = 120;          // print grid rows (frequency)

export class PrintModel {
  constructor(scene) {
    this.scene = scene;
    this.spec = null;
    this.mesh = null;
    this.name = 'audio-terrain';

    // adjustable parameters (millimetres / blur radius)
    this.sizeMM = 120;     // width along time
    this.smoothing = 1;    // box-blur radius, 0 = crisp

    const mat = new THREE.MeshStandardMaterial({
      color: 0x7e84a0,     // mid clay tone (kept below the bloom threshold)
      roughness: 0.92,
      metalness: 0.0,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.scene.add(this.mesh);
    this.setVisible(false);
  }

  /** Store the spectrogram and build the first solid. */
  build(spec, name) {
    this.spec = spec;
    if (name) this.name = name.replace(/\.[^.]+$/, '') || 'audio-terrain';
    this.rebuild();
  }

  setSize(mm)      { this.sizeMM = mm;  this.rebuild(); }
  setSmoothing(r)  { this.smoothing = r; this.rebuild(); }
  setVisible(v)    { this.mesh.visible = v; }

  /* Sample the (large) spectrogram down to the print grid, then blur. */
  _sampleGrid() {
    const { data, width: sw, height: sh } = this.spec;
    const g = new Float32Array(PW * PH);
    for (let pz = 0; pz < PH; pz++) {
      const sy = Math.round((pz / (PH - 1)) * (sh - 1));
      for (let px = 0; px < PW; px++) {
        const sx = Math.round((px / (PW - 1)) * (sw - 1));
        g[pz * PW + px] = data[sy * sw + sx];
      }
    }
    return this._blur(g, this.smoothing);
  }

  _blur(g, r) {
    r = Math.round(r);
    if (r <= 0) return g;
    let src = g;
    for (let pass = 0; pass < r; pass++) {
      const dst = new Float32Array(PW * PH);
      for (let z = 0; z < PH; z++) {
        for (let x = 0; x < PW; x++) {
          let sum = 0, n = 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, nz = z + dz;
              if (nx < 0 || nx >= PW || nz < 0 || nz >= PH) continue;
              sum += src[nz * PW + nx]; n++;
            }
          }
          dst[z * PW + x] = sum / n;
        }
      }
      src = dst;
    }
    return src;
  }

  /** Rebuild the watertight solid from the current parameters. */
  rebuild() {
    if (!this.spec) return;
    const grid = this._sampleGrid();

    const widthMM  = this.sizeMM;
    const depthMM  = this.sizeMM * 0.55;
    const reliefMM = this.sizeMM * 0.18;
    const baseMM   = Math.max(3, this.sizeMM * 0.04);

    const x = px => (px / (PW - 1)) * widthMM - widthMM / 2;
    const z = pz => (pz / (PH - 1)) * depthMM - depthMM / 2;
    const topY = (px, pz) => baseMM + Math.pow(grid[pz * PW + px], 1.1) * reliefMM;

    // Non-indexed triangle soup; orientation is fixed afterwards so we
    // don't have to track winding by hand.
    const tris = [];
    const T = (ax,ay,az, bx,by,bz, cx,cy,cz) =>
      tris.push(ax,ay,az, bx,by,bz, cx,cy,cz);

    // top surface
    for (let pz = 0; pz < PH - 1; pz++) {
      for (let px = 0; px < PW - 1; px++) {
        const x0 = x(px), x1 = x(px+1), z0 = z(pz), z1 = z(pz+1);
        const a = topY(px,pz),   b = topY(px+1,pz);
        const c = topY(px+1,pz+1), d = topY(px,pz+1);
        T(x0,a,z0,  x0,d,z1,  x1,c,z1);
        T(x0,a,z0,  x1,c,z1,  x1,b,z0);
      }
    }
    // flat bottom (y = 0)
    for (let pz = 0; pz < PH - 1; pz++) {
      for (let px = 0; px < PW - 1; px++) {
        const x0 = x(px), x1 = x(px+1), z0 = z(pz), z1 = z(pz+1);
        T(x0,0,z0,  x1,0,z1,  x0,0,z1);
        T(x0,0,z0,  x1,0,z0,  x1,0,z1);
      }
    }
    // side walls (front/back along X, left/right along Z)
    for (let px = 0; px < PW - 1; px++) {
      // front edge pz = 0
      let x0 = x(px), x1 = x(px+1), zf = z(0);
      let a = topY(px,0), b = topY(px+1,0);
      T(x0,a,zf,  x1,b,zf,  x0,0,zf);
      T(x1,b,zf,  x1,0,zf,  x0,0,zf);
      // back edge pz = PH-1
      let zb = z(PH-1);
      a = topY(px,PH-1); b = topY(px+1,PH-1);
      T(x0,a,zb,  x0,0,zb,  x1,b,zb);
      T(x1,b,zb,  x0,0,zb,  x1,0,zb);
    }
    for (let pz = 0; pz < PH - 1; pz++) {
      // left edge px = 0
      let z0 = z(pz), z1 = z(pz+1), xl = x(0);
      let a = topY(0,pz), b = topY(0,pz+1);
      T(xl,a,z0,  xl,0,z0,  xl,b,z1);
      T(xl,b,z1,  xl,0,z0,  xl,0,z1);
      // right edge px = PW-1
      let xr = x(PW-1);
      a = topY(PW-1,pz); b = topY(PW-1,pz+1);
      T(xr,a,z0,  xr,b,z1,  xr,0,z0);
      T(xr,b,z1,  xr,0,z1,  xr,0,z0);
    }

    const pos = new Float32Array(tris);
    this._fixOutwardNormals(pos);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;

    this.triangleCount = pos.length / 9;
    this.dims = { w: widthMM, d: depthMM, h: baseMM + reliefMM };
  }

  /* Flip any triangle whose normal points toward the centroid, so all
     faces point outward (valid for this star-shaped-from-center solid). */
  _fixOutwardNormals(pos) {
    let cx = 0, cy = 0, cz = 0;
    const n = pos.length / 3;
    for (let i = 0; i < pos.length; i += 3) { cx += pos[i]; cy += pos[i+1]; cz += pos[i+2]; }
    cx /= n; cy /= n; cz /= n;

    const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cxv = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3(), mid = new THREE.Vector3();
    for (let i = 0; i < pos.length; i += 9) {
      ax.set(pos[i],   pos[i+1], pos[i+2]);
      bx.set(pos[i+3], pos[i+4], pos[i+5]);
      cxv.set(pos[i+6],pos[i+7], pos[i+8]);
      e1.subVectors(bx, ax); e2.subVectors(cxv, ax);
      nrm.crossVectors(e1, e2);
      mid.set((ax.x+bx.x+cxv.x)/3 - cx, (ax.y+bx.y+cxv.y)/3 - cy, (ax.z+bx.z+cxv.z)/3 - cz);
      if (nrm.dot(mid) < 0) {
        // swap vertices b and c to reverse winding
        for (let k = 0; k < 3; k++) {
          const t = pos[i+3+k]; pos[i+3+k] = pos[i+6+k]; pos[i+6+k] = t;
        }
      }
    }
  }

  /** Export the current solid as a binary STL download. */
  exportSTL() {
    if (!this.spec) return;
    const data = new STLExporter().parse(this.mesh, { binary: true });
    const blob = new Blob([data], { type: 'model/stl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.name}.stl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  get size() {
    return { WIDTH: this.sizeMM, DEPTH: this.sizeMM * 0.55, HEIGHT: this.sizeMM * 0.22 };
  }
}
