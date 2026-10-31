// ls/interact: ready-made input code for a world.
//   import { orbit, draggable, slider, hover } from 'ls/interact'
// Nothing here runs unless a world imports it. Each helper takes `world`, listens
// through world.on, and returns its state plus dispose(). Distances from the
// pointer are board points. Copy any part and change it.
// Make orbit last: a helper that takes a pointer press sets e.taken, and orbit
// leaves that press alone.

import { Plane, Vector3, Mesh, Group, BoxGeometry, SphereGeometry, MeshBasicMaterial } from 'three'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Listeners that dispose() removes.
function listeners(world) {
  const off = []
  return { on: (type, fn) => off.push(world.on(type, fn)), dispose: () => off.splice(0).forEach((end) => end()) }
}

// True when object o is `root` or inside it.
function within(o, root) {
  for (; o; o = o.parent) if (o === root) return true
  return false
}

// Where a world's camera stood, by node: a seek starts a new run of the code, and the learner's view stays.
const views = new Map()

// Orbit the world's camera around a target: drag turns, wheel zooms. Nothing
// depends on time, so a seek or a pause changes nothing. autoRotate is radians
// per second of world time.
export function orbit(world, o = {}) {
  const camera = world.camera
  const target = new Vector3(...(o.target ?? [0, 0, 0]))
  const d = camera.position.clone().sub(target), far = d.length() || 10
  const s = {
    distance: o.distance ?? far,
    azimuth: o.azimuth ?? Math.atan2(d.x, d.z),
    polar: o.polar ?? Math.acos(clamp(d.y / far, -1, 1)),
    target,
    dragging: false,
    ...views.get(world.node)
  }
  const speed = o.speed ?? 1, min = o.minDistance ?? far * 0.2, max = o.maxDistance ?? far * 5
  const spin = o.autoRotate ?? 0
  const update = () => {
    const a = s.azimuth + spin * world.time, sp = Math.sin(s.polar)
    camera.position.set(target.x + s.distance * sp * Math.sin(a), target.y + s.distance * Math.cos(s.polar), target.z + s.distance * sp * Math.cos(a))
    camera.lookAt(target)
    views.set(world.node, { azimuth: s.azimuth, polar: s.polar, distance: s.distance })
  }
  let last = null
  const L = listeners(world)
  L.on('pointerdown', (e) => {
    if (e.taken) return
    last = [e.x, e.y]
    s.dragging = true
    world.cursor('grabbing')
  })
  L.on('pointermove', (e) => {
    if (!last) return
    s.azimuth -= (e.x - last[0]) * 0.008 * speed
    s.polar = clamp(s.polar - (e.y - last[1]) * 0.008 * speed, 0.05, Math.PI - 0.05)
    last = [e.x, e.y]
    update()
  })
  const end = () => {
    last = null
    s.dragging = false
    world.cursor('grab')
  }
  L.on('pointerup', end)
  L.on('pointercancel', end)
  if (o.zoom !== false) {
    L.on('wheel', (e) => {
      s.distance = clamp(s.distance * Math.exp((e.deltaY ?? 0) * 0.001 * speed), min, max)
      update()
    })
  }
  const stop = spin ? world.frame(update) : () => {}
  update()
  world.cursor('grab')
  return Object.assign(s, {
    update,
    dispose() {
      stop()
      L.dispose()
      world.cursor('')
    }
  })
}

// Drag objects with the hand. They slide on o.plane (a THREE.Plane), by default
// the level plane through the point you grab, so they stay on the floor.
// constrain(position, object) may change the position. onDrag(object) runs while it moves.
export function draggable(world, objects, o = {}) {
  const list = [].concat(objects)
  const state = { hover: null, active: null }
  const plane = new Plane(), grab = new Vector3()
  const owner = (hit) => (hit ? list.find((object) => within(hit.object, object)) ?? null : null)
  const L = listeners(world)
  L.on('pointerdown', (e) => {
    const object = owner(e.hit)
    if (!object) return
    e.taken = true
    state.active = object
    if (o.plane) plane.copy(o.plane)
    else plane.set(new Vector3(0, 1, 0), -e.hit.point.y)
    const at = world.toWorld(e.x, e.y, plane) ?? e.hit.point
    grab.copy(object.getWorldPosition(new Vector3())).sub(at)
    world.cursor('grabbing')
    o.onStart?.(object)
  })
  L.on('pointermove', (e) => {
    if (!state.active) {
      state.hover = owner(e.hit)
      world.cursor(state.hover ? 'grab' : '')
      return
    }
    const at = world.toWorld(e.x, e.y, plane)
    if (!at) return
    const object = state.active
    const place = at.add(grab)
    object.parent?.worldToLocal(place)
    object.position.copy(place)
    o.constrain?.(object.position, object)
    o.onDrag?.(object)
  })
  const end = () => {
    if (state.active) o.onEnd?.(state.active)
    state.active = null
    world.cursor('')
  }
  L.on('pointerup', end)
  L.on('pointercancel', end)
  return Object.assign(state, { dispose: L.dispose })
}

