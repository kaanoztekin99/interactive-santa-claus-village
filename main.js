// main.js
//
// FPS movement (PointerLockControls) + terrain height clamp + GLB collisions.
//
// Key change for collisions:
// - colliders.js reads PLAYER defaults from src/config/constants.js
// - so main.js should NOT override radius/height when calling resolveCollisions()
//   (we only pass eyeOffset because our player position is the camera/eye position)
//
// Fixes in this version:
// 1) Jump works while moving/running (stable grounded detection via snap-to-ground).
// 2) No "queued jump" from mid-air (SPACE only triggers if grounded now).
// 3) HDRI / assets paths resolved robustly via import.meta.url.
//
// NEW (animals):
// - deer/moose loaded separately so animations (idle) are always played
// - auto-scale to target height, and place on ground using bbox bottom
// - ONE cheap collider box per animal, without wiping other colliders

import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { createAbiskoTerrain } from "./src/environment/abiskoTerrain.js";
import { addLights } from "./src/environment/lights.js";
import { createSunShadowFollower } from "./src/environment/shadows.js";
import { loadHDRI, transitionHDRI, preloadAll, preloadHDRI } from "./src/environment/hdri.js";
import { placeModelsOnTerrain, updateShadowLODAll, registerShadowLODGroup } from "./src/environment/modelPlacer.js";
import { createCampfireController } from "./src/environment/campfire.js";
import { createSledgeController } from "./src/environment/sledge.js";

import { createFootstepController } from "./src/player/footsteps.js";
import { createMusicController } from "./src/audio/music.js";
import { createFenceForBounds } from "./src/environment/fence.js";
import Snow from "./src/environment/snow.js";

import {
  clearColliders,
  registerCollidersFromObject,
  registerColliderBox,
  resolveCollisions,
  getColliderBoxesCount,
} from "./src/collision/colliders.js";

import { MODEL_PATH, PLAYER } from "./src/config/constants.js";

const canvas = document.querySelector("#webgl-canvas");

// ------------------------------------------------------------
// Robust asset URL helper
// ------------------------------------------------------------
function assetUrl(p) {
  return new URL(p.replace(/^\//, "./"), import.meta.url).href;
}

// ------------------------------------------------------------
// Renderer / Scene / Camera
// ------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(window.innerWidth, window.innerHeight);

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb9ff);
scene.fog = new THREE.FogExp2(new THREE.Color(0x8fb9ff), 0.00011);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, 120, 180);

// ------------------------------------------------------------
// Player tuning
// ------------------------------------------------------------
const EYE_HEIGHT = PLAYER?.EYE_HEIGHT ?? 1.7;
let camDir = new THREE.Vector3();

const WALK_SPEED = 18.0;
const RUN_SPEED = 30.0;
const GRAVITY = 30.0;
const JUMP_VELOCITY = 9.0;

const GROUND_SNAP_DIST = 0.08;
const GROUND_EPS = 0.03;

const MAX_STEP = 0.8;
const EDGE_BUFFER = 0.0;

// ------------------------------------------------------------
// Controls (FPS)
// ------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.object);

try {
  window.scene = scene;
  window.controls = controls;
  window.camera = camera;
} catch (e) {}

document.addEventListener("click", () => {
  if (!controls.isLocked) controls.lock();
  try {
    if (musicController) musicController.start();
  } catch (e) {}
});

// Footsteps controller
let footstepController = null;
try {
  footstepController = createFootstepController({
    camera,
    audioUrl: assetUrl("./assets/sounds/steps-in-snow.wav"),
    volume: 1.0,
  });
} catch (e) {
  console.warn("createFootstepController failed:", e);
}

// Background music controller
let musicController = null;
try {
  musicController = createMusicController({
    audioUrl: assetUrl("./assets/sounds/arctic_sound.flac"),
    volume: 0.12,
  });
} catch (e) {
  console.warn("createMusicController failed:", e);
}

