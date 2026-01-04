import * as THREE from "three";

export function createSledgeController({
  scene,
  controls,
  range = 6.0,
  slideDuration = 6.0,
  slideSpeed = 28.0,
  heightOffset = 3.0,
  groundSampler = null,
  minAboveGround = 1.7,
  // climbing behavior
  climbTolerance = 0.03, // tiny bumps ignored
  maxClimbForSlow = 0.18, // up to this height, we allow climbing with slowdown
  climbSlowScale = 6.0, // scales slowdown against climb height
  backslideThreshold = 0.5, // above this, slide backwards instead
  backslideFactor = 0.5, // fraction of step to move backward on steep
  // safety for odd-model pivots
  maxBaseOffset = 3.0,
} = {}) {
  const sleds = [];
  let promptEl = null;
  let mountRequested = false;
  let mounted = false;
  let mountTimer = 0;
  let currentSled = null;
  const wp = new THREE.Vector3();

  function onKeyDown(e) {
    if (e.code !== "KeyF" || e.repeat) return;

    // set request flag now; we'll check the actual distance in update()
    mountRequested = true;
  }

  function findSleds() {
    // collect top-level instances that are tagged as sledges
    const foundRoots = new Set();

    // First pass: look for explicit tag on placed instances
    scene.traverse((o) => {
      try {
        if (o.userData && o.userData.isSledge) {
          // climb to top-level instance (child of scene)
          let root = o;
          while (root.parent && root.parent !== scene) root = root.parent;
          foundRoots.add(root);
        }
      } catch (e) {}
    });

    // Second pass: if none found, fallback to matching names or sourcePath
    if (foundRoots.size === 0) {
      scene.traverse((o) => {
        try {
          const sp = (o.userData && o.userData.sourcePath) || "";
          const name = o.name || "";
          if (/sledge|sled/i.test(sp) || /sledge|sled/i.test(name)) {
            let root = o;
            while (root.parent && root.parent !== scene) root = root.parent;
            foundRoots.add(root);
          }
        } catch (e) {}
      });
    }

    for (const root of foundRoots) {
      try {
        const box = new THREE.Box3().setFromObject(root);
        if (box.isEmpty()) continue;
        // avoid duplicates
        if (!sleds.find((s) => s.obj === root)) {
          // compute base offset (distance from ground) if possible
          let baseOffset = 0;
          try {
            const wp2 = new THREE.Vector3();
            root.getWorldPosition(wp2);
            if (typeof groundSampler === "function") {
              const gy = groundSampler(wp2.x, wp2.z);
              if (gy != null) baseOffset = wp2.y - gy;
              else baseOffset = wp2.y;
            } else baseOffset = wp2.y;
          } catch (e) { baseOffset = 0; }

          // clamp unreasonable base offsets caused by odd pivots
          if (typeof maxBaseOffset === "number" && isFinite(maxBaseOffset)) {
            if (baseOffset > maxBaseOffset) {
              console.warn("sledge baseOffset too large, clamping:", root.name, baseOffset, "->", maxBaseOffset);
              baseOffset = maxBaseOffset;
            }
            if (baseOffset < -Math.abs(maxBaseOffset)) {
              console.warn("sledge baseOffset too small, clamping:", root.name, baseOffset, "->", -Math.abs(maxBaseOffset));
              baseOffset = -Math.abs(maxBaseOffset);
            }
          }

          sleds.push({ obj: root, box, isSliding: false, baseOffset });
        }
      } catch (e) {}
    }
  }

  function initPrompt() {
    try {
      promptEl = document.createElement("div");
      promptEl.id = "sledge-prompt";
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
      promptEl.innerText = "Press F to mount";
      document.body.appendChild(promptEl);
    } catch (e) {}
  }

  function init() {
    try {
      findSleds();
      initPrompt();
      window.addEventListener("keydown", onKeyDown);
    } catch (e) {
      console.warn("sledge init failed:", e);
    }
  }

  function update(dt) {
    try {
      // if we haven't discovered sleds yet, try to find them (models may load after init)
      if (sleds.length === 0) findSleds();
      if (sleds.length === 0) return;

      // find nearest
      let nearest = null;
      let nearestDist = Infinity;
      const playerPos = controls.object.position;

      for (const s of sleds) {
        s.obj.getWorldPosition(wp);
        const d = wp.distanceTo(playerPos);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = s;
        }
      }

      if (!nearest) return;

      const inRange = nearestDist <= range;
      if (promptEl) {
        promptEl.style.opacity = inRange && !mounted ? "1" : "0";
        promptEl.innerText = mounted ? "Press F to dismount" : "Press F to mount";
      }

      if (mountRequested && inRange && !mounted) {
        mountRequested = false;
        mounted = true;
        currentSled = nearest.obj;
        mountTimer = 0;
        nearest.isSliding = true;
        // Do NOT request pointer lock programmatically (browser requires a user gesture).
        // Instead rely on the app's existing click-to-lock behavior.
      } else if (mountRequested && !inRange) {
        // clear the request if player is not in range right now
        mountRequested = false;
      }

      if (mounted && currentSled) {
        mountTimer += dt;

        // slide the sledge forward in XZ while preventing climbing
        try {
          // find sled entry
          const sledEntry = sleds.find((x) => x.obj === currentSled) || { baseOffset: 0 };

          // current world position
          const curWorld = new THREE.Vector3();
          currentSled.getWorldPosition(curWorld);

          // compute downhill direction from ground gradient
          const eps = 0.5;
          let dx = 0, dz = 0;
          try {
            const hx1 = (typeof groundSampler === "function") ? groundSampler(curWorld.x + eps, curWorld.z) : null;
            const hx2 = (typeof groundSampler === "function") ? groundSampler(curWorld.x - eps, curWorld.z) : null;
            const hz1 = (typeof groundSampler === "function") ? groundSampler(curWorld.x, curWorld.z + eps) : null;
            const hz2 = (typeof groundSampler === "function") ? groundSampler(curWorld.x, curWorld.z - eps) : null;
            if (hx1 != null && hx2 != null) dx = (hx1 - hx2) / (2 * eps);
            if (hz1 != null && hz2 != null) dz = (hz1 - hz2) / (2 * eps);
          } catch (e) { dx = dz = 0; }

          // downhill vector is negative gradient
          const downVec = new THREE.Vector3(-dx, 0, -dz);
          const slopeMag = Math.sqrt(dx * dx + dz * dz);

          const minSlopeToMove = 0.01;
          let moveX = curWorld.x;
          let moveZ = curWorld.z;

          if (downVec.lengthSq() < 1e-8 || slopeMag < minSlopeToMove) {
            // no downhill — stop sliding (crest)
            const sledEntry = sleds.find((x) => x.obj === currentSled);
            if (sledEntry) sledEntry.isSliding = false;
          } else {
            downVec.normalize();
            // scale step by slope: steeper => faster
            const slopeFactor = 1.0 + slopeMag * 4.0;
            const step = slideSpeed * dt * slopeFactor;

            moveX = curWorld.x + downVec.x * step;
            moveZ = curWorld.z + downVec.z * step;
          }

          // get final ground at target
          let finalGround = null;
          try { if (typeof groundSampler === "function") finalGround = groundSampler(moveX, moveZ); } catch (e) { finalGround = null; }

          // compute world target position (use baseOffset if available)
          const baseOff = sledEntry.baseOffset ?? 0;
          const targetY = (finalGround != null) ? finalGround + baseOff : curWorld.y;
          const targetWorld = new THREE.Vector3(moveX, targetY, moveZ);

          // apply the computed target position directly (no pre-check collision)
          try {
            if (currentSled.parent) {
              const local = targetWorld.clone();
              currentSled.parent.worldToLocal(local);
              currentSled.position.copy(local);
            } else {
              currentSled.position.copy(targetWorld);
            }
          } catch (e) {}
        } catch (e) {}

        // place camera above the sled but ensure it stays above ground level
        currentSled.getWorldPosition(wp);
        const worldX = wp.x;
        const worldZ = wp.z;
        const sledTopY = wp.y + heightOffset;

        let groundY = null;
        try {
          if (typeof groundSampler === "function") groundY = groundSampler(worldX, worldZ);
        } catch (e) {
          groundY = null;
        }

        const minY = (groundY != null ? groundY + minAboveGround : -Infinity);
        const camY = Math.max(sledTopY, minY);
        controls.object.position.set(worldX, camY, worldZ);
        // allow free look: do not override controls.object.rotation

        if (mountTimer >= slideDuration) {
          // stop sliding and dismount
          mounted = false;
          if (currentSled) {
            const s = sleds.find((x) => x.obj === currentSled);
            if (s) s.isSliding = false;
          }
          currentSled = null;
          mountTimer = 0;
          // don't programmatically re-lock pointer; user must click to enable mouse look
        }
      }

      // consume dismount request (press F while mounted)
      if (mountRequested && mounted) {
        mountRequested = false;
        mounted = false;
        if (currentSled) {
          const s = sleds.find((x) => x.obj === currentSled);
          if (s) s.isSliding = false;
        }
        currentSled = null;
        mountTimer = 0;
        // avoid automatic pointer-lock requests here
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
