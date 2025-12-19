// Collects bounding boxes from scene objects and resolves player collisions against them.
import * as THREE from "three";
import { PLAYER } from "../config/constants.js";

const colliderBoxes = [];

export function registerCollidersFromObject(root, opts = {}) {
  const {
    expand = PLAYER.RADIUS,
    includeInvisible = false,
    ignoreNoColliderTag = true,
    minSize = 0.02,
  } = opts;

  root.updateMatrixWorld(true);

  const tmpBox = new THREE.Box3();
  const tmpSize = new THREE.Vector3();

  root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (!includeInvisible && obj.visible === false) return;

    if (ignoreNoColliderTag) {
      if (obj.userData && obj.userData.noCollider) return;
      if ((obj.name || "").toLowerCase().includes("nocollide")) return;
      if ((obj.parent?.name || "").toLowerCase().includes("nocollide")) return;
    }

    const mat = obj.material;
    if (mat && mat.transparent && mat.opacity !== undefined && mat.opacity < 0.2) return;

    tmpBox.setFromObject(obj);
    if (tmpBox.isEmpty()) return;

    tmpBox.getSize(tmpSize);
    if (tmpSize.length() < minSize) return;

    tmpBox.expandByScalar(expand);
    colliderBoxes.push(tmpBox.clone());
  });
}

export function resolveCollisions(playerPosition, prevPlayerPos, onCollision) {
  for (let i = 0; i < colliderBoxes.length; i++) {
    if (colliderBoxes[i].containsPoint(playerPosition)) {
      playerPosition.copy(prevPlayerPos);
      if (onCollision) onCollision();
      break;
    }
  }
}

export function getColliderBoxesCount() {
  return colliderBoxes.length;
}
