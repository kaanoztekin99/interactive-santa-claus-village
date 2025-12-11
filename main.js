import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

// ---------------------------------------------------------------------
// Core variables
// ---------------------------------------------------------------------
let scene, camera, renderer, controls;
let pmremGenerator;

const HDRI_PATH = './assets/skybox/horn-koppe_snow_4k.exr';

init();
animate();

function init() {
  // Scene
  scene = new THREE.Scene();

  // Camera
  const fov = 60;
  const aspect = window.innerWidth / window.innerHeight;
  const near = 0.1;
  const far = 1000;
  camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  camera.position.set(0, 1.8, 5);

  // Renderer
  const canvas = document.getElementById('webgl-canvas');
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Tone mapping & color space
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // PMREM generator (for env map)
  pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  // OrbitControls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Simple test geometry
  addTestObjects();

  // Load HDRI (background + environment)
  loadHDRI(HDRI_PATH);

  // Resize
  window.addEventListener('resize', onWindowResize);
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
      // EXR is equirectangular
      texture.mapping = THREE.EquirectangularReflectionMapping;

      const envMap = pmremGenerator.fromEquirectangular(texture).texture;

      scene.background = envMap;
      scene.environment = envMap;

      texture.dispose();
      pmremGenerator.dispose();

      console.log('HDRI loaded:', path);
    },
    undefined,
    (error) => {
      console.error('Error loading EXR HDRI:', error);
    }
  );
}

// ---------------------------------------------------------------------
// Test objects: plane + sphere
// ---------------------------------------------------------------------
function addTestObjects() {
  // Ground
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

  // Reflective sphere
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

  // Soft hemisphere light
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

  controls.update();
  renderer.render(scene, camera);
}
