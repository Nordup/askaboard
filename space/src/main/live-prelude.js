/*
 * The live-scene API inside the sandbox (QuickJS). This file runs once per
 * stage (main/live-scene.ts): one QuickJS context that every scene program of a
 * board runs in, so objects, values and `stage` live on between programs.
 * The host sets globalThis.__fontText and __measure before this runs. It
 * keeps the four host functions this file defines (__begin, __advance,
 * __result, __bake) from right after it ran, and calls those, never a global
 * of the moment. For each program it calls __begin(ctxText) (JSON: {nodes,
 * names, view, viewport, seed, stage, cutAt}), runs the program, drives the
 * clock (drains the job queue and calls __advance() until it returns false),
 * reads __result() and calls __bake(), which turns the end of this scene into
 * the start of the next one.
 *
 * A program only builds data: objects and a timeline. Nothing here draws.
 * Each scene has its own time, from 0. Objects of earlier scenes are on the
 * board already; a scene that acts on one, or changes a value its recipe
 * reads, sends it again ("carried", with its base state), and the board
 * reuses its items.
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
  // This file's own code uses the built-ins as they are now, whatever a program does to the globals.
  const G = globalThis
  const { Object, Array, Function, String, Number, Boolean, Symbol, Math, JSON, Reflect, Promise, Map, Set, WeakMap, WeakSet, Date, RegExp, Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, Int8Array, Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int16Array, Int32Array, isFinite, isNaN, parseFloat, parseInt } = G
  const hostMeasure = typeof G.__measure === 'function' ? G.__measure : null
  const FONT = JSON.parse(G.__fontText)
  delete G.__fontText
  // Lab switch LS_LAB_NO_CODE (main/lab-switch.ts): no shader(), canvas() or program(), and no word of them.
  const NO_CODE_ITEMS = G.__noCodeItems === true
  delete G.__noCodeItems
  // Lab switch LS_LAB_NO_HTML: no html(), and no word of HTML material in messages. H(text, without) picks the words.
  const NO_HTML = G.__noHtml === true
  delete G.__noHtml
  const H = (text, without = '') => (NO_HTML ? without : text)
  let CTX = { nodes: {}, names: {}, view: { x: -600, y: -400, width: 1200, height: 800 }, viewport: [1200, 800], seed: 1 }
  const MAX_COORD = 100000

  let T = 0
  let endTime = 0
  /** The scene number in this stage (1 for the first program). */
  let sceneNo = 0
  /** While an action runs: the tracks it adds (so say(…, {during}) can stretch them). */
  let collector = null
  /** Every object of the stage, by stage id (its index). */
  const objects = []
  const actions = []
  const steps = []
  const logs = []
  const warnings = new Set()
  const waiters = []
  let waiterSeq = 0
  const cameraActions = []
  const pointerActions = []
  const cues = []
  /** Times where something animates (value tweens, moves, camera): changing objects are sampled there. */
  const activeSpans = []
  const SAMPLE_FPS = 30

  // ---------- Randomness: seeded, so a run repeats exactly ----------

  function mulberry32(seed) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  let programRandom = mulberry32(1)
  Math.random = () => programRandom()
  /** The hand's wobble in write() and around(): reseeded per object, so a changing object keeps its handwriting. */
  let rng = mulberry32(7)
  let nextSeed = 1000

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

  /**
   * Register an object; returns the handle the program sees. While a changing
   * object is evaluated again (building > 0), it returns the bare entry instead.
   */
  let building = 0
  function make(entry) {
    if (building > 0) return entry
    return register(entry)
  }
  function register(entry) {
    entry.id = objects.length
    entry.born = sceneNo
    entry.created = T
    entry.vis = undefined // 'hidden' (revealed later) or 'shown' (visible from its creation)
    entry.removed = false
    entry.revealed = false
    entry.tracks = {}
    if (!entry.pivot) entry.pivot = [entry.bounds.x + entry.bounds.width / 2, entry.bounds.y + entry.bounds.height / 2]
    objects.push(entry)
    const handle = new SceneObject(entry.id)
    handles.set(handle, entry)
    entry.handle = handle
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
    /** Live items: their parameters now. */
    get params() {
      const entry = objects[this.id]
      return entry.kind === 'live' ? { ...specAt(entry, T).params } : undefined
    }
    get name() {
      return objects[this.id].name
    }
    /** html objects: their parts (the root's children), each an object of its own. */
    get parts() {
      const entry = objects[this.id]
      return entry.kind === 'html' ? entry.parts.map((_, k) => partOf(entry, k)) : undefined
    }
    part(key) {
      const entry = objects[this.id]
      if (entry.kind !== 'html') fail(`part(): ${entry.api} ${this.id} has no parts; only ${H('html(), ')}image() and copies of material have`)
      return partOf(entry, key)
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
    if (entry.base && entry.base[prop] !== undefined) return entry.base[prop]
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
      // A cut track holds its value at the cut.
      const tt = a.until !== undefined ? Math.min(t, a.until) : t
      if (tt >= a.start + a.dur) value = a.to
      else if (typeof a.to === 'number') value = a.from + (a.to - a.from) * EASES[a.ease]((tt - a.start) / a.dur)
      else value = (tt - a.start) / a.dur < 0.5 ? a.from : a.to
    }
    return value
  }

  function addTrack(entry, prop, start, dur, to, ease, from) {
    const a = { obj: entry.id, prop, start: f3(start), dur: f3(Math.max(0, dur)), from: from === undefined ? valueAt(entry, prop, start) : from, to, ease: ease || 'inOut' }
    ;(entry.tracks[prop] ||= []).push(a)
    actions.push(a)
    if (collector) collector.push({ kind: 'track', a, entry })
    endTime = Math.max(endTime, start + dur)
    if (prop === 'x' || prop === 'y' || prop === 'scale' || prop === 'rotate') activeSpans.push([a.start, a.start + a.dur])
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
    const b = specAt(entry, t).bounds
    const corners = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height]
    ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
    const out = boundsOfPoints(corners)
    return { x: f2(out.x), y: f2(out.y), width: f2(out.width), height: f2(out.height) }
  }

  // ---------- Values ----------

  const values = []
  /** Counts value reads, so a creator whose function reads a value is known to change. */
  let reads = 0

  class SceneValue {
    constructor(id) {
      Object.defineProperty(this, 'id', { value: id, enumerable: true })
    }
    /** The value now: at the current time while the program runs, at the sample time while a changing object is drawn. */
    get() {
      reads++
      const v = values[this.id]
      return trackValue(v.tracks, v.base, T)
    }
    /** Jump to a new value at the current time. */
    set(n) {
      num(n, 'value.set(n)')
      addValueTrack(values[this.id], T, 0, n, 'linear')
      return this
    }
    valueOf() {
      return this.get()
    }
    toString() {
      return String(this.get())
    }
    toJSON() {
      return this.get()
    }
  }

  function trackValue(list, base, t) {
    let value = base
    for (const a of list) {
      if (a.start > t) break
      const tt = a.until !== undefined ? Math.min(t, a.until) : t
      if (tt >= a.start + a.dur) value = a.to
      else value = a.from + (a.to - a.from) * EASES[a.ease]((tt - a.start) / a.dur)
    }
    return value
  }

  function addValueTrack(v, start, dur, to, ease) {
    const from = trackValue(v.tracks, v.base, start)
    const a = { start: f3(start), dur: f3(Math.max(0, dur)), from, to, ease }
    v.tracks.push(a)
    v.tracks.sort((p, q) => p.start - q.start)
    if (collector) collector.push({ kind: 'value', a, v })
    endTime = Math.max(endTime, start + dur)
    activeSpans.push([f3(start), f3(start + dur)])
  }

  function value(initial) {
    if (initial === undefined) initial = 0
    num(initial, 'value(n)')
    values.push({ base: initial, tracks: [] })
    return new SceneValue(values.length - 1)
  }

  // ---------- Changing objects (functions and values as arguments) ----------

  function plain(v) {
    return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
  }

  function isDynamicArg(v, depth) {
    if (typeof v === 'function' || v instanceof SceneValue) return true
    if (depth <= 0) return false
    if (Array.isArray(v)) {
      for (const x of v) if (isDynamicArg(x, depth - 1)) return true
      return false
    }
    if (plain(v)) {
      for (const key of Object.keys(v)) if (isDynamicArg(v[key], depth - 1)) return true
    }
    return false
  }

  function resolveArg(v, depth) {
    if (typeof v === 'function') return resolveArg(v(), depth)
    if (v instanceof SceneValue) return v.get()
    if (depth <= 0) return v
    if (Array.isArray(v)) return isDynamicArg(v, depth) ? v.map((x) => resolveArg(x, depth - 1)) : v
    if (plain(v) && isDynamicArg(v, depth)) {
      const out = {}
      for (const key of Object.keys(v)) out[key] = resolveArg(v[key], depth - 1)
      return out
    }
    return v
  }

  /** Build an object's entry from its recipe now (at T), without registering it. */
  function evaluate(recipe) {
    building++
    rng = mulberry32(recipe.seed)
    try {
      let args = recipe.args.map((x, i) => (recipe.skip.includes(i) ? x : resolveArg(x, 5)))
      if (recipe.overrides) {
        args = args.slice()
        while (args.length <= recipe.optIndex) args.push(undefined)
        const opts = { ...(plain(args[recipe.optIndex]) ? args[recipe.optIndex] : {}) }
        for (const [key, v] of Object.entries(recipe.overrides)) {
          if (key.startsWith('params.')) opts.params = { ...(opts.params || {}), [key.slice(7)]: v.get() }
          else opts[key] = v.get()
        }
        args[recipe.optIndex] = opts
      }
      return recipe.impl(...args)
    } finally {
      building--
    }
  }

  const sampleErrors = new Set()
  /** The entry of a changing object at time t (its own entry when it does not change). */
  function specAt(entry, t) {
    if (!entry.dynamic || entry.evaluating) return entry
    const saved = T
    T = t
    entry.evaluating = true
    try {
      return evaluate(entry.recipe)
    } catch (error) {
      if (!sampleErrors.has(entry.id)) {
        sampleErrors.add(entry.id)
        warnings.add(`object ${entry.id} (${entry.api}${entry.name ? ` "${entry.name}"` : ''}): its functions failed at ${f2(t)} s: ${error && error.message ? error.message : String(error)}; it keeps its last good shape there`)
      }
      return entry.lastGood || entry
    } finally {
      T = saved
      entry.evaluating = false
    }
  }

  /**
   * Wrap a creator: functions and values in its arguments are evaluated now,
   * and again over time when the program ends (the object then changes as
   * they change). `skip`: argument indexes passed as they are (plot's function).
   */
  function creator(api, impl, { optIndex, skip = [], always = false } = {}) {
    return (...args) => {
      const dynamic = always || args.some((a, i) => !skip.includes(i) && isDynamicArg(a, 5))
      const recipe = { impl, args, seed: nextSeed++, optIndex, skip, overrides: null }
      const before = reads
      const entry = evaluate(recipe)
      const handle = register(entry)
      entry.recipe = recipe
      entry.dynamic = dynamic || reads !== before
      return handle
    }
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
      // The ink as drawn: its points plus half the pen's width on every side.
      bounds: padBox(boundsOfPoints(lines.flat()), style.width / 2)
    })
  }
  function padBox(b, pad) {
    return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
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
        const wob = 1 + (rng() - 0.5) * 0.06
        const dy = (rng() - 0.5) * 0.04 * size
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
    const entry = inkObject('write', placed, rest, { jitter: 0.25, width: Math.max(1.5, size / 11), speed: size * 11 })
    if (building > 0) entry.text = text
    return entry
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

  const textSizes = new Map()
  /** [width, height] of a tex()/text() node as the board lays it out, or null (the host cannot measure). */
  function measureText(math, text, size) {
    const key = `${math ? 'm' : 't'}|${size}|${text}`
    if (textSizes.has(key)) return textSizes.get(key)
    let size2 = null
    if (hostMeasure) {
      try {
        const got = JSON.parse(hostMeasure(JSON.stringify({ kind: 'text', items: [{ math, text, size }] })))
        const s = got && Array.isArray(got.sizes) ? got.sizes[0] : null
        if (Array.isArray(s) && s[0] > 0) size2 = [s[0], s[1]]
      } catch {
        size2 = null
      }
    }
    textSizes.set(key, size2)
    return size2
  }

  function textObject(api, text, opts, math) {
    const size = opts.size === undefined ? (math ? 30 : 22) : num(opts.size, `${api} size`)
    if (size <= 0) fail(`${api} size must be positive`)
    const color = colorArg(opts.color, `${api} color`) ?? 'text'
    // The size the board lays the node out at, measured by the app (an estimate only when it cannot measure).
    const measured = measureText(math, text, size)
    const tall = math && /\\(d?frac|sum|int|prod|sqrt)/.test(text)
    const width = measured ? measured[0] : math ? texWidth(text, size) : Math.max(...text.split('\n').map((row) => row.length)) * size * 0.52
    const height = measured ? measured[1] : size * (tall ? 2.4 : 1.4) * (math ? 1 : text.split('\n').length)
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
      const start = Math.PI * (1.05 + rng() * 0.2)
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
    let opts = {}
    if (members.length && plain(members[members.length - 1])) opts = members.pop()
    if (members.length === 1 && Array.isArray(members[0])) members = members[0]
    if (!members.length) fail('group(...objects) needs at least one object')
    const entries = members.map((m, k) => entryOf(m, `group member ${k}`))
    for (const e of entries) if (e.kind === 'part') fail(`object ${e.id} is a part of ${H('an html object', 'material')}; it moves with that object`)
    for (const e of entries) if (e.parent !== undefined) fail(`object ${e.id} is already in a group`)
    for (const key of Object.keys(opts)) if (key !== 'name') warnings.add(`group: the option "${key}" is unknown and was ignored`)
    const handle = register({ kind: 'group', api: 'group', name: nameOf(opts), members: entries.map((e) => e.id), bounds: union(entries.map((e) => worldBounds(e, T))) })
    for (const e of entries) e.parent = handle.id
    return handle
  }

  /** Board item id (node id or ink group id) → stage object id, from the renderer's record of the stage. */
  function stageItemOwner(id) {
    const items = (CTX.stage && CTX.stage.items) || {}
    for (const [sid, ids] of Object.entries(items)) if (ids.includes(id)) return Number(sid)
    return undefined
  }
  function handleOf(entry) {
    return entry.handle
  }
  const board = Object.freeze({
    node(id) {
      if (typeof id !== 'string') fail(`board.node(id) needs a node id or an ink group id such as "g3", got ${describe(id)}`)
      // An item made by a scene of this stage, by its id or its name: the stage's own object (its recipe, values and names still work).
      const owner = stageItemOwner(id)
      if (owner !== undefined && objects[owner] && !objects[owner].gone) return handleOf(objects[owner])
      for (let i = objects.length - 1; i >= 0; i--) {
        const e = objects[i]
        if (e.name === id && e.kind !== 'node' && !e.gone && !e.dropped) return handleOf(e)
      }
      // A name from an earlier scene (or a named node) finds its item; ids come first.
      const byName = CTX.nodes[id] ? undefined : CTX.names && CTX.names[id]
      const ref = byName || id
      const info = CTX.nodes[ref]
      if (!info) fail(`board.node: there is no node, ink group or named item "${id}" on the board. Ink groups are g1, g2, …; get_tree lists the ids.`)
      const known = objects.find((e) => e.kind === 'node' && e.ref === ref && !e.gone)
      if (known) return handleOf(known)
      const handle = register({ kind: 'node', api: 'node', ref, nodeKind: info.kind, name: info.name, bounds: info.bounds })
      objects[handle.id].vis = 'shown'
      objects[handle.id].created = 0
      return handle
    },
    /** The learner's view now (after this scene's camera moves so far). */
    get view() {
      return viewAt(T)
    }
  })

  // ---------- Traces ----------

  /** Times a trace samples its point at, from t0 up to now: frames where something animates, and both ends. */
  function traceTimes(t0, now) {
    const out = new Set([f3(t0), f3(now)])
    const dt = 1 / SAMPLE_FPS
    for (const [s0, s1] of activeSpans) {
      const a = Math.max(s0, t0)
      const b = Math.min(s1, now)
      if (b < a) continue
      for (let t = a; t < b; t += dt) out.add(f3(t))
      out.add(f3(b))
    }
    return [...out].filter((t) => t >= t0 - 1e-9 && t <= now + 1e-9).sort((p, q) => p - q)
  }
  /** While the end samples are taken, a trace's earlier points no longer change: keep them. */
  let finalSampling = false
  const traceCache = new WeakMap()

  /** The path a moving point leaves: fn() → [x, y] at every moment from the trace's start until now. */
  function trace(fn, t0, opts) {
    if (typeof fn !== 'function') fail('trace(fn, options) needs a function that returns the point now, like () => [x.get(), y.get()]')
    opts = options(opts, 'trace options')
    const now = T
    let cache = finalSampling ? traceCache.get(fn) : null
    if (finalSampling && !cache) traceCache.set(fn, (cache = new Map()))
    const pts = []
    try {
      for (const tau of traceTimes(t0, now)) {
        let p = cache && cache.get(tau)
        if (!p) {
          T = tau
          p = pair(resolveArg(fn(), 2), 'trace point')
          if (cache) cache.set(tau, p)
        }
        pts.push(p)
      }
    } finally {
      T = now
    }
    if (pts.length < 2) pts.push([pts[0][0] + 0.01, pts[0][1]])
    return shapeObject('trace', polyD(pts, false), opts, { closed: false })
  }

  // ---------- Live pixels ----------

  /** The line of the agent's program that called the API now (the innermost scene.js frame), or undefined. */
  function callLine() {
    const match = /scene\.js:(\d+)/.exec(new Error().stack || '')
    return match ? Number(match[1]) : undefined
  }

  function liveObject(api, mode, code, opts) {
    if (typeof code !== 'string' || !code.trim()) fail(`${api}(code, options) needs its program as a string`)
    const line = callLine()
    opts = options(opts, `${api} options`)
    const [w, h] = opts.size === undefined ? [320, 200] : pair(opts.size, `${api} size`)
    if (w <= 0 || h <= 0) fail(`${api} size must be positive`)
    let x
    let y
    if (opts.center !== undefined) {
      const [cx, cy] = pair(opts.center, `${api} center`)
      x = cx - w / 2
      y = cy - h / 2
    } else [x, y] = opts.at === undefined ? [-w / 2, -h / 2] : pair(opts.at, `${api} at`)
    const params = {}
    if (opts.params !== undefined) {
      if (!plain(opts.params)) fail(`${api} params must be an object of numbers like {k: 1}`)
      for (const [key, v] of Object.entries(opts.params)) params[key] = num(v, `${api} params.${key}`)
    }
    for (const key of Object.keys(opts)) if (!['at', 'center', 'size', 'params', 'name', 'opacity'].includes(key)) warnings.add(`${api}: the option "${key}" is unknown and was ignored`)
    return make({
      kind: 'live',
      api,
      mode,
      name: nameOf(opts),
      code,
      width: w,
      height: h,
      params,
      line,
      style: { color: 'text', width: 0, opacity: opts.opacity === undefined ? 1 : num(opts.opacity, `${api} opacity`) },
      bounds: { x, y, width: w, height: h }
    })
  }
  const shader = (code, opts) => liveObject('shader', 'shader', code, opts)
  const canvas = (code, opts) => liveObject('canvas', 'canvas', code, opts)
  const program = (code, opts) => liveObject('program', 'program', code, opts)

  // ---------- Board material: html(), image(), space(), copy(), edit() ----------

  /** edit() records of this scene: text and style changes of board items at a time. */
  const edits = []
  /** move(…, {into}) records of this scene: items that go into a frame. */
  const reparents = []

  /** Ask the board (the app) a question: the layout of HTML, a picture, an empty place, an item's content. Blocks until it answers. */
  function ask(request, what) {
    if (!hostMeasure) fail(`${what}: the board cannot answer here`)
    let got
    try {
      got = JSON.parse(hostMeasure(JSON.stringify(request)))
    } catch (error) {
      fail(`${what}: no answer from the board (${error && error.message ? error.message : String(error)})`)
    }
    if (!got || typeof got !== 'object') fail(`${what}: no answer from the board`)
    if (typeof got.error === 'string') fail(`${what}: ${got.error}`)
    return got
  }

  /** A rect from an object (its bounds now), a point [x, y], [x, y, w, h] or {x, y, width, height}. */
  function rectArg(value, what) {
    if (value && typeof value === 'object' && handles.has(value)) return worldBounds(handles.get(value), T)
    if (Array.isArray(value) && value.length === 4) return { x: coord(value[0], `${what}[0]`), y: coord(value[1], `${what}[1]`), width: num(value[2], `${what}[2]`), height: num(value[3], `${what}[3]`) }
    if (plain(value) && ['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number')) return { x: value.x, y: value.y, width: value.width, height: value.height }
    if (Array.isArray(value) && value.length === 2) {
      const [x, y] = pair(value, what)
      return { x, y, width: 0, height: 0 }
    }
    fail(`${what} must be an object, a point [x, y], a rect [x, y, width, height] or {x, y, width, height}, got ${describe(value)}`)
  }

  /** Where this scene's own objects are now (they are not on the board yet), for space(). */
  function sceneBoxes() {
    const out = []
    for (const e of objects) {
      if (e.kind === 'group' || e.kind === 'node' || e.kind === 'part' || e.gone || e.dropped || e.removed) continue
      if (e.born !== sceneNo && !Object.keys(e.tracks).some((key) => e.tracks[key].length > 0)) continue
      const b = worldBounds(e, T)
      out.push({ x: f2(b.x), y: f2(b.y), width: f2(b.width), height: f2(b.height) })
    }
    return out
  }

  function space(w, h, opts) {
    num(w, 'space width')
    num(h, 'space height')
    if (w <= 0 || h <= 0) fail('space(width, height, options) needs a positive width and height')
    opts = options(opts, 'space options')
    for (const key of Object.keys(opts)) if (key !== 'near' && key !== 'inView') warnings.add(`space: the option "${key}" is unknown and was ignored`)
    const near = opts.near === undefined ? null : rectArg(opts.near, 'space near')
    const got = ask({ kind: 'space', width: f2(w), height: f2(h), near, avoid: sceneBoxes(), inView: opts.inView !== false }, 'space')
    return Object.freeze({ x: got.x, y: got.y, width: got.width, height: got.height, at: [got.x, got.y], center: [f2(got.x + got.width / 2), f2(got.y + got.height / 2)], visible: !!got.visible })
  }

  /** The board items (node ids, and the ink group id last) an object of this stage shows through, or null. */
  function stageIds(entry) {
    const items = CTX.stage && CTX.stage.items
    const ids = items && items[String(entry.id)]
    return ids && ids.length ? ids : null
  }

  /** A frame for into: a node id or name, board.node(…), or an html object (or part) of this stage. */
  function frameArg(value, what) {
    if (typeof value === 'string') {
      const ref = CTX.nodes[value] ? value : CTX.names && CTX.names[value]
      if (!ref || !CTX.nodes[ref]) fail(`${what}: there is no node "${value}" on the board`)
      if (CTX.nodes[ref].kind !== 'frame') fail(`${what}: "${value}" is a ${CTX.nodes[ref].kind}, not a frame`)
      return { ref }
    }
    const e = entryOf(value, what)
    if (e.kind === 'node') {
      if (e.nodeKind !== 'frame') fail(`${what}: board.node("${e.ref}") is a ${e.nodeKind}, not a frame`)
      return { ref: e.ref }
    }
    if (e.kind === 'html' || e.kind === 'part') {
      if (e.born === sceneNo || !stageIds(e)) return { obj: e }
      return { ref: stageIds(e)[0] }
    }
    fail(`${what} must be a frame: a node id${H(', board.node(id), or an html() object', ' or board.node(id)')}, got ${who(e)}`)
  }

  const HTML_KEYS = ['at', 'center', 'near', 'into', 'mode', 'index', 'name', 'opacity']

  /** Material from drafts (html(), image(), copies): measured by the board, placed at o.at, o.center, into a frame, or in empty space. */
  function htmlFrom(api, source, opts) {
    for (const key of Object.keys(opts)) if (!HTML_KEYS.includes(key)) warnings.add(`${api}: the option "${key}" is unknown and was ignored`)
    let place
    if (opts.into !== undefined) {
      const target = frameArg(opts.into, `${api} into`)
      if (target.obj) fail(`${api} into: ${who(target.obj)} is made by this scene; ${H('write this inside its own html(), or ')}put it in from a later scene`)
      const mode = opts.mode === undefined ? 'insert' : opts.mode
      if (mode !== 'insert' && mode !== 'replace') fail(`${api} mode must be "insert" or "replace"`)
      place = { ref: target.ref, mode }
      if (opts.index !== undefined) place.index = Math.max(0, Math.floor(num(opts.index, `${api} index`)))
    } else if (opts.mode !== undefined || opts.index !== undefined) warnings.add(`${api}: mode and index work with into only; they were ignored`)
    const answer = ask({ kind: 'html', ...source, ...(place ? { into: place } : {}) }, api)
    if (answer.ignored) warnings.add(`${api}: ${answer.ignored}`)
    const [w, h] = answer.size
    let x
    let y
    if (place) ({ x, y } = answer.box)
    else if (opts.center !== undefined) {
      const [cx, cy] = pair(opts.center, `${api} center`)
      x = cx - w / 2
      y = cy - h / 2
    } else if (opts.at !== undefined) [x, y] = pair(opts.at, `${api} at`)
    else {
      const r = space(w, h, opts.near === undefined ? {} : { near: opts.near })
      x = r.x
      y = r.y
    }
    return make({
      kind: 'html',
      api,
      name: nameOf(opts),
      drafts: answer.drafts,
      place,
      parts: (answer.parts || []).map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height, ...(p.name ? { name: p.name } : {}) })),
      partObjects: [],
      style: { color: 'text', width: 0, opacity: opts.opacity === undefined ? 1 : Math.max(0, Math.min(1, num(opts.opacity, `${api} opacity`))) },
      bounds: { x: f2(x), y: f2(y), width: f2(w), height: f2(h) }
    })
  }

  function html(markup, opts) {
    if (typeof markup !== 'string' || !markup.trim()) fail(`html(markup, options) needs HTML as a string, got ${describe(markup)}`)
    return htmlFrom('html', { markup }, options(opts, 'html options'))
  }

  function image(src, opts) {
    if (typeof src !== 'string' || !src.trim()) fail(`image(src, options) needs an https:// or data: URL or a file path in the learning folder, got ${describe(src)}`)
    opts = options(opts, 'image options')
    const { size, ...rest } = opts
    let wanted
    if (size !== undefined) {
      if (typeof size === 'number') {
        if (!(size > 0)) fail('image size must be positive')
        wanted = num(size, 'image size')
      } else {
        wanted = pair(size, 'image size')
        if (!(wanted[0] > 0) || !(wanted[1] > 0)) fail('image size must be positive')
      }
    }
    return htmlFrom('image', { image: { src: src.trim(), ...(wanted !== undefined ? { size: wanted } : {}) } }, rest)
  }

  /** Part k (an index or a layer-name) of an html object: an object of its own (made once). */
  function partOf(entry, key) {
    let k = key
    if (typeof key === 'string') {
      k = entry.parts.findIndex((p) => p.name === key)
      if (k < 0) fail(`part("${key}"): ${who(entry)} has no part with layer-name "${key}"; its parts: ${entry.parts.map((p, i) => p.name || String(i)).join(', ') || 'none'}`)
    } else if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key >= entry.parts.length) {
      fail(`part(index or layer-name): ${who(entry)} has ${entry.parts.length} part(s) (indexes 0 to ${entry.parts.length - 1}), got ${describe(key)}`)
    }
    const known = entry.partObjects[k]
    if (known !== undefined && objects[known] && !objects[known].dropped) return objects[known].handle
    const p = entry.parts[k]
    const handle = register({
      kind: 'part',
      api: 'part',
      parent: entry.id,
      index: k,
      ...(p.name ? { name: p.name } : {}),
      style: { color: 'text', width: 0, opacity: 1 },
      bounds: { x: f2(entry.bounds.x + p.x), y: f2(entry.bounds.y + p.y), width: p.width, height: p.height }
    })
    entry.partObjects[k] = handle.id
    return handle
  }

  /** A copy of an object, shifted by dx, dy (its own state now: place, size, angle, colour). */
  function copyEntry(e, dx, dy, name) {
    if (e.kind === 'group') {
      const members = e.members.map((id) => copyEntry(objects[id], dx, dy))
      return group(...members, name === undefined ? {} : { name })
    }
    const named = name === undefined ? {} : { name }
    if (e.kind === 'node' || ((e.kind === 'html' || e.kind === 'part') && e.born < sceneNo && stageIds(e))) {
      // An item on the board: the board says what it holds now.
      const ref = e.kind === 'node' ? e.ref : stageIds(e)[0]
      const got = ask({ kind: 'item', ref }, 'copy')
      const box = worldBounds(e, T)
      if (got.kind === 'ink') {
        const lines = got.strokes.map((s) => s.points.map((p) => [p[0] + dx, p[1] + dy, p[2]]))
        const first = got.strokes[0]
        return inkObject('copy', lines, { color: first.color, width: first.width, tool: first.tool, ...named }, { jitter: 0 })
      }
      return htmlFrom('copy', { drafts: got.drafts }, { at: [box.x + dx, box.y + dy], ...named })
    }
    if (e.kind === 'part') {
      const owner = objects[e.parent]
      const draft = owner.drafts[0] && owner.drafts[0].children[e.index]
      if (!draft) fail(`copy: ${who(e)} cannot be copied`)
      const box = worldBounds(e, T)
      return htmlFrom('copy', { drafts: [draft], width: e.bounds.width }, { at: [box.x + dx, box.y + dy], ...named })
    }
    const spec = specAt(e, T)
    const clone = {}
    for (const key of ['kind', 'api', 'lines', 'd', 'pressure', 'length', 'speed', 'text', 'math', 'at', 'center', 'mode', 'code', 'width', 'height', 'params', 'line', 'drafts', 'parts']) {
      if (spec[key] !== undefined && spec[key] !== null) clone[key] = JSON.parse(JSON.stringify(spec[key]))
      else if (spec[key] === null) clone[key] = null
    }
    // A copy of material in a frame sits at the top level.
    if (e.kind === 'html') clone.partObjects = []
    clone.style = { ...spec.style }
    const color = valueAt(e, 'color', T)
    if (typeof color === 'string') clone.style.color = color
    clone.bounds = { ...spec.bounds }
    clone.pivot = [...e.pivot]
    if (name !== undefined) clone.name = name
    else if (e.name !== undefined) clone.name = e.name
    const handle = register(clone)
    const c = objects[handle.id]
    let ox = valueAt(e, 'x', T) + dx
    let oy = valueAt(e, 'y', T) + dy
    for (let p = e.parent !== undefined ? objects[e.parent] : null; p; p = p.parent !== undefined ? objects[p.parent] : null) {
      // In a group: the group's move comes along (its turn and scale do not).
      ox += valueAt(p, 'x', T)
      oy += valueAt(p, 'y', T)
      if (valueAt(p, 'scale', T) !== 1 || valueAt(p, 'rotate', T) !== 0) warnings.add(`copy: ${who(e)} is in a scaled or turned group; the copy keeps its own size and angle`)
    }
    const base = {}
    if (ox) base.x = f3(ox)
    if (oy) base.y = f3(oy)
    const scale = valueAt(e, 'scale', T)
    const rotate = valueAt(e, 'rotate', T)
    if (scale !== 1) base.scale = f3(scale)
    if (rotate) base.rotate = f3(rotate)
    c.base = Object.keys(base).length ? base : undefined
    return handle
  }

  function copy(target, opts) {
    const e = entryOf(target, 'copy(item)')
    opts = options(opts, 'copy options')
    for (const key of Object.keys(opts)) if (!['at', 'center', 'by', 'near', 'name'].includes(key)) warnings.add(`copy: the option "${key}" is unknown and was ignored`)
    const box = worldBounds(e, T)
    let dx
    let dy
    if (opts.at !== undefined) {
      const [x, y] = pair(opts.at, 'copy at')
      dx = x - box.x
      dy = y - box.y
    } else if (opts.center !== undefined) {
      const [x, y] = pair(opts.center, 'copy center')
      dx = x - (box.x + box.width / 2)
      dy = y - (box.y + box.height / 2)
    } else if (opts.by !== undefined) [dx, dy] = pair(opts.by, 'copy by')
    else {
      const r = space(Math.max(1, box.width), Math.max(1, box.height), { near: opts.near === undefined ? box : opts.near })
      dx = r.x - box.x
      dy = r.y - box.y
    }
    return copyEntry(e, dx, dy, opts.name === undefined ? undefined : nameOf(opts))
  }

  function edit(target, change, timing) {
    const entry = entryOf(target, 'edit(item)')
    change = options(change, 'edit change')
    for (const key of Object.keys(change)) if (!['text', 'style', 'dur', 'ease'].includes(key)) warnings.add(`edit: "${key}" is unknown and was ignored; edit takes {text, style}`)
    if (timing === undefined && (change.dur !== undefined || change.ease !== undefined)) timing = { dur: change.dur, ease: change.ease }
    let text
    if (change.text !== undefined) {
      if (typeof change.text !== 'string' && typeof change.text !== 'number') fail(`edit text must be a string, got ${describe(change.text)}`)
      text = String(change.text)
    }
    let style
    if (change.style !== undefined) {
      if (!plain(change.style)) fail('edit style must be an object of CSS properties, like {color: "var(--ls-good)", fontSize: 20}')
      style = {}
      for (const [key, v] of Object.entries(change.style)) {
        if (v !== null && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) fail(`edit style.${key} must be a string, a number or null, got ${describe(v)}`)
        style[key] = v
      }
    }
    if (text === undefined && style === undefined) fail('edit(item, {text, style}) needs text or style')
    const { dur, ease } = durationArg(timing, 'edit', style ? 0.5 : 0)
    for (const e of leaves(entry)) {
      if (e.kind === 'node' || e.kind === 'html' || e.kind === 'part') {
        edits.push({ obj: e.id, at: f3(T), dur: f3(dur), ease: ease || 'inOut', ...(text !== undefined ? { text } : {}), ...(style ? { style } : {}) })
        e.edited = true
        continue
      }
      if (text !== undefined) {
        if (e.kind !== 'text') fail(`edit text: ${who(e)} has no text of its own (${H('text(), tex(), html()', 'text(), tex()')} and text nodes have)`)
        if (e.dynamic) fail(`edit text: the text of ${who(e)} follows its functions; change the values it reads instead`)
        const before = e.text
        e.text = text
        if (e.recipe) e.recipe.args = [text, ...e.recipe.args.slice(1)]
        const measured = measureText(e.math, text, e.style.size)
        if (measured) {
          const cx = e.bounds.x + e.bounds.width / 2
          const cy = e.bounds.y + e.bounds.height / 2
          e.bounds = e.center ? { x: cx - measured[0] / 2, y: cy - measured[1] / 2, width: measured[0], height: measured[1] } : { x: e.bounds.x, y: e.bounds.y, width: measured[0], height: measured[1] }
        }
        edits.push({ obj: e.id, at: f3(T), dur: 0, ease: 'linear', text, before })
        e.edited = true
      }
      if (style) {
        for (const [raw, v] of Object.entries(style)) {
          const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
          if (key === 'color' && typeof v === 'string') addTrack(e, 'color', T, dur, colorArg(v, 'edit color'), ease || 'inOut')
          else if (key === 'opacity' && v !== null) {
            firstVisibility(e, false)
            addTrack(e, 'opacity', T, dur, Math.max(0, Math.min(1, Number(v))), ease || 'inOut')
          } else if (key === 'fontSize' && e.kind === 'text' && v !== null && parseFloat(v) > 0) addValueTrack(values[optionValue(e, 'size').id], T, dur, parseFloat(v), ease || 'inOut')
          else warnings.add(`edit: the style "${raw}" does not apply to ${who(e)}; tween its options instead`)
        }
      }
    }
    endTime = Math.max(endTime, T + dur)
    return new Action(T, T + dur)
  }

  // ---------- Labels ----------

  const SIDES = {
    right: [1, 0],
    left: [-1, 0],
    above: [0, -1],
    below: [0, 1],
    'above-right': [Math.SQRT1_2, -Math.SQRT1_2],
    'above-left': [-Math.SQRT1_2, -Math.SQRT1_2],
    'below-right': [Math.SQRT1_2, Math.SQRT1_2],
    'below-left': [-Math.SQRT1_2, Math.SQRT1_2]
  }
  /** The side a label chose when it was made: it keeps it while things move. */
  const labelChoice = new Map()
  /** A label anchored at a point on an object: that point as a share of the object's bounds, fixed when the label is made. */
  const labelAnchor = new Map()

  /** World polylines of an object at t (outlines and ink), for collisions and points along it. */
  function worldLines(entry, t) {
    if (entry.kind === 'group') return entry.members.flatMap((id) => worldLines(objects[id], t))
    const spec = specAt(entry, t)
    const m = matrixAt(entry, t)
    let local
    if (spec.kind === 'ink') local = spec.lines || samplePath(spec.d)
    else if (spec.kind === 'shape') local = samplePath(spec.d)
    else {
      const b = spec.bounds
      local = [[[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height], [b.x, b.y]]]
    }
    return local.map((l) => l.map((p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]))
  }

  function pointAlong(lines, share) {
    let total = 0
    for (const l of lines) total += polyLength(l)
    let left = Math.max(0, Math.min(1, share)) * total
    for (const l of lines) {
      for (let i = 1; i < l.length; i++) {
        const len = Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1])
        if (left <= len) {
          const k = len ? left / len : 0
          return [l[i - 1][0] + (l[i][0] - l[i - 1][0]) * k, l[i - 1][1] + (l[i][1] - l[i - 1][1]) * k]
        }
        left -= len
      }
    }
    const last = lines[lines.length - 1]
    return last[last.length - 1]
  }

  function rectsOverlap(a, b) {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    return w > 0 && h > 0 ? w * h : 0
  }
  function inside(r, outer) {
    return r.x >= outer.x && r.y >= outer.y && r.x + r.width <= outer.x + outer.width && r.y + r.height <= outer.y + outer.height
  }
  const isTextLike = (e) => e.kind === 'text' || e.api === 'write' || e.api === 'label'

  /** How badly a box collides with the scene's objects and the board's items at t. Lower is better. */
  function collisionScore(box, t, exclude) {
    let score = 0
    const shrunk = { x: box.x + box.width * 0.06, y: box.y + box.height * 0.06, width: box.width * 0.88, height: box.height * 0.88 }
    for (const e of objects) {
      if (exclude.has(e.id) || e.kind === 'group' || e.kind === 'node' || e.kind === 'part' || e.removed || e.gone || e.dropped) continue
      const b = worldBounds(e, t)
      if (!rectsOverlap(b, box)) continue
      if (isTextLike(e) || e.kind === 'live' || e.kind === 'html') {
        score += 60 * (rectsOverlap(b, box) / Math.max(1, box.width * box.height))
        continue
      }
      for (const l of worldLines(e, t)) {
        for (let i = 1; i < l.length; i++) {
          const n = Math.max(1, Math.ceil(Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]) / 5))
          for (let k = 0; k < n; k++) {
            const x = l[i - 1][0] + ((l[i][0] - l[i - 1][0]) * k) / n
            const y = l[i - 1][1] + ((l[i][1] - l[i - 1][1]) * k) / n
            if (x >= shrunk.x && x <= shrunk.x + shrunk.width && y >= shrunk.y && y <= shrunk.y + shrunk.height) score += 1
          }
        }
      }
    }
    for (const [id, info] of Object.entries(CTX.nodes)) {
      if (info.kind === 'frame' || info.kind === 'ink' || exclude.has(id) || stageItemOwner(id) !== undefined) continue
      score += 40 * (rectsOverlap(info.bounds, box) / Math.max(1, box.width * box.height))
    }
    if (!inside(box, viewAt(t))) score += 25
    return score
  }

  function label(target, str, opts) {
    if (typeof str !== 'string' && typeof str !== 'number') fail(`label(target, text, options) needs text, got ${describe(str)}`)
    str = String(str)
    opts = options(opts, 'label options')
    const { side = 'auto', at, gap: gapOpt, tex: asTex, text: asText, ...rest } = opts
    const gap = gapOpt === undefined ? 10 : num(gapOpt, 'label gap')
    const exclude = new Set()
    // The anchor and the directions to try.
    let anchor = null
    let box = null
    let dirs = Object.keys(SIDES)
    let preferred = []
    if (target instanceof SceneObject) {
      const entry = entryOf(target, 'label target')
      exclude.add(entry.id)
      if (entry.kind === 'node') exclude.add(entry.ref)
      if (at !== undefined) {
        const b = worldBounds(entry, T)
        if (typeof at === 'number') anchor = pointAlong(worldLines(entry, T), at)
        else {
          // A point on the object stays on the same spot of it as the object moves or scales.
          const p = pair(at, 'label at')
          let rel = labelKey !== null ? labelAnchor.get(labelKey) : undefined
          if (!rel) {
            rel = [b.width > 1e-9 ? (p[0] - b.x) / b.width : 0, b.height > 1e-9 ? (p[1] - b.y) / b.height : 0]
            if (labelKey !== null) labelAnchor.set(labelKey, rel)
          }
          anchor = [b.x + rel[0] * b.width, b.y + rel[1] * b.height]
        }
        const c = [b.x + b.width / 2, b.y + b.height / 2]
        const out = [anchor[0] - c[0], anchor[1] - c[1]]
        const len = Math.hypot(out[0], out[1])
        if (len > 1e-6) {
          // Outward from the object first.
          preferred = dirs.slice().sort((p, q) => SIDES[q][0] * out[0] + SIDES[q][1] * out[1] - (SIDES[p][0] * out[0] + SIDES[p][1] * out[1]))
        }
      } else box = worldBounds(entry, T)
    } else if (Array.isArray(target) && Array.isArray(target[0])) {
      const a = pair(target[0], 'label segment start')
      const b = pair(target[1], 'label segment end')
      const share = typeof at === 'number' ? at : 0.5
      anchor = [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      const n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]
      // The two sides of the segment, as the nearest named sides.
      const nearest = (v) => dirs.slice().sort((p, q) => SIDES[q][0] * v[0] + SIDES[q][1] * v[1] - (SIDES[p][0] * v[0] + SIDES[p][1] * v[1]))[0]
      dirs = [nearest(n), nearest([-n[0], -n[1]])]
    } else anchor = pair(target, 'label target')
    // Measure the text at the origin.
    const make1 = (pos) => {
      rng = mulberry32(labelSeed)
      const o = { ...rest, at: pos }
      return asTex ? textObject('tex', str, o, true) : asText ? textObject('text', str, o, false) : write(str, o)
    }
    const labelSeed = Math.floor(rng() * 1e9)
    const probe = make1([0, 0])
    const w = probe.bounds.width
    const h = probe.bounds.height
    const place = (dir) => {
      const [dx, dy] = SIDES[dir]
      if (box) {
        const cx = box.x + box.width / 2 + dx * (box.width / 2 + gap) + dx * (w / 2)
        const cy = box.y + box.height / 2 + dy * (box.height / 2 + gap) + dy * (h / 2)
        return { x: cx - w / 2, y: cy - h / 2, width: w, height: h }
      }
      const cx = anchor[0] + dx * gap + dx * (w / 2)
      const cy = anchor[1] + dy * gap + dy * (h / 2)
      return { x: cx - w / 2, y: cy - h / 2, width: w, height: h }
    }
    let dir
    if (side === 'center') {
      const c = box ? [box.x + box.width / 2, box.y + box.height / 2] : anchor
      const spec = make1([c[0] - w / 2, c[1] - h / 2])
      spec.api = 'label'
      return spec
    } else if (side !== 'auto') {
      if (!SIDES[side]) fail(`label side must be "auto", "center" or one of ${Object.keys(SIDES).join(', ')}`)
      dir = side
    } else {
      const key = labelKey
      dir = key !== null ? labelChoice.get(key) : undefined
      if (!dir) {
        const order = preferred.length ? preferred : dirs
        let best = Infinity
        order.forEach((d, i) => {
          if (!dirs.includes(d)) return
          const score = collisionScore(place(d), T, exclude) + i * 0.01
          if (score < best) {
            best = score
            dir = d
          }
        })
        if (key !== null) labelChoice.set(key, dir)
      }
    }
    const r = place(dir)
    const spec = make1([r.x, r.y])
    spec.api = 'label'
    return spec
  }
  /** The recipe seed of the label being evaluated (set by the wrapper below), so its side is chosen once. */
  let labelKey = null
  const labelCreator = creator('label', (...args) => label(...args), { optIndex: 2, always: true })
  const labelApi = (...args) => {
    const seed = nextSeed
    labelKey = seed
    try {
      const handle = labelCreator(...args)
      objects[handle.id].recipe.impl = (...a) => {
        const saved = labelKey
        labelKey = seed
        try {
          return label(...a)
        } finally {
          labelKey = saved
        }
      }
      return handle
    } finally {
      labelKey = null
    }
  }

  // ---------- Actions ----------

  const spans = new WeakMap()
  class Action {
    constructor(start, end) {
      spans.set(this, { start: f3(start), end: f3(end), parts: [] })
    }
    get start() {
      return spans.get(this).start
    }
    get end() {
      return spans.get(this).end
    }
    then(resolve) {
      waiters.push({ t: this.end, seq: waiterSeq++, resolve })
    }
    toJSON() {
      return { start: this.start, end: this.end }
    }
  }

  /** Wrap an action: the tracks it adds are kept with the Action it returns. */
  function collecting(fn) {
    return (...args) => {
      const outer = collector
      const mine = []
      collector = mine
      try {
        const act = fn(...args)
        if (act instanceof Action) spans.get(act).parts = mine
        return act
      } finally {
        collector = outer
        if (outer) outer.push(...mine)
      }
    }
  }

  /** Stretch actions so they run over [start, end] (say(…, {during})). */
  function retime(list, start, end) {
    const acts = (Array.isArray(list) ? list : [list]).filter((a) => a !== undefined && a !== null)
    for (const act of acts) if (!(act instanceof Action)) fail(`say during takes actions (draw(), move(), tween(), …) or a list of them, got ${describe(act)}`)
    const touchedEntries = new Set()
    const touchedValues = new Set()
    for (const act of acts) {
      const span = spans.get(act)
      const a0 = span.start
      const a1 = span.end
      const k = a1 - a0 > 1e-9 ? (end - start) / (a1 - a0) : null
      const map = (t0, dur) => (k === null ? [start, end - start] : [start + (t0 - a0) * k, dur * k])
      for (const part of span.parts) {
        const target = part.a || part.c || part.p
        const [s0, d0] = map(target.start, target.dur)
        target.start = f3(s0)
        target.dur = f3(Math.max(0, d0))
        if (part.entry) touchedEntries.add(part.entry)
        if (part.v) touchedValues.add(part.v)
        activeSpans.push([target.start, f3(target.start + target.dur)])
      }
      span.start = f3(start)
      span.end = f3(end)
    }
    for (const e of touchedEntries) for (const list of Object.values(e.tracks)) list.sort((p, q) => p.start - q.start)
    for (const v of touchedValues) v.tracks.sort((p, q) => p.start - q.start)
    cameraActions.sort((a, b) => a.start - b.start)
    pointerActions.sort((a, b) => a.start - b.start)
    endTime = Math.max(endTime, end)
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
    if (entry.kind === 'live') return 0.8
    if (entry.kind === 'html') return Math.max(0.5, Math.min(8, 0.5 + 0.45 * entry.parts.length))
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
      if (e.kind === 'shape' || e.kind === 'text' || e.kind === 'node' || e.kind === 'live' || e.kind === 'html' || e.kind === 'part') {
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
    if (entry.kind === 'part') fail(`move: ${who(entry)} is a part of ${H('an html object; move the html object', 'material; move the material')}, or edit the part`)
    if (timing === undefined && (spec.dur !== undefined || spec.ease !== undefined)) timing = { dur: spec.dur, ease: spec.ease }
    const { dur, ease } = durationArg(timing, 'move', 0.8)
    if (spec.into !== undefined) {
      if (entry.kind === 'group') fail('move into: a group cannot go into a frame; move its objects one by one')
      for (const key of Object.keys(spec)) if (!['into', 'index', 'to', 'by', 'dur', 'ease'].includes(key)) warnings.add(`move: the option "${key}" is unknown and was ignored`)
      const target = frameArg(spec.into, 'move into')
      if (target.obj === entry) fail('move into: an object cannot go into itself')
      if (target.obj) target.obj.edited = true
      const record = { obj: entry.id, into: target.obj ? { obj: target.obj.id } : { ref: target.ref }, start: f3(T), dur: f3(dur), ease: ease || 'inOut' }
      if (spec.index !== undefined) record.index = Math.max(0, Math.floor(num(spec.index, 'move index')))
      reparents.push(record)
      entry.edited = true
      if (spec.to === undefined && spec.by === undefined) {
        endTime = Math.max(endTime, T + dur)
        activeSpans.push([f3(T), f3(T + dur)])
        return new Action(T, T + dur)
      }
    }
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

  /** A value that stands for one numeric option of a creator: the object is drawn again as it changes. */
  function optionValue(entry, key) {
    const recipe = entry.recipe
    if (!recipe || recipe.optIndex === undefined) fail(`tween: object ${entry.id} (${entry.api}) has no option "${key}" to animate`)
    recipe.overrides ||= {}
    if (recipe.overrides[key]) return recipe.overrides[key]
    // The start: the option as given (resolved now), else the object's own number for it.
    const spec = specAt(entry, T)
    const given = resolveArg(recipe.args[recipe.optIndex], 5)
    let start
    if (key.startsWith('params.')) start = spec.params ? spec.params[key.slice(7)] : undefined
    else if (plain(given) && typeof given[key] === 'number') start = given[key]
    else if (spec.style && typeof spec.style[key] === 'number') start = spec.style[key]
    else if (key === 'size' && spec.style && typeof spec.style.size === 'number') start = spec.style.size
    if (typeof start !== 'number') fail(`tween: object ${entry.id} (${entry.api}) has no number for "${key}" to start from; give it in the creator's options`)
    const v = value(start)
    recipe.overrides[key] = v
    entry.dynamic = true
    return v
  }

  function tween(target, props, timing) {
    if (target instanceof SceneValue) {
      let to = props
      if (plain(props)) {
        if (timing === undefined && (props.dur !== undefined || props.ease !== undefined)) timing = { dur: props.dur, ease: props.ease }
        to = props.to
      }
      num(to, 'tween(value, target) target')
      const { dur, ease } = durationArg(timing, 'tween', 0.8)
      addValueTrack(values[target.id], T, dur, to, ease || 'inOut')
      return new Action(T, T + dur)
    }
    const entry = entryOf(target, 'tween(object)')
    props = options(props, 'tween props')
    if (timing === undefined && (props.dur !== undefined || props.ease !== undefined)) timing = { dur: props.dur, ease: props.ease }
    const { dur, ease } = durationArg(timing, 'tween', 0.8)
    let any = false
    for (const [key, value] of Object.entries(props)) {
      if (key === 'dur' || key === 'ease') continue
      if (key === 'params' && plain(value)) {
        for (const [k, v] of Object.entries(value)) {
          for (const e of leaves(entry)) {
            if (e.kind !== 'live') fail(`tween: object ${e.id} (${e.api}) has no params${NO_CODE_ITEMS ? '' : '; only shader(), canvas() and program() items do'}`)
            addValueTrack(values[optionValue(e, `params.${k}`).id], T, dur, num(v, `tween params.${k}`), ease || 'inOut')
          }
        }
        any = true
        continue
      }
      if (!TWEEN_PROPS.has(key)) {
        // Any other numeric option of the creator (width, size, fillOpacity, radius, …).
        num(value, `tween ${key}`)
        for (const e of leaves(entry)) addValueTrack(values[optionValue(e, key).id], T, dur, value, ease || 'inOut')
        any = true
        continue
      }
      any = true
      const groupOwn = key === 'x' || key === 'y' || key === 'scale' || key === 'rotate'
      if (groupOwn && entry.kind === 'part') fail(`tween ${key}: ${who(entry)} is a part of ${H('an html object', 'material')}; it moves with that object`)
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
    if (!any) fail('tween(object, {x, y, scale, rotate, opacity, color, draw, params, or any numeric option}, seconds) needs at least one property')
    return new Action(T, T + dur)
  }

  function wait(seconds) {
    const s = seconds === undefined ? 0.5 : num(seconds, 'wait seconds')
    if (s < 0) fail('wait seconds must not be negative')
    endTime = Math.max(endTime, T + s)
    return new Action(T, T + s)
  }

  function step(name, opts) {
    if (typeof name !== 'string' || !name.trim()) fail('step(name) needs a name string')
    opts = options(opts, 'step options')
    for (const key of Object.keys(opts)) if (key !== 'pause') warnings.add(`step: the option "${key}" is unknown and was ignored`)
    steps.push({ name: name.trim(), at: f3(T), ...(opts.pause ? { pause: true } : {}) })
  }

  // ---------- Camera, pointer, lines (say) ----------

  const clampZoom = (z) => Math.max(0.1, Math.min(8, z))
  const vw = () => (CTX.viewport && CTX.viewport[0]) || 1200
  const vh = () => (CTX.viewport && CTX.viewport[1]) || 800

  /** The learner's view at t, after this scene's camera moves (a move in progress counts as done at its end). */
  function viewAt(t) {
    let view = { ...CTX.view }
    for (const c of cameraActions) {
      if (c.start > t) break
      const w = vw() / c.zoom
      const h = vh() / c.zoom
      const to = { x: c.center[0] - w / 2, y: c.center[1] - h / 2, width: w, height: h }
      if (t >= c.start + c.dur || c.dur <= 0) view = to
      else {
        const k = EASES[c.ease]((t - c.start) / c.dur)
        view = { x: view.x + (to.x - view.x) * k, y: view.y + (to.y - view.y) * k, width: view.width + (to.width - view.width) * k, height: view.height + (to.height - view.height) * k }
      }
    }
    return { x: f2(view.x), y: f2(view.y), width: f2(view.width), height: f2(view.height) }
  }

  function camera(spec, timing) {
    spec = options(spec, 'camera spec')
    const { dur, ease } = durationArg(timing, 'camera', 1)
    const now = viewAt(T)
    let zoom = vw() / now.width
    let center = [now.x + now.width / 2, now.y + now.height / 2]
    if (spec.fit !== undefined) {
      let r
      if (spec.fit instanceof SceneObject) r = worldBounds(entryOf(spec.fit, 'camera fit'), T)
      else if (Array.isArray(spec.fit) && spec.fit.length === 4) r = { x: coord(spec.fit[0], 'camera fit[0]'), y: coord(spec.fit[1], 'camera fit[1]'), width: num(spec.fit[2], 'camera fit[2]'), height: num(spec.fit[3], 'camera fit[3]') }
      else fail('camera fit must be an object or [x, y, width, height]')
      const pad = spec.pad === undefined ? 40 : num(spec.pad, 'camera pad')
      zoom = clampZoom(Math.min(vw() / Math.max(1, r.width + pad * 2), vh() / Math.max(1, r.height + pad * 2)))
      center = [r.x + r.width / 2, r.y + r.height / 2]
    }
    if (spec.to !== undefined) center = pair(spec.to, 'camera to')
    if (spec.zoom !== undefined) zoom = clampZoom(num(spec.zoom, 'camera zoom'))
    for (const key of Object.keys(spec)) if (!['fit', 'to', 'zoom', 'pad'].includes(key)) warnings.add(`camera: the option "${key}" is unknown and was ignored`)
    if (spec.fit === undefined && spec.to === undefined && spec.zoom === undefined) fail('camera({fit, to, zoom}, seconds) needs fit, to or zoom')
    const move = { start: f3(T), dur: f3(dur), center: [f2(center[0]), f2(center[1])], zoom: Math.round(zoom * 1000) / 1000, ease: ease || 'inOut' }
    cameraActions.push(move)
    if (collector) collector.push({ kind: 'camera', c: move })
    cameraActions.sort((a, b) => a.start - b.start)
    activeSpans.push([f3(T), f3(T + dur)])
    endTime = Math.max(endTime, T + dur)
    return new Action(T, T + dur)
  }

  function point(target, timing) {
    const { dur } = durationArg(timing, 'point', 0.6)
    let to
    if (target === null || target === false) to = null
    else if (target instanceof SceneObject) {
      const b = worldBounds(entryOf(target, 'point target'), T)
      to = [f2(b.x + b.width / 2), f2(b.y + b.height / 2)]
    } else to = pair(target, 'point target')
    const glide = { start: f3(T), dur: f3(dur), to }
    pointerActions.push(glide)
    if (collector) collector.push({ kind: 'pointer', p: glide })
    pointerActions.sort((a, b) => a.start - b.start)
    endTime = Math.max(endTime, T + dur)
    return new Action(T, T + dur)
  }

  /**
   * The reading pace of say() lines: nothing is spoken; the learner reads the
   * line, so it lasts as long as reading it takes. 3.5 words per second (210
   * words a minute, an easy pace for a short line read next to a drawing),
   * plus 0.3 s to find the line, at least 1 s.
   */
  const WORDS_PER_S = 3.5
  const countWords = (str) => str.split(/\s+/).filter(Boolean).length
  const readTime = (str) => Math.max(1, countWords(str) / WORDS_PER_S + 0.3)
  /**
   * A line with marks: "Out come [[he]] a helium nucleus" → the words without
   * the markers, and each mark's character index (the start of the word after it).
   */
  function splitMarks(raw) {
    const marks = []
    let clean = ''
    const re = /\[\[\s*([^\]]*?)\s*\]\]/g
    let last = 0
    let m
    const add = (piece) => {
      piece = piece.replace(/\s+/g, ' ')
      if (clean.endsWith(' ') && piece.startsWith(' ')) piece = piece.slice(1)
      clean += piece
    }
    while ((m = re.exec(raw))) {
      add(raw.slice(last, m.index))
      if (!m[1]) fail('say: a mark needs a name, like [[he]]')
      marks.push({ name: m[1], char: clean.length })
      last = m.index + m[0].length
    }
    add(raw.slice(last))
    const lead = clean.length - clean.trimStart().length
    clean = clean.trim()
    for (const mark of marks) {
      mark.char = Math.max(0, Math.min(clean.length, mark.char - lead))
      while (clean[mark.char] === ' ') mark.char++
    }
    return { clean, marks }
  }

  /** A line's reading time, and each mark's offset: when the reader reaches the word after it (by word position at the reading pace). */
  function measureLine(clean, marks) {
    const dur = readTime(clean)
    const offsets = marks.map((mark) => {
      const before = countWords(clean.slice(0, mark.char))
      return before ? Math.min(dur, 0.3 + before / WORDS_PER_S) : 0
    })
    return { dur, offsets }
  }

  /** Mark name → its time in this scene (the latest line with it). */
  const markTimes = new Map()
  /** Errors thrown by mark callbacks that ran as async functions. */
  let asyncErrors = []

  function say(str, opts) {
    if (typeof str !== 'string' && typeof str !== 'number') fail(`say(text) needs a string, got ${describe(str)}`)
    const raw = String(str).trim()
    if (!raw) fail('say(text) needs some words')
    opts = options(opts, 'say options')
    const { clean, marks } = splitMarks(raw)
    if (!clean) fail('say(text) needs some words besides its marks')
    const measured = measureLine(clean, marks)
    const start = T
    const dur = f3(measured.dur)
    const cue = { text: clean, at: f3(start), dur }
    if (marks.length) cue.marks = marks.map((mark, i) => ({ name: mark.name, at: f3(start + measured.offsets[i]), char: mark.char }))
    cues.push(cue)
    for (const mark of cue.marks || []) markTimes.set(mark.name, mark.at)
    endTime = Math.max(endTime, start + dur)
    for (const [key, value] of Object.entries(opts)) {
      if (key === 'during') {
        retime(value, start, start + dur)
        continue
      }
      const mark = (cue.marks || []).find((entry) => entry.name === key)
      if (!mark) {
        warnings.add(`say: "${key}" is not a mark of this line (marks: ${(cue.marks || []).map((entry) => entry.name).join(', ') || 'none'}) and was ignored`)
        continue
      }
      if (typeof value !== 'function') fail(`say: the option "${key}" (a mark) must be a function, like () => draw(obj)`)
      waiters.push({
        t: mark.at,
        seq: waiterSeq++,
        resolve: () => {
          const out = value()
          if (out instanceof Promise) out.then(undefined, (error) => asyncErrors.push(error))
        }
      })
    }
    return new Action(start, start + dur)
  }

  /** An action that ends when the word after [[name]] is read, at the reading pace (the latest line with that mark). */
  function mark(name) {
    if (typeof name !== 'string' || !name) fail('mark(name) needs the name of a mark, like mark("he") for [[he]] in a say() line')
    if (!markTimes.has(name)) fail(`mark("${name}"): no line said so far in this scene has [[${name}]] (marks so far: ${[...markTimes.keys()].join(', ') || 'none'})`)
    return new Action(T, Math.max(T, markTimes.get(name)))
  }

  function all(...list) {
    if (list.length === 1 && Array.isArray(list[0])) list = list[0]
    let end = T
    const parts = []
    for (const item of list) {
      if (item instanceof Action) {
        end = Math.max(end, item.end)
        parts.push(...spans.get(item).parts)
      } else if (item !== undefined && item !== null) fail(`all(...) takes actions (draw(), move(), wait(), …), got ${describe(item)}`)
    }
    const act = new Action(T, end)
    spans.get(act).parts = parts
    return act
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
  G.console = Object.freeze({ log, info: log, warn: log, error: log })

  // ---------- Host interface ----------

  G.__advance = () => {
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

  // ---------- At the end: sample changing objects, check the layout ----------

  /** Sample times for an object made at `from`: frames where something animates, plus the start and the end. */
  function sampleTimes(from) {
    const out = new Set([f3(from), f3(endTime)])
    const dt = 1 / SAMPLE_FPS
    for (const [s0, s1] of activeSpans) {
      const a = Math.max(s0, from)
      const b = Math.min(s1, endTime)
      if (b < a) continue
      for (let t = a; t < b; t += dt) out.add(f3(t))
      out.add(f3(b))
    }
    return [...out].filter((t) => t >= from - 1e-9 && t <= endTime + 1e-9).sort((p, q) => p - q)
  }

  function geometryOf(spec) {
    const g = { bounds: { x: f2(spec.bounds.x), y: f2(spec.bounds.y), width: f2(spec.bounds.width), height: f2(spec.bounds.height) } }
    if (spec.kind === 'shape') {
      g.d = spec.d
      g.width = spec.style.width
      if (spec.style.fill) g.fill = spec.style.fill
      if (spec.style.fillOpacity !== undefined) g.fillOpacity = spec.style.fillOpacity
    } else if (spec.kind === 'ink') {
      if (spec.lines) g.lines = spec.lines
      else g.d = spec.d
      g.width = spec.style.width
    } else if (spec.kind === 'text') g.text = spec.text
    else if (spec.kind === 'live') g.params = spec.params
    return g
  }

  /** Sample changing objects over this scene. Returns the objects of earlier scenes whose geometry changes in it. */
  function sampleObjects(list) {
    finalSampling = true
    const changedEarlier = new Set()
    for (const entry of list) {
      if (!entry.dynamic || entry.kind === 'group' || entry.kind === 'node') continue
      const samples = []
      let lastKey = ''
      let final = null
      for (const t of sampleTimes(entry.born === sceneNo ? entry.created : 0)) {
        const spec = specAt(entry, t)
        if (spec !== entry) entry.lastGood = spec
        if (spec.kind !== entry.kind) {
          warnings.add(`object ${entry.id} (${entry.api}): its functions changed what kind of object it is; it keeps its first kind`)
          continue
        }
        const g = geometryOf(spec)
        const key = JSON.stringify(g)
        final = spec
        if (key === lastKey) continue
        lastKey = key
        samples.push({ t: f3(t), ...g })
      }
      if (!final) continue
      // The object's own fields hold the end state.
      for (const field of ['d', 'lines', 'text', 'params', 'at', 'center', 'pressure', 'length', 'style']) if (final[field] !== undefined) entry[field] = final[field]
      entry.bounds = final.bounds
      if (samples.length > 1) entry.dyn = samples
      if (entry.born < sceneNo && (samples.length > 1 || lastKey !== entry.bakedKey)) changedEarlier.add(entry)
    }
    finalSampling = false
    return changedEarlier
  }

  /** Visible at t: made (or revealed) by then and not gone. */
  function visibleAt(e, t) {
    if (e.kind === 'group' || e.kind === 'node' || e.kind === 'part') return false
    if (e.vis === 'hidden') {
      const reveal = (e.tracks.draw || []).concat(e.tracks.opacity || []).find((a) => a.to > 0)
      if (!reveal || reveal.start > t) return false
    } else if (e.created > t) return false
    const draw = valueAt(e, 'draw', t)
    const opacity = valueAt(e, 'opacity', t)
    return draw > 0.05 && opacity > 0.05
  }

  function revealEnd(e) {
    let end = e.created
    for (const a of e.tracks.draw || []) if (a.to > 0) end = Math.max(end, a.start + a.dur)
    for (const a of e.tracks.fill || []) if (a.to > 0) end = Math.max(end, a.start + a.dur)
    for (const a of e.tracks.opacity || []) if (a.to > 0) end = Math.max(end, a.start + a.dur)
    return Math.min(end, endTime)
  }

  const who = (e) => {
    const words = isTextLike(e) ? specAt(e, endTime).text : undefined
    return `${e.api} ${e.id}${e.name ? ` "${e.name}"` : ''}${typeof words === 'string' ? ` ${JSON.stringify(words.length > 30 ? `${words.slice(0, 29)}…` : words)}` : ''}`
  }
  function stepAt(t) {
    let name = null
    for (const st of steps) if (st.at <= t + 1e-9) name = st.name
    return name
  }

  /** The first `share` (0..1) of polylines, by length: a line drawn that far. */
  function trimLines(lines, share) {
    if (share >= 1) return lines
    let left = Math.max(0, share) * lines.reduce((sum, l) => sum + polyLength(l), 0)
    const out = []
    for (const l of lines) {
      if (left <= 0) break
      const part = [l[0]]
      for (let i = 1; i < l.length; i++) {
        const len = Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1])
        if (left >= len) {
          part.push(l[i])
          left -= len
          continue
        }
        const k = len ? left / len : 0
        part.push([l[i - 1][0] + (l[i][0] - l[i - 1][0]) * k, l[i - 1][1] + (l[i][1] - l[i - 1][1]) * k])
        left = 0
        break
      }
      out.push(part)
    }
    return out
  }

  /**
   * How much of a stroke crosses a text box: the stroke's drawn part, sampled
   * every 1.5 points along its world polylines, counts where the stroke (its
   * centre line widened by half its width) reaches into the box. Returns the
   * length in points. A fill does not count, so text inside a filled shape
   * that does not touch its outline stays quiet.
   */
  function strokeInBox(o, t, box) {
    const m = matrixAt(o, t)
    const style = specAt(o, t).style
    const half = (((style && style.width) || 2) * Math.hypot(m[0], m[1])) / 2
    const x0 = box.x - half
    const y0 = box.y - half
    const x1 = box.x + box.width + half
    const y1 = box.y + box.height + half
    const STEP = 1.5
    let inside = 0
    for (const l of trimLines(worldLines(o, t), valueAt(o, 'draw', t))) {
      for (let i = 1; i < l.length; i++) {
        const ax = l[i - 1][0]
        const ay = l[i - 1][1]
        const bx = l[i][0]
        const by = l[i][1]
        // Skip segments that cannot reach the box.
        if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue
        const len = Math.hypot(bx - ax, by - ay)
        const n = Math.max(1, Math.ceil(len / STEP))
        for (let k = 0; k < n; k++) {
          const x = ax + ((bx - ax) * k) / n
          const y = ay + ((by - ay) * k) / n
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) inside += len / n
        }
      }
    }
    return inside
  }

  /** Overlaps and the view, for the objects this scene sends (`list`), against everything visible. */
  function checkLayout(list) {
    const mine = new Set(list)
    const times = new Set([f3(endTime)])
    for (const st of steps) times.add(st.at)
    for (const e of list) if (isTextLike(e) && e.kind !== 'group') times.add(f3(revealEnd(e)))
    // Between those moments too (text and shapes move with tweens): every half second, at most 160 moments.
    const every = Math.max(0.5, endTime / 160)
    for (let t = every; t < endTime; t += every) times.add(f3(t))
    const seen = new Set()
    const sorted = [...times].sort((a, b) => a - b)
    for (const t of sorted) {
      const visible = objects.filter((e) => !e.gone && !e.dropped && visibleAt(e, t))
      for (const e of visible) {
        if (!isTextLike(e) || !mine.has(e)) continue
        const box = worldBounds(e, t)
        // The text's ink: the layout box less the empty leading above and below the line, and a hair at the sides.
        const inner = { x: box.x + Math.min(2, box.width * 0.04), y: box.y + box.height * 0.1, width: box.width - 2 * Math.min(2, box.width * 0.04), height: box.height * 0.8 }
        for (const o of visible) {
          if (o === e) continue
          const pairKey = e.id < o.id ? `${e.id}:${o.id}` : `${o.id}:${e.id}`
          if (seen.has(pairKey)) continue
          const ob = worldBounds(o, t)
          if (!rectsOverlap(ob, inner)) continue
          let hit = false
          let what = 'outline'
          if (isTextLike(o) || o.kind === 'live' || o.kind === 'html') {
            hit = rectsOverlap(ob, inner) > 0.12 * Math.min(inner.width * inner.height, ob.width * ob.height)
            what = o.kind === 'live' || o.kind === 'html' ? 'box' : 'text'
          } else {
            // The stroke itself: a line, curve, outline or ink that runs through the text (at least 5 points of it).
            hit = strokeInBox(o, t, inner) >= 5
            what = o.kind === 'ink' ? 'ink' : 'outline'
          }
          if (!hit) continue
          seen.add(pairKey)
          const st = stepAt(t)
          warnings.add(`overlap: ${who(e)} overlaps the ${what} of ${who(o)} at ${f2(t)} s${st ? ` (step "${st}")` : ''}; text at ${f2(box.x)}, ${f2(box.y)} ${f2(box.width)}×${f2(box.height)}`)
        }
        const items = []
        for (const [id, info] of Object.entries(CTX.nodes)) {
          // Ink shows through its ink group (g1, …); frames hold other items.
          if (info.kind === 'frame' || info.kind === 'ink' || seen.has(`${e.id}:${id}`) || stageItemOwner(id) !== undefined) continue
          if (rectsOverlap(info.bounds, inner) <= 0.12 * Math.min(inner.width * inner.height, info.bounds.width * info.bounds.height)) continue
          // Items this scene acts on are where the scene puts them, not where they were.
          if (objects.some((o) => o.kind === 'node' && o.ref === id)) continue
          seen.add(`${e.id}:${id}`)
          items.push(`${id}${info.name ? ` "${info.name}"` : ''} (${info.kind})`)
        }
        if (items.length) warnings.add(`overlap: ${who(e)} overlaps the board item${items.length > 1 ? 's' : ''} ${items.join(', ')} at ${f2(t)} s`)
      }
    }
    // Outside the learner's view when it appears (this scene's camera moves count).
    for (const e of list) {
      if (e.born < sceneNo && !e.revealed) continue
      if (e.kind === 'group' || e.kind === 'node' || e.kind === 'part' || e.removed) continue
      const t = revealEnd(e)
      if (!visibleAt(e, t) && !visibleAt(e, endTime)) continue
      const b = worldBounds(e, t)
      const view = viewAt(t)
      if (!inside(b, view)) {
        const fully = rectsOverlap(b, view) <= 0
        warnings.add(`view: ${who(e)} is ${fully ? 'outside' : 'partly outside'} the learner's view at ${f2(t)} s (object ${f2(b.x)}, ${f2(b.y)} ${f2(b.width)}×${f2(b.height)}; view ${f2(view.x)}, ${f2(view.y)} ${f2(view.width)}×${f2(view.height)})`)
      }
    }
  }

  /** Cut the scene at c (scene_control cut): what starts at c or later is dropped, what runs then holds its value. */
  function applyCut(c) {
    const cutList = (list) => {
      const keep = []
      for (const a of list) {
        if (a.start >= c - 1e-9) continue
        if (a.start + a.dur > c) a.until = f3(c)
        keep.push(a)
      }
      return keep
    }
    for (const e of objects) {
      if (e.born === sceneNo && e.kind !== 'group' && e.kind !== 'node') {
        let appears = e.created
        if (e.vis === 'hidden') {
          appears = Infinity
          for (const a of (e.tracks.draw || []).concat(e.tracks.opacity || [])) if (typeof a.to === 'number' && a.to > 0) appears = Math.min(appears, a.start)
        }
        if (appears >= c - 1e-9) {
          e.dropped = true
          continue
        }
      }
      for (const prop of Object.keys(e.tracks)) e.tracks[prop] = cutList(e.tracks[prop])
      if (e.removed) e.removed = valueAt(e, 'opacity', c) < 0.02 || valueAt(e, 'draw', c) <= 0.001
    }
    for (const e of objects) {
      if (e.kind !== 'group' || e.born !== sceneNo) continue
      e.members = e.members.filter((id) => !objects[id].dropped)
      if (!e.members.length) e.dropped = true
    }
    const kept = new Set()
    for (const e of objects) if (!e.dropped) for (const list of Object.values(e.tracks)) for (const a of list) kept.add(a)
    const acts = actions.filter((a) => kept.has(a))
    actions.length = 0
    for (const a of acts) actions.push(a)
    for (const v of values) v.tracks = cutList(v.tracks)
    const keepSteps = steps.filter((st) => st.at < c - 1e-9)
    steps.length = 0
    for (const st of keepSteps) steps.push(st)
    const keepCues = cues.filter((cue) => cue.at < c - 1e-9)
    cues.length = 0
    for (const cue of keepCues) {
      cue.dur = f3(Math.min(cue.dur, c - cue.at))
      if (cue.marks) cue.marks = cue.marks.filter((m) => m.at < c - 1e-9)
      cues.push(cue)
    }
    const keepEdits = edits.filter((x) => x.at < c - 1e-9 && !objects[x.obj].dropped)
    edits.length = 0
    for (const x of keepEdits) edits.push(x)
    const keepMoves = reparents.filter((x) => x.start < c - 1e-9 && !objects[x.obj].dropped)
    reparents.length = 0
    for (const x of keepMoves) reparents.push(x)
    const keepCam = cameraActions.filter((a) => a.start < c - 1e-9)
    cameraActions.length = 0
    for (const a of keepCam) cameraActions.push(a)
    const keepPtr = pointerActions.filter((a) => a.start < c - 1e-9)
    pointerActions.length = 0
    for (const a of keepPtr) pointerActions.push(a)
    for (const span of activeSpans) span[1] = Math.min(span[1], c)
    endTime = c
  }

  const touched = (e) => Object.keys(e.tracks).some((key) => e.tracks[key].length > 0)

  G.__result = () => {
    if (asyncErrors.length) throw asyncErrors[0]
    for (const e of objects) if (e.born === sceneNo && e.vis === undefined) e.vis = 'shown'
    if (cutAt !== null) applyCut(Math.min(cutAt, endTime))
    const fresh = objects.filter((e) => e.born === sceneNo && !e.dropped)
    const earlier = objects.filter((e) => e.born < sceneNo && !e.dropped && !e.gone && e.kind !== 'node' && e.kind !== 'group')
    for (const e of earlier) delete e.dyn
    const anyChange = actions.length > 0 || values.some((v) => v.tracks.length > 0)
    const changed = sampleObjects(anyChange ? fresh.concat(earlier) : fresh)
    // Earlier objects this scene sends again: those it acts on, those whose recipe changes in it, and gone ones it brings back.
    const emit = new Set(fresh)
    for (const e of objects) {
      if (e.born === sceneNo || e.dropped) continue
      if (e.gone) {
        if (e.revealed && e.kind !== 'group' && e.kind !== 'node') emit.add(e)
        else if (touched(e) && e.kind !== 'group') warnings.add(`${who(e)} is not on the board any more (erased, or removed by an earlier scene); draw it or fade it in to bring it back`)
        continue
      }
      if (touched(e) || changed.has(e) || e.edited) emit.add(e)
    }
    // An object moves with its groups; a group that moves moves its members.
    for (let grew = true; grew; ) {
      grew = false
      for (const e of [...emit]) {
        if (e.parent !== undefined && !emit.has(objects[e.parent])) {
          emit.add(objects[e.parent])
          grew = true
        }
        if (e.kind === 'group' && touched(e)) {
          for (const id of e.members) {
            const member = objects[id]
            if (!emit.has(member) && !member.gone && !member.dropped) {
              emit.add(member)
              grew = true
            }
          }
        }
      }
    }
    const list = objects.filter((e) => emit.has(e))
    if (!anyChange) sampleObjects(list.filter((e) => e.born < sceneNo && e.dynamic))
    try {
      checkLayout(list)
    } catch (error) {
      warnings.add(`The layout check failed: ${error && error.message ? error.message : String(error)}`)
    }
    const local = new Map(list.map((e, i) => [e.id, i]))
    const out = list.map((e) => {
      const carry = e.born < sceneNo && !e.gone && e.kind !== 'node'
      const o = { id: local.get(e.id), sid: e.id, kind: e.kind, api: e.api, created: f3(carry ? 0 : e.created), vis: carry ? 'shown' : e.vis || 'shown', removed: e.removed, bounds: e.bounds, pivot: e.pivot }
      if (carry) o.carry = true
      if (e.base && e.kind !== 'node') o.base = e.base
      if (e.name !== undefined) o.name = e.name
      if (e.parent !== undefined && local.has(e.parent)) o.parent = local.get(e.parent)
      if (e.dyn) o.dyn = e.dyn
      if (e.kind === 'ink') Object.assign(o, { style: e.style, lines: e.lines, d: e.d, pressure: e.pressure })
      if (e.kind === 'shape') Object.assign(o, { style: e.style, d: e.d })
      if (e.kind === 'text') Object.assign(o, { style: e.style, text: e.text, math: e.math, at: e.at, center: e.center })
      if (e.kind === 'live') Object.assign(o, { style: e.style, mode: e.mode, code: e.code, width: e.width, height: e.height, params: e.params, line: e.line })
      if (e.kind === 'group') o.members = e.members.filter((id) => local.has(id)).map((id) => local.get(id))
      if (e.kind === 'node') o.ref = e.ref
      if (e.kind === 'html') Object.assign(o, { style: e.style, drafts: e.drafts, ...(e.place ? { place: e.place } : {}) })
      if (e.kind === 'part') Object.assign(o, { style: e.style, index: e.index })
      return o
    })
    const acts = actions.filter((a) => local.has(a.obj)).map((a) => ({ ...a, obj: local.get(a.obj) }))
    const editList = edits.filter((x) => local.has(x.obj)).map((x) => ({ ...x, obj: local.get(x.obj) }))
    const moveList = reparents
      .filter((x) => local.has(x.obj) && (!x.into.obj || local.has(x.into.obj)))
      .map((x) => ({ ...x, obj: local.get(x.obj), into: x.into.obj !== undefined ? { obj: local.get(x.into.obj) } : x.into }))
    return JSON.stringify({ objects: out, actions: acts, edits: editList, reparents: moveList, steps, duration: f3(endTime), logs, warnings: [...warnings], camera: cameraActions, pointer: pointerActions, cues })
  }

  /** The end of this scene becomes the start of the next: each object's state at the end is its base, values keep their end value. */
  G.__bake = () => {
    for (const e of objects) if (e.born === sceneNo && e.vis === undefined) e.vis = 'shown'
    for (const e of objects) e.edited = false
    const hidden = { opacity: 1, draw: 0, fill: 0 }
    for (const e of objects) {
      if (e.dropped) {
        Object.assign(e, { dropped: false, gone: true, vis: 'hidden', base: { ...hidden }, tracks: {}, created: 0, removed: false, revealed: false })
        delete e.dyn
        continue
      }
      if (e.kind === 'node') {
        e.tracks = {}
        e.base = undefined
        continue
      }
      if (e.gone && !e.revealed) {
        e.tracks = {}
        continue
      }
      const props = {}
      const defaults = { x: 0, y: 0, scale: 1, rotate: 0 }
      for (const prop of Object.keys(defaults)) {
        const v = valueAt(e, prop, endTime)
        if (typeof v === 'number' && Math.abs(v - defaults[prop]) > 1e-9) props[prop] = f3(v)
      }
      if (e.kind !== 'group') {
        if (e.dynamic) {
          const spec = specAt(e, endTime)
          if (spec !== e && spec.kind === e.kind) {
            for (const field of ['d', 'lines', 'text', 'params', 'at', 'center', 'pressure', 'length', 'style']) if (spec[field] !== undefined) e[field] = spec[field]
            e.bounds = spec.bounds
          }
          e.bakedKey = JSON.stringify(geometryOf(e))
          // A trace keeps the path it left; a new trace() draws on from here.
          if (e.api === 'trace') e.dynamic = false
        }
        if (e.removed) {
          e.gone = true
          e.vis = 'hidden'
          Object.assign(props, hidden)
        } else {
          e.gone = false
          e.vis = 'shown'
          const opacity = valueAt(e, 'opacity', endTime)
          const draw = valueAt(e, 'draw', endTime)
          const fill = valueAt(e, 'fill', endTime)
          const color = valueAt(e, 'color', endTime)
          if (typeof opacity === 'number' && opacity !== 1) props.opacity = f3(opacity)
          if (typeof draw === 'number' && draw !== 1) props.draw = f3(draw)
          if (typeof fill === 'number' && fill !== 1) props.fill = f3(fill)
          if (typeof color === 'string' && e.style && color !== e.style.color) props.color = color
        }
      }
      e.base = Object.keys(props).length ? props : undefined
      e.tracks = {}
      e.created = 0
      e.removed = false
      e.revealed = false
      delete e.dyn
    }
    for (const v of values) {
      v.base = trackValue(v.tracks, v.base, endTime)
      v.tracks = []
    }
  }

  let cutAt = null
  /** A new scene: its context, its own time from 0, nothing on its timeline yet. */
  G.__begin = (ctxText) => {
    restoreGlobals()
    CTX = JSON.parse(ctxText)
    sceneNo++
    programRandom = mulberry32(CTX.seed || 1)
    cutAt = typeof CTX.cutAt === 'number' ? CTX.cutAt : null
    T = 0
    endTime = 0
    actions.length = 0
    steps.length = 0
    logs.length = 0
    warnings.clear()
    waiters.length = 0
    cameraActions.length = 0
    pointerActions.length = 0
    cues.length = 0
    edits.length = 0
    reparents.length = 0
    activeSpans.length = 0
    sampleErrors.clear()
    markTimes.clear()
    asyncErrors = []
    collector = null
    finalSampling = false
    const items = CTX.stage && CTX.stage.items
    for (const e of objects) {
      if (e.kind === 'node') {
        // Items from before the stage: where they are now, or gone.
        const info = CTX.nodes[e.ref]
        if (!info) e.gone = true
        else {
          e.gone = false
          e.bounds = info.bounds
          e.pivot = [info.bounds.x + info.bounds.width / 2, info.bounds.y + info.bounds.height / 2]
        }
        continue
      }
      // An object whose items are no longer on the board (the learner erased them, or undid the scene).
      if (items && e.kind !== 'group' && !e.gone && !items[String(e.id)]) {
        e.gone = true
        e.vis = 'hidden'
        e.base = { ...(e.base || {}), opacity: 1, draw: 0, fill: 0 }
      }
    }
  }

  const traceCreator = creator('trace', trace, { optIndex: 2, skip: [0, 1], always: true })

  /** Values, functions and objects kept from one program to the next on this board. */
  const stage = {}

  const api = {
    stroke: creator('stroke', stroke, { optIndex: 1 }),
    line: creator('line', line, { optIndex: 4 }),
    arrow: creator('arrow', arrow, { optIndex: 4 }),
    circle: creator('circle', circle, { optIndex: 3 }),
    ellipse: creator('ellipse', ellipse, { optIndex: 4 }),
    rect: creator('rect', rect, { optIndex: 4 }),
    polygon: creator('polygon', polygon, { optIndex: 1 }),
    path: creator('path', path, { optIndex: 1 }),
    plot: creator('plot', plot, { optIndex: 1, skip: [0] }),
    write: creator('write', write, { optIndex: 1 }),
    tex: creator('tex', tex, { optIndex: 1 }),
    text: creator('text', text, { optIndex: 1 }),
    around: creator('around', around, { optIndex: 1 }),
    label: labelApi,
    trace: (fn, opts) => traceCreator(fn, T, opts),
    shader: creator('shader', shader, { optIndex: 1 }),
    canvas: creator('canvas', canvas, { optIndex: 1 }),
    program: creator('program', program, { optIndex: 1 }),
    html,
    image,
    copy,
    space,
    group,
    board,
    value,
    draw: collecting(draw),
    fillIn: collecting(fillIn),
    fadeIn: collecting(fadeIn),
    fadeOut: collecting(fadeOut),
    erase: collecting(erase),
    move: collecting(move),
    tween: collecting(tween),
    edit: collecting(edit),
    wait,
    step,
    all,
    camera: collecting(camera),
    point: collecting(point),
    say,
    mark,
    stage
  }
  if (NO_CODE_ITEMS) for (const key of ['shader', 'canvas', 'program']) delete api[key]
  if (NO_HTML) delete api.html
  for (const [key, value] of Object.entries(api)) Object.defineProperty(G, key, { value, enumerable: true, writable: false, configurable: false })

  // ---------- Lock the stage ----------
  // Every program of a board runs in this one context. So that no program can
  // change the scene API or a built-in (JSON.stringify, Array.prototype.map, …)
  // for the programs after it, or for this file's own code: every object
  // reachable from a global is frozen, every global is locked, and each
  // program starts with the globals as they are here (QuickJS lets
  // Object.defineProperty replace even a locked property of the global
  // object, so __begin puts back any that a program replaced or deleted).
  // Only `stage` stays a free, writable object; programs may still add
  // globals of their own.

  // A frozen prototype makes a plain assignment like `obj.toString = f` or
  // `this.name = "MyError"` fail (the "override mistake"). For the properties
  // that programs commonly assign, an accessor keeps that working: the
  // assignment defines an own property on the object instead.
  const tame = (proto, names) => {
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(proto, name)
      if (!d || !('value' in d) || !d.configurable) continue
      const value = d.value
      Object.defineProperty(proto, name, {
        get() {
          return value
        },
        set(next) {
          if (this === proto) throw new TypeError(`The built-in ${name} cannot be changed`)
          Object.defineProperty(this, name, { value: next, writable: true, enumerable: true, configurable: true })
        },
        enumerable: d.enumerable,
        configurable: false
      })
    }
  }
  tame(Object.prototype, ['constructor', 'toString', 'valueOf', 'toLocaleString'])
  tame(Function.prototype, ['constructor', 'toString'])
  tame(Array.prototype, ['constructor', 'toString'])
  for (const E of [Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError]) {
    tame(E.prototype, ['constructor', 'name', 'message', 'toString'])
  }

  const frozen = new Set()
  const freezeAll = (root) => {
    const todo = [root]
    while (todo.length) {
      const obj = todo.pop()
      if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) continue
      if (obj === stage || obj === G || frozen.has(obj)) continue
      frozen.add(obj)
      Object.freeze(obj)
      todo.push(Object.getPrototypeOf(obj))
      for (const key of Reflect.ownKeys(obj)) {
        const d = Object.getOwnPropertyDescriptor(obj, key)
        if (!d) continue
        if ('value' in d) todo.push(d.value)
        else todo.push(d.get, d.set)
      }
    }
  }
  // Intrinsics that no global names directly.
  const hidden = [
    [][Symbol.iterator](),
    new Map()[Symbol.iterator](),
    new Set()[Symbol.iterator](),
    ''[Symbol.iterator](),
    function* () {},
    (function* () {})(),
    async function () {},
    async function* () {},
    (async function* () {})(),
    Object.getPrototypeOf(Int8Array)
  ]
  if (typeof ''.matchAll === 'function') hidden.push(''.matchAll(/(?:)/g))
  for (const item of hidden) freezeAll(item)
  /** Every global as this file leaves it: key → its locked descriptor. */
  const globals = new Map()
  for (const key of Reflect.ownKeys(G)) {
    const d = Object.getOwnPropertyDescriptor(G, key)
    if (!d) continue
    let locked
    if ('value' in d) {
      if (d.value !== stage) freezeAll(d.value)
      locked = { value: d.value, writable: false, enumerable: d.enumerable, configurable: false }
    } else {
      freezeAll(d.get)
      freezeAll(d.set)
      locked = { get: d.get, set: d.set, enumerable: d.enumerable, configurable: false }
    }
    if (d.configurable) Object.defineProperty(G, key, locked)
    globals.set(key, locked)
  }
  const sameDescriptor = (a, b) => ('value' in b ? Object.is(a.value, b.value) : a.get === b.get && a.set === b.set)
  /** Put back each global that the program before replaced or deleted. */
  function restoreGlobals() {
    for (const [key, locked] of globals) {
      const now = Reflect.getOwnPropertyDescriptor(G, key)
      if (now && sameDescriptor(now, locked)) continue
      try {
        Reflect.deleteProperty(G, key)
        Object.defineProperty(G, key, locked)
      } catch {
        // QuickJS replaces it anyway; the check below names a failure.
      }
      const back = Reflect.getOwnPropertyDescriptor(G, key)
      if (!back || !sameDescriptor(back, locked)) throw new Error(`The scene library could not restore the global ${String(key)}`)
    }
  }
})()
