// ls/interact: ready-made input code for program() items.
// Nothing here runs unless a program imports it. Each helper listens to the
// pointer and wheel events that reach `canvas` (offsetX, offsetY are board
// points inside the item) and returns { dispose() } plus its own state.
// The item gets these events only when its program calls input("enter") or
// input("direct").

import { Raycaster, Vector2 } from 'three'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// A list of event listeners that dispose() removes.
function listeners(el) {
  const added = []
  return {
    on(type, fn, opts) {
      el.addEventListener(type, fn, opts)
      added.push([type, fn, opts])
    },
    dispose() {
      for (const [type, fn, opts] of added) el.removeEventListener(type, fn, opts)
      added.length = 0
    }
  }
}

// Orbit a camera around a target: drag turns, wheel zooms, shift-drag or
// right-drag pans. Works with a three.js camera (or any object with
// position.set(x, y, z) and lookAt(x, y, z)). Call update() every frame.
export function orbit(camera, o = {}) {
  const el = o.el ?? canvas
  const target = [...(o.target ?? [0, 0, 0])]
  const p = camera.position
  const d0 = [p.x - target[0], p.y - target[1], p.z - target[2]]
  const s = {
    distance: o.distance ?? (Math.hypot(...d0) || 10),
    azimuth: o.azimuth ?? Math.atan2(d0[0], d0[2]),
    polar: o.polar ?? Math.acos(clamp(d0[1] / (Math.hypot(...d0) || 1), -1, 1)),
    target,
    dragging: false
  }
  const min = o.minDistance ?? s.distance * 0.2
  const max = o.maxDistance ?? s.distance * 5
  const minPolar = o.minPolar ?? 0.05
  const maxPolar = o.maxPolar ?? Math.PI - 0.05
  const speed = o.speed ?? 1
  const damping = o.damping ?? 0.12
  const autoRotate = o.autoRotate ?? 0
  let goal = { azimuth: s.azimuth, polar: s.polar, distance: s.distance }
  let last = null
  let mode = 'turn'
  const L = listeners(el)
  L.on('pointerdown', (e) => {
    last = [e.offsetX, e.offsetY]
    mode = e.button === 2 || e.shiftKey ? 'pan' : 'turn'
    s.dragging = true
    el.style.cursor = 'grabbing'
  })
  L.on('pointermove', (e) => {
    if (!last) return
    const dx = e.offsetX - last[0]
    const dy = e.offsetY - last[1]
    last = [e.offsetX, e.offsetY]
    const h = el.clientHeight || 300
    if (mode === 'turn') {
      goal.azimuth -= (2 * Math.PI * dx * speed) / h
      goal.polar = clamp(goal.polar - (2 * Math.PI * dy * speed) / h, minPolar, maxPolar)
    } else {
      // Pan in the camera's screen plane.
      const k = (goal.distance * 1.2) / h
      const a = goal.azimuth
      const right = [Math.cos(a), 0, -Math.sin(a)]
      const up = [-Math.sin(a) * Math.cos(goal.polar), Math.sin(goal.polar), -Math.cos(a) * Math.cos(goal.polar)]
      for (let i = 0; i < 3; i++) s.target[i] += (-dx * right[i] + dy * up[i]) * k
    }
  })
  const end = () => {
    last = null
    s.dragging = false
    el.style.cursor = 'grab'
  }
  L.on('pointerup', end)
  L.on('pointercancel', end)
  L.on('contextmenu', (e) => e.preventDefault())
  if (o.zoom !== false) {
    L.on('wheel', (e) => {
      e.preventDefault()
      goal.distance = clamp(goal.distance * Math.exp(e.deltaY * 0.001 * speed), min, max)
    })
  }
  el.style.cursor = 'grab'
  return Object.assign(s, {
    // Jump (or glide, with glide: true) to new angles or distance.
    set(next, glide = false) {
      goal = { ...goal, ...next }
      if (!glide) Object.assign(s, goal)
    },
    update(dt = 1 / 60) {
      if (autoRotate && !s.dragging) goal.azimuth += autoRotate * dt
      const k = damping > 0 ? 1 - Math.pow(damping, dt * 60 * 0.25) : 1
      s.azimuth += (goal.azimuth - s.azimuth) * k
      s.polar += (goal.polar - s.polar) * k
      s.distance += (goal.distance - s.distance) * k
      const sp = Math.sin(s.polar)
      camera.position.set(
        s.target[0] + s.distance * sp * Math.sin(s.azimuth),
        s.target[1] + s.distance * Math.cos(s.polar),
        s.target[2] + s.distance * sp * Math.cos(s.azimuth)
      )
      camera.lookAt(s.target[0], s.target[1], s.target[2])
    },
    dispose() {
      L.dispose()
      el.style.cursor = ''
    }
  })
}

