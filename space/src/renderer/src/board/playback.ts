import { OWN_ROTATION } from './rotation'
import type { BoardNode, Point } from './types'

/**
 * Live-scene playback on the board: how a node looks at this moment, while a
 * scene plays. The board's nodes already hold the scene's final state (saved,
 * one undo step); an override shows a node partly drawn, faded, moved or
 * recoloured on the way there. Ghosts are nodes that the scene removes
 * (erase, fadeOut): they show during playback only.
 */

/** A 2D affine matrix [a, b, c, d, e, f] in board points, applied to the node's final world geometry. */
export type PlaybackMatrix = [number, number, number, number, number, number]

/**
 * How one node looks now. An override is never changed after it is made: a
 * node whose look stays the same keeps the same override object from frame
 * to frame.
 */
export interface NodeOverride {
  /** World transform from the final geometry to what shows now. */
  matrix?: PlaybackMatrix
  /** 0..1, multiplies the node's own opacity. */
  opacity?: number
  /** 0..1: the share drawn (ink along its points, svg outlines along their length, other nodes wiped in from the left). */
  reveal?: number
  /** 0..1: the share of the fill shown (svg fills). */
  fill?: number
  /** The colour now (ink colour; svg stroke and text colour). */
  color?: string
  /** A changing vector shape: its path "d" now (in the node's own coordinates). */
  d?: string
  /** A changing vector shape: its stroke width now. */
  strokeWidth?: number
  /** Changing text: its HTML now. */
  html?: string
  /** Worlds: param values now, merged over the node's own params. */
  params?: Record<string, number>
  /** Content: inline style values now (an edit() on its way), camelCase keys. */
  style?: Record<string, string>
}

/** The pen tip: where a stroke is being drawn now. */
export interface PlaybackTip {
  point: Point
  color: string
  size: number
  /** pen (default): the tip of a stroke being drawn; pointer: a tutor's hand pointing. */
  kind?: 'pen' | 'pointer'
  /** 0..1 (fading in or out). */
  alpha?: number
  /** The pointer goes to points of worlds: `at` stands in for each one in `point`, by `share`. */
  follows?: Array<{ world: string; point: string; at: Point; share: number }>
}

export interface PlaybackFrame {
  /** The look of each node that does not show as committed now. */
  overrides: ReadonlyMap<string, NodeOverride>
  /**
   * The nodes whose override changed (was added, replaced or removed) since
   * the frame before. null or missing: any node can have changed.
   */
  changed?: ReadonlySet<string> | null
  /** Nodes not on the board that show during playback: top-level, in world coordinates. */
  ghosts: readonly BoardNode[]
  tips: readonly PlaybackTip[]
  /** Ink that exists only now (changing ink objects): top-level, in world coordinates, painted on the canvas. The player changes their points from frame to frame. */
  inks?: readonly BoardNode[]
  /** The scene clock of each world a scene plays: scene time, playing or held, step name, duration. */
  clocks?: ReadonlyMap<string, { t: number; playing: boolean; step: string | null; end: number }>
}

// ---------- Ink: the drawn share of a stroke ----------

const lengthCache = new WeakMap<object, Float64Array>()

/** Cumulative arc length at each point. */
function cumulative(points: ReadonlyArray<readonly [number, number, number]>): Float64Array {
  let cached = lengthCache.get(points)
  if (cached) return cached
  cached = new Float64Array(points.length)
  for (let i = 1; i < points.length; i++) cached[i] = cached[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  lengthCache.set(points, cached)
  return cached
}

/** The first `share` (0..1) of a stroke's points, by length, ending in an interpolated point. */
export function revealPoints<P extends readonly [number, number, number]>(points: readonly P[], share: number): P[] {
  if (share >= 1 || points.length < 2) return points as P[]
  if (share <= 0) return []
  const lengths = cumulative(points)
  const target = lengths[lengths.length - 1] * share
  const out: P[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    if (lengths[i] <= target) {
      out.push(points[i])
      continue
    }
    const span = lengths[i] - lengths[i - 1] || 1
    const k = (target - lengths[i - 1]) / span
    const a = points[i - 1]
    const b = points[i]
    out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k] as unknown as P)
    break
  }
  return out
}

