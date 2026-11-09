/**
 * The splash band's artworks (decision U20): the band shows one per launch, over the breathing grid (art.ts).
 * An artwork is a module: `init` makes one instance from the launch's seed (its phases and small variations), and the
 * instance draws itself at a time in seconds. To add an artwork, write its module and add it to ARTWORKS in art.ts.
 */

import type { TreeGpu } from './tree'

/** The band in CSS px. */
export interface Size {
  w: number
  h: number
}

/** A colour as [r, g, b, a] (0…255, alpha 0…1). */
export type RGB = [number, number, number, number]

/**
 * The band's colours and the few alphas that differ by theme. The dark band reads the dark tokens (and the artwork's own
 * colours below); the light band is drawn by hand from the founder's reference (LIGHT): ink on near-white paper.
 */
export interface Palette {
  /** Whether the band is drawn for the light theme. */
  readonly light: boolean
  /** Computed CSS values of the dark tokens, by name without the leading "--" (numbers and sizes). */
  get(name: string): string
  /** A band colour by name: a token name (bg-canvas, accent, splash-…) or one of the artwork's own (DARK_OWN). */
  colour(name: string): RGB
  /** An alpha by name: the dark band's own number, or the light band's (LIGHT_ALPHA) when it has one. */
  alpha(name: string, dark: number): number
}

export interface ArtworkInstance {
  /**
   * Draw the artwork at time t (seconds since the band started; a fixed t under reduced motion). The context is in CSS px
   * of the band, already shifted by the pointer parallax at depth 1; `fade` (0…1) is the artwork's entry, to multiply its
   * alphas with; `pointer` (−1…1 each way, eased) lets parts at other depths move by the difference.
   */
  draw(ctx: CanvasRenderingContext2D, t: number, size: Size, fade: number, pointer: readonly [number, number]): void
  /** What the WebGL layer (gl.ts) can draw for this artwork; when it draws, draw() is not called. */
  gpu?: { tree?: TreeGpu }
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
export function rgba(css: string): RGB {
  const probe = document.createElement('canvas').getContext('2d')!
  probe.fillStyle = '#000'
  probe.fillStyle = css
  const v = String(probe.fillStyle)
  if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1]
  const n = v.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1]
  return [n[0], n[1], n[2], n[3] ?? 1]
}

/** A colour as a CSS string. */
export const cssColour = ([r, g, b, a]: RGB): string => `rgba(${r}, ${g}, ${b}, ${a})`

// ---------- The light band, by hand ----------

/** The artwork's own colours in the dark band (not tokens), and names that take another colour in the dark band. */
const DARK_OWN: Record<string, RGB> = {
  'splash-stamen': [250, 222, 160, 1],
  'splash-flower-deep': [120, 10, 30, 1],
  'splash-bud-deep': [90, 10, 25, 1],
  'splash-wash-pool': [6, 5, 6, 1]
}
const DARK_ALIAS: Record<string, string> = { 'splash-moon-edge': 'splash-moon', 'splash-wash': 'splash-tree-rim', 'splash-grid-dot': 'ink-white' }

/** The light band (the founder's reference, 2026-11-09): every colour it draws. */
const LIGHT: Record<string, string> = {
  'bg-canvas': '#fbfbfc',
  'splash-grid-dot': '#000000',
  accent: '#4a63e8',
  'splash-moon': '#ffffff',
  'splash-moon-edge': '#000000',
  'splash-tree-bark': '#1c1617',
  'splash-tree-core': '#120e0f',
  'splash-tree-rim': '#5a4f50',
  'splash-blossom-crimson': '#e3164a',
  'splash-blossom-rose': '#f0406a',
  'splash-blossom-pink': '#f78fae',
  'splash-blossom-pale': '#fcd2de',
  'splash-blossom-white': '#ffffff',
  'splash-stamen': '#f2c14e',
  'splash-flower-deep': '#d40f3c',
  'splash-bud-deep': '#5a0a19',
  'splash-wash': '#000000',
  'splash-wash-pool': '#000000',
  'text-primary': '#111113',
  'text-tertiary': '#8e8e96'
}
/** The light band's alphas where the dark band's do not fit paper. */
const LIGHT_ALPHA: Record<string, number> = {
  'grid-low': 0.1,
  'grid-rise': 0.08,
  'moon-halo': 0,
  'moon-disc-0': 1,
  'moon-disc-1': 1,
  'moon-disc-2': 0.97,
  'moon-edge': 0.06,
  'moon-emboss': 0.025,
  'wash-pool': 0.06,
  wash: 0.6
}

/** The band's palette for the document's theme now. The dark tokens come from `probe`, an element with data-theme="dark". */
export function bandPalette(probe: HTMLElement): Palette {
  const dark = getComputedStyle(probe)
  const get = (name: string): string => dark.getPropertyValue(`--${name}`).trim()
  const light = document.documentElement.dataset.theme === 'light'
  return {
    light,
    get,
    colour: (name) => {
      if (light && LIGHT[name]) return rgba(LIGHT[name])
      return DARK_OWN[name] ?? rgba(get(DARK_ALIAS[name] ?? name) || (name === 'bg-canvas' ? '#161618' : '#000'))
    },
    alpha: (name, darkAlpha) => (light && name in LIGHT_ALPHA ? LIGHT_ALPHA[name] : darkAlpha)
  }
}