// ------------------------------------------------------------
// Lighting + shadow follower
// ------------------------------------------------------------
const { sun } = addLights(scene, {
  hemiIntensity: 0.35,
  sunIntensity: 1.2,
  shadowMapSize: 1024,
});

const shadowFollower = createSunShadowFollower(sun, scene, {
  radius: 220,
  sunOffset: new THREE.Vector3(-300, 600, 200),
  near: 1,
  far: 2500,
  snap: 5,
});

let campfireController = null;

// ------------------------------------------------------------
// GLTF animation mixers (animals)
// ------------------------------------------------------------
const mixers = [];
const anchoredActors = []; // { obj, baseOffsetY, extraLift }


// ------------------------------------------------------------
// HDRI
// ------------------------------------------------------------
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();

function _setLoading(pct, txt) {
  try {
    const el = document.getElementById("loading-fill");
    const t = document.getElementById("loading-text");
    if (el) el.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (t && typeof txt !== "undefined") t.innerText = txt;
    else if (t) t.innerText = Math.round(pct) + "%";

    try {
      const needle = document.getElementById("loading-needle");
      const bar = el?.parentElement;
      if (needle && bar) {
        const barRect = bar.getBoundingClientRect();
        const pctClamped = Math.max(0, Math.min(100, pct)) / 100;
        const travel = Math.max(0, barRect.width - needle.offsetWidth);
        const x = Math.round(travel * pctClamped);
        needle.style.transform = `translateX(${x}px) rotate(${pctClamped * 180}deg)`;
      }
    } catch (e) {}
  } catch (e) {}
}

function _hideLoading() {
  try {
    const o = document.getElementById("loading-overlay");
    if (o) o.style.display = "none";
  } catch (e) {}
}

_setLoading(5, "Initializing...");

preloadHDRI("./assets/skybox/hdr/sunlight_4k.exr", pmrem)
  .then(() => {
    loadHDRI("./assets/skybox/hdr/sunlight_4k.exr", scene, pmrem);
    _setLoading(15, "Loading sky...");
  })
  .catch(() => {
    loadHDRI("./assets/skybox/hdr/sunlight_4k.exr", scene, pmrem);
    _setLoading(10, "Loading sky...");
  });

const hdriEntries = [
  { id: "sun", path: "./assets/skybox/hdr/sunlight_4k.exr", preset: { targetExposure: 1.0, targetSunIntensity: 1.2 } },
  { id: "sunset", path: "./assets/skybox/hdr/sunset_10k.exr", preset: { targetExposure: 0.7, targetSunIntensity: 0.45 } },
  { id: "aurora2", path: "./assets/skybox/hdr/aurora_v2.exr", preset: { targetExposure: 0.5, targetSunIntensity: 0.25 } },
  { id: "dark", path: "./assets/skybox/hdr/dark_8k.exr", preset: { targetExposure: 0.25, targetSunIntensity: 0.08 } },
  { id: "aurora3", path: "./assets/skybox/hdr/aurora_v3.exr", preset: { targetExposure: 0.6, targetSunIntensity: 0.35 } },
];

let currentHdriIndex = 0;
let isHdriTransitioning = false;

function setHdriIndex(idx) {
  currentHdriIndex = ((idx % hdriEntries.length) + hdriEntries.length) % hdriEntries.length;
  const entry = hdriEntries[currentHdriIndex];
  const opts = entry.preset ?? {};
  transitionHDRI(entry.path, scene, pmrem, renderer, {
    sun: sun,
    duration: opts.duration ?? 2000,
    targetExposure: opts.targetExposure ?? 1.0,
    targetSunIntensity: opts.targetSunIntensity ?? 1.0,
  });
}

function requestSetHdriIndex(idx) {
  if (isHdriTransitioning) return false;
  const entry = hdriEntries[((idx % hdriEntries.length) + hdriEntries.length) % hdriEntries.length];
  const duration = entry?.preset?.duration ?? 2000;
  isHdriTransitioning = true;
  setHdriIndex(idx);
  setTimeout(() => {
    isHdriTransitioning = false;
  }, duration + 120);
  return true;
}

