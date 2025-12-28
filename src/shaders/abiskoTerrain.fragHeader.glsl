// abiskoTerrain.fragHeader.glsl
//
// Shared header injected into MeshStandardMaterial fragment shader.
// This file must provide EVERY symbol that any of the terrain chunks may reference.
//
// Chunks:
//   - abiskoTerrain.colorFragment.glsl       (expects sampleSlope01, sampleHill01, noise2, etc.)
//   - abiskoTerrain.roughnessFragment.glsl   (expects hash21, sparkle uniforms, vUvTerrain, etc.)
//   - abiskoTerrain.normalFragment.glsl      (expects noise2 and dune uniforms)
//
// Design:
//  - Keep this as a stable "API layer" for all chunks.
//  - Avoid JS string patching. All logic lives in GLSL.

varying vec2 vUvTerrain;

// -----------------------------
// Data maps (NoColorSpace)
// -----------------------------
uniform sampler2D uSlopeTex;
uniform sampler2D uHillTex;

// -----------------------------
// Snow thresholds (degrees)
// -----------------------------
uniform float uSnowSlopeFull;
uniform float uSnowSlopeNone;

// -----------------------------
// Base colors
// -----------------------------
uniform vec3 uSnowColor;
uniform vec3 uRockColor;

// -----------------------------
// Look tuning
// -----------------------------
uniform float uHillStrength;
uniform float uHillBlur;
uniform float uSlopeBlur;

// These are used by your other chunks.
uniform float uDuneStrength;
uniform float uDuneFreq;

uniform float uSparkleStrength;
uniform float uSparklePower;
uniform float uSparkleDensity;
uniform float uSparkleThreshold;

// ------------------------------------------------------------
// Blur helpers
// ------------------------------------------------------------

float sampleBlur5(sampler2D tex, vec2 uv, vec2 duv) {
  float s = texture2D(tex, uv).r;
  s += texture2D(tex, uv + vec2( duv.x, 0.0)).r;
  s += texture2D(tex, uv + vec2(-duv.x, 0.0)).r;
  s += texture2D(tex, uv + vec2(0.0,  duv.y)).r;
  s += texture2D(tex, uv + vec2(0.0, -duv.y)).r;
  return s * 0.2;
}

float sampleBlur9(sampler2D tex, vec2 uv, vec2 duv) {
  float s = 0.0;

  s += texture2D(tex, uv).r;

  s += texture2D(tex, uv + vec2( duv.x, 0.0)).r;
  s += texture2D(tex, uv + vec2(-duv.x, 0.0)).r;
  s += texture2D(tex, uv + vec2(0.0,  duv.y)).r;
  s += texture2D(tex, uv + vec2(0.0, -duv.y)).r;

  s += texture2D(tex, uv + duv).r;
  s += texture2D(tex, uv - duv).r;
  s += texture2D(tex, uv + vec2( duv.x, -duv.y)).r;
  s += texture2D(tex, uv + vec2(-duv.x,  duv.y)).r;

  return s / 9.0;
}

// ------------------------------------------------------------
// Hash + noise (compat)
// ------------------------------------------------------------

// Scalar hash: vec2 -> float in [0..1)
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Compatibility alias: many sparkle chunks expect hash21(vec2)
float hash21(vec2 p) {
  return hash12(p);
}

// Smooth value noise in 2D (0..1)
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);

  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));

  vec2 u = f * f * (3.0 - 2.0 * f);

  return mix(a, b, u.x) +
         (c - a) * u.y * (1.0 - u.x) +
         (d - b) * u.x * u.y;
}

// ------------------------------------------------------------
// Data-map sampling (THIS is what your chunks expect)
// ------------------------------------------------------------

// NOTE: These function names are intentionally chosen to match existing chunk code.
// Your color chunk calls sampleSlope01(vUvTerrain) and sampleHill01(vUvTerrain, snow).

float sampleSlope01(vec2 uv) {
  // Stabilize snow mask. Single-tap slope often causes patchy snow.
  vec2 duv = fwidth(uv) * uSlopeBlur;
  return sampleBlur5(uSlopeTex, uv, duv);
}

float sampleHill01(vec2 uv, float snow01) {
  // Hillshade easily becomes blotchy on snow under fog/soft lighting.
  // We blur more where snow is present.
  vec2 duv = fwidth(uv) * uHillBlur * mix(1.0, 2.2, snow01);
  return sampleBlur9(uHillTex, uv, duv);
}

// Optional convenience: compute snow factor from slope (kept here for reuse)
float computeSnowFactor(vec2 uv) {
  float slope01 = sampleSlope01(uv);
  float slopeDeg = slope01 * 90.0;
  return 1.0 - smoothstep(uSnowSlopeFull, uSnowSlopeNone, slopeDeg);
}
