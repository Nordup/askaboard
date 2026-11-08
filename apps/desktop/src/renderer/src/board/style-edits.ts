import { renderableStyle, STYLE_KEYS, styleKey, type NodeStyle } from '@shared/board-format'
import { MAX_COORD, MAX_STYLE_CHARS } from '@shared/limits'
import { mixColors, sceneColor } from '../live/colors'

/**
 * Style changes from agents (a scene's edit()): camelCase keys, numbers as
 * px, only the whitelisted keys the board renders; and the in-between value
 * of a style while it glides from one value to another.
 */

const UNITLESS = new Set(['opacity', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight'])
const POSITION_KEYS = new Set(['x', 'y', 'left', 'top', 'right', 'bottom', 'position', 'transform'])

/** Normalize an agent style object: camelCase keys, numbers to px, whitelist. Dropped keys go to `ignored`. */
export function normalizeStyles(input: unknown, ignored: Set<string>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  if (!input || typeof input !== 'object') return out
  const allowed = new Set<string>(STYLE_KEYS)
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = styleKey(rawKey)
    if (POSITION_KEYS.has(key)) {
      ignored.add(`${rawKey} (places change with move())`)
      continue
    }
    if (!allowed.has(key)) {
      ignored.add(rawKey)
      continue
    }
    if (rawValue === null || rawValue === '') {
      out[key] = null
      continue
    }
    const value =
      typeof rawValue === 'number' && Number.isFinite(rawValue) && Math.abs(rawValue) <= MAX_COORD
        ? UNITLESS.has(key) ? String(rawValue) : `${rawValue}px`
        : typeof rawValue === 'string' && rawValue.length <= MAX_STYLE_CHARS ? rawValue.trim() : null
    if (value === null) {
      ignored.add(rawKey)
      continue
    }
    // The renderer's own filter decides (url(), unknown display values).
    if (renderableStyle({ [key]: value })[key as keyof ReturnType<typeof renderableStyle>] === undefined) {
      ignored.add(`${rawKey}: ${value}`)
      continue
    }
    out[key] = value
  }
  return out
}

export function applyStyles(style: NodeStyle, changes: Record<string, string | null>): NodeStyle {
  const next: NodeStyle = { ...style }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

const LENGTH = /^(-?\d*\.?\d+)(px|%|em)?$/

function colorOf(value: string): string | null {
  if (!value || LENGTH.test(value.trim())) return null
  try {
    return sceneColor(value).hex
  } catch {
    return null
  }
}

/** A style value between a and b (k from 0 to 1): colours and lengths blend, anything else switches halfway. */
export function blendStyle(a: string, b: string, k: number): string {
  if (k <= 0) return a
  if (k >= 1) return b
  const la = LENGTH.exec(a.trim())
  const lb = LENGTH.exec(b.trim())
  if (la && lb && (la[2] ?? '') === (lb[2] ?? '')) {
    const value = Number(la[1]) + (Number(lb[1]) - Number(la[1])) * k
    return `${Math.round(value * 100) / 100}${la[2] ?? ''}`
  }
  const ca = colorOf(a)
  const cb = colorOf(b)
  if (ca && cb) return mixColors(ca, cb, k)
  return k < 0.5 ? a : b
}
