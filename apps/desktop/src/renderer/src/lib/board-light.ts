import { useSyncExternalStore } from 'react'

/**
 * The light board: one formula that gives each board colour its light-board colour (lightColor).
 *
 * Agents and the learner write colours for the dark board: literal colours in board files and the canonical
 * `--ls-*` tokens of content.css. Board files keep those colours in both themes. In the light theme every colour
 * that reaches the board's pixels passes through lightColor, one colour at a time, at one choke point per path:
 * canvas ink and shapes (paint.ts), node styles, SVG markup and maths (content.tsx), scene overrides
 * (playback.ts), the `--ls-*` tokens (lightTokenSheet) and the swatches (BoardControls.tsx).
 *
 * Why a formula and not a layer filter: a filter maps every pixel, photos too, and its inverse cannot give back
 * a saturated colour (the inverse is outside the sRGB gamut: pure red came back #ab3e3e). Excalidraw moved from
 * a filter to per-colour transforms for the same reason (excalidraw#10578, 2026); Chrome's auto-dark mode also
 * changes colours one by one, and only the ones that would be unreadable. So raster images show exactly, and a
 * strong colour that reads on the paper (red, the accent blue, purple, pink) stays exactly what was written.
 *
 * The formula, with BOARD #161618, PAPER #f6f6f8 and the WCAG contrast ratio cr:
 * 1. A colour with cr < 2.2 against the board is a surface or a subtle tone near it (a card fill, a grid line on
 *    a card). Its OKLab lightness is mirrored about the two backgrounds, damped by 0.9: a dark card becomes a
 *    light card. Hue and chroma stay.
 * 2. Else the target contrast against the paper is the colour's own contrast against the board (at most 13) for a
 *    neutral colour (OKLCH chroma < 0.04), 4.5 for coloured text and 2.5 for a coloured graphic (a line, a border).
 * 3. A colour that already meets the target stays unchanged. Else it gets the largest OKLab lightness, at the same
 *    hue, that meets it. Chroma goes down only as far as the sRGB gamut needs.
 * An area ('tint': a highlighter, an SVG fill, a gradient stop, a CSS background) keeps its own colour when it is
 * chromatic; a neutral or near-board one follows the rules above, so a dark card still becomes a light card.
 * A gradient stop ('stop') is part of a painted glow or shading: only the surface rule changes it.
 * Shadows (box-shadow, text-shadow, drop-shadow()) pass through as written.
 * Alpha never changes. The snapshot window never has data-theme="light", so agents always see the dark board.
 */

/** The canonical (dark) board background: content.css --ls-bg. Agents always see the dark board. */
export const BOARD_DARK_BG = '#161618'

/** How a colour is used: text needs more contrast than a line; an area or a highlighter (tint) keeps a chromatic colour; a gradient stop keeps any colour. */
export type ColorRole = 'text' | 'graphic' | 'tint' | 'stop'

// ---------- The theme ----------

/** True while the main window shows the light theme (`data-theme` on :root). */
export function isBoardLight(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
}

const listeners = new Set<() => void>()
const beforeListeners = new Set<() => void>()
let observer: MutationObserver | null = null

