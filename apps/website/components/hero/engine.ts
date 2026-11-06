/**
 * The hero board (decision D11): the windows and the loose ink, their drawings, and the
 * visitor's tools. One animation frame loop paints every drawing; it stops while the hero is
 * off screen or the tab is hidden, and with reduced motion the drawings are painted once,
 * finished. The visitor's marks (pen, shapes, text) stay until the eraser removes them.
 *
 * Coordinates: "world" units are design units (layout.ts) from the frame's origin; one unit is
 * `u` CSS px. The hand tool pans the layer (windows, loose ink and marks), not the headline.
 */
import { hex } from '@/lib/board/colors'
import type { InkPoint } from '@/lib/board/hand'
import { Ink, Pen, write } from '@/lib/board/kit'
import { drawStroke } from '@/lib/board/paint'
import { PEN_WIDTH, PenStroke } from '@/lib/pen-stroke'
import { BAR, DESK, PHONE, PHONE_BELOW, type Place, type SpriteDef } from './layout'
import type { Draw } from './scene'
import { toolForKey, type ToolId } from './tools'

type XY = [number, number]

/** The app's shape line (tools.ts SHAPE_WIDTHS.medium) and text size (TEXT_SIZES M). */
const SHAPE_WIDTH = 2.5
const TEXT_SIZE = 24
/** A press this close to a mark (world units) takes it; the eraser's reach. */
const HIT = 8
const ERASER = 9
const SHAPE_TOOLS = new Set<ToolId>(['rect', 'ellipse', 'arrow', 'line'])
const DRAW_TOOLS = new Set<ToolId>(['hand', 'rect', 'ellipse', 'arrow', 'line', 'pen', 'text', 'eraser'])

type Mark =
  | { kind: 'ink'; points: InkPoint[]; off: XY }
  | { kind: 'shape'; shape: 'rect' | 'ellipse' | 'arrow' | 'line'; a: XY; b: XY; off: XY }
  | { kind: 'text'; text: string; ink: Ink; off: XY }

interface Sprite {
  def: SpriteDef
  el: HTMLElement
  canvas: HTMLCanvasElement
  g: Pen
  draw: Draw
  /** The visitor's drag, in world units. */
  dx: number
  dy: number
  place: Place | null
  /** The canvas's local size in design units (a window's body). */
  bodyH: number
}

type Press =
  | { kind: 'window'; sprite: Sprite; from: XY; start: XY }
  | { kind: 'mark'; mark: Mark; last: XY }
  | { kind: 'pan'; from: XY; start: XY }
  | { kind: 'pen'; stroke: PenStroke }
  | { kind: 'shape'; mark: Extract<Mark, { kind: 'shape' }> }
  | { kind: 'erase'; last: XY }

export interface HeroState {
  tool: ToolId
  lock: boolean
}

export interface Engine {
  setTool(tool: ToolId): void
  toggleLock(): void
  stop(): void
}

const dist = (a: XY, b: XY): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The distance from p to the segment a–b. */
function toSegment(p: XY, a: XY, b: XY): number {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const len = vx * vx + vy * vy
  const k = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len)) : 0
  return Math.hypot(p[0] - a[0] - vx * k, p[1] - a[1] - vy * k)
}

/** The outline of a shape mark (world units, without its offset). */
function shapeLines(m: Extract<Mark, { kind: 'shape' }>): XY[][] {
  const [x0, y0] = m.a
  const [x1, y1] = m.b
  if (m.shape === 'rect')
    return [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0]
      ]
    ]
  if (m.shape === 'ellipse') {
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const rx = Math.abs(x1 - x0) / 2
    const ry = Math.abs(y1 - y0) / 2
    return [Array.from({ length: 49 }, (_, i) => [cx + rx * Math.cos((i / 48) * Math.PI * 2), cy + ry * Math.sin((i / 48) * Math.PI * 2)] as XY)]
  }
  return [[m.a, m.b]]
}

