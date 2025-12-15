import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ---------------------------------------------------------------------
// Core variables
// ---------------------------------------------------------------------
let scene, camera, renderer, controls;
let pmremGenerator;

const HDRI_PATH = "./assets/skybox/horn-koppe_snow_4k.exr";
const MODEL_PATH = "./assets/models/winter_camping.glb";

const clock = new THREE.Clock();

// Player tuning
const EYE_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.45;

// FPS movement tuning
const MOVE_SPEED = 10.0; // m/s
const LOOK_MAX_PITCH = 85; // degrees (anti-flip)
const FOV_MIN = 35;
const FOV_MAX = 80;

// Terrain tuning (must match createTerrain size)
const TERRAIN_SIZE = 260;
const TERRAIN_HALF = TERRAIN_SIZE / 2;

// World objects
let terrainMesh = null;
const colliderBoxes = []; // AABBs expanded by PLAYER_RADIUS

// Reuse
const tmpDir = new THREE.Vector3();
const prevPlayerPos = new THREE.Vector3();
const downRay = new THREE.Raycaster();
const downOrigin = new THREE.Vector3();

const keys = { w: false, a: false, s: false, d: false };

// Ground fallback (important!)
let lastGroundY = 0;

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
init();
animate();

function init() {
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xcfe9ff, 30, 220);

  // Camera
  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );

  // Renderer
  const canvas = document.getElementById("webgl-canvas");
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // PMREM
  pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  // FPS Controls (PointerLock)
  controls = new PointerLockControls(camera, renderer.domElement);
  scene.add(controls.getObject());

  // IMPORTANT: camera local offset must be zero; player position is controls.getObject().position
  camera.position.set(0, 0, 0);

  // Click to lock mouse (like games)
  renderer.domElement.addEventListener("pointerdown", () => controls.lock());
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

  // Wheel zoom
  renderer.domElement.addEventListener("wheel", onWheelZoom, { passive: false });

  // Input
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // Lights
  addLights();

  // Terrain + obstacles
  terrainMesh = createTerrain();
  scene.add(terrainMesh);

  createLandmarks(); // optional test obstacles

  // HDRI
  loadHDRI(HDRI_PATH);

  // Example Sketchfab model
  loadSketchfabModel({
    path: MODEL_PATH,
    x: 0,
    z: 0,
    targetHeight: 6.0,   // altezza desiderata in metri (cambia pure)
    yawDeg: 0,
    yOffset: 0.0,
    addToCollisions: true,
  });


  // Spawn player
  const spawnX = 0, spawnZ = 8;
  const g = sampleGroundY(spawnX, spawnZ, 0);
  lastGroundY = g;
  controls.getObject().position.set(spawnX, g + EYE_HEIGHT, spawnZ);

  // Resize
  window.addEventListener("resize", onWindowResize);
}

function addLights() {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.35);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(20, 40, 10);
  sun.castShadow = true;

  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 150;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;

  scene.add(sun);
}

// ---------------------------------------------------------------------
// HDRI Loader (EXR)
// ---------------------------------------------------------------------
function loadHDRI(path) {
  const loader = new EXRLoader();
  loader.setDataType(THREE.FloatType);

  loader.load(
    path,
    (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const envMap = pmremGenerator.fromEquirectangular(texture).texture;

      scene.background = envMap;
      scene.environment = envMap;

      texture.dispose();
      pmremGenerator.dispose();
      console.log("HDRI loaded:", path);
    },
    undefined,
    (error) => console.error("Error loading EXR HDRI:", error)
  );
}

// ---------------------------------------------------------------------
// Terrain (procedurale)
// ---------------------------------------------------------------------
function createTerrain() {
  const size = TERRAIN_SIZE;
  const seg = 220;

  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const amp = 3.5;
  const freq = 0.045;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h =
      0.60 * noise2D(x * freq, z * freq) +
      0.30 * noise2D(x * freq * 2.2, z * freq * 2.2) +
      0.10 * noise2D(x * freq * 6.0, z * freq * 6.0);

    pos.setY(i, (h - 0.5) * 2.0 * amp);
  }

  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide, // IMPORTANT: if you ever look from below you still see terrain
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = "terrain";
  return mesh;
}

// deterministic value-noise 2D
function noise2D(x, z) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const x1 = x0 + 1, z1 = z0 + 1;

  const sx = smoothstep(x - x0);
  const sz = smoothstep(z - z0);

  const n00 = hash2D(x0, z0);
  const n10 = hash2D(x1, z0);
  const n01 = hash2D(x0, z1);
  const n11 = hash2D(x1, z1);

  const ix0 = lerp(n00, n10, sx);
  const ix1 = lerp(n01, n11, sx);
  return lerp(ix0, ix1, sz);
}