preloadAll(hdriEntries, pmrem).then(() => {
  console.log("All HDRIs preloaded into PMREM cache.");
});

// clock HUD
const _createClockHud = () => {
  const el = document.createElement("div");
  el.id = "game-clock";
  el.style.position = "fixed";
  el.style.top = "10px";
  el.style.right = "14px";
  el.style.padding = "6px 10px";
  el.style.background = "rgba(0,0,0,0.5)";
  el.style.color = "#fff";
  el.style.fontFamily = "monospace";
  el.style.fontSize = "14px";
  el.style.borderRadius = "6px";
  el.style.zIndex = "9999";
  el.style.pointerEvents = "none";
  document.body.appendChild(el);
  return el;
};

const clockHud = _createClockHud();

function _formatTime(sec) {
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor((sec / 3600) % 24);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function _desiredHdriForHour(hour) {
  if (hour >= 10 && hour < 17) return 0;
  if (hour >= 17 && hour < 20) return 1;
  if (hour >= 6 && hour < 10) return 4;
  return 3;
}

let gameTimeSeconds = new Date().getHours() * 3600 + new Date().getMinutes() * 60;
let timeScale = 900;

// ------------------------------------------------------------
// Snow
// ------------------------------------------------------------
let snow = new Snow(scene, {
  count: 2500,
  size: 1.6,
  speed: 18,
  texturePath: assetUrl("./assets/textures/snowflake-svgrepo-com.svg"),
  wind: new THREE.Vector3(3, 0, 1),
});

// ------------------------------------------------------------
// Terrain
// ------------------------------------------------------------
let terrain = null;
let terrainReady = false;
let terrainXZ = null;
let outerTerrain = null;

// Outer terrain knobs
const OUTER_SIZE_MULTIPLIER = 4.0;
const OUTER_SEGMENTS = 160;
const OUTER_NOISE_AMPLITUDE_M = 1.2;
const OUTER_NOISE_FREQ = 0.0016;
const OUTER_NOISE_RAMP_M = 380;
const OUTER_Y_OFFSET = -0.05;

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

  terrainXZ = { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z };
  return terrainXZ;
}

function clampPlayerToTerrainBounds() {
  if (!terrainXZ) return;

  const playerRadius = PLAYER?.RADIUS ?? 0.45;
  const margin = EDGE_BUFFER + playerRadius + 0.05;

  controls.object.position.x = THREE.MathUtils.clamp(controls.object.position.x, terrainXZ.minX + margin, terrainXZ.maxX - margin);
  controls.object.position.z = THREE.MathUtils.clamp(controls.object.position.z, terrainXZ.minZ + margin, terrainXZ.maxZ - margin);
}

function lowFreqNoise2D(x, z) {
  const a = Math.sin(x * OUTER_NOISE_FREQ + z * OUTER_NOISE_FREQ * 0.73);
  const b = Math.sin(x * OUTER_NOISE_FREQ * 0.51 - z * OUTER_NOISE_FREQ * 0.92 + 1.7);
  const c = Math.sin((x + z) * OUTER_NOISE_FREQ * 0.35 - 0.8);
  return a * 0.5 + b * 0.35 + c * 0.15;
}

function outsideRamp01(x, z, bounds) {
  const dx = Math.max(0, bounds.minX - x, x - bounds.maxX);
  const dz = Math.max(0, bounds.minZ - z, z - bounds.maxZ);
  const d = Math.max(dx, dz);
  return THREE.MathUtils.clamp(d / OUTER_NOISE_RAMP_M, 0, 1);
}

