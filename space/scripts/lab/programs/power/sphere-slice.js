// A sphere sliced in 3D (three.js in a program() item). The scene timeline
// drives the camera (param cam), the height of the cut (param h) and the
// labels (steps), in step with the spoken lines. The sphere's slow turn is the
// program's own motion.
const v = board.view
const c = [v.x + v.width / 2, v.y + v.height / 2]

const src = String.raw`
import * as THREE from 'three'

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
renderer.setPixelRatio(item.dpr)
renderer.setSize(item.w, item.h, false)
renderer.localClippingEnabled = true
on('resize', () => {
  renderer.setPixelRatio(item.dpr)
  renderer.setSize(item.w, item.h, false)
  camera.aspect = item.w / item.h
  camera.updateProjectionMatrix()
})

const world = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(35, item.w / item.h, 0.1, 100)
world.add(new THREE.HemisphereLight(0xffffff, 0x202030, 1.2))
const sun = new THREE.DirectionalLight(0xffffff, 2.2)
sun.position.set(3, 5, 4)
world.add(sun)

const accent = new THREE.Color(colors.accent)
const good = new THREE.Color(colors.good)
const warn = new THREE.Color(colors.warn)

// The sphere below the cut: solid, lit. Above it: a faint ghost.
const cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
const keepAbove = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const ball = new THREE.SphereGeometry(1, 96, 64)
const solid = new THREE.Mesh(ball, new THREE.MeshStandardMaterial({ color: accent, roughness: 0.45, metalness: 0.05, clippingPlanes: [cut], side: THREE.DoubleSide }))
const ghost = new THREE.Mesh(ball, new THREE.MeshStandardMaterial({ color: accent, transparent: true, opacity: 0.12, depthWrite: false, clippingPlanes: [keepAbove] }))
world.add(solid, ghost)

// The cross-section: a lit disk and its rim, at height h.
const disk = new THREE.Mesh(new THREE.CircleGeometry(1, 128), new THREE.MeshStandardMaterial({ color: good, emissive: good, emissiveIntensity: 0.35, roughness: 0.6, side: THREE.DoubleSide }))
disk.rotation.x = -Math.PI / 2
const rimPoints = []
for (let i = 0; i <= 128; i++) rimPoints.push(new THREE.Vector3(Math.cos(i / 128 * Math.PI * 2), 0, Math.sin(i / 128 * Math.PI * 2)))
const rim = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rimPoints), new THREE.LineBasicMaterial({ color: 0xffffff }))
const section = new THREE.Group()
section.add(disk, rim)
world.add(section)

// The radius of the cut and the height h: thin lines.
const radiusLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]), new THREE.LineBasicMaterial({ color: warn }))
const heightLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.05, gapSize: 0.04 }))
const center = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }))
world.add(radiusLine, heightLine, center)

// Text labels: sprites with a canvas texture, redrawn when their text changes.
function label(color) {
  const c = new OffscreenCanvas(512, 128)
  const g = c.getContext('2d')
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
  sprite.scale.set(1.4, 0.35, 1)
  sprite.center.set(0, 0.5)
  let shown = ''
  sprite.text = (text) => {
    if (text === shown) return
    shown = text
    g.clearRect(0, 0, 512, 128)
    g.font = '600 60px system-ui, sans-serif'
    g.fillStyle = color
    g.textBaseline = 'middle'
    g.fillText(text, 6, 64)
    texture.needsUpdate = true
  }
  world.add(sprite)
  return sprite
}
const hLabel = label(colors.text)
const rLabel = label(colors.warn)

// Labels fade in at their steps: the scene sends the step names.
const fade = { h: 0, r: 0 }
const want = () => ({ h: ['slice', 'turn', 'radius', 'sweep'].includes(scene.step) ? 1 : 0, r: ['radius', 'sweep'].includes(scene.step) ? 1 : 0 })

let last = performance.now()
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  const h = params.h
  const r = Math.sqrt(Math.max(0, 1 - h * h))
  cut.constant = h
  keepAbove.constant = -h
  section.position.y = h
  section.scale.set(r, 1, r)
  section.visible = Math.abs(h) < 1
  // The sphere turns slowly on its own; the radius line turns with it.
  const spin = item.t * 0.25
  solid.rotation.y = ghost.rotation.y = spin
  const dir = new THREE.Vector3(Math.cos(spin), 0, -Math.sin(spin))
  radiusLine.geometry.setFromPoints([new THREE.Vector3(0, h, 0), dir.clone().multiplyScalar(r).setY(h)])
  heightLine.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, h, 0)])
  heightLine.computeLineDistances()

  const target = want()
  fade.h += (target.h - fade.h) * Math.min(1, dt * 4)
  fade.r += (target.r - fade.r) * Math.min(1, dt * 4)
  hLabel.text('h = ' + h.toFixed(2))
  hLabel.material.opacity = fade.h
  hLabel.position.set(0.06, h / 2, 0)
  rLabel.text('r = √(1 − h²) = ' + r.toFixed(2))
  rLabel.material.opacity = fade.r
  rLabel.position.copy(dir.clone().multiplyScalar(r * 0.5).setY(h + 0.12))
  radiusLine.visible = fade.r > 0.02

  // The camera: param cam 0 = from the side, 1 = from above.
  const polar = THREE.MathUtils.lerp(1.35, 0.25, params.cam)
  const dist = 4.1
  camera.position.set(dist * Math.sin(polar) * 0.6, dist * Math.cos(polar), dist * Math.sin(polar) * 0.8)
  camera.lookAt(0, 0, 0)

  renderer.render(world, camera)
  report({ h: +h.toFixed(3), r: +r.toFixed(3), step: scene.step })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
`

step('sphere')
const s = program(src, { center: c, size: [560, 400], params: { cam: 0, h: 1 }, name: 'sliced sphere' })
await all(fadeIn(s, 0.8), say('Here is a sphere of radius one.'))

step('slice')
await all(tween(s, { params: { h: 0.45 } }, 2.5), say('Cut it with a flat plane at height h.'))

step('turn')
await all(tween(s, { params: { cam: 1 } }, 2.5), say('Seen from above, the cut is a circle.'))

step('radius')
await say('Its radius is the square root of one minus h squared.')

step('sweep')
await all(tween(s, { params: { h: -0.8, cam: 0.35 } }, 3.5), say('As the plane moves down, the circle grows, then shrinks again.'))
await wait(0.5)
