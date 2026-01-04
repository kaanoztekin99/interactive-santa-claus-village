import * as THREE from "three";

export function createFenceForBounds(bounds, { postSpacing = 3.0, postHeight = 1.2, postRadius = 0.06, railHeight = 0.6, railThickness = 0.06, material = null, heightSampler = null } = {}) {
  // bounds: { minX, maxX, minZ, maxZ }
  if (!bounds) return null;

  const group = new THREE.Group();
  group.name = "Fence";

  const mat =
    material ?? new THREE.MeshStandardMaterial({ color: 0x8b5a2b, metalness: 0.05, roughness: 0.8 });

  const postGeo = new THREE.CylinderGeometry(postRadius, postRadius, postHeight, 8);
  const railGeo = new THREE.BoxGeometry(1, railThickness, railThickness);

  function addPost(x, z) {
    const groundY = (typeof heightSampler === "function") ? (heightSampler(x, z) ?? 0) : 0;
    const m = new THREE.Mesh(postGeo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.position.set(x, groundY + postHeight * 0.5, z);
    group.add(m);
    return m;
  }

  function addRail(x1, z1, x2, z2, y) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return null;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(len, railThickness, railThickness), mat);
    rail.castShadow = true;
    rail.receiveShadow = true;
    // position at midpoint
    rail.position.set((x1 + x2) * 0.5, y, (z1 + z2) * 0.5);
    // rotate around Y to align the box's X-axis with the edge direction
    const angle = Math.atan2(dz, dx);
    rail.rotation.set(0, angle, 0);
    group.add(rail);
    return rail;
  }

  const corners = [
    { x: bounds.minX, z: bounds.minZ },
    { x: bounds.maxX, z: bounds.minZ },
    { x: bounds.maxX, z: bounds.maxZ },
    { x: bounds.minX, z: bounds.maxZ },
  ];

  // Build posts along edges
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const edgeLen = Math.hypot(dx, dz);
    const count = Math.max(2, Math.ceil(edgeLen / postSpacing) + 1);
    const stepX = dx / (count - 1);
    const stepZ = dz / (count - 1);

    const posts = [];
    for (let j = 0; j < count; j++) {
      const x = a.x + stepX * j;
      const z = a.z + stepZ * j;
      posts.push(addPost(x, z));
    }
    edges.push(posts);
  }

  // Add two rails between posts (lower and upper)
  for (const posts of edges) {
    for (let i = 0; i < posts.length - 1; i++) {
      const pa = posts[i].position;
      const pb = posts[i + 1].position;
      // sample ground heights at endpoints if sampler provided
      const yA = (typeof heightSampler === "function") ? (heightSampler(pa.x, pa.z) ?? 0) : 0;
      const yB = (typeof heightSampler === "function") ? (heightSampler(pb.x, pb.z) ?? 0) : 0;
      const upperY = (yA + yB) * 0.5 + railHeight;
      const lowerY = (yA + yB) * 0.5 + railHeight - 0.35;
      addRail(pa.x, pa.z, pb.x, pb.z, upperY);
      addRail(pa.x, pa.z, pb.x, pb.z, lowerY);
    }
  }

  return group;
}
