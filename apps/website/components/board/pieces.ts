/**
 * The things on the hero board: a classroom board after the students had it.
 * Each piece draws in its own board units around its box; the stage (stage.ts)
 * places, turns and scales it, and keeps the header clear.
 */
import { arc, box as rect, clamp01, cyc, ease, fadeEnd, Ink, oval, pen, share, star, write, type Pen, type Point } from '@/lib/board/kit'

export interface Piece {
  id: string
  /** x0, y0, x1, y1 in the piece's own units: what is drawn, for layout and dragging. */
  box: [number, number, number, number]
  /** Desktop place of the box centre: fractions of the hero's width and height. */
  at: [number, number]
  /** Degrees. */
  rot?: number
  size?: number
  /** Phone place: the band above or below the header, fractions of its width and height. No phone: not on phones. */
  phone?: { band: 'top' | 'bottom'; x: number; y: number; size?: number; rot?: number }
  /** The time of the still frame (prefers-reduced-motion). */
  still?: number
  draw(g: Pen, t: number, look: Point | null): void
}

const TAU = Math.PI * 2

function bounds(inks: Ink[], pad = 4, extra: [number, number, number, number] | null = null): [number, number, number, number] {
  let [x0, y0, x1, y1] = extra ?? [Infinity, Infinity, -Infinity, -Infinity]
  for (const ink of inks) {
    x0 = Math.min(x0, ink.box.x0 - pad)
    y0 = Math.min(y0, ink.box.y0 - pad)
    x1 = Math.max(x1, ink.box.x1 + pad)
    y1 = Math.max(y1, ink.box.y1 + pad)
  }
  return [x0, y0, x1, y1]
}

/** Where an eye at x, y looks: toward the pointer, at most r away. */
function gaze(look: Point | null, x: number, y: number, r: number): Point {
  if (!look) return [0, 0]
  const dx = look[0] - x
  const dy = look[1] - y
  const d = Math.hypot(dx, dy) || 1
  const k = Math.min(1, d / 30) * r
  return [(dx / d) * k, (dy / d) * k]
}

/** A short wave packet: a squiggle of `len` along the direction a. */
function squiggle(g: Pen, x: number, y: number, a: number, color: string, len = 16, amp = 3): void {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const pts: Point[] = []
  for (let i = 0; i <= 16; i++) {
    const u = (i / 16) * len - len / 2
    const v = amp * Math.sin((i / 16) * TAU * 2)
    pts.push([x + u * c - v * s, y + u * s + v * c])
  }
  g.line(pts, color, 2)
}

/** A text that writes itself, holds and fades, in a loop. */
function looping(id: string, ink: Ink, at: [number, number], period: number, o: Partial<Piece> = {}, offset = 0): Piece {
  return {
    id,
    box: bounds([ink]),
    at,
    still: period / 2,
    ...o,
    draw(g, t) {
      const local = cyc(t, period, offset)
      g.ink(ink, share(local, 0.3, ink), fadeEnd(local, period))
    }
  }
}

/** A text written once, a little after the page opens, that stays. */
function once(id: string, inks: Ink[], at: [number, number], start: number, o: Partial<Piece> = {}): Piece {
  return {
    id,
    box: bounds(inks),
    at,
    still: 30,
    ...o,
    draw(g, t) {
      let s = start
      for (const ink of inks) {
        g.ink(ink, share(t, s, ink))
        s += ink.duration + 0.15
      }
    }
  }
}

function planet(): Piece {
  const tilt = -0.25
  const body = pen([arc(0, 0, 30)], 'warn', 2.6, 0.3, 'planet')
  const back = pen([oval(0, 0, 62, 14, tilt, Math.PI, TAU)], 'purple', 2.4, 0.2, 'ring-back')
  const front = pen([oval(0, 0, 62, 14, tilt, 0, Math.PI)], 'purple', 2.4, 0.2, 'ring-front')
  const label = write('saturn-ish', 13, 46, -66, 'muted')
  const pointer = pen([[[52, -46], [38, -20]]], 'muted', 1.6, 0.2, 'planet-pointer')
  const moon = (t: number, g: Pen): void => {
    const a = t * 0.8
    const x = 88 * Math.cos(a)
    const y = 24 * Math.sin(a)
    const mx = x * Math.cos(tilt) - y * Math.sin(tilt)
    const my = x * Math.sin(tilt) + y * Math.cos(tilt)
    g.circle(mx, my, 6, 'text', 2)
    g.dot(mx - 1.5, my - 1.2, 1.6, 'muted')
  }
  return {
    id: 'planet',
    box: [-96, -70, 120, 46],
    at: [0.085, 0.17],
    rot: -6,
    phone: { band: 'top', x: 0.24, y: 0.42 },
    draw(g, t) {
      const behind = Math.sin(t * 0.8) < 0
      if (behind) moon(t, g)
      g.ink(back)
      g.fill(arc(0, 0, 29.5, 0, TAU, 40), 'bg')
      g.ink(body)
      g.ellipse(0, -10, 27, 3.5, 0, 'warn', 1.4, 0, Math.PI)
      g.ellipse(0, 9, 27, 3.5, 0, 'warn', 1.4, 0, Math.PI)
      // Spots that ride round as it turns.
      for (let k = 0; k < 3; k++) {
        const p = t * 0.7 + k * 2.1
        const depth = Math.cos(p)
        if (depth <= 0.1) continue
        g.ellipse(26 * Math.sin(p), -14 + k * 12, 4.5 * depth, 2.4, 0, 'orange', 1.6)
      }
      g.ink(front)
      if (!behind) moon(t, g)
      g.ink(label, share(t, 1.2, label))
      g.ink(pointer, share(t, 1.2 + label.duration, pointer))
    }
  }
}

