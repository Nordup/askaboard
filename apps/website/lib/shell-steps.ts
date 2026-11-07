/**
 * Where the use cases' steps are in the app shell's scroll track (decision D12): one owner of the
 * rule for the shell (which use case is current) and the board engine (where each step's marks
 * are drawn). The window sticks in the middle of the viewport while the page scrolls through the
 * track. Each step has one area of marks in the margins, `step` px tall, one under the other.
 *
 * The founder (2026-11-07): the window sticks when the first mark's top is at 25 % of the
 * viewport's height (the first question is then in full view in the upper part), and it lets go
 * when the last mark's bottom is at 72 % (the last question is still in full view). The sticky
 * phase between them is cut into three equal parts, one per step. On a phone both ends are the
 * viewport's middle, so the switches are at the marks' borders.
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

/**
 * The window's glide into and out of its sticky place, as a share of the viewport's height
 * (AppShell.tsx). After the release the window stays half of it below the track's end, so the
 * shell's content ends there (lib/spacing.ts, the agent section's margin).
 */
export const GLIDE = 0.155

/** Where the first mark's top is when the window sticks, and the last mark's bottom when it lets go: shares of the viewport's height from its top. Keep in sync with --stick-cut (AppShell.module.css). */
export const STICK_AT = 0.25
export const RELEASE_AT = 0.72

/**
 * The shell's sizes in CSS px: the window's height; `step`, the height of one step's marks;
 * `lead`, how far the first mark's top is below the line `winH / 2` in the track (negative:
 * above it); and `third`, one third of the sticky phase. The viewport's centre is `winH / 2` px
 * below the track's top when the window sticks, and the track is the window plus the sticky phase.
 */
export function shellSizes({ track, frame }: ShellParts): { winH: number; step: number; lead: number; third: number } {
  const winH = frame.offsetHeight
  const vh = window.innerHeight
  const phone = window.matchMedia('(max-width: 719px)').matches
  const stick = phone ? 0.5 : STICK_AT
  const release = phone ? 0.5 : RELEASE_AT
  const sticky = Math.max(1, track.offsetHeight - winH)
  // The marks span the sticky phase and the stretches from 25 % to the middle and from the middle to 72 %.
  return { winH, step: (sticky + (release - stick) * vh) / STEP_COUNT, lead: (stick - 0.5) * vh, third: sticky / STEP_COUNT }
}

/** Where step i's marks begin (the middle of the gap before its area), in px below the track's top. */
export const stepLine = (winH: number, step: number, i: number, lead = 0): number => winH / 2 + lead + i * step

/** The step whose third of the sticky phase the viewport's centre is in, when the centre is `y` px below the track's top. */
const stepAt = (winH: number, third: number, y: number): number => Math.max(0, Math.min(STEP_COUNT - 1, Math.floor((y - winH / 2) / third)))

/** The gap between one step's area (its line in the margin) and the next one's, in CSS px (on a phone the switch is in its middle). */
export const STEP_GAP = 44

/** A scroll jitter this close to a line (px) does not switch back and forth; less than half the gap. */
export const STEP_HYSTERESIS = 12

/**
 * The step to show: it changes from `current` only once the centre is past a line by more than
 * the hysteresis, in either direction. `third` is one third of the sticky phase (shellSizes).
 */
export function nextStep(winH: number, third: number, y: number, current: number): number {
  const ahead = stepAt(winH, third, y - STEP_HYSTERESIS)
  if (ahead > current) return ahead
  const behind = stepAt(winH, third, y + STEP_HYSTERESIS)
  return behind < current ? behind : current
}
