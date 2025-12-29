// main.js
//
// FPS movement (PointerLockControls) + terrain height clamp + GLB collisions.
//
// In this version we do three important visual things:
//  1) Keep HDRI as the “real” background (photo stays visible).
//  2) Add a very light fog for depth cueing (subtle, not washing everything out).
//  3) Add a "visual-only" outer terrain around the playable tile:
//
//     Why outer terrain helps:
//     - The hard border happens because your terrain mesh ends, but the HDRI is infinite.
//     - By extending terrain visually beyond the playable boundary, you avoid ever seeing
//       "terrain ends -> background begins" as a hard cut.
//
//     Why it must be "visual-only":
//     - The real DEM covers 1 km x 1 km, and gameplay logic depends on that dataset.
//     - The outer terrain is just a continuity trick, not real terrain data.
//     - So player is still clamped to the real tile bounds.

import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { createAbiskoTerrain } from "./src/environment/abiskoTerrain.js";
import { addLights } from "./src/environment/lights.js";
import { createSunShadowFollower } from "./src/environment/shadows.js";
import { loadHDRI } from "./src/environment/hdri.js";
import Snow from "./src/environment/snow.js";
import { placeModelsOnTerrain } from "./src/environment/modelPlacer.js";

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

// Tone mapping and color space for nicer HDRI lighting.
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// Shadows
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb9ff);

/**
 * Very light fog:
 * - Adds depth cueing and slightly softens the far distance.
 * - Does NOT replace HDRI background (background is a separate thing).
 *
 * If you feel fog is too strong, reduce density a bit (e.g. 0.00009).
 * If it's too weak, increase slightly (e.g. 0.00013).
 */
scene.fog = new THREE.FogExp2(new THREE.Color(0x8fb9ff), 0.00011);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  8000
);

camera.position.set(0, 120, 180);

// ------------------------------------------------------------
// Snow particle system
// ------------------------------------------------------------

let snow = new Snow(scene, {
  count: 2500,
  size: 1.6,
  speed: 18,
  texturePath: "./assets/textures/snowflake-svgrepo-com.svg",
  wind: new THREE.Vector3(3, 0, 1),
});

// ------------------------------------------------------------
// Player tuning
// ------------------------------------------------------------
//
// controls.object.position is the EYE position (camera).

const EYE_HEIGHT = 1.7;
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.45;

const WALK_SPEED = 100.0;
const RUN_SPEED = 16.0;

const GRAVITY = 30.0;
const JUMP_VELOCITY = 9.0;

// Tiny lift to avoid "sinking" visual artifacts
const GROUND_EPS = 0.03;

// Anti-tunneling: split movement into micro-steps in XZ
const MAX_STEP = 0.10;

// How far from the tile border the player must stop.
// This ensures the player never reaches the ugly contrast zone.
const EDGE_BUFFER = 0.0;

// ------------------------------------------------------------
// Controls (FPS)
// ------------------------------------------------------------

const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.object);

document.addEventListener("click", () => {
  if (!controls.isLocked) controls.lock();
});

// ------------------------------------------------------------
// Lighting + shadow follower
// ------------------------------------------------------------

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
// HDRI
// ------------------------------------------------------------

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
loadHDRI("./assets/skybox/hdr/sunlight_4k.exr", scene, pmrem);

// ------------------------------------------------------------
// Terrain: inner (playable) + outer (visual only)
// ------------------------------------------------------------

let terrain = null;
let terrainReady = false;

// World-space playable bounds (XZ only)
let terrainXZ = null;

// Visual-only extension mesh
let outerTerrain = null;

// ------------------------------------------------------------
// Outer terrain knobs (these are the "art direction" controls)
// ------------------------------------------------------------

/**
 * Outer size multiplier:
 * - inner tile: 1 km x 1 km
 * - outer: multiplier * inner (e.g. 4 => 4 km x 4 km)
 *
 * Performance note:
 * - Bigger size means farther visible terrain, but you still want to keep
 *   segment count moderate so it doesn't get too heavy.
 */
const OUTER_SIZE_MULTIPLIER = 4.0;

/**
 * Outer terrain resolution:
 * - This is purely visual, so keep it relatively low.
 * - If you increase it too much, you'll pay with vertex count.
 */
const OUTER_SEGMENTS = 160;

/**
 * Noise tuning:
 * The outer terrain uses a "wrapped" sampler, which is continuous
 * but tends to create mirror-like repeated patterns.
 *
 * To make it look less obviously repeated, we add a low-frequency noise
 * OUTSIDE the real tile only.
 */
const OUTER_NOISE_AMPLITUDE_M = 1.2; // meters; keep small to avoid weird hills
const OUTER_NOISE_FREQ = 0.0016;     // low frequency (big features)
const OUTER_NOISE_RAMP_M = 380;      // how quickly noise ramps up outside border

