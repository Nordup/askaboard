/**
 * Where the hero's windows and loose ink sit (decision D11). Units are the reference image's
 * pixels ("design units"): the desktop frame is 1586 × 848 with the origin at the hero's centre;
 * the phone frame is 390 wide with the origin at the top centre. The CSS (--u, one design unit in
 * CSS px) and the engine both place things from these numbers.
 */
import type { Point } from '@/lib/board/hand'
import { lineQuestion, LINE_W, PHONE_QUESTION_BOX, QUESTION_BOX, stackedQuestion, stepLine } from './steps'
import { buildsScene, bulbInk, CHECKS_WORDS, checksScene, diagramNote, handHeading, loopArrowInk, SEES_WORDS, seesScene, starsInk, type HandLine } from './closing'
import { CUBE_WORDS, cubeWindow, EARTH_WORDS, earthWindow, HINT_WORDS, MOVE_SCALE, MOVE_WORDS, moveInk, NEURON_WORDS, neuronWindow, pillHint, planetInk, squiggleInk, sunInk, WAVES_WORDS, wavesWindow, wordsOf, type Draw } from './scene'

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
  /**
   * A use case step's mark (steps.ts): it lies in the layer behind the app shell's window, and its
   * desk and phone x, y are offsets from an anchor in the step's area of the shell's track
   * (lib/shell-steps.ts). x: the centre of the `side` margin on a desktop, the page's centre on a
   * phone. y: `top` is where the area begins; `upper` is where the viewport's centre is less 12 % of
   * its height when the centre is at the area's middle (the question reads a bit above the middle
   * of the screen then); `span` is the area's middle, and the item's height
   * becomes the area's (less the gap between areas); `above` is the window's top at the moment the
   * step begins. It draws on when it first comes on screen.
   */
  step?: { index: number; side: 'left' | 'right'; y: 'top' | 'upper' | 'span' | 'above' }
  /** Not shown on a desktop (a phone-only item). */
  deskOff?: boolean
  /**
   * Placed from an element of the page (`data-anchor` with this name): the desk and phone x, y are
   * offsets in design units from the element's top centre. It draws on when it first comes on
   * screen, `start` seconds later.
   */
  anchor?: string
  make?(): Draw
  /** The words the ink writes, as text: Board.tsx puts them on the page, unseen, for readers that cannot see the canvas. */
  text?: string
}

/** A hand note (closing.ts diagramNote) and its words, from one list of lines. */
const note = (lines: readonly string[], at: Point, arrow: Point[] | null): Pick<SpriteDef, 'make' | 'text'> => ({ text: lines.join(' '), make: () => diagramNote(lines, at, arrow) })
/** A hand heading (closing.ts handHeading) and its words, from one list of lines. */
const heading = (lines: readonly HandLine[], size: number): Pick<SpriteDef, 'make' | 'text'> => ({ text: lines.map(([line]) => line).join(' '), make: () => handHeading(lines, size) })

/** A window's title strip, in design units. */
export const BAR = 28

/** The hero's windows a little smaller than the reference image, round their centres, so they clutter less (the founder, 2026-11-07). */
const QUIET = 0.92

/** The desktop frame (design units) and the phone frame's width. */
export const DESK = { w: 1586, h: 848 }
export const PHONE = { w: 390, h: 980, maxU: 1.3 }
/** Narrower than this (CSS px): the phone layout. Keep in sync with Hero.module.css. */
export const PHONE_BELOW = 720

