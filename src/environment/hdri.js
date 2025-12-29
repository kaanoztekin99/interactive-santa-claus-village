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
      // Do not dispose pmremGenerator here; caller owns it.
      console.log("HDRI loaded:", path);
    },
    undefined,
    (error) => console.error("Error loading EXR HDRI:", error)
  );
}

// Smooth transition helper:
// - path: EXR file path
// - scene: THREE.Scene
// - pmremGenerator: THREE.PMREMGenerator
// - renderer: THREE.WebGLRenderer (used to lerp toneMappingExposure)
// - opts: { sun, duration, targetExposure, targetSunIntensity }
export function transitionHDRI(path, scene, pmremGenerator, renderer, opts = {}) {
  const { sun = null, duration = 2000, targetExposure = 1.0, targetSunIntensity = 1.0 } = opts;

  const loader = new EXRLoader();
  loader.setDataType(THREE.FloatType);

  const startExposure = renderer.toneMappingExposure ?? 1.0;
  const startSun = sun ? sun.intensity : null;

  const half = Math.max(50, duration / 2);

  // Fade exposure and sun down over first half
  const t0 = performance.now();
  function fadeOut(now) {
    const dt = now - t0;
    const p = Math.min(1, dt / half);
    renderer.toneMappingExposure = THREE.MathUtils.lerp(startExposure, Math.min(0.05, targetExposure * 0.25), p);
    if (sun && startSun != null) sun.intensity = THREE.MathUtils.lerp(startSun, Math.max(0.05, targetSunIntensity * 0.15), p);
    if (p < 1) requestAnimationFrame(fadeOut);
    else loadAndFadeIn();
  }

  function loadAndFadeIn() {
    loader.load(
      path,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const envMap = pmremGenerator.fromEquirectangular(texture).texture;

        // swap immediately (we keep exposure low so swap is subtle)
        scene.background = envMap;
        scene.environment = envMap;

        texture.dispose();

        // Fade back up
        const t1 = performance.now();
        function fadeIn(now) {
          const dt = now - t1;
          const p = Math.min(1, dt / half);
          renderer.toneMappingExposure = THREE.MathUtils.lerp(renderer.toneMappingExposure, targetExposure, p);
          if (sun && startSun != null) sun.intensity = THREE.MathUtils.lerp(sun.intensity, targetSunIntensity, p);
          if (p < 1) requestAnimationFrame(fadeIn);
          else {
            // ensure final values
            renderer.toneMappingExposure = targetExposure;
            if (sun && startSun != null) sun.intensity = targetSunIntensity;
            console.log("HDRI transition complete:", path);
          }
        }

        requestAnimationFrame(fadeIn);
      },
      undefined,
      (err) => console.error("Error loading EXR HDRI:", err)
    );
  }

  requestAnimationFrame(fadeOut);
}