// src/environment/snow.js
//
// Simple GPU-friendly snow as a THREE.Points cloud.
//
// Goals of this version:
// - Keep the visual style you already have, but avoid "fillrate murder":
//   * NormalBlending instead of Additive
//   * alphaTest to skip transparent pixels early
// - Allow runtime quality scaling from main.js:
//   * setCount(n)  -> rebuilds buffers
//   * setSize(s)   -> updates sprite size
//   * setUpdateHz(hz) -> throttles CPU position updates (huge win when FPS is busy)
// - Keep API backward compatible with your current constructor + setArea() + update()
//
// Notes:
// - Points are still not physically accurate snow. This is just a cheap "vibe" layer.
// - The expensive part is usually pixel overdraw (big sprites + additive blending + many points).
//   NormalBlending + alphaTest helps a lot.

import * as THREE from "three";

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

      // NEW:
      // updateHz controls how often we actually move particles on CPU.
      // Example: updateHz = 20 means we update positions ~20 times per second,
      // even if your render loop is 60 fps.
      updateHz = 30,

      // If you want to force additive for a specific look, you can,
      // but for performance NormalBlending is a safer default.
      blending = THREE.NormalBlending,
    } = options;

    this.count = Math.max(0, count | 0);
    this.area = area;
    this.speed = speed;
    this.wind = wind.clone();
    this.enabled = true;

    // Where "ground" is in world Y (used for respawn)
    this.groundY = 0;

    // --- Throttling state (CPU update frequency) ---
    this.updateHz = updateHz;
    this._updateEvery = updateHz > 0 ? 1 / updateHz : 0; // seconds
    this._accum = 0;

    // Geometry + material + points
    this.geometry = new THREE.BufferGeometry();

    // We keep material stable and only tweak parameters (size/count changes are handled separately).
    this.material = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,

      // depthWrite false avoids "hard stamping" sprites into depth,
      // and reduces weird popping when you walk through snow.
      depthWrite: false,

      // NormalBlending is usually cheaper than Additive and looks more natural for snow.
      blending,

      sizeAttenuation: true,
    });

    // Create initial buffers
    this._buildBuffers(this.count);

    this.points = new THREE.Points(this.geometry, this.material);

    // Snow is a screen-space vibe layer, not a physical object.
    // We generally don't want it to disappear because the center point is off-screen.
    this.points.frustumCulled = false;

    // Load texture if provided (sprite)
    if (texturePath) {
      new THREE.TextureLoader().load(texturePath, (tex) => {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;

        this.material.map = tex;

        // alphaTest is a big deal: pixels below threshold are discarded early.
        // That reduces overdraw, which is one of the main reasons snow can tank FPS.
        this.material.alphaTest = 0.08;

        this.material.needsUpdate = true;
      });
    }

    scene.add(this.points);
  }

  // ------------------------------------------------------------
  // Internal: create / rebuild the CPU-side particle arrays
  // ------------------------------------------------------------
  _buildBuffers(count) {
    const c = Math.max(0, count | 0);

    const positions = new Float32Array(c * 3);
    const velocities = new Float32Array(c);

    const ax = this.area?.x ?? 300;
    const ay = this.area?.y ?? 120;
    const az = this.area?.z ?? 300;

    for (let i = 0; i < c; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * ax;
      positions[i * 3 + 1] = Math.random() * ay;
      positions[i * 3 + 2] = (Math.random() - 0.5) * az;

      // Each particle gets a personal "fall speed factor"
      velocities[i] = 0.2 + Math.random() * 1.0;
    }

    // Replace attributes on geometry (safe to do at runtime)
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute("velocity", new THREE.BufferAttribute(velocities, 1));

    this.count = c;
  }

  // Regenerate positions using current area without reallocating buffers (same count).
  _regeneratePositionsInPlace() {
    const posAttr = this.geometry.getAttribute("position");
    const velAttr = this.geometry.getAttribute("velocity");
    if (!posAttr || !velAttr) return;

    const positions = posAttr.array;
    const velocities = velAttr.array;

    const ax = this.area?.x ?? 300;
    const ay = this.area?.y ?? 120;
    const az = this.area?.z ?? 300;

    for (let i = 0; i < this.count; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * ax;
      positions[i * 3 + 1] = Math.random() * ay;
      positions[i * 3 + 2] = (Math.random() - 0.5) * az;
      velocities[i] = 0.2 + Math.random() * 1.0;
    }

    posAttr.needsUpdate = true;
    velAttr.needsUpdate = true;
  }

  // ------------------------------------------------------------
  // Public API: runtime tuning (used by main.js)
  // ------------------------------------------------------------

  // Change how many snow particles exist.
  // This reallocates arrays (so don't spam it every frame).
  setCount(newCount) {
    const n = Math.max(0, newCount | 0);
    if (n === this.count) return;
    this._buildBuffers(n);
  }

  // Change sprite size.
  setSize(newSize) {
    const s = Number(newSize);
    if (!Number.isFinite(s)) return;
    this.material.size = s;
  }

  // Change how often we update positions on CPU.
  // Lower values reduce CPU cost when you are GPU-bound.
  setUpdateHz(hz) {
    const h = Number(hz);
    if (!Number.isFinite(h) || h < 0) return;

    this.updateHz = h;
    this._updateEvery = h > 0 ? 1 / h : 0;
    this._accum = 0;
  }

  // Set wind direction/speed
  setWind(vec3) {
    this.wind.copy(vec3);
  }

  // Enable/disable the whole layer (visibility + update)
  setEnabled(flag) {
    this.enabled = !!flag;
    if (this.points) this.points.visible = !!flag;
  }

  // Set coverage volume in world space
  // area: {x,y,z}, center: world coords, groundY: world y treated as respawn threshold
  setArea(area, center = new THREE.Vector3(0, 0, 0), groundY = 0) {
    this.area = area;

    // Move the particle system so local coords map to world coords nicely.
    this.points.position.set(center.x, groundY, center.z);

    this.groundY = groundY;

    // Keep current count but randomize positions inside new box
    this._regeneratePositionsInPlace();
  }

  // ------------------------------------------------------------
  // Update
  // ------------------------------------------------------------
  update(delta) {
    if (!this.enabled) return;
    if (this.count <= 0) return;

    // If updateHz is 0, we basically freeze snow in place (but still visible).
    if (this.updateHz === 0) return;

    // Throttle CPU updates: accumulate time and update only when enough time has passed.
    // This way, if your render loop is overloaded (aurora HDRI, heavy shadows, etc.),
    // you don't make it worse by also updating 2500 particles 60 times per second.
    this._accum += delta;
    if (this._accum < this._updateEvery) return;
    const dt = this._accum;
    this._accum = 0;

    const posAttr = this.geometry.getAttribute("position");
    const velAttr = this.geometry.getAttribute("velocity");
    if (!posAttr || !velAttr) return;

    const positions = posAttr.array;
    const velocities = velAttr.array;

    const ax = this.area?.x ?? 300;
    const ay = this.area?.y ?? 120;
    const az = this.area?.z ?? 300;

    const wind = this.wind;
    const groundY = this.groundY != null ? this.groundY : 0;

    for (let i = 0; i < this.count; i++) {
      const idx3 = i * 3;

      // fall
      positions[idx3 + 1] -= velocities[i] * this.speed * dt;

      // drift
      const drift = (0.2 + velocities[i] * 0.8);
      positions[idx3 + 0] += wind.x * dt * drift;
      positions[idx3 + 2] += wind.z * dt * drift;

      // respawn if below ground
      const worldY = positions[idx3 + 1] + this.points.position.y;
      if (worldY < groundY) {
        positions[idx3 + 1] = ay * (0.6 + Math.random() * 0.4);
        positions[idx3 + 0] = (Math.random() - 0.5) * ax;
        positions[idx3 + 2] = (Math.random() - 0.5) * az;
      }
    }

    posAttr.needsUpdate = true;
  }

  dispose() {
    if (this.geometry) this.geometry.dispose();
    if (this.material) this.material.dispose();
    if (this.points && this.points.parent) this.points.parent.remove(this.points);
  }
}
