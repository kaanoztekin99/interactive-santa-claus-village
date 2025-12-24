// main.js
//
// FPS style movement (PointerLockControls) + terrain height clamp + GLB collisions.
//
// What this version adds/changes (as requested):
// 1) Stop the player ~5 meters BEFORE the terrain boundary (not exactly at the edge).
// 2) Debug grid removed entirely (no leftover code).
// 3) Jump with SPACE (classic videogame jump, only when grounded).
// 4) Run with SHIFT + WASD (faster movement).
// 5) More accurate, human style comments so the file is easy to explain / document.

import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { createAbiskoTerrain } from "./src/environment/abiskoTerrain.js";
import { addLights } from "./src/environment/lights.js";
import { createSunShadowFollower } from "./src/environment/shadows.js";
import { loadHDRI } from "./src/environment/hdri.js";
import Snow from "./src/environment/snow.js";

import {
  clearColliders,
  registerCollidersFromObject,
  resolveCollisions,
  getColliderBoxesCount,
} from "./src/collision/colliders.js";

const canvas = document.querySelector("#webgl-canvas");

// ------------------------------------------------------------
// Renderer / Scene / Camera
// ------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

// Tone mapping + output color space for nicer visuals (especially with HDRI)
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// Enable shadows (DirectionalLight will cast them, meshes must have cast/receiveShadow)
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

// Snow system (instantiated once scene/renderer exist)
let snow = null;

// Instantiate snow with default options; starts immediately
// You can tweak count/size/speed/wind as desired.
snow = new Snow(scene, {
  count: 2500,
  size: 1.6,
  speed: 18,
  texturePath: "./assets/textures/snowflake-svgrepo-com.svg",
  wind: new THREE.Vector3(3, 0, 1),
});

// ------------------------------------------------------------
// Player tuning (feel free to tweak these like "game settings")
// ------------------------------------------------------------
//
// IMPORTANT: controls.object.position is treated as the EYE position (camera position).
// That means "feet Y" = eyeY - EYE_HEIGHT.

const EYE_HEIGHT = 1.7;     // camera height above ground (meters)
const PLAYER_HEIGHT = 1.8;  // collision cylinder height (meters)
const PLAYER_RADIUS = 0.45; // collision cylinder radius (meters)

const WALK_SPEED = 10.0;        // m/s
const RUN_SPEED = 16.0;         // m/s (SHIFT)
const GRAVITY = 30.0;           // m/s^2 (higher = snappier fall)
const JUMP_VELOCITY = 9.0;      // m/s (jump strength)
const GROUND_EPS = 0.03;        // tiny lift to avoid clipping into snow

// Anti-tunneling: limit how far you move per physics step in XZ.
// This greatly reduces "walking through thin walls" at high speed.
const MAX_STEP = 0.10; // 10 cm per sub-step

// Terrain edge buffer: stop ~5 meters before the map boundary.
const EDGE_BUFFER = 5.0; // meters

// Initial camera position (will be reset once terrain is ready)
camera.position.set(0, 120, 180);

// Pointer lock controls (FPS look)
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.object);

// Click anywhere to lock pointer (enter FPS mode)
document.addEventListener("click", () => {
  if (!controls.isLocked) controls.lock();
});

// ------------------------------------------------------------
// Lighting + shadow-follow system
// ------------------------------------------------------------
//
// The "shadow follower" moves the directional light's shadow camera with the player.
// Without it, shadows disappear as you walk away from the origin.

const { sun } = addLights(scene, {
  hemiIntensity: 0.35,
  sunIntensity: 1.2,
  shadowMapSize: 2048,
});

const shadowFollower = createSunShadowFollower(sun, scene, {
  radius: 350,
  sunOffset: new THREE.Vector3(-300, 600, 200),
  near: 1,
  far: 2500,
  snap: 5,
});

// ------------------------------------------------------------
// HDRI (environment lighting / reflections)
// ------------------------------------------------------------

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
loadHDRI("./assets/skybox/hdr/sunlight_4k.exr", scene, pmrem);

