// src/environment/lights.js
// -----------------------------------------------------------------------------
// Global lighting rig for the scene.
// - Hemisphere light: soft "sky vs ground" fill (great for snow scenes).
// - Directional light ("sun"): main key light, casts shadows.
//
// This module ONLY creates/configures lights.
// It does NOT implement the "shadow camera follows the player" behavior.
// That part lives in src/environment/shadows.js.
// -----------------------------------------------------------------------------

import * as THREE from "three";

/**
 * Adds a consistent lighting setup to the scene and returns references.
 *
 * Why we return the sun:
 * - Directional light shadows need an update loop if you want stable quality
 *   while walking around a big terrain (follow-player shadow frustum).
 *
 * @param {THREE.Scene} scene
 * @param {object} [opts]
 * @param {number} [opts.hemiIntensity=0.35]
 * @param {number} [opts.sunIntensity=1.2]
 * @param {number} [opts.shadowMapSize=2048]
 * @returns {{ hemi: THREE.HemisphereLight, sun: THREE.DirectionalLight }}
 */
export function addLights(scene, opts = {}) {
  const {
    hemiIntensity = 0.35,
    sunIntensity = 1.2,
    shadowMapSize = 2048,
  } = opts;

  // HemisphereLight simulates a bright sky and a darker ground bounce.
  // For snowy scenes, a soft fill prevents harsh black shadows everywhere.
  const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, hemiIntensity);
  hemi.name = "HemiLight";
  scene.add(hemi);

  // DirectionalLight = "sun".
  // Shadows come from THIS light (not from HDRI/IBL).
  const sun = new THREE.DirectionalLight(0xffffff, sunIntensity);
  sun.name = "SunLight";

  // Enable shadow casting for this light.
  sun.castShadow = true;

  // Shadow map resolution (quality vs performance).
  // 2048 is a good baseline for desktop; 1024 for weaker GPUs.
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);

  // Bias settings:
  // - normalBias helps fight shadow acne on detailed meshes (GLB, terrain normals).
  // - bias is sometimes needed too, but it can cause "peter panning" if too large.
  // Start with a small normalBias; tune if you see artifacts.
  sun.shadow.normalBias = 0.5; // conservative default for snowy terrain + GLB
  sun.shadow.bias = -0.00005;

  // IMPORTANT:
  // We do NOT finalize the shadow camera frustum here.
  // For large environments (1km terrain), a fixed frustum is either:
  // - too small -> shadows disappear when you walk
  // - too big   -> shadows get blurry (shadow texels spread over huge area)
  //
  // The follow-player shadow frustum is implemented in shadows.js.

  // Set a reasonable "default" direction and height.
  // shadows.js will reposition this relative to the player each frame,
  // but these defaults are still useful during loading.
  sun.position.set(-300, 600, 200);

  // DirectionalLight uses an internal OrthographicCamera for shadows.
  // We'll keep wide defaults; shadows.js will overwrite them continuously.
  const cam = sun.shadow.camera;
  cam.near = 1;
  cam.far = 2500;
  cam.left = -700;
  cam.right = 700;
  cam.top = 700;
  cam.bottom = -700;

  scene.add(sun);

  // NOTE: DirectionalLight has a "target" object.
  // If you want the sun to consistently point at the player, you must add
  // sun.target to the scene and update its position in the shadow-follow system.
  scene.add(sun.target);

  return { hemi, sun };
}
