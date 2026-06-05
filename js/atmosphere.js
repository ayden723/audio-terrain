/* ============================================================
   atmosphere.js — gradient sky background + drifting star particles
   Adds depth and parallax behind the terrain instead of flat black.
   ============================================================ */

import * as THREE from 'three';

/* A vertical gradient drawn to a canvas, used as the scene background. */
function makeSkyTexture(top, bottom) {
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createAtmosphere(scene) {
  // --- gradient background ---
  scene.background = makeSkyTexture('#03040a', '#0a0e22');

  // --- drifting particle field ---
  const COUNT = 900;
  const positions = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    const r = 600 + Math.random() * 1100;        // distance from center
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i*3+0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = 80 + Math.abs(r * Math.cos(phi)) * 0.6; // keep above ground
    positions[i*3+2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.PointsMaterial({
    color: 0x9fb4ff,
    size: 2.2,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const points = new THREE.Points(geo, mat);
  const group = new THREE.Group();
  group.add(points);
  scene.add(group);

  return {
    group,
    update() { group.rotation.y += 0.0002; }, // slow drift
  };
}
