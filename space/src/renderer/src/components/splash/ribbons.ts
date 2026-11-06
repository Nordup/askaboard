/**
 * "Flowing ribbons": 42 thin lines that drift as one soft band across the splash, accent blue on the left through violet
 * into teal, faded out at both ends. The mockup's band was 680 × 340: x runs in those units, y scales with the band.
 * Each launch moves every wave's phase and changes its speed and height a little (±15 %).
 *
 * The WebGL layer (gl.ts) draws them from the same numbers (RIBBON and the instance's `gpu` state); draw() here is the
 * 2D fallback.
 */
import { rgba, seeded, type Artwork, type Size } from './artworks'

/** One source of the ribbons' numbers for both painters. */
export const RIBBON = {
  lines: 42,
  unitsW: 680,
  /** A line's points, in x units. */
  step: 5,
  /** The lines' middle, × band height. */
  mid: 0.47,
  /** The three waves of a line: their x frequency, t speed, height (× band height) and line-phase factor. */
  waves: [
    { fx: 0.006, ft: 0.22, amp: 0.16, fk: 1.2 },
    { fx: 0.013, ft: -0.31, amp: 0.09, fk: 2.1 },
    { fx: 0.021, ft: 0.17, amp: 0.05, fk: 4 }
  ],
  /** The spread: lines open and close around the middle line. */
  spread: { fx: 0.004, ft: 0.1, amp: 0.18 },
  /** The lines' depths for the parallax: from 1 − depth to 1 + depth across the sheet (the direction per launch). */
  depth: 0.4,
  /** The horizontal gradient over the band's width: a stop's place, colour token and alpha (+ alphaK × the line's k). */
  stops: [
    { at: 0, token: 'accent', alpha: 0, alphaK: 0 },
    { at: 0.25, token: 'accent', alpha: 0.22, alphaK: 0.1 },
    { at: 0.7, token: 'splash-ribbon-violet', alpha: 0.2, alphaK: 0 },
    { at: 1, token: 'splash-ribbon-teal', alpha: 0, alphaK: 0 }
  ]
} as const

/** One launch's ribbons: the waves with this seed's speed, height and phase. */
export interface RibbonState {
  waves: { fx: number; ft: number; amp: number; fk: number; phase: number }[]
  spread: { fx: number; ft: number; amp: number; phase: number }
  /** A line's depth is 1 + depth × (2k − 1). */
  depth: number
}

const LINES = RIBBON.lines
const UNITS_W = RIBBON.unitsW
const STEP = RIBBON.step

const rgbaText = ([r, g, b]: number[], a: number): string => `rgba(${r}, ${g}, ${b}, ${a})`

export const ribbons: Artwork = {
  id: 'ribbons',
  /** The middle line's parallax; each line has its own depth around it (RIBBON.depth), so the sheet shears. */
  parallax: 14,
  init(seed, palette) {
    const random = seeded(seed)
    const vary = (): number => 1 + (random() * 2 - 1) * 0.15
    const waves = RIBBON.waves.map((w) => ({ ...w, ft: w.ft * vary(), amp: w.amp * vary(), phase: random() * Math.PI * 2 }))
    const spread = { ...RIBBON.spread, ft: RIBBON.spread.ft * vary(), amp: RIBBON.spread.amp * vary(), phase: random() * Math.PI * 2 }
    const depth = (random() < 0.5 ? -1 : 1) * RIBBON.depth
    const stops = RIBBON.stops.map((s) => ({ ...s, colour: rgba(palette.get(s.token)) }))

    // The lines' gradients depend only on the band's width, so they are made on a resize, not in a frame.
    let gradients: CanvasGradient[] = []
    let gradientW = -1
    const makeGradients = (ctx: CanvasRenderingContext2D, w: number): void => {
      gradients = Array.from({ length: LINES }, (_, i) => {
        const k = i / (LINES - 1)
        const g = ctx.createLinearGradient(0, 0, w, 0)
        for (const s of stops) g.addColorStop(s.at, rgbaText(s.colour, s.alpha + s.alphaK * k))
        return g
      })
      gradientW = w
    }

    const points = Math.floor(UNITS_W / STEP) + 1

    return {
      gpu: { ribbons: { waves, spread, depth } },
      draw(ctx: CanvasRenderingContext2D, t: number, size: Size, fade: number, pointer: readonly [number, number]) {
        if (size.w !== gradientW) makeGradients(ctx, size.w)
        const sx = size.w / UNITS_W
        const h = size.h
        const [w0, w1, w2] = waves
        const a0 = h * w0.amp
        const a1 = h * w1.amp
        const a2 = h * w2.amp
        const as = h * spread.amp
        const p0 = t * w0.ft + w0.phase
        const p1 = t * w1.ft + w1.phase
        const p2 = t * w2.ft + w2.phase
        const ps = t * spread.ft + spread.phase
        ctx.lineWidth = 1
        ctx.lineJoin = 'round'
        ctx.globalAlpha = fade
        for (let i = 0; i < LINES; i++) {
          const k = i / (LINES - 1)
          const q0 = p0 + k * w0.fk
          const q1 = p1 + k * w1.fk
          const q2 = p2 + k * w2.fk
          const ks = (k - 0.5) * as
          // The context is shifted for the middle line; this line moves by its own depth's difference.
          const d = depth * (2 * k - 1)
          const ox = -pointer[0] * ribbons.parallax * d
          const oy = -pointer[1] * ribbons.parallax * d
          ctx.beginPath()
          for (let j = 0; j < points; j++) {
            const x = j * STEP
            const y = h * RIBBON.mid + a0 * Math.sin(x * w0.fx + q0) + a1 * Math.sin(x * w1.fx + q1) + a2 * Math.sin(x * w2.fx + q2) + ks * Math.sin(x * spread.fx + ps)
            if (j) ctx.lineTo(x * sx + ox, y + oy)
            else ctx.moveTo(x * sx + ox, y + oy)
          }
          ctx.strokeStyle = gradients[i]
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
    }
  }
}
