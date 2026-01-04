import * as THREE from "three";

export function createFootstepController({ camera, audioUrl, volume = 0.7 } = {}) {
  const listener = new THREE.AudioListener();
  camera.add(listener);

  const sound = new THREE.Audio(listener);
  const loader = new THREE.AudioLoader();
  let loaded = false;

  loader.load(
    audioUrl,
    (buffer) => {
      sound.setBuffer(buffer);
      sound.setLoop(true);
      sound.setVolume(volume);
      loaded = true;
    },
    undefined,
    (err) => {
      console.warn("Footstep audio load failed:", err);
    }
  );

  let moving = false;

  function setMoving(on) {
    if (on === moving) return;
    moving = !!on;
    if (moving) {
      if (loaded && !sound.isPlaying) {
        // tiny randomization to avoid exact repetition
        sound.playbackRate = 0.95 + Math.random() * 0.1;
        try {
          sound.play();
        } catch (e) {}
      }
    } else {
      try {
        if (sound.isPlaying) sound.stop();
      } catch (e) {}
    }
  }

  function update(/* dt */) {
    // nothing required per-frame for now; kept for API symmetry
  }

  function dispose() {
    try {
      if (sound && sound.isPlaying) sound.stop();
      camera.remove(listener);
    } catch (e) {}
  }

  return { setMoving, update, dispose };
}