/**
 * Outer terrain vertical offset:
 * We keep it slightly below the inner mesh to avoid z-fighting artifacts.
 */
const OUTER_Y_OFFSET = -0.05;

// ------------------------------------------------------------
// Terrain helpers
// ------------------------------------------------------------

function getGroundY(x, z) {
  const fn = terrain?.userData?.getHeightAt;
  if (!terrainReady || typeof fn !== "function") return null;

  const y = fn(x, z);
  return Number.isFinite(y) ? y : null;
}

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

function clampPlayerToTerrainBounds() {
  if (!terrainXZ) return;

  // We include player radius so you don't visually "touch" the border.
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

// ------------------------------------------------------------
// Outer terrain generation
// ------------------------------------------------------------

/**
 * Cheap deterministic noise in [-1..1-ish].
 * Not Perlin/Simplex, but good enough to break obvious repetition.
 *
 * The important part:
 * - Stable (same x,z always produces the same value)
 * - Very cheap (just a few sin waves)
 */
function lowFreqNoise2D(x, z) {
  const a = Math.sin(x * OUTER_NOISE_FREQ + z * OUTER_NOISE_FREQ * 0.73);
  const b = Math.sin(x * OUTER_NOISE_FREQ * 0.51 - z * OUTER_NOISE_FREQ * 0.92 + 1.7);
  const c = Math.sin((x + z) * OUTER_NOISE_FREQ * 0.35 - 0.8);
  return (a * 0.5 + b * 0.35 + c * 0.15);
}

/**
 * Returns 0 inside the real tile, and ramps to 1 as you go outside.
 * This is crucial: we do NOT want noise to change the playable terrain.
 *
 * Using "box distance" (max(dx,dz)) fits naturally for a square tile.
 */
function outsideRamp01(x, z, bounds) {
  const dx = Math.max(0, bounds.minX - x, x - bounds.maxX);
  const dz = Math.max(0, bounds.minZ - z, z - bounds.maxZ);
  const d = Math.max(dx, dz);
  return THREE.MathUtils.clamp(d / OUTER_NOISE_RAMP_M, 0, 1);
}

/**
 * Builds a big plane around the inner tile.
 * Heights come from the wrapped sampler:
 *   terrain.userData.getHeightAtWrapped(x,z)
 *
 * Then we add noise OUTSIDE the tile only to break mirror patterns.
 *
 * Important:
 * - This mesh uses the SAME material as the inner terrain so shading is consistent.
 * - It's "visual only": no colliders, no height queries, no gameplay logic.
 */
function createOuterTerrain(innerTerrain, bounds, {
  sizeMultiplier = OUTER_SIZE_MULTIPLIER,
  segments = OUTER_SEGMENTS,
  yOffset = OUTER_Y_OFFSET,
} = {}) {
  const getWrapped = innerTerrain?.userData?.getHeightAtWrapped;
  if (typeof getWrapped !== "function") {
    console.warn("Outer terrain requested, but getHeightAtWrapped() is missing.");
    return null;
  }
  if (!bounds) return null;

  // --- outer extents (world space) ---
  const innerSize = innerTerrain.userData?.terrainSizeM ?? 1000;
  const outerSize = innerSize * sizeMultiplier;

  const cx = innerTerrain.position.x;
  const cz = innerTerrain.position.z;

  const outerHalf = outerSize * 0.5;
  const outerMinX = cx - outerHalf;
  const outerMaxX = cx + outerHalf;
  const outerMinZ = cz - outerHalf;
  const outerMaxZ = cz + outerHalf;

  // We want the same triangle density everywhere.
  // "segments" means: outer plane would have that many segments across its full size.
  const metersPerSegment = outerSize / segments;

  // Clone material so polygonOffset does NOT affect the playable tile.
  const outerMat = innerTerrain.material.clone();
  outerMat.polygonOffset = true;
  outerMat.polygonOffsetFactor = 1;
  outerMat.polygonOffsetUnits = 1;

  // Helper: build one strip (axis-aligned rectangle), then displace Y
  function buildStrip(x0, x1, z0, z1) {
    const width = Math.max(1, x1 - x0);
    const depth = Math.max(1, z1 - z0);

    const segX = Math.max(1, Math.round(width / metersPerSegment));
    const segZ = Math.max(1, Math.round(depth / metersPerSegment));

    const geom = new THREE.PlaneGeometry(width, depth, segX, segZ);
    geom.rotateX(-Math.PI / 2);

    // Center strip in world space
    const mesh = new THREE.Mesh(geom, outerMat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = -1;

    mesh.position.set((x0 + x1) * 0.5, 0, (z0 + z1) * 0.5);

    const pos = geom.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      // position is local to strip mesh, convert to world
      const wx = mesh.position.x + pos.getX(i);
      const wz = mesh.position.z + pos.getZ(i);

      let y = getWrapped(wx, wz);

      // Keep your "outside ramp" + noise logic:
      const ramp = outsideRamp01(wx, wz, bounds);
      if (ramp > 0) {
        y += ramp * OUTER_NOISE_AMPLITUDE_M * lowFreqNoise2D(wx, wz);
      }

      pos.setY(i, y + yOffset);
    }

    pos.needsUpdate = true;
    geom.computeVertexNormals();

    return mesh;
  }

  // Build a ring: only outside the playable bounds (NO overlap under inner tile)
  const g = new THREE.Group();
  g.name = "OuterTerrainRing";

  // North strip: above maxZ
  g.add(buildStrip(outerMinX, outerMaxX, bounds.maxZ, outerMaxZ));
  // South strip: below minZ
  g.add(buildStrip(outerMinX, outerMaxX, outerMinZ, bounds.minZ));
  // East strip: right of maxX (only across the inner Z range to avoid corner overlap)
  g.add(buildStrip(bounds.maxX, outerMaxX, bounds.minZ, bounds.maxZ));
  // West strip: left of minX
  g.add(buildStrip(outerMinX, bounds.minX, bounds.minZ, bounds.maxZ));

  return g;
}

// ------------------------------------------------------------
// Build inner terrain (async), then add outer terrain
// ------------------------------------------------------------

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

    // Build and add outer terrain once we know the inner bounds.
    outerTerrain = createOuterTerrain(terrain, terrainXZ, {
      sizeMultiplier: OUTER_SIZE_MULTIPLIER,
      segments: OUTER_SEGMENTS,
      yOffset: OUTER_Y_OFFSET,
    });

    if (outerTerrain) {
      scene.add(outerTerrain);
    }

    // Expand snow only over the INNER terrain.
    // The outer terrain is just a visual trick; particles everywhere can look odd.
    if (snow) {
      const box = new THREE.Box3().setFromObject(terrain);
      if (!box.isEmpty()) {
        const margin = 10;
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

        snow.setArea(area, center, box.min.y);
      }
    }

    // Place models
    try {
      await placeModelsOnTerrain(scene, terrain, [
        { path: "./assets/models/winter_tree.glb", count: 10, minSpacing: 3.0, scaleRange: [0.8, 1.2], targetHeight: 80, maxSlopeDeg: 30 },
        { path: "./assets/models/no_leaf_tree.glb", count: 10, minSpacing: 4.0, scaleRange: [0.7, 1.3], targetHeight: 80, maxSlopeDeg: 35 },
        { path: "./assets/models/snowy_fallen_tree.glb", count: 0, minSpacing: 6.0, scaleRange: [0.8, 1.1], targetHeight:100, alignToNormal: false },
        { path: "./assets/models/low_poly_winter_tree_pack.glb", count: 1, minSpacing: 2.5, scaleRange: [0.5, 1.0], targetHeight: 80,maxSlopeDeg: 40 },
        { path: "./assets/models/sledge.glb", count: 1, minSpacing: 20.0, scaleRange: [0.1, 0.2], targetHeight:10,alignToNormal: false },
        { path: "./assets/models/poly.glb", count: 1, minSpacing: 20.0, scaleRange: [0.1, 0.2], targetHeight:100,alignToNormal: false },
        { path: "./assets/models/santas_workshop_lapland_finland.glb", count: 1, minSpacing: 20.0, scaleRange: [0.1, 0.2], targetHeight:1000,alignToNormal: false },
        { path: "./assets/models/wooden_sledge.glb", count: 1, minSpacing: 20.0, scaleRange: [0.1, 0.2], targetHeight:70,alignToNormal: false },
        { path: "./assets/models/trees_winter_and_summer.glb", count: 1, minSpacing: 20.0, scaleRange: [0.1, 0.2], targetHeight:10,alignToNormal: false }
      ]);
    } catch (e) {
      console.warn("placeModelsOnTerrain failed:", e);
    }

    // Spawn player safely above terrain at (0,0)
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

const gltfLoader = new GLTFLoader();

gltfLoader.load(
  "./assets/models/winter_camping.glb",
  (gltf) => {
    const model = gltf.scene;
    model.name = "VillageModel";

    // Enable shadows on all meshes
    model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    model.position.set(20, 0, -15);
    model.scale.set(1, 1, 1);

    scene.add(model);

    // Place the model vertically so it rests on the terrain.
    const placeOnSnow = () => {
      const groundY = getGroundY(model.position.x, model.position.z);
      if (groundY == null) return false;

      const box = new THREE.Box3().setFromObject(model);
      const lift = groundY + GROUND_EPS - box.min.y;
      model.position.y += lift;

      model.updateMatrixWorld(true);
      return true;
    };

    const buildColliders = () => {
      // NOTE:
      // Colliders are only built for the village model.
      // We DO NOT create colliders for terrain (player uses height sampling + clamp).
      clearColliders();

      registerCollidersFromObject(model, {
        expand: 0.02,
        minSize: 0.05,
      });

      console.log("Collider boxes:", getColliderBoxesCount());
    };

    const finalize = () => {
      if (!placeOnSnow()) return false;
      buildColliders();
      return true;
    };

    // If the GLB loads before the terrain is ready, retry until terrain exists.
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

const keys = new Set();
let jumpQueued = false;

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") e.preventDefault();

  // Queue jump only on initial press (prevents auto-repeat jump spam)
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

const velocity = new THREE.Vector3();
const dir = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const move = new THREE.Vector3();

const clock = new THREE.Clock();

// Reused vectors to reduce allocations
const prevPos = new THREE.Vector3();
const prevStep = new THREE.Vector3();
const playerGroundPos = new THREE.Vector3();

function tick() {
  requestAnimationFrame(tick);

  // Cap dt so slow frames don't cause huge movement jumps
  const dt = Math.min(clock.getDelta(), 0.033);

  if (controls.isLocked) {
    prevPos.copy(controls.object.position);

    // --- input direction (local) ---
    dir.set(0, 0, 0);
    if (keys.has("KeyW")) dir.z += 1;
    if (keys.has("KeyS")) dir.z -= 1;
    if (keys.has("KeyA")) dir.x -= 1;
    if (keys.has("KeyD")) dir.x += 1;

    const hasMoveInput = dir.lengthSq() > 1e-8;
    if (hasMoveInput) dir.normalize();

    // --- camera forward flattened to XZ ---
    controls.object.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() > 1e-8) forward.normalize();

    // --- camera right ---
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    // --- convert local input to world direction ---
    move
      .set(0, 0, 0)
      .addScaledVector(forward, dir.z)
      .addScaledVector(right, dir.x);

    if (move.lengthSq() > 1e-8) move.normalize();

    // --- run / walk ---
    const isRunning = hasMoveInput && (keys.has("ShiftLeft") || keys.has("ShiftRight"));
    const speed = isRunning ? RUN_SPEED : WALK_SPEED;

    velocity.x = move.x * speed;
    velocity.z = move.z * speed;

    // --- ground check for jump + gravity ---
    const px = controls.object.position.x;
    const pz = controls.object.position.z;
    const groundY = getGroundY(px, pz);

    let grounded = false;
    if (groundY != null) {
      const minEyeY = groundY + EYE_HEIGHT;
      grounded = controls.object.position.y <= minEyeY + 0.01;
    }

    // --- jump ---
    if (jumpQueued && grounded) {
      velocity.y = JUMP_VELOCITY;
      jumpQueued = false;
      grounded = false;
    } else {
      if (grounded) jumpQueued = false;
    }

    // --- gravity ---
    if (groundY != null) {
      velocity.y -= GRAVITY * dt;
    } else {
      // Outside strict tile: stop vertical integration to avoid "falling forever"
      velocity.y = 0;
    }

    // --- anti-tunneling: micro steps ---
    const horizSpeed = Math.hypot(velocity.x, velocity.z);
    const steps = Math.max(1, Math.ceil((horizSpeed * dt) / MAX_STEP));
    const subDt = dt / steps;

    for (let s = 0; s < steps; s++) {
      prevStep.copy(controls.object.position);

      // Integrate motion for this micro-step
      controls.object.position.addScaledVector(velocity, subDt);

      // Resolve collisions with GLB colliders
      resolveCollisions(controls.object.position, prevStep, null, {
        radius: PLAYER_RADIUS,
        height: PLAYER_HEIGHT,
        eyeOffset: EYE_HEIGHT,
        maxIters: 4,
        skin: 0.01,
      });

      // Keep player inside playable bounds (inner tile only)
      clampPlayerToTerrainBounds();

      // Clamp to terrain height
      const gy = getGroundY(controls.object.position.x, controls.object.position.z);

      if (gy != null) {
        const minEyeY = gy + EYE_HEIGHT;
        if (controls.object.position.y < minEyeY) {
          controls.object.position.y = minEyeY;
          velocity.y = 0;
        }
      } else {
        // If we ever end up outside terrain, revert to safe previous position
        controls.object.position.copy(prevStep);
        velocity.y = 0;
      }
    }

    // Update shadow follower around player's ground-ish position
    const gy2 = getGroundY(controls.object.position.x, controls.object.position.z);
    playerGroundPos.set(
      controls.object.position.x,
      gy2 ?? (controls.object.position.y - EYE_HEIGHT),
      controls.object.position.z
    );
    shadowFollower.update(playerGroundPos);
  }

  if (snow) snow.update(dt);
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
