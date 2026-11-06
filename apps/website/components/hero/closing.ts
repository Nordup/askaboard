/**
 * The board ink of the page's last sections (website plan, page items 4 and 5): the hand-written
 * headings, the "open source, MIT" note and a few loose drawings round the last download button.
 * Each draws on once when it first comes on screen and then rests: its Draw returns true when it
 * is finished, and the engine stops painting it. Same ink as the hero (scene.ts, lib/board).
 */
import type { Point } from '@/lib/board/hand'
import { arc, Ink, pen, share, star, write } from '@/lib/board/kit'
import { spline } from '@/lib/board/spline'
import { arrowLines, type Draw } from './scene'

/** Drawing on goes this many times faster than the board's natural pace (as scene.ts). */
const PACE = 1.7

/** Draw the inks on one after the other; true when every one is finished. */
function drawOnce(g: Parameters<Draw>[0], t: number, still: boolean, list: [Ink, number][]): boolean {
  let done = true
  for (const [ink, start] of list) {
    const k = still ? 1 : share(t, start, ink, PACE)
    if (k < 1) done = false
    g.ink(ink, k)
  }
  return done
}

/** A hand line of the heading: its text and colour. */
export type HandLine = readonly [text: string, color: string]

/**
 * A hand-written heading: lines centred in the box, one under the other, drawn on one after the
 * other. The whole heading shrinks to fit the box's width, so the same words fit a phone.
 * `underline`: a quick stroke under the last line, in that colour.
 */
export function handHeading(lines: readonly HandLine[], size: number, underline?: string): Draw {
  let inks: [Ink, number][] | null = null
  let fit = 1
  let height = 0
  return (g, t, still, box) => {
    if (t < 0 || !box) return
    if (!inks) {
      inks = []
      let at = 0
      let width = 0
      lines.forEach(([text, color], i) => {
        const ink = write(text, size, 0, i * size * 1.22, color, { center: true })
        inks!.push([ink, at])
        at += ink.duration / PACE + 0.08
        width = Math.max(width, ink.box.x1 - ink.box.x0)
      })
      height = (lines.length - 1) * size * 1.22
      if (underline) {
        const last = inks[inks.length - 1][0].box
        const y = last.y1 + size * 0.14
        const x0 = last.x0 + (last.x1 - last.x0) * 0.08
        const x1 = last.x1 - (last.x1 - last.x0) * 0.04
        const line: Point[] = spline([
          [x0, y + 3],
          [(x0 + x1) / 2, y - 1],
          [x1, y + 1]
        ])
        inks.push([pen([line], underline, Math.max(2.4, size / 18), 0.2, `underline-${lines.join()}`), at + 0.1])
        height += size * 0.3
      }
      fit = Math.min(1, (box.w - 8) / width)
    }
    let done = false
    g.at(box.w / 2, box.h / 2 - (height * fit) / 2, 0, fit, () => {
      done = drawOnce(g, t, still, inks!)
    })
    return done
  }
}

/** "open source, MIT" with an arrow up and to the left, at the GitHub link. Box 300 × 110. */
export function openSourceNote(): Draw {
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    if (!inks) {
      const curve = spline([
        [92, 82],
        [64, 77],
        [42, 62],
        [29, 40],
        [24, 12]
      ])
      const end = curve[curve.length - 1]
      const before = curve[curve.length - 6]
      const head = arrowLines(before[0], before[1], end[0], end[1], 9)[1]
      inks = [
        [write('open source, MIT', 15, 192, 84, 'green', { center: true }), 0],
        [pen([curve, head], 'green', 2.4, 0.2, 'mit-arrow'), 1.1]
      ]
    }
    return drawOnce(g, t, still, inks)
  }
}

/** A light bulb with three short rays: the idea. Box 110 × 130. */
export function bulbInk(): Draw {
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    inks ??= [
      [
        pen(
          [
            [...arc(55, 52, 26, Math.PI * 0.72, Math.PI * 2.28, 30)],
            [
              [39, 72],
              [45, 92]
            ],
            [
              [71, 72],
              [65, 92]
            ]
          ],
          'yellow',
          2.4,
          0.25,
          'bulb'
        ),
        0
      ],
      [
        pen(
          [
            [
              [45, 98],
              [65, 98]
            ],
            [
              [48, 105],
              [62, 105]
            ]
          ],
          'text',
          2.2,
          0.2,
          'bulb-base'
        ),
        0.7
      ],
      [
        pen(
          [
            [
              [16, 30],
              [8, 24]
            ],
            [
              [55, 12],
              [55, 3]
            ],
            [
              [94, 30],
              [102, 24]
            ]
          ],
          'yellow',
          2.4,
          0.2,
          'bulb-rays'
        ),
        1.1
      ]
    ]
    return drawOnce(g, t, still, inks)
  }
}

/** A loose arrow with one loop, down and to the right, toward the button. Box 190 × 120. */
export function loopArrowInk(): Draw {
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    if (!inks) {
      const curve = spline([
        [10, 30],
        [44, 22],
        [80, 30],
        [96, 52],
        [84, 70],
        [66, 62],
        [72, 42],
        [100, 36],
        [134, 52],
        [160, 82],
        [176, 104]
      ])
      const end = curve[curve.length - 1]
      const before = curve[curve.length - 7]
      inks = [[pen([curve, arrowLines(before[0], before[1], end[0], end[1], 11)[1]], 'blue', 2.6, 0.2, 'loop-arrow'), 0]]
    }
    return drawOnce(g, t, still, inks)
  }
}

/** Two small hand stars and a few dots. Box 150 × 100. */
export function starsInk(): Draw {
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    inks ??= [
      [pen([star(52, 46, 22)], 'pink', 2.4, 0.25, 'star-big'), 0],
      [pen([star(116, 70, 12)], 'yellow', 2.2, 0.2, 'star-small'), 0.6]
    ]
    const done = drawOnce(g, t, still, inks)
    const dots: Point[] = [
      [104, 22],
      [20, 86],
      [138, 36]
    ]
    dots.forEach(([x, y], i) => {
      const k = still ? 1 : Math.min(1, Math.max(0, (t - 1.1 - i * 0.15) / 0.2))
      if (k > 0) g.dot(x, y, 1.8, 'text', 0.8 * k)
    })
    return done && (still || t > 1.6)
  }
}
