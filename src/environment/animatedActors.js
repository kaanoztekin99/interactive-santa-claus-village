// src/environment/animatedActors.js
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

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
    if (!has) {
      box.copy(wb);
      has = true;
    } else {
      box.union(wb);
    }
  });

  return has ? box : null;
}

export function createAnimatedActorSystem({
  scene,
  getGroundY,                 // (x,z) -> y|null
  registerShadowLODGroup,      // from modelPlacer.js
  registerColliderBox,         // from colliders.js
  groundEps = 0.03,
} = {}) {
  const loader = new GLTFLoader();
  const mixers = [];

  async function addActor({
    path,
    name,
    x,
    z,
    scale = 1.0,
    yawDeg = 0,
    yOffset = 0,
    castDistance = 25,
    receiveDistance = 70,
    colliderExpand = 0.03,
    colliderMinSize = 0.35,
  }) {
    const gltf = await new Promise((resolve, reject) => {
      loader.load(path, resolve, undefined, reject);
    });

    const actor = gltf.scene;
    actor.name = name || actor.name || "actor";

    // materials/shadows
    actor.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = true;
    });
    if (registerShadowLODGroup) {
      registerShadowLODGroup(actor, { castDistance, receiveDistance });
    }

    actor.scale.setScalar(scale);
    actor.rotation.y = THREE.MathUtils.degToRad(yawDeg);

    const gy = getGroundY ? getGroundY(x, z) : null;
    actor.position.set(x, (gy ?? 0) + yOffset + groundEps, z);

    scene.add(actor);
    actor.updateMatrixWorld(true);

    // ONE cheap collider per actor, clamped to ground
    if (registerColliderBox) {
      const box = computeVisibleBox(actor) ?? new THREE.Box3().setFromObject(actor);
      if (box && !box.isEmpty()) {
        const groundY = (gy ?? actor.position.y) + yOffset;
        box.min.y = Math.max(box.min.y, groundY + 0.02);
        registerColliderBox(box, { expand: colliderExpand, minSize: colliderMinSize });
      }
    }

    // idle animation
    if (gltf.animations && gltf.animations.length) {
      const mixer = new THREE.AnimationMixer(actor);
      mixers.push(mixer);

      const idle = gltf.animations.find((c) => /idle/i.test(c.name)) || gltf.animations[0];
      mixer.clipAction(idle).reset().play();
    }

    return actor;
  }

  function update(dt) {
    for (let i = 0; i < mixers.length; i++) mixers[i].update(dt);
  }

  return { addActor, update };
}