function teacher(): Piece {
  const body = pen(
    [
      arc(0, -72, 13),
      [
        [0, -59],
        [0, -10]
      ],
      [
        [-13, 28],
        [0, -10],
        [13, 28]
      ],
      [
        [-15, -24],
        [0, -47],
        [20, -58]
      ]
    ],
    'text',
    2.6,
    0.3,
    'teacher'
  )
  const glasses = pen([arc(-5, -73, 4.5), arc(5.5, -73, 4.5)], 'muted', 1.5, 0.1, 'glasses')
  const bubble = pen([oval(92, -128, 66, 22, -0.04), [[58, -110], [36, -94], [70, -112]]], 'muted', 2, 0.3, 'bubble')
  const lines = ['any questions?', 'pens down!', 'who drew the cat?'].map((s) => write(s, 15, 92, -128, 'text', { center: true }))
  return {
    id: 'teacher',
    box: [-24, -156, 162, 32],
    at: [0.09, 0.47],
    phone: undefined,
    still: 3,
    draw(g, t, look) {
      g.ink(body)
      g.ink(glasses)
      for (const [x, y] of [
        [-5, -73],
        [5.5, -73]
      ]) {
        const [ex, ey] = gaze(look, x, y, 1.8)
        g.dot(x + ex, y + ey, 1.5, 'text')
      }
      const tap = Math.max(0, Math.sin(t * 7)) * (cyc(t, 4) < 1.5 ? 1 : 0)
      const a = -0.8 - 0.14 * tap
      g.seg(20, -58, 20 + 58 * Math.cos(a), -58 + 58 * Math.sin(a), 'orange', 2.4)
      g.ink(bubble, share(t, 0.4, bubble))
      const local = cyc(t, 6)
      const line = lines[Math.floor(t / 6) % lines.length]
      g.ink(line, share(local, 0.6, line), fadeEnd(local, 6, 0.6))
    }
  }
}

function equation(): Piece {
  const l1 = write('2x + 3 = 7', 22, 0, 0)
  const note = write('−3 both sides', 12, l1.box.x1 + 12, 6, 'muted')
  const l2 = write('2x = 10', 22, 0, 38)
  const strike = pen([[[l2.box.x0 - 5, l2.box.y1 - 6], [l2.box.x1 + 5, l2.box.y0 + 5]]], 'bad', 2.6, 0.3, 'strike')
  const l3 = write('2x = 4', 22, l2.box.x1 + 20, 38)
  const l4 = write('x = 2', 22, 4, 78)
  const check = write('✓', 24, l4.box.x1 + 16, 74, 'good')
  const cx = (l4.box.x0 + l4.box.x1) / 2
  const cy = (l4.box.y0 + l4.box.y1) / 2
  const ring = pen([oval(cx, cy, (l4.box.x1 - l4.box.x0) / 2 + 13, 19, -0.06, -0.4, TAU + 0.15)], 'accent', 2.4, 0.4, 'eq-ring')
  const steps: [Ink, number][] = []
  let at = 0.4
  for (const [ink, gap] of [
    [l1, 0.4],
    [note, 0.7],
    [l2, 0.6],
    [strike, 0.5],
    [l3, 0.8],
    [l4, 0.5],
    [check, 0.3],
    [ring, 0]
  ] as [Ink, number][]) {
    steps.push([ink, at])
    at += ink.duration + gap
  }
  const period = 18
  return {
    id: 'equation',
    box: bounds([l1, note, l2, l3, l4, check, ring], 6),
    at: [0.2, 0.68],
    rot: -3,
    phone: { band: 'bottom', x: 0.3, y: 0.2, size: 0.85 },
    still: 14,
    draw(g, t) {
      const local = cyc(t, period)
      const fade = fadeEnd(local, period)
      for (const [ink, start] of steps) g.ink(ink, share(local, start, ink), fade)
    }
  }
}

function sky(): Piece {
  const sun = pen([arc(-100, 0, 11)], 'warn', 2.4, 0.3, 'sky-sun')
  const air = pen([arc(0, 0, 4), arc(7, -6, 3.5), arc(-5, 7, 3.5)], 'muted', 1.6, 0.1, 'air')
  const title = write('why is the sky blue?', 13, -116, -74, 'muted')
  const blue = write('blue scatters', 13, -58, -50, 'accent')
  const red = write('red goes on', 13, 40, 10, 'bad')
  const angles = [-2.5, -1.9, -1.2, -0.7, 0.8, 1.4, 2.0, 2.6]
  return {
    id: 'sky',
    box: [-118, -78, 122, 32],
    at: [0.095, 0.875],
    rot: 2,
    phone: { band: 'bottom', x: 0.68, y: 0.39, size: 0.8 },
    still: 3.4,
    draw(g, t) {
      g.ink(sun)
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + t * 0.2
        g.seg(-100 + 15 * Math.cos(a), 15 * Math.sin(a), -100 + 20 * Math.cos(a), 20 * Math.sin(a), 'warn', 1.6)
      }
      g.fade(0.35, () => g.seg(-84, 0, -8, 0, 'text', 1.4))
      g.fade(0.5, () => g.arrow(8, 0, 112, 0, 'bad', 1.6))
      g.ink(air)
      for (let k = 0; k < 3; k++) {
        const local = cyc(t, 2.4, k * 0.8)
        const n = Math.floor((t + k * 0.8) / 2.4) + k
        if (local < 1) g.fade(0.9, () => squiggle(g, -82 + 74 * local, 0, 0, 'text'))
        else {
          const s = local - 1
          const fade = clamp01(1.2 - s)
          g.fade(fade, () => {
            squiggle(g, 10 + 90 * s, 0, 0, 'bad')
            for (const j of [n % 8, (n * 3 + 5) % 8]) {
              const a = angles[j]
              squiggle(g, (12 + 55 * s) * Math.cos(a), (12 + 55 * s) * Math.sin(a), a, 'accent', 14, 2.6)
            }
          })
        }
      }
      g.ink(title, share(t, 0.8, title))
      g.ink(blue, share(t, 2.0, blue))
      g.ink(red, share(t, 2.6, red))
    }
  }
}

function dna(): Piece {
  const label = write('DNA', 13, 72, -44, 'muted')
  return {
    id: 'dna',
    box: [-100, -46, 100, 24],
    at: [0.25, 0.94],
    rot: -12,
    draw(g, t) {
      const p = t * 1.4
      const a: Point[] = []
      const b: Point[] = []
      for (let i = 0; i <= 60; i++) {
        const x = -95 + (190 * i) / 60
        a.push([x, 16 * Math.sin(x * 0.075 + p)])
        b.push([x, -16 * Math.sin(x * 0.075 + p)])
      }
      for (let i = 0; i < 19; i++) {
        const x = -90 + i * 10
        const y = 16 * Math.sin(x * 0.075 + p)
        g.fade(0.8, () => g.seg(x, y, x, -y, i % 2 ? 'good' : 'warn', 1.5))
      }
      g.line(a, 'accent', 2.4)
      g.line(b, 'bad', 2.4)
      g.ink(label, share(t, 1, label))
      g.fade(0.6, () => g.seg(76, -30, 66, -18, 'muted', 1.4))
    }
  }
}