function createOuterTerrain(innerTerrain, bounds, { sizeMultiplier = OUTER_SIZE_MULTIPLIER, segments = OUTER_SEGMENTS, yOffset = OUTER_Y_OFFSET } = {}) {
  const getWrapped = innerTerrain?.userData?.getHeightAtWrapped;
  if (typeof getWrapped !== "function") {
    console.warn("Outer terrain requested, but getHeightAtWrapped() is missing.");
    return null;
  }
  if (!bounds) return null;

  const innerSize = innerTerrain.userData?.terrainSizeM ?? 1000;
  const outerSize = innerSize * sizeMultiplier;

  const cx = innerTerrain.position.x;
  const cz = innerTerrain.position.z;

  const outerHalf = outerSize * 0.5;
  const outerMinX = cx - outerHalf;
  const outerMaxX = cx + outerHalf;
  const outerMinZ = cz - outerHalf;
  const outerMaxZ = cz + outerHalf;

  const metersPerSegment = outerSize / segments;

  const outerMat = innerTerrain.material.clone();
  outerMat.polygonOffset = true;
  outerMat.polygonOffsetFactor = 1;
  outerMat.polygonOffsetUnits = 1;

  function buildStrip(x0, x1, z0, z1) {
    const width = Math.max(1, x1 - x0);
    const depth = Math.max(1, z1 - z0);

    const segX = Math.max(1, Math.round(width / metersPerSegment));
    const segZ = Math.max(1, Math.round(depth / metersPerSegment));

    const geom = new THREE.PlaneGeometry(width, depth, segX, segZ);
    geom.rotateX(-Math.PI / 2);

    const mesh = new THREE.Mesh(geom, outerMat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = -1;

    mesh.position.set((x0 + x1) * 0.5, 0, (z0 + z1) * 0.5);

    const pos = geom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = mesh.position.x + pos.getX(i);
      const wz = mesh.position.z + pos.getZ(i);

      let y = getWrapped(wx, wz);
      const ramp = outsideRamp01(wx, wz, bounds);
      if (ramp > 0) y += ramp * OUTER_NOISE_AMPLITUDE_M * lowFreqNoise2D(wx, wz);

      pos.setY(i, y + yOffset);
    }

    pos.needsUpdate = true;
    geom.computeVertexNormals();
    return mesh;
  }

  const g = new THREE.Group();
  g.name = "OuterTerrainRing";
  g.add(buildStrip(outerMinX, outerMaxX, bounds.maxZ, outerMaxZ)); // North
  g.add(buildStrip(outerMinX, outerMaxX, outerMinZ, bounds.minZ)); // South
  g.add(buildStrip(bounds.maxX, outerMaxX, bounds.minZ, bounds.maxZ)); // East
  g.add(buildStrip(outerMinX, bounds.minX, bounds.minZ, bounds.maxZ)); // West

  return g;
}

// ------------------------------------------------------------
// Helpers for animals: visible bbox + auto scale + ground placement
// ------------------------------------------------------------
function computeVisibleBox(root) {
  const box = new THREE.Box3();
  let has = false;

  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.visible === false) return;
    if (!o.geometry) return;

    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    if (!b) return;

    const wb = b.clone().applyMatrix4(o.matrixWorld);
    if (!has) { box.copy(wb); has = true; }
    else box.union(wb);
  });

  return has ? box : null;
}

function autoScaleToHeight(root, targetHeightM) {
  root.updateMatrixWorld(true);
  const box = computeVisibleBox(root) ?? new THREE.Box3().setFromObject(root);
  if (!box || box.isEmpty()) return 1.0;

  const size = new THREE.Vector3();
  box.getSize(size);
  const h = size.y;

  if (!Number.isFinite(h) || h < 1e-6) return 1.0;

  const s = targetHeightM / h;
  root.scale.multiplyScalar(s);
  root.updateMatrixWorld(true);
  return s;
}

function placeOnGroundByBBox(root, x, z, extraLift = 0.08) {
  root.position.set(x, 0, z);
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  if (!box || box.isEmpty()) { 
    const baseOffsetY = 0;
    const gy = getGroundY(x, z);
    if (gy != null) root.position.y = gy + extraLift + baseOffsetY;
    root.updateMatrixWorld(true);
    return baseOffsetY;
  }

  const baseOffsetY = -box.min.y;

  const gy = getGroundY(x, z);
  if (gy == null) {
    console.warn("placeOnGroundByBBox: groundY null at", x, z);
    root.position.y = baseOffsetY;
    root.updateMatrixWorld(true);
    return baseOffsetY;
  }

  root.position.y = gy + extraLift + baseOffsetY;
  root.updateMatrixWorld(true);
  return baseOffsetY;
}