function hash2D(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------
// Landmarks (test) + auto collision
// ---------------------------------------------------------------------
function createLandmarks() {
  const houseMat = new THREE.MeshStandardMaterial({ color: 0xffd2a6, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.9 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 1.0 });
  const leavesMat = new THREE.MeshStandardMaterial({ color: 0x2e6b3a, roughness: 1.0 });

  const placeOnGround = (obj, x, z) => {
    const y = sampleGroundY(x, z, lastGroundY);
    obj.position.set(x, y, z);
  };

  // Houses
  for (let i = 0; i < 10; i++) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.2, 3.2), houseMat);
    base.castShadow = true;
    base.receiveShadow = true;

    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.7, 1.6, 4), roofMat);
    roof.position.y = 2.2 / 2 + 1.6 / 2;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;

    const house = new THREE.Group();
    house.add(base);
    house.add(roof);

    const x = (Math.random() - 0.5) * 160;
    const z = (Math.random() - 0.5) * 160;
    placeOnGround(house, x, z);

    scene.add(house);
    registerCollidersFromObject(house);
  }

  // Trees
  for (let i = 0; i < 40; i++) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 2.2, 10), trunkMat);
    trunk.castShadow = true;
    trunk.receiveShadow = true;

    const crown = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2.8, 12), leavesMat);
    crown.position.y = 2.2 / 2 + 2.8 / 2 - 0.2;
    crown.castShadow = true;

    const tree = new THREE.Group();
    tree.add(trunk);
    tree.add(crown);

    const x = (Math.random() - 0.5) * 220;
    const z = (Math.random() - 0.5) * 220;
    placeOnGround(tree, x, z);

    scene.add(tree);
    registerCollidersFromObject(tree);
  }
}

// ---------------------------------------------------------------------
// Collision registration (AUTO) for real models
// ---------------------------------------------------------------------
function registerCollidersFromObject(root, opts = {}) {
  const {
    expand = PLAYER_RADIUS,
    includeInvisible = false,
    ignoreNoColliderTag = true,
    minSize = 0.02,
  } = opts;

  root.updateMatrixWorld(true);

  const tmpBox = new THREE.Box3();
  const tmpSize = new THREE.Vector3();

  root.traverse((obj) => {
    if (!obj.isMesh) return;

    if (!includeInvisible && obj.visible === false) return;

    if (ignoreNoColliderTag) {
      if (obj.userData && obj.userData.noCollider) return;
      if ((obj.name || "").toLowerCase().includes("nocollide")) return;
      if ((obj.parent?.name || "").toLowerCase().includes("nocollide")) return;
    }

    const mat = obj.material;
    if (mat && mat.transparent && mat.opacity !== undefined && mat.opacity < 0.2) return;

    tmpBox.setFromObject(obj);
    if (tmpBox.isEmpty()) return;

    tmpBox.getSize(tmpSize);
    if (tmpSize.length() < minSize) return;

    tmpBox.expandByScalar(expand);
    colliderBoxes.push(tmpBox.clone());
  });
}

// ---------------------------------------------------------------------
// Sketchfab model loader (GLB/glTF)
// ---------------------------------------------------------------------
function loadSketchfabModel({
  path,
  x,
  z,
  targetHeight = 6.0,
  yawDeg = 0,
  yOffset = 0,
  addToCollisions = true,
}) {
  const loader = new GLTFLoader();

  loader.load(
    path,
    (gltf) => {
      const root = gltf.scene;

      // Ombre
      root.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      // 1) calcola bbox e dimensioni originali
      root.updateMatrixWorld(true);
      const box0 = new THREE.Box3().setFromObject(root);
      const size0 = new THREE.Vector3();
      box0.getSize(size0);

      // 2) auto-scale (se ha senso)
      if (size0.y > 1e-6) {
        const s = targetHeight / size0.y;
        root.scale.setScalar(s);
      }

      // 3) ruota yaw
      root.rotation.y = THREE.MathUtils.degToRad(yawDeg);

      // 4) ricalcola bbox dopo scale/rotazione
      root.updateMatrixWorld(true);
      const box1 = new THREE.Box3().setFromObject(root);

      // 5) posiziona al centro (x,z) e appoggia la base sul terreno
      const groundY = sampleGroundY(x, z, lastGroundY);

      // box1.min.y è la base del modello in world coords (relativa alla posizione corrente).
      // quindi per appoggiare: y = groundY - minY + offset
      root.position.set(x, groundY - box1.min.y + yOffset, z);

      scene.add(root);

      if (addToCollisions) {
        registerCollidersFromObject(root, { minSize: 0.05 });
      }

      console.log("Model loaded:", path);
      console.log("Model size (approx):", size0, "targetHeight:", targetHeight);
    },
    undefined,
    (err) => console.error("Error loading model:", path, err)
  );
}