function why(): Piece {
  const word = write('why?', 26, 0, 0, 'bad')
  const x = word.box.x1 + 6
  const curve: Point[] = []
  for (let i = 0; i <= 20; i++) {
    const s = i / 20
    curve.push([x + 30 * Math.sin(s * 2.2), 14 + s * 52])
  }
  const end = curve[curve.length - 1]
  const tail = curve[curve.length - 3]
  const a = Math.atan2(end[1] - tail[1], end[0] - tail[0])
  const head: Point[] = [
    [end[0] - 10 * Math.cos(a - 0.45), end[1] - 10 * Math.sin(a - 0.45)],
    end,
    [end[0] - 10 * Math.cos(a + 0.45), end[1] - 10 * Math.sin(a + 0.45)]
  ]
  const arrow = pen([curve, head], 'bad', 2.4, 0.3, 'why-arrow')
  const period = 10
  return {
    id: 'why',
    box: bounds([word, arrow]),
    at: [0.175, 0.2],
    rot: -8,
    phone: { band: 'bottom', x: 0.52, y: 0.92, size: 0.75, rot: 6 },
    still: 5,
    draw(g, t) {
      const local = cyc(t, period, 3)
      const fade = fadeEnd(local, period)
      g.ink(word, share(local, 0.3, word), fade)
      g.ink(arrow, share(local, 0.5 + word.duration, arrow), fade)
    }
  }
}

function twinkle(id: string, at: [number, number], r: number, color: string, phone?: Piece['phone']): Piece {
  const ink = pen([star(0, 0, r)], color, 2, 0.2, id)
  return {
    id,
    box: [-r - 3, -r - 3, r + 3, r + 3],
    at,
    phone,
    draw(g, t) {
      const k = id.length + r
      g.at(0, 0, Math.sin(t * 0.6 + k) * 0.3, 0.85 + 0.18 * Math.sin(t * 2.3 + k), () => g.ink(ink, share(t, 0.2 + (k % 5) * 0.3, ink)))
    }
  }
}

function smiley(): Piece {
  const face = pen([arc(0, 0, 20)], 'warn', 2.4, 0.3, 'smiley')
  const smile = pen([arc(0, 1, 11, 0.25 * Math.PI, 0.75 * Math.PI)], 'warn', 2.2, 0.3, 'smile')
  return {
    id: 'smiley',
    box: [-24, -24, 24, 24],
    at: [0.15, 0.785],
    rot: 10,
    phone: { band: 'bottom', x: 0.9, y: 0.78, size: 0.8 },
    draw(g, t, look) {
      g.ink(face, share(t, 0.5, face))
      g.ink(smile, share(t, 0.5 + face.duration, smile))
      if (t > 0.5 + face.duration) for (const x of [-7, 7]) {
        const [ex, ey] = gaze(look, x, -6, 2.4)
        g.dot(x + ex, -6 + ey, 2.4, 'warn')
      }
    }
  }
}

function ticTacToe(): Piece {
  const grid = pen(
    [
      [[-15, -45], [-15, 45]],
      [[15, -45], [15, 45]],
      [[-45, -15], [45, -15]],
      [[-45, 15], [45, 15]]
    ] as Point[][],
    'muted',
    2.2,
    0.4,
    'ttt'
  )
  const cell = (c: number, r: number): Point => [(c - 1) * 30, (r - 1) * 30]
  const cross = (c: number, r: number): Ink => {
    const [x, y] = cell(c, r)
    return pen(
      [
        [[x - 8, y - 8], [x + 8, y + 8]],
        [[x + 8, y - 8], [x - 8, y + 8]]
      ] as Point[][],
      'accent',
      2.6,
      0.3,
      `x${c}${r}`
    )
  }
  const nought = (c: number, r: number): Ink => {
    const [x, y] = cell(c, r)
    return pen([arc(x, y, 9, -1.4, TAU - 1.2)], 'good', 2.6, 0.3, `o${c}${r}`)
  }
  const moves = [cross(1, 1), nought(0, 0), cross(2, 0), nought(1, 0), cross(0, 2)]
  const win = pen([[cell(2, 0).map((v, i) => v + (i ? -12 : 12)) as Point, cell(0, 2).map((v, i) => v + (i ? 12 : -12)) as Point]], 'bad', 2.8, 0.4, 'win')
  const period = 11
  return {
    id: 'ttt',
    box: [-50, -50, 50, 50],
    at: [0.325, 0.2],
    rot: 4,
    phone: { band: 'top', x: 0.56, y: 0.3, size: 0.75 },
    still: 7,
    draw(g, t) {
      const local = cyc(t, period, 1)
      const fade = fadeEnd(local, period)
      g.ink(grid, share(local, 0.2, grid), fade)
      moves.forEach((m, i) => g.ink(m, share(local, 1.4 + i * 0.85, m), fade))
      g.ink(win, share(local, 1.6 + moves.length * 0.85, win), fade)
    }
  }
}

function emc2(): Piece {
  const e = write('E = mc²', 26, 0, 0)
  const cx = (e.box.x0 + e.box.x1) / 2
  const cy = (e.box.y0 + e.box.y1) / 2
  const ring = pen([oval(cx, cy, (e.box.x1 - e.box.x0) / 2 + 16, (e.box.y1 - e.box.y0) / 2 + 12, -0.08, -0.5, TAU + 0.05)], 'accent', 2.4, 0.4, 'emc-ring')
  const bang = write('!!', 20, e.box.x1 + 22, -8, 'warn')
  const period = 12
  return {
    id: 'emc2',
    box: bounds([e, ring, bang]),
    at: [0.445, 0.235],
    rot: -4,
    phone: { band: 'top', x: 0.5, y: 0.82, size: 0.8, rot: -4 },
    still: 6,
    draw(g, t) {
      const local = cyc(t, period, 5)
      const fade = fadeEnd(local, period)
      g.ink(e, share(local, 0.3, e), fade)
      g.ink(ring, share(local, 0.6 + e.duration, ring), fade)
      g.ink(bang, share(local, 0.8 + e.duration + ring.duration, bang), fade)
    }
  }
}

function pi(): Piece {
  return looping('pi', write('π ≈ 3.14159 26535 89793…', 20, 0, 0), [0.5, 0.105], 13, { rot: 1, phone: { band: 'top', x: 0.5, y: 0.06, size: 0.85 } }, 2)
}

function plane(): Piece {
  const body = pen(
    [
      [[16, 0], [-12, -9], [-6, 0], [-12, 9], [16, 0]],
      [[-6, 0], [16, 0]]
    ] as Point[][],
    'text',
    2.2,
    0.2,
    'plane'
  )
  const place = (u: number): Point => [100 * Math.sin(u), 30 * Math.sin(2 * u)]
  return {
    id: 'plane',
    box: [-116, -42, 116, 42],
    at: [0.63, 0.165],
    phone: undefined,
    draw(g, t) {
      const u = t * 0.55
      for (let j = 1; j <= 26; j++) {
        const [x, y] = place(u - j * 0.035)
        g.dot(x, y, 1.3, 'muted', 1 - j / 26)
      }
      const [x, y] = place(u)
      const a = Math.atan2(60 * Math.cos(2 * u), 100 * Math.cos(u))
      g.at(x, y, a, 1, () => g.ink(body))
    }
  }
}

