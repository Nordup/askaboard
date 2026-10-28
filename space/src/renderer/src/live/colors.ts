/**
 * Colours in live scenes: a name (accent, good, …), a board token
 * (var(--ls-good)) or any CSS colour. Board material (svg, text) keeps the
 * token, so it follows the app's theme; ink and interpolation need a
 * concrete colour.
 */

/** The board's colour tokens (content.css) and the ink palette names. */
const NAMED: Record<string, { css: string; hex: string }> = {
  accent: { css: 'var(--ls-accent)', hex: '#6e8bff' },
  good: { css: 'var(--ls-good)', hex: '#5fd38d' },
  bad: { css: 'var(--ls-bad)', hex: '#ff6b8b' },
  warn: { css: 'var(--ls-warn)', hex: '#f5d76e' },
  text: { css: 'var(--ls-text)', hex: '#ececef' },
  muted: { css: 'var(--ls-muted)', hex: '#a0a0a8' },
  card: { css: 'var(--ls-card)', hex: '#1f2230' },
  'card-2': { css: 'var(--ls-card-2)', hex: '#262a3a' },
  border: { css: 'var(--ls-border)', hex: '#2e3448' },
  bg: { css: 'var(--ls-bg)', hex: '#161618' },
  white: { css: '#ececef', hex: '#ececef' },
  yellow: { css: '#f5d76e', hex: '#f5d76e' },
  blue: { css: '#6ea8ff', hex: '#6ea8ff' },
  green: { css: '#5fd38d', hex: '#5fd38d' },
  pink: { css: '#ff6b8b', hex: '#ff6b8b' },
  red: { css: '#ff6b8b', hex: '#ff6b8b' },
  orange: { css: '#ff9f45', hex: '#ff9f45' },
  purple: { css: '#b58cff', hex: '#b58cff' },
  teal: { css: '#4fd1c5', hex: '#4fd1c5' }
}

export const COLOR_NAMES = Object.keys(NAMED)

let probe: CanvasRenderingContext2D | null = null

/** Any CSS colour as #rrggbb or rgba(…), as the canvas reads it; null when the browser does not know it. */
function normalize(value: string): string | null {
  probe ??= document.createElement('canvas').getContext('2d')
  if (!probe) return null
  probe.fillStyle = '#000001'
  probe.fillStyle = value
  const first = probe.fillStyle
  probe.fillStyle = '#000002'
  probe.fillStyle = value
  // A colour the canvas refused leaves the sentinel in place.
  return first === '#000001' && probe.fillStyle === '#000002' ? null : String(first)
}

export interface SceneColor {
  /** For board material (svg, text): a token or a CSS colour. */
  css: string
  /** For ink and interpolation: a concrete colour. */
  hex: string
}

/** Resolve a colour. Unknown colours throw a readable error (scenes draw with drawColor, which never throws). */
export function sceneColor(value: string): SceneColor {
  const raw = value.trim()
  const token = /^var\(\s*--ls-([a-z0-9-]+)\s*\)$/i.exec(raw)?.[1]
  const named = NAMED[(token ?? raw).toLowerCase()]
  if (named) return token ? { css: raw, hex: named.hex } : named
  if (/[<>"'`;{}]|url\s*\(|expression/i.test(raw)) throw new Error(`"${raw}" is not a colour.`)
  const hex = normalize(raw)
  if (!hex) throw new Error(`"${raw}" is not a colour. Use a name (${COLOR_NAMES.join(', ')}), a token such as var(--ls-good), hex, rgb() or hsl().`)
  return { css: raw, hex }
}

/** "none": a colour that draws nothing. */
const NONE: SceneColor = { css: 'transparent', hex: 'rgba(0, 0, 0, 0)' }

/**
 * The colour a scene draws with: every value draws, or draws nothing. A
 * name, a token or any CSS colour draws as sceneColor reads it; "none" draws
 * nothing; a value the board does not know draws in the default colour
 * (text). Scenes use this one; sceneColor is for a check that must know
 * whether a value is a colour (style-edits).
 */
export function drawColor(value: unknown): SceneColor {
  if (typeof value !== 'string') return NAMED.text
  if (value.trim().toLowerCase() === 'none') return NONE
  try {
    return sceneColor(value)
  } catch {
    return NAMED.text
  }
}

/** [r, g, b, a] of a concrete colour. */
export function rgba(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim())
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, hex[2] ? parseInt(hex[2], 16) / 255 : 1]
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(color.trim())
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1]
  }
  const normalized = normalize(color)
  return normalized && normalized !== color ? rgba(normalized) : [236, 236, 239, 1]
}

export function mixColors(a: string, b: string, t: number): string {
  const x = rgba(a)
  const y = rgba(b)
  const c = (i: number): number => Math.round(x[i] + (y[i] - x[i]) * t)
  const alpha = x[3] + (y[3] - x[3]) * t
  return `rgba(${c(0)}, ${c(1)}, ${c(2)}, ${Math.round(alpha * 1000) / 1000})`
}

/** A concrete colour with its alpha multiplied by `opacity`. */
export function withOpacity(color: string, opacity: number): string {
  if (opacity >= 1) return color
  const [r, g, b, a] = rgba(color)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * opacity * 1000) / 1000})`
}
