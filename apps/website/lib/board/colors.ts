// Copied from apps/desktop/src/renderer/src/live/colors.ts (NAMED, the board's colour names).
/** The board's colour tokens (content.css) and the ink palette names. */
export const NAMED: Record<string, { css: string; hex: string }> = {
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

/** The ink colour of a name, or the colour itself. */
export const hex = (color: string): string => NAMED[color]?.hex ?? color