function moonPhases(): Piece {
  const r = 11
  const xs = Array.from({ length: 7 }, (_, i) => -96 + 32 * i)
  const outlines = pen(
    xs.map((x) => arc(x, 0, r)),
    'muted',
    1.8,
    0.15,
    'moons'
  )
  const label = write('moon phases', 12, -40, 18, 'muted')
  const lit = (cx: number, p: number): Point[] => {
    const out: Point[] = []
    const n = 14
    const waxing = p < 0.5
    for (let i = 0; i <= n; i++) {
      const a = waxing ? -Math.PI / 2 + (Math.PI * i) / n : Math.PI / 2 + (Math.PI * i) / n
      out.push([cx + r * Math.cos(a), r * Math.sin(a)])
    }
    for (let i = 0; i <= n; i++) {
      const y = waxing ? r - (2 * r * i) / n : -r + (2 * r * i) / n
      const w = Math.sqrt(Math.max(0, 1 - (y / r) ** 2))
      out.push([cx + (waxing ? 1 : -1) * r * Math.cos(TAU * p) * w, y])
    }
    return out
  }
  return {
    id: 'moons',
    box: [-112, -16, 112, 36],
    at: [0.6, 0.27],
    rot: -2,
    still: 5,
    draw(g, t) {
      xs.forEach((x, i) => {
        const p = (i / 8 + t / 14) % 1
        g.fill(lit(x, p), 'warn', 0.7)
      })
      g.ink(outlines, share(t, 0.4, outlines))
      g.ink(label, share(t, 2, label))
    }
  }
}

function hangman(): Piece {
  const gallows = pen(
    [
      [[-50, 40], [0, 40]],
      [[-35, 40], [-35, -40], [5, -40], [5, -30]]
    ] as Point[][],
    'muted',
    2.4,
    0.3,
    'gallows'
  )
  const head = pen([arc(5, -23, 7)], 'text', 2.2, 0.3, 'hm-head')
  const bodyInk = pen(
    [
      [[5, -16], [5, 4]],
      [[-3, -3], [5, -10], [13, -3]]
    ] as Point[][],
    'text',
    2.2,
    0.3,
    'hm-body'
  )
  const word = 'LEARN'
  const blanks = pen(
    Array.from({ length: 5 }, (_, i) => [
      [26 + 19 * i, 40],
      [38 + 19 * i, 40]
    ]) as Point[][],
    'text',
    2.2,
    0.2,
    'blanks'
  )
  const letters = [...word].map((ch, i) => write(ch, 16, 32 + 19 * i, 28, 'text', { center: true }))
  const missedLabel = write('missed:', 11, 26, -44, 'muted')
  const missed = [write('z', 14, 86, -42, 'bad'), write('q', 14, 100, -42, 'bad')]
  const order: [Ink, number][] = [
    [gallows, 0.2],
    [blanks, 1.2],
    [missedLabel, 1.8],
    [letters[1], 2.6],
    [missed[0], 3.6],
    [head, 3.9],
    [letters[2], 5.0],
    [missed[1], 6.0],
    [bodyInk, 6.3],
    [letters[0], 7.4],
    [letters[3], 8.4],
    [letters[4], 9.4]
  ]
  const period = 15
  return {
    id: 'hangman',
    box: [-54, -50, 122, 46],
    at: [0.785, 0.15],
    rot: 3,
    still: 11,
    draw(g, t) {
      const local = cyc(t, period, 4)
      const fade = fadeEnd(local, period)
      for (const [ink, start] of order) g.ink(ink, share(local, start, ink), fade)
    }
  }
}

function atom(): Piece {
  const orbits = pen([0, Math.PI / 3, (2 * Math.PI) / 3].map((rot) => oval(0, 0, 46, 15, rot)), 'purple', 1.8, 0.2, 'orbits')
  return {
    id: 'atom',
    box: [-50, -50, 50, 50],
    at: [0.895, 0.19],
    rot: 10,
    phone: { band: 'top', x: 0.82, y: 0.36, size: 0.8 },
    draw(g, t) {
      g.ink(orbits)
      g.dot(-3, -2, 5, 'bad')
      g.dot(4, 2, 5, 'accent')
      g.dot(2, -5, 4.5, 'bad')
      g.dot(-3, 5, 4.5, 'accent')
      for (let i = 0; i < 3; i++) {
        const rot = (i * Math.PI) / 3
        const a = t * (1.5 + 0.45 * i) + i * 2
        const x = 46 * Math.cos(a)
        const y = 15 * Math.sin(a)
        const ex = x * Math.cos(rot) - y * Math.sin(rot)
        const ey = x * Math.sin(rot) + y * Math.cos(rot)
        g.dot(ex, ey, 7, 'accent', 0.22)
        g.dot(ex, ey, 3.2, 'accent')
      }
    }
  }
}

function clock(): Piece {
  const face = pen([arc(0, 0, 30)], 'text', 2.4, 0.3, 'clock')
  const late = write('late!', 13, 20, 26, 'bad')
  return {
    id: 'clock',
    box: [-34, -34, 56, 44],
    at: [0.965, 0.13],
    rot: -8,
    phone: { band: 'bottom', x: 0.87, y: 0.19, size: 0.75 },
    still: 2,
    draw(g, t) {
      g.ink(face)
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU
        g.seg(24 * Math.cos(a), 24 * Math.sin(a), 27 * Math.cos(a), 27 * Math.sin(a), 'muted', 1.6)
      }
      const m = (t / 6) * TAU - Math.PI / 2
      const h = (t / 72) * TAU - Math.PI / 2
      g.seg(0, 0, 14 * Math.cos(h), 14 * Math.sin(h), 'text', 3)
      g.seg(0, 0, 21 * Math.cos(m), 21 * Math.sin(m), 'warn', 2.2)
      g.dot(0, 0, 2.6, 'text')
      const local = cyc(t, 6)
      g.ink(late, share(local, 0.2, late), fadeEnd(local, 6, 0.5) * (local < 3.5 ? 1 : 0))
    }
  }
}

function gearPoints(teeth: number, r: number, depth: number): Point[] {
  const out: Point[] = []
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * TAU
    const w = TAU / teeth
    for (const [da, rr] of [
      [0, r - depth],
      [w * 0.2, r],
      [w * 0.5, r],
      [w * 0.7, r - depth]
    ]) out.push([rr * Math.cos(a + da), rr * Math.sin(a + da)])
  }
  out.push(out[0])
  return out
}

