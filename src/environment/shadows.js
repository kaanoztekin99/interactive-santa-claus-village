// src/environment/shadows.js
// -----------------------------------------------------------------------------
// Shadow utilities.
// Implements a "follow-player" directional shadow frustum.
//
// Why this helps:
// - With a fixed orthographic shadow camera, you must choose between:
//   (a) small frustum -> crisp shadows but they disappear when you walk away
//   (b) huge frustum  -> shadows always present but low resolution / blurry
//
// The solution used here:
// - Keep a *fixed-size* shadow box (good quality)
// - Move that box so it stays centered on the player (no disappearing shadows)
//
// This is NOT cascaded shadows, just a single moving shadow frustum.
// -----------------------------------------------------------------------------

import * as THREE from "three";

/**
 * Creates a controller that keeps a directional light's shadow camera centered
 * around a moving target (typically the player).
 *
 * @param {THREE.DirectionalLight} sun - The directional light that casts shadows.
 * @param {THREE.Scene} scene - Needed because we update sun.target.
 * @param {object} [opts]
 * @param {number} [opts.radius=350]  Half-size of the shadow box in world units (meters).
 *                                   Example: radius=350 covers a 700x700 area around player.
 * @param {THREE.Vector3} [opts.sunOffset] Where the sun is placed relative to the target.
 * @param {number} [opts.near=1]      Shadow camera near plane.
 * @param {number} [opts.far=2500]    Shadow camera far plane.
 * @param {number} [opts.snap=5]      Snap the shadow camera center to a grid to reduce shimmering.
 * @returns {{ update: (targetWorldPos: THREE.Vector3) => void }}
 */
export function createSunShadowFollower(sun, scene, opts = {}) {
  const {
    radius = 350,
    sunOffset = new THREE.Vector3(-300, 600, 200),
    near = 1,
    far = 2500,
    snap = 5,
  } = opts;

  if (!sun || !sun.isDirectionalLight) {
    throw new Error("createSunShadowFollower: 'sun' must be a THREE.DirectionalLight.");
  }

  // Ensure the sun target exists in the scene graph.
  // (Your lights.js already adds sun.target, but we keep this robust.)
  if (sun.target && sun.target.parent !== scene) {
    scene.add(sun.target);
  }

  const cam = sun.shadow.camera; // OrthographicCamera inside DirectionalLightShadow

  // Configure the orthographic shadow camera once (size stays constant).
  cam.left = -radius;
  cam.right = radius;
  cam.top = radius;
  cam.bottom = -radius;
  cam.near = near;
  cam.far = far;

  // Internal temps to avoid allocations every frame.
  const snappedTarget = new THREE.Vector3();
  const sunPos = new THREE.Vector3();

  /**
   * Update function to be called every frame after the player moved.
   * @param {THREE.Vector3} targetWorldPos - Player position on/near ground (world).
   */
  function update(targetWorldPos) {
    if (!targetWorldPos) return;

    // Optional snapping:
    // Shadow maps can shimmer when the camera moves because texel sampling changes.
    // Snapping the shadow camera center to a small grid reduces that shimmering.
    if (snap > 0) {
      snappedTarget.set(
        Math.round(targetWorldPos.x / snap) * snap,
        Math.round(targetWorldPos.y / snap) * snap,
        Math.round(targetWorldPos.z / snap) * snap
      );
    } else {
      snappedTarget.copy(targetWorldPos);
    }

    // Keep the sun aimed at the target.
    sun.target.position.copy(snappedTarget);
    sun.target.updateMatrixWorld(true);

    // Place the sun at a fixed offset relative to the target.
    // This keeps lighting direction stable even when walking far from origin.
    sunPos.copy(snappedTarget).add(sunOffset);
    sun.position.copy(sunPos);
    sun.updateMatrixWorld(true);

    // IMPORTANT:
    // For directional light shadows, the shadow camera is *in the light's space*.
    // Three.js updates it automatically based on sun + sun.target,
    // but changes to the camera frustum require an updateProjectionMatrix().
    cam.updateProjectionMatrix();
  }

  return { update };
}
