/**
 * The hero's drawings: one per window and the loose ink between the windows (the founder's
 * reference image, decision D11). Each is drawn in board ink with the app's own code
 * (lib/board: write() text, humanize, drawStroke), in the local coordinates of its canvas.
 * A drawing first draws on, then keeps moving with its own period. `t` is the seconds since
 * the drawing's start (negative: not yet started); `still` (reduced motion) shows it finished.
 */
import { hex } from '@/lib/board/colors'
import { humanize, type InkPoint, type Point } from '@/lib/board/hand'
import { arc, clamp01, cyc, Ink, oval, pen, Pen, share, write } from '@/lib/board/kit'
import { drawStroke, revealPoints } from '@/lib/board/paint'
import { mulberry32 } from '@/lib/board/random'
import { spline } from '@/lib/board/spline'

/**
 * A drawing: `box` is the item's canvas size in its own units (a step's brace changes height with
 * the page). A drawing that becomes still returns true once it is finished; the engine then stops
 * painting it. A drawing that keeps moving returns nothing.
 */
export type Draw = (g: Pen, t: number, still: boolean, box?: { w: number; h: number }) => boolean | void

/**
 * The labels' size: write()'s letters run wider than the reference image's hand at the same size,
 * so the sizes below (read off the reference by eye) are scaled to match its text widths.
 */
const LABEL_SCALE = 0.74
export const label = (text: string, size: number, x: number, y: number, color = 'text', o: { center?: boolean } = {}): Ink => write(text, size * LABEL_SCALE, x, y, color, o)

/**
 * The words a drawing writes, in one table: its text, size, place, start (seconds), colour and
 * whether the text is centred on x. The drawing writes them (`labels`), and the page carries the
 * same words as text for readers that cannot see the canvas (`wordsOf`, layout.ts `text`).
 */
export type Label = readonly [text: string, size: number, x: number, y: number, start: number, color?: string, center?: boolean]
/** A table's words as ink; `scale` 1 writes at write()'s own size (closing.ts). */
export const labels = (list: readonly Label[], scale = LABEL_SCALE): [Ink, number][] =>
  list.map(([text, size, x, y, start, color = 'text', center = true]) => [write(text, size * scale, x, y, color, { center }), start])
/** A table's words as one line of text. */
export const wordsOf = (list: readonly Label[]): string => list.map(([text]) => text).join(' ')

/** The words of the hero's drawings (below). */
export const WAVES_WORDS: readonly Label[] = [
  ['two waves', 15, 106, 127, 1.9],
  ['(interference)', 15, 106, 146, 2.3],
  ['constructive', 15, 312, 120, 2.7],
  ['interference', 15, 316, 139, 3.1]
]
export const NEURON_WORDS: readonly Label[] = [
  ['neuron', 18, 84, 30, 0],
  ['dendrite', 14, 180, 108, 3.3],
  ['(receive)', 14, 182, 126, 3.6],
  ['axon', 14, 154, 292, 3.9],
  ['(send)', 14, 158, 311, 4.1],
  ['synapse', 14, 166, 430, 4.6],
  ['(to next neuron)', 13, 164, 449, 4.9]
]
export const CUBE_WORDS: readonly Label[] = [
  ['cube', 16, 64, 118, 1.6],
  ['rotate', 16, 220, 118, 2.6]
]
export const EARTH_WORDS: readonly Label[] = [
  ['short path', 13.5, 246, 18, 2.8, 'text', false],
  ['through air', 13.5, 246, 37, 3.0, 'text', false],
  ['air', 13, 352, 84, 3.2, 'blue'],
  ['(thickness exaggerated)', 11.5, 368, 102, 3.3, 'blue'],
  ['long path through air', 12.5, 118, 164, 3.6, 'orange'],
  ['Earth', 15, 238, 184, 3.9, 'green'],
  ['blue sky: light scattered toward you', 14.5, 222, 236, 4.1, 'blue'],
  ['red sunset: light left in the direct beam', 14.5, 232, 263, 4.5, 'orange']
]
export const MOVE_WORDS: readonly Label[] = [
  ['move things', 16, 0, 0, 0],
  ['around', 16, 4, 22, 0.8]
]
export const HINT_WORDS: readonly Label[] = [
  ['draw, write,', 22, 140, 42, 0],
  ['make shapes', 22, 146, 72, 0.9]
]

