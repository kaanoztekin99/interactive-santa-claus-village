// Loads the EXR skybox and assigns it as both background and environment map.
import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

export function loadHDRI(path, scene, pmremGenerator) {
  const loader = new EXRLoader();
  loader.setDataType(THREE.FloatType);

  loader.load(
    path,
    (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const envMap = pmremGenerator.fromEquirectangular(texture).texture;

      scene.background = envMap;
      scene.environment = envMap;

      texture.dispose();
      pmremGenerator.dispose();
      console.log("HDRI loaded:", path);
    },
    undefined,
    (error) => console.error("Error loading EXR HDRI:", error)
  );
}
