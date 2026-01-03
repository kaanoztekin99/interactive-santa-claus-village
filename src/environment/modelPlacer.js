import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { registerCollidersFromObject } from "../collision/colliders.js";

const loader = new GLTFLoader();
const downRay = new THREE.Raycaster();
const downOrigin = new THREE.Vector3();

function loadGLTF(path) {
  return new Promise((resolve, reject) => {
    loader.load(path, (gltf) => resolve(gltf), undefined, reject);
  });
}

function randRange(a, b) {
  return a + Math.random() * (b - a);
}

export async function placeModelsOnTerrain(scene, terrainMesh, entries = []) {
  if (!terrainMesh || !terrainMesh.userData || typeof terrainMesh.userData.getHeightAt !== "function") {
    console.warn("placeModelsOnTerrain: invalid terrainMesh");
    return;
  }

  const terrainSize = terrainMesh.userData.terrainSizeM ?? (260);
  const half = terrainSize * 0.5;

  const allPlaced = [];

  for (const e of entries) {
    const {
      path,
      count = 10,
      minSpacing = 4.0,
      maxAttemptsPerItem = 60,
      targetHeight = null,
      scaleRange = [1, 1],
      yawRange = [0, 360],
      maxSlopeDeg = 35,
      alignToNormal = true,
      yOffset = 0,
      addColliders = true,
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

    // compute approximate vertical size for optional targeting
    proto.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(proto);
    const size = new THREE.Vector3();
    box.getSize(size);

    const placed = [];
    const slopeThreshold = Math.cos((maxSlopeDeg * Math.PI) / 180.0);

    // helper to perform a single placement at given XZ (optional providedY)
    const tryPlaceAt = (x, z, providedY = null) => {
      const y = providedY != null ? providedY : terrainMesh.userData.getHeightAt(x, z);
      if (y == null) return false;

      // raycast down to get normal and precise hit
      downOrigin.set(x, y + 200, z);
      downRay.set(downOrigin, new THREE.Vector3(0, -1, 0));
      const hits = downRay.intersectObject(terrainMesh, false);
      if (!hits.length) return false;
      const hit = hits[0];

      // normal in world space
      const faceNormal = hit.face?.normal ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
      const normalMat = new THREE.Matrix3().getNormalMatrix(terrainMesh.matrixWorld);
      const normalWorld = faceNormal.applyMatrix3(normalMat).normalize();

      // slope check
      if (normalWorld.dot(new THREE.Vector3(0, 1, 0)) < slopeThreshold) return false;

      // spacing check
      for (const p of placed) {
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz < minSpacing * minSpacing) return false;
      }

      // clone and position
      const instance = proto.clone(true);

      // random scale (support optional targetHeight to normalize model height)
      const protoHeight = size.y;
      const randScaleFactor = randRange(scaleRange[0], scaleRange[1]);
      let finalScale = randScaleFactor;
      if (targetHeight != null && protoHeight > 1e-6) {
        const baseScale = targetHeight / protoHeight;
        finalScale = baseScale * randScaleFactor;
      }
      instance.scale.setScalar(finalScale);

      // rotation: align to normal then apply random yaw
      if (alignToNormal) {
        const up = new THREE.Vector3(0, 1, 0);
        const q = new THREE.Quaternion().setFromUnitVectors(up, normalWorld);
        instance.quaternion.copy(q);
      }

      const yawDeg = randRange(yawRange[0], yawRange[1]);
      instance.rotateOnAxis(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yawDeg));

      // Place instance high above, compute world bbox, then lower so bbox.min.y == hit.point.y
      const SAFE_HIGH_Y = hit.point.y + 200;
      instance.position.set(x, SAFE_HIGH_Y, z);
      instance.updateMatrixWorld(true);

      const box2 = new THREE.Box3().setFromObject(instance);
      if (box2.isEmpty()) {
        // fallback: snap instance origin to hit point with offset
        instance.position.set(x, hit.point.y + yOffset + 0.02, z);
      } else {
        const shiftDown = box2.min.y - hit.point.y; // positive if bbox is above hit
        instance.position.y = instance.position.y - shiftDown + yOffset + 0.02;
      }

      instance.updateMatrixWorld(true);
      scene.add(instance);

      if (addColliders) registerCollidersFromObject(instance, { minSize: 0.03 });

      const rec = { path, x, z, y: hit.point.y, instance };
      placed.push(rec);
      allPlaced.push(rec);
      console.log(`Placed ${path} at`, rec.x.toFixed(2), rec.y.toFixed(2), rec.z.toFixed(2));
      return true;
    };

    // If explicit positions provided, place at those deterministically
    if (Array.isArray(e.positions) && e.positions.length > 0) {
      for (let i = 0; i < Math.min(count, e.positions.length); i++) {
        const pos = e.positions[i];
        const px = pos.x ?? pos[0];
        const pz = pos.z ?? pos[1];
        const py = pos.y ?? null;
        if (px == null || pz == null) continue;
        tryPlaceAt(px, pz, py);
      }
    } else {
      let attempts = 0;
      while (placed.length < count && attempts < count * maxAttemptsPerItem) {
        attempts++;

        const x = randRange(-half, half);
        const z = randRange(-half, half);

        tryPlaceAt(x, z);
      }
    }

    console.log(`Placed ${placed.length}/${count} instances of ${path}`);
  }
  
  // return an array of placement records so callers can persist / interact with placed objects
  return allPlaced;
}