function gears(): Piece {
  const big = pen([gearPoints(10, 30, 5), arc(0, 0, 7)], 'warn', 2.2, 0.15, 'gear-big')
  const small = pen([gearPoints(7, 21, 5), arc(0, 0, 5)], 'good', 2.2, 0.15, 'gear-small')
  const d = 47
  const sx = -26 + d * Math.cos(0.25)
  const sy = d * Math.sin(0.25)
  return {
    id: 'gears',
    box: [-60, -34, 48, 44],
    at: [0.94, 0.33],
    rot: 0,
    draw(g, t) {
      const a = t * 0.7
      g.at(-26, 0, a, 1, () => g.ink(big))
      g.at(sx, sy, -a * (10 / 7) + 0.22, 1, () => g.ink(small))
    }
  }
}

function doNotErase(): Piece {
  const frame = pen([rect(-92, -21, 184, 42)], 'warn', 2.4, 0.4, 'dne-frame')
  const text = write('DO NOT ERASE', 18, 0, 0, 'warn', { center: true })
  return once('dne', [frame, text], [0.82, 0.335], 0.6, { rot: -5, box: [-96, -25, 96, 25] })
}

function neuron(): Piece {
  const soma = pen([arc(-100, 0, 14)], 'purple', 2.4, 0.3, 'soma')
  const dendrites = pen(
    [
      [[-112, -8], [-130, -22], [-142, -20]],
      [[-130, -22], [-134, -36]],
      [[-112, 8], [-130, 18], [-136, 32]],
      [[-130, 18], [-146, 16]],
      [[-100, -14], [-96, -32], [-104, -42]],
      [[-96, -32], [-84, -40]]
    ] as Point[][],
    'purple',
    2,
    0.3,
    'dendrites'
  )
  const axonY = (x: number): number => 4 * Math.sin(x / 40)
  const axonPts: Point[] = Array.from({ length: 40 }, (_, i) => {
    const x = -86 + (186 * i) / 39
    return [x, axonY(x)]
  })
  const axon = pen([axonPts], 'accent', 2.4, 0.2, 'axon')
  const myelin = pen(
    [-60, -28, 4, 36, 68].map((x) => oval(x, axonY(x), 12, 5.5, Math.atan(Math.cos(x / 40) / 10))),
    'muted',
    1.8,
    0.15,
    'myelin'
  )
  const ends: Point[] = [
    [116, -12],
    [119, 0],
    [116, 12]
  ]
  const terminals = pen(
    ends.map((e) => [[100, axonY(100)], e] as Point[]),
    'accent',
    2,
    0.3,
    'terminals'
  )
  const spike = write('spike!', 13, 104, -36, 'warn')
  const label = write('neuron', 12, -132, 24, 'muted')
  return {
    id: 'neuron',
    box: [-150, -46, 132, 40],
    at: [0.855, 0.49],
    rot: -4,
    phone: { band: 'bottom', x: 0.55, y: 0.74, size: 0.7 },
    draw(g, t) {
      g.ink(dendrites)
      g.ink(soma)
      g.ink(axon)
      g.ink(myelin)
      g.ink(terminals)
      g.ink(label)
      const local = cyc(t, 2.8)
      const s = local / 1.7
      if (s < 1) {
        const x = -86 + 186 * s
        g.dot(x, axonY(x), 8, 'warn', 0.25)
        g.dot(x, axonY(x), 3.4, 'warn')
      } else {
        const flash = clamp01(1 - (local - 1.7) / 1)
        for (const [x, y] of ends) {
          g.dot(x, y, 6, 'warn', 0.3 * flash)
          g.dot(x, y, 2.6, 'warn', flash)
        }
        g.ink(spike, share(local, 1.7, spike, 2), flash)
      }
    }
  }
}

function graph(): Piece {
  const noise = [4, -6, 3, -2, 6, -5, 2, -3]
  const pts: Point[] = noise.map((n, i) => [-58 + 17 * i, 38 - 10 * i + n])
  const fit = pen([[[-64, 42], [66, -38]]], 'bad', 2.4, 0.3, 'fit')
  const label = write('trend?', 13, 34, -60, 'bad')
  const xl = write('x', 12, 80, 40, 'muted')
  const yl = write('y', 12, -84, -60, 'muted')
  const period = 12
  return {
    id: 'graph',
    box: [-88, -64, 92, 56],
    at: [0.785, 0.67],
    rot: 3,
    still: 8,
    draw(g, t) {
      const local = cyc(t, period, 2)
      const fade = fadeEnd(local, period)
      g.fade(fade, () => {
        g.arrow(-70, 50, -70, -56, 'muted', 2)
        g.arrow(-70, 50, 84, 50, 'muted', 2)
        g.ink(xl)
        g.ink(yl)
        pts.forEach(([x, y], i) => {
          const pop = clamp01((local - 0.6 - i * 0.45) / 0.25)
          if (pop > 0) g.dot(x, y, 3.2 * (pop < 1 ? 1.4 - 0.4 * pop : 1), 'accent')
        })
      })
      g.ink(fit, share(local, 4.6, fit), fade)
      g.ink(label, share(local, 4.8 + fit.duration, label), fade)
    }
  }
}

function rocket(): Piece {
  const nose = arc(0, -9, 15, -Math.PI + 0.75, -0.75).map(([x, y]) => [x, y - 13] as Point)
  const hull = pen(
    [
      [[-11, 22], ...nose, [11, 22], [-11, 22]],
      [[-11, 10], [-21, 27], [-11, 22]],
      [[11, 10], [21, 27], [11, 22]]
    ] as Point[][],
    'text',
    2.4,
    0.2,
    'rocket'
  )
  const window = pen([arc(0, -10, 5)], 'accent', 2, 0.1, 'window')
  return {
    id: 'rocket',
    box: [-26, -46, 26, 52],
    at: [0.97, 0.63],
    rot: 22,
    phone: { band: 'bottom', x: 0.92, y: 0.6, size: 0.8, rot: 20 },
    draw(g, t) {
      g.at(0, 3 * Math.sin(t * 3), 0, 1, () => {
        for (const [x, c, k] of [
          [-6, 'orange', 0],
          [0, 'warn', 1],
          [6, 'orange', 2]
        ] as [number, string, number][]) {
          const len = 10 + 8 * (0.5 + 0.5 * Math.sin(t * 17 + k * 2.1)) + (k === 1 ? 6 : 0)
          g.seg(x, 26, x * 1.3, 26 + len, c, 2.4)
        }
        g.ink(hull)
        g.ink(window)
      })
      for (const [x, k] of [
        [-30, 0],
        [30, 1]
      ]) {
        const y = cyc(t * 60 + k * 30, 70) - 20
        g.fade(0.5, () => g.seg(x, y, x, y + 14, 'muted', 1.4))
      }
    }
  }
}

