import * as THREE from "three";

/**
 * Abisko DEM terrain (1 km x 1 km) driven by:
 *  - height_1km_2m_16bit.png  (CPU: vertex displacement)
 *  - slope_deg.png           (GPU: snow vs rock)
 *  - hillshade.png           (GPU: readability/lighting imprint)
 *
 * Clean architecture choice:
 *  - NO string patching of GLSL in JS.
 *  - All snow continuity logic lives in the shader files.
 *  - JS only:
 *      - builds geometry from the height map
 *      - loads textures
 *      - injects external shader chunks
 *      - sets uniforms (tuning knobs)
 */

const DEFAULT_TERRAIN_SIZE_M = 1000;
const MAX_SEGMENTS = 512;

// Elevation range (meters) for your crop (update if tile changes)
const ELEV_MIN_M = 478.42;
const ELEV_MAX_M = 723.65;

// Snow logic (degrees)
const SNOW_SLOPE_FULL = 12.0;
const SNOW_SLOPE_NONE = 35.0;

const COLOR_SNOW = new THREE.Color(0.92, 0.95, 1.0);
const COLOR_ROCK = new THREE.Color(0.30, 0.32, 0.35);

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------

async function fetchText(urlObj) {
  const res = await fetch(urlObj);
  if (!res.ok) {
    throw new Error(`Failed to fetch shader "${urlObj}": ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function loadImageData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);

  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;

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
  const xx = Math.max(0, Math.min(imageData.width - 1, x));
  const yy = Math.max(0, Math.min(imageData.height - 1, y));
  const i = 4 * (yy * imageData.width + xx);
  return imageData.data[i] / 255.0;
}

function smoothHeightGrid(heights, w, h, iterations = 1) {
  const tmp = new Float32Array(heights.length);

  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let cnt = 0;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.max(0, Math.min(w - 1, x + dx));
            const yy = Math.max(0, Math.min(h - 1, y + dy));
            sum += heights[yy * w + xx];
            cnt++;
          }
        }

        tmp[y * w + x] = sum / cnt;
      }
    }
    heights.set(tmp);
  }
}

function mirrorRepeat01(t) {
  t = t % 2;
  if (t < 0) t += 2;
  return t <= 1 ? t : 2 - t;
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export async function createAbiskoTerrain({
  heightUrl = "/assets/terrain/height_1km_2m_16bit.png",
  slopeUrl = "/assets/terrain/slope_deg.png",
  hillshadeUrl = "/assets/terrain/hillshade.png",
  sizeM = DEFAULT_TERRAIN_SIZE_M,
} = {}) {
  // ------------------------------------------------------------
  // 1) Load external GLSL chunks
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
  // 2) Build geometry from height map (CPU displacement)
  // ------------------------------------------------------------

  const heightImg = await loadImageData(heightUrl);
  const stride = computeStride(heightImg.width, heightImg.height);

  const sampleW = Math.floor((heightImg.width - 1) / stride) + 1;
  const sampleH = Math.floor((heightImg.height - 1) / stride) + 1;

  const segX = sampleW - 1;
  const segY = sampleH - 1;

  const heights = new Float32Array(sampleW * sampleH);

  const geom = new THREE.PlaneGeometry(sizeM, sizeM, segX, segY);
  const pos = geom.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const ix = i % (segX + 1);
    const iy = Math.floor(i / (segX + 1));

    const px = ix * stride;
    const py = iy * stride;

    const h01 = sampleGray01(heightImg, px, py);
    const elevM = ELEV_MIN_M + h01 * (ELEV_MAX_M - ELEV_MIN_M);

    const shifted = elevM - ELEV_MIN_M; // 0 == min elevation
    pos.setZ(i, shifted);
    heights[iy * sampleW + ix] = shifted;
  }

  // Geometry smoothing: removes faceting without destroying macro shape
  smoothHeightGrid(heights, sampleW, sampleH, 3);

  for (let i = 0; i < pos.count; i++) {
    const ix = i % (segX + 1);
    const iy = Math.floor(i / (segX + 1));
    pos.setZ(i, heights[iy * sampleW + ix]);
  }

  pos.needsUpdate = true;
  geom.computeVertexNormals();

  // PlaneGeometry is XY by default: rotate to XZ with Y up
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

  // These are data maps, not color maps (avoid any sRGB conversion)
  slopeTex.colorSpace = THREE.NoColorSpace;
  hillTex.colorSpace = THREE.NoColorSpace;

  slopeTex.wrapS = slopeTex.wrapT = THREE.ClampToEdgeWrapping;
  hillTex.wrapS = hillTex.wrapT = THREE.ClampToEdgeWrapping;

  // Linear filtering reduces shimmer and aliasing
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
    // Core textures
    shader.uniforms.uSlopeTex = { value: slopeTex };
    shader.uniforms.uHillTex = { value: hillTex };

    // Snow thresholds
    shader.uniforms.uSnowSlopeFull = { value: SNOW_SLOPE_FULL };
    shader.uniforms.uSnowSlopeNone = { value: SNOW_SLOPE_NONE };

    // Base colors
    shader.uniforms.uSnowColor = { value: COLOR_SNOW.clone() };
    shader.uniforms.uRockColor = { value: COLOR_ROCK.clone() };

    // Visual tuning knobs (these are consumed by GLSL now, not patched by JS)
    shader.uniforms.uHillStrength = { value: 1.0 }; // mainly affects rock; snow reduces internally
    shader.uniforms.uHillBlur = { value: 3.2 };     // hillshade blur footprint
    shader.uniforms.uSlopeBlur = { value: 2.4 };    // slope blur footprint (stabilizes snow mask)

    // Dunes + sparkle (leave your existing normal/roughness logic intact, just tune)
    shader.uniforms.uDuneStrength = { value: 0.07 };
    shader.uniforms.uDuneFreq = { value: 32.0 };

    shader.uniforms.uSparkleStrength = { value: 0.025 };
    shader.uniforms.uSparklePower = { value: 80.0 };
    shader.uniforms.uSparkleDensity = { value: 2600.0 };
    shader.uniforms.uSparkleThreshold = { value: 0.992 };

    /**
     * We always define our own UV varying so slope/hillshade sampling is stable.
     * (Depending on defines, Three may or may not include vUv in compiled shaders.)
     */
    shader.vertexShader = shader.vertexShader.replace(
      "#include <uv_pars_vertex>",
      `#include <uv_pars_vertex>
varying vec2 vUvTerrain;`
    );

    shader.vertexShader = shader.vertexShader.replace(
      "#include <uv_vertex>",
      `#include <uv_vertex>
vUvTerrain = uv;`
    );

    // Inject our custom header after <common>
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>\n${fragHeader}\n`
    );

    // Replace standard chunks with external GLSL snippets
    shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", colorChunk);
    shader.fragmentShader = shader.fragmentShader.replace("#include <roughnessmap_fragment>", roughChunk);
    shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", normalChunk);
  };

  // Force recompilation if you change GLSL files
  mat.customProgramCacheKey = () => "abiskoTerrain_cleanShaders_v1";

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "AbiskoTerrain";
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  // ------------------------------------------------------------
  // 5) Height sampling API (strict + wrapped)
  // ------------------------------------------------------------

  function sampleHeightAtUV(u, v) {
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

  function getHeightAtLocalXZ(x, z) {
    const half = sizeM * 0.5;
    const u = (x + half) / sizeM;
    const v = (z + half) / sizeM;

    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return sampleHeightAtUV(u, v);
  }

  function getHeightAtLocalXZWrapped(x, z) {
    const half = sizeM * 0.5;
    let u = (x + half) / sizeM;
    let v = (z + half) / sizeM;

    u = mirrorRepeat01(u);
    v = mirrorRepeat01(v);

    return sampleHeightAtUV(u, v);
  }

  function getHeightAtWorldXZ(x, z) {
    const localX = x - mesh.position.x;
    const localZ = z - mesh.position.z;

    const hLocal = getHeightAtLocalXZ(localX, localZ);
    if (hLocal == null) return null;
    return mesh.position.y + hLocal;
  }

  function getHeightAtWorldXZWrapped(x, z) {
    const localX = x - mesh.position.x;
    const localZ = z - mesh.position.z;

    const hLocal = getHeightAtLocalXZWrapped(localX, localZ);
    return mesh.position.y + hLocal;
  }

  mesh.userData.getHeightAtLocalXZ = getHeightAtLocalXZ;
  mesh.userData.getHeightAtWorldXZ = getHeightAtWorldXZ;

  mesh.userData.getHeightAt = (x, z) => getHeightAtWorldXZ(x, z);
  mesh.userData.getHeightAtWrapped = (x, z) => getHeightAtWorldXZWrapped(x, z);

  mesh.userData.terrainSizeM = sizeM;
  mesh.userData.elevMinM = ELEV_MIN_M;
  mesh.userData.elevMaxM = ELEV_MAX_M;

  return mesh;
}
