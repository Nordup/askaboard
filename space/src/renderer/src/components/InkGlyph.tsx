import { useMemo } from 'react'
import { mulberry32 } from '@shared/live-scene'
import { flattenPath, type PathSegment } from '@shared/path-geometry'
import { ellipseSegments } from '@shared/pen-shapes'
import { pressureWidth } from '../board/geometry'
import { penInk, strokeSeed } from '../board/hand'

/**
 * A small drawing in the agents' pen ink, for the app's own controls (docs/learning-space/agent-ink.md,
 * "Ink glyphs"). Its path is drawn as an agent's pen shape is: flattenPath, then hand.ts penInk (the
 * sampling, the wobble and the pressure taper) with a fixed seed, so the glyph never changes. It
 * paints as the board paints pressure ink (board/paint.ts writePiece): one curve piece per sample,
 * from the midpoint before it to the midpoint after it, `width` × pressureWidth(pressure) thick with
 * round caps. It is SVG, so it stays sharp at any pixel density, and it draws in currentColor.
 */
export function InkGlyph({ segments, width, seed, box, className }: {
  /** The path in board points, as absolute segments (shared/pen-shapes.ts builds the agents' outlines). */
  segments: readonly PathSegment[]
  /** The pen's width in board points (an agent's pen shape is 3 when the scene gives none). */
  width: number
  /** The seed of the wobble and the pressure: one per glyph, so it looks the same each time. */
  seed: number
  /** The part of the board the glyph shows: x, y, width, height in board points. The CSS size scales it. */
  box: readonly [number, number, number, number]
  className?: string
}) {
  const pieces = useMemo(() => glyphPieces(segments, width, seed), [segments, width, seed])
  return (
    <svg className={className} viewBox={box.join(' ')} aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round">
      {pieces.map(([d, w], i) => (
        <path key={i} d={d} strokeWidth={w} />
      ))}
    </svg>
  )
}

const r3 = (value: number): number => Math.round(value * 1000) / 1000

/** The curve pieces of the glyph's ink, each as its path and its width. */
function glyphPieces(segments: readonly PathSegment[], width: number, seed: number): [string, number][] {
  const out: [string, number][] = []
  for (const points of penInk(flattenPath(segments, 'ink'), mulberry32(seed))) {
    const last = points.length - 1
    for (let i = 0; i <= last; i++) {
      const [x, y, p] = points[i]
      const [px, py] = points[Math.max(0, i - 1)]
      const [nx, ny] = points[Math.min(last, i + 1)]
      out.push([`M${r3((px + x) / 2)} ${r3((py + y) / 2)}Q${r3(x)} ${r3(y)} ${r3((x + nx) / 2)} ${r3((y + ny) / 2)}`, r3(width * pressureWidth(p))])
    }
  }
  return out
}

/**
 * The pen ring of a colour swatch: an agent's circle(…, { pen: true }) of radius 7 at the pen's width 3,
 * a small ring as the agents draw it. The box leaves room for the wobble (0.66) and the widest nib.
 */
const RING = ellipseSegments(0, 0, 7, 7)
const RING_WIDTH = 3
const RING_BOX = [-9.5, -9.5, 19, 19] as const

/** A colour swatch's pen ring; `name` (the colour's id) gives it its own fixed seed. */
export function PenRing({ name, className }: { name: string; className?: string }) {
  const seed = useMemo(() => strokeSeed(`swatch:${name}`, []), [name])
  return <InkGlyph segments={RING} width={RING_WIDTH} seed={seed} box={RING_BOX} className={className} />
}
