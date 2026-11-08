/**
 * The page board (decisions D11, "The whole page is one board"): one layer over the whole page
 * holds every board item — the windows, the loose ink and the visitor's marks — in one z-order.
 * A press on an item with the select tool brings it to the front and drags it; the hand tool
 * moves the board (its dot grid and every item), not the page content. The visitor's marks
 * stay until the eraser removes them.
 *
 * Every item is an element with its own canvas. The animated drawings repaint in one animation
 * frame loop while they are on screen; a mark is painted once. What is being drawn now (a
 * shape, a pen stroke, a text, the eraser's ring) is the draft: it paints on one fixed canvas
 * over the viewport, with the same painter as a finished mark, in the same loop. With reduced
 * motion the drawings are painted once, finished.
 *
 * Coordinates: "world" units are design units (layout.ts) from the frame's origin (the hero's
 * centre on a desktop, its top centre on a phone); one unit is `u` CSS px. "Page px" are CSS px
 * from the top left of the page (the host).
 */
import { hex } from '@/lib/board/colors'
import type { InkPoint } from '@/lib/board/hand'
import { Ink, Pen, write } from '@/lib/board/kit'
import { drawStroke } from '@/lib/board/paint'
import { PEN_WIDTH, PenStroke } from '@/lib/pen-stroke'
import { shellParts, shellSizes, STEP_GAP, stepLine } from '@/lib/shell-steps'
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

/** A visitor's mark, in world units. */
type Mark =
  | { kind: 'ink'; points: InkPoint[] }
  | { kind: 'shape'; shape: 'rect' | 'ellipse' | 'arrow' | 'line'; a: XY; b: XY }
  | { kind: 'text'; text: string; ink: Ink }

/** A board item: a window, a loose drawing or a mark. */
interface Item {
  el: HTMLElement
  /** None for an item without a canvas. */
  canvas: HTMLCanvasElement | null
  g: Pen | null
  /** Animated items (windows, loose ink) have a drawing and a start; a mark has its geometry. */
  draw?: Draw
  start: number
  def?: SpriteDef
  mark?: Mark
  window: boolean
  /** The full size in world units at size 1 (a window's includes its title strip). */
  w: number
  h: number
  /** The place now (null: not shown in this layout), and the visitor's drag in world units. */
  place: Place | null
  dx: number
  dy: number
  /** The canvas's height in world units (a window's body). */
  bodyH: number
  /** A mark's box: the world point at the canvas's top left. */
  at: XY
  z: number
  onScreen: boolean
  /** A drawing that said it is finished and still (its Draw returned true): painted only on a layout. */
  settled?: boolean
}

type Press =
  | { kind: 'item'; item: Item; from: XY; start: XY }
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

/** The outline of a shape mark (world units). */
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