function watch(set: Set<() => void>, fn: () => void): () => void {
  set.add(fn)
  if (!observer) {
    observer = new MutationObserver(() => {
      // First what must be undone in the old theme, then React renders the new one.
      for (const listener of [...beforeListeners]) listener()
      for (const listener of [...listeners]) listener()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }
  return () => {
    set.delete(fn)
    if (!listeners.size && !beforeListeners.size && observer) {
      observer.disconnect()
      observer = null
    }
  }
}

/** One observer for every subscriber (each content node subscribes). */
function subscribe(onChange: () => void): () => void {
  return watch(listeners, onChange)
}

/**
 * Run `fn` when the theme changes, before React renders the new theme. Code that writes board colours into the DOM
 * outside React (scene playback) takes them off here, so nothing it saved holds the old theme's colours.
 */
export function beforeThemeChange(fn: () => void): () => void {
  return watch(beforeListeners, fn)
}

/** React: whether the board is light now; re-renders when the theme changes. */
export function useBoardLight(): boolean {
  return useSyncExternalStore(subscribe, isBoardLight, () => false)
}

// ---------- Colour maths ----------

type Rgb = [number, number, number]

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function luminance(c: Rgb): number {
  return 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2])
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** sRGB (gamma, 0..1) to OKLab (Björn Ottosson). */
function toOklab(c: Rgb): Rgb {
  const r = toLinear(c[0])
  const g = toLinear(c[1])
  const b = toLinear(c[2])
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

/** OKLab to linear sRGB (may be out of gamut). */
function oklabToLinear(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

const EPS = 1e-5
const inGamut = (c: Rgb): boolean => c.every((v) => v >= -EPS && v <= 1 + EPS)
const clamp = (v: number): number => Math.min(1, Math.max(0, v))

/** The sRGB colour of OKLCH (L, C, h), with C reduced only as far as the sRGB gamut needs. */
function fromOklch(L: number, C: number, h: number): Rgb {
  const at = (chroma: number): Rgb => oklabToLinear(L, chroma * Math.cos(h), chroma * Math.sin(h))
  let linear = at(C)
  if (!inGamut(linear)) {
    let lo = 0
    let hi = C
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(at(mid))) lo = mid
      else hi = mid
    }
    linear = at(lo)
  }
  return [toGamma(clamp(linear[0])), toGamma(clamp(linear[1])), toGamma(clamp(linear[2]))]
}

// ---------- Parsing ----------

let probe: CanvasRenderingContext2D | null | undefined

function probeContext(): CanvasRenderingContext2D | null {
  if (probe === undefined) {
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas')
    if (canvas) canvas.width = canvas.height = 1
    probe = canvas?.getContext('2d', { willReadFrequently: true }) ?? null
  }
  return probe
}

/** Any CSS colour as sRGB (0..1) and alpha, or null. The canvas normalises it; other spaces are read as a pixel. */
function parse(css: string): [Rgb, number] | null {
  const ctx = probeContext()
  if (!ctx) return null
  const sentinel = '#010203'
  ctx.fillStyle = sentinel
  ctx.fillStyle = css
  const norm = String(ctx.fillStyle)
  if (norm === sentinel && css.trim().toLowerCase() !== sentinel) return null
  const hex = /^#([0-9a-f]{6})$/i.exec(norm)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [[((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], 1]
  }
  const rgb = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/i.exec(norm)
  if (rgb) return [[Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255], rgb[4] === undefined ? 1 : Number(rgb[4])]
  // Another colour space (lab(), oklch(), color()): paint it with 'copy' and read the pixel and its alpha.
  ctx.clearRect(0, 0, 1, 1)
  ctx.globalCompositeOperation = 'copy'
  ctx.fillRect(0, 0, 1, 1)
  const px = ctx.getImageData(0, 0, 1, 1).data
  ctx.globalCompositeOperation = 'source-over'
  const alpha = px[3] / 255
  if (alpha === 0) return [[0, 0, 0], 0]
  // getImageData gives unpremultiplied values.
  return [[px[0] / 255, px[1] / 255, px[2] / 255], alpha]
}

const hex2 = (v: number): string => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')

function format(c: Rgb, alpha: number): string {
  const rgb = `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`
  return alpha < 1 ? rgb + hex2(alpha) : rgb
}

// ---------- The formula ----------

const SURFACE_CONTRAST = 2.2
const SURFACE_DAMPING = 0.9
const NEUTRAL_CHROMA = 0.04
const NEUTRAL_MAX_TARGET = 13

const BOARD_RGB: Rgb = [0x16 / 255, 0x16 / 255, 0x18 / 255]
/** The light board background, the paper #f6f6f8 (tokens.css --bg-canvas in light). */
const PAPER_RGB: Rgb = [0xf6 / 255, 0xf6 / 255, 0xf8 / 255]
const BOARD_LUM = luminance(BOARD_RGB)
const PAPER_LUM = luminance(PAPER_RGB)
const BOARD_L = toOklab(BOARD_RGB)[0]
const PAPER_L = toOklab(PAPER_RGB)[0]

/** An opaque sRGB colour on the light board, or null when it stays unchanged. */
function lightRgb(c: Rgb, role: ColorRole): Rgb | null {
  const [L, a, b] = toOklab(c)
  const C = Math.hypot(a, b)
  const h = Math.atan2(b, a)
  const own = contrast(luminance(c), BOARD_LUM)
  if (own < SURFACE_CONTRAST) return fromOklch(Math.min(1, PAPER_L - (L - BOARD_L) * SURFACE_DAMPING), C, h)
  const neutral = C < NEUTRAL_CHROMA
  if (role === 'stop' || (role === 'tint' && !neutral)) return null
  const target = neutral ? Math.min(own, NEUTRAL_MAX_TARGET) : role === 'text' ? 4.5 : 2.5
  if (contrast(luminance(c), PAPER_LUM) >= target) return null
  let lo = 0
  let hi = L
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2
    if (contrast(luminance(fromOklch(mid, C, h)), PAPER_LUM) >= target) lo = mid
    else hi = mid
  }
  return fromOklch(lo, C, h)
}

