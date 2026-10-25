// A small solar system in three.js: a glowing sun as the only light, planets
// on their orbits, a moon, a ring, stars. The orbit control comes from the
// ready-made module ls/interact (double-click the item, drag to turn, wheel to
// zoom, Escape to leave). The scene drives the speed of time and the camera's
// tilt; the step "earth" follows the earth.
const v = board.view
const c = [v.x + v.width / 2, v.y + v.height / 2 + 30]

const src = String.raw`
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { orbit } from 'ls/interact'

input('enter')

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.toneMapping = THREE.ACESFilmicToneMapping
const world = new THREE.Scene()
world.background = new THREE.Color(0x05060a)
const camera = new THREE.PerspectiveCamera(42, item.w / item.h, 0.1, 500)
camera.position.set(0, 14, 30)
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(world, camera))
composer.addPass(new UnrealBloomPass(new THREE.Vector2(item.w, item.h), 0.7, 0.5, 0.85))
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

const view = orbit(camera, { distance: 32, minDistance: 8, maxDistance: 90, damping: 0.1 })

// Stars.
const starGeo = new THREE.BufferGeometry()
const stars = new Float32Array(3000 * 3)
for (let i = 0; i < stars.length; i += 3) {
  const d = 120 + Math.random() * 120
  const u = Math.random() * 2 - 1
  const a = Math.random() * Math.PI * 2
  const s = Math.sqrt(1 - u * u)
  stars.set([d * s * Math.cos(a), d * u, d * s * Math.sin(a)], i)
}
starGeo.setAttribute('position', new THREE.BufferAttribute(stars, 3))
world.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.6, sizeAttenuation: true })))

// The sun: bright, unlit, and the light of the system.
const sun = new THREE.Mesh(new THREE.SphereGeometry(2.2, 64, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd27a).multiplyScalar(2.5) }))
world.add(sun)
world.add(new THREE.PointLight(0xfff1d6, 400, 0, 1.6))
world.add(new THREE.AmbientLight(0x404060, 0.15))

// Planets: [name, radius, orbit, period in years, colour].
const specs = [
  ['mercury', 0.32, 4.2, 0.24, 0xb1a497],
  ['venus', 0.55, 6.0, 0.62, 0xe8c58c],
  ['earth', 0.6, 8.2, 1.0, 0x4f8cff],
  ['mars', 0.42, 10.6, 1.88, 0xd2694a],
  ['jupiter', 1.35, 14.8, 11.9, 0xd9b48f],
  ['saturn', 1.1, 19.5, 29.5, 0xe6d3a3]
]
const planets = specs.map(([name, r, d, period, color]) => {
  const pivot = new THREE.Group()
  const body = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 24), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }))
  body.position.x = d
  pivot.add(body)
  pivot.rotation.y = Math.random() * Math.PI * 2
  world.add(pivot)
  const ringPts = []
  for (let i = 0; i <= 160; i++) ringPts.push(new THREE.Vector3(Math.cos((i / 160) * Math.PI * 2) * d, 0, Math.sin((i / 160) * Math.PI * 2) * d))
  world.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: 0x8890a8, transparent: true, opacity: 0.25 })))
  return { name, body, pivot, period }
})
const earth = planets.find((p) => p.name === 'earth')
const moonPivot = new THREE.Group()
const moon = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 12), new THREE.MeshStandardMaterial({ color: 0xcfcfcf }))
moon.position.x = 1.2
moonPivot.add(moon)
earth.body.add(moonPivot)
const saturn = planets.find((p) => p.name === 'saturn')
const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.5, 96), new THREE.MeshStandardMaterial({ color: 0xcdb98a, side: THREE.DoubleSide, transparent: true, opacity: 0.75 }))
ring.rotation.x = Math.PI / 2.3
saturn.body.add(ring)

let years = 0
let last = performance.now()
const target = new THREE.Vector3()
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  years += dt * params.speed
  for (const p of planets) {
    p.pivot.rotation.y = -(years / p.period) * Math.PI * 2
    p.body.rotation.y += dt * 2
  }
  moonPivot.rotation.y = -(years * 13.4) * Math.PI * 2
  // The scene tilts the view (param tilt) unless the learner is turning it.
  if (!view.dragging && scene.active) view.set({ polar: THREE.MathUtils.lerp(1.45, 0.35, params.tilt) }, true)
  // Step "earth": the camera's target glides to the earth.
  const wantEarth = scene.step === 'earth' || scene.step === 'moon'
  if (wantEarth) earth.body.getWorldPosition(target)
  else target.set(0, 0, 0)
  for (let i = 0; i < 3; i++) view.target[i] += ([target.x, target.y, target.z][i] - view.target[i]) * Math.min(1, dt * 3)
  if (scene.active) view.set({ distance: wantEarth ? 6 : 34 }, true)
  view.update(dt)
  composer.render(dt)
  report({ years: +years.toFixed(2) })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
`

step('system')
const s = program(src, { center: c, size: [680, 420], params: { speed: 0.15, tilt: 0.2 }, name: 'solar system' })
await all(fadeIn(s, 1), say('The sun, and the planets that circle it.'))

step('tilt')
await all(tween(s, { params: { tilt: 0.85 } }, 3), say('From above, the orbits are nearly circles, all in one plane.'))

step('time')
await all(tween(s, { params: { speed: 1.2 } }, 2), say('Speed up time: the inner planets race, the outer ones crawl.'))

step('earth')
await all(tween(s, { params: { speed: 0.25, tilt: 0.4 } }, 2), say('Now follow the earth, with the moon around it.'))
await wait(1.5)
await say('Double-click the system to turn it yourself.')
