// abiskoTerrain.fragHeader.glsl
// Shared header injected into MeshStandardMaterial fragment shader.
// Keep it self-contained: no vUv/vUv2 assumptions.

uniform sampler2D uSlopeTex;
uniform sampler2D uHillTex;

uniform float uSnowSlopeFull;
uniform float uSnowSlopeNone;

uniform vec3 uSnowColor;
uniform vec3 uRockColor;

// Micro-dune (normal perturbation) controls
uniform float uDuneStrength; // 0..1-ish
uniform float uDuneFreq;     // frequency in UV space

// Sparkle controls (handled via roughness modulation)
uniform float uSparkleStrength;   // 0..0.3
uniform float uSparkleDensity;    // 1000..5000
uniform float uSparkleThreshold;  // 0.97..0.995

varying vec2 vUvTerrain;

// --- tiny hash / noise helpers (fast, cheap) ---
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Value noise (cheap, good enough for snow micro variation)
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);

  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));

  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
