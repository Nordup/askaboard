// One world with 400 separate meshes, turning, in the film look: the cost of draw calls.
const code = `
world.look = "film"
const g = new THREE.Group()
const ball = new THREE.SphereGeometry(0.11, 16, 12)
const material = world.look.gloss("#5b7fd6")
for (let i = 0; i < 400; i++) {
  const y = 1 - (2 * i + 1) / 400
  const r = Math.sqrt(1 - y * y)
  const a = i * 2.399963
  const m = new THREE.Mesh(ball, material)
  m.position.set(Math.cos(a) * r * 1.6, y * 1.6, Math.sin(a) * r * 1.6)
  g.add(m)
}
world.add(g)
world.frame((t) => { g.rotation.y = t * 0.5 })
`

const w = world(code, { center: [0, 0], size: [420, 420], name: "many film" })
await draw(w, 0.5)
