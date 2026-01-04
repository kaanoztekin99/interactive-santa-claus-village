// src/environment/modelPlacer.js
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { registerCollidersFromObject } from "../collision/colliders.js";

const loader = new GLTFLoader();
const downRay = new THREE.Raycaster();
const downOrigin = new THREE.Vector3();

/* ---------------------------
 * Seeded RNG (deterministic)
 * --------------------------*/
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seed) {
  const s = typeof seed === "string" ? seed : String(seed ?? "default-seed");
  const h = xmur3(s)();
  return mulberry32(h);
}

function loadGLTF(path) {
  return new Promise((resolve, reject) => {
    loader.load(path, (gltf) => resolve(gltf), undefined, reject);
  });
}

function randRange(rng, a, b) {
  return a + rng() * (b - a);
}

function computeVisibleBox(root) {
  const box = new THREE.Box3();
  let has = false;

  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.visible === false) return;
    if (!o.geometry) return;

    // Eğer modellerde görünmez helper/base mesh varsa filtreleyebilirsin:
    // if (/collider|collision|helper|bounds|trigger/i.test(o.name)) return;

    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    if (!b) return;

    const wb = b.clone().applyMatrix4(o.matrixWorld);
    if (!has) {
      box.copy(wb);
      has = true;
    } else {
      box.union(wb);
    }
  });

  return has ? box : null;
}

function snapToGroundByVisibleBox(obj, hitY, yOffset = 0) {
  obj.updateMatrixWorld(true);
  const b = computeVisibleBox(obj) ?? new THREE.Box3().setFromObject(obj);

  if (!b || b.isEmpty()) {
    obj.position.y = hitY + yOffset;
    obj.updateMatrixWorld(true);
    return;
  }

  const dy = hitY - b.min.y;
  obj.position.y += dy + yOffset;
  obj.updateMatrixWorld(true);
}