// 2D pan and zoom: drag pans, wheel zooms at the pointer. Draw with
// view.apply(ctx) (after your own ctx.setTransform), and turn item points
// into world points with view.toWorld(x, y).
export function panZoom(o = {}) {
  const el = o.el ?? canvas
  const min = o.min ?? 0.2
  const max = o.max ?? 20
  const view = { x: o.x ?? 0, y: o.y ?? 0, k: o.k ?? 1, dragging: false }
  let last = null
  const L = listeners(el)
  L.on('pointerdown', (e) => {
    if (o.when && !o.when(e)) return
    last = [e.offsetX, e.offsetY]
    view.dragging = true
  })
  L.on('pointermove', (e) => {
    if (!last) return
    view.x += e.offsetX - last[0]
    view.y += e.offsetY - last[1]
    last = [e.offsetX, e.offsetY]
    o.onChange?.(view)
  })
  const end = () => {
    last = null
    view.dragging = false
  }
  L.on('pointerup', end)
  L.on('pointercancel', end)
  L.on('wheel', (e) => {
    e.preventDefault()
    const k = clamp(view.k * Math.exp(-e.deltaY * 0.002), min, max)
    view.x = e.offsetX - ((e.offsetX - view.x) * k) / view.k
    view.y = e.offsetY - ((e.offsetY - view.y) * k) / view.k
    view.k = k
    o.onChange?.(view)
  })
  return Object.assign(view, {
    apply(ctx) {
      ctx.translate(view.x, view.y)
      ctx.scale(view.k, view.k)
    },
    toWorld(x, y) {
      return [(x - view.x) / view.k, (y - view.y) / view.k]
    },
    reset() {
      Object.assign(view, { x: o.x ?? 0, y: o.y ?? 0, k: o.k ?? 1 })
    },
    dispose: L.dispose
  })
}

// Draggable points: points is an array of {x, y} (in your own coordinates;
// give toWorld to map item points to them, e.g. a panZoom view's toWorld).
// constrain(p, i) may change p.x, p.y (keep a point on a line, a circle, a
// grid). State: hover and active (the index under the pointer / being dragged).
export function draggable(points, o = {}) {
  const el = o.el ?? canvas
  const radius = o.radius ?? 12
  const toWorld = o.toWorld ?? ((x, y) => [x, y])
  const state = { hover: -1, active: -1 }
  let grab = [0, 0]
  const nearest = (x, y) => {
    let best = -1
    let bestD = radius
    points.forEach((p, i) => {
      const [sx, sy] = o.toItem ? o.toItem(p.x, p.y) : [p.x, p.y]
      const d = Math.hypot(sx - x, sy - y)
      if (d <= bestD) {
        best = i
        bestD = d
      }
    })
    return best
  }
  const L = listeners(el)
  L.on('pointerdown', (e) => {
    const i = nearest(e.offsetX, e.offsetY)
    if (i < 0) return
    e.stopImmediatePropagation()
    state.active = i
    const [wx, wy] = toWorld(e.offsetX, e.offsetY)
    grab = [points[i].x - wx, points[i].y - wy]
    o.onStart?.(i, points[i])
  })
  L.on('pointermove', (e) => {
    if (state.active < 0) {
      state.hover = nearest(e.offsetX, e.offsetY)
      el.style.cursor = state.hover >= 0 ? 'grab' : ''
      return
    }
    e.stopImmediatePropagation()
    const p = points[state.active]
    const [wx, wy] = toWorld(e.offsetX, e.offsetY)
    p.x = wx + grab[0]
    p.y = wy + grab[1]
    o.constrain?.(p, state.active)
    el.style.cursor = 'grabbing'
    o.onDrag?.(state.active, p)
  })
  const end = () => {
    if (state.active >= 0) o.onEnd?.(state.active, points[state.active])
    state.active = -1
  }
  L.on('pointerup', end)
  L.on('pointercancel', end)
  return Object.assign(state, { dispose: L.dispose })
}