/** Drawing on goes this many times faster than the board's natural pace. */
const PACE = 1.7
export const TAU = Math.PI * 2

/**
 * A line that changes each frame, as pen ink: the same seed gives the same hand each frame. The
 * line runs as a smooth curve through its points (lib/board/spline.ts), so a few points do not
 * show as straight pieces.
 */
export function inkLine(g: Pen, line: Point[], color: string, width: number, seed: number, part = 1): void {
  if (part <= 0 || line.length < 2) return
  // A line that is the same as in its last frame (a seed is one line) keeps its points: a frame works out only the
  // lines that move.
  const last = held.get(seed)
  const same = !!last && sameLine(last.line, line)
  const points = same ? last!.points : humanize(spline(line), 0.25, mulberry32(seed))
  if (!same) held.set(seed, { line: line.map(([x, y]) => [x, y] as Point), points })
  drawStroke(g.ctx, { points: part < 1 ? revealPoints(points, part) : points, color: hex(color), width }, 0, g.a)
}

/** Each inkLine seed's last line and its ink points. */
const held = new Map<number, { line: Point[]; points: InkPoint[] }>()
const sameLine = (a: Point[], b: Point[]): boolean => a.length === b.length && a.every(([x, y], i) => x === b[i][0] && y === b[i][1])

/** Static inks that draw on one after the other: [ink, start second]. */
export function drawOn(g: Pen, t: number, still: boolean, list: [Ink, number][]): void {
  for (const [ink, start] of list) g.ink(ink, still ? 1 : share(t, start, ink, PACE))
}

/** How far a part that starts at `start` and takes `span` seconds is drawn. */
export const part = (t: number, still: boolean, start: number, span: number): number => (still ? 1 : clamp01((t - start) / span))

export const wave = (x0: number, x1: number, y: number, amp: number, len: number, phase: number, tilt = 0): Point[] => {
  const out: Point[] = []
  for (let x = x0; x <= x1 + 0.01; x += 2.5) out.push([x, y + tilt * (x - x0) + amp * Math.sin(((x - x0) / len) * TAU - phase)])
  return out
}

/** An arrow as pen ink: the shaft, then the head (the board's arrow head rule). */
export function arrowLines(x1: number, y1: number, x2: number, y2: number, head = 7): Point[][] {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1
  const ux = (x2 - x1) / length
  const uy = (y2 - y1) / length
  const wing = (a: number): Point => [x2 - head * (ux * Math.cos(a) - uy * Math.sin(a)), y2 - head * (uy * Math.cos(a) + ux * Math.sin(a))]
  return [
    [
      [x1, y1],
      [x2, y2]
    ],
    [wing(0.45), [x2, y2], wing(-0.45)]
  ]
}

/** Dashes along a straight line, as separate pen strokes. */
function dashes(x1: number, y1: number, x2: number, y2: number, on = 5, off = 4): Point[][] {
  const length = Math.hypot(x2 - x1, y2 - y1)
  const out: Point[][] = []
  for (let s = 0; s < length; s += on + off) {
    const e = Math.min(length, s + on)
    out.push([
      [x1 + ((x2 - x1) * s) / length, y1 + ((y2 - y1) * s) / length],
      [x1 + ((x2 - x1) * e) / length, y1 + ((y2 - y1) * e) / length]
    ])
  }
  return out
}

