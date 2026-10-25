/*
 * The live-scene API inside the sandbox (QuickJS). The host sets
 * globalThis.__ctxText (JSON: {nodes, view, font}) before this runs, then runs
 * the agent's program, then drives the clock: it drains the job queue and
 * calls __advance() until it returns false, then reads __result().
 *
 * A program only builds data: objects and a timeline. Nothing here draws.
 *
 * Time: every action starts at the current time T. `await action` resolves
 * when the action ends, and the code after it runs with T at that end.
 * __advance() resolves the waiter with the earliest end first, so parallel
 * async functions each keep their own place in time.
 *
 * Plain JS, no imports: this file is loaded as text (?raw) by live-scene.ts.
 */
'use strict'
;(() => {
  const CTX = JSON.parse(globalThis.__ctxText)
  delete globalThis.__ctxText
  const FONT = CTX.font
  const MAX_COORD = 100000

  let T = 0
  let endTime = 0
  const objects = []
  const actions = []
  const steps = []
  const logs = []
  const warnings = new Set()
  const waiters = []
  let waiterSeq = 0

  // ---------- Checks ----------

  function fail(message) {
    throw new Error(message)
  }
  function num(value, what) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${what} must be a finite number, got ${describe(value)}`)
    return value
  }
  function coord(value, what) {
    num(value, what)
    if (Math.abs(value) > MAX_COORD) fail(`${what} must be within ±${MAX_COORD} board points`)
    return value
  }
  function pair(value, what) {
    if (!Array.isArray(value) || value.length < 2) fail(`${what} must be [x, y], got ${describe(value)}`)
    return [coord(value[0], `${what}[0]`), coord(value[1], `${what}[1]`)]
  }
  function describe(value) {
    try {
      const text = JSON.stringify(value)
      return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}...` : text
    } catch {
      return String(value)
    }
  }
  function options(value, what) {
    if (value === undefined || value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) fail(`${what} must be an options object like {color: "accent"}, got ${describe(value)}`)
    return value
  }

  // ---------- Geometry helpers ----------

  function boundsOfPoints(list) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of list) {
      if (p[0] < x0) x0 = p[0]
      if (p[1] < y0) y0 = p[1]
      if (p[0] > x1) x1 = p[0]
      if (p[1] > y1) y1 = p[1]
    }
    if (x0 === Infinity) return { x: 0, y: 0, width: 0, height: 0 }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }
  function union(list) {
    const pts = []
    for (const b of list) if (b) pts.push([b.x, b.y], [b.x + b.width, b.y + b.height])
    return boundsOfPoints(pts)
  }
  function polyLength(line) {
    let length = 0
    for (let i = 1; i < line.length; i++) length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
    return length
  }
  const f2 = (v) => Math.round(v * 100) / 100

  /** Sample an SVG path "d" into polylines (for bounds and length only; the app draws the real path). */
  function samplePath(d) {
    if (typeof d !== 'string' || !d.trim()) fail('path(d) needs an SVG path string such as "M0 0 L80 0"')
    const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || []
    let i = 0
    const lines = []
    let line = null
    let cx = 0
    let cy = 0
    let sx = 0
    let sy = 0
    let lastCtrl = null
    let lastCmd = ''
    let cmd = ''
    const isCmd = (t) => /^[a-zA-Z]$/.test(t)
    const next = () => {
      const t = tokens[i++]
      if (t === undefined || isCmd(t)) fail(`The path "${d.slice(0, 40)}" has a command with too few numbers`)
      return Number(t)
    }
    const push = (x, y) => {
      if (!line) {
        line = [[cx, cy]]
        lines.push(line)
      }
      line.push([x, y])
    }
    const curve = (pts, n) => {
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const u = 1 - t
        let x
        let y
        if (pts.length === 3) {
          x = u * u * pts[0][0] + 2 * u * t * pts[1][0] + t * t * pts[2][0]
          y = u * u * pts[0][1] + 2 * u * t * pts[1][1] + t * t * pts[2][1]
        } else {
          x = u * u * u * pts[0][0] + 3 * u * u * t * pts[1][0] + 3 * u * t * t * pts[2][0] + t * t * t * pts[3][0]
          y = u * u * u * pts[0][1] + 3 * u * u * t * pts[1][1] + 3 * u * t * t * pts[2][1] + t * t * t * pts[3][1]
        }
        push(x, y)
      }
    }
    while (i < tokens.length) {
      if (isCmd(tokens[i])) cmd = tokens[i++]
      else if (!cmd) fail(`The path "${d.slice(0, 40)}" must start with M`)
      const rel = cmd === cmd.toLowerCase()
      const C = cmd.toUpperCase()
      const ox = rel ? cx : 0
      const oy = rel ? cy : 0
      if (C === 'M') {
        cx = next() + ox
        cy = next() + oy
        sx = cx
        sy = cy
        line = null
        cmd = rel ? 'l' : 'L'
        lastCtrl = null
      } else if (C === 'L') {
        const x = next() + ox
        const y = next() + oy
        push(x, y)
        cx = x
        cy = y
        lastCtrl = null
      } else if (C === 'H') {
        const x = next() + ox
        push(x, cy)
        cx = x
        lastCtrl = null
      } else if (C === 'V') {
        const y = next() + oy
        push(cx, y)
        cy = y
        lastCtrl = null
      } else if (C === 'C' || C === 'S') {
        let c1
        if (C === 'C') c1 = [next() + ox, next() + oy]
        else c1 = lastCtrl && /[CS]/.test(lastCmd.toUpperCase()) ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy]
        const c2 = [next() + ox, next() + oy]
        const end = [next() + ox, next() + oy]
        curve([[cx, cy], c1, c2, end], 16)
        lastCtrl = c2
        cx = end[0]
        cy = end[1]
      } else if (C === 'Q' || C === 'T') {
        let c1
        if (C === 'Q') c1 = [next() + ox, next() + oy]
        else c1 = lastCtrl && /[QT]/.test(lastCmd.toUpperCase()) ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy]
        const end = [next() + ox, next() + oy]
        curve([[cx, cy], c1, end], 12)
        lastCtrl = c1
        cx = end[0]
        cy = end[1]
      } else if (C === 'A') {
        let rx = Math.abs(next())
        let ry = Math.abs(next())
        const phi = (next() * Math.PI) / 180
        const large = next() !== 0
        const sweep = next() !== 0
        const x = next() + ox
        const y = next() + oy
        if (!rx || !ry) push(x, y)
        else {
          // Endpoint to centre parameterization (SVG spec F.6.5).
          const cos = Math.cos(phi)
          const sin = Math.sin(phi)
          const dx = (cx - x) / 2
          const dy = (cy - y) / 2
          const x1 = cos * dx + sin * dy
          const y1 = -sin * dx + cos * dy
          const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
          if (lambda > 1) {
            rx *= Math.sqrt(lambda)
            ry *= Math.sqrt(lambda)
          }
          const sign = large === sweep ? -1 : 1
          const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
          const coef = sign * Math.sqrt(Math.max(0, num2 / (rx * rx * y1 * y1 + ry * ry * x1 * x1)))
          const cxp = (coef * rx * y1) / ry
          const cyp = (-coef * ry * x1) / rx
          const ccx = cos * cxp - sin * cyp + (cx + x) / 2
          const ccy = sin * cxp + cos * cyp + (cy + y) / 2
          const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
          const t1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
          let dt = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
          if (!sweep && dt > 0) dt -= 2 * Math.PI
          if (sweep && dt < 0) dt += 2 * Math.PI
          const n = Math.max(4, Math.ceil(Math.abs(dt) / 0.2))
          for (let k = 1; k <= n; k++) {
            const a = t1 + (dt * k) / n
            push(ccx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, ccy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos)
          }
        }
        cx = x
        cy = y
        lastCtrl = null
      } else if (C === 'Z') {
        push(sx, sy)
        cx = sx
        cy = sy
        line = null
        lastCtrl = null
      } else fail(`The path command "${cmd}" is not an SVG path command`)
      lastCmd = cmd
    }
    if (!lines.length) fail(`The path "${d.slice(0, 40)}" draws nothing`)
    return lines
  }

  /** A path "d" through points (a polyline), closed with Z when asked. */
  function polyD(list, closed) {
    let d = ''
    list.forEach((p, k) => {
      d += `${k ? 'L' : 'M'}${f2(p[0])} ${f2(p[1])} `
    })
    return closed ? `${d}Z` : d.trim()
  }

  /** An ellipse as four cubic arcs, starting at the left (a hand starts circles there). */
  function ellipseD(cx, cy, rx, ry) {
    const k = 0.5522847498
    const p = (x, y) => `${f2(x)} ${f2(y)}`
    return (
      `M${p(cx - rx, cy)} C${p(cx - rx, cy + ry * k)} ${p(cx - rx * k, cy + ry)} ${p(cx, cy + ry)} ` +
      `C${p(cx + rx * k, cy + ry)} ${p(cx + rx, cy + ry * k)} ${p(cx + rx, cy)} ` +
      `C${p(cx + rx, cy - ry * k)} ${p(cx + rx * k, cy - ry)} ${p(cx, cy - ry)} ` +
      `C${p(cx - rx * k, cy - ry)} ${p(cx - rx, cy - ry * k)} ${p(cx - rx, cy)} Z`
    )
  }

  // ---------- Objects ----------

  const STYLE_KEYS = new Set(['color', 'width', 'fill', 'fillOpacity', 'opacity', 'dash', 'pen', 'jitter', 'name', 'hatch', 'tool', 'size', 'at', 'center', 'x', 'y', 't', 'unit', 'samples', 'shape', 'pad', 'head', 'slant', 'closed', 'radius', 'align'])
  const handles = new WeakMap()

  function checkKeys(opts, what) {
    for (const key of Object.keys(opts)) if (!STYLE_KEYS.has(key)) warnings.add(`${what}: the option "${key}" is unknown and was ignored`)
  }

  function colorArg(value, what) {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim()) fail(`${what} must be a colour name or CSS colour string, got ${describe(value)}`)
    return value.trim()
  }

  function styleOf(opts, what, defaults) {
    checkKeys(opts, what)
    const style = {
      color: colorArg(opts.color, `${what} color`) ?? defaults.color ?? 'text',
      width: opts.width === undefined ? (defaults.width ?? 3) : num(opts.width, `${what} width`),
      opacity: opts.opacity === undefined ? 1 : Math.max(0, Math.min(1, num(opts.opacity, `${what} opacity`)))
    }
    if (style.width <= 0) fail(`${what} width must be positive`)
    if (opts.fill !== undefined && opts.fill !== null && opts.fill !== 'none') {
      if (Array.isArray(opts.fill)) {
        if (opts.fill.length < 2 || !opts.fill.every((c) => typeof c === 'string')) fail(`${what} fill as a gradient must be a list of two or more colours`)
        style.gradient = opts.fill.map((c) => c.trim())
      } else style.fill = colorArg(opts.fill, `${what} fill`)
    }
    if (opts.hatch !== undefined) style.hatch = colorArg(opts.hatch, `${what} hatch`)
    if (opts.fillOpacity !== undefined) style.fillOpacity = Math.max(0, Math.min(1, num(opts.fillOpacity, `${what} fillOpacity`)))
    if (opts.dash !== undefined && opts.dash !== false) {
      if (opts.dash === true) style.dash = [style.width * 3, style.width * 2.5]
      else if (Array.isArray(opts.dash) && opts.dash.length >= 2 && opts.dash.every((v) => typeof v === 'number' && v >= 0)) style.dash = opts.dash.slice(0, 8)
      else fail(`${what} dash must be true or a list like [8, 6]`)
    }
    if (opts.jitter !== undefined) style.jitter = Math.max(0, Math.min(1, num(opts.jitter, `${what} jitter`)))
    if (opts.tool !== undefined) {
      if (opts.tool !== 'pen' && opts.tool !== 'highlighter') fail(`${what} tool must be "pen" or "highlighter"`)
      style.tool = opts.tool
    }
    return style
  }

  function nameOf(opts) {
    if (opts.name === undefined) return undefined
    if (typeof opts.name !== 'string') fail('name must be a string')
    return opts.name
  }

  /** Register an object; returns the handle the program sees. */
  function make(entry) {
    entry.id = objects.length
    entry.created = T
    entry.vis = undefined // 'hidden' (revealed later) or 'shown' (visible from its creation)
    entry.removed = false
    entry.revealed = false
    entry.tracks = {}
    if (!entry.pivot) entry.pivot = [entry.bounds.x + entry.bounds.width / 2, entry.bounds.y + entry.bounds.height / 2]
    objects.push(entry)
    const handle = new SceneObject(entry.id)
    handles.set(handle, entry)
    return handle
  }

  function entryOf(value, what) {
    const entry = value && typeof value === 'object' ? handles.get(value) : undefined
    if (!entry) fail(`${what} must be an object made by a scene function (circle(), write(), board.node(), …), got ${describe(value)}`)
    return entry
  }

  class SceneObject {
    constructor(id) {
      Object.defineProperty(this, 'id', { value: id, enumerable: true })
    }
    /** The bounds now (at the current time), with moves and scaling applied. */
    get bounds() {
      return worldBounds(objects[this.id], T)
    }
    get center() {
      const b = this.bounds
      return [b.x + b.width / 2, b.y + b.height / 2]
    }
    get kind() {
      return objects[this.id].kind === 'node' ? objects[this.id].nodeKind : objects[this.id].api
    }
    get name() {
      return objects[this.id].name
    }
    toString() {
      return `[${this.kind} object ${this.id}]`
    }
    toJSON() {
      return { object: this.id, kind: this.kind, bounds: this.bounds }
    }
  }

  // ---------- Tracks (the timeline of one object) ----------

  const EASES = {
    linear: (t) => t,
    in: (t) => t * t * t,
    out: (t) => 1 - Math.pow(1 - t, 3),
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    smooth: (t) => t * t * (3 - 2 * t)
  }

  function base(entry, prop) {
    switch (prop) {
      case 'x':
      case 'y':
      case 'rotate':
        return 0
      case 'scale':
      case 'opacity':
        return 1
      case 'draw':
      case 'fill':
        return entry.vis === 'hidden' ? 0 : 1
      case 'color':
        // An existing board node: the app knows its colour.
        return entry.style ? entry.style.color : undefined
      default:
        return 0
    }
  }

  function valueAt(entry, prop, t) {
    let value = base(entry, prop)
    for (const a of entry.tracks[prop] || []) {
      if (a.start > t) break
      if (t >= a.start + a.dur) value = a.to
      else if (typeof a.to === 'number') value = a.from + (a.to - a.from) * EASES[a.ease]((t - a.start) / a.dur)
      else value = (t - a.start) / a.dur < 0.5 ? a.from : a.to
    }
    return value
  }

  function addTrack(entry, prop, start, dur, to, ease, from) {
    const a = { obj: entry.id, prop, start: f3(start), dur: f3(Math.max(0, dur)), from: from === undefined ? valueAt(entry, prop, start) : from, to, ease: ease || 'inOut' }
    ;(entry.tracks[prop] ||= []).push(a)
    actions.push(a)
    endTime = Math.max(endTime, start + dur)
    return a
  }
  const f3 = (v) => Math.round(v * 1000) / 1000

  /** The world transform of an object at time t: parent ∘ translate(pivot + offset) ∘ rotate ∘ scale ∘ translate(-pivot). */
  function matrixAt(entry, t) {
    const s = valueAt(entry, 'scale', t)
    const r = (valueAt(entry, 'rotate', t) * Math.PI) / 180
    const ox = valueAt(entry, 'x', t)
    const oy = valueAt(entry, 'y', t)
    const [px, py] = entry.pivot
    const a = Math.cos(r) * s
    const b = Math.sin(r) * s
    const own = [a, b, -b, a, px + ox - (a * px - b * py), py + oy - (b * px + a * py)]
    if (entry.parent === undefined) return own
    return multiply(matrixAt(objects[entry.parent], t), own)
  }
  function multiply(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
  }
  function worldBounds(entry, t) {
    if (entry.kind === 'group') return union(entry.members.map((id) => worldBounds(objects[id], t)))
    const m = matrixAt(entry, t)
    const b = entry.bounds
    const corners = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height]
    ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
    const out = boundsOfPoints(corners)
    return { x: f2(out.x), y: f2(out.y), width: f2(out.width), height: f2(out.height) }
  }

  // ---------- Creators ----------

  function inkObject(api, lines, opts, defaults) {
    const style = styleOf(opts, api, defaults)
    const pressure = lines.some((l) => l.some((p) => p.length > 2))
    let total = 0
    for (const l of lines) total += polyLength(l)
    return make({
      kind: 'ink',
      api,
      name: nameOf(opts),
      style: { ...style, jitter: style.jitter ?? defaults.jitter ?? 0.3, tool: style.tool ?? 'pen' },
      lines: lines.map((l) => l.map((p) => (p.length > 2 ? [f2(p[0]), f2(p[1]), Math.max(0, Math.min(1, p[2]))] : [f2(p[0]), f2(p[1])]))),
      pressure,
      length: total,
      speed: defaults.speed ?? 450,
      bounds: boundsOfPoints(lines.flat())
    })
  }

  function shapeObject(api, d, opts, defaults) {
    const lines = samplePath(d)
    let total = 0
    for (const l of lines) total += polyLength(l)
    if (opts.pen) {
      return make({
        kind: 'ink',
        api,
        name: nameOf(opts),
        style: { ...styleOf({ ...opts, pen: undefined }, api, defaults), jitter: opts.jitter === undefined ? 0.3 : Math.max(0, Math.min(1, num(opts.jitter, `${api} jitter`))), tool: opts.tool ?? 'pen' },
        d,
        lines: null,
        pressure: false,
        length: total,
        speed: 450,
        bounds: boundsOfPoints(lines.flat())
      })
    }
    const style = styleOf(opts, api, defaults)
    if (defaults.closed === false && (style.fill || style.gradient || style.hatch)) warnings.add(`${api}: an open curve has no inside to fill; the fill shows along its chord`)
    const pad = style.width / 2
    const b = boundsOfPoints(lines.flat())
    return make({
      kind: 'shape',
      api,
      name: nameOf(opts),
      style,
      d,
      length: total,
      bounds: { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
    })
  }

  function pointList(value, what, min) {
    if (!Array.isArray(value) || value.length < min) fail(`${what} must be a list of at least ${min} [x, y] points`)
    return value.map((p, k) => {
      if (!Array.isArray(p) || p.length < 2) fail(`${what}[${k}] must be [x, y] or [x, y, pressure]`)
      const out = [coord(p[0], `${what}[${k}][0]`), coord(p[1], `${what}[${k}][1]`)]
      if (p.length > 2 && p[2] !== undefined) out.push(num(p[2], `${what}[${k}][2]`))
      return out
    })
  }

  function stroke(pts, opts) {
    opts = options(opts, 'stroke options')
    let lines
    if (Array.isArray(pts) && pts.length && Array.isArray(pts[0]) && Array.isArray(pts[0][0])) lines = pts.map((l, k) => pointList(l, `stroke points[${k}]`, 1))
    else lines = [pointList(pts, 'stroke points', 1)]
    lines = lines.map((l) => (l.length === 1 ? [l[0], [l[0][0] + 0.5, l[0][1] + 0.5]] : l))
    return inkObject('stroke', lines, opts, { jitter: 0, width: 3.5 })
  }

  function line(x1, y1, x2, y2, opts) {
    opts = options(opts, 'line options')
    return shapeObject('line', `M${coord(x1, 'x1')} ${coord(y1, 'y1')} L${coord(x2, 'x2')} ${coord(y2, 'y2')}`, opts, { closed: false })
  }

  function arrow(x1, y1, x2, y2, opts) {
    opts = options(opts, 'arrow options')
    coord(x1, 'x1')
    coord(y1, 'y1')
    coord(x2, 'x2')
    coord(y2, 'y2')
    const length = Math.hypot(x2 - x1, y2 - y1) || 1
    const ux = (x2 - x1) / length
    const uy = (y2 - y1) / length
    const width = opts.width === undefined ? 3 : num(opts.width, 'arrow width')
    const head = opts.head === undefined ? Math.max(10, Math.min(22, length * 0.2, width * 5)) : num(opts.head, 'arrow head')
    const wing = (angle) => {
      const c = Math.cos(angle)
      const s = Math.sin(angle)
      return [x2 - head * (ux * c - uy * s), y2 - head * (uy * c + ux * s)]
    }
    const [ax, ay] = wing(0.45)
    const [bx, by] = wing(-0.45)
    const d = `M${f2(x1)} ${f2(y1)} L${f2(x2)} ${f2(y2)} M${f2(ax)} ${f2(ay)} L${f2(x2)} ${f2(y2)} L${f2(bx)} ${f2(by)}`
    return shapeObject('arrow', d, opts, { closed: false })
  }

  function circle(cx, cy, r, opts) {
    opts = options(opts, 'circle options')
    num(r, 'circle radius')
    if (r <= 0) fail('circle radius must be positive')
    return shapeObject('circle', ellipseD(coord(cx, 'cx'), coord(cy, 'cy'), r, r), opts, {})
  }

  function ellipse(cx, cy, rx, ry, opts) {
    opts = options(opts, 'ellipse options')
    num(rx, 'ellipse rx')
    num(ry, 'ellipse ry')
    if (rx <= 0 || ry <= 0) fail('ellipse radii must be positive')
    return shapeObject('ellipse', ellipseD(coord(cx, 'cx'), coord(cy, 'cy'), rx, ry), opts, {})
  }

  function rect(x, y, w, h, opts) {
    opts = options(opts, 'rect options')
    coord(x, 'x')
    coord(y, 'y')
    num(w, 'rect width')
    num(h, 'rect height')
    const r = Math.max(0, Math.min(opts.radius === undefined ? 0 : num(opts.radius, 'rect radius'), Math.abs(w) / 2, Math.abs(h) / 2))
    let d
    if (r > 0) {
      d =
        `M${f2(x + r)} ${f2(y)} H${f2(x + w - r)} A${r} ${r} 0 0 1 ${f2(x + w)} ${f2(y + r)} V${f2(y + h - r)} A${r} ${r} 0 0 1 ${f2(x + w - r)} ${f2(y + h)} ` +
        `H${f2(x + r)} A${r} ${r} 0 0 1 ${f2(x)} ${f2(y + h - r)} V${f2(y + r)} A${r} ${r} 0 0 1 ${f2(x + r)} ${f2(y)} Z`
    } else d = `M${f2(x)} ${f2(y)} H${f2(x + w)} V${f2(y + h)} H${f2(x)} Z`
    return shapeObject('rect', d, opts, {})
  }

  function polygon(pts, opts) {
    opts = options(opts, 'polygon options')
    const list = pointList(pts, 'polygon points', 2)
    const closed = opts.closed !== false
    return shapeObject('polygon', polyD(list, closed), opts, { closed })
  }

  function path(d, opts) {
    opts = options(opts, 'path options')
    return shapeObject('path', d, opts, { closed: /z\s*$/i.test(String(d)) })
  }

  function plot(fn, opts) {
    if (typeof fn !== 'function') fail('plot(fn, options) needs a function: x => y, or t => [x, y] with options.t')
    opts = options(opts, 'plot options')
    const [ox, oy] = opts.at === undefined ? [0, 0] : pair(opts.at, 'plot at')
    let sx = 50
    let sy = 50
    if (opts.unit !== undefined) {
      if (Array.isArray(opts.unit)) {
        sx = num(opts.unit[0], 'plot unit[0]')
        sy = num(opts.unit[1], 'plot unit[1]')
      } else sx = sy = num(opts.unit, 'plot unit')
    }
    const samples = Math.max(2, Math.floor(opts.samples === undefined ? 240 : num(opts.samples, 'plot samples')))
    const param = opts.t !== undefined
    const [a, b] = param ? pair(opts.t, 'plot t') : opts.x === undefined ? [-4, 4] : pair(opts.x, 'plot x')
    const clip = opts.y === undefined ? null : pair(opts.y, 'plot y')
    const lines = []
    let current = []
    let prev = null
    for (let k = 0; k <= samples; k++) {
      const t = a + ((b - a) * k) / samples
      let x
      let y
      const value = fn(t)
      if (param) {
        if (!Array.isArray(value)) fail('plot with options.t needs fn(t) to return [x, y]')
        x = value[0]
        y = value[1]
      } else {
        x = t
        y = value
      }
      const ok = typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && (!clip || (y >= clip[0] && y <= clip[1]))
      // A jump of more than half the view between samples is a discontinuity (tan x, 1/x).
      const point = ok ? [ox + x * sx, oy - y * sy] : null
      const jump = point && prev && Math.abs(point[1] - prev[1]) > 400 && Math.abs(point[1] - prev[1]) > 40 * Math.abs(point[0] - prev[0])
      if (!point || jump) {
        if (current.length > 1) lines.push(current)
        current = []
      }
      if (point) current.push(point)
      prev = point
    }
    if (current.length > 1) lines.push(current)
    if (!lines.length) fail('plot drew nothing: fn gave no finite values in the range')
    for (const l of lines) for (const p of l) if (Math.abs(p[0]) > MAX_COORD || Math.abs(p[1]) > MAX_COORD) fail('plot goes outside ±100000 board points; use options.y to clip it')
    const d = lines.map((l) => polyD(l, false)).join(' ')
    const { at: _a, unit: _u, samples: _s, t: _t, x: _x, y: _y, ...rest } = opts
    return shapeObject('plot', d, rest, { closed: false })
  }

  // ---------- Handwriting ----------

  const SUPERS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '−', 'ⁿ': 'n', 'ˣ': 'x' }
  const SUBS = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '−', 'ₓ': 'x', 'ᵢ': 'i', 'ₙ': 'n' }

  /** Characters with a level: 0 normal, 1 superscript, -1 subscript. "^2", "^{10}", "_1", "_{ab}" and ²₁ work. */
  function shapeText(text) {
    const out = []
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if ((c === '^' || c === '_') && i + 1 < text.length && text[i + 1] !== ' ') {
        const level = c === '^' ? 1 : -1
        if (text[i + 1] === '{') {
          const close = text.indexOf('}', i + 2)
          const end = close < 0 ? text.length : close
          for (const ch of text.slice(i + 2, end)) out.push([ch, level])
          i = end
        } else {
          out.push([text[i + 1], level])
          i++
        }
        continue
      }
      if (SUPERS[c]) out.push([SUPERS[c], 1])
      else if (SUBS[c]) out.push([SUBS[c], -1])
      else out.push([c, 0])
    }
    return out
  }

  function write(text, opts) {
    if (typeof text !== 'string' && typeof text !== 'number') fail(`write(text, options) needs a string, got ${describe(text)}`)
    text = String(text)
    opts = options(opts, 'write options')
    const size = opts.size === undefined ? 28 : num(opts.size, 'write size')
    if (size <= 0) fail('write size must be positive')
    const slant = opts.slant === undefined ? 0.12 : num(opts.slant, 'write slant')
    const lines = []
    const missing = new Set()
    const rows = text.split('\n')
    const rowWidths = []
    let pen = 0
    rows.forEach((row, r) => {
      pen = 0
      const baseline = r * size * 1.75
      for (const [ch, level] of shapeText(row)) {
        const scale = level ? 0.62 : 1
        const lift = level === 1 ? -0.55 : level === -1 ? 0.3 : 0
        if (ch === ' ') {
          pen += 0.55 * size * scale
          continue
        }
        const glyph = FONT[ch] || FONT[ch.normalize('NFD')[0]]
        if (!glyph) {
          missing.add(ch)
          pen += 0.6 * size * scale
          continue
        }
        // A little variation per letter, like a hand.
        const wob = 1 + (Math.random() - 0.5) * 0.06
        const dy = (Math.random() - 0.5) * 0.04 * size
        for (const flat of glyph.s) {
          const pts = []
          for (let k = 0; k < flat.length; k += 2) {
            const gx = flat[k] * size * scale * wob
            const gy = (flat[k + 1] + lift) * size * scale * wob
            pts.push([pen + gx - gy * slant, baseline + gy + dy])
          }
          if (pts.length === 1) pts.push([pts[0][0] + 0.5, pts[0][1] + 0.5])
          lines.push(pts)
        }
        pen += glyph.a * size * scale * 0.92
      }
      rowWidths.push(pen)
    })
    if (missing.size) warnings.add(`write: no handwriting for ${[...missing].map((c) => JSON.stringify(c)).join(', ')}; use tex() for these`)
    if (!lines.length) fail('write() has nothing to draw')
    const b = boundsOfPoints(lines.flat())
    let dx
    let dy
    if (opts.center !== undefined) {
      const [cx, cy] = pair(opts.center, 'write center')
      dx = cx - (b.x + b.width / 2)
      dy = cy - (b.y + b.height / 2)
    } else {
      const [ax, ay] = opts.at === undefined ? [0, 0] : pair(opts.at, 'write at')
      dx = ax - b.x
      dy = ay - b.y
    }
    const placed = lines.map((l) => l.map(([x, y]) => [x + dx, y + dy]))
    const { at: _a, center: _c, size: _s, slant: _sl, ...rest } = opts
    return inkObject('write', placed, rest, { jitter: 0.25, width: Math.max(1.5, size / 11), speed: size * 11 })
  }

  // ---------- Typeset text ----------

  function texWidth(source, size) {
    const plain = source
      .replace(/\\(frac|dfrac|tfrac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, _f, a, b) => (a.length > b.length ? a : b))
      .replace(/\\(left|right|displaystyle|,|;|!|quad|qquad)/g, ' ')
      .replace(/\\[a-zA-Z]+/g, 'x')
      .replace(/[{}^_]/g, '')
    return Math.max(size * 0.6, plain.length * size * 0.56)
  }

  function textObject(api, text, opts, math) {
    const size = opts.size === undefined ? (math ? 30 : 22) : num(opts.size, `${api} size`)
    if (size <= 0) fail(`${api} size must be positive`)
    const color = colorArg(opts.color, `${api} color`) ?? 'text'
    const tall = math && /\\(d?frac|sum|int|prod|sqrt)/.test(text)
    const width = math ? texWidth(text, size) : Math.max(...text.split('\n').map((row) => row.length)) * size * 0.52
    const height = size * (tall ? 2.4 : 1.4) * (math ? 1 : text.split('\n').length)
    let x
    let y
    if (opts.center !== undefined) {
      const [cx, cy] = pair(opts.center, `${api} center`)
      x = cx - width / 2
      y = cy - height / 2
    } else [x, y] = opts.at === undefined ? [0, 0] : pair(opts.at, `${api} at`)
    checkKeys(opts, api)
    return make({
      kind: 'text',
      api,
      name: nameOf(opts),
      style: { color, size, opacity: opts.opacity === undefined ? 1 : num(opts.opacity, `${api} opacity`), width: 0 },
      text,
      math,
      at: opts.center === undefined ? [x, y] : null,
      center: opts.center === undefined ? null : pair(opts.center, `${api} center`),
      bounds: { x, y, width, height }
    })
  }

  function tex(latex, opts) {
    if (typeof latex !== 'string' || !latex.trim()) fail(`tex(latex, options) needs a LaTeX string such as "V = \\\\frac{4}{3}\\\\pi r^3", got ${describe(latex)}`)
    return textObject('tex', latex, options(opts, 'tex options'), true)
  }

  function text(str, opts) {
    if (typeof str !== 'string' && typeof str !== 'number') fail(`text(str, options) needs a string, got ${describe(str)}`)
    str = String(str)
    return textObject('text', str, options(opts, 'text options'), false)
  }

  // ---------- Marks around things ----------

  function around(target, opts) {
    const entry = entryOf(target, 'around(object)')
    opts = options(opts, 'around options')
    const box = worldBounds(entry, T)
    const shape = opts.shape === undefined ? 'circle' : opts.shape
    const pad = opts.pad === undefined ? 8 + 0.08 * Math.max(box.width, box.height) : num(opts.pad, 'around pad')
    let lines
    if (shape === 'circle') {
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      const rx = box.width / 2 + pad
      const ry = box.height / 2 + pad
      const start = Math.PI * (1.05 + Math.random() * 0.2)
      const sweep = Math.PI * 2 * 1.08
      const pts = []
      for (let k = 0; k <= 96; k++) {
        const t = k / 96
        const angle = start - sweep * t
        const drift = 1 + 0.05 * t + 0.02 * Math.sin(t * Math.PI * 3)
        pts.push([cx + Math.cos(angle) * rx * drift, cy + Math.sin(angle) * ry * drift])
      }
      lines = [pts]
    } else if (shape === 'box') {
      const x0 = box.x - pad
      const y0 = box.y - pad
      const x1 = box.x + box.width + pad
      const y1 = box.y + box.height + pad
      lines = [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
          [x0, y0 - 2]
        ]
      ]
    } else if (shape === 'underline') {
      const y = box.y + box.height + Math.max(4, pad / 2)
      lines = [
        [
          [box.x - 4, y],
          [box.x + box.width / 2, y + 2.5],
          [box.x + box.width + 6, y + 0.5]
        ]
      ]
    } else fail('around shape must be "circle", "box" or "underline"')
    const { shape: _s, pad: _p, ...rest } = opts
    return inkObject('around', lines, rest, { jitter: 0.3, color: 'accent', width: 3.5 })
  }

  // ---------- Groups and board nodes ----------

  function group(...members) {
    if (members.length === 1 && Array.isArray(members[0])) members = members[0]
    if (!members.length) fail('group(...objects) needs at least one object')
    const entries = members.map((m, k) => entryOf(m, `group member ${k}`))
    for (const e of entries) if (e.parent !== undefined) fail(`object ${e.id} is already in a group`)
    const handle = make({ kind: 'group', api: 'group', members: entries.map((e) => e.id), bounds: union(entries.map((e) => worldBounds(e, T))) })
    for (const e of entries) e.parent = handle.id
    return handle
  }

  const nodeCache = new Map()
  const board = Object.freeze({
    node(id) {
      if (typeof id !== 'string') fail(`board.node(id) needs a node id or an ink group id such as "g3", got ${describe(id)}`)
      if (nodeCache.has(id)) return nodeCache.get(id)
      const info = CTX.nodes[id]
      if (!info) fail(`board.node: there is no node or ink group "${id}" on the board. Ink groups are g1, g2, …; get_tree lists the ids.`)
      const handle = make({ kind: 'node', api: 'node', ref: id, nodeKind: info.kind, name: info.name, bounds: info.bounds })
      objects[handle.id].vis = 'shown'
      objects[handle.id].created = 0
      nodeCache.set(id, handle)
      return handle
    },
    get view() {
      return { ...CTX.view }
    }
  })

  // ---------- Actions ----------

  class Action {
    constructor(start, end) {
      Object.defineProperty(this, 'start', { value: f3(start), enumerable: true })
      Object.defineProperty(this, 'end', { value: f3(end), enumerable: true })
    }
    then(resolve) {
      waiters.push({ t: this.end, seq: waiterSeq++, resolve })
    }
  }

  function durationArg(value, what, fallback) {
    let dur = fallback
    let ease
    if (typeof value === 'number') dur = value
    else if (value && typeof value === 'object') {
      if (value.dur !== undefined) dur = num(value.dur, `${what} dur`)
      if (value.ease !== undefined) {
        if (!EASES[value.ease]) fail(`${what} ease must be one of ${Object.keys(EASES).join(', ')}`)
        ease = value.ease
      }
    } else if (value !== undefined) fail(`${what}: the duration must be a number of seconds or {dur, ease}`)
    num(dur, `${what} duration`)
    if (dur < 0) fail(`${what} duration must not be negative`)
    return { dur, ease }
  }

  /** The leaf objects under an entry (itself unless it is a group). */
  function leaves(entry) {
    if (entry.kind !== 'group') return [entry]
    return entry.members.flatMap((id) => leaves(objects[id]))
  }

  function naturalDraw(entry) {
    if (entry.kind === 'group') return leaves(entry).reduce((sum, e) => sum + naturalDraw(e), 0)
    if (entry.kind === 'ink') return Math.max(0.25, entry.length / entry.speed + (entry.lines ? entry.lines.length * 0.05 : 0))
    if (entry.kind === 'shape') return Math.max(0.35, Math.min(3, entry.length / 500))
    if (entry.kind === 'text') return Math.max(0.4, Math.min(2.5, entry.bounds.width / 260))
    if (entry.kind === 'node') return 1
    return 0.6
  }

  function hasFill(entry) {
    return entry.kind === 'shape' && !!(entry.style.fill || entry.style.gradient || entry.style.hatch)
  }

  /** Mark how an object becomes visible: hidden until this reveal, or visible since it was made. */
  function firstVisibility(entry, reveal) {
    if (entry.vis === undefined) entry.vis = reveal ? 'hidden' : 'shown'
  }

  function revealSet(entry, start) {
    // A reveal brings back an object that faded out.
    if (valueAt(entry, 'opacity', start) < 1 && entry.removed) addTrack(entry, 'opacity', start, 0, 1, 'linear')
    entry.removed = false
    entry.revealed = true
  }

  function draw(target, timing) {
    const entry = entryOf(target, 'draw(object)')
    const { dur, ease } = durationArg(timing, 'draw', naturalDraw(entry))
    const start = T
    const list = leaves(entry)
    const total = list.reduce((sum, e) => sum + naturalDraw(e), 0) || 1
    let at = start
    for (const e of list) {
      const share = (dur * naturalDraw(e)) / total
      firstVisibility(e, true)
      revealSet(e, at)
      const from = valueAt(e, 'draw', at)
      addTrack(e, 'draw', at, share, 1, ease || (e.kind === 'ink' ? 'linear' : 'inOut'), from >= 1 ? 0 : from)
      if (e.kind === 'shape' || e.kind === 'text' || e.kind === 'node') {
        if (hasFill(e)) addTrack(e, 'fill', at + share * 0.6, share * 0.4 + 0.25, 1, 'out', valueAt(e, 'fill', at + share * 0.6))
        else addTrack(e, 'fill', at, 0, 1, 'linear')
      }
      at += share
    }
    return new Action(start, start + dur)
  }

  function fillIn(target, timing) {
    const entry = entryOf(target, 'fillIn(object)')
    const { dur, ease } = durationArg(timing, 'fillIn', 0.6)
    for (const e of leaves(entry)) {
      firstVisibility(e, true)
      revealSet(e, T)
      if (valueAt(e, 'draw', T) < 1) addTrack(e, 'draw', T, dur, 1, ease || 'out')
      addTrack(e, 'fill', T, dur, 1, ease || 'out')
    }
    return new Action(T, T + dur)
  }

  function fadeIn(target, timing) {
    const entry = entryOf(target, 'fadeIn(object)')
    const { dur, ease } = durationArg(timing, 'fadeIn', 0.5)
    for (const e of leaves(entry)) {
      firstVisibility(e, true)
      e.removed = false
      e.revealed = true
      addTrack(e, 'draw', T, 0, 1, 'linear', 1)
      addTrack(e, 'fill', T, 0, 1, 'linear', 1)
      addTrack(e, 'opacity', T, dur, 1, ease || 'linear', 0)
    }
    return new Action(T, T + dur)
  }

  function fadeOut(target, timing) {
    const entry = entryOf(target, 'fadeOut(object)')
    const { dur, ease } = durationArg(timing, 'fadeOut', 0.5)
    for (const e of leaves(entry)) {
      firstVisibility(e, false)
      addTrack(e, 'opacity', T, dur, 0, ease || 'linear')
      e.removed = true
    }
    return new Action(T, T + dur)
  }

  function erase(target, timing) {
    const entry = entryOf(target, 'erase(object)')
    const { dur, ease } = durationArg(timing, 'erase', Math.min(1.2, Math.max(0.35, naturalDraw(entry) * 0.4)))
    for (const e of leaves(entry)) {
      firstVisibility(e, false)
      addTrack(e, 'fill', T, dur * 0.5, 0, 'linear')
      addTrack(e, 'draw', T, dur, 0, ease || 'inOut')
      e.removed = true
    }
    return new Action(T, T + dur)
  }

  function move(target, spec, timing) {
    const entry = entryOf(target, 'move(object)')
    spec = options(spec, 'move spec')
    if (timing === undefined && (spec.dur !== undefined || spec.ease !== undefined)) timing = { dur: spec.dur, ease: spec.ease }
    const { dur, ease } = durationArg(timing, 'move', 0.8)
    const x = valueAt(entry, 'x', T)
    const y = valueAt(entry, 'y', T)
    let tx
    let ty
    if (spec.to !== undefined) {
      const [cx, cy] = pair(spec.to, 'move to')
      const b = worldBounds(entry, T)
      tx = x + cx - (b.x + b.width / 2)
      ty = y + cy - (b.y + b.height / 2)
    } else if (spec.by !== undefined) {
      const [dx, dy] = pair(spec.by, 'move by')
      tx = x + dx
      ty = y + dy
    } else fail('move(object, {to: [x, y]} or {by: [dx, dy]}, seconds)')
    addTrack(entry, 'x', T, dur, tx, ease || 'inOut')
    addTrack(entry, 'y', T, dur, ty, ease || 'inOut')
    return new Action(T, T + dur)
  }

  const TWEEN_PROPS = new Set(['x', 'y', 'scale', 'rotate', 'opacity', 'color', 'draw'])

  function tween(target, props, timing) {
    const entry = entryOf(target, 'tween(object)')
    props = options(props, 'tween props')
    if (timing === undefined && (props.dur !== undefined || props.ease !== undefined)) timing = { dur: props.dur, ease: props.ease }
    const { dur, ease } = durationArg(timing, 'tween', 0.8)
    let any = false
    for (const [key, value] of Object.entries(props)) {
      if (key === 'dur' || key === 'ease') continue
      if (!TWEEN_PROPS.has(key)) fail(`tween: "${key}" is not a tweenable property (${[...TWEEN_PROPS].join(', ')})`)
      any = true
      const groupOwn = key === 'x' || key === 'y' || key === 'scale' || key === 'rotate'
      const targets = groupOwn ? [entry] : leaves(entry)
      for (const e of targets) {
        if (key === 'color') addTrack(e, 'color', T, dur, colorArg(value, 'tween color'), ease || 'inOut')
        else {
          num(value, `tween ${key}`)
          if (key === 'scale' && value <= 0) fail('tween scale must be positive')
          let to = value
          if (key === 'opacity' || key === 'draw') to = Math.max(0, Math.min(1, value))
          if (key === 'draw') {
            firstVisibility(e, true)
            revealSet(e, T)
            if (e.kind === 'shape') addTrack(e, 'fill', T, 0, 1, 'linear')
          }
          if (key === 'opacity') firstVisibility(e, false)
          addTrack(e, key, T, dur, to, ease || 'inOut')
        }
      }
    }
    if (!any) fail('tween(object, {x, y, scale, rotate, opacity, color, draw}, seconds) needs at least one property')
    return new Action(T, T + dur)
  }

  function wait(seconds) {
    const s = seconds === undefined ? 0.5 : num(seconds, 'wait seconds')
    if (s < 0) fail('wait seconds must not be negative')
    endTime = Math.max(endTime, T + s)
    return new Action(T, T + s)
  }

  function step(name) {
    if (typeof name !== 'string' || !name.trim()) fail('step(name) needs a name string')
    steps.push({ name: name.trim(), at: f3(T) })
  }

  function all(...list) {
    if (list.length === 1 && Array.isArray(list[0])) list = list[0]
    let end = T
    for (const item of list) {
      if (item instanceof Action) end = Math.max(end, item.end)
      else if (item !== undefined && item !== null) fail(`all(...) takes actions (draw(), move(), wait(), …), got ${describe(item)}`)
    }
    return new Action(T, end)
  }

  // ---------- Console ----------

  const show = (value) => {
    if (typeof value === 'string') return value
    if (value instanceof SceneObject) return value.toString()
    return describe(value)
  }
  const log = (...items) => {
    logs.push(items.map(show).join(' '))
  }
  globalThis.console = Object.freeze({ log, info: log, warn: log, error: log })

  // ---------- Host interface ----------

  globalThis.__advance = () => {
    if (!waiters.length) return false
    let best = 0
    for (let k = 1; k < waiters.length; k++) {
      const w = waiters[k]
      const b = waiters[best]
      if (w.t < b.t || (w.t === b.t && w.seq < b.seq)) best = k
    }
    const [w] = waiters.splice(best, 1)
    T = Math.max(T, w.t)
    endTime = Math.max(endTime, T)
    w.resolve()
    return true
  }

  globalThis.__result = () => {
    for (const e of objects) if (e.vis === undefined) e.vis = 'shown'
    const out = objects.map((e) => {
      const o = { id: e.id, kind: e.kind, api: e.api, created: f3(e.created), vis: e.vis, removed: e.removed, bounds: e.bounds, pivot: e.pivot }
      if (e.name !== undefined) o.name = e.name
      if (e.parent !== undefined) o.parent = e.parent
      if (e.kind === 'ink') Object.assign(o, { style: e.style, lines: e.lines, d: e.d, pressure: e.pressure })
      if (e.kind === 'shape') Object.assign(o, { style: e.style, d: e.d })
      if (e.kind === 'text') Object.assign(o, { style: e.style, text: e.text, math: e.math, at: e.at, center: e.center })
      if (e.kind === 'group') o.members = e.members
      if (e.kind === 'node') o.ref = e.ref
      return o
    })
    return JSON.stringify({ objects: out, actions, steps, duration: f3(endTime), logs, warnings: [...warnings] })
  }

  const api = { stroke, line, arrow, circle, ellipse, rect, polygon, path, plot, write, tex, text, around, group, board, draw, fillIn, fadeIn, fadeOut, erase, move, tween, wait, step, all }
  for (const [key, value] of Object.entries(api)) Object.defineProperty(globalThis, key, { value, enumerable: true, writable: false, configurable: false })
})()
