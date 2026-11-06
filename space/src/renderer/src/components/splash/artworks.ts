/**
 * The splash band's artworks (decision U20): the band shows one per launch, over the breathing grid (art.ts).
 * An artwork is a module: `init` makes one instance from the launch's seed (its phases and small variations), and the
 * instance draws itself at a time in seconds. To add an artwork, write its module and add it to ARTWORKS in art.ts.
 */

import type { RibbonState } from './ribbons'
import type { TreeGpu } from './tree'

/** The band in CSS px. */
export interface Size {
  w: number
  h: number
}

/** The colours an artwork may use, read from the tokens once. */
export interface Palette {
  /** Computed CSS values of the tokens, by name without the leading "--". */
  get(name: string): string
}

export interface ArtworkInstance {
  /**
   * Draw the artwork at time t (seconds since the band started; a fixed t under reduced motion). The context is in CSS px
   * of the band, already shifted by the pointer parallax at depth 1; `fade` (0…1) is the artwork's entry, to multiply its
   * alphas with; `pointer` (−1…1 each way, eased) lets parts at other depths move by the difference.
   */
  draw(ctx: CanvasRenderingContext2D, t: number, size: Size, fade: number, pointer: readonly [number, number]): void
  /** What the WebGL layer (gl.ts) can draw for this artwork; with it, draw() runs only on the 2D fallback. */
  gpu?: { ribbons?: RibbonState; tree?: TreeGpu }
}

export interface Artwork {
  id: string
  /** How far the artwork moves against the pointer at depth 1, in CSS px at the band's edge (the grid moves 3). */
  parallax: number
  init(seed: number, palette: Palette): ArtworkInstance
}

/** A small seeded random source (mulberry32): one launch's variations from one number. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A colour token as [r, g, b, a] (0…255, alpha 0…1); the canvas parses any CSS colour. */
export function rgba(css: string): [number, number, number, number] {
  const probe = document.createElement('canvas').getContext('2d')!
  probe.fillStyle = '#000'
  probe.fillStyle = css
  const v = String(probe.fillStyle)
  if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1]
  const n = v.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1]
  return [n[0], n[1], n[2], n[3] ?? 1]
}
