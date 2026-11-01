export const build = `
const g = new THREE.Group()
g.scale.setScalar(0.7)
const ball = new THREE.SphereGeometry(1, 48, 32)
const stick = new THREE.CylinderGeometry(0.09, 0.09, 1, 24)
const parts = []
function atom(p, r, m) {
  const a = new THREE.Mesh(ball, m)
  a.position.copy(p)
  a.scale.setScalar(r)
  a.userData.grow = new THREE.Vector3(1.07, 1.07, 1.07)
  g.add(a)
  parts.push(a)
}
function bond(a, b, m) {
  const c = new THREE.Mesh(stick, m)
  c.position.copy(a).add(b).multiplyScalar(0.5)
  c.scale.y = a.distanceTo(b)
  c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  c.userData.grow = new THREE.Vector3(1.5, 1, 1.5)
  g.add(c)
  parts.push(c)
}
function molecule(carbon, hydrogen, link) {
  for (let i = 0; i < 6; i++) {
    const t = (i * Math.PI) / 3
    const u = t + Math.PI / 3
    const c = new THREE.Vector3(Math.cos(t) * 1.4, Math.sin(t) * 1.4, 0)
    const n = new THREE.Vector3(Math.cos(u) * 1.4, Math.sin(u) * 1.4, 0)
    const h = new THREE.Vector3(Math.cos(t) * 2.45, Math.sin(t) * 2.45, 0)
    atom(c, 0.42, carbon)
    atom(h, 0.26, hydrogen)
    bond(c, n, link)
    bond(c, h, link)
  }
}
function hull(color) {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide })
  for (const p of parts.slice()) {
    const h = new THREE.Mesh(p.geometry, m)
    h.position.copy(p.position)
    h.quaternion.copy(p.quaternion)
    h.scale.copy(p.scale).multiply(p.userData.grow)
    g.add(h)
  }
}
function studyLights() {
  world.scene.add(new THREE.HemisphereLight("#dfe7ff", "#2a2a33", 1.6))
  const d = new THREE.DirectionalLight("#ffffff", 2)
  d.position.set(3, 5, 6)
  world.scene.add(d)
}
`

export const run = `
world.add(g)
world.frame((t) => { g.rotation.set(1.0, 0, t * 0.5) })
`

export async function show(style) {
  const w = world(build + style + run, { center: [0, 0], size: [420, 420], name: "molecule" })
  await draw(w, 0.5)
  await draw(write("a ring of six carbons", { at: [-470, -230], size: 26 }), 0.6)
  await draw(arrow(-300, -190, -120, -70), 0.4)
}
