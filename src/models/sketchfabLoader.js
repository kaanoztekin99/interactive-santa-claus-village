// Loads a glTF file, normalizes its scale/orientation, drops it on the ground, and registers collisions.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { registerCollidersFromObject } from "../collision/colliders.js";

export function loadSketchfabModel({
  path,
  scene,
  sampleGround,
  fallbackGround = 0,
  x = 0,
  z = 0,
  targetHeight = 6.0,
  yawDeg = 0,
  yOffset = 0,
  addToCollisions = true,
}) {
  const loader = new GLTFLoader();

  loader.load(
    path,
    (gltf) => {
      const root = gltf.scene;

      root.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      root.updateMatrixWorld(true);
      const box0 = new THREE.Box3().setFromObject(root);
      const size0 = new THREE.Vector3();
      box0.getSize(size0);

      if (size0.y > 1e-6) {
        const s = targetHeight / size0.y;
        root.scale.setScalar(s);
      }

      root.rotation.y = THREE.MathUtils.degToRad(yawDeg);

      root.updateMatrixWorld(true);
      const box1 = new THREE.Box3().setFromObject(root);

      const groundY = sampleGround(x, z, fallbackGround);
      root.position.set(x, groundY - box1.min.y + yOffset, z);

      scene.add(root);

      if (addToCollisions) {
        registerCollidersFromObject(root, { minSize: 0.05 });
      }

      console.log("Model loaded:", path);
      console.log("Model size (approx):", size0, "targetHeight:", targetHeight);
    },
    undefined,
    (err) => console.error("Error loading model:", path, err)
  );
}
