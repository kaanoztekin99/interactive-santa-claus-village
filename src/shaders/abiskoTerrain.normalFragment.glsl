// abiskoTerrain.normalFragment.glsl
// Replaces: #include <normal_fragment_maps>
//
// Goal: micro-dune / wind ripples only on flatter snow.
// We do a tiny bump-like normal perturbation in view space using derivatives.
// This is intentionally subtle: too strong looks like sand, not snow.

#include <normal_fragment_maps>

// Compute slope + snow again (cheap and keeps behavior consistent)
float slope01_n = texture2D(uSlopeTex, vUvTerrain).r;
float slopeDeg_n = slope01_n * 90.0;
float snow_n = 1.0 - smoothstep(uSnowSlopeFull, uSnowSlopeNone, slopeDeg_n);

float flatMask_n = 1.0 - smoothstep(10.0, 25.0, slopeDeg_n);
float snowFlat_n = snow_n * flatMask_n;

// Dune height function (UV-space ripples + slight noise warp)
vec2 uv = vUvTerrain;

// Warp UV a bit so dunes don't look perfectly sinusoidal
float warp = (noise2(uv * (uDuneFreq * 0.25)) - 0.5) * 0.15;
uv += vec2(warp, -warp);

float dune =
  sin(uv.x * uDuneFreq + noise2(uv * (uDuneFreq * 0.1)) * 2.0) * 0.5 +
  sin(uv.y * (uDuneFreq * 0.7)) * 0.25;

dune *= snowFlat_n;

// Convert dune “height” into a small normal perturbation using screen-space derivatives.
// We operate in view space; vViewPosition exists in MeshStandardMaterial fragment.
float h = dune;
float dhdx = dFdx(h);
float dhdy = dFdy(h);

// Build a tangent-ish basis from view-space position and UV derivatives.
// This is a common trick to do bump mapping without a normal map.
vec3 dpdx = dFdx(vViewPosition);
vec3 dpdy = dFdy(vViewPosition);
vec2 dtdx = dFdx(vUvTerrain);
vec2 dtdy = dFdy(vUvTerrain);

vec3 T = normalize(dpdx * dtdy.t - dpdy * dtdx.t);
vec3 B = normalize(-dpdx * dtdy.s + dpdy * dtdx.s);

// Perturb normal: subtle, scaled by dune strength
vec3 N = normalize(normal);
vec3 bumped = normalize(N + (T * dhdx + B * dhdy) * uDuneStrength);

// Only apply where it makes sense (flat snow)
normal = normalize(mix(N, bumped, snowFlat_n));
