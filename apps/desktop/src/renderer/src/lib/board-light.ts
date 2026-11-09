import { useSyncExternalStore } from 'react'

/**
 * The light board: one colour map over the board material (the board material keeps its stored colours).
 *
 * Agents and the learner write colours for the dark board: literal hex in board files and the canonical
 * `--ls-*` tokens of content.css. In the light theme this map runs over the layers that show that material
 * (`.board__material` in board.css). It flips lightness and keeps hue and chroma. It sends the dark board
 * #161618 to the paper #f6f6f8 and the white ink #ececef to near-black.
 *
 * The map is the CSS chain `invert(1) hue-rotate(180deg) brightness(1.056)`. Per channel on sRGB values in
 * [0, 1], with the luma L = 0.213 r + 0.715 g + 0.072 b of CSS hue-rotate, it is c' = 1.056·(1 − 2L + c),
 * clamped after each step. It is within ΔE 4 of the exact matrix c' = c − 2.056·Y + 1.056 (Rec.709 Y) for
 * every colour of the board palette. On a pan and zoom of the 739-item Attention board (M1 Air, 2026-11-09)
 * both forms held 60 fps; the SVG feColorMatrix form cost the renderer 17 to 45 percent more CPU, this chain
 * cost the GPU process about 10 percent more.
 *
 * This module is the only owner of the map. Everything inside the mapped layers uses canonical dark values
 * only (the `--ls-*` tokens, never the app tokens of tokens.css, which change with the theme).
 */

const LIFT = 1.056
/** The luma of CSS hue-rotate(): hue-rotate(180deg) is the matrix 2·LUMA − I. */
const LUMA = [0.213, 0.715, 0.072] as const

/** The map, and its inverse for material that shows its true colours (raster images). */
export const BOARD_MAP_FILTER = `invert(1) hue-rotate(180deg) brightness(${LIFT})`
export const BOARD_UNMAP_FILTER = `brightness(${Math.round((1 / LIFT) * 10000) / 10000}) hue-rotate(180deg) invert(1)`

/** The canonical (dark) board background: content.css --ls-bg. Agents always see the dark board. */
export const BOARD_DARK_BG = '#161618'

/** Give CSS the two filters as `--board-map` and `--board-unmap` on :root. board.css applies them only under :root[data-theme='light']. */
export function installBoardLight(): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--board-map', BOARD_MAP_FILTER)
  document.documentElement.style.setProperty('--board-unmap', BOARD_UNMAP_FILTER)
}

/** True while the main window shows the light theme (`data-theme` on :root). */
export function isBoardLight(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

/** React: whether the board is light now; re-renders when the theme changes. */
export function useBoardLight(): boolean {
  return useSyncExternalStore(subscribe, isBoardLight, () => false)
}

function parse(css: string): [number, number, number, number] | null {
  const hex = css.trim().match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16) / 255
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1]
  }
  const rgb = css.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i)
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])
    return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, a]
  }
  return null
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value))
const hex2 = (value: number): string => Math.round(clamp(value) * 255).toString(16).padStart(2, '0')

type Rgb = readonly [number, number, number]

/** hue-rotate(180deg) as CSS applies it, clamped: 2·luma − c per channel. */
function turn(c: Rgb): Rgb {
  const luma = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2]
  return [clamp(2 * luma - c[0]), clamp(2 * luma - c[1]), clamp(2 * luma - c[2])]
}

function convert(css: string, steps: (c: Rgb) => Rgb): string {
  const c = parse(css)
  if (!c) return css
  const out = steps([c[0], c[1], c[2]])
  const rgb = `#${hex2(out[0])}${hex2(out[1])}${hex2(out[2])}`
  return c[3] < 1 ? rgb + hex2(c[3]) : rgb
}

/** A board colour as the light board shows it: BOARD_MAP_FILTER applied to a hex or rgb() colour. Other values pass unchanged. */
export function mapColor(css: string): string {
  return convert(css, (c) => {
    const t = turn([1 - c[0], 1 - c[1], 1 - c[2]])
    return [clamp(LIFT * t[0]), clamp(LIFT * t[1]), clamp(LIFT * t[2])]
  })
}

/** The colour that the light board's map shows as `css`: BOARD_UNMAP_FILTER applied to it. A very saturated colour comes back a little paler. */
export function unmapColor(css: string): string {
  return convert(css, (c) => {
    const t = turn([clamp(c[0] / LIFT), clamp(c[1] / LIFT), clamp(c[2] / LIFT)])
    return [1 - t[0], 1 - t[1], 1 - t[2]]
  })
}

/** Below this spread of the sRGB channels a highlighter colour counts as neutral (the white highlighter). */
const NEUTRAL_CHROMA = 0.15

/**
 * The colour a highlighter stroke paints, for its stored (dark-board) colour. On the dark board it is the colour itself.
 * On the light board a coloured highlighter paints the unmapped colour: the map is affine, so the stroke then shows
 * its own colour at its alpha over the paper, a light tint of its hue, not a dark smear. A neutral highlighter keeps
 * the plain map (a grey band): a white tint on paper would not show. The stored colour never changes.
 */
export function highlighterPaint(css: string, light = isBoardLight()): string {
  if (!light) return css
  const c = parse(css)
  if (!c || Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < NEUTRAL_CHROMA) return css
  return unmapColor(css)
}

/** A stored ink colour as the board shows it now (a swatch): the colour itself on the dark board; on the light board what the pen or the highlighter shows. */
export function shownInk(css: string, light: boolean, highlighter = false): string {
  if (!light) return css
  return mapColor(highlighter ? highlighterPaint(css, true) : css)
}
