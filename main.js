// main.js
import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { createAbiskoTerrain } from "./src/environment/abiskoTerrain.js";
import { addLights } from "./src/environment/lights.js";
import { createSunShadowFollower } from "./src/environment/shadows.js";
import { loadHDRI } from "./src/environment/hdri.js";

import {
  registerCollidersFromObject,
  resolveCollisions,
} from "./src/collision/colliders.js";

const canvas = document.querySelector("#webgl-canvas");

// ------------------------------------------------------------
// Renderer / Scene / Camera
// ------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// Shadows must be enabled on the renderer, otherwise lights can't cast shadows.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb9ff);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  8000
);

// ------------------------------------------------------------
// Player tuning
// IMPORTANT: controls.object.position is our "player position".
// Here we treat it as the EYE position (camera).
// ------------------------------------------------------------
const EYE_HEIGHT = 1.7; // meters above the snow (camera height)
const PLAYER_HEIGHT = 1.8; // used for object collisions
const PLAYER_RADIUS = 0.45; // used for object collisions

const MOVE_SPEED = 50.0; // m/s
const GRAVITY = 30.0; // m/s^2
const GROUND_EPS = 0.03; // tiny lift to avoid clipping into snow

// Initial camera (will be re-positioned once terrain is ready)
camera.position.set(0, 120, 180);

// Pointer lock controls (FPS)
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.object);

document.addEventListener("click", () => {
  if (!controls.isLocked) controls.lock();
});

// ------------------------------------------------------------
// Lights + Shadow system
// ------------------------------------------------------------

// Create lights via module (keeps main.js clean and consistent).
const { sun } = addLights(scene, {
  // Keep values aligned with your old main.js defaults:
  hemiIntensity: 0.35,
  sunIntensity: 1.2,
  shadowMapSize: 2048,
});

// Create a "shadow follower" so shadows don't disappear when you walk far away.
// The radius is the HALF-size of the shadow box around the player.
// Increase if you want shadows visible farther away; decrease for sharper shadows.
const shadowFollower = createSunShadowFollower(sun, scene, {
  radius: 350,
  // Keeps the same sun direction/feel as your previous hard-coded position.
  sunOffset: new THREE.Vector3(-300, 600, 200),
  near: 1,
  far: 2500,
  // Snapping reduces shimmer when moving. Try 0 to disable.
  snap: 5,
});

// ------------------------------------------------------------
// HDRI (EXR) via module
// ------------------------------------------------------------
// IMPORTANT:
// - HDRI/IBL makes materials look realistic (diffuse + reflections).
// - It does NOT create sharp shadows by itself. Shadows come from DirectionalLight.
// - Your current hdri.js disposes the PMREM generator inside loadHDRI().
//   That's fine if you load exactly one HDRI during startup.
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
loadHDRI("./assets/skybox/horn-koppe_snow_4k.exr", scene, pmrem);

// ------------------------------------------------------------
// Terrain
// ------------------------------------------------------------
let terrain = null;
let terrainReady = false;

function getGroundY(x, z) {
  // If terrain isn't ready OR getHeightAt isn't present, return null.
  // Returning null is critical: it prevents "fall forever" behavior.
  const fn = terrain?.userData?.getHeightAt;
  if (!terrainReady || typeof fn !== "function") return null;

  const y = fn(x, z);
  return Number.isFinite(y) ? y : null;
}

(async () => {
  try {
    terrain = await createAbiskoTerrain({
      heightUrl: "/assets/terrain/height_1km_2m_16bit.png",
      slopeUrl: "/assets/terrain/slope_deg.png",
      hillshadeUrl: "/assets/terrain/hillshade.png",
    });

    terrain.position.set(0, 0, 0);
    scene.add(terrain);

    // Debug grid (optional)
    const grid = new THREE.GridHelper(1000, 20, 0x334455, 0x334455);
    grid.position.y = 0.02;
    scene.add(grid);

    terrainReady = true;

    // Spawn the player safely above the snow at (0,0)
    const y0 = getGroundY(0, 0);
    const safeY = (y0 ?? 0) + EYE_HEIGHT + 5.0;
    controls.object.position.set(0, safeY, 0);
  } catch (e) {
    console.error("Failed to create Abisko terrain:", e);
  }
})();

// ------------------------------------------------------------
// Model loader (GLB) + Colliders + Place on snow
// ------------------------------------------------------------
const gltfLoader = new GLTFLoader();

