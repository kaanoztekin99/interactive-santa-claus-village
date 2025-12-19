// Keeps renderer and camera aspect in sync with the browser window size.
export function enableResizeHandling(camera, renderer) {
  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };

  window.addEventListener("resize", onResize);
  return () => window.removeEventListener("resize", onResize);
}
