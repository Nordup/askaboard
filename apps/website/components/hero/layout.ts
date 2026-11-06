/**
 * Where the hero's windows and loose ink sit (decision D11). Units are the reference image's
 * pixels ("design units"): the desktop frame is 1586 × 848 with the origin at the hero's centre;
 * the phone frame is 390 wide with the origin at the top centre. The CSS (--u, one design unit in
 * CSS px) and the engine both place things from these numbers.
 */
import { cubeWindow, earthWindow, MOVE_SCALE, moveInk, neuronWindow, pillHint, planetInk, squiggleInk, sunInk, wavesWindow, type Draw } from './scene'

/** A place: the centre, a turn in degrees and a size factor. */
export interface Place {
  x: number
  y: number
  r: number
  s: number
}

export interface SpriteDef {
  id: string
  /** A window has the app's chrome and can be dragged; loose ink stays. */
  window: boolean
  /** The full size in design units (a window's includes its title strip). */
  w: number
  h: number
  desk: Place
  /** The phone place; none: not shown on a phone. */
  phone?: Place
  /** Seconds after the page starts: the drawings never start together. */
  start: number
  make(): Draw
}

/** A window's title strip, in design units. */
export const BAR = 28

/** The desktop frame (design units) and the phone frame's width. */
export const DESK = { w: 1586, h: 848 }
export const PHONE = { w: 390, h: 980, maxU: 1.3 }
/** Narrower than this (CSS px): the phone layout. Keep in sync with Hero.module.css. */
export const PHONE_BELOW = 720

export const SPRITES: SpriteDef[] = [
  { id: 'sun', window: false, w: 170, h: 100, desk: { x: 102, y: -242, r: 0, s: 1 }, phone: { x: 128, y: 92, r: 0, s: 0.7 }, start: 0.9, make: sunInk },
  { id: 'planet', window: false, w: 125, h: 115, desk: { x: -410, y: 46, r: 0, s: 1 }, phone: { x: -138, y: 670, r: 0, s: 0.75 }, start: 2.2, make: planetInk },
  { id: 'squiggle', window: false, w: 165, h: 45, desk: { x: -330, y: 266, r: 0, s: 1 }, phone: { x: 122, y: 662, r: 0, s: 0.7 }, start: 3.1, make: squiggleInk },
  { id: 'move', window: false, w: 175 * MOVE_SCALE, h: 85 * MOVE_SCALE, desk: { x: 505, y: -66, r: 0, s: 1 }, start: 4.0, make: moveInk },
  { id: 'hint', window: false, w: 225, h: 100, desk: { x: 368, y: 380, r: 0, s: 1 }, start: 4.6, make: pillHint },
  { id: 'waves', window: true, w: 400, h: 200, desk: { x: -377, y: -238, r: -2.8, s: 1 }, phone: { x: -62, y: 150, r: -3, s: 0.58 }, start: 0.3, make: wavesWindow },
  { id: 'neuron', window: true, w: 270, h: 505, desk: { x: -612, y: 176, r: -6.8, s: 1 }, start: 1.6, make: neuronWindow },
  { id: 'cube', window: true, w: 286, h: 170, desk: { x: 505, y: -224, r: 5, s: 1 }, phone: { x: 112, y: 222, r: 5, s: 0.6 }, start: 1.1, make: cubeWindow },
  { id: 'earth', window: true, w: 450, h: 330, desk: { x: 574, y: 185, r: 4.2, s: 1 }, phone: { x: 8, y: 840, r: 3, s: 0.74 }, start: 2.6, make: earthWindow }
]
