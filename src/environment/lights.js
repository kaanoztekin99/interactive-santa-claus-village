// Defines the global lighting rig (hemisphere + directional sun) for the scene.
import * as THREE from "three";

export function addLights(scene) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.35);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(20, 40, 10);
  sun.castShadow = true;

  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 150;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;

  scene.add(sun);
}
