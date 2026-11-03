import { screen, type BrowserWindow } from 'electron'

/**
 * View > Interface Size: the page zoom of the main window, per machine (state.json). The OS scale sets the size of a
 * CSS pixel; this setting only corrects for taste per screen, as VS Code's window.zoomLevel does. The app never guesses
 * the physical size of a screen. The board camera zoom (View > Zoom In) is a different thing and does not change here.
 */
export const INTERFACE_SIZES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2] as const

export type InterfaceSize = 'auto' | number

/**
 * The automatic size for the display that holds the window: 120% on a 1x display, 100% on a 1.5x or 2x one (a 1x
 * display shows text that was tuned on a Retina display too small). On Wayland the window position can be unknown;
 * then Electron gives the nearest or the primary display.
 */
export function automaticSize(win: BrowserWindow | null): number {
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
  return display.scaleFactor < 1.5 ? 1.2 : 1
}

/** The zoom factor that the setting gives for this window. */
export function interfaceFactor(size: InterfaceSize, win: BrowserWindow | null): number {
  return size === 'auto' ? automaticSize(win) : size
}

/** The next size in the list, larger or smaller than the factor; the factor itself at the end of the list. */
export function stepSize(factor: number, direction: 1 | -1): number {
  const next = direction > 0 ? INTERFACE_SIZES.find((size) => size > factor + 1e-6) : [...INTERFACE_SIZES].reverse().find((size) => size < factor - 1e-6)
  return next ?? factor
}

export const percent = (factor: number): string => `${Math.round(factor * 100)}%`
