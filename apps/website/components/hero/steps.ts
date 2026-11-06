/**
 * The use cases' step marks on the page (decision D12, after the founder's sketch): for each step
 * of the app shell, the question written word under word down one margin, and one hand-drawn line
 * down the other margin that spans the step's area, one quick gesture each. The sides change
 * from step to step. They are board items in the layer behind the shell (layout.ts `step`), so
 * they scroll past the window; the shell shows a step while the viewport's centre is inside its
 * line (lib/shell-steps.ts). Each draws on once when it first comes on screen, then stays still:
 * its draw function returns true when it is finished, and the engine stops painting it.
 * On a phone the question is one or two short lines above the window and there is no line.
 */
import { humanize, strokeSeed, type InkPoint, type Point } from '@/lib/board/hand'
import { Ink, share, write } from '@/lib/board/kit'
import { mulberry32 } from '@/lib/board/random'
import { spline } from '@/lib/board/spline'
import type { Draw } from './scene'

/** The stacked question's box (design units). Its words are centred on x = 65; it fits the ~123-unit margin at 1440 px. */
export const QUESTION_BOX = { w: 130, h: 440 }
/** The phone's question box: one or two lines, centred. */
export const PHONE_QUESTION_BOX = { w: 340, h: 76 }
const PACE = 1.7

/** A word of the question: its text, size, turn (degrees) and a small sideways shift. */
export type Word = readonly [text: string, size: number, turn: number, shift: number]

/** The question, word under word; the lines are spaced by their sizes. */
export function stackedQuestion(words: readonly Word[], color: string): Draw {
  let placed: { ink: Ink; x: number; y: number; r: number; at: number }[] | null = null
  return (g, t, still) => {
    if (t < 0) return
    if (!placed) {
      // The words sit in the middle of the box, so the box's place is the question's middle.
      const total = words.reduce((sum, [, size]) => sum + size * 1.24 + 6, -6)
      let y = (QUESTION_BOX.h - total) / 2
      let at = 0
      placed = words.map(([text, size, turn, shift]) => {
        const ink = write(text, size, 0, 0, color, { center: true })
        y += size * 0.62
        const item = { ink, x: QUESTION_BOX.w / 2 + shift, y, r: (turn * Math.PI) / 180, at }
        y += size * 0.62 + 6
        at += ink.duration / PACE + 0.1
        return item
      })
    }
    let done = true
    for (const p of placed) {
      const k = still ? 1 : share(t, p.at, p.ink, PACE)
      if (k < 1) done = false
      if (k > 0) g.at(p.x, p.y, p.r, 1, () => g.ink(p.ink, k))
    }
    return done
  }
}

/** The phone's question: the same words on two short lines. */
export function lineQuestion(lines: readonly string[], color: string): Draw {
  let inks: Ink[] | null = null
  return (g, t, still) => {
    if (t < 0) return
    inks ??= lines.map((line, i) => write(line, 18, PHONE_QUESTION_BOX.w / 2, 20 + i * 28, color, { center: true }))
    let at = 0
    let done = true
    for (const ink of inks) {
      const k = still ? 1 : share(t, at, ink, PACE)
      if (k < 1) done = false
      g.ink(ink, k)
      at += ink.duration / PACE
    }
    return done
  }
}

/**
 * A step's line down the margin across from its question: one quick hand gesture that spans the
 * step's area from top to bottom (after the founder's pen lines). `side` is the margin it is in.
 */
export function stepLine(side: 'left' | 'right', color: string, index: number): Draw {
  let inks: Ink[] | null = null
  let builtFor = 0
  return (g, t, still, box) => {
    if (t < 0 || !box) return
    const h = box.h
    if (!inks || builtFor !== h) {
      builtFor = h
      inks = gestureInks(GESTURES[index % GESTURES.length], side, h, color, index)
    }
    let done = true
    let at = 0
    for (const ink of inks) {
      const k = still ? 1 : Math.min(1, Math.max(0, (t - at) / 1.4))
      if (k < 1) done = false
      g.ink(ink, k)
      at += 1.4
    }
    return done
  }
}

/**
 * The line's box width (design units), wider than the margin so a swing can pass a little behind
 * the window's edge; its height is the step's area (the engine sets it).
 */
export const LINE_W = 160

/** The width of the hero's ink lines (scene.ts: its waves and rays), so the step lines match them. */
const HERO_INK_WIDTH = 2.6

/**
 * A gesture: control points through which a smooth spline runs, as [x, v] with x in units across
 * the box (0..LINE_W) and v from 0 (the area's top) to 1 (its bottom). `side` is the margin it was
 * drawn for; in the other margin it is mirrored, so the window side stays the window side. Each
 * has a few large moves and long calm stretches between them, as a quick pen line does, and
 * simply starts and ends.
 */
interface Gesture {
  side: 'left' | 'right'
  strokes: [x: number, v: number][][]
}

const GESTURES: Gesture[] = [
  // An S down the margin, then a wide, soft belly out to the page's edge near the bottom.
  { side: 'right', strokes: [[[70, 0], [54, 0.12], [62, 0.26], [86, 0.4], [70, 0.52], [42, 0.62], [92, 0.74], [132, 0.86], [120, 0.96], [100, 1]]] },
  // One long, slow bulge across the margin and back.
  { side: 'left', strokes: [[[112, 0], [96, 0.1], [62, 0.24], [30, 0.4], [20, 0.56], [32, 0.73], [72, 0.87], [110, 1]]] },
  // A drift with one full loop a third of the way down, then an S to the end.
  {
    side: 'right',
    strokes: [[[70, 0], [58, 0.12], [50, 0.22], [58, 0.31], [76, 0.39], [110, 0.42], [130, 0.37], [118, 0.3], [88, 0.3], [64, 0.36], [46, 0.48], [40, 0.6], [66, 0.74], [88, 0.86], [80, 1]]]
  }
]

function gestureInks(gesture: Gesture, side: 'left' | 'right', h: number, color: string, index: number): Ink[] {
  const top = 8
  const tall = h - 16
  const mirror = gesture.side !== side
  return gesture.strokes.map((stroke, i) => {
    // A clean curve with the big moves only: dense samples and almost no small wobble, at the hero ink's width.
    const pts = spline(stroke.map(([x, v]) => [mirror ? LINE_W - x : x, top + v * tall] as Point), 1)
    const hand: InkPoint[] = humanize(pts, 0.04, mulberry32(strokeSeed(`step-line-${index}-${i}`, pts)))
    return new Ink([hand], color, HERO_INK_WIDTH, 1)
  })
}