async function loadAnimatedActor({
  path,
  name,
  x,
  z,
  targetHeightM,
  yawDeg = 0,
  extraLift = 0.10,
  castDistance = 25,
  receiveDistance = 70,
  colliderExpand = 0.03,
}) {
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => loader.load(path, resolve, undefined, reject));

  const actor = gltf.scene;
  actor.name = name || actor.name || "actor";

  // Shadows
  actor.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = false;
    obj.receiveShadow = true;
  });
  registerShadowLODGroup(actor, { castDistance, receiveDistance });

  // Rotate
  actor.rotation.y = THREE.MathUtils.degToRad(yawDeg);

  // Scale to desired height (this fixes “too small”)
  if (Number.isFinite(targetHeightM) && targetHeightM > 0) {
    autoScaleToHeight(actor, targetHeightM);
  }

  // Place on ground using bbox bottom (this fixes “inside snow”)
 const baseOffsetY = placeOnGroundByBBox(actor, x, z, extraLift);

  // register for continue anchoring each frame
  anchoredActors.push({ obj: actor, baseOffsetY, extraLift });


  scene.add(actor);

  // Collider: ONE AABB per actor
  try {
    const box = computeVisibleBox(actor) ?? new THREE.Box3().setFromObject(actor);
    if (box && !box.isEmpty()) {
      const gy = getGroundY(x, z);
      if (gy != null) box.min.y = Math.max(box.min.y, gy + 0.02);
      registerColliderBox(box, { expand: colliderExpand, minSize: 0.35 });
    }
  } catch (e) {
    console.warn("actor collider failed:", name, e);
  }

  // Play idle animation
  if (gltf.animations && gltf.animations.length > 0) {
    const mixer = new THREE.AnimationMixer(actor);
    mixers.push(mixer);

    const idle = gltf.animations.find((c) => /idle/i.test(c.name)) || gltf.animations[0];
    const action = mixer.clipAction(idle);
    action.reset().play();
  } else {
    console.warn("No animations found in", path);
  }

  return actor;
}

