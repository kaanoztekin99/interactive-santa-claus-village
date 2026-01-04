// src/collision/colliders.js
// ------------------------------------------------------------
// Fast-ish player collisions against scene objects.
// Key idea:
// - Keep AABBs (cheap), but DO NOT test all AABBs every frame.
// - Use a simple spatial hash grid on XZ to query only nearby colliders.
// - Prefer 1 collider per placed object (bounds) instead of 1 per mesh.
// ------------------------------------------------------------
import * as THREE from "three";
import { PLAYER } from "../config/constants.js";

// -------------------------
// Collider storage + grid
// -------------------------
const colliderBoxes = [];          // array<Box3>
const grid = new Map();            // key -> array<int> (indices into colliderBoxes)

// Tune this: bigger cells = fewer grid entries but more candidates per query.
// 8..16m is a good starting range for outdoor scenes.
let GRID_CELL_SIZE = 12.0;

function cellKey(ix, iz) {
  return `${ix},${iz}`;
}

function worldToCell(v) {
  return Math.floor(v / GRID_CELL_SIZE);
}

function insertIndexIntoGridForBox(box, idx) {
  const minX = worldToCell(box.min.x);
  const maxX = worldToCell(box.max.x);
  const minZ = worldToCell(box.min.z);
  const maxZ = worldToCell(box.max.z);

  for (let ix = minX; ix <= maxX; ix++) {
    for (let iz = minZ; iz <= maxZ; iz++) {
      const k = cellKey(ix, iz);
      let arr = grid.get(k);
      if (!arr) {
        arr = [];
        grid.set(k, arr);
      }
      arr.push(idx);
    }
  }
}

// -------------------------
// Public API
// -------------------------
export function clearColliders() {
  colliderBoxes.length = 0;
  grid.clear();
}

export function setColliderGridCellSize(meters) {
  GRID_CELL_SIZE = Math.max(2.0, Number(meters) || 12.0);
  // NOTE: caller should clear + rebuild colliders after changing this,
  // otherwise old entries are still mapped with old cell size.
}

export function getColliderBoxesCount() {
  return colliderBoxes.length;
}

export function getColliderGridStats() {
  return {
    cellSize: GRID_CELL_SIZE,
    cells: grid.size,
    boxes: colliderBoxes.length,
  };
}

/**
 * Register ONE collider box (already in world coords).
 */
export function registerColliderBox(box, opts = {}) {
  const expand = opts.expand ?? 0.0;
  const b = box.clone();
  if (expand !== 0) b.expandByScalar(expand);

  const idx = colliderBoxes.length;
  colliderBoxes.push(b);
  insertIndexIntoGridForBox(b, idx);
}

/**
 * Register ONE collider for an object hierarchy: its overall bounds.
 * This is what you want for most placed props/trees (fast).
 */
export function registerColliderFromObjectBounds(root, opts = {}) {
  const {
    includeInvisible = false,
    expand = 0.0,
    minSize = 0.05,
  } = opts;

  root.updateMatrixWorld(true);

  // If you want "visible only" bounds, keep it simple:
  // compute bounds from meshes that are visible.
  const box = new THREE.Box3();
  let has = false;

  const tmpBox = new THREE.Box3();
  const tmpSize = new THREE.Vector3();

  root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (!includeInvisible && obj.visible === false) return;
    if (obj.userData && obj.userData.noCollider) return;
    if ((obj.name || "").toLowerCase().includes("nocollide")) return;

    tmpBox.setFromObject(obj);
    if (tmpBox.isEmpty()) return;

    if (!has) {
      box.copy(tmpBox);
      has = true;
    } else {
      box.union(tmpBox);
    }
  });

  if (!has || box.isEmpty()) return;

  box.getSize(tmpSize);
  if (tmpSize.length() < minSize) return;

  registerColliderBox(box, { expand });
}

/**
 * Legacy function (per-mesh colliders).
 * Keep it for special cases only (e.g., big buildings where bounds is too crude).
 */