const caches: Record<ColorRole, Map<string, string>> = { text: new Map(), graphic: new Map(), tint: new Map(), stop: new Map() }

/** A board colour (any CSS colour) as the light board shows it, for its role. Unparseable values pass unchanged. */
export function lightColor(css: string, role: ColorRole): string {
  const cache = caches[role]
  let out = cache.get(css)
  if (out !== undefined) return out
  const parsed = parse(css)
  const mapped = parsed && parsed[1] > 0 ? lightRgb(parsed[0], role) : null
  out = mapped ? format(mapped, parsed![1]) : css
  if (cache.size > 4000) cache.clear()
  cache.set(css, out)
  return out
}

/** A board colour as the board shows it now: lightColor on the light board, the colour itself on the dark one. */
export function boardColor(css: string, role: ColorRole): string {
  return isBoardLight() ? lightColor(css, role) : css
}

// ---------- Colours inside CSS values and markup ----------

const NAMED =
  'aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen'

/** A colour literal inside a CSS value: hex, a colour function (one level of nesting) or a named colour. */
const LITERAL = new RegExp(
  `(?<!url\\(\\s*['"]?)#[0-9a-f]{3,8}(?![\\w-])|(?<![\\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\((?:[^()]|\\([^()]*\\))*\\)|(?<![\\w.#-])(?:${NAMED})(?![\\w-])`,
  'gi'
)

const GRADIENT = /(?<![\w-])(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi

/**
 * Every colour literal inside a CSS value (shorthands) through lightColor. A colour inside a gradient function is a
 * gradient stop (role 'stop'), as an SVG stop-color is.
 */
export function lightValue(value: string, role: ColorRole): string {
  const map = (part: string, as: ColorRole): string => part.replace(LITERAL, (literal) => lightColor(literal, as))
  if (!value.includes('gradient(')) return map(value, role)
  let out = ''
  let at = 0
  GRADIENT.lastIndex = 0
  for (let match = GRADIENT.exec(value); match; match = GRADIENT.exec(value)) {
    let depth = 1
    let end = match.index + match[0].length
    while (end < value.length && depth > 0) {
      if (value[end] === '(') depth++
      else if (value[end] === ')') depth--
      end++
    }
    out += map(value.slice(at, match.index), role) + map(value.slice(match.index, end), 'stop')
    at = end
    GRADIENT.lastIndex = end
  }
  return out + map(value.slice(at), role)
}

/** The role of a CSS property, or null when it bears no colour. Property names in camelCase or kebab-case. */
export function colorRole(property: string): ColorRole | null {
  const p = property.toLowerCase().replace(/-/g, '')
  if (p === 'color') return 'text'
  // Shadows keep the colour they were written with.
  if (/shadow|filter/.test(p)) return null
  // Areas keep their colour (tint): fills and backgrounds; a gradient stop keeps even a light neutral (a glow).
  if (p === 'stopcolor') return 'stop'
  if (/^(fill|floodcolor)$|background/.test(p)) return 'tint'
  return /color|border|outline|stroke|caret|decoration/.test(p) ? 'graphic' : null
}

/** The strictest of two roles: text needs most contrast, then a line, then an area, then a stop. */
const STRICT: ColorRole[] = ['text', 'graphic', 'tint', 'stop']
const stricter = (a: ColorRole | undefined, b: ColorRole): ColorRole => (a === undefined || STRICT.indexOf(b) < STRICT.indexOf(a) ? b : a)

/** The custom properties that colour-bearing declarations read with var(), each with the strictest role that reads it. */
function varRoles(pairs: Iterable<[string, string, boolean]>, into = new Map<string, ColorRole>()): Map<string, ColorRole> {
  for (const [prop, value, inText] of pairs) {
    if (!value.includes('var(')) continue
    const lower = prop.toLowerCase()
    const role = lower === 'fill' && inText ? 'text' : colorRole(prop)
    if (!role) continue
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) into.set(m[1], stricter(into.get(m[1]), role))
  }
  return into
}

