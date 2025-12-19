// Creates core Three.js objects (scene/camera/renderer/controls) shared by the app.
import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";

export function createCore() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xcfe9ff, 30, 220);

  const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );

  const canvas = document.getElementById("webgl-canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const controls = new PointerLockControls(camera, renderer.domElement);
  scene.add(controls.getObject());
  camera.position.set(0, 0, 0);

  const clock = new THREE.Clock();

  return { scene, camera, renderer, controls, pmremGenerator, clock };
}
