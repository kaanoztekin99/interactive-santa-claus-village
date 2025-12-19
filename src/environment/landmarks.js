// Spawns placeholder houses and trees, aligning them with the terrain and registering colliders.
import * as THREE from "three";
import { registerCollidersFromObject } from "../collision/colliders.js";

export function createLandmarks(scene, sampleGround, fallbackGround = 0) {
  const houseMat = new THREE.MeshStandardMaterial({ color: 0xffd2a6, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.9 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 1.0 });
  const leavesMat = new THREE.MeshStandardMaterial({ color: 0x2e6b3a, roughness: 1.0 });

  const placeOnGround = (obj, x, z) => {
    const y = sampleGround(x, z, fallbackGround);
    obj.position.set(x, y, z);
  };

  for (let i = 0; i < 10; i++) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.2, 3.2), houseMat);
    base.castShadow = true;
    base.receiveShadow = true;

    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.7, 1.6, 4), roofMat);
    roof.position.y = 2.2 / 2 + 1.6 / 2;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;

    const house = new THREE.Group();
    house.add(base);
    house.add(roof);

    const x = (Math.random() - 0.5) * 160;
    const z = (Math.random() - 0.5) * 160;
    placeOnGround(house, x, z);

    scene.add(house);
    registerCollidersFromObject(house);
  }

  for (let i = 0; i < 40; i++) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 2.2, 10), trunkMat);
    trunk.castShadow = true;
    trunk.receiveShadow = true;

    const crown = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2.8, 12), leavesMat);
    crown.position.y = 2.2 / 2 + 2.8 / 2 - 0.2;
    crown.castShadow = true;

    const tree = new THREE.Group();
    tree.add(trunk);
    tree.add(crown);

    const x = (Math.random() - 0.5) * 220;
    const z = (Math.random() - 0.5) * 220;
    placeOnGround(tree, x, z);

    scene.add(tree);
    registerCollidersFromObject(tree);
  }
}
