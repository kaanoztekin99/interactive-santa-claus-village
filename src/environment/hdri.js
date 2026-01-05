// src/environment/hdri.js
// Loads the EXR skybox and assigns:
// - original EXR texture as background (the actual "photo")
// - PMREM as environment (lighting)

import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

// path -> { bg: THREE.Texture, env: THREE.Texture }
const _cache = new Map();

export function preloadHDRI(path, pmremGenerator) {
  if (_cache.has(path)) return Promise.resolve(_cache.get(path));

  return new Promise((resolve, reject) => {
    const loader = new EXRLoader();
    loader.setDataType(THREE.HalfFloatType);

    loader.load(
      path,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;

        const envMap = pmremGenerator.fromEquirectangular(texture).texture;

        // IMPORTANT: keep the original texture for background (do NOT dispose it)
        const pair = { bg: texture, env: envMap };
        _cache.set(path, pair);

        console.log("Preloaded HDRI:", path);
        resolve(pair);
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
  return Promise.all(paths.map((p) => preloadHDRI(p, pmremGenerator).catch(() => null)));
}

export function loadHDRI(path, scene, pmremGenerator) {
  if (_cache.has(path)) {
    const { bg, env } = _cache.get(path);
    scene.background = bg;      // <-- photo
    scene.environment = env;    // <-- lighting
    console.log("HDRI used from cache:", path);
    return;
  }

  const loader = new EXRLoader();
  loader.setDataType(THREE.HalfFloatType);

  loader.load(
    path,
    (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;

      const envMap = pmremGenerator.fromEquirectangular(texture).texture;

      scene.background = texture;   // <-- photo
      scene.environment = envMap;   // <-- lighting

      _cache.set(path, { bg: texture, env: envMap });

      console.log("HDRI loaded:", path);
    },
    undefined,
    (error) => console.error("Error loading EXR HDRI:", error)
  );
}

export function transitionHDRI(path, scene, pmremGenerator, renderer, opts = {}) {
  const {
    sun = null,
    duration = 2000,
    targetExposure = 1.0,
    targetSunIntensity = 1.0,
  } = opts;

  const loader = new EXRLoader();
  loader.setDataType(THREE.HalfFloatType);

  const startExposure = renderer.toneMappingExposure ?? 1.0;
  const startSun = sun ? sun.intensity : null;

  const half = Math.max(50, duration / 2);
  const t0 = performance.now();

  function fadeOut(now) {
    const p = Math.min(1, (now - t0) / half);

    // keep a floor so it doesn't go pure black too aggressively
    renderer.toneMappingExposure = THREE.MathUtils.lerp(startExposure, Math.max(0.15, targetExposure * 0.4), p);

    if (sun && startSun != null) {
      sun.intensity = THREE.MathUtils.lerp(startSun, Math.max(0.05, targetSunIntensity * 0.2), p);
    }

    if (p < 1) requestAnimationFrame(fadeOut);
    else loadAndFadeIn();
  }

  function applyPair(pair, cachedLabel) {
    if (scene.environment !== pair.env)  scene.environment = pair.env;   // <-- lighting
    if (scene.background !== pair.bg)  scene.background = pair.bg;     // <-- photo

    console.log("HDRI transition swap:", cachedLabel, path);

    const t1 = performance.now();
    function fadeIn(now) {
      const p = Math.min(1, (now - t1) / half);

      renderer.toneMappingExposure = THREE.MathUtils.lerp(renderer.toneMappingExposure, targetExposure, p);
      if (sun && startSun != null) {
        sun.intensity = THREE.MathUtils.lerp(sun.intensity, targetSunIntensity, p);
      }

      if (p < 1) requestAnimationFrame(() => requestAnimationFrame(fadeIn));
      else {
        renderer.toneMappingExposure = targetExposure;
        if (sun && startSun != null) sun.intensity = targetSunIntensity;
        console.log("HDRI transition complete:", path);
      }
    }
    requestAnimationFrame(() => requestAnimationFrame(fadeIn));

  }

  function loadAndFadeIn() {
    if (_cache.has(path)) {
      applyPair(_cache.get(path), "cached");
      return;
    }

    loader.load(
      path,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;

        const envMap = pmremGenerator.fromEquirectangular(texture).texture;
        const pair = { bg: texture, env: envMap };

        _cache.set(path, pair);
        applyPair(pair, "loaded");
      },
      undefined,
      (err) => console.error("Error loading EXR HDRI:", err)
    );
  }

  requestAnimationFrame(fadeOut);
}