function epicycles(): Piece {
  const label = write('circles draw a square', 12, -40, 34, 'muted')
  const harmonics = [1, 3, 5, 7]
  const R = 26
  return {
    id: 'epicycles',
    box: [-118, -42, 118, 50],
    at: [0.87, 0.88],
    rot: -2,
    phone: { band: 'bottom', x: 0.42, y: 0.56, size: 0.75 },
    draw(g, t) {
      const w = 1.3
      let x = -84
      let y = 0
      for (const n of harmonics) {
        const r = R / n
        g.circle(x, y, r, 'muted', 1.2)
        const a = n * w * t
        const nx = x + r * Math.cos(a)
        const ny = y - r * Math.sin(a)
        g.seg(x, y, nx, ny, 'muted', 1.4)
        x = nx
        y = ny
      }
      g.dot(x, y, 2.6, 'warn')
      const wave: Point[] = []
      for (let j = 0; j <= 120; j++) {
        let v = 0
        for (const n of harmonics) v += (R / n) * Math.sin(n * w * (t - j * 0.035))
        wave.push([-40 + j * 1.25, -v])
      }
      g.fade(0.5, () => g.seg(x, y, wave[0][0], wave[0][1], 'warn', 1.2))
      g.line(wave, 'accent', 2.4)
      g.ink(label, share(t, 1.5, label))
    }
  }
}

function ripples(): Piece {
  const label = write('two ripples', 12, -34, 46, 'muted')
  const max = 58
  return {
    id: 'ripples',
    box: [-80, -58, 80, 62],
    at: [0.36, 0.885],
    phone: { band: 'bottom', x: 0.18, y: 0.9, size: 0.7 },
    draw(g, t) {
      for (const [sx, color] of [
        [-22, 'accent'],
        [22, 'good']
      ] as [number, string][]) {
        for (let k = 0; k < 5; k++) {
          const r = (t * 16 + k * 12) % (max - 2)
          g.fade(1 - r / max, () => g.circle(sx, 0, r + 2, color, 1.6))
        }
        g.dot(sx, 0, 2.6, color)
      }
      g.ink(label, share(t, 2, label))
    }
  }
}

function pythagoras(): Piece {
  const tri = pen([[[-40, 24], [24, 24], [-40, -24], [-40, 24]]], 'good', 2.6, 0.3, 'tri')
  const corner = pen([[[-40, 15], [-31, 15], [-31, 24]]], 'good', 1.6, 0.1, 'corner')
  const a = write('a', 15, -50, 0, 'text', { center: true })
  const b = write('b', 15, -8, 35, 'text', { center: true })
  const c = write('c', 15, -1, -9, 'text', { center: true })
  const formula = write('a² + b² = c²', 20, -54, 50)
  const period = 13
  return {
    id: 'pythagoras',
    box: bounds([tri, a, b, c, formula]),
    at: [0.515, 0.88],
    rot: 4,
    phone: { band: 'bottom', x: 0.15, y: 0.72, size: 0.65 },
    still: 8,
    draw(g, t) {
      g.ink(tri, share(t, 0.5, tri))
      g.ink(corner, share(t, 0.6 + tri.duration, corner))
      let s = 0.8 + tri.duration
      for (const l of [a, b, c]) {
        g.ink(l, share(t, s, l))
        s += l.duration + 0.15
      }
      const local = cyc(t, period, 7)
      g.ink(formula, share(local, 0.4, formula), fadeEnd(local, period))
    }
  }
}

function cat(): Piece {
  const body = pen(
    [
      arc(-26, -14, 17),
      [[-39, -24], [-38, -42], [-29, -30]],
      [[-22, -31], [-13, -40], [-12, -22]],
      oval(10, 10, 30, 16, 0.05, -2.6, 2.4),
      [[-8, 24], [-9, 31]],
      [[24, 24], [25, 31]]
    ] as Point[][],
    'orange',
    2.4,
    0.3,
    'cat'
  )
  const whiskers = pen(
    [
      [[-34, -8], [-52, -11]],
      [[-34, -5], [-51, -1]],
      [[-18, -8], [-2, -11]]
    ] as Point[][],
    'muted',
    1.4,
    0.2,
    'whiskers'
  )
  const eyes = pen([arc(-32, -17, 3.4), arc(-21, -17, 3.4)], 'text', 1.6, 0.05, 'cat-eyes')
  const meow = write('meow', 13, -70, -62, 'muted')
  return {
    id: 'cat',
    box: [-72, -64, 84, 34],
    at: [0.6, 0.895],
    rot: -3,
    phone: { band: 'bottom', x: 0.82, y: 0.9, size: 0.8 },
    still: 3,
    draw(g, t, look) {
      const swish = Math.sin(t * 2.2)
      const tail: Point[] = [[38, 8]]
      let a = -0.9
      for (let i = 0; i < 12; i++) {
        a += -0.08 + swish * 0.07 * (i / 6)
        const [x, y] = tail[tail.length - 1]
        tail.push([x + 4.4 * Math.cos(a), y + 4.4 * Math.sin(a)])
      }
      g.line(tail, 'orange', 2.4)
      g.ink(body)
      g.ink(whiskers)
      g.ink(eyes)
      for (const x of [-32, -21]) {
        const [ex, ey] = gaze(look, x, -17, 1.4)
        g.dot(x + ex, -17 + ey, 1.6, 'good')
      }
      g.dot(-26, -10, 1.8, 'bad')
      const local = cyc(t, 9, 1)
      g.ink(meow, share(local, 0.3, meow), fadeEnd(local, 9, 0.6) * (local < 4 ? 1 : 0))
    }
  }
}