// ------------------------------------------------------------
// Terrain
// ------------------------------------------------------------
//
// createAbiskoTerrain() is assumed to attach a height sampler at:
//   terrain.userData.getHeightAt(x, z) -> y
//
// We also compute the terrain bounding box once and use it to clamp movement,
// with an additional EDGE_BUFFER so we stop BEFORE the map ends.

let terrain = null;
let terrainReady = false;

// Terrain bounds in XZ, computed once after terrain is added to the scene.
let terrainXZ = null;

/**
 * Terrain height query helper.
 * Returns null if terrain not ready or the sampler doesn't provide a valid number.
 */
function getGroundY(x, z) {
  const fn = terrain?.userData?.getHeightAt;
  if (!terrainReady || typeof fn !== "function") return null;

  const y = fn(x, z);
  return Number.isFinite(y) ? y : null;
}

/**
 * Compute terrain bounds in world space. We use these to keep the player inside the map.
 */
function computeTerrainBoundsXZ() {
  if (!terrain) return null;

  const box = new THREE.Box3().setFromObject(terrain);
  if (box.isEmpty()) return null;

  terrainXZ = {
    minX: box.min.x,
    maxX: box.max.x,
    minZ: box.min.z,
    maxZ: box.max.z,
  };
  return terrainXZ;
}

/**
 * Clamp player position in XZ so they cannot reach the terrain edge.
 * We stop EDGE_BUFFER meters before the bounds, plus a small margin for player radius.
 */
function clampPlayerToTerrainBounds() {
  if (!terrainXZ) return;

  // We include player radius so the camera doesn't visually "touch" the boundary.
  const margin = EDGE_BUFFER + PLAYER_RADIUS + 0.05;

  controls.object.position.x = THREE.MathUtils.clamp(
    controls.object.position.x,
    terrainXZ.minX + margin,
    terrainXZ.maxX - margin
  );

  controls.object.position.z = THREE.MathUtils.clamp(
    controls.object.position.z,
    terrainXZ.minZ + margin,
    terrainXZ.maxZ - margin
  );
}

// Build terrain asynchronously
(async () => {
  try {
    terrain = await createAbiskoTerrain({
      heightUrl: "/assets/terrain/height_1km_2m_16bit.png",
      slopeUrl: "/assets/terrain/slope_deg.png",
      hillshadeUrl: "/assets/terrain/hillshade.png",
    });

    terrain.position.set(0, 0, 0);
    scene.add(terrain);

    terrainReady = true;
    computeTerrainBoundsXZ();

    // If we have a snow system, expand it to cover the whole terrain.
    if (snow) {
      const box = new THREE.Box3().setFromObject(terrain);
      if (!box.isEmpty()) {
        const margin = 10; // extra padding around terrain
        const area = {
          x: Math.max(100, box.max.x - box.min.x + margin),
          y: Math.max(120, box.max.y - box.min.y + 80),
          z: Math.max(100, box.max.z - box.min.z + margin),
        };

        const center = new THREE.Vector3(
          (box.min.x + box.max.x) * 0.5,
          0,
          (box.min.z + box.max.z) * 0.5
        );

        const groundY = box.min.y;
        snow.setArea(area, center, groundY);
      }
    }
    // Spawn the player safely above the snow at (0,0)
    const y0 = getGroundY(0, 0);
    const safeY = (y0 ?? 0) + EYE_HEIGHT + 5.0;
    controls.object.position.set(0, safeY, 0);
  } catch (e) {
    console.error("Failed to create Abisko terrain:", e);
  }
})();

// ------------------------------------------------------------
// GLB loader + colliders
// ------------------------------------------------------------
//
// Key detail for your collisions:
// We MUST register colliders AFTER the model has its final position (after placeOnSnow).
// The collider system stores static AABBs; if you move the model after registering,
// the colliders remain behind in the old position.

const gltfLoader = new GLTFLoader();