/** A point along a polyline at `s` (0..1) of its length. */
export function along(line: Point[], s: number): Point {
  let total = 0
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
  let left = clamp01(s) * total
  for (let i = 1; i < line.length; i++) {
    const d = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
    if (left <= d) {
      const k = d ? left / d : 0
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * k, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * k]
    }
    left -= d
  }
  return line[line.length - 1]
}

/** A soft glowing dot: a moving signal or a photon. */
export function glow(g: Pen, x: number, y: number, r: number, color: string, alpha = 1): void {
  g.dot(x, y, r * 2.4, color, 0.18 * alpha)
  g.dot(x, y, r, color, alpha)
}

// ---------- The windows (body coordinates: the window less its 28-unit title strip) ----------

/** Two waves in step add up to one tall wave: constructive interference. Body 400 × 172. */
export function wavesWindow(): Draw {
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    inks ??= [
      [
        pen(
          [
            [
              [180, 36],
              [187, 40],
              [188, 54],
              [189, 62],
              [196, 66],
              [189, 70],
              [188, 80],
              [187, 92],
              [180, 96]
            ]
          ],
          'text',
          2.4,
          0.2,
          'brace'
        ),
        1.0
      ],
      [pen(arrowLines(207, 66, 234, 66), 'text', 2.4, 0.2, 'waves-arrow'), 1.25],
      ...labels(WAVES_WORDS)
    ]
    // The waves move to the right, all in step.
    const phase = still ? 0.9 : t * 2.4
    inkLine(g, wave(32, 168, 46, 10, 46, phase, 0.01), 'yellow', 2.6, 11, part(t, still, 0, 0.7))
    inkLine(g, wave(34, 170, 84, 9, 46, phase, 0.01), 'blue', 2.6, 12, part(t, still, 0.45, 0.7))
    inkLine(g, wave(246, 378, 66, 27, 44, phase), 'pink', 2.6, 13, part(t, still, 1.45, 0.8))
    drawOn(g, t, still, inks)
  }
}

/** A neuron with its parts; a signal runs from the cell body down the axon. Body 270 × 477: the drawing sits 28 in from the left. */
export function neuronWindow(): Draw {
  const draw = neuronDrawing()
  return (g, t, still) => g.at(28, 4, 0, 1, () => draw(g, t, still))
}