// A horizontal slider that the program places and draws. slider.draw(ctx)
// draws it in the board colours; or read slider.value, .x, .y, .width,
// .knob (the knob's x) and draw it your own way. onChange(value) runs while
// it is dragged; set slider.value to move it from code.
export function slider(o = {}) {
  const el = o.el ?? canvas
  const s = {
    x: o.x ?? 20,
    y: o.y ?? 20,
    width: o.width ?? 160,
    min: o.min ?? 0,
    max: o.max ?? 1,
    step: o.step ?? 0,
    value: o.value ?? o.min ?? 0,
    label: o.label ?? '',
    active: false,
    hover: false
  }
  const share = () => (s.value - s.min) / (s.max - s.min || 1)
  const hit = (x, y) => x >= s.x - 10 && x <= s.x + s.width + 10 && Math.abs(y - s.y) <= 14
  const setFrom = (x) => {
    let v = s.min + clamp((x - s.x) / s.width, 0, 1) * (s.max - s.min)
    if (s.step) v = Math.round(v / s.step) * s.step
    if (v !== s.value) {
      s.value = v
      o.onChange?.(v)
    }
  }
  const L = listeners(el)
  L.on('pointerdown', (e) => {
    if (!hit(e.offsetX, e.offsetY)) return
    e.stopImmediatePropagation()
    s.active = true
    setFrom(e.offsetX)
  })
  L.on('pointermove', (e) => {
    s.hover = hit(e.offsetX, e.offsetY)
    if (!s.active) return
    e.stopImmediatePropagation()
    setFrom(e.offsetX)
  })
  const end = () => {
    s.active = false
  }
  L.on('pointerup', end)
  L.on('pointercancel', end)
  return Object.assign(s, {
    get knob() {
      return s.x + share() * s.width
    },
    hit,
    draw(ctx, style = {}) {
      const c = { track: colors.border, fill: colors.accent, knob: colors.text, text: colors.muted, ...style }
      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineWidth = 4
      ctx.strokeStyle = c.track
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.x + s.width, s.y)
      ctx.stroke()
      ctx.strokeStyle = c.fill
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(s.knob, s.y)
      ctx.stroke()
      ctx.fillStyle = c.knob
      ctx.beginPath()
      ctx.arc(s.knob, s.y, s.active || s.hover ? 8 : 7, 0, Math.PI * 2)
      ctx.fill()
      if (s.label) {
        ctx.fillStyle = c.text
        ctx.font = '13px system-ui, sans-serif'
        ctx.textBaseline = 'bottom'
        ctx.fillText(s.label, s.x, s.y - 12)
      }
      ctx.restore()
    },
    dispose: L.dispose
  })
}

// Hover and click on your own shapes: hit(x, y) returns the thing under
// item point (x, y), or null. State: hovered (the thing under the pointer).
// o.key(thing) says when two hits are the same thing (default: ===).
export function hover(hit, o = {}) {
  const el = o.el ?? canvas
  const key = o.key ?? ((thing) => thing)
  const state = { hovered: null }
  let down = null
  const L = listeners(el)
  L.on('pointermove', (e) => {
    const thing = hit(e.offsetX, e.offsetY)
    const changed = key(thing) !== key(state.hovered)
    state.hovered = thing
    if (changed) {
      el.style.cursor = thing ? (o.cursor ?? 'pointer') : ''
      o.onHover?.(thing)
    }
  })
  L.on('pointerdown', (e) => {
    down = [e.offsetX, e.offsetY]
  })
  L.on('pointerup', (e) => {
    if (!down || Math.hypot(e.offsetX - down[0], e.offsetY - down[1]) > 4) return
    down = null
    const thing = hit(e.offsetX, e.offsetY)
    if (thing) o.onClick?.(thing, e)
  })
  L.on('pointerleave', () => {
    if (state.hovered) o.onHover?.(null)
    state.hovered = null
  })
  return Object.assign(state, { dispose: L.dispose })
}

// hover() for three.js: the first of `objects` (and their children) under
// the pointer. onHover(hit) and onClick(hit) get three.js intersections
// ({object, point, …}) or null.
export function pick3d(camera, objects, o = {}) {
  const ray = new Raycaster()
  const ndc = new Vector2()
  const el = o.el ?? canvas
  return hover((x, y) => {
    ndc.set((x / (el.clientWidth || 1)) * 2 - 1, -(y / (el.clientHeight || 1)) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    return ray.intersectObjects(typeof objects === 'function' ? objects() : objects, true)[0] ?? null
  }, { key: (hit) => hit?.object ?? null, ...o, el })
}