gltfLoader.load(
  "./assets/models/winter_camping.glb",
  (gltf) => {
    const model = gltf.scene;
    model.name = "VillageModel";

    // Enable shadows on all meshes in the GLB
    model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    // Choose where you want the model in XZ
    model.position.set(20, 0, -15);
    model.scale.set(1, 1, 1);

    // Add to scene so Box3 sees it
    scene.add(model);

    /**
     * Move the model vertically so its bounding box bottom rests on the terrain.
     */
    const placeOnSnow = () => {
      const groundY = getGroundY(model.position.x, model.position.z);
      if (groundY == null) return false;

      const box = new THREE.Box3().setFromObject(model);
      const lift = groundY + GROUND_EPS - box.min.y;
      model.position.y += lift;

      model.updateMatrixWorld(true);
      return true;
    };

    /**
     * Build colliders from the model meshes.
     * clearColliders() is OK if this is the only collidable model.
     * If you later add more collidable objects, remove clearColliders() and
     * just register additional colliders.
     */
    const buildColliders = () => {
      clearColliders();

      registerCollidersFromObject(model, {
        expand: 0.02,  // slight inflation so you don't visually clip
        minSize: 0.05, // ignore tiny decorative meshes
      });

      console.log("Collider boxes:", getColliderBoxesCount());
    };

    /**
     * Finalize: place model on snow (needs terrain) and only THEN build colliders.
     */
    const finalize = () => {
      if (!placeOnSnow()) return false;
      buildColliders();
      return true;
    };

    // If terrain wasn't ready when the GLB loaded, retry next frames until it is.
    if (!finalize()) {
      const retry = () => {
        if (!finalize()) requestAnimationFrame(retry);
      };
      retry();
    }
  },
  undefined,
  (err) => console.warn("GLB failed to load:", err)
);

// ------------------------------------------------------------
// Input (WASD + SHIFT run + SPACE jump)
// ------------------------------------------------------------
//
// We keep a Set of currently pressed keys.
// For jumping we use a "queued" boolean so holding SPACE doesn't spam jumps.

const keys = new Set();
let jumpQueued = false;

window.addEventListener("keydown", (e) => {
  // Prevent the browser from scrolling the page on SPACE
  if (e.code === "Space") e.preventDefault();

  // Queue a jump only on the initial press (not every repeat)
  if (e.code === "Space" && !keys.has("Space")) {
    jumpQueued = true;
  }

  keys.add(e.code);
});

window.addEventListener("keyup", (e) => {
  keys.delete(e.code);
});

// ------------------------------------------------------------
// Movement + physics
// ------------------------------------------------------------

const velocity = new THREE.Vector3(); // player velocity (m/s)
const dir = new THREE.Vector3();      // input direction (local)
const forward = new THREE.Vector3();  // camera forward (flattened on XZ)
const right = new THREE.Vector3();    // camera right (flattened on XZ)
const move = new THREE.Vector3();     // world move direction

const clock = new THREE.Clock();

// Reusable vectors to avoid per-frame allocations
const prevPos = new THREE.Vector3();
const prevStep = new THREE.Vector3();
const playerGroundPos = new THREE.Vector3();