// ------------------------------------------------------------
// Build inner terrain (async), then add outer terrain + models + animals
// ------------------------------------------------------------
(async () => {
  try {
    _setLoading(30, "Loading terrain...");
    terrain = await createAbiskoTerrain({
      heightUrl: assetUrl("/assets/terrain/height_1km_2m_16bit.png"),
      slopeUrl: assetUrl("/assets/terrain/slope_deg.png"),
      hillshadeUrl: assetUrl("/assets/terrain/hillshade.png"),
    });

    terrain.position.set(0, 0, 0);
    scene.add(terrain);

    terrainReady = true;
    computeTerrainBoundsXZ();

    // Fence
    try {
      if (terrainXZ) {
        const fence = createFenceForBounds(terrainXZ, {
          postSpacing: 4.0,
          postHeight: 1.2,
          heightSampler: terrain.userData?.getHeightAt,
        });
        if (fence) scene.add(fence);
      }
    } catch (e) {
      console.warn("create fence failed:", e);
    }

    // Outer terrain ring
    outerTerrain = createOuterTerrain(terrain, terrainXZ, {
      sizeMultiplier: OUTER_SIZE_MULTIPLIER,
      segments: OUTER_SEGMENTS,
      yOffset: OUTER_Y_OFFSET,
    });
    if (outerTerrain) scene.add(outerTerrain);

    // Snow area: inner only
    if (snow) {
      const box = new THREE.Box3().setFromObject(terrain);
      if (!box.isEmpty()) {
        const margin = 10;
        const area = {
          x: Math.max(100, box.max.x - box.min.x + margin),
          y: Math.max(120, box.max.y - box.min.y + 80),
          z: Math.max(100, box.max.z - box.min.z + margin),
        };
        const center = new THREE.Vector3((box.min.x + box.max.x) * 0.5, 0, (box.min.z + box.max.z) * 0.5);
        snow.setArea(area, center, box.min.y);
      }
    }

    // IMPORTANT: clear colliders ONCE here
    clearColliders();

    _setLoading(60, "Placing models...");
    // Static props
    try {
      await placeModelsOnTerrain(
        scene,
        terrain,
        [
          {
            path: "./assets/models/winter_tree.glb",
            count: 10,
            minSpacing: 3.0,
            scaleRange: [0.8, 1.2],
            targetHeight: 20,
            maxSlopeDeg: 30,
            alignToNormal: false,
            yOffset: -0.12,
          },
          {
            path: "./assets/models/no_leaf_tree.glb",
            count: 10,
            minSpacing: 4.0,
            scaleRange: [0.7, 1.3],
            targetHeight: 20,
            maxSlopeDeg: 35,
            alignToNormal: false,
            yOffset: -0.12,
          },
          {
            path: "./assets/models/snowy_fallen_tree.glb",
            count: 0,
            minSpacing: 6.0,
            scaleRange: [0.8, 1.1],
            targetHeight: 100,
            alignToNormal: false,
          },
          {
            path: "./assets/models/sledge.glb",
            count: 10,
            minSpacing: 20.0,
            scaleRange: [0.1, 0.2],
            targetHeight: 10,
            alignToNormal: false,
            yOffset: -0.3,
          },
          {
            path: "./assets/models/poly.glb",
            count: 1,
            minSpacing: 20.0,
            scaleRange: [0.1, 0.2],
            targetHeight: 100,
            alignToNormal: false,
          },
          {
            path: "./assets/models/santas_workshop_lapland_finland.glb",
            count: 1,
            minSpacing: 25.0,
            scaleRange: [0.1, 0.2],
            targetHeight: 250,
            alignToNormal: false,
            yOffset: -0.02,
            positions: [{ x: 120, z: -480, yawDeg: 35 }],
          },
          {
            path: "./assets/models/wooden_sledge.glb",
            count: 20,
            minSpacing: 20.0,
            scaleRange: [0.1, 0.2],
            targetHeight: 50,
            alignToNormal: false,
            yOffset: -3.6,
          },
          {
            path: "./assets/models/campfire.glb",
            name: "campfire",
            count: 3,
            minSpacing: 6.0,
            scaleRange: [0.5, 0.9],
            targetHeight: 1.0,
            alignToNormal: false,
            positions: [{ x: 8, z: -6, yawDeg: 0, scale: 1 }],
            yOffset: -3.5,
          },
        ],
        { seed: "LAPLAND-v1", overlapMode: "bbox" }
      );
    } catch (e) {
      console.warn("placeModelsOnTerrain failed:", e);
    }

    // Animals: load separately for animations + correct placement/scale
    try {
      _setLoading(75, "Loading animals...");

      // deer: ~1.6m tall
      await loadAnimatedActor({
        path: "./assets/models/animated_deer_mr.glb",
        name: "deer",
        x: 14,
        z: -6,
        targetHeightM: 1.6,
        yawDeg: 145,
        extraLift: 0.12,
      });

      // moose: ~2.2m tall
      await loadAnimatedActor({
        path: "./assets/models/animated_moose_mr.glb",
        name: "moose",
        x: -16,
        z: -10,
        targetHeightM: 2.2,
        yawDeg: 35,
        extraLift: 0.14,
      });
    } catch (e) {
      console.warn("Animated actor load failed:", e);
    }

    // Campfire controller
    try {
      campfireController = createCampfireController({ scene, controls, range: 6.0 });
    } catch (e) {
      console.warn("createCampfireController failed:", e);
    }

    // Sledge controller
    try {
      window.sledgeController = createSledgeController({
        scene,
        controls,
        range: 6.0,
        slideDuration: 6.0,
        slideSpeed: 28.0,
        heightOffset: 3.0,
        groundSampler: getGroundY,
        minAboveGround: EYE_HEIGHT + 0.2,
        maxBaseOffset: 3.0,
      });
    } catch (e) {
      console.warn("createSledgeController failed:", e);
    }

    // Spawn player
    const y0 = getGroundY(0, 0);
    const safeY = (y0 ?? 0) + EYE_HEIGHT + 5.0;
    controls.object.position.set(0, safeY, 0);

    // Loading overlay
    try {
      _setLoading(95, "Finalizing...");
      setTimeout(() => {
        _setLoading(100, "Ready");
        setTimeout(_hideLoading, 220);
      }, 220);
    } catch (e) {}

    console.log("Collider boxes:", getColliderBoxesCount());
  } catch (e) {
    console.error("Failed to create Abisko terrain:", e);
  }
})();