export async function placeModelsOnTerrain(scene, terrainMesh, entries = [], options = {}) {
  if (!terrainMesh?.userData || typeof terrainMesh.userData.getHeightAt !== "function") {
    console.warn("placeModelsOnTerrain: invalid terrainMesh");
    return [];
  }

  const {
    seed = "lapland-default",
    // "bbox" en kesin, "distance" daha hafif
    overlapMode = "bbox",
  } = options;

  const rng = makeRng(seed);

  const terrainSize = terrainMesh.userData.terrainSizeM ?? 260;
  const half = terrainSize * 0.5;

  // fence avoidance: collect positions of fence children (posts/rails)
  const fenceAvoidDistance = options.fenceAvoidDistance ?? 6.0;
  const fencePositions = [];
  try {
    scene.traverse((o) => {
      if (!o.parent) return;
      if (o.parent.name === "Fence" || o.name === "Fence") {
        const wp = new THREE.Vector3();
        o.getWorldPosition(wp);
        fencePositions.push({ x: wp.x, z: wp.z });
      }
    });
  } catch (e) {}

  // GLOBAL
  const allPlaced = []; // { x, z, minR, box, path }

  const isFreeByDistance = (x, z, reqR) => {
    for (const p of allPlaced) {
      const dx = p.x - x;
      const dz = p.z - z;
      const minD = (p.minR ?? 0) + reqR;
      if (dx * dx + dz * dz < minD * minD) return false;
    }
    return true;
  };

  const isFreeByBBox = (testBox) => {
    for (const p of allPlaced) {
      if (p.box && testBox.intersectsBox(p.box)) return false;
    }
    return true;
  };

  for (const e of entries) {
    const {
      path,
      name = null,

      count = 10,
      minSpacing = 4.0,
      maxAttemptsPerItem = 80,

      targetHeight = null,
      scaleRange = [1, 1],

      yawRange = [0, 360],
      maxSlopeDeg = 35,
      alignToNormal = true,

      yOffset = 0,

      // fixed replacements
      // positions: [{x,z,yawDeg,scale,scaleMul,targetHeightOverride, yOffsetOverride}]
      positions = null,

      addColliders = true,
      colliderMinSize = 0.30,
      colliderExpand = 0.00,
    } = e;

    let gltf;
    try {
      gltf = await loadGLTF(path);
    } catch (err) {
      console.warn("Failed to load model for placer:", path, err);
      continue;
    }

    const proto = gltf.scene;
    proto.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    // proto height for targetHeight scaling
    proto.updateMatrixWorld(true);
    const protoBox = computeVisibleBox(proto) ?? new THREE.Box3().setFromObject(proto);
    const protoSize = new THREE.Vector3();
    protoBox.getSize(protoSize);
    const protoHeight = protoSize.y;

    const slopeThreshold = Math.cos((maxSlopeDeg * Math.PI) / 180.0);

    const tryPlaceAt = (x, z, overrides = {}) => {
      // reject if too close to fence
      try {
        for (const p of fencePositions) {
          const dx = p.x - x;
          const dz = p.z - z;
          if (dx * dx + dz * dz < fenceAvoidDistance * fenceAvoidDistance) return false;
        }
      } catch (e) {}

      const y = terrainMesh.userData.getHeightAt(x, z);
      if (y == null) return false;

      // raycast -> hit point & normal
      downOrigin.set(x, y + 600, z);
      downRay.set(downOrigin, new THREE.Vector3(0, -1, 0));
      terrainMesh.updateMatrixWorld(true);

      const hits = downRay.intersectObject(terrainMesh, false);
      if (!hits.length) return false;
      const hit = hits[0];

      const faceNormal = hit.face?.normal ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
      const normalMat = new THREE.Matrix3().getNormalMatrix(terrainMesh.matrixWorld);
      const normalWorld = faceNormal.applyMatrix3(normalMat).normalize();

      // slope gate
      if (normalWorld.dot(new THREE.Vector3(0, 1, 0)) < slopeThreshold) return false;

      // global spacing gate
      const reqR = overrides.minSpacingOverride ?? minSpacing;
      if (!isFreeByDistance(x, z, reqR)) return false;

      // instance
      const instance = proto.clone(true);
      if (name) instance.name = name;

      // scale
      const desiredTargetHeight = overrides.targetHeightOverride ?? targetHeight;
      const manualScale = overrides.scale ?? null; // absolute scalar
      const scaleMul = overrides.scaleMul ?? null; // multiplier

      let finalScale;
      if (manualScale != null) {
        finalScale = manualScale;
      } else {
        const randScaleFactor = randRange(rng, scaleRange[0], scaleRange[1]);
        finalScale = randScaleFactor;

        if (desiredTargetHeight != null && protoHeight > 1e-6) {
          finalScale = (desiredTargetHeight / protoHeight) * randScaleFactor;
        }
        if (scaleMul != null) finalScale *= scaleMul;
      }
      instance.scale.setScalar(finalScale);

      // rotation
      if (alignToNormal) {
        const up = new THREE.Vector3(0, 1, 0);
        instance.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(up, normalWorld));
      }
      const fixedYaw = overrides.yawDeg ?? null;
      const yawDeg = fixedYaw != null ? fixedYaw : randRange(rng, yawRange[0], yawRange[1]);
      instance.rotateOnAxis(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yawDeg));

      // place high then snap by bbox
      instance.position.set(x, hit.point.y + 200, z);
      instance.updateMatrixWorld(true);

      const yOff = overrides.yOffsetOverride ?? yOffset;

      // only yOffset
      snapToGroundByVisibleBox(instance, hit.point.y, yOff);
      if (terrainMesh.userData.getSnowLiftAt) {
        const snowLift = terrainMesh.userData.getSnowLiftAt(x, z);
        instance.position.y += snowLift;
        instance.updateMatrixWorld(true);
      }
      // overlap check
      const b = computeVisibleBox(instance) ?? new THREE.Box3().setFromObject(instance);
      if (!b || b.isEmpty()) return false;

      if (overlapMode === "bbox") {
        if (!isFreeByBBox(b)) return false;
      }

      // accept
      // expose source path and ensure sledges are named so controllers can find them
      try {
        instance.userData = instance.userData || {};
        instance.userData.sourcePath = path;
        if (/sledge|sled/i.test(path)) {
          instance.userData.isSledge = true;
          // also set a helpful name so controllers/hit-tests can match
          instance.name = instance.name || "sledge";
        }
      } catch (e) {}
      scene.add(instance);
      if (addColliders) {
        registerCollidersFromObject(instance, {
          minSize: colliderMinSize,
          expand: colliderExpand,
        });
      }

      allPlaced.push({ x, z, minR: reqR, box: b, path });
      return true;
    };

    // Fixed positions first 
    if (Array.isArray(positions) && positions.length > 0) {
      let placedCount = 0;
      for (let i = 0; i < Math.min(count, positions.length); i++) {
        const p = positions[i];

        const x = p.x ?? p[0];
        const z = p.z ?? p[1];
        if (x == null || z == null) continue;

        const ok = tryPlaceAt(x, z, {
          yawDeg: typeof p.yawDeg === "number" ? p.yawDeg : (typeof p.yaw === "number" ? p.yaw : null),
          scale: typeof p.scale === "number" ? p.scale : null,
          scaleMul: typeof p.scaleMul === "number" ? p.scaleMul : null,
          targetHeightOverride: typeof p.targetHeight === "number" ? p.targetHeight : null,
          yOffsetOverride: typeof p.yOffset === "number" ? p.yOffset : null,
          minSpacingOverride: typeof p.minSpacing === "number" ? p.minSpacing : null,
        });

        if (ok) placedCount++;
      }
      console.log(`Placed ${placedCount}/${count} instances of ${path} (fixed positions)`);
      continue; // skip random placement
    }

    // Random placement (seeded)
    let placedCount = 0;
    let attempts = 0;
    const maxAttempts = count * maxAttemptsPerItem;

    while (placedCount < count && attempts < maxAttempts) {
      attempts++;

      const x = randRange(rng, -half, half);
      const z = randRange(rng, -half, half);

      if (tryPlaceAt(x, z)) placedCount++;
    }

    console.log(`Placed ${placedCount}/${count} instances of ${path} (seed="${seed}")`);
  }

  return allPlaced;
}