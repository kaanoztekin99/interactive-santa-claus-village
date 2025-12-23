// src/collision/colliders.js
// ------------------------------------------------------------
// Realistic-ish player collisions against scene objects.
//
// What changed vs your original version:
// - Before: if player was inside ANY box -> teleport back to previous position.
// - Now: player is treated like a vertical capsule/cylinder (in practice: circle in XZ + height),
//        and we PUSH the player out of the collider while allowing sliding along surfaces.
// - This is much closer to how FPS games feel.
//
// Notes / assumptions:
// - We resolve collisions primarily in XZ (horizontal). Vertical collisions (stairs/ceilings)
//   are intentionally minimal because your "ground" is the terrain height sampler.
// - Colliders are still axis-aligned bounding boxes (AABB). That's a good tradeoff:
//   works for GLB models, fast, and usually "good enough" if you keep minSize filtering.
// ------------------------------------------------------------

import * as THREE from "three";
import { PLAYER } from "../config/constants.js";

const colliderBoxes = [];

/**
 * Optional helper: clear existing colliders (useful when reloading scenes).
 */
export function clearColliders() {
  colliderBoxes.length = 0;
}

/**
 * Collects AABB colliders from an object hierarchy (e.g., a loaded GLB scene).
 *
 * Tips for GLB:
 * - Mark non-collidable meshes with `mesh.userData.noCollider = true`
 * - Or name them with "nocollide"
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

    // Expand slightly so the player doesn't "clip" visually into thin surfaces.
    tmpBox.expandByScalar(expand);

    colliderBoxes.push(tmpBox.clone());
  });
}

export function getColliderBoxesCount() {
  return colliderBoxes.length;
}

// ------------------------------------------------------------
// Collision resolution (player capsule/cylinder vs AABBs)
// ------------------------------------------------------------

const _closest = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * Push player out of an AABB in XZ.
 *
 * playerPos: world position (either eye position or feet position - see opts.eyeOffset)
 */
function resolveOneBoxXZ(playerPos, box, radius, height, eyeOffset, skin) {
  // Compute the vertical span of the player capsule/cylinder.
  // We only collide with boxes that overlap vertically with the player.
  const feetY = playerPos.y - eyeOffset;
  const headY = feetY + height;

  if (headY < box.min.y || feetY > box.max.y) {
    return false; // no vertical overlap -> no collision
  }

  // Closest point on AABB to player's XZ (we don't care about Y here)
  const cx = THREE.MathUtils.clamp(playerPos.x, box.min.x, box.max.x);
  const cz = THREE.MathUtils.clamp(playerPos.z, box.min.z, box.max.z);

  const dx = playerPos.x - cx;
  const dz = playerPos.z - cz;

  const distSq = dx * dx + dz * dz;
  const r = radius + skin;

  if (distSq >= r * r) return false;

  // If we're exactly on the closest point (inside box center line),
  // choose a stable push direction based on nearest face.
  if (distSq < 1e-12) {
    const toMinX = Math.abs(playerPos.x - box.min.x);
    const toMaxX = Math.abs(box.max.x - playerPos.x);
    const toMinZ = Math.abs(playerPos.z - box.min.z);
    const toMaxZ = Math.abs(box.max.z - playerPos.z);

    const min = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);

    if (min === toMinX) playerPos.x = box.min.x - r;
    else if (min === toMaxX) playerPos.x = box.max.x + r;
    else if (min === toMinZ) playerPos.z = box.min.z - r;
    else playerPos.z = box.max.z + r;

    return true;
  }

  // Normal case: push out along the radial direction from closest point to player.
  const dist = Math.sqrt(distSq);
  const push = (r - dist);

  const nx = dx / dist;
  const nz = dz / dist;

  playerPos.x += nx * push;
  playerPos.z += nz * push;

  return true;
}

/**
 * Resolve collisions against registered collider boxes.
 *
 * Backwards compatible signature:
 *   resolveCollisions(playerPosition, prevPlayerPos, onCollision)
 *
 * Extended usage (recommended):
 *   resolveCollisions(playerPosition, prevPlayerPos, onCollision, {
 *     radius: 0.45,
 *     height: 1.8,
 *     eyeOffset: 1.7,   // if playerPosition is camera/eye
 *     maxIters: 4,
 *     skin: 0.01
 *   })
 */
export function resolveCollisions(playerPosition, prevPlayerPos, onCollision, opts = {}) {
  const radius = opts.radius ?? (PLAYER?.RADIUS ?? 0.45);
  const height = opts.height ?? (PLAYER?.HEIGHT ?? 1.8);
  const eyeOffset = opts.eyeOffset ?? 0.0; // 0 => playerPosition is feet. Use EYE_HEIGHT if it's eye.
  const maxIters = opts.maxIters ?? 4;
  const skin = opts.skin ?? 0.01;

  let collided = false;

  // Multiple iterations help in corners (two boxes at once).
  for (let iter = 0; iter < maxIters; iter++) {
    let anyThisIter = false;

    for (let i = 0; i < colliderBoxes.length; i++) {
      const box = colliderBoxes[i];
      const hit = resolveOneBoxXZ(playerPosition, box, radius, height, eyeOffset, skin);
      if (hit) {
        anyThisIter = true;
        collided = true;

        if (onCollision) onCollision(box);
      }
    }

    if (!anyThisIter) break;
  }

  // Safety: if something produced NaN (shouldn't, but GL math can get wild),
  // revert to previous position.
  if (!Number.isFinite(playerPosition.x) || !Number.isFinite(playerPosition.y) || !Number.isFinite(playerPosition.z)) {
    playerPosition.copy(prevPlayerPos);
    return true;
  }

  return collided;
}