// A slider that the world draws with three.js: a thin track and a knob, with no
// box. It hangs on the camera, so it stays put when the camera turns. `at` is
// [x, y] in board points from the world's anchor, and width is in board points.
// onChange(value) runs while it is dragged; set slider.value to move it from code.
export function slider(world, o = {}) {
  const camera = world.camera, [w, h] = world.size
  const min = o.min ?? 0, max = o.max ?? 1, step = o.step ?? 0
  const [ax, ay] = o.at ?? [0, h / 2 - 24]
  const width = o.width ?? 160
  // Board points to world units on a plane in front of the camera.
  const depth = camera.near * 4
  const unit = camera.isPerspectiveCamera ? (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / h : (camera.top - camera.bottom) / h
  const flat = (color) => new MeshBasicMaterial({ color, toneMapped: false, depthTest: false, transparent: true })
  const group = new Group()
  group.position.set(ax * unit, -ay * unit, -depth)
  const bar = (color, y) => {
    const mesh = new Mesh(new BoxGeometry(1, 3 * unit, unit / 4), flat(color))
    mesh.renderOrder = 10 + y
    mesh.position.x = 0
    group.add(mesh)
    return mesh
  }
  const track = bar(o.track ?? world.colors.border ?? '#3a3d45', 0)
  const fill = bar(o.fill ?? world.colors.accent ?? '#7c8cff', 1)
  const knob = new Mesh(new SphereGeometry(7 * unit, 24, 12), flat(o.knob ?? world.colors.text ?? '#e8e8ea'))
  knob.renderOrder = 12
  const reach = new Mesh(new BoxGeometry((width + 28) * unit, 28 * unit, unit / 4), new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
  group.add(knob, reach)
  track.scale.x = width * unit
  camera.add(group)
  world.scene.add(camera)
  const s = { active: false, group, min, max }
  let value = o.value ?? min
  const show = () => {
    const share = (value - min) / (max - min || 1), left = (-width / 2) * unit
    fill.scale.x = Math.max(1e-4, share * width * unit)
    fill.position.x = left + fill.scale.x / 2
    knob.position.x = left + share * width * unit
    world.redraw()
  }
  const fromBoard = (e) => {
    const point = group.getWorldPosition(new Vector3()), facing = camera.getWorldDirection(new Vector3())
    const at = world.toWorld(e.x, e.y, new Plane().setFromNormalAndCoplanarPoint(facing, point))
    if (!at) return
    let v = min + clamp((group.worldToLocal(at).x + (width / 2) * unit) / (width * unit), 0, 1) * (max - min)
    if (step) v = Math.round(v / step) * step
    if (v !== value) {
      value = v
      show()
      o.onChange?.(v)
    }
  }
  const L = listeners(world)
  L.on('pointerdown', (e) => {
    if (!e.hit || !within(e.hit.object, group)) return
    e.taken = true
    s.active = true
    fromBoard(e)
  })
  L.on('pointermove', (e) => {
    if (s.active) fromBoard(e)
  })
  const end = () => {
    s.active = false
  }
  L.on('pointerup', end)
  L.on('pointercancel', end)
  show()
  return Object.defineProperty(Object.assign(s, {
    dispose() {
      L.dispose()
      camera.remove(group)
    }
  }), 'value', { get: () => value, set: (v) => { value = clamp(v, min, max); show() } })
}

// Hover and click on the world's objects. onHover(hit) and onClick(hit) get a
// hit ({ part, object, point, local }) or null. o.objects limits it to some objects.
export function hover(world, o = {}) {
  const state = { hovered: null }
  const list = o.objects ? [].concat(o.objects) : null
  const test = (e) => (e.hit && (!list || list.some((object) => within(e.hit.object, object))) ? e.hit : null)
  const same = (a, b) => (a?.instanceId ?? a?.object ?? null) === (b?.instanceId ?? b?.object ?? null)
  let down = null
  const L = listeners(world)
  L.on('pointermove', (e) => {
    const hit = test(e)
    const changed = !same(hit, state.hovered)
    state.hovered = hit
    if (changed) {
      world.cursor(hit ? (o.cursor ?? 'pointer') : '')
      o.onHover?.(hit)
    }
  })
  L.on('pointerdown', (e) => {
    down = [e.x, e.y]
  })
  L.on('pointerup', (e) => {
    const moved = !down || Math.hypot(e.x - down[0], e.y - down[1]) > 4
    down = null
    const hit = moved ? null : test(e)
    if (hit) o.onClick?.(hit, e)
  })
  L.on('pointerleave', () => {
    if (state.hovered) o.onHover?.(null)
    state.hovered = null
  })
  return Object.assign(state, { dispose: L.dispose })
}
