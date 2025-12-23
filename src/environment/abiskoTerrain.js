import * as THREE from "three";

/**
 * Abisko DEM terrain (1 km x 1 km) driven by:
 *  - height_1km_2m_16bit.png  (CPU: vertex displacement)
 *  - slope_deg.png           (GPU: snow vs rock)
 *  - hillshade.png           (GPU: contrast/readability)
 *
 * Key design goals:
 *  - Keep geometry interactive (downsample the PNG if it's huge)
 *  - Expose a reliable height query API for:
 *      - camera ground clamp (FPS movement)
 *      - model placement (sit on snow)
 *  - Use external GLSL snippets so you can iterate shader logic without touching JS
 */

// ------------------------------------------------------------
// Scene scale / performance knobs
// ------------------------------------------------------------

const TERRAIN_SIZE_M = 1000; // 1km x 1km

// Prevent insane vertex counts (PNG can be 2000x2000+).
// We'll downsample so we keep <= ~512 segments per side.
const MAX_SEGMENTS = 512;

// Elevation range (meters) for YOUR crop (from gdalinfo stats of tile_abisko)
// Update these if you change crop.
const ELEV_MIN_M = 478.42;
const ELEV_MAX_M = 723.65;

// Snow logic (degrees)
const SNOW_SLOPE_FULL = 12.0; // <= full snow
const SNOW_SLOPE_NONE = 35.0; // >= no snow

// Base colors (linear-ish; renderer outputColorSpace handles final conversion)
const COLOR_SNOW = new THREE.Color(0.92, 0.95, 1.0);
const COLOR_ROCK = new THREE.Color(0.30, 0.32, 0.35);

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------

async function fetchText(urlObj) {
  const res = await fetch(urlObj);
  if (!res.ok) throw new Error(`Failed to fetch shader "${urlObj}": ${res.status} ${res.statusText}`);
  return await res.text();
}

async function loadImageData(url) {
  // Fetch -> createImageBitmap -> draw to canvas -> get RGBA
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);

  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;

  // willReadFrequently improves perf for getImageData in some browsers
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);

  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: bmp.width, height: bmp.height, data: img.data };
}

function computeStride(w, h) {
  const maxSide = Math.max(w, h);
  if (maxSide <= (MAX_SEGMENTS + 1)) return 1;
  return Math.ceil(maxSide / (MAX_SEGMENTS + 1));
}