// ------------------------------------------------------------
// Village GLB loader + colliders (DO NOT clearColliders here!)
// ------------------------------------------------------------
const gltfLoader = new GLTFLoader();

gltfLoader.load(
  assetUrl(MODEL_PATH),
  (gltf) => {
    const model = gltf.scene;
    model.name = "VillageModel";

    model.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = true;
    });

    registerShadowLODGroup(model, { castDistance: 25, receiveDistance: 99999 });

    model.position.set(20, 0, -15);
    model.scale.set(1, 1, 1);
    scene.add(model);

    const placeOnSnow = () => {
      const groundY = getGroundY(model.position.x, model.position.z);
      if (groundY == null) return false;

      const box = computeVisibleBox(model) ?? new THREE.Box3().setFromObject(model);
      if (!box || box.isEmpty()) return false;

      const lift = groundY + GROUND_EPS - box.min.y;
      model.position.y += lift;
      model.updateMatrixWorld(true);
      return true;
    };

    const buildColliders = () => {
      registerCollidersFromObject(model, { expand: 0.02, minSize: 0.35 });
      console.log("Collider boxes:", getColliderBoxesCount());
    };

    const finalize = () => {
      if (!placeOnSnow()) return false;
      buildColliders();
      return true;
    };

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
// Input
// ------------------------------------------------------------
const keys = new Set();
let jumpPressed = false;

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") e.preventDefault();
  if (e.code === "Space" && !e.repeat) jumpPressed = true;
  keys.add(e.code);
});

window.addEventListener("keyup", (e) => {
  keys.delete(e.code);
});

// ------------------------------------------------------------
// Movement + physics
// ------------------------------------------------------------
const clock = new THREE.Clock();

const velocity = new THREE.Vector3();
const dir = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const move = new THREE.Vector3();

const prevPos = new THREE.Vector3();
const prevStep = new THREE.Vector3();
const playerGroundPos = new THREE.Vector3();

let _shadowFrame = 0;

