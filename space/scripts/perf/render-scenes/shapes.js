// One board of what the default look must draw well: a smooth shape, a flat-sided shape, a texture, a glow, glass, instances.
const code = `
const put = (m, x, y) => { m.position.set(x, y, 0); world.add(m); return m; };
const knot = put(new THREE.Mesh(new THREE.TorusKnotGeometry(0.62, 0.2, 160, 24), new THREE.MeshStandardMaterial({ color: "#5b7fd6" })), -2.6, 1.3);
const box = put(new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), new THREE.MeshPhongMaterial({ color: "#d9a05b" })), 0, 1.3);
const canvas = new OffscreenCanvas(128, 128), g = canvas.getContext("2d");
for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { g.fillStyle = (i + j) % 2 ? "#e8e4da" : "#7a5fc0"; g.fillRect(i * 16, j * 16, 16, 16); }
const textured = put(new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 32), new THREE.MeshLambertMaterial({ map: Object.assign(new THREE.CanvasTexture(canvas), { colorSpace: THREE.SRGBColorSpace }) })), 2.6, 1.3);
put(new THREE.Mesh(new THREE.SphereGeometry(0.65, 48, 32), world.look.glow("#ffb56b")), -2.6, -1.3);
const solid = put(new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), world.look.gloss("#d65b7f")), 0, -1.3);
put(new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 32), world.look.glass("#9fd0e8")), 0, -1.3);
const many = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16, 2), world.look.metal("#9aa3b5"), 40);
const m = new THREE.Matrix4();
for (let i = 0; i < 40; i++) { const a = i * 2.399963, r = 0.1 + 0.022 * i; m.setPosition(Math.cos(a) * r, Math.sin(a) * r, 0); many.setMatrixAt(i, m); }
many.position.set(2.6, -1.3, 0);
world.add(many);
const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 65 }, (_, i) => new THREE.Vector3(Math.cos(i * 0.09817) * 4, Math.sin(i * 0.09817) * 2.6, -1))), new THREE.LineBasicMaterial({ color: "#7fd0a0" }));
world.add(ring);
world.camera.position.set(0, 0, 18);
world.camera.lookAt(0, 0, 0);
world.frame((t) => { knot.rotation.set(t * 0.3, t * 0.2, 0); box.rotation.set(0.6 + t * 0.2, 0.7 + t * 0.3, 0); textured.rotation.y = t * 0.4; many.rotation.z = t * 0.2; });
`
const w = world(code, { center: [0, 0], size: [640, 420], name: "shapes" })
await draw(w, 0.3)
await draw(write("every kind of thing", { at: [-330, 250], size: 26 }), 0.4)