// ---------- Content: the same override on DOM elements ----------

const GEOMETRY = 'path, line, polyline, polygon, circle, ellipse, rect'

interface ShapeInfo {
  dash: string
  offset: string
  fillOpacity: string
  /** The path length; null when the geometry changed since it was measured (it is measured again when a reveal needs it). */
  length: number | null
  pattern: number[] | null
  baseFill: number
}

interface Saved {
  transform: string
  transformOrigin: string
  opacity: string
  clipPath: string
  color: string
  overflow: string
  /** The markup before a d or html override. */
  html: string | null
  /** Inline style values before a style override, by camelCase key. */
  styles: Record<string, string> | null
  /** The override shown now, and the origin and own opacity it was shown with (null: none yet). */
  last: NodeOverride | null
  origin: Point
  baseOpacity: number
  /** An svg node's shapes, in document order (found once). */
  shapes: SVGGeometryElement[] | null
}
const savedStyles = new WeakMap<HTMLElement, Saved>()
const savedShapes = new WeakMap<SVGGeometryElement, ShapeInfo>()

function shapeInfo(element: SVGGeometryElement): ShapeInfo {
  let info = savedShapes.get(element)
  if (!info) {
    const attr = element.getAttribute('stroke-dasharray')
    const pattern = attr && attr !== 'none' ? attr.split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v) && v >= 0) : null
    const fo = Number(element.getAttribute('fill-opacity') ?? '1')
    info = {
      dash: element.style.strokeDasharray,
      offset: element.style.strokeDashoffset,
      fillOpacity: element.style.fillOpacity,
      length: null,
      pattern: pattern && pattern.length && pattern.some((v) => v > 0) ? pattern : null,
      baseFill: Number.isFinite(fo) ? fo : 1
    }
    savedShapes.set(element, info)
  }
  return info
}

/** The shape's path length (measured once per geometry). */
function shapeLength(element: SVGGeometryElement, info: ShapeInfo): number {
  if (info.length === null) {
    try {
      info.length = element.getTotalLength()
    } catch {
      info.length = 0
    }
  }
  return info.length
}

/** A dash list that shows the first `shown` length of a path drawn with `pattern` (or solid). */
function revealDash(length: number, shown: number, pattern: number[] | null): { dash: string; offset: string } {
  if (!pattern) return { dash: `${length} ${length}`, offset: `${length - shown}` }
  const out: number[] = []
  let at = 0
  let k = 0
  while (at < shown && out.length < 2000) {
    const piece = pattern[k % pattern.length]
    const on = k % 2 === 0
    const use = Math.min(piece, shown - at)
    out.push(on ? use : piece)
    at += on ? use : piece
    k++
  }
  if (out.length % 2 === 1) out.push(length + 1)
  else out[out.length - 1] += length + 1
  return { dash: out.map((v) => Math.round(v * 100) / 100).join(' '), offset: '0' }
}

function revealSvg(element: HTMLElement, saved: Saved, share: number | undefined, fill: number | undefined): void {
  const shapes = (saved.shapes ??= [...element.querySelectorAll<SVGGeometryElement>(GEOMETRY)])
  const partial = share !== undefined && share < 1
  let total = 0
  if (partial) {
    for (const shape of shapes) total += shapeLength(shape, shapeInfo(shape))
    total ||= 1
  }
  // Shapes draw one after another, in document order, by length.
  let start = 0
  for (const shape of shapes) {
    const info = shapeInfo(shape)
    if (!partial) {
      shape.style.strokeDasharray = info.dash
      shape.style.strokeDashoffset = info.offset
    } else {
      const length = shapeLength(shape, info)
      const local = Math.max(0, Math.min(1, (share * total - start) / (length || 1)))
      const { dash, offset } = revealDash(length, length * local, info.pattern)
      shape.style.strokeDasharray = dash
      shape.style.strokeDashoffset = offset
      start += length
    }
    shape.style.fillOpacity = fill === undefined || fill >= 1 ? info.fillOpacity : String(info.baseFill * Math.max(0, fill))
  }
}

