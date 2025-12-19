// Entry point for the interactive village scene; initializes modules and drives the render loop.
import { HDRI_PATH, MODEL_PATH } from "./src/config/constants.js";
import { createCore } from "./src/core/setupCore.js";
import { enableResizeHandling } from "./src/core/resize.js";
import { addLights } from "./src/environment/lights.js";
import { loadHDRI } from "./src/environment/hdri.js";
import { createTerrain, sampleGroundY } from "./src/environment/terrain.js";
import { createLandmarks } from "./src/environment/landmarks.js";
import { loadSketchfabModel } from "./src/models/sketchfabLoader.js";
import { FirstPersonController } from "./src/player/firstPersonController.js";

const { scene, camera, renderer, controls, pmremGenerator, clock } = createCore();

addLights(scene);

const terrainMesh = createTerrain();
scene.add(terrainMesh);

const sampleGround = (x, z, fallback = 0) => sampleGroundY(terrainMesh, x, z, fallback);

createLandmarks(scene, sampleGround);
loadHDRI(HDRI_PATH, scene, pmremGenerator);

loadSketchfabModel({
  path: MODEL_PATH,
  scene,
  sampleGround,
  x: 0,
  z: 0,
  targetHeight: 6.0,
  yawDeg: 0,
  yOffset: 0.0,
  addToCollisions: true,
});

const playerController = new FirstPersonController({
  controls,
  camera,
  domElement: renderer.domElement,
  groundSampler: sampleGround,
});
playerController.spawnAt(0, 8);

enableResizeHandling(camera, renderer);

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  playerController.update(dt);
  renderer.render(scene, camera);
}

animate();