function neuronDrawing(): Draw {
  const soma: Point = [62, 172]
  const dendrites: Point[][] = [
    [soma, [46, 142], [32, 114], [22, 92], [10, 70]],
    [[32, 114], [44, 94], [42, 72]],
    [[22, 92], [4, 88]],
    [soma, [66, 136], [70, 106], [72, 80], [66, 56]],
    [[70, 106], [88, 88], [96, 66]],
    [[72, 80], [86, 62]],
    [soma, [86, 150], [108, 130], [128, 112], [140, 94]],
    [[108, 130], [130, 138], [148, 132]],
    [[128, 112], [126, 90]],
    [soma, [90, 174], [118, 180], [140, 172]],
    [[118, 180], [134, 198]],
    [soma, [38, 174], [16, 168], [-2, 162]],
    [[16, 168], [4, 188]],
    [soma, [44, 194], [24, 208], [6, 216]]
  ]
  const axon: Point[] = [
    [62, 182],
    [61, 214],
    [60, 246],
    [59, 278],
    [58, 310],
    [57, 342],
    [56, 374],
    [56, 402]
  ]
  const ends: Point[] = [
    [20, 448],
    [36, 462],
    [56, 466],
    [76, 460],
    [94, 446]
  ]
  const capsule = (cx: number, y0: number, y1: number, r = 6): Point[] => [
    ...arc(cx, y0 + r, r, Math.PI, TAU, 10),
    [cx + r, y1 - r],
    ...arc(cx, y1 - r, r, 0, Math.PI, 10),
    [cx - r, y0 + r]
  ]
  let inks: [Ink, number][] | null = null
  const signalPath: Point[] = [soma, ...axon]
  return (g, t, still) => {
    if (t < 0) return
    inks ??= [
      [pen(dendrites, 'yellow', 2.2, 0.3, 'dendrites'), 0.5],
      [pen([arc(soma[0], soma[1], 7, 0, TAU, 18)], 'pink', 2.2, 0.15, 'soma'), 1.5],
      [pen([axon], 'yellow', 2.2, 0.2, 'axon'), 1.7],
      [pen([0, 1, 2, 3, 4].map((i) => capsule(60 - i, 218 + i * 32, 242 + i * 32)), 'green', 2.2, 0.15, 'myelin'), 2.0],
      [pen(ends.map((e) => [[56, 402], [(56 + e[0]) / 2 + 2, (402 + e[1]) / 2 - 4], e]), 'pink', 2.2, 0.25, 'terminals'), 2.6],
      [pen(ends.map((e) => arc(e[0], e[1] + 4, 4, 0, TAU, 10)), 'pink', 2, 0.1, 'synapses'), 3.0],
      [pen(arrowLines(130, 302, 80, 304, 6), 'text', 2, 0.2, 'axon-arrow'), 4.3],
      ...labels(NEURON_WORDS)
    ]
    g.dot(soma[0], soma[1], 2.4, 'pink', part(t, still, 1.6, 0.3))
    drawOn(g, t, still, inks)
    if (still || t < 5.6) return
    // The signal: down the axon in 1.8 s, then the synapses light up; one pulse every 3.4 s.
    const local = cyc(t - 5.6, 3.4)
    if (local < 1.8) {
      const [x, y] = along(signalPath, local / 1.8)
      glow(g, x, y, 3.2, 'yellow')
    } else if (local < 2.6) {
      const a = 1 - (local - 1.8) / 0.8
      for (const e of ends) glow(g, e[0], e[1] + 4, 2.6, 'pink', a)
    }
  }
}

/** A cube, and the same cube turning. Body 286 × 142. */
export function cubeWindow(): Draw {
  // The still cube: front square, back square up and to the right, hidden edges dashed.
  const f = { x: 40, y: 40, s: 46 }
  const b = { x: f.x + 20, y: f.y - 14 }
  const solid: Point[][] = [
    [
      [f.x, f.y],
      [f.x + f.s, f.y],
      [f.x + f.s, f.y + f.s],
      [f.x, f.y + f.s],
      [f.x, f.y]
    ],
    [
      [f.x, f.y],
      [b.x, b.y],
      [b.x + f.s, b.y],
      [b.x + f.s, b.y + f.s],
      [f.x + f.s, f.y + f.s]
    ],
    [
      [f.x + f.s, f.y],
      [b.x + f.s, b.y]
    ]
  ]
  const hidden = [...dashes(b.x, b.y, b.x, b.y + f.s), ...dashes(b.x, b.y + f.s, b.x + f.s, b.y + f.s), ...dashes(b.x, b.y + f.s, f.x, f.y + f.s)]
  const corners: number[][] = []
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z])
  const edges: [number, number][] = []
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) if (corners[i].filter((v, k) => v !== corners[j][k]).length === 1) edges.push([i, j])
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    inks ??= [
      [pen(solid, 'blue', 2.2, 0.15, 'cube'), 0],
      [pen(hidden, 'blue', 1.8, 0.1, 'cube-hidden'), 0.9],
      [pen(arrowLines(128, 58, 162, 58), 'yellow', 2.4, 0.2, 'cube-arrow'), 1.3],
      ...labels(CUBE_WORDS)
    ]
    drawOn(g, t, still, inks)
    // The turning cube: yaw at one turn per 7.5 s, a fixed tilt toward the viewer.
    const appear = part(t, still, 1.7, 0.6)
    if (appear <= 0) return
    const yaw = (still ? 0.55 : 0.55 + (t * TAU) / 7.5) % TAU
    const tilt = -0.42
    const half = 25
    const p = corners.map(([x, y, z]) => {
      const x1 = x * Math.cos(yaw) + z * Math.sin(yaw)
      const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw)
      const y2 = y * Math.cos(tilt) - z1 * Math.sin(tilt)
      const z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt)
      return [220 + x1 * half, 60 + y2 * half, z2]
    })
    let far = 0
    for (let i = 1; i < 8; i++) if (p[i][2] > p[far][2]) far = i
    const c = g.ctx
    g.fade(appear, () => {
      for (const [i, j] of edges) {
        const back = i === far || j === far
        c.setLineDash(back ? [4, 5] : [])
        g.seg(p[i][0], p[i][1], p[j][0], p[j][1], 'blue', back ? 1.6 : 2.2)
      }
      c.setLineDash([])
    })
  }
}

