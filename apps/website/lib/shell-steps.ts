/**
 * Where the use cases' steps are in the app shell's scroll track (decision D12): one owner of the
 * rule for the shell (which use case is current) and the board engine (where each step's marker
 * line is drawn). The track is the window's height plus one scroll step per use case; the window
 * sticks in the middle of the viewport while the page scrolls through it. Step i begins on a line
 * `winH / 2 + i · step` px below the track's top: step 0's line reaches the viewport's centre when
 * the window sticks, and the shell switches to step i when its line crosses the viewport's centre.
 */
import { USE_CASES } from '@/components/usecases'

export const STEP_COUNT = USE_CASES.length

/** The track (data-shell-track) and the window's frame (data-shell-frame) in a host. */
export interface ShellParts {
  track: HTMLElement
  frame: HTMLElement
}

export function shellParts(host: ParentNode): ShellParts | null {
  const track = host.querySelector<HTMLElement>('[data-shell-track]')
  const frame = host.querySelector<HTMLElement>('[data-shell-frame]')
  return track && frame ? { track, frame } : null
}

/** The window's height and one scroll step, in CSS px. */
export function shellSizes({ track, frame }: ShellParts): { winH: number; step: number } {
  const winH = frame.offsetHeight
  return { winH, step: Math.max(1, (track.offsetHeight - winH) / STEP_COUNT) }
}

/** Where step i begins (the middle of the gap before its area), in px below the track's top. */
export const stepLine = (winH: number, step: number, i: number): number => winH / 2 + i * step

/** The step whose line the viewport's centre passed last, when the centre is `y` px below the track's top. */
const stepAt = (winH: number, step: number, y: number): number => Math.max(0, Math.min(STEP_COUNT - 1, Math.floor((y - winH / 2) / step)))

/** The gap between one step's area (its line in the margin) and the next one's, in CSS px; the switch is in its middle. */
export const STEP_GAP = 44

/** A scroll jitter this close to a line (px) does not switch back and forth; less than half the gap. */
export const STEP_HYSTERESIS = 12

/**
 * The step to show: it changes from `current` only once the centre is past a line by more than
 * the hysteresis, in either direction.
 */
export function nextStep(winH: number, step: number, y: number, current: number): number {
  const ahead = stepAt(winH, step, y - STEP_HYSTERESIS)
  if (ahead > current) return ahead
  const behind = stepAt(winH, step, y + STEP_HYSTERESIS)
  return behind < current ? behind : current
}
