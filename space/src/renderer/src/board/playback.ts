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
  /** Live pixel items: param values now, merged over the node's own params. */
  params?: Record<string, number>
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
}

export interface PlaybackFrame {
  overrides: ReadonlyMap<string, NodeOverride>
  /** Nodes not on the board that show during playback: top-level, in world coordinates. */
  ghosts: readonly BoardNode[]
  tips: readonly PlaybackTip[]
  /** Ink that exists only now (changing ink objects): top-level, in world coordinates, painted on the canvas. */
  inks?: readonly BoardNode[]
  /** The scene clock of each node a scene plays (program items follow it): scene time, playing or held, step name, duration. */
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

interface Saved {
  transform: string
  transformOrigin: string
  opacity: string
  clipPath: string
  color: string
  overflow: string
  /** The markup before a d or html override. */
  html: string | null
}
const savedStyles = new WeakMap<HTMLElement, Saved>()
const savedShapes = new WeakMap<SVGGeometryElement, { dash: string; offset: string; fillOpacity: string; length: number; pattern: number[] | null; baseFill: number }>()

function shapeInfo(element: SVGGeometryElement) {
  let info = savedShapes.get(element)
  if (!info) {
    let length = 0
    try {
      length = element.getTotalLength()
    } catch {
      length = 0
    }
    const attr = element.getAttribute('stroke-dasharray')
    const pattern = attr && attr !== 'none' ? attr.split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v) && v >= 0) : null
    const fo = Number(element.getAttribute('fill-opacity') ?? '1')
    info = {
      dash: element.style.strokeDasharray,
      offset: element.style.strokeDashoffset,
      fillOpacity: element.style.fillOpacity,
      length,
      pattern: pattern && pattern.length && pattern.some((v) => v > 0) ? pattern : null,
      baseFill: Number.isFinite(fo) ? fo : 1
    }
    savedShapes.set(element, info)
  }
  return info
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

function revealSvg(element: HTMLElement, share: number | undefined, fill: number | undefined): void {
  const shapes = [...element.querySelectorAll<SVGGeometryElement>(GEOMETRY)]
  const infos = shapes.map(shapeInfo)
  const total = infos.reduce((sum, info) => sum + info.length, 0) || 1
  // Shapes draw one after another, in document order, by length.
  let start = 0
  shapes.forEach((shape, i) => {
    const info = infos[i]
    if (share === undefined || share >= 1) {
      shape.style.strokeDasharray = info.dash
      shape.style.strokeDashoffset = info.offset
    } else {
      const local = Math.max(0, Math.min(1, (share * total - start) / (info.length || 1)))
      const { dash, offset } = revealDash(info.length, info.length * local, info.pattern)
      shape.style.strokeDasharray = dash
      shape.style.strokeDashoffset = offset
    }
    shape.style.fillOpacity = fill === undefined || fill >= 1 ? info.fillOpacity : String(info.baseFill * Math.max(0, fill))
    start += info.length
  })
}

function clearSvg(element: HTMLElement): void {
  for (const shape of element.querySelectorAll<SVGGeometryElement>(GEOMETRY)) {
    const info = savedShapes.get(shape)
    if (!info) continue
    shape.style.strokeDasharray = info.dash
    shape.style.strokeDashoffset = info.offset
    shape.style.fillOpacity = info.fillOpacity
    savedShapes.delete(shape)
  }
}

/**
 * Show an override on a content element. `origin` is the element's world
 * top-left (its layout box), so a world matrix becomes a CSS transform.
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
      html: null
    }
    savedStyles.set(element, saved)
  }
  const m = override.matrix
  if (m) {
    const [px, py] = origin
    const e = m[0] * px + m[2] * py + m[4] - px
    const f = m[1] * px + m[3] * py + m[5] - py
    element.style.transformOrigin = '0 0'
    element.style.transform = `matrix(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${e}, ${f})`
  } else {
    element.style.transform = saved.transform
    element.style.transformOrigin = saved.transformOrigin
  }
  element.style.opacity = override.opacity === undefined || override.opacity >= 1 ? saved.opacity : String(Math.max(0, override.opacity) * baseOpacity)
  element.style.color = override.color ?? saved.color
  const svg = element.dataset.kind === 'svg'
  if (svg) {
    revealSvg(element, override.reveal, override.fill)
    element.style.clipPath = saved.clipPath
  } else if (override.reveal !== undefined && override.reveal < 1) {
    // Typeset text and other boxes wipe in from the left, like a line being written.
    const hidden = Math.max(0, Math.min(100, (1 - override.reveal) * 100))
    element.style.clipPath = `inset(-30% ${hidden}% -30% -10%)`
  } else element.style.clipPath = saved.clipPath
  applyContentOverride(element, saved, override)
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
    if (saved.html === null) {
      saved.html = 'svg'
      savedPaths.set(element, { d: shape.getAttribute('d') ?? '', width: shape.getAttribute('stroke-width') })
    }
    const svg = element.querySelector('svg')
    if (svg) svg.style.overflow = 'visible'
    element.style.overflow = 'visible'
    if (shape.getAttribute('d') !== override.d) {
      shape.setAttribute('d', override.d)
      const info = shapeInfo(shape)
      try {
        info.length = shape.getTotalLength()
      } catch {
        info.length = 0
      }
    }
    if (override.strokeWidth !== undefined) shape.setAttribute('stroke-width', String(Math.round(override.strokeWidth * 100) / 100))
    return
  }
  if (saved.html !== null) restoreMarkup(element, saved)
}

const savedPaths = new WeakMap<HTMLElement, { d: string; width: string | null }>()

function restoreMarkup(element: HTMLElement, saved: Saved): void {
  if (saved.html === 'text') {
    element.querySelector(':scope > .live-text-now')?.remove()
    for (const child of element.children) (child as HTMLElement).style.visibility = ''
    delete element.dataset.liveText
  } else if (saved.html === 'svg') {
    const shape = element.querySelector<SVGPathElement>('path')
    const original = savedPaths.get(element)
    if (shape && original) {
      shape.setAttribute('d', original.d)
      if (original.width === null) shape.removeAttribute('stroke-width')
      else shape.setAttribute('stroke-width', original.width)
      const info = savedShapes.get(shape)
      if (info) {
        try {
          info.length = shape.getTotalLength()
        } catch {
          info.length = 0
        }
      }
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
  restoreMarkup(element, saved)
  element.style.transform = saved.transform
  element.style.transformOrigin = saved.transformOrigin
  element.style.opacity = saved.opacity
  element.style.clipPath = saved.clipPath
  element.style.color = saved.color
  savedStyles.delete(element)
  if (element.dataset.kind === 'svg') clearSvg(element)
}
