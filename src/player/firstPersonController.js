// Encapsulates FPS controls: input handling, zoom/dolly, ground clamping, and collision response.
import * as THREE from "three";
import { resolveCollisions } from "../collision/colliders.js";
import { CAMERA, MOVEMENT, PLAYER, TERRAIN } from "../config/constants.js";

export class FirstPersonController {
  constructor({ controls, camera, domElement, groundSampler }) {
    this.controls = controls;
    this.camera = camera;
    this.domElement = domElement;
    this.groundSampler = groundSampler;
    this.keys = { w: false, a: false, s: false, d: false };
    this.lastGroundY = 0;

    this.prevPlayerPos = new THREE.Vector3();
    this.tmpDir = new THREE.Vector3();

    this.boundKeyDown = (e) => this.onKeyDown(e);
    this.boundKeyUp = (e) => this.onKeyUp(e);
    this.boundWheel = (e) => this.onWheel(e);
    this.boundPointerDown = () => this.controls.lock();
    this.boundContextMenu = (e) => e.preventDefault();

    window.addEventListener("keydown", this.boundKeyDown);
    window.addEventListener("keyup", this.boundKeyUp);
    this.domElement.addEventListener("wheel", this.boundWheel, { passive: false });
    this.domElement.addEventListener("pointerdown", this.boundPointerDown);
    this.domElement.addEventListener("contextmenu", this.boundContextMenu);
  }

  dispose() {
    window.removeEventListener("keydown", this.boundKeyDown);
    window.removeEventListener("keyup", this.boundKeyUp);
    this.domElement.removeEventListener("wheel", this.boundWheel);
    this.domElement.removeEventListener("pointerdown", this.boundPointerDown);
    this.domElement.removeEventListener("contextmenu", this.boundContextMenu);
  }

  spawnAt(x, z) {
    const g = this.groundSampler(x, z, 0);
    this.lastGroundY = g;
    this.controls.getObject().position.set(x, g + PLAYER.EYE_HEIGHT, z);
  }

  update(dt) {
    const player = this.controls.getObject();
    this.prevPlayerPos.copy(player.position);

    this.updateMovement(dt);
    this.clampPitch();
    this.applyGroundClamp(player);

    resolveCollisions(player.position, this.prevPlayerPos, () => this.applyGroundClamp(player));
  }

  updateMovement(dt) {
    if (!this.controls.isLocked) return;

    const forward = (this.keys.w ? 1 : 0) - (this.keys.s ? 1 : 0);
    const right = (this.keys.d ? 1 : 0) - (this.keys.a ? 1 : 0);
    if (forward === 0 && right === 0) return;

    this.tmpDir.set(right, 0, forward).normalize();
    const speed = MOVEMENT.MOVE_SPEED * dt;

    if (this.tmpDir.z !== 0) this.controls.moveForward(this.tmpDir.z * speed);
    if (this.tmpDir.x !== 0) this.controls.moveRight(this.tmpDir.x * speed);
  }

  clampPitch() {
    const pitchObject = this.controls.getObject().children[0];
    if (!pitchObject) return;

    const maxPitch = THREE.MathUtils.degToRad(MOVEMENT.LOOK_MAX_PITCH);
    pitchObject.rotation.x = THREE.MathUtils.clamp(pitchObject.rotation.x, -maxPitch, maxPitch);
  }

  applyGroundClamp(player) {
    player.position.x = THREE.MathUtils.clamp(
      player.position.x,
      -TERRAIN.HALF + 1,
      TERRAIN.HALF - 1
    );
    player.position.z = THREE.MathUtils.clamp(
      player.position.z,
      -TERRAIN.HALF + 1,
      TERRAIN.HALF - 1
    );

    const groundY = this.groundSampler(player.position.x, player.position.z, this.lastGroundY);
    this.lastGroundY = groundY;
    player.position.y = groundY + PLAYER.EYE_HEIGHT;
  }

  onKeyDown(e) {
    if (!this.controls.isLocked) return;
    if (e.code === "KeyW") this.keys.w = true;
    if (e.code === "KeyA") this.keys.a = true;
    if (e.code === "KeyS") this.keys.s = true;
    if (e.code === "KeyD") this.keys.d = true;
  }

  onKeyUp(e) {
    if (e.code === "KeyW") this.keys.w = false;
    if (e.code === "KeyA") this.keys.a = false;
    if (e.code === "KeyS") this.keys.s = false;
    if (e.code === "KeyD") this.keys.d = false;
  }

  onWheel(e) {
    e.preventDefault();

    if (e.shiftKey && this.controls.isLocked) {
      const dolly = e.deltaY * 0.01;
      this.controls.moveForward(dolly);
      return;
    }

    this.camera.fov = THREE.MathUtils.clamp(
      this.camera.fov + e.deltaY * 0.02,
      CAMERA.FOV_MIN,
      CAMERA.FOV_MAX
    );
    this.camera.updateProjectionMatrix();
  }
}
