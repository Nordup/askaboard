/**
 * The app's theme on <html data-theme="light" | "dark">: styles/tokens.css and the board's styles read it. Main owns
 * the choice (main/settings.ts: Appearance, or SPACE_THEME) and sets nativeTheme.themeSource from it, so
 * prefers-color-scheme here is already the result: System follows the computer, and a change shows at once.
 * The snapshot window never calls this: agents always see the dark board.
 */

const dark = window.matchMedia('(prefers-color-scheme: dark)')

function apply(): void {
  document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light'
}

/** Set data-theme now and keep it true; the returned function stops it. */
export function followTheme(): () => void {
  apply()
  dark.addEventListener('change', apply)
  return () => dark.removeEventListener('change', apply)
}
