/**
 * "How does my phone know where I am?": the GPS use case, as the agent explains it on the app's
 * board: a flat picture that plays step by step, read out in the app's reading panel
 * (script-panel.ts). The founder (2026-11-07): the app's look, the website's colours, simple
 * shapes, not lines only, as long as the explanation needs.
 *
 * Seen from the side: the Earth's curve at the bottom, three satellites in the sky (founder: not
 * from above, and three satellites, as the classic explanation goes):
 * 1. The phone only listens; satellite 1 sends its time.
 * 2. The delay is a distance: the phone is on a circle that far round satellite 1.
 * 3. Satellite 2's circle crosses it at two points: one on the ground, one far out in space.
 * 4. Satellite 3's circle goes through only the one on the ground: that is the phone.
 * This takes an exact clock in the phone. A real phone's clock is not exact, so it listens to a
 * fourth satellite as well and works out its clock error too; the scene leaves that out.
 * The geometry is true: each circle goes through the phone, and the second crossing is the true
 * second intersection of circles 1 and 2. The circles go on under the ground, dimmed by the Earth.
 */
import { hex } from '@/lib/board/colors'
import { clamp01, ease } from '@/lib/board/kit'
import { PILL_ROOM } from './placeholder'
import { scriptPanel } from './script-panel'
import type { Animation } from './index'

type V = [number, number]

/** The picture, in its own units: the phone at 0, 0, y down. */
const SATS: { at: V; color: string; km: string }[] = [
  { at: [-280, -170], color: 'blue', km: '20,100 km' },
  { at: [60, -260], color: 'green', km: '21,800 km' },
  { at: [270, -150], color: 'pink', km: '21,300 km' }
]
/** The Earth: its centre and radius; its surface is just under the phone. */
const EARTH = { at: [0, 918] as V, r: 900 }
const RADIUS = SATS.map((s) => Math.hypot(s.at[0], s.at[1]))
/** Circles 1 and 2 cross at the phone and at its mirror over the line through their centres. */
const SECOND: V = (() => {
  const [[x1, y1], [x2, y2]] = [SATS[0].at, SATS[1].at]
  const dx = x2 - x1
  const dy = y2 - y1
  const k = -(x1 * dx + y1 * dy) / (dx * dx + dy * dy)
  return [2 * (x1 + k * dx), 2 * (y1 + k * dy)]
})()
/** The box the picture needs (the satellites, the second crossing out in space, the ground): its centre and size. */
const BOX = { cx: -20, cy: -215, w: 760, h: 580 }

const STEPS = [
  { start: 0, end: 6.5, text: 'Your phone only listens. Each GPS satellite keeps sending the time on its atomic clock.' },
  { start: 6.5, end: 14.5, text: 'This signal took 0.067 s. At the speed of light that is 20,100 km, so you are somewhere on a circle that far from satellite 1.' },
  { start: 14.5, end: 21.5, text: 'A second satellite gives a second circle. The two circles cross at two points: one on the ground, one far out in space.' },
  { start: 21.5, end: 30, text: 'A third circle goes through only the point on the ground. That point is you.' }
]
const DURATION = 32

/** Scene seconds for each satellite: it comes in, sends its signal, its line and distance show, its circle draws. */
const T = [
  { come: 1.2, waves: 2.4, line: 2.6, km: 7.2, circle: [8.5, 10.6] },
  { come: 14.8, waves: 15.6, line: 15.8, km: 16.4, circle: [17.0, 18.7] },
  { come: 21.8, waves: 22.6, line: 22.8, km: 23.4, circle: [23.8, 25.4] }
]
const PHONE_IN = 0.3
const CROSSINGS = 18.8
const NOT_THERE = 25.6
const YOU = 26.0

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif"

const span = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a))
const grow = (t: number, a: number, d = 0.5): number => ease(span(t, a, a + d))