/** The role of a declaration: a custom property takes the role of what reads it (default 'graphic'). */
function declRole(prop: string, vars: ReadonlyMap<string, ColorRole>): ColorRole | null {
  return prop.startsWith('--') ? (vars.get(prop) ?? 'graphic') : colorRole(prop)
}

/** A node style object on the light board: each colour-bearing value through lightColor. Returns the same object when nothing changed. */
export function lightStyle<T extends object>(style: T): T {
  let out: Record<string, unknown> | null = null
  const entries = Object.entries(style as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')
  const vars = varRoles(entries.map(([key, value]) => [key, value, false]))
  for (const [key, value] of entries) {
    const role = declRole(key, vars)
    if (!role) continue
    const mapped = lightValue(value, role)
    if (mapped !== value) (out ??= { ...(style as Record<string, unknown>) })[key] = mapped
  }
  return (out ?? style) as T
}

const DECLARATION = /([\w-]+)(\s*:\s*)([^;{}]*)/g

function lightDeclarations(css: string, role: ColorRole | null, vars: ReadonlyMap<string, ColorRole>): string {
  return css.replace(DECLARATION, (whole, prop: string, colon: string, value: string) => {
    const own = declRole(prop, vars)
    if (!own) return whole
    return `${prop}${colon}${lightValue(value, prop.toLowerCase() === 'fill' && role === 'text' ? 'text' : own)}`
  })
}

/** The fill and color an element sets itself (attribute or style), or undefined. */
function ownPaint(attrs: string): { fill?: string; color?: string } {
  const out: { fill?: string; color?: string } = {}
  for (const m of attrs.matchAll(/\s(fill|color)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out[m[1].toLowerCase() as 'fill' | 'color'] = m[2] ?? m[3]
  const style = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
  if (style) for (const m of (style[1] ?? style[2]).matchAll(/(?:^|;)\s*(fill|color)\s*:\s*([^;]*)/gi)) out[m[1].toLowerCase() as 'fill' | 'color'] = m[2].trim()
  return out
}

const TEXT_TAGS = new Set(['text', 'tspan', 'textpath'])
/** Elements with no closing tag in HTML (KaTeX output is HTML). */
const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'wbr', 'col', 'area', 'base', 'source', 'track', 'embed', 'param'])
const COLOR_ATTRS = /(\s)(fill|stroke|stop-color|flood-color|lighting-color|color|style)(\s*=\s*)("([^"]*)"|'([^']*)')/gi
const TAG = /<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|[^<]+/g
const markupCache = new Map<string, string>()

interface Open {
  name: string
  /** The fill and color this element shows (its own, or inherited), as written (dark-board values). */
  fill?: string
  color?: string
}

/** One pass over the tags of markup with the open-element stack: `visit` sees each opening tag with its parent. */
function walkTags(markup: string, visit: (tag: string, attrs: string, parent: Open | undefined, inText: boolean, inStyle: boolean) => string, text: (part: string, inStyle: boolean) => string): string {
  const stack: Open[] = []
  let inStyle = false
  return markup.replace(TAG, (part, close: string | undefined, tag: string | undefined, attrs: string | undefined) => {
    if (tag === undefined) return text(part, inStyle)
    const name = tag.toLowerCase()
    if (close) {
      const at = stack.map((open) => open.name).lastIndexOf(name)
      if (at >= 0) stack.length = at
      if (name === 'style') inStyle = false
      return part
    }
    const parent = stack[stack.length - 1]
    const inText = TEXT_TAGS.has(name) || stack.some((open) => TEXT_TAGS.has(open.name))
    const out = visit(tag, attrs ?? '', parent, inText, inStyle)
    if (!/\/\s*$/.test(attrs ?? '') && !VOID_TAGS.has(name)) {
      const own = ownPaint(attrs ?? '')
      stack.push({ name, fill: own.fill ?? parent?.fill, color: own.color ?? parent?.color })
      if (name === 'style') inStyle = true
    }
    return out
  })
}

/**
 * SVG or HTML markup (an svg node, KaTeX output) on the light board: colour attributes, style attributes, custom
 * properties and <style> text through lightColor. The fill of <text>/<tspan> and of what is inside them is text; a
 * text element that inherits its fill from a group gets that fill as text, set on itself.
 */