function tick() {
  requestAnimationFrame(tick);

  const dt = Math.min(clock.getDelta(), 0.033);

  if (controls.isLocked) {
    prevPos.copy(controls.object.position);

    dir.set(0, 0, 0);
    if (keys.has("KeyW")) dir.z += 1;
    if (keys.has("KeyS")) dir.z -= 1;
    if (keys.has("KeyA")) dir.x -= 1;
    if (keys.has("KeyD")) dir.x += 1;

    const hasMoveInput = dir.lengthSq() > 1e-8;
    if (hasMoveInput) dir.normalize();

    controls.object.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() > 1e-8) forward.normalize();

    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    move.set(0, 0, 0).addScaledVector(forward, dir.z).addScaledVector(right, dir.x);
    if (move.lengthSq() > 1e-8) move.normalize();

    const isRunning = hasMoveInput && (keys.has("ShiftLeft") || keys.has("ShiftRight"));
    const speed = isRunning ? RUN_SPEED : WALK_SPEED;

    velocity.x = move.x * speed;
    velocity.z = move.z * speed;

    const px = controls.object.position.x;
    const pz = controls.object.position.z;
    const groundY = getGroundY(px, pz);

    let grounded = false;

    if (groundY != null) {
      const minEyeY = groundY + EYE_HEIGHT;
      const distToGround = controls.object.position.y - minEyeY;

      if (distToGround <= GROUND_SNAP_DIST && velocity.y <= 0) {
        controls.object.position.y = minEyeY;
        velocity.y = 0;
        grounded = true;
      } else {
        grounded = distToGround <= 0.12;
      }
    }

    if (jumpPressed && grounded) {
      velocity.y = JUMP_VELOCITY;
      grounded = false;
    }
    jumpPressed = false;

    if (groundY != null && !grounded) velocity.y -= GRAVITY * dt;
    else if (groundY == null) velocity.y = 0;

    const horizSpeed = Math.hypot(velocity.x, velocity.z);
    const steps = Math.max(1, Math.ceil((horizSpeed * dt) / MAX_STEP));
    const subDt = dt / steps;

    for (let s = 0; s < steps; s++) {
      prevStep.copy(controls.object.position);

      controls.object.position.addScaledVector(velocity, subDt);

      const yBeforeCollision = controls.object.position.y;
      resolveCollisions(controls.object.position, prevStep, null, {
        eyeOffset: EYE_HEIGHT,
        maxIters: 3,
        skin: 0.03,
      });
      controls.object.position.y = yBeforeCollision;

      clampPlayerToTerrainBounds();

      const gy = getGroundY(controls.object.position.x, controls.object.position.z);
      if (gy != null) {
        const stepMinEyeY = gy + EYE_HEIGHT;
        const dist = controls.object.position.y - stepMinEyeY;

        if (dist < 0) {
          controls.object.position.y = stepMinEyeY;
          velocity.y = 0;
        } else if (dist <= GROUND_SNAP_DIST && velocity.y <= 0) {
          controls.object.position.y = stepMinEyeY;
          velocity.y = 0;
        }
      } else {
        controls.object.position.copy(prevStep);
        velocity.y = 0;
      }
    }

    const gy2 = getGroundY(controls.object.position.x, controls.object.position.z);
    playerGroundPos.set(controls.object.position.x, gy2 ?? controls.object.position.y - EYE_HEIGHT, controls.object.position.z);
    controls.object.getWorldDirection(camDir);
    shadowFollower.update(playerGroundPos, camDir);

    try {
      if (footstepController) {
        const horizSpeedNow = Math.hypot(velocity.x, velocity.z);
        const isMoving = horizSpeedNow > 0.6 && grounded;
        footstepController.setMoving(isMoving);
      }
    } catch (e) {}
  }

  if (snow) snow.update(dt);

  // update animal animations
  if (mixers.length) {
    for (let i = 0; i < mixers.length; i++) mixers[i].update(dt);
  }

  if (anchoredActors.length) {
    for (let i = 0; i < anchoredActors.length; i++) {
      const a = anchoredActors[i];
      const o = a.obj;
      if (!o) continue;

      const x = o.position.x;
      const z = o.position.z;
      const gy = getGroundY(x, z);
      if (gy == null) continue;

      o.position.y = gy + (a.extraLift ?? 0) + (a.baseOffsetY ?? 0);
      o.updateMatrixWorld(true);
    }
  }


  // update time + HUD + HDRI time mapping
  try {
    gameTimeSeconds += dt * timeScale;
    gameTimeSeconds = gameTimeSeconds % (24 * 3600);
    const hour = Math.floor((gameTimeSeconds / 3600) % 24);
    const desired = _desiredHdriForHour(hour);
    if (desired !== currentHdriIndex) requestSetHdriIndex(desired);
    if (clockHud) clockHud.innerText = _formatTime(gameTimeSeconds);
  } catch (e) {}

  if (window.sledgeController) window.sledgeController.update(dt);
  try {
    if (campfireController) campfireController.update(dt);
  } catch (e) {}

  if ((++_shadowFrame % 10) === 0) updateShadowLODAll(controls.object.position);

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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
}
window.addEventListener("resize", onResize);
