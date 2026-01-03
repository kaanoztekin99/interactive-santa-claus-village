// Loads the EXR skybox and assigns it as both background and environment map.
import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

// Simple in-memory cache for PMREM-generated envMaps
const _cache = new Map(); // path -> THREE.Texture (PMREM envMap)

export function preloadHDRI(path, pmremGenerator) {
  if (_cache.has(path)) return Promise.resolve(_cache.get(path));
  return new Promise((resolve, reject) => {
    const loader = new EXRLoader();
    loader.setDataType(THREE.FloatType);
    loader.load(
      path,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const envMap = pmremGenerator.fromEquirectangular(texture).texture;
        _cache.set(path, envMap);
        texture.dispose();
        console.log("Preloaded HDRI:", path);
        resolve(envMap);
      },
      undefined,
      (err) => {
        console.error("Error preloading EXR HDRI:", path, err);
        reject(err);
      }
    );
  });
}

export function preloadAll(entries, pmremGenerator) {
  const paths = entries.map((e) => (typeof e === "string" ? e : e.path));
  const promises = paths.map((p) => preloadHDRI(p, pmremGenerator).catch((_) => null));
  return Promise.all(promises);
}

export function loadHDRI(path, scene, pmremGenerator) {
  // Use cache if available
  if (_cache.has(path)) {
    scene.background = _cache.get(path);
    scene.environment = _cache.get(path);
    console.log("HDRI used from cache:", path);
    return;
  }

  const loader = new EXRLoader();
  loader.setDataType(THREE.FloatType);

  loader.load(
    path,
    (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const envMap = pmremGenerator.fromEquirectangular(texture).texture;

      scene.background = envMap;
      scene.environment = envMap;

      _cache.set(path, envMap);

      texture.dispose();
      console.log("HDRI loaded:", path);
    },
    undefined,
    (error) => console.error("Error loading EXR HDRI:", error)
  );
}

export function transitionHDRI(path, scene, pmremGenerator, renderer, opts = {}) {
  const { sun = null, duration = 2000, targetExposure = 1.0, targetSunIntensity = 1.0 } = opts;

  const loader = new EXRLoader();
  loader.setDataType(THREE.FloatType);

  const startExposure = renderer.toneMappingExposure ?? 1.0;
  const startSun = sun ? sun.intensity : null;

  const half = Math.max(50, duration / 2);

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
    // if cached, swap immediately
    if (_cache.has(path)) {
      scene.background = _cache.get(path);
      scene.environment = _cache.get(path);
      console.log("HDRI transition used cached envMap:", path);

      const t1 = performance.now();
      function fadeIn(now) {
        const dt = now - t1;
        const p = Math.min(1, dt / half);
        renderer.toneMappingExposure = THREE.MathUtils.lerp(renderer.toneMappingExposure, targetExposure, p);
        if (sun && startSun != null) sun.intensity = THREE.MathUtils.lerp(sun.intensity, targetSunIntensity, p);
        if (p < 1) requestAnimationFrame(fadeIn);
        else {
          renderer.toneMappingExposure = targetExposure;
          if (sun && startSun != null) sun.intensity = targetSunIntensity;
          console.log("HDRI transition complete (cached):", path);
        }
      }
      requestAnimationFrame(fadeIn);
      return;
    }

    loader.load(
      path,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const envMap = pmremGenerator.fromEquirectangular(texture).texture;

        scene.background = envMap;
        scene.environment = envMap;
        _cache.set(path, envMap);

        texture.dispose();

        const t1 = performance.now();
        function fadeIn(now) {
          const dt = now - t1;
          const p = Math.min(1, dt / half);
          renderer.toneMappingExposure = THREE.MathUtils.lerp(renderer.toneMappingExposure, targetExposure, p);
          if (sun && startSun != null) sun.intensity = THREE.MathUtils.lerp(sun.intensity, targetSunIntensity, p);
          if (p < 1) requestAnimationFrame(fadeIn);
          else {
            renderer.toneMappingExposure = targetExposure;
            if (sun && startSun != null) sun.intensity = targetSunIntensity;
            console.log("HDRI transition complete (loaded):", path);
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