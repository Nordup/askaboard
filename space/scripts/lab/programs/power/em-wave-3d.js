// An electromagnetic wave in true 3D (three.js with bloom). E (warm) swings in
// the vertical plane, B (blue) in the horizontal plane, both travelling along
// x. The learner double-clicks the item to turn it by dragging (orbit code
// written by hand here, no library) and zooms with the wheel; Escape leaves.
// The scene drives the amplitude and the wave number, and the steps "E" and
// "B" highlight one field at a time.
const v = board.view
const c = [v.x + v.width / 2, v.y + v.height / 2]

const src = String.raw`
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

input('enter')

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(item.dpr)
renderer.setSize(item.w, item.h, false)
const world = new THREE.Scene()
world.background = new THREE.Color(colors.bg)
const camera = new THREE.PerspectiveCamera(40, item.w / item.h, 0.1, 100)

const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(world, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(item.w, item.h), 0.9, 0.5, 0.15)
composer.addPass(bloom)
composer.addPass(new OutputPass())
const fit = () => {
  renderer.setPixelRatio(item.dpr)
  renderer.setSize(item.w, item.h, false)
  composer.setPixelRatio(item.dpr)
  composer.setSize(item.w, item.h)
  camera.aspect = item.w / item.h
  camera.updateProjectionMatrix()
}
on('resize', fit)
fit()

const eColor = new THREE.Color(colors.warn)
const bColor = new THREE.Color(colors.accent)
const L = 8 // the length of the axis shown, x in [-L/2, L/2]

// The axis of travel and a faint grid in the horizontal plane.
const axis = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-L / 2 - 0.3, 0, 0), L + 0.9, new THREE.Color(colors.text), 0.3, 0.14)
world.add(axis)
const grid = new THREE.GridHelper(L, 16, new THREE.Color(colors.border), new THREE.Color(colors.border))
grid.material.transparent = true
grid.material.opacity = 0.35
grid.scale.set(1, 1, 0.4)
world.add(grid)

// A field: a glowing tube along the curve and a row of arrows from the axis to it.
const N = 220
const ARROWS = 33
function field(color, dir) {
  const group = new THREE.Group()
  const curvePoints = Array.from({ length: N }, () => new THREE.Vector3())
  const curve = new THREE.CatmullRomCurve3(curvePoints)
  const material = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.6), transparent: true })
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, N, 0.035, 8), material)
  group.add(tube)
  const arrows = []
  for (let i = 0; i < ARROWS; i++) {
    const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.16, 0.09)
    a.line.material.transparent = a.cone.material.transparent = true
    arrows.push(a)
    group.add(a)
  }
  world.add(group)
  return {
    update(amp, k, phase, glow) {
      for (let i = 0; i < N; i++) {
        const x = -L / 2 + (i / (N - 1)) * L
        const s = amp * Math.sin(k * x - phase)
        curvePoints[i].set(x, dir.y * s, dir.z * s)
      }
      curve.updateArcLengths()
      tube.geometry.dispose()
      tube.geometry = new THREE.TubeGeometry(curve, N, 0.035, 8)
      material.opacity = glow
      for (let i = 0; i < ARROWS; i++) {
        const x = -L / 2 + (i / (ARROWS - 1)) * L
        const s = amp * Math.sin(k * x - phase)
        const a = arrows[i]
        a.position.set(x, 0, 0)
        a.setDirection(s >= 0 ? dir : dir.clone().negate())
        const len = Math.max(0.001, Math.abs(s))
        a.setLength(len, Math.min(0.16, len * 0.5), Math.min(0.09, len * 0.3))
        a.line.material.opacity = a.cone.material.opacity = glow * 0.85
      }
    }
  }
}
const E = field(eColor, new THREE.Vector3(0, 1, 0))
const B = field(bColor, new THREE.Vector3(0, 0, 1))

// Labels that face the camera.
function label(text, color) {
  const c = new OffscreenCanvas(256, 128)
  const g = c.getContext('2d')
  g.font = 'italic 600 96px Georgia, serif'
  g.fillStyle = color
  g.textBaseline = 'middle'
  g.fillText(text, 20, 64)
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
  sprite.scale.set(0.8, 0.4, 1)
  world.add(sprite)
  return sprite
}
const eLabel = label('E', colors.warn)
const bLabel = label('B', colors.accent)
const cLabel = label('c', colors.text)
cLabel.position.set(L / 2 + 0.9, 0.25, 0)

// Orbit by hand: drag turns the view, the wheel zooms. Angles glide to their goal.
const view = { az: -0.55, el: 0.32, dist: 10.5 }
const goal = { ...view }
let drag = null
on('pointerdown', (e) => {
  drag = { x: e.offsetX, y: e.offsetY }
  canvas.style.cursor = 'grabbing'
})
on('pointermove', (e) => {
  if (!drag) return
  goal.az -= ((e.offsetX - drag.x) / item.w) * Math.PI * 1.5
  goal.el = Math.max(-1.2, Math.min(1.35, goal.el + ((e.offsetY - drag.y) / item.h) * Math.PI))
  drag = { x: e.offsetX, y: e.offsetY }
})
const release = () => {
  drag = null
  canvas.style.cursor = 'grab'
}
on('pointerup', release)
on('pointercancel', release)
on('wheel', (e) => {
  goal.dist = Math.max(5, Math.min(22, goal.dist * Math.exp(e.deltaY * 0.0015)))
})
on('enter', () => (canvas.style.cursor = 'grab'))
on('leave', () => (canvas.style.cursor = ''))

const glow = { e: 1, b: 1 }
let last = performance.now()
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  for (const key of ['az', 'el', 'dist']) view[key] += (goal[key] - view[key]) * Math.min(1, dt * 8)
  camera.position.set(view.dist * Math.cos(view.el) * Math.sin(view.az), view.dist * Math.sin(view.el), view.dist * Math.cos(view.el) * Math.cos(view.az))
  camera.lookAt(0, 0, 0)

  // The scene's steps pick which field shines.
  const want = scene.step === 'E' ? { e: 1, b: 0.12 } : scene.step === 'B' ? { e: 0.12, b: 1 } : { e: 1, b: 1 }
  glow.e += (want.e - glow.e) * Math.min(1, dt * 3)
  glow.b += (want.b - glow.b) * Math.min(1, dt * 3)

  // The wave travels on its own clock; the scene sets its shape.
  const phase = item.t * params.omega
  E.update(params.amp, params.k, phase, glow.e)
  B.update(params.amp, params.k, phase, glow.b)
  eLabel.position.set(-L / 2 + 0.6, params.amp + 0.45, 0)
  bLabel.position.set(-L / 2 + 0.6, 0.15, params.amp + 0.45)
  eLabel.material.opacity = glow.e
  bLabel.material.opacity = glow.b

  composer.render(dt)
  report({ view: { az: +view.az.toFixed(2), el: +view.el.toFixed(2), dist: +view.dist.toFixed(2) } })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
`

step('wave')
const w = program(src, { center: c, size: [640, 400], params: { amp: 0.2, k: 1.6, omega: 2.4 }, name: 'em wave 3d' })
await all(fadeIn(w, 0.8), tween(w, { params: { amp: 1.3 } }, 2), say('An electromagnetic wave, travelling along x at the speed of light.'))

step('E')
await say('The electric field E swings up and down, in the vertical plane.')

step('B')
await say('The magnetic field B swings sideways, at right angles to E.')

step('both')
await all(tween(w, { params: { k: 2.6 } }, 3), say('They rise and fall together. A larger wave number packs the crests closer.'))
await say('Double-click the wave to turn it and look from any side.')