// ---------------------------------------------------------------------
// Ground sampling + clamp (ROBUST)
// ---------------------------------------------------------------------
function sampleGroundY(x, z, fallback = 0) {
  if (!terrainMesh) return fallback;

  downOrigin.set(x, 200, z);
  downRay.set(downOrigin, new THREE.Vector3(0, -1, 0));

  const hits = downRay.intersectObject(terrainMesh, false);
  return hits.length ? hits[0].point.y : fallback;
}

function applyGroundClampToPlayer() {
  const player = controls.getObject();

  // keep inside terrain so raycast doesn't miss at the edges
  player.position.x = THREE.MathUtils.clamp(player.position.x, -TERRAIN_HALF + 1, TERRAIN_HALF - 1);
  player.position.z = THREE.MathUtils.clamp(player.position.z, -TERRAIN_HALF + 1, TERRAIN_HALF - 1);

  const groundY = sampleGroundY(player.position.x, player.position.z, lastGroundY);
  lastGroundY = groundY;

  // player is the camera world position (eyes)
  player.position.y = groundY + EYE_HEIGHT;
}

// ---------------------------------------------------------------------
// Collision resolve (point vs expanded AABB)
// ---------------------------------------------------------------------
function resolveCollisions() {
  const player = controls.getObject();
  for (let i = 0; i < colliderBoxes.length; i++) {
    if (colliderBoxes[i].containsPoint(player.position)) {
      player.position.copy(prevPlayerPos);
      applyGroundClampToPlayer();
      break;
    }
  }
}

// ---------------------------------------------------------------------
// FPS movement + input
// ---------------------------------------------------------------------
function onKeyDown(e) {
  if (!controls.isLocked) return;
  if (e.code === "KeyW") keys.w = true;
  if (e.code === "KeyA") keys.a = true;
  if (e.code === "KeyS") keys.s = true;
  if (e.code === "KeyD") keys.d = true;
}

function onKeyUp(e) {
  if (e.code === "KeyW") keys.w = false;
  if (e.code === "KeyA") keys.a = false;
  if (e.code === "KeyS") keys.s = false;
  if (e.code === "KeyD") keys.d = false;
}

function updateMovement(dt) {
  if (!controls.isLocked) return;

  const forward = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  const right = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  if (forward === 0 && right === 0) return;

  tmpDir.set(right, 0, forward).normalize();
  const speed = MOVE_SPEED * dt;

  if (tmpDir.z !== 0) controls.moveForward(tmpDir.z * speed);
  if (tmpDir.x !== 0) controls.moveRight(tmpDir.x * speed);
}

// Hard pitch clamp (no lookAt; doesn't fight pointer lock)
function clampPitchHard() {
  // PointerLockControls structure: yawObject (controls.getObject()) -> pitchObject -> camera
  const pitchObject = controls.getObject().children[0];
  if (!pitchObject) return;

  const maxPitch = THREE.MathUtils.degToRad(LOOK_MAX_PITCH);
  pitchObject.rotation.x = THREE.MathUtils.clamp(pitchObject.rotation.x, -maxPitch, maxPitch);
}

// ---------------------------------------------------------------------
// Zoom: wheel = FOV, Shift+wheel = dolly (when locked)
// ---------------------------------------------------------------------
function onWheelZoom(e) {
  e.preventDefault();

  if (e.shiftKey && controls.isLocked) {
    const dolly = e.deltaY * 0.01;
    controls.moveForward(dolly);
    return;
  }

  camera.fov = THREE.MathUtils.clamp(camera.fov + e.deltaY * 0.02, FOV_MIN, FOV_MAX);
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------
function onWindowResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ---------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);

  const dt = clock.getDelta();
  const player = controls.getObject();

  prevPlayerPos.copy(player.position);

  updateMovement(dt);
  clampPitchHard();
  applyGroundClampToPlayer();
  resolveCollisions();

  renderer.render(scene, camera);
}
