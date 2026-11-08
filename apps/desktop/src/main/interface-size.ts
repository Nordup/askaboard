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

/**
 * The macOS window buttons at an Interface Size factor. They are native, so the page zoom does not move them: three
 * 14 px circles at a 23 px pitch, 60 px from the first circle's left edge to the last one's right edge (measured in a
 * window capture, 2026-11-06). Their centre line is the title row's centre (44 CSS px high, tokens.css
 * --titlebar-height), so y follows the factor. x stays 16 window px at every factor: macOS keeps the window buttons a
 * fixed distance from the window edge whatever the content size (Finder, Mail and Xcode keep about 20 px at every
 * toolbar size), and a scaled x (24 px at 150%) looks loose next to other windows.
 */
const WINDOW_BUTTONS_X = 16
const WINDOW_BUTTONS_WIDTH = 60
const WINDOW_BUTTON_SIZE = 14
const TITLE_ROW_CSS = 44

/** Where the window buttons go at this factor (BrowserWindow trafficLightPosition / setWindowButtonPosition, window px). */
export function windowButtonPosition(factor: number): { x: number; y: number } {
  return { x: WINDOW_BUTTONS_X, y: Math.round((TITLE_ROW_CSS * factor - WINDOW_BUTTON_SIZE) / 2) }
}

/**
 * The window buttons' right edge in CSS px at this factor: the renderer's --window-buttons-end. The 16 CSS px gap after
 * it (--window-buttons-gap) is then 16 x factor window px, as every other CSS length. null off macOS (no window buttons).
 */
export function windowButtonsEnd(factor: number): number | null {
  return process.platform === 'darwin' ? (WINDOW_BUTTONS_X + WINDOW_BUTTONS_WIDTH) / factor : null
}