function clearSvg(element: HTMLElement, saved: Saved): void {
  for (const shape of saved.shapes ?? element.querySelectorAll<SVGGeometryElement>(GEOMETRY)) {
    const info = savedShapes.get(shape)
    if (!info) continue
    shape.style.strokeDasharray = info.dash
    shape.style.strokeDashoffset = info.offset
    shape.style.fillOpacity = info.fillOpacity
    savedShapes.delete(shape)
  }
}

const sameMatrix = (a: PlaybackMatrix | undefined, b: PlaybackMatrix | undefined): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false
  return true
}

const sameStyle = (a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/**
 * Show an override on a content element. `origin` is the element's world
 * top-left (its layout box), so a world matrix becomes a CSS transform. Only
 * the values that differ from the override shown before are written.
 */
export function applyElementOverride(element: HTMLElement, override: NodeOverride, origin: Point, baseOpacity: number): void {
  let saved = savedStyles.get(element)
  if (!saved) {
    saved = {
      transform: element.style.transform,
      transformOrigin: element.style.transformOrigin,
      opacity: element.style.opacity,
      clipPath: element.style.clipPath,
      color: element.style.color,
      overflow: element.style.overflow,
      html: null,
      styles: null,
      last: null,
      origin,
      baseOpacity,
      shapes: null
    }
    savedStyles.set(element, saved)
  }
  const last = saved.last
  const moved = saved.origin[0] !== origin[0] || saved.origin[1] !== origin[1]
  if (last === override && !moved && saved.baseOpacity === baseOpacity) return
  const first = last === null
  const m = override.matrix
  if (first || !sameMatrix(last.matrix, m) || (m && moved)) {
    if (m) {
      const [px, py] = origin
      const e = m[0] * px + m[2] * py + m[4] - px
      const f = m[1] * px + m[3] * py + m[5] - py
      element.style.transformOrigin = '0 0'
      // The element's own rotation stays under the world matrix: the matrix applies to the final geometry.
      element.style.transform = `matrix(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${e}, ${f})${element.dataset.rotation ? ` ${OWN_ROTATION}` : ''}`
    } else {
      element.style.transform = saved.transform
      element.style.transformOrigin = saved.transformOrigin
    }
  }
  if (first || last.opacity !== override.opacity || saved.baseOpacity !== baseOpacity) {
    element.style.opacity = override.opacity === undefined || override.opacity >= 1 ? saved.opacity : String(Math.max(0, override.opacity) * baseOpacity)
  }
  const recolored = first || last.color !== override.color
  const reshaped = first || last.html !== override.html || last.d !== override.d || last.strokeWidth !== override.strokeWidth
  // Changing text makes the node's own colour transparent: a new colour or new content sets it again.
  if (recolored || reshaped) element.style.color = override.color ?? saved.color
  if (first || !sameStyle(last.style, override.style)) applyStyleOverride(element, saved, override.style)
  if (reshaped || recolored) applyContentOverride(element, saved, override)
  const svg = element.dataset.kind === 'svg'
  if (svg) {
    // After the content override: a new path "d" changes the lengths that a reveal uses.
    if (first || reshaped || last.reveal !== override.reveal || last.fill !== override.fill) revealSvg(element, saved, override.reveal, override.fill)
    if (first) element.style.clipPath = saved.clipPath
  } else if (first || last.reveal !== override.reveal) {
    if (override.reveal !== undefined && override.reveal < 1) {
      // Typeset text and other boxes wipe in from the left, like a line being written.
      const hidden = Math.max(0, Math.min(100, (1 - override.reveal) * 100))
      element.style.clipPath = `inset(-30% ${hidden}% -30% -10%)`
    } else element.style.clipPath = saved.clipPath
  }
  saved.last = override
  saved.origin = origin
  saved.baseOpacity = baseOpacity
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** Inline styles of now (edit()): set over the node's own; keys no longer overridden go back. */
function applyStyleOverride(element: HTMLElement, saved: Saved, style: Record<string, string> | undefined): void {
  const before = saved.styles ?? {}
  for (const key of Object.keys(before)) {
    if (style && key in style) continue
    element.style.setProperty(kebab(key), before[key])
    delete before[key]
  }
  if (style) {
    for (const [key, value] of Object.entries(style)) {
      if (!(key in before)) before[key] = element.style.getPropertyValue(kebab(key))
      element.style.setProperty(kebab(key), value)
    }
  }
  saved.styles = Object.keys(before).length ? before : null
}

/**
 * A changing shape or text: show its geometry or words of now. A shape gets
 * its path "d" changed in place; text gets an overlay over its own (hidden)
 * children, so React's nodes are never replaced.
 */
function applyContentOverride(element: HTMLElement, saved: Saved, override: NodeOverride): void {
  if (override.html !== undefined) {
    let overlay = element.querySelector<HTMLElement>(':scope > .live-text-now')
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.className = 'live-text-now'
      overlay.dataset.color = getComputedStyle(element).color
      for (const child of element.children) (child as HTMLElement).style.visibility = 'hidden'
      if (saved.html === null) saved.html = 'text'
      element.appendChild(overlay)
      element.dataset.liveText = '1'
    }
    // The node's own words go transparent; the overlay shows the words of now in the node's colour.
    overlay.style.color = override.color ?? overlay.dataset.color ?? ''
    element.style.color = 'transparent'
    if (overlay.dataset.html !== override.html) {
      overlay.innerHTML = override.html
      overlay.dataset.html = override.html
    }
    return
  }
  if (override.d !== undefined && element.dataset.kind === 'svg') {
    const shape = element.querySelector<SVGPathElement>('path')
    if (!shape) return
    // The saved path belongs to one path element: when the node's markup is replaced (a scene committed it
    // again), the new element holds the node's own geometry, and that is what shows when the override ends.
    if (saved.html === null || savedPaths.get(element)?.shape !== shape) {
      saved.html = 'svg'
      savedPaths.set(element, { shape, d: shape.getAttribute('d') ?? '', width: shape.getAttribute('stroke-width') })
    }
    const svg = element.querySelector('svg')
    if (svg) svg.style.overflow = 'visible'
    element.style.overflow = 'visible'
    if (shape.getAttribute('d') !== override.d) {
      shape.setAttribute('d', override.d)
      shapeInfo(shape).length = null
    }
    if (override.strokeWidth !== undefined) shape.setAttribute('stroke-width', String(Math.round(override.strokeWidth * 100) / 100))
    return
  }
  if (saved.html !== null) restoreMarkup(element, saved)
}

const savedPaths = new WeakMap<HTMLElement, { shape: SVGPathElement; d: string; width: string | null }>()

function restoreMarkup(element: HTMLElement, saved: Saved): void {
  if (saved.html === 'text') {
    element.querySelector(':scope > .live-text-now')?.remove()
    for (const child of element.children) (child as HTMLElement).style.visibility = ''
    delete element.dataset.liveText
  } else if (saved.html === 'svg') {
    const shape = element.querySelector<SVGPathElement>('path')
    const original = savedPaths.get(element)
    if (shape && original && original.shape === shape) {
      shape.setAttribute('d', original.d)
      if (original.width === null) shape.removeAttribute('stroke-width')
      else shape.setAttribute('stroke-width', original.width)
      const info = savedShapes.get(shape)
      if (info) info.length = null
    }
    const svg = element.querySelector('svg')
    if (svg) svg.style.overflow = ''
    element.style.overflow = saved.overflow
    savedPaths.delete(element)
  }
  saved.html = null
}

/** Put back what applyElementOverride changed. */
export function clearElementOverride(element: HTMLElement): void {
  const saved = savedStyles.get(element)
  if (!saved) return
  applyStyleOverride(element, saved, undefined)
  restoreMarkup(element, saved)
  element.style.transform = saved.transform
  element.style.transformOrigin = saved.transformOrigin
  element.style.opacity = saved.opacity
  element.style.clipPath = saved.clipPath
  element.style.color = saved.color
  savedStyles.delete(element)
  if (element.dataset.kind === 'svg') clearSvg(element, saved)
}