/** Why the sky is blue and the sunset red. Body 450 × 302. */
export function earthWindow(): Draw {
  const top: Point = [222, 20]
  const left: Point = [26, 139]
  const eye: Point = [222, 134]
  const beam: Point[] = [
    [top[0], top[1] + 12],
    [eye[0], eye[1] - 6]
  ]
  const long: Point[] = [
    [left[0] + 12, left[1]],
    [eye[0] - 8, eye[1]]
  ]
  const scatter: [Point, Point][] = [
    [
      [84, 136],
      [102, 108]
    ],
    [
      [126, 136],
      [144, 108]
    ],
    [
      [168, 135],
      [186, 107]
    ]
  ]
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    inks ??= [
      [pen([arc(225, 330, 250, Math.PI + 0.46, TAU - 0.46)], 'blue', 2.2, 0.2, 'air'), 0],
      [pen([arc(225, 336, 200, Math.PI + 0.36, TAU - 0.36)], 'green', 2.4, 0.2, 'earth'), 0.6],
      [pen([arc(top[0], top[1], 11, 0, TAU, 20)], 'yellow', 2.2, 0.15, 'sun-top'), 1.1],
      [pen([beam, ...arrowLines(top[0], 60, top[0], 76, 6).slice(1)], 'yellow', 2.6, 0.15, 'beam'), 1.3],
      [pen([arc(left[0], left[1], 11, 0, TAU, 20)], 'yellow', 2.2, 0.15, 'sun-left'), 1.6],
      [pen([long, ...arrowLines(40, 139, 62, 138.5, 6).slice(1)], 'orange', 2.6, 0.15, 'long'), 1.8],
      [pen(scatter.flatMap(([a, b]) => arrowLines(a[0], a[1], b[0], b[1], 6)), 'blue', 2, 0.15, 'scatter'), 2.4],
      [pen([oval(eye[0], eye[1], 7, 4), [[eye[0] + 0.5, eye[1]], [eye[0] - 0.5, eye[1]]]], 'text', 1.8, 0.05, 'eye'), 2.6],
      ...labels(EARTH_WORDS)
    ]
    drawOn(g, t, still, inks)
    if (still || t < 5.2) return
    const local = t - 5.2
    // Light from the high sun: a short path, so it arrives white.
    for (let k = 0; k < 3; k++) {
      const s = cyc(local, 2.6, k * 0.87) / 2.6
      const [x, y] = along(beam, s)
      glow(g, x, y, 2.2, 'yellow', Math.min(1, (1 - s) * 6))
    }
    // Light from the low sun: a long path; the blue leaves it on the way, the red goes on.
    for (let k = 0; k < 3; k++) {
      const s = cyc(local, 3.9, k * 1.3) / 3.9
      const [x, y] = along(long, s)
      glow(g, x, y, 2.4, s < 0.35 ? 'yellow' : 'orange', Math.min(1, (1 - s) * 6))
    }
    for (let k = 0; k < scatter.length; k++) {
      const s = cyc(local, 3.9, 3.9 - 0.35 * k - 0.6) / 3.9
      if (s > 0.3) continue
      const [x, y] = along(scatter[k], s / 0.3)
      glow(g, x, y, 2, 'blue', 1 - s / 0.3)
    }
  }
}