export default function create(): Animation {
  const panel = typeof document === 'undefined' ? null : scriptPanel('GPS · how your phone finds you', STEPS)
  let host: HTMLElement | null = null

  const draw = (c: CanvasRenderingContext2D, w: number, h: number, t: number): void => {
    // The window's scale (its own CSS px to px on screen), and the room the panel leaves.
    const lw = host?.clientWidth || w
    const s = w / lw
    const phone = lw < 760
    const below = PILL_ROOM / s + 14
    panel?.update(t, phone, below)
    const panelH = panel?.el.offsetHeight ?? 0
    const regionW = phone ? w : w - (296 + 24) * s
    const regionH = phone ? h - (panelH + below + 12) * s : h - PILL_ROOM
    // A window being resized can leave no room for a moment: the picture stays at its smallest then.
    // On a phone the picture keeps room under the phone's label, above the panel.
    const room = phone ? 34 * s : 0
    const k = Math.max(0.2, Math.min(1.6, regionW / BOX.w, (regionH - room) / BOX.h))
    const ox = regionW / 2 - BOX.cx * k
    const oy = (regionH - room) / 2 - BOX.cy * k
    const at = ([x, y]: V): V => [ox + x * k, oy + y * k]
    const label = phone ? 11 : 13
    // The things' own size (satellites, the phone, the line widths): with the picture, within limits.
    const px = Math.max(0.55, Math.min(1.4, k))

    // One thing at a time: a circle goes quiet while the next satellite's circle draws, until all
    // three meet at the end; a satellite's line and distance go once its circle is drawn.
    const met = ease(span(t, YOU + 0.6, YOU + 1.6))
    const quiet = (i: number): number => (i + 1 < SATS.length ? 1 - 0.65 * ease(span(t, T[i + 1].come, T[i + 1].come + 0.8)) * (1 - met) : 1)
    const said = (i: number): number => 1 - ease(span(t, T[i].circle[1] + 1.2, T[i].circle[1] + 2))
    const [phoneX, phoneY] = at([0, 0])

    // The circles, under everything: a soft band with its line, drawn out from the phone both ways.
    SATS.forEach((sat, i) => {
      const share = ease(span(t, T[i].circle[0], T[i].circle[1]))
      if (share <= 0) return
      const [cx, cy] = at(sat.at)
      const r = Math.max(0, RADIUS[i] * k)
      const from = Math.atan2(phoneY - cy, phoneX - cx)
      c.lineCap = 'round'
      for (const [width, alpha] of [
        [10 * px, 0.14],
        [2 * px, 1]
      ] as const) {
        c.beginPath()
        c.arc(cx, cy, r, from - Math.PI * share, from + Math.PI * share)
        c.strokeStyle = hex(sat.color)
        c.globalAlpha = alpha * quiet(i)
        c.lineWidth = width
        c.stroke()
      }
      c.globalAlpha = 1
    })

    // The Earth over the circles' lower parts (they go on under the ground, dimmed), its surface in green.
    const earthIn = grow(t, 0, 0.8)
    const [ex, ey] = at(EARTH.at)
    c.beginPath()
    c.arc(ex, ey, EARTH.r * k, 0, Math.PI * 2)
    c.fillStyle = hex('card')
    c.globalAlpha = 0.9 * earthIn
    c.fill()
    for (const [width, alpha] of [
      [10 * px, 0.12],
      [2 * px, 0.9]
    ] as const) {
      c.strokeStyle = hex('green')
      c.lineWidth = width
      c.globalAlpha = alpha * earthIn
      c.stroke()
    }
    c.globalAlpha = 1
    const [gx, gy] = at([-300, 120])
    text(c, 'Earth', gx, gy, label, hex('muted'), earthIn)

    // Each satellite: its signal (waves, then a dashed line to the phone and the distance on it), then itself.
    SATS.forEach((sat, i) => {
      const come = grow(t, T[i].come, 0.7)
      if (come <= 0) return
      const [sx, sy] = at(sat.at)
      const dx = phoneX - sx
      const dy = phoneY - sy
      const dist = Math.hypot(dx, dy)
      const dir = Math.atan2(dy, dx)
      const color = hex(sat.color)

      // The signal: three waves that travel to the phone and fade.
      for (let n = 0; n < 3; n++) {
        const local = span(t, T[i].waves + n * 0.45, T[i].waves + n * 0.45 + 1.3)
        if (local <= 0 || local >= 1) continue
        c.beginPath()
        c.arc(sx, sy, 16 * px + (dist - 26 * px) * local, dir - 0.32, dir + 0.32)
        c.strokeStyle = color
        c.globalAlpha = 0.85 * (1 - local)
        c.lineWidth = 2.2 * px
        c.stroke()
      }
      c.globalAlpha = 1

      const line = ease(span(t, T[i].line, T[i].line + 0.7))
      if (line > 0) {
        c.save()
        c.setLineDash([3 * px, 5 * px])
        c.beginPath()
        c.moveTo(sx + Math.cos(dir) * 18 * px, sy + Math.sin(dir) * 18 * px)
        c.lineTo(sx + dx * line - Math.cos(dir) * 20 * px * line, sy + dy * line - Math.sin(dir) * 20 * px * line)
        c.strokeStyle = color
        c.globalAlpha = 0.75 * said(i)
        c.lineWidth = 1.5 * px
        c.stroke()
        c.restore()
      }
      const km = grow(t, T[i].km) * said(i)
      if (km > 0) {
        // Along the line, upright, a little to its side.
        const up = dir > Math.PI / 2 || dir < -Math.PI / 2 ? dir + Math.PI : dir
        c.save()
        c.translate(sx + dx * 0.5 + Math.cos(up - Math.PI / 2) * 10 * px, sy + dy * 0.5 + Math.sin(up - Math.PI / 2) * 10 * px)
        c.rotate(up)
        c.font = `500 ${label}px ${FONT}`
        c.textAlign = 'center'
        c.fillStyle = color
        c.globalAlpha = km
        c.fillText(sat.km, 0, 0)
        c.restore()
      }

      // The satellite: panels across its line to the phone, the body filled, its dish towards the phone.
      c.save()
      c.translate(sx - Math.cos(dir) * 24 * (1 - come), sy - Math.sin(dir) * 24 * (1 - come))
      c.rotate(dir - Math.PI / 2)
      c.scale(px, px)
      c.globalAlpha = come
      c.lineWidth = 1.6
      c.strokeStyle = color
      c.lineJoin = 'round'
      for (const side of [-1, 1]) {
        c.beginPath()
        c.roundRect(side < 0 ? -35 : 13, -7, 22, 14, 2.5)
        c.fillStyle = color
        c.globalAlpha = come * 0.22
        c.fill()
        c.globalAlpha = come
        c.stroke()
        c.beginPath()
        for (const x of [7.3, 14.7]) {
          const xx = side < 0 ? -35 + x : 13 + x
          c.moveTo(xx, -7)
          c.lineTo(xx, 7)
        }
        c.moveTo(side * 9, 0)
        c.lineTo(side * 13, 0)
        c.globalAlpha = come * 0.6
        c.stroke()
        c.globalAlpha = come
      }
      c.beginPath()
      c.roundRect(-9, -9, 18, 18, 4)
      c.fillStyle = color
      c.fill()
      c.beginPath()
      c.arc(0, 9, 5, 0, Math.PI)
      c.fillStyle = hex('bg')
      c.fill()
      c.beginPath()
      c.moveTo(0, -9)
      c.lineTo(0, -15)
      c.stroke()
      c.beginPath()
      c.arc(0, -16.5, 2.2, 0, Math.PI * 2)
      c.fill()
      c.restore()

      text(c, `satellite ${i + 1}`, sx - Math.cos(dir) * 50 * px, sy - Math.sin(dir) * 50 * px + label * 0.35, label, hex('muted'), come)
    })

    // The two crossings of circles 1 and 2; the far one goes when circle 3 misses it.
    const cross = grow(t, CROSSINGS, 0.4)
    const [qx, qy] = at(SECOND)
    const gone = grow(t, NOT_THERE, 0.6)
    if (cross > 0) {
      const a = cross * (1 - gone)
      disc(c, qx, qy, 13 * px * cross, hex('yellow'), 0.18 * a)
      disc(c, qx, qy, 6 * px * cross, hex('yellow'), a)
      text(c, 'or here, in space?', qx + 18 * px, qy + label * 0.35, label, hex('yellow'), grow(t, CROSSINGS + 0.4) * (1 - gone), 'left')
      // Where it was: a small cross, in circle 3's colour.
      if (gone > 0) {
        c.save()
        c.strokeStyle = hex('pink')
        c.lineWidth = 2 * px
        c.lineCap = 'round'
        c.globalAlpha = gone * 0.9
        const d = 6 * px
        c.beginPath()
        c.moveTo(qx - d, qy - d)
        c.lineTo(qx + d, qy + d)
        c.moveTo(qx + d, qy - d)
        c.lineTo(qx - d, qy + d)
        c.stroke()
        c.restore()
      }
    }

    // The phone, and once it is found, the yellow place round it.
    const found = Math.max(cross, grow(t, YOU))
    if (found > 0) {
      disc(c, phoneX, phoneY, 26 * px, hex('yellow'), 0.14 * found)
      ring(c, phoneX, phoneY, 26 * px, hex('yellow'), 2 * px, found)
    }
    const phoneIn = grow(t, PHONE_IN, 0.6)
    if (phoneIn > 0) {
      c.save()
      c.translate(phoneX, phoneY)
      c.scale(px * (0.85 + 0.15 * phoneIn), px * (0.85 + 0.15 * phoneIn))
      c.globalAlpha = phoneIn
      c.beginPath()
      c.roundRect(-10, -16, 20, 32, 5)
      c.fillStyle = hex('card-2')
      c.fill()
      c.lineWidth = 1.8
      c.strokeStyle = hex('text')
      c.stroke()
      c.beginPath()
      c.roundRect(-6.5, -12, 13, 20, 2)
      c.fillStyle = hex('blue')
      c.globalAlpha = phoneIn * 0.35
      c.fill()
      c.globalAlpha = phoneIn
      c.beginPath()
      c.moveTo(-3, 12)
      c.lineTo(3, 12)
      c.lineCap = 'round'
      c.lineWidth = 1.5
      c.stroke()
      c.restore()
    }
    const you = grow(t, YOU)
    const labelY = phoneY + 26 * px + label + 6
    const asked = grow(t, CROSSINGS + 0.4)
    text(c, 'your phone', phoneX, labelY, label, hex('muted'), phoneIn * (1 - asked))
    text(c, 'here?', phoneX, labelY, label, hex('yellow'), asked * (1 - you))
    text(c, 'you are here', phoneX, labelY, label, hex('yellow'), you)
  }

  return {
    duration: DURATION,
    draw,
    mount(el) {
      host = el
      if (panel) el.appendChild(panel.el)
    },
    unmount() {
      panel?.el.remove()
      host = null
    }
  }
}

function text(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, alpha: number, align: CanvasTextAlign = 'center'): void {
  if (alpha <= 0) return
  c.font = `${size}px ${FONT}`
  c.textAlign = align
  c.fillStyle = color
  c.globalAlpha = alpha
  c.fillText(s, x, y)
  c.globalAlpha = 1
}

function disc(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
  if (alpha <= 0 || r <= 0) return
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fillStyle = color
  c.globalAlpha = alpha
  c.fill()
  c.globalAlpha = 1
}

function ring(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number, alpha: number): void {
  if (alpha <= 0) return
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.strokeStyle = color
  c.lineWidth = width
  c.globalAlpha = alpha
  c.stroke()
  c.globalAlpha = 1
}