function tick() {
  requestAnimationFrame(tick);

  // Cap dt so a slow frame doesn't cause huge "teleport" steps
  const dt = Math.min(clock.getDelta(), 0.033);

  if (controls.isLocked) {
    // Store previous position (useful as a safety fallback)
    prevPos.copy(controls.object.position);

    // ----------------------------
    // Build desired movement direction from keys (WASD)
    // ----------------------------
    dir.set(0, 0, 0);
    if (keys.has("KeyW")) dir.z += 1;
    if (keys.has("KeyS")) dir.z -= 1;
    if (keys.has("KeyA")) dir.x -= 1;
    if (keys.has("KeyD")) dir.x += 1;

    const hasMoveInput = dir.lengthSq() > 1e-8;
    if (hasMoveInput) dir.normalize();

    // Camera forward (flattened to XZ so we don't "fly" when looking up/down)
    controls.object.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() > 1e-8) forward.normalize();

    // Right direction from forward
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    // Convert input direction into world space
    move
      .set(0, 0, 0)
      .addScaledVector(forward, dir.z)
      .addScaledVector(right, dir.x);

    if (move.lengthSq() > 1e-8) move.normalize();

    // ----------------------------
    // Walk vs run speed (SHIFT + WASD)
    // ----------------------------
    const isRunning =
      hasMoveInput && (keys.has("ShiftLeft") || keys.has("ShiftRight"));

    const speed = isRunning ? RUN_SPEED : WALK_SPEED;

    // Horizontal velocity updates every frame (classic FPS feel)
    velocity.x = move.x * speed;
    velocity.z = move.z * speed;

    // ----------------------------
    // Ground check (used for jump + gravity behavior)
    // ----------------------------
    const px = controls.object.position.x;
    const pz = controls.object.position.z;
    const groundY = getGroundY(px, pz);

    // "Grounded" = eye is at or below the minimum allowed eye height (with epsilon)
    let grounded = false;
    if (groundY != null) {
      const minEyeY = groundY + EYE_HEIGHT;
      grounded = controls.object.position.y <= minEyeY + 0.01;
    }

    // ----------------------------
    // Jump (SPACE)
    // - Only allowed when grounded
    // - We consume jumpQueued so holding SPACE won't keep jumping
    // ----------------------------
    if (jumpQueued && grounded) {
      velocity.y = JUMP_VELOCITY;
      jumpQueued = false;
      grounded = false; // immediately treat as airborne for this frame
    } else {
      // If we didn't jump, clear the queue only when grounded.
      // (This keeps the behavior responsive if you press SPACE slightly early.)
      if (grounded) jumpQueued = false;
    }

    // ----------------------------
    // Gravity
    // We apply gravity as long as terrain exists at the current position.
    // (If groundY becomes null, we avoid integrating into infinity.)
    // ----------------------------
    if (groundY != null) {
      velocity.y -= GRAVITY * dt;
    } else {
      velocity.y = 0;
    }

    // ----------------------------
    // Anti-tunneling: sub-steps
    // We split the frame into smaller steps so we don't skip through thin colliders.
    // ----------------------------
    const horizSpeed = Math.hypot(velocity.x, velocity.z);
    const steps = Math.max(1, Math.ceil((horizSpeed * dt) / MAX_STEP));
    const subDt = dt / steps;

    for (let s = 0; s < steps; s++) {
      prevStep.copy(controls.object.position);

      // Integrate motion for this micro-step
      controls.object.position.addScaledVector(velocity, subDt);

      // Resolve collisions against GLB AABB colliders (slide along surfaces)
      resolveCollisions(controls.object.position, prevStep, null, {
        radius: PLAYER_RADIUS,
        height: PLAYER_HEIGHT,
        eyeOffset: EYE_HEIGHT,
        maxIters: 4,
        skin: 0.01,
      });

      // Prevent leaving the map: clamp XZ to terrain bounds with a 5m buffer
      clampPlayerToTerrainBounds();

      // Terrain clamp: keep the camera above the terrain surface
      const gy = getGroundY(
        controls.object.position.x,
        controls.object.position.z
      );

      if (gy != null) {
        const minEyeY = gy + EYE_HEIGHT;

        // If we fell below ground, snap to ground and cancel vertical velocity
        if (controls.object.position.y < minEyeY) {
          controls.object.position.y = minEyeY;
          velocity.y = 0;
        }
      } else {
        // No terrain info -> revert the step (safer than drifting out of world)
        controls.object.position.copy(prevStep);
        velocity.y = 0;
      }
    }

    // ----------------------------
    // Shadow follow update
    // We center the shadow box around the player's ground-ish position.
    // ----------------------------
    const gy2 = getGroundY(controls.object.position.x, controls.object.position.z);
    playerGroundPos.set(
      controls.object.position.x,
      gy2 ?? (controls.object.position.y - EYE_HEIGHT),
      controls.object.position.z
    );
    shadowFollower.update(playerGroundPos);
  }

  if (typeof snow !== 'undefined' && snow) snow.update(dt);
  renderer.render(scene, camera);
}

tick();

// ------------------------------------------------------------
// Resize handler
// ------------------------------------------------------------

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

window.addEventListener("resize", onResize);