// ---------- The loose ink between the windows ----------

/** The sun over a hill; its rays pulse. Box 170 × 100. */
export function sunInk(): Draw {
  const sun: Point = [118, 45]
  const rays = [175, -145, -100, -60, -25, 20].map((d) => (d * Math.PI) / 180)
  // The hill: a circle through (5, 90), (85, 66) and (158, 90).
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    inks ??= [
      [pen([arc(82, 198, 132, -2.18, -0.96)], 'green', 2.4, 0.25, 'hill'), 0],
      [pen([arc(sun[0], sun[1], 15, 0, TAU, 28)], 'yellow', 2.4, 0.2, 'sun'), 0.5]
    ]
    drawOn(g, t, still, inks)
    const show = part(t, still, 1.0, 0.8)
    rays.forEach((a, i) => {
      const pulse = still ? 0 : Math.sin(t * 2.1 - i * 0.9) * 2.2
      const r0 = 21 + pulse * 0.4
      const r1 = 30 + pulse
      inkLine(
        g,
        [
          [sun[0] + r0 * Math.cos(a), sun[1] + r0 * Math.sin(a)],
          [sun[0] + r1 * Math.cos(a), sun[1] + r1 * Math.sin(a)]
        ],
        'yellow',
        2.4,
        40 + i,
        clamp01(show * rays.length - i)
      )
    })
  }
}

/** A planet with a ring, a small moon on the ring and stars that twinkle. Box 125 × 115. */
export function planetInk(): Draw {
  const c: Point = [62, 66]
  const rot = -0.36
  const stars: Point[] = [
    [27, 19],
    [45, 27],
    [82, 12],
    [15, 43],
    [114, 100]
  ]
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    inks ??= [
      [pen([oval(c[0], c[1], 40, 11, rot, Math.PI, TAU)], 'blue', 2.2, 0.15, 'ring-back'), 0],
      [pen([arc(c[0], c[1], 17, 0, TAU, 28)], 'yellow', 2.4, 0.2, 'planet'), 0.3],
      [pen([oval(c[0], c[1], 40, 11, rot, 0, Math.PI)], 'blue', 2.2, 0.15, 'ring-front'), 0.8]
    ]
    drawOn(g, t, still, inks)
    stars.forEach(([x, y], i) => {
      const a = part(t, still, 1.2 + i * 0.12, 0.2) * (still ? 0.8 : 0.55 + 0.45 * Math.sin(t * 1.7 + i * 2.3))
      g.dot(x, y, 1.6, 'text', a)
    })
    if (still || t < 1.6) return
    // The moon goes round the ring once in 6 s; behind the planet it is hidden.
    const a = (t * TAU) / 6
    const x = 40 * Math.cos(a)
    const y = 11 * Math.sin(a)
    const px = c[0] + x * Math.cos(rot) - y * Math.sin(rot)
    const py = c[1] + x * Math.sin(rot) + y * Math.cos(rot)
    const behind = Math.sin(a) < 0 && Math.hypot(px - c[0], py - c[1]) < 18
    if (!behind) g.dot(px, py, 2.4, 'text', 0.9)
  }
}

/** The yellow squiggle; it moves along slowly. Box 165 × 45. */
export function squiggleInk(): Draw {
  return (g, t, still) => {
    if (t < 0) return
    const phase = still ? 0 : t * 1.3
    inkLine(g, wave(8, 157, 30, 8, 50, phase, -0.09), 'yellow', 2.4, 77, part(t, still, 0, 0.9))
  }
}

