// src/environment/shadows.js
// -----------------------------------------------------------------------------
// Follow-player directional shadow frustum (FPS-friendly).
// - Center is pushed forward in the view direction (lookAhead)
// - Snap only XZ to reduce shimmering (never snap Y)
// -----------------------------------------------------------------------------

import * as THREE from "three";

export function createSunShadowFollower(sun, scene, opts = {}) {
  const {
    radius = 260, // piu piccolo = piu qualita; aumenta se ti spariscono ombre
    sunOffset = new THREE.Vector3(-300, 600, 200),
    near = 10,
    far = 1800,
    snap = 2,     // snap XZ (metri). 0 per disattivare
    lookAhead = 160, // quanto avanti mettere il box nella direzione di vista
  } = opts;

  if (!sun || !sun.isDirectionalLight) {
    throw new Error("createSunShadowFollower: 'sun' must be a THREE.DirectionalLight.");
  }

  if (sun.target && sun.target.parent !== scene) {
    scene.add(sun.target);
  }

  const cam = sun.shadow.camera;

  cam.left = -radius;
  cam.right = radius;
  cam.top = radius;
  cam.bottom = -radius;
  cam.near = near;
  cam.far = far;

  const center = new THREE.Vector3();
  const snapped = new THREE.Vector3();
  const sunPos = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  /**
   * @param {THREE.Vector3} targetGroundPos - posizione player "a terra" (world)
   * @param {THREE.Vector3} cameraWorldDir  - direzione camera (world, normalizzata)
   */
  function update(targetGroundPos, cameraWorldDir) {
    if (!targetGroundPos) return;

    // forward (XZ) per mettere il box dove stai guardando
    if (cameraWorldDir) {
      fwd.copy(cameraWorldDir);
      fwd.y = 0;
      if (fwd.lengthSq() > 1e-8) fwd.normalize();
      else fwd.set(0, 0, -1);
    } else {
      fwd.set(0, 0, -1);
    }

    center.copy(targetGroundPos).addScaledVector(fwd, lookAhead);

    // Snap SOLO X/Z
    if (snap > 0) {
      snapped.set(
        Math.round(center.x / snap) * snap,
        center.y,
        Math.round(center.z / snap) * snap
      );
    } else {
      snapped.copy(center);
    }

    sun.target.position.copy(snapped);
    sun.target.updateMatrixWorld(true);

    sunPos.copy(snapped).add(sunOffset);
    sun.position.copy(sunPos);
    sun.updateMatrixWorld(true);

    cam.updateProjectionMatrix();
  }

  return { update };
}
