export function createMusicController({ audioUrl, volume = 0.12 } = {}) {
  let audioEl = null;
  let started = false;

  function init() {
    try {
      audioEl = new Audio(audioUrl);
      audioEl.loop = true;
      audioEl.volume = volume;
      audioEl.preload = 'auto';
      audioEl.crossOrigin = 'anonymous';
    } catch (e) {
      console.warn('createMusicController init failed', e);
      audioEl = null;
    }
  }

  function start() {
    if (!audioEl) return false;
    if (started) return true;
    // Play via user gesture; callers should call from click handler
    audioEl.play().then(() => {
      started = true;
    }).catch((e) => {
      console.warn('music play failed:', e);
    });
    return true;
  }

  function stop() {
    if (!audioEl) return;
    try {
      audioEl.pause();
      audioEl.currentTime = 0;
      started = false;
    } catch (e) {}
  }

  function setVolume(v) {
    if (!audioEl) return;
    audioEl.volume = v;
  }

  function isPlaying() {
    return started && audioEl && !audioEl.paused;
  }

  function dispose() {
    try {
      stop();
      audioEl = null;
    } catch (e) {}
  }

  init();
  return { start, stop, setVolume, isPlaying, dispose };
}
