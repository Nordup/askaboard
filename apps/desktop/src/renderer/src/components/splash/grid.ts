/**
 * The breathing grid (decision U20): the board's dot grid under every artwork, where three slow waves lift some dots and
 * turn them from white ink toward the accent blue. One source of its numbers for both painters: the WebGL layer (gl.ts,
 * a fragment shader) and the 2D fallback here (one path per colour step, not one fill per dot).
 */
import type { Palette, Size } from './artworks'

/** The approved mockup's band: the grid's numbers are in these units, scaled to the band (x by W/680, y by H/340). */
export const GRID = {
  unitsW: 680,
  unitsH: 340,
  /** Colour steps: dots of one step share one colour (and, in 2D, one path). */
  steps: 16,
  /** The waves: sin(x·fx + t·tx) + sin(y·fy + t·ty) + sin((x + y)·fxy + t·txy), in units and seconds. */
  fx: 0.011,
  tx: 0.35,
  fy: 0.017,
  ty: -0.27,
  fxy: 0.006,
  txy: 0.19,
  /** A lifted dot rises this many units and grows by this share of its radius. */
  lift: 2,
  grow: 0.6,
  /** Alpha of a dot at the bottom step and the extra at the top (the dark band; palette.alpha gives the light band's). */
  alpha0: 0.05,
  alpha1: 0.26
} as const

/** The grid's two ends (white ink, the accent) and its pitch in units, from the tokens. */
export function gridColours(palette: Palette): { low: number[]; high: number[]; pitch: number; alpha0: number; alpha1: number } {
  return {
    low: palette.colour('splash-grid-dot'),
    high: palette.colour('accent'),
    pitch: parseFloat(palette.get('splash-dot-pitch')) || 20,
    alpha0: palette.alpha('grid-low', GRID.alpha0),
    alpha1: palette.alpha('grid-rise', GRID.alpha1)
  }
}

/** The 2D painter: the grid at time t on a context already scaled to CSS px (and shifted by the parallax). */
export function grid2D(palette: Palette): (ctx: CanvasRenderingContext2D, t: number, size: Size) => void {
  const { low, high, pitch, alpha0, alpha1 } = gridColours(palette)
  const offset = pitch / 2
  const fills = Array.from({ length: GRID.steps }, (_, s) => {
    const b = (s + 0.5) / GRID.steps
    const c = (i: number): number => Math.round(low[i] + (high[i] - low[i]) * b)
    return `rgba(${c(0)}, ${c(1)}, ${c(2)}, ${(alpha0 + alpha1 * b).toFixed(3)})`
  })
  /** One flat list per step: x, y, radius of each dot. */
  const buckets: number[][] = Array.from({ length: GRID.steps }, () => [])
  return (ctx, t, size) => {
    const sx = size.w / GRID.unitsW
    const sy = size.h / GRID.unitsH
    const s = (sx + sy) / 2
    for (const bucket of buckets) bucket.length = 0
    // One row and column past each edge, so the parallax never shows an empty margin.
    for (let uy = offset - pitch; uy <= GRID.unitsH + pitch; uy += pitch) {
      const wy = Math.sin(uy * GRID.fy + t * GRID.ty)
      for (let ux = offset - pitch; ux <= GRID.unitsW + pitch; ux += pitch) {
        const w = Math.sin(ux * GRID.fx + t * GRID.tx) + wy + Math.sin((ux + uy) * GRID.fxy + t * GRID.txy)
        const k = Math.max(0, w / 3)
        const b = k * k
        const bucket = buckets[Math.min(GRID.steps - 1, Math.floor(b * GRID.steps))]
        bucket.push(ux * sx, (uy - GRID.lift * k) * sy, (1 + GRID.grow * k) * s)
      }
    }
    for (let i = 0; i < GRID.steps; i++) {
      const bucket = buckets[i]
      if (!bucket.length) continue
      ctx.beginPath()
      for (let j = 0; j < bucket.length; j += 3) {
        const x = bucket[j]
        const y = bucket[j + 1]
        const r = bucket[j + 2]
        ctx.moveTo(x + r, y)
        ctx.arc(x, y, r, 0, Math.PI * 2)
      }
      ctx.fillStyle = fills[i]
      ctx.fill()
    }
  }
}