export function registerCollidersFromObject(root, opts = {}) {
  const {
    expand = PLAYER?.RADIUS ?? 0.45,
    includeInvisible = false,
    ignoreNoColliderTag = true,
    minSize = 0.02,
  } = opts;

  root.updateMatrixWorld(true);

  const tmpBox = new THREE.Box3();
  const tmpSize = new THREE.Vector3();

  root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (!includeInvisible && obj.visible === false) return;

    if (ignoreNoColliderTag) {
      if (obj.userData && obj.userData.noCollider) return;
      if ((obj.name || "").toLowerCase().includes("nocollide")) return;
      if ((obj.parent?.name || "").toLowerCase().includes("nocollide")) return;
    }

    const mat = obj.material;
    if (mat && mat.transparent && mat.opacity !== undefined && mat.opacity < 0.2) return;

    tmpBox.setFromObject(obj);
    if (tmpBox.isEmpty()) return;

    tmpBox.getSize(tmpSize);
    if (tmpSize.length() < minSize) return;

    tmpBox.expandByScalar(expand);

    const idx = colliderBoxes.length;
    colliderBoxes.push(tmpBox.clone());
    insertIndexIntoGridForBox(tmpBox, idx);
  });
}

// ------------------------------------------------------------
// Collision resolution (player cylinder vs AABBs) + grid query
// ------------------------------------------------------------
function resolveOneBoxXZ(playerPos, box, radius, height, eyeOffset, skin) {
  const feetY = playerPos.y - eyeOffset;
  const headY = feetY + height;
  if (headY < box.min.y || feetY > box.max.y) return false;

  const cx = THREE.MathUtils.clamp(playerPos.x, box.min.x, box.max.x);
  const cz = THREE.MathUtils.clamp(playerPos.z, box.min.z, box.max.z);

  const dx = playerPos.x - cx;
  const dz = playerPos.z - cz;

  const distSq = dx * dx + dz * dz;
  const r = radius + skin;
  if (distSq >= r * r) return false;

  if (distSq < 1e-12) {
    const toMinX = Math.abs(playerPos.x - box.min.x);
    const toMaxX = Math.abs(box.max.x - playerPos.x);
    const toMinZ = Math.abs(playerPos.z - box.min.z);
    const toMaxZ = Math.abs(box.max.z - playerPos.z);
    const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);

    if (m === toMinX) playerPos.x = box.min.x - r;
    else if (m === toMaxX) playerPos.x = box.max.x + r;
    else if (m === toMinZ) playerPos.z = box.min.z - r;
    else playerPos.z = box.max.z + r;

    return true;
  }

  const dist = Math.sqrt(distSq);
  const push = r - dist;
  const nx = dx / dist;
  const nz = dz / dist;
  playerPos.x += nx * push;
  playerPos.z += nz * push;
  return true;
}

function queryCandidateIndices(playerPos, radius) {
  // Query a small neighborhood of cells around player.
  // Use radius to decide how many cells to check.
  const r = Math.max(1.0, radius + 1.0);
  const minX = worldToCell(playerPos.x - r);
  const maxX = worldToCell(playerPos.x + r);
  const minZ = worldToCell(playerPos.z - r);
  const maxZ = worldToCell(playerPos.z + r);

  const out = [];
  const seen = new Set();

  for (let ix = minX; ix <= maxX; ix++) {
    for (let iz = minZ; iz <= maxZ; iz++) {
      const arr = grid.get(cellKey(ix, iz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const idx = arr[i];
        if (seen.has(idx)) continue;
        seen.add(idx);
        out.push(idx);
      }
    }
  }

  return out;
}

export function resolveCollisions(playerPosition, prevPlayerPos, onCollision, opts = {}) {
  const radius = opts.radius ?? (PLAYER?.RADIUS ?? 0.45);
  const height = opts.height ?? (PLAYER?.HEIGHT ?? 1.8);
  const eyeOffset = opts.eyeOffset ?? 0.0;
  const maxIters = opts.maxIters ?? 4;
  const skin = opts.skin ?? 0.01;

  let collided = false;

  // Only check nearby colliders
  const candidates = queryCandidateIndices(playerPosition, radius);

  for (let iter = 0; iter < maxIters; iter++) {
    let anyThisIter = false;

    for (let c = 0; c < candidates.length; c++) {
      const box = colliderBoxes[candidates[c]];
      const hit = resolveOneBoxXZ(playerPosition, box, radius, height, eyeOffset, skin);
      if (hit) {
        anyThisIter = true;
        collided = true;
        if (onCollision) onCollision(box);
      }
    }

    if (!anyThisIter) break;
  }

  if (
    !Number.isFinite(playerPosition.x) ||
    !Number.isFinite(playerPosition.y) ||
    !Number.isFinite(playerPosition.z)
  ) {
    playerPosition.copy(prevPlayerPos);
    return true;
  }

  return collided;
}