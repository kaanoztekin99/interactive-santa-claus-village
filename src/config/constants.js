// src/config/constants.js
//
// Central place for paths and gameplay constants.
// Keep this file boring and predictable: no logic, just values.

// ------------------------------------------------------------
// Asset paths (relative to your web server root)
// ------------------------------------------------------------

// HDRI used by src/environment/hdri.js
export const HDRI_PATH = "/assets/skybox/hdr/horn-koppe_snow_4k.exr";

// Main GLB model used in main.js
export const MODEL_PATH = "/assets/models/winter_camping.glb";

// Terrain assets used by createAbiskoTerrain in src/environment/abiskoTerrain.js
export const TERRAIN_ASSETS = {
  HEIGHT: "/assets/terrain/height_1km_2m_16bit.png",
  SLOPE: "/assets/terrain/slope_deg.png",
  HILLSHADE: "/assets/terrain/hillshade.png",
};

// ------------------------------------------------------------
// Player collider / controller defaults
// NOTE: colliders.js reads these values (branch kaan).
// ------------------------------------------------------------
export const PLAYER = {
  // Camera height above ground when standing.
  EYE_HEIGHT: 1.7,

  // Full capsule height (used by colliders.js if it builds capsule defaults).
  // Even if you mostly drive collisions from EYE_HEIGHT, having HEIGHT here
  // avoids silent fallbacks inside colliders.js.
  HEIGHT: 1.8,

  // Capsule radius for collision.
  RADIUS: 0.45,
};

// ------------------------------------------------------------
// Optional: terrain meta (useful if some modules still expect it)
// ------------------------------------------------------------
export const TERRAIN = {
  // Inner terrain tile is ~1 km x 1 km in your Abisko dataset.
  SIZE_M: 1000,
  HALF_M: 500,
};