export const SPRITES: SpriteDef[] = [
  { id: 'sun', window: false, w: 170, h: 100, desk: { x: 102, y: -242, r: 0, s: 1 }, phone: { x: 128, y: 92, r: 0, s: 0.7 }, start: 0.9, make: sunInk },
  { id: 'planet', window: false, w: 125, h: 115, desk: { x: -410, y: 46, r: 0, s: 1 }, phone: { x: -138, y: 670, r: 0, s: 0.75 }, start: 2.2, make: planetInk },
  { id: 'squiggle', window: false, w: 165, h: 45, desk: { x: -330, y: 266, r: 0, s: 1 }, phone: { x: 122, y: 662, r: 0, s: 0.7 }, start: 3.1, make: squiggleInk },
  { id: 'move', window: false, w: 175 * MOVE_SCALE, h: 85 * MOVE_SCALE, desk: { x: 505, y: -66, r: 0, s: 1 }, start: 4.0, make: moveInk, text: wordsOf(MOVE_WORDS) },
  { id: 'hint', window: false, w: 225, h: 100, desk: { x: 261, y: 437, r: 0, s: 1 }, start: 4.6, make: pillHint, text: wordsOf(HINT_WORDS) },
  { id: 'waves', window: true, w: 400, h: 200, desk: { x: -377, y: -238, r: -2.8, s: QUIET }, phone: { x: -62, y: 150, r: -3, s: 0.58 }, start: 0.3, make: wavesWindow, text: wordsOf(WAVES_WORDS) },
  { id: 'neuron', window: true, w: 270, h: 505, desk: { x: -612, y: 176, r: -6.8, s: QUIET }, start: 1.6, make: neuronWindow, text: wordsOf(NEURON_WORDS) },
  { id: 'cube', window: true, w: 286, h: 170, desk: { x: 505, y: -224, r: 5, s: QUIET }, phone: { x: 112, y: 222, r: 5, s: 0.6 }, start: 1.1, make: cubeWindow, text: wordsOf(CUBE_WORDS) },
  { id: 'earth', window: true, w: 450, h: 330, desk: { x: 574, y: 185, r: 4.2, s: QUIET }, phone: { x: 8, y: 840, r: 3, s: 0.74 }, start: 2.6, make: earthWindow, text: wordsOf(EARTH_WORDS) },
  // The agent section (anchor `agents`, AgentSection.tsx): three quiet windows, one case each, in a
  // loose group under the heading, each with a hand-ink caption and a short arrow, like the hero's
  // hints. On a phone the windows stack, each with a caption above it and no arrow (deskOff captions).
  { id: 'agent-sees', window: true, w: 300, h: 190, desk: { x: -420, y: 346, r: -4, s: 1 }, phone: { x: 0, y: 292, r: -2, s: 0.9 }, start: 0.2, anchor: 'agents', make: seesScene, text: wordsOf(SEES_WORDS) },
  { id: 'agent-checks', window: true, w: 380, h: 230, desk: { x: 0, y: 381, r: 2.5, s: 1 }, phone: { x: 0, y: 532, r: 2, s: 0.9 }, start: 0.5, anchor: 'agents', make: checksScene, text: wordsOf(CHECKS_WORDS) },
  { id: 'agent-builds', window: true, w: 260, h: 210, desk: { x: 420, y: 332, r: 4.5, s: 1 }, phone: { x: 0, y: 782, r: -2, s: 0.9 }, start: 0.8, anchor: 'agents', make: buildsScene },
  {
    id: 'agent-sees-note',
    window: false,
    w: 320,
    h: 110,
    desk: { x: -500, y: 194, r: -3, s: 1 },
    start: 1.2,
    anchor: 'agents',
    ...note(['your agent sees', 'what you write'], [120, 34], [
      [222, 52],
      [262, 66],
      [290, 100]
    ])
  },
  {
    id: 'agent-checks-note',
    window: false,
    w: 320,
    h: 100,
    desk: { x: 30, y: 564, r: 2, s: 1 },
    start: 1.6,
    anchor: 'agents',
    ...note(['it checks your work'], [190, 62], [
      [70, 52],
      [52, 30],
      [50, 4]
    ])
  },
  {
    id: 'agent-builds-note',
    window: false,
    w: 320,
    h: 110,
    desk: { x: 505, y: 514, r: -2, s: 1 },
    start: 2.0,
    anchor: 'agents',
    ...note(['it explains', 'until it clicks'], [206, 50], [
      [124, 46],
      [80, 34],
      [56, 4]
    ])
  },
  ...(
    [
      ['sees', 'your agent sees what you write', 190],
      ['checks', 'it checks your work', 412],
      ['builds', 'it explains until it clicks', 668]
    ] as const
  ).map(
    ([id, text, y]): SpriteDef => ({
      id: `agent-${id}-caption`,
      window: false,
      w: 360,
      h: 44,
      desk: { x: 0, y: 0, r: 0, s: 1 },
      phone: { x: 0, y, r: -1.5, s: 0.85 },
      deskOff: true,
      start: 0.4,
      anchor: 'agents',
      ...note([text], [180, 22], null)
    })
  ),
  // The download section (anchor `download`, DownloadSection.tsx): one big hand line over the button, a few quiet drawings round it.
  { id: 'dl-line', window: false, w: 820, h: 120, desk: { x: 0, y: 110, r: -1, s: 1 }, start: 0, anchor: 'download', ...heading([['open a board, start learning', 'text']], 66) },
  // On a phone the line breaks in two, at a size that reads like the hero's headline there.
  { id: 'dl-line-phone', window: false, w: 360, h: 130, desk: { x: 0, y: 0, r: 0, s: 1 }, phone: { x: 0, y: 66, r: -1, s: 1 }, deskOff: true, start: 0, anchor: 'download', ...heading([['open a board,', 'text'], ['start learning', 'text']], 44) },
  { id: 'dl-bulb', window: false, w: 110, h: 130, desk: { x: -500, y: 170, r: -9, s: 1 }, phone: { x: -150, y: 300, r: -9, s: 0.55 }, start: 0.9, anchor: 'download', make: bulbInk },
  { id: 'dl-arrow', window: false, w: 190, h: 120, desk: { x: -266, y: 196, r: 0, s: 1 }, start: 1.6, anchor: 'download', make: loopArrowInk },
  { id: 'dl-stars', window: false, w: 150, h: 100, desk: { x: 470, y: 250, r: 6, s: 1 }, phone: { x: 148, y: 300, r: 6, s: 0.6 }, start: 1.2, anchor: 'download', make: starsInk },
  // The use cases' step marks behind the app shell's window (steps.ts, after the founder's sketch): the
  // question down one margin, a hand-drawn line over the step's area down the other; the sides change each step.
  ...(
    [
      ['sky', 'blue', 'left', [['why is', 26, -4, -2], ['the sky', 28, 3, 2], ['blue?', 34, -3, 0]], ['why is the sky', 'blue?']],
      ['check', 'green', 'right', [['I cannot', 24, 5, 0], ['solve it,', 26, -3, -2], ['help me?', 26, 2, 0]], ['I cannot solve it,', 'help me?']],
      ['sheet', 'yellow', 'left', [['2,000+ rows', 19, -5, -2], ["I'm lost", 26, 2, 0], ['explain simply?', 16, -3, 2]], ["2,000+ rows, I'm lost,", 'explain simply?']]
    ] as const
  ).flatMap(([id, color, side, words, lines], index): SpriteDef[] => {
    const other = side === 'left' ? 'right' : 'left'
    return [
      { id: `${id}-question`, window: false, ...QUESTION_BOX, desk: { x: 0, y: 0, r: 0, s: 1 }, start: 0, step: { index, side, y: 'upper' }, make: () => stackedQuestion(words, color), text: words.map(([word]) => word).join(' ') },
      { id: `${id}-line`, window: false, w: LINE_W, h: 100, desk: { x: 0, y: 0, r: 0, s: 1 }, start: 0, step: { index, side: other, y: 'span' }, make: () => stepLine(other, color, index) },
      { id: `${id}-question-phone`, window: false, ...PHONE_QUESTION_BOX, desk: { x: 0, y: 0, r: 0, s: 1 }, phone: { x: 0, y: -PHONE_QUESTION_BOX.h / 2 - 14, r: 0, s: 1 }, deskOff: true, start: 0, step: { index, side, y: 'above' }, make: () => lineQuestion(lines, color), text: lines.join(' ') }
    ]
  })
]