function eraser(): Piece {
  const word = write('homework', 18, -70, -14)
  const spiral = pen(
    [
      Array.from({ length: 60 }, (_, i) => {
        const a = i * 0.32
        const r = 1 + i * 0.3
        return [64 + r * Math.cos(a), -2 + r * Math.sin(a)] as Point
      })
    ],
    'purple',
    2,
    0.3,
    'erase-spiral'
  )
  const period = 11
  return {
    id: 'eraser',
    box: [-78, -28, 108, 26],
    at: [0.33, 0.775],
    rot: 2,
    still: 4,
    draw(g, t) {
      const local = cyc(t, period, 0)
      const wipe = ease((local - 5.6) / 1.8)
      const ex = -86 + 190 * wipe
      const ctx = g.ctx
      ctx.save()
      if (wipe > 0) {
        ctx.beginPath()
        ctx.rect(ex, -40, 400, 80)
        ctx.clip()
      }
      g.ink(word, share(local, 0.3, word))
      g.ink(spiral, share(local, 0.5 + word.duration, spiral))
      ctx.restore()
      const show = clamp01((local - 5.1) * 2) * clamp01((8.2 - local) * 2)
      if (show > 0)
        g.fade(show, () =>
          g.at(ex, -2, 0.12, 1, () => {
            g.fill(rect(-13, -21, 26, 42), 'card')
            g.line(rect(-13, -21, 26, 42), 'muted', 2)
            g.seg(-13, 6, 13, 6, 'accent', 2)
          })
        )
    }
  }
}

function sine(): Piece {
  return {
    id: 'sine',
    box: [-96, -26, 86, 26],
    at: [0.735, 0.8],
    rot: -3,
    draw(g, t) {
      const a = t * 1.6
      const cx = -70
      const px = cx + 22 * Math.cos(a)
      const py = -22 * Math.sin(a)
      g.circle(cx, 0, 22, 'muted', 1.6)
      g.seg(cx, 0, px, py, 'muted', 1.6)
      g.fade(0.6, () => g.seg(px, py, -40, py, 'accent', 1.2))
      const wave: Point[] = []
      for (let i = 0; i <= 80; i++) wave.push([-40 + i * 1.5, -22 * Math.sin(a - i * 0.08)])
      g.line(wave, 'accent', 2.4)
      g.dot(px, py, 3.4, 'accent')
    }
  }
}

function pendulum(): Piece {
  const ceiling = pen(
    [[[-20, -50], [20, -50]], ...[-16, -8, 0, 8, 16].map((x) => [[x, -50], [x + 5, -57]] as Point[])] as Point[][],
    'muted',
    1.8,
    0.2,
    'ceiling'
  )
  const label = write('T = 2π√(L/g)', 12, 14, 26, 'muted')
  return {
    id: 'pendulum',
    box: [-44, -58, 96, 44],
    at: [0.04, 0.68],
    rot: 0,
    draw(g, t) {
      g.ink(ceiling)
      const th = 0.45 * Math.sin(t * 2.4)
      const x = 70 * Math.sin(th)
      const y = -50 + 70 * Math.cos(th)
      for (let i = -6; i <= 6; i++) {
        const a = (i / 6) * 0.45
        g.dot(70 * Math.sin(a), -50 + 70 * Math.cos(a), 1, 'muted', 0.7)
      }
      g.seg(0, -50, x, y, 'text', 1.6)
      g.dot(x, y, 8, 'accent', 0.2)
      g.circle(x, y, 8, 'accent', 2.4)
      g.ink(label, share(t, 2.4, label))
    }
  }
}

function quiz(): Piece {
  const text = write('quiz on friday!!', 19, 0, 0, 'warn')
  const y = text.box.y1 + 6
  const u1 = pen([[[text.box.x0 - 2, y], [text.box.x1 + 4, y - 3]]], 'warn', 2.4, 0.4, 'u1')
  const u2 = pen([[[text.box.x0 + 8, y + 6], [text.box.x1 - 6, y + 4]]], 'warn', 2.2, 0.4, 'u2')
  return once('quiz', [text, u1, u2], [0.2, 0.31], 1.2, { rot: -5 })
}

function bars(): Piece {
  const heights = [26, 44, 34, 58]
  const period = 8
  return {
    id: 'bars',
    box: [-40, -62, 48, 6],
    at: [0.235, 0.475],
    rot: 2,
    still: 6,
    draw(g, t) {
      const local = cyc(t, period, 2)
      g.fade(fadeEnd(local, period), () => {
        g.seg(-38, 0, 46, 0, 'muted', 2)
        heights.forEach((h, i) => {
          const k = ease((local - 0.4 - i * 0.3) / 0.9)
          if (k <= 0) return
          const pts = rect(-30 + 20 * i, -h * k, 14, h * k)
          const color = i % 2 ? 'accent' : 'good'
          g.fill(pts, color, 0.18)
          g.line(pts, color, 2)
        })
      })
    }
  }
}

function venn(): Piece {
  const circles = pen([arc(-14, 0, 26), arc(14, 0, 26)], 'accent', 2.2, 0.3, 'venn')
  const cats = write('cats', 13, -26, -36, 'accent', { center: true })
  const dogs = write('dogs', 13, 26, -36, 'bad', { center: true })
  const q = write('?', 18, 0, 0, 'warn', { center: true })
  return once('venn', [circles, cats, dogs, q], [0.955, 0.955], 2.5, { rot: -6 })
}

function lissajous(): Piece {
  return {
    id: 'lissajous',
    box: [-38, -30, 38, 30],
    at: [0.025, 0.36],
    draw(g, t) {
      const p = t * 0.5
      const pts: Point[] = []
      for (let i = 0; i <= 160; i++) {
        const u = (i / 160) * TAU
        pts.push([34 * Math.sin(3 * u + p), 26 * Math.sin(2 * u)])
      }
      g.line(pts, 'good', 1.8)
    }
  }
}

function student(): Piece {
  const body = pen(
    [
      arc(0, -50, 11),
      [[0, -39], [0, -8]],
      [[-11, 26], [0, -8], [11, 26]],
      [[0, -32], [-14, -14]]
    ] as Point[][],
    'text',
    2.4,
    0.3,
    'student'
  )
  const me = write('me! me!', 14, 20, -92, 'good')
  return {
    id: 'student',
    box: [-22, -96, 82, 30],
    at: [0.7, 0.925],
    rot: 2,
    still: 2.5,
    draw(g, t, look) {
      g.ink(body)
      const a = -1.25 + 0.3 * Math.sin(t * 6)
      g.seg(0, -32, 30 * Math.cos(a), -32 + 30 * Math.sin(a), 'text', 2.4)
      for (const x of [-4, 4]) {
        const [ex, ey] = gaze(look, x, -52, 1.6)
        g.dot(x + ex, -52 + ey, 1.4, 'text')
      }
      const local = cyc(t, 5)
      g.ink(me, share(local, 0.2, me), fadeEnd(local, 5, 0.5))
    }
  }
}

