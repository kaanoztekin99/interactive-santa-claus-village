import * as THREE from "three";

export function createCampfireController({ scene, controls, range = 6.0 } = {}) {
  const emitters = [];
  let promptEl = null;
  let toggleRequested = false;
  const wp = new THREE.Vector3();

  function makeFireSpriteTexture() {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    // Use the earlier radial gradient stops (tweaked slightly more orange)
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 1.6;
    const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
    grad.addColorStop(0, "rgba(255,230,180,1)");
    grad.addColorStop(0.25, "rgba(255,150,60,0.95)");
    grad.addColorStop(0.6, "rgba(200,80,20,0.6)");
    grad.addColorStop(1, "rgba(0,0,0,0)");

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  function init() {
    try {
      const fireTex = makeFireSpriteTexture();

      // find campfire by name
      const campObj = scene.getObjectByName("campfire");
      if (!campObj) return;

      const box = new THREE.Box3().setFromObject(campObj);
      const worldTopY = box.max.y;
      const worldBase = new THREE.Vector3();
      campObj.getWorldPosition(worldBase);
      const localTopY = worldTopY - worldBase.y;

      const light = new THREE.PointLight(0xffa550, 1.6, 8, 2);
      light.position.set(0, localTopY + 0.25, 0);
      light.castShadow = false;
      light.intensity = 0.0; // start off
      campObj.add(light);

      const sprMat = new THREE.SpriteMaterial({
        map: fireTex,
        color: 0xff8a2b,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.0,
      });
      const sprite = new THREE.Sprite(sprMat);
      sprite.position.set(0, localTopY + 0.15, 0);
      const baseScale = Math.max(0.35, (box.getSize(new THREE.Vector3()).x || 1) * 0.35);
      sprite.scale.set(baseScale, baseScale, 1);
      sprite.visible = false;
      campObj.add(sprite);

      emitters.push({ obj: campObj, light, sprite, baseIntensity: 1.6, baseScale, tOff: Math.random() * 10, isOn: false });

      // prompt element
      try {
        promptEl = document.createElement("div");
        promptEl.id = "campfire-prompt";
        promptEl.style.position = "fixed";
        promptEl.style.bottom = "18%";
        promptEl.style.left = "50%";
        promptEl.style.transform = "translateX(-50%)";
        promptEl.style.padding = "8px 12px";
        promptEl.style.background = "rgba(0,0,0,0.6)";
        promptEl.style.color = "#fff";
        promptEl.style.fontFamily = "sans-serif";
        promptEl.style.fontSize = "14px";
        promptEl.style.borderRadius = "6px";
        promptEl.style.pointerEvents = "none";
        promptEl.style.opacity = "0";
        promptEl.style.transition = "opacity 0.16s ease";
        promptEl.innerText = "Press F to light it up";
        document.body.appendChild(promptEl);
      } catch (e) {}

      // key handler
      window.addEventListener("keydown", onKeyDown);
    } catch (e) {
      console.warn("campfire init failed:", e);
    }
  }

  function onKeyDown(e) {
    if (e.code === "KeyF" && !e.repeat) toggleRequested = true;
  }

  function update(dt) {
    try {
      if (emitters.length === 0) return;

      // find nearest
      let nearest = null;
      let nearestDist = Infinity;
      const playerPos = controls.object.position;

      for (const em of emitters) {
        em.obj.getWorldPosition(wp);
        const d = wp.distanceTo(playerPos);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = em;
        }
      }

      if (!nearest) return;

      const inRange = nearestDist <= range;
      if (promptEl) {
        promptEl.style.opacity = inRange ? "1" : "0";
        promptEl.innerText = nearest.isOn ? "Press F to extinguish the fire" : "Press F to light it up";
      }

      if (toggleRequested && inRange) {
        toggleRequested = false;
        nearest.isOn = !nearest.isOn;
        if (nearest.isOn) {
          nearest.light.intensity = nearest.baseIntensity;
          nearest.sprite.visible = true;
          nearest.sprite.material.opacity = 0.9;
        } else {
          nearest.light.intensity = 0;
          nearest.sprite.material.opacity = 0;
          nearest.sprite.visible = false;
        }
      }

      // animate flicker
      const nowT = performance.now() * 0.001;
      for (const e of emitters) {
        if (!e.isOn) {
          e.light.intensity = 0;
          if (e.sprite) e.sprite.material.opacity = 0;
          continue;
        }

        const f = 0.8 + 0.45 * Math.sin(nowT * 8.0 + e.tOff) + (Math.random() * 0.12 - 0.06);
        e.light.intensity = Math.max(0.06, e.baseIntensity * f);

        const s = e.baseScale * (1.0 + 0.12 * Math.sin(nowT * 12.0 + e.tOff));
        if (e.sprite) {
          e.sprite.scale.set(s, s, 1);
          e.sprite.material.opacity = 0.9 * (0.6 + 0.4 * Math.abs(Math.sin(nowT * 6.0 + e.tOff)));
        }
      }
    } catch (e) {}
  }

  function dispose() {
    try {
      window.removeEventListener("keydown", onKeyDown);
      if (promptEl && promptEl.parentElement) promptEl.parentElement.removeChild(promptEl);
    } catch (e) {}
  }

  init();

  return { update, dispose };
}
