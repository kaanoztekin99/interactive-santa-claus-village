import * as THREE from 'three';

export default class Snow {
  constructor(scene, options = {}) {
    this.scene = scene;
    const {
      count = 2000,
      area = { x: 300, y: 120, z: 300 },
      size = 2.0,
      speed = 20,
      texturePath = null,
      wind = new THREE.Vector3(0, 0, 0),
      color = 0xffffff,
    } = options;

    this.count = count;
    this.area = area;
    this.speed = speed;
    this.wind = wind;
    this.enabled = true;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * area.x;
      positions[i * 3 + 1] = Math.random() * area.y;
      positions[i * 3 + 2] = (Math.random() - 0.5) * area.z;
      velocities[i] = 0.2 + Math.random() * 1.0; // fall speed multiplier
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('velocity', new THREE.BufferAttribute(velocities, 1));

    const material = new THREE.PointsMaterial({
      color: color,
      size: size,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    this.geometry = geometry;
    this.material = material;
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;

    // optionally load texture (svg/png) and apply as sprite
    if (texturePath) {
      new THREE.TextureLoader().load(texturePath, (tex) => {
        material.map = tex;
        material.alphaTest = 0.01;
        material.needsUpdate = true;
      });
    }

    scene.add(this.points);
  }

  // Regenerate particle positions to match current area
  _regeneratePositions() {
    const positions = this.geometry.attributes.position.array;
    const velocities = this.geometry.attributes.velocity.array;
    const ax = this.area.x;
    const ay = this.area.y;
    const az = this.area.z;

    for (let i = 0; i < this.count; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * ax;
      positions[i * 3 + 1] = Math.random() * ay;
      positions[i * 3 + 2] = (Math.random() - 0.5) * az;
      velocities[i] = 0.2 + Math.random() * 1.0;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.velocity.needsUpdate = true;
  }

  // Set the world-space area the snow should cover.
  // area: {x,y,z}, center: THREE.Vector3 (world coords), groundY: world y considered "ground"
  setArea(area, center = new THREE.Vector3(0, 0, 0), groundY = 0) {
    this.area = area;
    // position the Points object so particles' local coordinates map to world space
    this.points.position.set(center.x, groundY, center.z);
    this.groundY = groundY;
    this._regeneratePositions();
  }

  update(delta) {
    if (!this.enabled) return;
    const positions = this.geometry.attributes.position.array;
    const velocities = this.geometry.attributes.velocity.array;
    const ax = this.area.x;
    const ay = this.area.y;
    const az = this.area.z;
    const wind = this.wind;
    const groundY = this.groundY != null ? this.groundY : 0;

    for (let i = 0; i < this.count; i++) {
      const idx3 = i * 3;
      // fall
      positions[idx3 + 1] -= velocities[i] * this.speed * delta;
      // horizontal drift
      positions[idx3 + 0] += wind.x * delta * (0.2 + velocities[i] * 0.8);
      positions[idx3 + 2] += wind.z * delta * (0.2 + velocities[i] * 0.8);

      // respawn at top when below ground (world Y < groundY)
      const worldY = positions[idx3 + 1] + this.points.position.y;
      if (worldY < groundY) {
        positions[idx3 + 1] = ay * (0.6 + Math.random() * 0.4);
        positions[idx3 + 0] = (Math.random() - 0.5) * ax;
        positions[idx3 + 2] = (Math.random() - 0.5) * az;
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
  }

  setWind(vec3) {
    this.wind.copy(vec3);
  }

  setEnabled(flag) {
    this.enabled = !!flag;
    this.points.visible = !!flag;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    if (this.points && this.points.parent) this.points.parent.remove(this.points);
  }
}
