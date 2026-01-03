// src/environment/lights.js
// -----------------------------------------------------------------------------
// Global lighting rig for the scene.
// -----------------------------------------------------------------------------

import * as THREE from "three";

export function addLights(scene, opts = {}) {
  const {
    hemiIntensity = 0.55,     // un po' piu fill -> ombre meno "nere"
    sunIntensity = 1.1,
    shadowMapSize = 4096,     // se il PC regge: molto meglio su terrain
  } = opts;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, hemiIntensity);
  hemi.name = "HemiLight";
  scene.add(hemi);

  // Piccolo ambient per togliere il “catrame” dalle ombre (molto leggero)
  const amb = new THREE.AmbientLight(0xffffff, 0.08);
  amb.name = "AmbientFill";
  scene.add(amb);

  const sun = new THREE.DirectionalLight(0xffffff, sunIntensity);
  sun.name = "SunLight";
  sun.castShadow = true;

  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);

  // Bias: valori realistici.
  // normalBias 0.5 è troppo alto -> patch/ombre staccate.
  sun.shadow.normalBias = 0.12;
  sun.shadow.bias = -0.00015;

  // Defaults (verranno poi gestiti dal follower)
  sun.position.set(-300, 600, 200);

  const cam = sun.shadow.camera;
  cam.near = 10;
  cam.far = 1800;
  cam.left = -500;
  cam.right = 500;
  cam.top = 500;
  cam.bottom = -500;

  scene.add(sun);
  scene.add(sun.target);

  return { hemi, sun };
}