function sampleGray01(imageData, x, y) {
  // Clamp to avoid out-of-bounds access
  const xx = Math.max(0, Math.min(imageData.width - 1, x));
  const yy = Math.max(0, Math.min(imageData.height - 1, y));
  const i = 4 * (yy * imageData.width + xx);

  // Assumes grayscale PNG (R holds the value)
  return imageData.data[i] / 255.0;
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export async function createAbiskoTerrain({
  heightUrl = "/assets/terrain/height_1km_2m_16bit.png",
  slopeUrl = "/assets/terrain/slope_deg.png",
  hillshadeUrl = "/assets/terrain/hillshade.png",
} = {}) {
  // ------------------------------------------------------------
  // 1) Load external GLSL snippets
  // ------------------------------------------------------------

  const fragHeaderUrl = new URL("../shaders/abiskoTerrain.fragHeader.glsl", import.meta.url);
  const colorChunkUrl = new URL("../shaders/abiskoTerrain.colorFragment.glsl", import.meta.url);
  const roughChunkUrl = new URL("../shaders/abiskoTerrain.roughnessFragment.glsl", import.meta.url);
  const normalChunkUrl = new URL("../shaders/abiskoTerrain.normalFragment.glsl", import.meta.url);

  const [fragHeader, colorChunk, roughChunk, normalChunk] = await Promise.all([
    fetchText(fragHeaderUrl),
    fetchText(colorChunkUrl),
    fetchText(roughChunkUrl),
    fetchText(normalChunkUrl),
  ]);

  // ------------------------------------------------------------
  // 2) Load heightmap pixels (CPU) + build geometry
  // ------------------------------------------------------------

  const heightImg = await loadImageData(heightUrl);

  // Downsample: reduce vertex count while still keeping terrain shape.
  const stride = computeStride(heightImg.width, heightImg.height);

  const sampleW = Math.floor((heightImg.width - 1) / stride) + 1;
  const sampleH = Math.floor((heightImg.height - 1) / stride) + 1;

  const segX = sampleW - 1;
  const segY = sampleH - 1;

  // Heights stored in "shifted meters":
  //   0.0 == ELEV_MIN_M, positive upward.
  const heights = new Float32Array(sampleW * sampleH);

  // PlaneGeometry is created in XY, we rotate to XZ later.
  const geom = new THREE.PlaneGeometry(TERRAIN_SIZE_M, TERRAIN_SIZE_M, segX, segY);
  const pos = geom.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    // Vertex indexing is row-major: x changes fastest.
    const ix = i % (segX + 1);
    const iy = Math.floor(i / (segX + 1));

    const px = ix * stride;
    const py = iy * stride;

    const h01 = sampleGray01(heightImg, px, py);
    const elevM = ELEV_MIN_M + h01 * (ELEV_MAX_M - ELEV_MIN_M);

    const shifted = elevM - ELEV_MIN_M;
    pos.setZ(i, shifted);

    heights[iy * sampleW + ix] = shifted;
  }

  pos.needsUpdate = true;
  geom.computeVertexNormals();

  // Now the plane lies on XZ with Y up.
  geom.rotateX(-Math.PI / 2);

  // ------------------------------------------------------------
  // 3) Load slope + hillshade textures (GPU)
  // ------------------------------------------------------------

  const texLoader = new THREE.TextureLoader();

  const slopeTex = await new Promise((resolve, reject) => {
    texLoader.load(slopeUrl, resolve, undefined, reject);
  });

  const hillTex = await new Promise((resolve, reject) => {
    texLoader.load(hillshadeUrl, resolve, undefined, reject);
  });

  // Data textures: prevent sRGB transforms
  slopeTex.colorSpace = THREE.NoColorSpace;
  hillTex.colorSpace = THREE.NoColorSpace;

  // We want them to align 1:1 with the terrain
  slopeTex.wrapS = slopeTex.wrapT = THREE.ClampToEdgeWrapping;
  hillTex.wrapS = hillTex.wrapT = THREE.ClampToEdgeWrapping;

  // Smooth a bit (reduces aliasing / shimmer)
  slopeTex.minFilter = slopeTex.magFilter = THREE.LinearFilter;
  hillTex.minFilter = hillTex.magFilter = THREE.LinearFilter;

  // ------------------------------------------------------------
  // 4) Material + shader injection
  // ------------------------------------------------------------

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.0,
  });

  mat.onBeforeCompile = (shader) => {
    // ---- uniforms used by our custom GLSL ----
    shader.uniforms.uSlopeTex = { value: slopeTex };
    shader.uniforms.uHillTex = { value: hillTex };

    shader.uniforms.uSnowSlopeFull = { value: SNOW_SLOPE_FULL };
    shader.uniforms.uSnowSlopeNone = { value: SNOW_SLOPE_NONE };

    shader.uniforms.uSnowColor = { value: COLOR_SNOW.clone() };
    shader.uniforms.uRockColor = { value: COLOR_ROCK.clone() };

    // Micro dunes / sparkle (your shader snippets use these)
    shader.uniforms.uDuneStrength = { value: 0.35 };
    shader.uniforms.uDuneFreq = { value: 45.0 };

    shader.uniforms.uSparkleStrength = { value: 0.10 };
    shader.uniforms.uSparklePower = { value: 80.0 }; // (if unused in your GLSL, harmless)
    shader.uniforms.uSparkleDensity = { value: 2600.0 };
    shader.uniforms.uSparkleThreshold = { value: 0.985 };

    /**
     * IMPORTANT:
     * We do NOT rely on Three's built-in `vUv` varying because it's not always compiled
     * unless certain defines are enabled.
     *
     * So we always define our own `vUvTerrain` and sample slope/hillshade with that.
     */

    // Vertex: declare varying
    shader.vertexShader = shader.vertexShader.replace(
      "#include <uv_pars_vertex>",
      `#include <uv_pars_vertex>
varying vec2 vUvTerrain;`
    );

    // Vertex: write varying
    shader.vertexShader = shader.vertexShader.replace(
      "#include <uv_vertex>",
      `#include <uv_vertex>
vUvTerrain = uv;`
    );

    // Fragment: inject our header after <common>
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>\n${fragHeader}\n`
    );

    // Replace shader chunks with external GLSL snippets
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", colorChunk);
    shader.fragmentShader = shader.fragmentShader.replace("#include <roughnessmap_fragment>", roughChunk);
    shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", normalChunk);
  };

  // Ensure shader program caching doesn't reuse an older variant by accident
  mat.customProgramCacheKey = () => "abiskoTerrain_vUvTerrain_final_v1";

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "AbiskoTerrain";
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  // ------------------------------------------------------------
  // 5) Height sampling (this MUST exist for your main.js)
  // ------------------------------------------------------------

  /**
   * Bilinear height query in LOCAL space (x,z are in meters).
   * Terrain spans [-500..+500] in local X and Z.
   *
   * Returns:
   *  - height in SHIFTED meters (0 == min elevation)
   *  - null if outside the tile bounds
   */
  function getHeightAtLocalXZ(x, z) {
    const half = TERRAIN_SIZE_M * 0.5;

    // Map [-half..+half] -> [0..1]
    const u = (x + half) / TERRAIN_SIZE_M;
    const v = (z + half) / TERRAIN_SIZE_M;

    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    // Map [0..1] -> [0..sampleW-1], [0..sampleH-1]
    const fx = u * (sampleW - 1);
    const fy = v * (sampleH - 1);

    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, sampleW - 1);
    const y1 = Math.min(y0 + 1, sampleH - 1);

    const tx = fx - x0;
    const ty = fy - y0;

    const h00 = heights[y0 * sampleW + x0];
    const h10 = heights[y0 * sampleW + x1];
    const h01 = heights[y1 * sampleW + x0];
    const h11 = heights[y1 * sampleW + x1];

    const hx0 = h00 * (1 - tx) + h10 * tx;
    const hx1 = h01 * (1 - tx) + h11 * tx;

    return hx0 * (1 - ty) + hx1 * ty;
  }

  /**
   * Height query in WORLD space (x,z are world meters).
   * Assumes terrain is only translated (no extra rotation/scale applied after creation).
   */
  function getHeightAtWorldXZ(x, z) {
    const localX = x - mesh.position.x;
    const localZ = z - mesh.position.z;
    const hLocal = getHeightAtLocalXZ(localX, localZ);
    if (hLocal == null) return null;
    return mesh.position.y + hLocal;
  }

  // Expose stable API
  mesh.userData.getHeightAtLocalXZ = getHeightAtLocalXZ;
  mesh.userData.getHeightAtWorldXZ = getHeightAtWorldXZ;

  // This is the function your main.js expects:
  mesh.userData.getHeightAt = (x, z) => getHeightAtWorldXZ(x, z);

  // Small metadata that can be useful later
  mesh.userData.terrainSizeM = TERRAIN_SIZE_M;
  mesh.userData.elevMinM = ELEV_MIN_M;
  mesh.userData.elevMaxM = ELEV_MAX_M;

  return mesh;
}