gltfLoader.load(
  "./assets/models/winter_camping.glb",
  (gltf) => {
    const model = gltf.scene;
    model.name = "VillageModel";

    model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    // Choose where you want the model in XZ (world coordinates)
    model.position.set(20, 0, -15);
    model.scale.set(1, 1, 1);

    // Add to scene first so Box3 measures correctly
    scene.add(model);

    // Register colliders from the GLB (AABBs from meshes)
    // If you have meshes that should NOT collide, set mesh.userData.noCollider = true
    registerCollidersFromObject(model, {
      expand: 0.02, // small expansion; big values make collisions feel "fat"
      minSize: 0.05, // ignore tiny decorative meshes
    });

    // Place the model on the snow:
    // 1) compute model bounding box in world
    // 2) lift so its bottom touches ground at its XZ
    const placeOnSnow = () => {
      const groundY = getGroundY(model.position.x, model.position.z);
      if (groundY == null) return; // terrain not ready yet

      const box = new THREE.Box3().setFromObject(model);
      const lift = groundY + GROUND_EPS - box.min.y;
      model.position.y += lift;
    };

    placeOnSnow();

    // If terrain wasn't ready at load time, re-try once shortly after.
    // (No timers needed if you prefer: you can also re-place in the render loop once.)
    const tryLater = () => {
      if (terrainReady) placeOnSnow();
      else requestAnimationFrame(tryLater);
    };
    tryLater();
  },
  undefined,
  (err) => console.warn("GLB failed to load:", err)
);

// ------------------------------------------------------------
// Simple WASD movement + gravity + terrain clamp + object collisions
// ------------------------------------------------------------
const keys = new Set();
window.addEventListener("keydown", (e) => keys.add(e.code));
window.addEventListener("keyup", (e) => keys.delete(e.code));

const velocity = new THREE.Vector3();
const dir = new THREE.Vector3();
const clock = new THREE.Clock();

// Temp to avoid allocations every frame.
const playerGroundPos = new THREE.Vector3();

function tick() {
  requestAnimationFrame(tick);

  const dt = Math.min(clock.getDelta(), 0.033);

  if (controls.isLocked) {
    // Save previous position for robust collision fallback
    const prevPos = controls.object.position.clone();

    // ----------------------------
    // Input -> desired direction
    // ----------------------------
    dir.set(0, 0, 0);
    if (keys.has("KeyW")) dir.z += 1;
    if (keys.has("KeyS")) dir.z -= 1;
    if (keys.has("KeyA")) dir.x -= 1;
    if (keys.has("KeyD")) dir.x += 1;
    dir.normalize();

    // Convert local direction to world direction using camera yaw
    const forward = new THREE.Vector3();
    controls.object.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0))
      .normalize();

    const move = new THREE.Vector3()
      .addScaledVector(forward, dir.z)
      .addScaledVector(right, dir.x);

    if (move.lengthSq() > 1e-8) move.normalize();

    // Horizontal velocity (instant, FPS style)
    velocity.x = move.x * MOVE_SPEED;
    velocity.z = move.z * MOVE_SPEED;

    // ----------------------------
    // Gravity: ONLY apply if we have a valid ground sample.
    // This single rule prevents the "falling forever" bug.
    // ----------------------------
    const px = controls.object.position.x;
    const pz = controls.object.position.z;
    const groundY = getGroundY(px, pz);

    if (groundY != null) {
      velocity.y -= GRAVITY * dt;
    } else {
      // No ground info -> do NOT integrate gravity.
      // Keep vertical velocity calm so you don't drift into infinity.
      velocity.y = 0;
    }

    // Integrate motion
    controls.object.position.addScaledVector(velocity, dt);

    // ----------------------------
    // Object collisions (GLB etc.)
    // We resolve in XZ and let the player slide along surfaces.
    // ----------------------------
    resolveCollisions(controls.object.position, prevPos, null, {
      radius: PLAYER_RADIUS,
      height: PLAYER_HEIGHT,
      eyeOffset: EYE_HEIGHT, // because controls.object.position is the EYE position
      maxIters: 4,
      skin: 0.01,
    });

    // ----------------------------
    // Terrain clamp (camera always above snow)
    // After resolving object collisions, clamp to the terrain.
    // ----------------------------
    const groundY2 = getGroundY(
      controls.object.position.x,
      controls.object.position.z
    );

    if (groundY2 != null) {
      const minEyeY = groundY2 + EYE_HEIGHT;
      if (controls.object.position.y < minEyeY) {
        controls.object.position.y = minEyeY;
        velocity.y = 0;
      }
    }

    // ----------------------------
    // Shadow follow update
    // Use the player's "ground-ish" position as the shadow center.
    // controls.object.position is the EYE, so subtract EYE_HEIGHT.
    // ----------------------------
    playerGroundPos.set(
      controls.object.position.x,
      (groundY2 ?? controls.object.position.y - EYE_HEIGHT),
      controls.object.position.z
    );
    shadowFollower.update(playerGroundPos);
  }

  renderer.render(scene, camera);
}
tick();

// ------------------------------------------------------------
// Resize
// ------------------------------------------------------------
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}
window.addEventListener("resize", onResize);