/** "move things around" with a hand cursor that taps, large enough to read as an invitation. Box 175 × 85 at MOVE_SCALE. */
export const MOVE_SCALE = 1.45
export function moveInk(): Draw {
  const draw = moveDrawing()
  return (g, t, still) => g.at(0, 0, 0, MOVE_SCALE, () => draw(g, t, still))
}

function moveDrawing(): Draw {
  const hand = [
    'M22 14a8 8 0 0 1-8 8',
    'M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2',
    'M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1',
    'M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10',
    'M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15'
  ]
  let paths: Path2D[] | null = null
  let inks: [Ink, number][] | null = null
  const ticks: [number, number][] = [
    [-1.75, 7],
    [-1.05, 8],
    [-0.45, 7]
  ]
  return (g, t, still) => {
    if (t < 0) return
    paths ??= hand.map((d) => new Path2D(d))
    inks ??= labels(MOVE_WORDS)
    g.at(64, 26, -0.2, 1, () => drawOn(g, t, still, inks!))
    const show = part(t, still, 1.4, 0.4)
    if (show <= 0) return
    // The hand drags a little to the side and back; it taps at each end.
    const local = still ? 0 : cyc(t - 1.4, 3.2)
    const sway = still ? 0 : -Math.cos((local / 3.2) * TAU) * 5 + 5
    const tip: Point = [139 + sway, 52]
    const c = g.ctx
    g.fade(show, () => {
      c.save()
      c.translate(tip[0] - 8 * 1.15, tip[1] - 2 * 1.15)
      c.scale(1.15, 1.15)
      c.lineWidth = 1.9
      c.lineCap = 'round'
      c.lineJoin = 'round'
      c.strokeStyle = hex('text')
      c.globalAlpha = g.a
      for (const p of paths!) c.stroke(p)
      c.restore()
      c.globalAlpha = 1
      // Ticks round the fingertip, at each tap.
      const tap = still ? 1 : Math.max(clamp01(1 - Math.abs(local - 0.05) / 0.5), clamp01(1 - Math.abs(local - 1.65) / 0.5))
      if (tap <= 0) return
      g.fade(tap, () => {
        for (const [a, r] of ticks) {
          const r0 = r + 4
          const r1 = r + 11
          g.seg(tip[0] + r0 * Math.cos(a), tip[1] + r0 * Math.sin(a), tip[0] + r1 * Math.cos(a), tip[1] + r1 * Math.sin(a), 'yellow', 2)
        }
      })
    })
  }
}

/** The hint at the tool pill: "draw, write, make shapes" and an arrow to the pill's right end. Box 225 × 100. */
export function pillHint(): Draw {
  const arrow: Point[] = [
    [62, 60],
    [44, 58],
    [28, 50],
    [16, 38],
    [9, 26]
  ]
  let inks: [Ink, number][] | null = null
  return (g, t, still) => {
    if (t < 0) return
    inks ??= labels(HINT_WORDS)
    drawOn(g, t, still, inks)
    // The arrow draws on, then its tip nods toward the pill now and then.
    const nod = still ? 0 : Math.max(0, Math.sin((cyc(t - 2.4, 4.2) / 4.2) * TAU * 2)) * 3 * (cyc(t - 2.4, 4.2) < 1.05 ? 1 : 0)
    const line = arrow.map(([x, y], i) => [x - (nod * i) / arrow.length, y - (nod * i) / arrow.length] as Point)
    const reveal = part(t, still, 1.7, 0.5)
    inkLine(g, line, 'yellow', 2.6, 91, reveal)
    if (reveal < 1) return
    const [tx, ty] = line[line.length - 1]
    const [px, py] = line[line.length - 2]
    const a = Math.atan2(ty - py, tx - px)
    for (const side of [0.5, -0.5]) inkLine(g, [[tx - 9 * Math.cos(a + side), ty - 9 * Math.sin(a + side)], [tx, ty]], 'yellow', 2.6, side > 0 ? 92 : 93)
  }
}
