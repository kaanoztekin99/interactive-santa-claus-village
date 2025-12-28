// abiskoTerrain.colorFragment.glsl
//
// This replaces MeshStandardMaterial's <color_fragment> chunk.
// We compute a stable snow factor from slope, then color the terrain.
// Key goals:
//  - Snow looks continuous (no harsh patchy contrast).
//  - Hillshade helps rock readability, but is almost neutral on snow.
//  - Micro variation exists, but stays subtle under fog and lighting.

{
  // -------------------------
  // 1) Compute snow factor
  // -------------------------
  float slope01 = sampleSlope01(vUvTerrain);

  // The slope map is slope in degrees baked to grayscale.
  // Most pipelines encode 0..90 degrees into 0..1, so we restore degrees.
  float slopeDeg = slope01 * 90.0;

  // snow = 1 for gentle slopes, 0 for steep slopes
  float snow = 1.0 - smoothstep(uSnowSlopeFull, uSnowSlopeNone, slopeDeg);

  // -------------------------
  // 2) Base albedo
  // -------------------------
  vec3 base = mix(uRockColor, uSnowColor, snow);

  // -------------------------
  // 3) Gentle micro variation
  // -------------------------
  // Lower frequency and tiny amplitude.
  float n = noise2(vUvTerrain * 360.0);
  float micro = mix(0.993, 1.007, n);

  // Apply mainly on snow, but weak (prevents peppery look in fog)
  base *= mix(1.0, micro, snow * 0.14);

  // -------------------------
  // 4) Hillshade influence (snow aware)
  // -------------------------
  float hill = sampleHill01(vUvTerrain, snow);

  // Keep hillshade mainly for rock, almost neutral for snow.
  float hsRock = uHillStrength;
  float hsSnow = uHillStrength * 0.03;
  float hs = mix(hsRock, hsSnow, snow);

  // Rock gets a readable range, snow stays around 1.0.
  float lo = mix(0.90, 0.995, snow);
  float hi = mix(1.08, 1.005, snow);

  // Convert hs (0..1) into a mix between neutral (1.0) and the hill range
  float hillLo = mix(1.0, lo, hs);
  float hillHi = mix(1.0, hi, hs);

  base *= mix(hillLo, hillHi, hill);

  // -------------------------
  // 5) Output to Three.js
  // -------------------------
  diffuseColor.rgb = base;
}