export function lightMarkup(markup: string): string {
  const cached = markupCache.get(markup)
  if (cached !== undefined) return cached
  // First pass: which custom properties are read, and by what.
  const reads: Array<[string, string, boolean]> = []
  walkTags(
    markup,
    (tag, attrs, parent, inText) => {
      for (const m of attrs.matchAll(COLOR_ATTRS)) {
        const value = m[5] ?? m[6] ?? ''
        if (m[2].toLowerCase() === 'style') for (const d of value.matchAll(DECLARATION)) reads.push([d[1], d[3], inText])
        else reads.push([m[2], value, inText])
      }
      // A text element with no fill of its own reads its parent's fill as text.
      if (TEXT_TAGS.has(tag.toLowerCase()) && parent?.fill && ownPaint(attrs).fill === undefined) reads.push(['fill', parent.fill, true])
      return ''
    },
    (part, inStyle) => {
      if (inStyle) for (const d of part.matchAll(DECLARATION)) reads.push([d[1], d[3], false])
      return part
    }
  )
  const vars = varRoles(reads)
  const out = walkTags(
    markup,
    (tag, attrs, parent, inText) => {
      const name = tag.toLowerCase()
      let mapped = attrs.replace(COLOR_ATTRS, (whole, space: string, attr: string, eq: string, quoted: string, dq?: string, sq?: string) => {
        const value = dq ?? sq ?? ''
        const lower = attr.toLowerCase()
        const next =
          lower === 'style'
            ? lightDeclarations(value, inText ? 'text' : null, vars)
            : lightValue(value, lower === 'color' || (lower === 'fill' && inText) ? 'text' : (colorRole(lower) ?? 'graphic'))
        if (next === value) return whole
        const q = quoted[0]
        return `${space}${attr}${eq}${q}${next}${q}`
      })
      // An inherited fill (a group's, an area colour) reaches the text as text.
      const inherited = parent?.fill
      if (TEXT_TAGS.has(name) && inherited && ownPaint(attrs).fill === undefined && !/^(none|inherit|url\()/i.test(inherited.trim())) {
        const asText = lightValue(inherited, 'text')
        if (asText !== lightValue(inherited, 'tint')) mapped = ` fill="${asText.replace(/"/g, "'")}"${mapped}`
      }
      return mapped === attrs ? `<${tag}${attrs}>` : `<${tag}${mapped}>`
    },
    (part, inStyle) => (inStyle ? lightDeclarations(part, null, vars) : part)
  )
  if (markupCache.size > 1000) markupCache.clear()
  markupCache.set(markup, out)
  return out
}

/** Markup as the board shows it now (lightMarkup on the light board). */
export function boardMarkup(markup: string, light = isBoardLight()): string {
  return light ? lightMarkup(markup) : markup
}

// ---------- The --ls-* tokens ----------

const TOKEN_ROLES: Record<string, ColorRole | 'surface'> = {
  '--ls-text': 'text',
  '--ls-muted': 'text',
  '--ls-accent': 'text',
  '--ls-good': 'graphic',
  '--ls-bad': 'graphic',
  '--ls-warn': 'graphic',
  '--ls-card': 'surface',
  '--ls-card-2': 'surface',
  '--ls-border': 'surface',
  '--ls-bg': 'surface'
}

let tokenSheet: HTMLStyleElement | null = null

/**
 * In light, the `--ls-*` tokens on `.board__content` (the content layer and the ghost) computed from their dark
 * values in content.css through lightColor: no second copy by hand. A surface token goes through the surface rule
 * of the formula (all of them are near the board). Installed once, on the first light render.
 */
export function installLightTokens(): void {
  if (tokenSheet || typeof document === 'undefined') return
  const host = document.createElement('div')
  host.className = 'snapshot__content'
  host.style.display = 'none'
  document.body.appendChild(host)
  const computed = getComputedStyle(host)
  const lines: string[] = []
  for (const [token, role] of Object.entries(TOKEN_ROLES)) {
    const dark = computed.getPropertyValue(token).trim()
    if (!dark) continue
    lines.push(`${token}: ${lightColor(dark, role === 'surface' ? 'graphic' : role)};`)
  }
  host.remove()
  if (!lines.length) return
  tokenSheet = document.createElement('style')
  tokenSheet.dataset.boardLight = ''
  tokenSheet.textContent =
    `:root[data-theme='light'] .board__content { ${lines.join(' ')} }\n` +
    `:root[data-theme='light'] .board__content .node-image--missing { border-color: ${lightColor('rgba(255, 255, 255, 0.25)', 'graphic')}; color: ${lightColor('rgba(255, 255, 255, 0.45)', 'text')}; }`
  document.head.appendChild(tokenSheet)
}
