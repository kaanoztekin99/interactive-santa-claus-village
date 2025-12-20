// abiskoTerrain.roughnessFragment.glsl
// Replaces: #include <roughnessmap_fragment>

#include <roughnessmap_fragment>

// Re-sample slope to stay consistent with color logic
float slope01_r = texture2D(uSlopeTex, vUvTerrain).r;
float slopeDeg_r = slope01_r * 90.0;

float snow_r = 1.0 - smoothstep(uSnowSlopeFull, uSnowSlopeNone, slopeDeg_r);

// Base roughness: rocks slightly less rough than snow
float baseRough = mix(0.65, 0.95, snow_r);

// Sparkle mask:
// - only meaningful where snow exists AND slope is low
float flatMask = 1.0 - smoothstep(10.0, 25.0, slopeDeg_r); // 1 flat, 0 steep
float snowFlat = snow_r * flatMask;

// Sparse “crystal” distribution in UV space
float rnd = hash21(vUvTerrain * uSparkleDensity);
float crystal = step(uSparkleThreshold, rnd); // mostly 0, sometimes 1

// Sparkle reduces roughness locally -> sharper specular glints
float sparkle = crystal * snowFlat;
float rough = baseRough - sparkle * uSparkleStrength;

// Keep physically reasonable bounds
roughnessFactor = clamp(rough, 0.04, 1.0);