function seasons(): Piece {
  const sun = pen([arc(0, 0, 10)], 'warn', 2.4, 0.3, 'season-sun')
  const summer = write('summer', 11, -70, -36, 'warn', { center: true })
  const winter = write('winter', 11, 70, -36, 'accent', { center: true })
  const tilt = 0.4
  return {
    id: 'seasons',
    box: [-96, -44, 96, 30],
    at: [0.905, 0.73],
    rot: 3,
    draw(g, t) {
      const a = t * 0.6
      const ex = 70 * Math.cos(a)
      const ey = 22 * Math.sin(a)
      const earth = (): void => {
        g.circle(ex, ey, 6, 'accent', 2.2)
        g.seg(ex - 10 * Math.sin(tilt), ey - 10 * Math.cos(tilt), ex + 10 * Math.sin(tilt), ey + 10 * Math.cos(tilt), 'text', 1.4)
      }
      for (let i = 0; i < 40; i++) {
        const b = (i / 40) * TAU
        g.dot(70 * Math.cos(b), 22 * Math.sin(b), 0.9, 'muted', 0.8)
      }
      if (Math.sin(a) < 0) earth()
      g.fill(arc(0, 0, 9.5, 0, TAU, 24), 'bg')
      g.ink(sun)
      for (let i = 0; i < 8; i++) {
        const b = (i / 8) * TAU + t * 0.3
        g.seg(14 * Math.cos(b), 14 * Math.sin(b), 18 * Math.cos(b), 18 * Math.sin(b), 'warn', 1.6)
      }
      if (Math.sin(a) >= 0) earth()
      g.ink(summer, share(t, 1.5, summer))
      g.ink(winter, share(t, 2, winter))
    }
  }
}

function heart(): Piece {
  const pts: Point[] = Array.from({ length: 50 }, (_, i) => {
    const u = (i / 49) * TAU
    return [1.1 * 16 * Math.sin(u) ** 3, -1.1 * (13 * Math.cos(u) - 5 * Math.cos(2 * u) - 2 * Math.cos(3 * u) - Math.cos(4 * u))]
  })
  const ink = pen([pts], 'bad', 2.4, 0.3, 'heart')
  return {
    id: 'heart',
    box: [-21, -18, 21, 21],
    at: [0.43, 0.715],
    rot: -12,
    phone: { band: 'bottom', x: 0.1, y: 0.42, size: 0.8 },
    draw(g, t) {
      const beat = Math.max(0, Math.sin(t * 4)) ** 6
      g.at(0, 0, 0, 1 + 0.12 * beat, () => g.ink(ink, share(t, 1.5, ink)))
    }
  }
}

function spiral(): Piece {
  const ink = pen(
    [
      Array.from({ length: 90 }, (_, i) => {
        const a = i * 0.24
        const r = 1 + i * 0.25
        return [r * Math.cos(a), r * Math.sin(a)] as Point
      })
    ],
    'muted',
    2,
    0.3,
    'spiral'
  )
  return looping('spiral', ink, [0.61, 0.78], 7, { rot: 0, box: [-26, -26, 26, 26] }, 1)
}

function todo(): Piece {
  const text = write('TODO: read p.42', 15, 0, 0, 'muted')
  const cy = (text.box.y0 + text.box.y1) / 2
  const strike = pen([[[text.box.x0 - 3, cy + 2], [text.box.x1 + 3, cy - 2]]], 'bad', 2.2, 0.3, 'todo-strike')
  const check = write('✓', 18, text.box.x1 + 10, -4, 'good')
  return once('todo', [text, strike, check], [0.77, 0.965], 3, { rot: 3 })
}

function hint(): Piece {
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  const ink = write(touch ? 'hold, then draw: it fades' : 'draw anywhere, it fades', 15, 0, 0, 'muted', { center: true })
  return once('hint', [ink], [0.5, 0.775], 2.4, { phone: { band: 'bottom', x: 0.5, y: 0.03, size: 1 } })
}

function pie(): Piece {
  const r = 22
  const circle = pen([arc(0, 0, r)], 'text', 2.2, 0.3, 'pie')
  const cuts = pen(
    [
      [[0, -r], [0, r]],
      [[-r, 0], [r, 0]]
    ] as Point[][],
    'text',
    1.8,
    0.3,
    'pie-cuts'
  )
  const label = write('1/4', 15, r + 8, -r - 6, 'warn')
  const slice: Point[] = [[0, 0], ...arc(0, 0, r - 2, -Math.PI / 2, 0, 12)]
  const period = 9
  return {
    id: 'pie',
    box: [-r - 4, -r - 10, r + 40, r + 4],
    at: [0.15, 0.535],
    rot: -8,
    still: 6,
    draw(g, t) {
      const local = cyc(t, period, 2)
      const fade = fadeEnd(local, period)
      g.ink(circle, share(local, 0.3, circle), fade)
      g.ink(cuts, share(local, 0.4 + circle.duration, cuts), fade)
      g.fade(fade * clamp01((local - 1.8) * 2), () => g.fill(slice, 'warn', 0.35))
      g.ink(label, share(local, 2.2, label), fade)
    }
  }
}

export function makePieces(): Piece[] {
  return [
    lissajous(),
    planet(),
    teacher(),
    equation(),
    sky(),
    dna(),
    why(),
    quiz(),
    bars(),
    pie(),
    pendulum(),
    smiley(),
    heart(),
    once('qm', [write('?!', 30, 0, 0, 'bad')], [0.255, 0.395], 3.2, { rot: 8 }),
    twinkle('star1', [0.03, 0.5], 9, 'warn', { band: 'top', x: 0.06, y: 0.1 }),
    twinkle('star2', [0.36, 0.055], 7, 'warn'),
    twinkle('star3', [0.97, 0.47], 10, 'warn', { band: 'top', x: 0.95, y: 0.86 }),
    twinkle('star4', [0.685, 0.255], 6, 'good'),
    ticTacToe(),
    pi(),
    emc2(),
    plane(),
    moonPhases(),
    once('integral', [write('∫ f(x) dx', 22, 0, 0, 'purple')], [0.29, 0.115], 4, { rot: -3 }),
    once('h2o', [pen([arc(0, 0, 12)], 'accent', 2.2, 0.3, 'O'), pen([arc(-16, 13, 8), arc(16, 13, 8)], 'text', 2, 0.3, 'H'), write('H₂O', 13, -12, 26, 'muted')], [0.695, 0.1], 2, { rot: 8 }),
    hangman(),
    atom(),
    clock(),
    doNotErase(),
    gears(),
    looping('limit', write('x → ∞', 20, 0, 0, 'good'), [0.755, 0.285], 9, { rot: -6 }, 4),
    neuron(),
    graph(),
    rocket(),
    seasons(),
    epicycles(),
    cat(),
    todo(),
    ripples(),
    pythagoras(),
    eraser(),
    spiral(),
    sine(),
    student(),
    venn(),
    hint()
  ]
}
