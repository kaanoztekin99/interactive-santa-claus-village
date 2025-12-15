import * as THREE from 'three';
import { FlyControls } from 'three/addons/controls/FlyControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Se il modello e Draco compresso, vedi note in fondo su DRACOLoader.

// ---------------------------------------------------------------------
// Core variables
// ---------------------------------------------------------------------
let scene, camera, renderer, controls;
let pmremGenerator;

const HDRI_PATH = './assets/skybox/horn-koppe_snow_4k.exr';

// >>> metti qui il tuo modello (consigliato .glb)
const MODEL_PATH = './assets/models/sketchfab_model.glb';

const clock = new THREE.Clock();

// “Player” tuning
const EYE_HEIGHT = 1.7;         // altezza camera sopra il terreno
const PLAYER_RADIUS = 0.45;     // raggio collisione semplice
const ZOOM_DOLLY_SPEED = 0.02;  // velocita zoom con rotellina

// World objects
let terrainMesh = null;
const colliders = [];           // mesh statiche “solide”
const colliderBoxes = [];       // bounding box precomputate

// Reuse vectors/objects
const tmpDir = new THREE.Vector3();
const prevPos = new THREE.Vector3();
const downRay = new THREE.Raycaster();
const downOrigin = new THREE.Vector3();

init();
animate();

function init() {
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xcfe9ff, 30, 220);

  // Camera
  camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 3.0, 8);

  // Renderer
  const canvas = document.getElementById('webgl-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // PMREM for env map
  pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  // Controls: free movement + “look while dragging”
  controls = new FlyControls(camera, renderer.domElement);
  controls.movementSpeed = 12;
  controls.rollSpeed = 0;          // evita inclinazione (piu “walking”)
  controls.dragToLook = true;

  // Zoom / dezoom (dolly along view dir)
  renderer.domElement.addEventListener('wheel', onWheelZoom, { passive: false });

  // Lights
  addLights();

  // Terrain + obstacles
  terrainMesh = createTerrain();
  scene.add(terrainMesh);

  createLandmarks(); // ostacoli di test + collisioni

  // HDRI background + environment
  loadHDRI(HDRI_PATH);

  // >>> Carica e piazza un modello Sketchfab in un punto della mappa
  // Scegli tu x,z (metri della tua scena). Y viene calcolata dal terreno.
  loadSketchfabModel({
    path: MODEL_PATH,
    x: 25,
    z: -40,
    scale: 2.0,            // cambia in base al modello
    yawDeg: 135,           // rotazione attorno a Y (gradi)
    yOffset: 0.0,          // se sprofonda o “galleggia”, aggiusta qui
    addToCollisions: true  // collisione bbox (grezza ma funziona)
  });

  // Resize
  window.addEventListener('resize', onWindowResize);
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
// Sketchfab model loader (GLB/glTF via GLTFLoader)
// ---------------------------------------------------------------------
function loadSketchfabModel({
  path,
  x,
  z,
  scale = 1.0,
  yawDeg = 0,
  yOffset = 0,
  addToCollisions = true
}) {
  const loader = new GLTFLoader();

  loader.load(
    path,
    (gltf) => {
      const root = gltf.scene;

      // piazza sul terreno
      const groundY = sampleGroundY(x, z);
      root.position.set(x, groundY + yOffset, z);

      // scala e rotazione
      root.scale.setScalar(scale);
      root.rotation.y = THREE.MathUtils.degToRad(yawDeg);

      // ombre (molti modelli arrivano con castShadow disattivo)
      root.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      scene.add(root);

      // collisioni (bbox unica del modello)
      if (addToCollisions) {
        // importante: aggiorna matrici prima della bbox
        root.updateMatrixWorld(true);
        registerCollider(root);
      }

      console.log('Model loaded:', path);
    },
    undefined,
    (err) => console.error('Error loading model:', path, err)
  );
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
      console.log('HDRI loaded:', path);
    },
    undefined,
    (error) => console.error('Error loading EXR HDRI:', error)
  );
}

// ---------------------------------------------------------------------
// Terrain (procedurale, semplice)
// ---------------------------------------------------------------------
function createTerrain() {
  const size = 260;
  const seg = 220;

  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);

  // heightmap noise
  const pos = geo.attributes.position;
  const amp = 3.5;     // altezza colline
  const freq = 0.045;  // “scala” del rumore

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
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

// value-noise 2D (deterministico, senza librerie)
function noise2D(x, z) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const z1 = z0 + 1;

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
  return s - Math.floor(s); // fract
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------
// Landmarks + collision boxes (ostacoli di test)
// ---------------------------------------------------------------------
function createLandmarks() {
  const houseMat = new THREE.MeshStandardMaterial({ color: 0xffd2a6, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.9 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 1.0 });
  const leavesMat = new THREE.MeshStandardMaterial({ color: 0x2e6b3a, roughness: 1.0 });

  const placeOnGround = (obj, x, z) => {
    const y = sampleGroundY(x, z);
    obj.position.set(x, y, z);
  };

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
    registerCollider(house);
  }

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
    registerCollider(tree);
  }
}

function registerCollider(obj) {
  colliders.push(obj);

  const box = new THREE.Box3().setFromObject(obj);
  box.expandByScalar(PLAYER_RADIUS);
  colliderBoxes.push(box);
}

// ---------------------------------------------------------------------
// “Walking”: camera sempre sul terreno + collisioni
// ---------------------------------------------------------------------
function sampleGroundY(x, z) {
  if (!terrainMesh) return 0;

  downOrigin.set(x, 80, z);
  downRay.set(downOrigin, new THREE.Vector3(0, -1, 0));

  const hits = downRay.intersectObject(terrainMesh, false);
  return hits.length ? hits[0].point.y : 0;
}

function applyGroundClamp() {
  const y = sampleGroundY(camera.position.x, camera.position.z);
  camera.position.y = y + EYE_HEIGHT;
}

function resolveCollisions() {
  for (let i = 0; i < colliderBoxes.length; i++) {
    if (colliderBoxes[i].containsPoint(camera.position)) {
      camera.position.copy(prevPos);
      applyGroundClamp();
      break;
    }
  }
}

// ---------------------------------------------------------------------
// Zoom (dolly)
// ---------------------------------------------------------------------
function onWheelZoom(e) {
  e.preventDefault();

  const dollyAmount = e.deltaY * ZOOM_DOLLY_SPEED * (controls.movementSpeed * 0.1);

  camera.getWorldDirection(tmpDir); // forward
  camera.position.addScaledVector(tmpDir, dollyAmount);
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

  prevPos.copy(camera.position);

  controls.update(dt);

  applyGroundClamp();
  resolveCollisions();

  renderer.render(scene, camera);
}
