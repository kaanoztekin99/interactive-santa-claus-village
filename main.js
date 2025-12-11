import * as THREE from "npm:three";
import { OrbitControls } from 'https://unpkg.com/three@0.165.0/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from 'https://unpkg.com/three@0.165.0/examples/jsm/loaders/RGBELoader.js';

// ---------------------------------------------------------------------
// Temel değişkenler
// ---------------------------------------------------------------------
let scene, camera, renderer, controls;
let pmremGenerator;

const HDRI_PATH = './assets/skybox/horn-koppe_snow_4k.exr';

init();
animate();

function init() {
  // Sahne
  scene = new THREE.Scene();

  // Kamera
  const fov = 60;
  const aspect = window.innerWidth / window.innerHeight;
  const near = 0.1;
  const far = 1000;
  camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  camera.position.set(0, 1.8, 5); // göz hizasına yakın bir pozisyon

  // Renderer
  const canvas = document.getElementById('webgl-canvas');
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Tonemapping & color space
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // PMREM generator (HDRI -> environment map için)
  pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  // Orbit Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Basit bir test obje (küre) – HDRI yansımalarını görmek için
  addTestObjects();

  // HDRI yükle (background + environment)
  loadHDRI(HDRI_PATH);

  // Resize
  window.addEventListener('resize', onWindowResize);
}

// ---------------------------------------------------------------------
// HDRI Yükleyici
// ---------------------------------------------------------------------
function loadHDRI(path) {
  const loader = new RGBELoader();
  loader.setDataType(THREE.FloatType); // .exr/.hdr için önemli

  loader.load(
    path,
    (texture) => {
      const envMap = pmremGenerator.fromEquirectangular(texture).texture;

      // Sahne arka planı ve environment ışığı
      scene.background = envMap;
      scene.environment = envMap;

      // Artık equirectangular texture'a ihtiyacımız yok
      texture.dispose();
      pmremGenerator.dispose();

      console.log('HDRI loaded:', path);
    },
    (xhr) => {
      // Yüklenme ilerlemesi (isteğe bağlı)
      // console.log((xhr.loaded / xhr.total * 100) + '% loaded');
    },
    (error) => {
      console.error('Error loading HDRI:', error);
    }
  );
}

// ---------------------------------------------------------------------
// Test objeleri: küre + zemin
// ---------------------------------------------------------------------
function addTestObjects() {
  // Zemin (kar dokusu yok ama şimdilik düz beyaz/ gri olsun)
  const planeGeo = new THREE.PlaneGeometry(50, 50);
  const planeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0.0,
  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 0;
  plane.receiveShadow = true;
  scene.add(plane);

  // Küre (environment yansımasını görmek için metalik)
  const sphereGeo = new THREE.SphereGeometry(1, 64, 64);
  const sphereMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    metalness: 1.0,
    roughness: 0.1,
  });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  sphere.position.set(0, 1, 0);
  sphere.castShadow = true;
  scene.add(sphere);

  // Ek olarak hafif ambient / hemi light (HDRI yanında destek için)
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.3);
  hemi.position.set(0, 20, 0);
  scene.add(hemi);
}

// ---------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------
function onWindowResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height);
}

// ---------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);

  // Orbit controls smoothing
  controls.update();

  renderer.render(scene, camera);
}