/** Is p (world units, in the mark's own place) within `reach` of the mark? */
function touches(m: Mark, q: XY, reach: number): boolean {
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

/** A mark's box in world units, with room for its line and an arrow head. */
function markBox(m: Mark): { x0: number; y0: number; x1: number; y1: number } {
  if (m.kind === 'text') return m.ink.box
  const pts: XY[] = m.kind === 'ink' ? m.points.map(([x, y]) => [x, y] as XY) : shapeLines(m).flat()
  const pad = m.kind === 'ink' ? PEN_WIDTH * 1.4 : m.kind === 'shape' && m.shape === 'arrow' ? 24 : SHAPE_WIDTH
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
}

export function mountBoard(o: {
  /** The page: the board covers it and takes the presses. */
  host: HTMLElement
  /** The hero: the frame's origin and size come from it. */
  hero: HTMLElement
  /** The board layer (in the host), its items, the draft canvas (fixed over the viewport) and the text tool's field. */
  layer: HTMLElement
  /** The layer behind the app shell's window: the use case steps' ink (layout.ts `step`). It pans with the board. */
  back: HTMLElement
  draft: HTMLCanvasElement
  field: HTMLInputElement
  sprites: SpriteDef[]
  onChange(state: HeroState): void
}): Engine {
  const { host, hero, layer, back, draft, field } = o
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const css = getComputedStyle(host)
  const inkColor = css.getPropertyValue('--ink').trim() || hex('accent')
  const caretColor = css.getPropertyValue('--accent').trim() || hex('accent')
  const eraserColor = css.getPropertyValue('--eraser-ring').trim() || hex('text')
  const draftCtx = draft.getContext('2d')!
  const dg = new Pen(draftCtx)

  let z = 0
  const items: Item[] = o.sprites.map((def) => {
    const el = host.querySelector<HTMLElement>(`[data-sprite="${def.id}"]`)!
    const canvas = el.querySelector('canvas')
    const item: Item = {
      el,
      canvas,
      g: canvas ? new Pen(canvas.getContext('2d')!) : null,
      draw: def.make?.(),
      // A step's ink and an anchored item draw on when they first come on screen (the IntersectionObserver below).
      start: def.step || def.anchor ? Infinity : def.start,
      def,
      window: def.window,
      w: def.w,
      h: def.h,
      place: def.desk,
      dx: 0,
      dy: 0,
      bodyH: def.window ? def.h - BAR : def.h,
      at: [0, 0],
      z: ++z,
      onScreen: true
    }
    el.style.zIndex = String(item.z)
    return item
  })

  let state: HeroState = { tool: 'select', lock: false }
  let W = 0
  let u = 1
  let dpr = 1
  let origin: XY = [0, 0]
  const pan: XY = [0, 0]
  let press: Press | null = null
  let pointerId = -1
  let editing: { at: XY; text: string; ink: Ink | null } | null = null
  let eraserAt: XY | null = null
  let draftShown = false
  let frame = 0
  let suppressClick = false
  let paintAll = true
  let overShell = false
  /** The window under the pointer or held: it shows as the active window (data-active, Board.module.css .quiet). */
  let active: Item | null = null
  const t0 = performance.now()

  // ---------- Layout ----------

  /** CSS px rounded to whole device pixels. */
  const snap = (px: number): number => Math.round(px * dpr) / dpr

  /**
   * An item's place in page px: the centre, from the world place, its drag and the pan. An item
   * that is not turned is moved by the part of a device pixel that its canvas is off the pixel
   * grid, so the browser shows the canvas's pixels one to one and does not resample (soften) it.
   */
  const placeItem = (item: Item): void => {
    moveItem(item)
    snapItem(item, gridBox(item))
  }
  // Its two halves, so layout() writes every item first and reads the boxes once: a read after each item's write was
  // a layout for each item.
  const moveItem = (item: Item): void => {
    item.el.style.translate = `${item.dx * u}px ${item.dy * u}px`
  }
  /** The canvas's box, read after moveItem, for an item that is not turned. */
  const gridBox = (item: Item): DOMRect | null => (item.canvas && item.place && item.place.r === 0 ? item.canvas.getBoundingClientRect() : null)
  const snapItem = (item: Item, box: DOMRect | null): void => {
    if (!box?.width) return
    const fx = box.left - snap(box.left)
    const fy = box.top - snap(box.top)
    if (fx || fy) item.el.style.translate = `${item.dx * u - fx}px ${item.dy * u - fy}px`
  }

  const sizeCanvas = (item: Item): void => {
    if (!item.canvas) return
    const k = (item.place?.s ?? 1) * u
    const w = Math.max(1, Math.round(item.w * k * dpr))
    const h = Math.max(1, Math.round(item.bodyH * k * dpr))
    if (item.canvas.width !== w || item.canvas.height !== h) {
      item.canvas.width = w
      item.canvas.height = h
    }
    // The canvas shows its bitmap one device pixel to one: its CSS size is the bitmap's size over
    // the device pixel ratio, never a stylesheet's (a mark's canvas has no class).
    item.canvas.style.width = `${w / dpr}px`
    item.canvas.style.height = `${h / dpr}px`
  }

  const layout = (): void => {
    W = host.clientWidth
    // The true device pixel ratio: a canvas with fewer pixels than the screen is scaled up and looks soft.
    dpr = window.devicePixelRatio || 1
    const phone = W < PHONE_BELOW
    u = phone ? Math.min(W / PHONE.w, PHONE.maxU) : Math.min(W / DESK.w, hero.clientHeight / DESK.h)
    origin = phone ? [W / 2, 0] : [W / 2, hero.clientHeight / 2]
    host.style.setProperty('--u', `${u}px`)
    const shell = shellParts(host)
    const hostBox = host.getBoundingClientRect()
    const track = shell?.track.getBoundingClientRect()
    const frame = shell?.frame.getBoundingClientRect()
    const sizes = shell ? shellSizes(shell) : null
    // The anchors' boxes, read before the items' writes below (they do not move the page's elements).
    const anchors = new Map<string, DOMRect | null>()
    for (const item of items) {
      const name = item.def?.anchor
      if (name && !anchors.has(name)) anchors.set(name, host.querySelector<HTMLElement>(`[data-anchor="${name}"]`)?.getBoundingClientRect() ?? null)
    }
    const placed: Item[] = []
    /** Put an item whose place is an offset from (x, y) page px there; its CSS place follows. */
    const placeFrom = (item: Item, place: Place, x: number, y: number): void => {
      const at: Place = { ...place, x: (x - origin[0]) / u + place.x, y: (y - origin[1]) / u + place.y }
      item.place = at
      item.el.style.display = ''
      // Placed: it may show now (Board.module.css .sprite[data-pending]).
      item.el.removeAttribute('data-pending')
      for (const [name, value] of Object.entries({ dx: at.x, dy: at.y, px: at.x, py: at.y })) item.el.style.setProperty(`--${name}`, String(value))
    }
    for (const item of items) {
      if (item.def) item.place = phone ? (item.def.phone ?? null) : item.def.deskOff ? null : item.def.desk
      if (item.def?.step && item.place) {
        // A step's mark: its place is an offset from an anchor in the step's area of the shell's
        // track (layout.ts `step`, lib/shell-steps.ts).
        if (!track || !frame || !sizes) {
          item.place = null
          item.el.style.display = 'none'
          continue
        }
        const { index, side, y: anchor } = item.def.step
        const begins = track.top - hostBox.top + stepLine(sizes.winH, sizes.step, index, sizes.lead)
        const middle = begins + sizes.step / 2
        const y = anchor === 'span' ? middle : anchor === 'upper' ? middle - 0.12 * window.innerHeight : anchor === 'above' ? begins - sizes.winH / 2 : begins
        const x = phone ? W / 2 : side === 'left' ? (frame.left - hostBox.left) / 2 : (frame.right - hostBox.left + W) / 2
        if (anchor === 'span') {
          // The brace spans the step's area, less the gap to the next one.
          item.h = item.bodyH = Math.max(40, (sizes.step - STEP_GAP) / u / item.place.s)
          item.el.style.setProperty('--h', String(item.h))
        } else if (anchor === 'upper') {
          // The question fills its margin's width, less a little air to the window and the page's edge.
          const margin = side === 'left' ? frame.left - hostBox.left : W - (frame.right - hostBox.left)
          item.w = Math.max(40, (margin * 0.84) / u / item.place.s)
          item.el.style.setProperty('--w', String(item.w))
        }
        placeFrom(item, item.place, x, y)
      }
      if (item.def?.anchor && item.place) {
        // An anchored item: its place is an offset from the top centre of its page element (layout.ts `anchor`).
        const box = anchors.get(item.def.anchor)
        if (!box) {
          item.place = null
          item.el.style.display = 'none'
          continue
        }
        placeFrom(item, item.place, box.left - hostBox.left + box.width / 2, box.top - hostBox.top)
      }
      if (!item.place) continue
      sizeCanvas(item)
      moveItem(item)
      placed.push(item)
      if (item.mark) paintMark(item)
    }
    const boxes = placed.map(gridBox)
    placed.forEach((item, i) => snapItem(item, boxes[i]))
    showPan()
    sizeDraft()
    paintAll = true
    request()
  }

  const showPan = (): void => {
    // In whole device pixels, so the items stay on the pixel grid (placeItem).
    const x = snap(pan[0] * u)
    const y = snap(pan[1] * u)
    layer.style.translate = `${x}px ${y}px`
    back.style.translate = layer.style.translate
    // The dot grid moves with the board.
    host.style.setProperty('--pan-x', `${x}px`)
    host.style.setProperty('--pan-y', `${y}px`)
  }

  const sizeDraft = (): void => {
    const w = Math.max(1, Math.round(window.innerWidth * dpr))
    const h = Math.max(1, Math.round(window.innerHeight * dpr))
    if (draft.width !== w || draft.height !== h) {
      draft.width = w
      draft.height = h
    }
  }

  // ---------- Painting ----------

  /** Paint an animated item; true when its drawing says it is finished and still. */
  const paintSprite = (item: Item, t: number): boolean | void => {
    if (!item.place || !item.draw || !item.canvas || !item.g) return false
    const c = item.g.ctx
    const k = item.place.s * u * dpr
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, item.canvas.width, item.canvas.height)
    c.setTransform(k, 0, 0, k, 0, 0)
    c.lineCap = 'round'
    c.lineJoin = 'round'
    return item.draw(item.g, still ? 1e4 : t - item.start, still, { w: item.w, h: item.bodyH })
  }

  /** Draw a mark in world units on a context whose transform maps world units. */
  const drawMark = (g: Pen, m: Mark): void => {
    const c = g.ctx
    c.lineCap = 'round'
    c.lineJoin = 'round'
    if (m.kind === 'ink') drawStroke(c, { points: m.points, color: inkColor, width: PEN_WIDTH }, 0, 1, m.points)
    else if (m.kind === 'text') m.ink.draw(c)
    else if (m.shape === 'rect') g.line(shapeLines(m)[0], inkColor, SHAPE_WIDTH, true)
    else if (m.shape === 'ellipse') {
      const [[x0, y0], [x1, y1]] = [m.a, m.b]
      g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, inkColor, SHAPE_WIDTH)
    } else if (m.shape === 'arrow') g.arrow(m.a[0], m.a[1], m.b[0], m.b[1], inkColor, SHAPE_WIDTH)
    else g.seg(m.a[0], m.a[1], m.b[0], m.b[1], inkColor, SHAPE_WIDTH)
  }

  /** A mark's own canvas: painted once (and again when the scale changes). */
  const paintMark = (item: Item): void => {
    if (!item.canvas || !item.g) return
    const c = item.g.ctx
    const k = u * dpr
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, item.canvas.width, item.canvas.height)
    c.setTransform(k, 0, 0, k, -item.at[0] * k, -item.at[1] * k)
    drawMark(item.g, item.mark!)
  }

  /** The draft: what is being drawn now, over the viewport. */
  const paintDraft = (now: number): void => {
    const c = draftCtx
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, draft.width, draft.height)
    const r = host.getBoundingClientRect()
    const k = u * dpr
    c.setTransform(k, 0, 0, k, dpr * (r.left + origin[0] + pan[0] * u), dpr * (r.top + origin[1] + pan[1] * u))
    const marks: Mark[] = []
    if (press?.kind === 'shape') marks.push(press.mark)
    if (press?.kind === 'pen') marks.push({ kind: 'ink', points: press.stroke.shown().map(([x, y, p]) => [...toWorld([x, y]), p] as InkPoint) })
    if (editing?.ink) marks.push({ kind: 'text', text: editing.text, ink: editing.ink })
    for (const m of marks) drawMark(dg, m)
    // The text caret blinks after the text.
    if (editing && Math.floor((now - t0) / 530) % 2 === 0) {
      const x = editing.ink ? editing.ink.box.x1 + 4 : editing.at[0]
      dg.seg(x, editing.at[1] - 2, x, editing.at[1] + TEXT_SIZE, caretColor, 1.6)
    }
    if (eraserAt && state.tool === 'eraser') dg.circle(eraserAt[0], eraserAt[1], ERASER, eraserColor, 1.2)
    draftShown = marks.length > 0 || !!editing || !!eraserAt
  }

  const draftActive = (): boolean => (!!press && press.kind !== 'item' && press.kind !== 'pan') || !!editing || !!eraserAt

  const tick = (now: number): void => {
    frame = 0
    const t = (now - t0) / 1000
    for (const item of items) {
      if (!item.draw || !item.place || !(paintAll || (!still && item.onScreen && !item.settled))) continue
      if (paintSprite(item, t) === true) item.settled = true
    }
    paintAll = false
    if (draftActive() || draftShown) paintDraft(now)
    if (running()) frame = requestAnimationFrame(tick)
  }
  const running = (): boolean => (!still && items.some((item) => item.draw && item.onScreen && !item.settled)) || draftActive()
  const request = (): void => {
    if (!frame) frame = requestAnimationFrame(tick)
  }

  // ---------- Hit tests ----------

  /** Client px to page px. */
  const local = (e: { clientX: number; clientY: number }): XY => {
    const r = host.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  /** Page px to world units. */
  const toWorld = (p: XY): XY => [(p[0] - origin[0]) / u - pan[0], (p[1] - origin[1]) / u - pan[1]]

  const hits = (item: Item, p: XY): boolean => {
    if (!item.place || item.el.style.display === 'none') return false
    if (item.mark) return touches(item.mark, [p[0] - item.dx, p[1] - item.dy], HIT)
    const { x, y, r, s: k } = item.place
    const a = (-r * Math.PI) / 180
    const vx = p[0] - (x + item.dx)
    const vy = p[1] - (y + item.dy)
    const lx = (vx * Math.cos(a) - vy * Math.sin(a)) / k
    const ly = (vx * Math.sin(a) + vy * Math.cos(a)) / k
    return Math.abs(lx) <= item.w / 2 && Math.abs(ly) <= item.h / 2
  }

  /** The topmost item under p (world units). */
  const itemAt = (p: XY): Item | null => {
    let best: Item | null = null
    for (const item of items) if ((!best || item.z > best.z) && !(overShell && item.def?.step) && hits(item, p)) best = item
    return best
  }

  const setActive = (item: Item | null): void => {
    const next = item?.window ? item : null
    if (next === active) return
    active?.el.removeAttribute('data-active')
    active = next
    active?.el.setAttribute('data-active', '')
  }

  const toFront = (item: Item): void => {
    item.z = ++z
    item.el.style.zIndex = String(item.z)
  }

  // ---------- Marks ----------

  const addMark = (mark: Mark): void => {
    const b = markBox(mark)
    const el = document.createElement('div')
    el.className = layer.dataset.markClass ?? ''
    const canvas = document.createElement('canvas')
    el.append(canvas)
    const w = b.x1 - b.x0
    const h = b.y1 - b.y0
    const place: Place = { x: b.x0 + w / 2, y: b.y0 + h / 2, r: 0, s: 1 }
    for (const [name, value] of Object.entries({ w, h, dx: place.x, dy: place.y, dr: 0, ds: 1, px: place.x, py: place.y, pr: 0, ps: 1 })) el.style.setProperty(`--${name}`, String(value))
    layer.append(el)
    const item: Item = { el, canvas, g: new Pen(canvas.getContext('2d')!), mark, start: 0, window: false, w, h, place, dx: 0, dy: 0, bodyH: h, at: [b.x0, b.y0], z: 0, onScreen: false }
    items.push(item)
    toFront(item)
    sizeCanvas(item)
    placeItem(item)
    paintMark(item)
  }

  const removeItem = (item: Item): void => {
    items.splice(items.indexOf(item), 1)
    item.el.remove()
  }

  // ---------- Tools ----------

  const emit = (): void => o.onChange({ ...state })

  const setTool = (tool: ToolId): void => {
    if (editing) commitText()
    state = { ...state, tool }
    if (tool !== 'select') setActive(null)
    // One finger scrolls the page with the select tool; the other tools draw (or pan) with it.
    host.style.touchAction = tool === 'select' ? 'pan-y pinch-zoom' : 'none'
    host.dataset.tool = tool
    eraserAt = null
    request()
    emit()
  }

  /** After one mark: shapes and text go back to Select unless the lock keeps the tool (the app's rule). */
  const afterMark = (): void => {
    if (!state.lock && (SHAPE_TOOLS.has(state.tool) || state.tool === 'text')) setTool('select')
  }

  const startText = (at: XY, page: XY): void => {
    editing = { at, text: '', ink: null }
    field.value = ''
    field.style.left = `${page[0]}px`
    field.style.top = `${page[1]}px`
    field.focus({ preventScroll: true })
    request()
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
    if (e.ink) addMark({ kind: 'text', text: e.text, ink: e.ink })
    if (document.activeElement === field) field.blur()
    request()
    if (e.ink) afterMark()
  }

  const onInput = (): void => {
    if (!editing) return
    editing.text = field.value
    editing.ink = textInk(field.value, editing.at)
    request()
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
    for (let i = 0; i <= steps; i++) {
      const p: XY = [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]
      for (const item of [...items]) if (item.mark && touches(item.mark, [p[0] - item.dx, p[1] - item.dy], ERASER)) removeItem(item)
    }
  }

  // ---------- Pointer ----------

  /** A press on the top bar, the pill or the text field belongs to them. */
  const isUi = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('[data-ui]')
  const isLink = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('a, button')
  /** The app shell's window covers the steps' ink behind it: a press there does not take that ink. */
  const isOverShell = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('[data-shell-frame]')

  const setCursor = (p: XY | null): void => {
    const tool = state.tool
    let cursor = ''
    if (press?.kind === 'item' || press?.kind === 'pan') cursor = 'grabbing'
    else if (tool === 'hand') cursor = 'grab'
    else if (tool === 'text') cursor = 'text'
    else if (tool === 'eraser') cursor = 'none'
    else if (tool !== 'select') cursor = 'crosshair'
    else if (p && itemAt(p)) cursor = 'grab'
    host.style.cursor = cursor
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || isUi(e.target) || press) return
    overShell = isOverShell(e.target)
    const at = local(e)
    const p = toWorld(at)
    if (editing) {
      // A click away ends the text; it starts nothing else.
      commitText()
      e.preventDefault()
      return
    }
    const tool = state.tool
    if (tool === 'select') {
      const item = itemAt(p)
      // Not on an item: the page's own text, button and links work as usual.
      if (!item) return
      toFront(item)
      setActive(item)
      press = { kind: 'item', item, from: [item.dx, item.dy], start: p }
      if (isLink(e.target)) suppressClick = true
    } else {
      // The other tools work everywhere on the board, over the page's content too.
      if (isLink(e.target)) suppressClick = true
      if (tool === 'hand') press = { kind: 'pan', from: [pan[0], pan[1]], start: at }
      else if (tool === 'pen') press = { kind: 'pen', stroke: new PenStroke(at[0], at[1], performance.now()) }
      else if (tool === 'text') {
        e.preventDefault()
        startText(p, at)
        return
      } else if (tool === 'eraser') {
        press = { kind: 'erase', last: p }
        eraserAt = p
        eraseAlong(p, p)
      } else press = { kind: 'shape', mark: { kind: 'shape', shape: tool as 'rect', a: p, b: p } }
    }
    e.preventDefault()
    pointerId = e.pointerId
    host.setPointerCapture(e.pointerId)
    setCursor(p)
    request()
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (press && e.pointerId !== pointerId) return
    const at = local(e)
    const p = toWorld(at)
    if (!press) {
      if (e.pointerType === 'touch') return
      overShell = isOverShell(e.target)
      setActive(state.tool === 'select' ? itemAt(p) : null)
      if (state.tool === 'eraser') {
        eraserAt = p
        request()
      }
      setCursor(p)
      return
    }
    if (press.kind === 'item') {
      const item = press.item
      item.dx = press.from[0] + p[0] - press.start[0]
      item.dy = press.from[1] + p[1] - press.start[1]
      placeItem(item)
    } else if (press.kind === 'pan') {
      pan[0] = press.from[0] + (at[0] - press.start[0]) / u
      pan[1] = press.from[1] + (at[1] - press.start[1]) / u
      showPan()
    } else if (press.kind === 'pen') {
      for (const c of e.getCoalescedEvents?.() ?? [e]) press.stroke.add(...local(c), performance.now())
    } else if (press.kind === 'shape') press.mark.b = p
    else if (press.kind === 'erase') {
      eraseAlong(press.last, p)
      press.last = p
      eraserAt = p
    }
    request()
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (!press || e.pointerId !== pointerId) return
    const done = press
    press = null
    pointerId = -1
    if (done.kind === 'pen') {
      done.stroke.finish(performance.now())
      const points = done.stroke.points.map(([x, y, pressure]) => [...toWorld([x, y]), pressure] as InkPoint)
      if (points.length) addMark({ kind: 'ink', points })
    } else if (done.kind === 'shape') {
      if (dist(done.mark.a, done.mark.b) >= 4) {
        addMark(done.mark)
        afterMark()
      }
    }
    if (e.pointerType === 'touch') eraserAt = null
    // Released: the window stays active only while the pointer is still on it.
    setActive(e.pointerType !== 'touch' && state.tool === 'select' ? itemAt(toWorld(local(e))) : null)
    request()
    setCursor(toWorld(local(e)))
  }

  const onClick = (e: MouseEvent): void => {
    if (!suppressClick) return
    suppressClick = false
    e.preventDefault()
    e.stopPropagation()
  }

  const onPointerLeave = (): void => {
    if (!press) setActive(null)
    if (eraserAt && !press) {
      eraserAt = null
      request()
    }
  }

  // ---------- Keys ----------

  const onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || editing) return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable)) return
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
  resize.observe(hero)
  // The steps' ink follows the app shell's track and window (lib/shell-steps.ts).
  const shell = shellParts(host)
  if (shell) {
    resize.observe(shell.track)
    resize.observe(shell.frame)
  }
  // Anchored items follow their page elements (layout.ts `anchor`).
  for (const anchor of host.querySelectorAll<HTMLElement>('[data-anchor]')) resize.observe(anchor)
  // An animated drawing repaints only while it is on screen (it can be dragged anywhere on the page).
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const item = items.find((each) => each.el === entry.target)
      if (!item) continue
      item.onScreen = entry.isIntersecting
      if (item.onScreen && item.start === Infinity) item.start = (performance.now() - t0) / 1000 + (item.def?.anchor ? item.def.start : 0)
    }
    request()
  })
  for (const item of items) if (item.draw) seen.observe(item.el)
  const onVisibility = (): void => {
    if (!document.hidden) request()
  }
  const onScroll = (): void => {
    if (draftActive() || draftShown) request()
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
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', sizeDraft)
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
      for (const item of items) if (item.mark) item.el.remove()
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
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', sizeDraft)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}
