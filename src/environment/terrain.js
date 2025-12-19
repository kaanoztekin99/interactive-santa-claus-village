// Builds the procedural snow terrain and exposes helpers to sample its height.
import * as THREE from "three";
import { TERRAIN } from "../config/constants.js";

export function createTerrain() {
  const size = TERRAIN.SIZE;
  const seg = 220;

  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const amp = 3.5;
  const freq = 0.045;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h =
      0.6 * noise2D(x * freq, z * freq) +
      0.3 * noise2D(x * freq * 2.2, z * freq * 2.2) +
      0.1 * noise2D(x * freq * 6.0, z * freq * 6.0);

    pos.setY(i, (h - 0.5) * 2.0 * amp);
  }

  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "terrain";
  return mesh;
}

const downRay = new THREE.Raycaster();
const downOrigin = new THREE.Vector3();

export function sampleGroundY(terrainMesh, x, z, fallback = 0) {
  if (!terrainMesh) return fallback;

  downOrigin.set(x, 200, z);
  downRay.set(downOrigin, new THREE.Vector3(0, -1, 0));

  const hits = downRay.intersectObject(terrainMesh, false);
  return hits.length ? hits[0].point.y : fallback;
}

function noise2D(x, z) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

  const sx = smoothstep(x - x0);
  const sz = smoothstep(z - z0);

  const n00 = hash2D(x0, z0);
  const n10 = hash2D(x1, z0);
  const n01 = hash2D(x0, z1);
  const n11 = hash2D(x1, z1);

  const ix0 = lerp(n00, n10, sx);
  const ix1 = lerp(n01, n11, sx);
  return lerp(ix0, ix1, sz);
}

function hash2D(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
