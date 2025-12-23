// abiskoTerrain.colorFragment.glsl
// Replaces: #include <color_fragment>
// IMPORTANT: we keep the original chunk first, then override diffuseColor.

#include <color_fragment>

// slope_deg.png assumption:
// grayscale 0..1 corresponds to 0..90 degrees (adjust if your PNG was scaled differently)
float slope01 = texture2D(uSlopeTex, vUvTerrain).r;
float slopeDeg = slope01 * 90.0;

// Snow factor: 1 on flat, 0 on steep
float snow = 1.0 - smoothstep(uSnowSlopeFull, uSnowSlopeNone, slopeDeg);

// Hillshade: 0..1 (darker valleys, brighter ridges)
float hill = texture2D(uHillTex, vUvTerrain).r;

// Micro albedo variation (avoid “flat paint” look)
float n = noise2(vUvTerrain * 600.0);
float micro = mix(0.92, 1.06, n);

// Base albedo mix
vec3 base = mix(uRockColor, uSnowColor, snow);

// Hillshade contrast (kept subtle, snow still mostly white)
base *= mix(0.82, 1.10, hill);

// Apply micro variation mostly on snow
base *= mix(1.0, micro, snow * 0.7);

diffuseColor.rgb = base;