/** Is p within `reach` of the mark? */
function touches(m: Mark, p: XY, reach: number): boolean {
  const q: XY = [p[0] - m.off[0], p[1] - m.off[1]]
  if (m.kind === 'text') {
    const b = m.ink.box
    return q[0] >= b.x0 - reach && q[0] <= b.x1 + reach && q[1] >= b.y0 - reach && q[1] <= b.y1 + reach
  }
  const lines: XY[][] = m.kind === 'ink' ? [m.points.map(([x, y]) => [x, y] as XY)] : shapeLines(m)
  const r = reach + (m.kind === 'ink' ? PEN_WIDTH : SHAPE_WIDTH) / 2
  for (const line of lines) {
    if (line.length === 1 && dist(q, line[0]) <= r) return true
    for (let i = 1; i < line.length; i++) if (toSegment(q, line[i - 1], line[i]) <= r) return true
  }
  return false
}

export function mountHero(o: {
  host: HTMLElement
  layer: HTMLElement
  marks: HTMLCanvasElement
  field: HTMLInputElement
  sprites: SpriteDef[]
  onChange(state: HeroState): void
}): Engine {
  const { host, layer, marks, field } = o
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const inkColor = getComputedStyle(host).getPropertyValue('--ink').trim() || hex('text')
  const caretColor = getComputedStyle(host).getPropertyValue('--accent').trim() || hex('accent')
  const eraserColor = getComputedStyle(host).getPropertyValue('--eraser-ring').trim() || inkColor
  const marksCtx = marks.getContext('2d')!
  const mg = new Pen(marksCtx)

  const sprites: Sprite[] = o.sprites.map((def) => {
    const el = layer.querySelector<HTMLElement>(`[data-sprite="${def.id}"]`)!
    const canvas = el.querySelector('canvas')!
    return { def, el, canvas, g: new Pen(canvas.getContext('2d')!), draw: def.make(), dx: 0, dy: 0, place: def.desk, bodyH: def.window ? def.h - BAR : def.h }
  })

  let state: HeroState = { tool: 'select', lock: false }
  let W = 0
  let H = 0
  let u = 1
  let dpr = 1
  let origin: XY = [0, 0]
  let phone = false
  const pan: XY = [0, 0]
  let z = 1
  const items: Mark[] = []
  let press: Press | null = null
  let pointerId = -1
  let editing: { at: XY; text: string; ink: Ink | null } | null = null
  let eraserAt: XY | null = null
  let marksDirty = true
  let frame = 0
  let visible = true
  let suppressClick = false
  const t0 = performance.now()

  // ---------- Layout ----------

  const layout = (): void => {
    W = host.clientWidth
    H = host.clientHeight
    dpr = Math.min(2, window.devicePixelRatio || 1)
    phone = W < PHONE_BELOW
    u = phone ? Math.min(W / PHONE.w, PHONE.maxU) : Math.min(W / DESK.w, H / DESK.h)
    origin = phone ? [W / 2, 0] : [W / 2, H / 2]
    host.style.setProperty('--u', `${u}px`)
    for (const s of sprites) {
      s.place = phone ? (s.def.phone ?? null) : s.def.desk
      if (!s.place) continue
      const k = s.place.s * u
      const w = Math.max(1, Math.round(s.def.w * k * dpr))
      const h = Math.max(1, Math.round(s.bodyH * k * dpr))
      if (s.canvas.width !== w || s.canvas.height !== h) {
        s.canvas.width = w
        s.canvas.height = h
      }
      placeSprite(s)
    }
    layer.style.translate = `${pan[0] * u}px ${pan[1] * u}px`
    const mw = Math.max(1, Math.round(W * dpr))
    const mh = Math.max(1, Math.round(H * dpr))
    if (marks.width !== mw || marks.height !== mh) {
      marks.width = mw
      marks.height = mh
    }
    marksDirty = true
    request()
  }

  const placeSprite = (s: Sprite): void => {
    s.el.style.translate = `${s.dx * u}px ${s.dy * u}px`
  }

  // ---------- Painting ----------

  const paintSprite = (s: Sprite, t: number): void => {
    if (!s.place) return
    const c = s.g.ctx
    const k = s.place.s * u * dpr
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, s.canvas.width, s.canvas.height)
    c.setTransform(k, 0, 0, k, 0, 0)
    c.lineCap = 'round'
    c.lineJoin = 'round'
    s.draw(s.g, still ? 1e4 : t - s.def.start, still)
  }

  const paintMarks = (now: number): void => {
    marksDirty = false
    const c = marksCtx
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, marks.width, marks.height)
    c.setTransform(dpr * u, 0, 0, dpr * u, dpr * (origin[0] + pan[0] * u), dpr * (origin[1] + pan[1] * u))
    c.lineCap = 'round'
    c.lineJoin = 'round'
    for (const m of items) paintMark(m)
    if (press?.kind === 'pen') {
      const points = press.stroke.shown().map(([x, y, p]) => [...toWorld([x, y]), p] as InkPoint)
      drawStroke(c, { points, color: inkColor, width: PEN_WIDTH })
    }
    if (editing) {
      if (editing.ink) editing.ink.draw(c)
      // The caret blinks after the text.
      if (Math.floor((now - t0) / 530) % 2 === 0) {
        const x = editing.ink ? editing.ink.box.x1 + 4 : editing.at[0]
        mg.seg(x, editing.at[1] - 2, x, editing.at[1] + TEXT_SIZE, caretColor, 1.6)
      }
    }
    if (eraserAt && state.tool === 'eraser') mg.circle(eraserAt[0], eraserAt[1], ERASER, eraserColor, 1.2)
  }

  const paintMark = (m: Mark): void => {
    const c = marksCtx
    c.save()
    c.translate(m.off[0], m.off[1])
    if (m.kind === 'ink') drawStroke(c, { points: m.points, color: inkColor, width: PEN_WIDTH }, 0, 1, m.points)
    else if (m.kind === 'text') m.ink.draw(c)
    else if (m.shape === 'rect') mg.line(shapeLines(m)[0], inkColor, SHAPE_WIDTH, true)
    else if (m.shape === 'ellipse') {
      const [[x0, y0], [x1, y1]] = [m.a, m.b]
      mg.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, inkColor, SHAPE_WIDTH)
    } else if (m.shape === 'arrow') mg.arrow(m.a[0], m.a[1], m.b[0], m.b[1], inkColor, SHAPE_WIDTH)
    else mg.seg(m.a[0], m.a[1], m.b[0], m.b[1], inkColor, SHAPE_WIDTH)
    c.restore()
  }

  const tick = (now: number): void => {
    frame = 0
    const t = (now - t0) / 1000
    if (!still || !painted) for (const s of sprites) paintSprite(s, t)
    painted = true
    if (marksDirty || editing) paintMarks(now)
    if (running()) frame = requestAnimationFrame(tick)
  }
  let painted = false
  // A hidden tab gets no frames anyway; visibilitychange asks for one when it shows again.
  const running = (): boolean => visible && (!still || !!editing)
  const request = (): void => {
    painted = false
    if (!frame) frame = requestAnimationFrame(tick)
  }
  const dirty = (): void => {
    marksDirty = true
    if (!frame) frame = requestAnimationFrame(tick)
  }

  // ---------- Hit tests ----------

  const local = (e: { clientX: number; clientY: number }): XY => {
    const r = host.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  /** Host px to world units. */
  const toWorld = (p: XY): XY => [(p[0] - origin[0]) / u - pan[0], (p[1] - origin[1]) / u - pan[1]]

  /** The topmost window under p (world units). */
  const windowAt = (p: XY): Sprite | null => {
    let best: Sprite | null = null
    let bestZ = -1
    for (const s of sprites) {
      if (!s.def.window || !s.place) continue
      const { x, y, r, s: k } = s.place
      const a = (-r * Math.PI) / 180
      const vx = p[0] - (x + s.dx)
      const vy = p[1] - (y + s.dy)
      const lx = (vx * Math.cos(a) - vy * Math.sin(a)) / k
      const ly = (vx * Math.sin(a) + vy * Math.cos(a)) / k
      const zi = Number(s.el.style.zIndex) || 0
      if (Math.abs(lx) <= s.def.w / 2 && Math.abs(ly) <= s.def.h / 2 && zi >= bestZ) {
        best = s
        bestZ = zi
      }
    }
    return best
  }

  const markAt = (p: XY): Mark | null => {
    for (let i = items.length - 1; i >= 0; i--) if (touches(items[i], p, HIT)) return items[i]
    return null
  }

  // ---------- Tools ----------

  const emit = (): void => o.onChange({ ...state })

  const setTool = (tool: ToolId): void => {
    if (editing) commitText()
    state = { ...state, tool }
    // One finger scrolls the page unless a drawing tool is chosen.
    host.style.touchAction = DRAW_TOOLS.has(tool) ? 'none' : 'pan-y pinch-zoom'
    host.dataset.tool = tool
    eraserAt = null
    dirty()
    emit()
  }

  /** After one mark: shapes and text go back to Select unless the lock keeps the tool (the app's rule). */
  const afterMark = (): void => {
    if (!state.lock && (SHAPE_TOOLS.has(state.tool) || state.tool === 'text')) setTool('select')
  }

  const startText = (at: XY): void => {
    editing = { at, text: '', ink: null }
    field.value = ''
    const [x, y] = [origin[0] + (at[0] + pan[0]) * u, origin[1] + (at[1] + pan[1]) * u]
    field.style.left = `${x}px`
    field.style.top = `${y}px`
    field.focus({ preventScroll: true })
    dirty()
    if (!frame) frame = requestAnimationFrame(tick)
  }

  const textInk = (text: string, at: XY): Ink | null => {
    if (!text.trim()) return null
    try {
      return write(text, TEXT_SIZE, at[0], at[1], inkColor, { seed: 7 })
    } catch {
      return null
    }
  }

  const commitText = (): void => {
    const e = editing
    if (!e) return
    editing = null
    if (e.ink) items.push({ kind: 'text', text: e.text, ink: e.ink, off: [0, 0] })
    if (document.activeElement === field) field.blur()
    dirty()
    if (e.ink) afterMark()
  }

  const onInput = (): void => {
    if (!editing) return
    editing.text = field.value
    editing.ink = textInk(field.value, editing.at)
    dirty()
  }
  const onFieldKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitText()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (editing) editing.ink = null
      commitText()
    }
  }
  const onFieldBlur = (): void => commitText()

  const eraseAlong = (a: XY, b: XY): void => {
    const steps = Math.max(1, Math.ceil(dist(a, b) / 3))
    let removed = false
    for (let i = 0; i <= steps; i++) {
      const p: XY = [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]
      for (let j = items.length - 1; j >= 0; j--)
        if (touches(items[j], p, ERASER)) {
          items.splice(j, 1)
          removed = true
        }
    }
    if (removed) dirty()
  }

  // ---------- Pointer ----------

  /** A press on the top bar, the pill or the text field belongs to them. */
  const isUi = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('[data-ui]')
  const isLink = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('a, button')

  const setCursor = (p: XY | null): void => {
    const tool = state.tool
    let cursor = 'default'
    if (press?.kind === 'window' || press?.kind === 'mark' || press?.kind === 'pan') cursor = 'grabbing'
    else if (tool === 'hand') cursor = 'grab'
    else if (tool === 'text') cursor = 'text'
    else if (tool === 'eraser') cursor = 'none'
    else if (tool !== 'select') cursor = 'crosshair'
    else if (p && (markAt(p) || windowAt(p))) cursor = 'grab'
    host.style.cursor = cursor
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || isUi(e.target) || press) return
    const at = local(e)
    const p = toWorld(at)
    const link = isLink(e.target)
    if (editing) {
      // A click away ends the text; it starts nothing else.
      commitText()
      e.preventDefault()
      return
    }
    const tool = state.tool
    if (tool === 'select') {
      const mark = markAt(p)
      const win = mark ? null : windowAt(p)
      if (mark) press = { kind: 'mark', mark, last: p }
      else if (win) {
        win.el.style.zIndex = String(++z)
        press = { kind: 'window', sprite: win, from: [win.dx, win.dy], start: p }
      } else return
      // A window over the button takes the press; the button gets no click.
      if (link) suppressClick = true
    } else {
      if (link) return
      if (tool === 'hand') press = { kind: 'pan', from: [pan[0], pan[1]], start: at }
      else if (tool === 'pen') {
        press = { kind: 'pen', stroke: new PenStroke(at[0], at[1], performance.now()) }
        dirty()
      } else if (tool === 'text') {
        e.preventDefault()
        startText(p)
        return
      } else if (tool === 'eraser') {
        press = { kind: 'erase', last: p }
        eraserAt = p
        eraseAlong(p, p)
      } else press = { kind: 'shape', mark: { kind: 'shape', shape: tool as 'rect', a: p, b: p, off: [0, 0] } }
    }
    e.preventDefault()
    pointerId = e.pointerId
    host.setPointerCapture(e.pointerId)
    setCursor(p)
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (press && e.pointerId !== pointerId) return
    const at = local(e)
    const p = toWorld(at)
    if (!press) {
      if (state.tool === 'eraser' && e.pointerType !== 'touch') {
        eraserAt = p
        dirty()
      }
      if (e.pointerType !== 'touch') setCursor(p)
      return
    }
    if (press.kind === 'window') {
      const s = press.sprite
      s.dx = press.from[0] + p[0] - press.start[0]
      s.dy = press.from[1] + p[1] - press.start[1]
      placeSprite(s)
    } else if (press.kind === 'mark') {
      press.mark.off = [press.mark.off[0] + p[0] - press.last[0], press.mark.off[1] + p[1] - press.last[1]]
      press.last = p
      dirty()
    } else if (press.kind === 'pan') {
      pan[0] = press.from[0] + (at[0] - press.start[0]) / u
      pan[1] = press.from[1] + (at[1] - press.start[1]) / u
      layer.style.translate = `${pan[0] * u}px ${pan[1] * u}px`
      dirty()
    } else if (press.kind === 'pen') {
      for (const c of e.getCoalescedEvents?.() ?? [e]) press.stroke.add(...local(c), performance.now())
      dirty()
    } else if (press.kind === 'shape') {
      press.mark.b = p
      dirty()
    } else if (press.kind === 'erase') {
      eraseAlong(press.last, p)
      press.last = p
      eraserAt = p
      dirty()
    }
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (!press || e.pointerId !== pointerId) return
    const done = press
    press = null
    pointerId = -1
    if (done.kind === 'pen') {
      done.stroke.finish(performance.now())
      const points = done.stroke.points.map(([x, y, pressure]) => [...toWorld([x, y]), pressure] as InkPoint)
      if (points.length) items.push({ kind: 'ink', points, off: [0, 0] })
    } else if (done.kind === 'shape') {
      if (dist(done.mark.a, done.mark.b) >= 4) {
        items.push(done.mark)
        afterMark()
      }
    }
    if (e.pointerType === 'touch') eraserAt = null
    dirty()
    setCursor(toWorld(local(e)))
  }

  const onClick = (e: MouseEvent): void => {
    if (!suppressClick) return
    suppressClick = false
    e.preventDefault()
    e.stopPropagation()
  }

  const onPointerLeave = (): void => {
    if (eraserAt && !press) {
      eraserAt = null
      dirty()
    }
  }

  // ---------- Keys ----------

  const onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || editing || !visible) return
    const active = document.activeElement
    if (active && active !== document.body && !host.contains(active)) return
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return
    if (e.key === 'Escape') return setTool('select')
    if (e.key.toUpperCase() === 'Q') {
      toggleLock()
      return
    }
    const tool = toolForKey(e.key)
    if (tool) setTool(tool)
  }

  const toggleLock = (): void => {
    state = { ...state, lock: !state.lock }
    emit()
  }

  // ---------- Wiring ----------

  const resize = new ResizeObserver(layout)
  resize.observe(host)
  const seen = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) request()
  })
  seen.observe(host)
  const onVisibility = (): void => {
    if (!document.hidden) request()
  }

  host.addEventListener('pointerdown', onPointerDown)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerup', onPointerUp)
  host.addEventListener('pointercancel', onPointerUp)
  host.addEventListener('pointerleave', onPointerLeave)
  host.addEventListener('click', onClick, true)
  field.addEventListener('input', onInput)
  field.addEventListener('keydown', onFieldKey)
  field.addEventListener('blur', onFieldBlur)
  window.addEventListener('keydown', onKey)
  document.addEventListener('visibilitychange', onVisibility)
  layout()
  setTool('select')

  return {
    setTool,
    toggleLock,
    stop() {
      cancelAnimationFrame(frame)
      resize.disconnect()
      seen.disconnect()
      host.removeEventListener('pointerdown', onPointerDown)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerup', onPointerUp)
      host.removeEventListener('pointercancel', onPointerUp)
      host.removeEventListener('pointerleave', onPointerLeave)
      host.removeEventListener('click', onClick, true)
      field.removeEventListener('input', onInput)
      field.removeEventListener('keydown', onFieldKey)
      field.removeEventListener('blur', onFieldBlur)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}
