/**
 * The hero board: one canvas, one animation frame loop for every piece.
 * Pieces sit at their places, and a piece that would cover the header or the
 * top bar (elements with data-clear) moves out of the way. The visitor can drag
 * a piece; it eases back out of the clear areas when let go. The loop stops
 * while the hero is off screen or the tab is hidden; with reduced motion the
 * board is drawn once, finished.
 */
import { Pen, type Point } from '@/lib/board/kit'
import type { Piece } from './pieces'

export interface Drag {
  move(x: number, y: number): void
  end(): void
}

interface Placed {
  piece: Piece
  /** The box centre now and where it goes, in hero pixels. */
  x: number
  y: number
  tx: number
  ty: number
  /** The visitor's drag, in hero pixels. */
  dx: number
  dy: number
  rot: number
  s: number
  hidden: boolean
  dragging: boolean
}

type Rect = { x0: number; y0: number; x1: number; y1: number }

const MARGIN = 14
const PHONE = 720

export function mountBoard(host: HTMLElement, canvas: HTMLCanvasElement, pieces: Piece[]) {
  const ctx = canvas.getContext('2d')!
  const g = new Pen(ctx)
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const placed: Placed[] = pieces.map((piece) => ({ piece, x: 0, y: 0, tx: 0, ty: 0, dx: 0, dy: 0, rot: 0, s: 1, hidden: true, dragging: false }))
  let W = 0
  let H = 0
  let first = true
  let frame = 0
  let visible = true
  let clock = 0
  let last = 0
  let pointer: Point | null = null

  const centre = (p: Piece): Point => [(p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2]
  const half = (q: Placed): Point => {
    const [x0, y0, x1, y1] = q.piece.box
    const c = Math.abs(Math.cos(q.rot))
    const s = Math.abs(Math.sin(q.rot))
    const w = ((x1 - x0) / 2) * q.s
    const h = ((y1 - y0) / 2) * q.s
    return [w * c + h * s, w * s + h * c]
  }

  const clearRects = (): Rect[] => {
    const r = host.getBoundingClientRect()
    return [...host.querySelectorAll<HTMLElement>('[data-clear]')].map((el) => {
      const b = el.getBoundingClientRect()
      return { x0: b.left - r.left - MARGIN, y0: b.top - r.top - MARGIN, x1: b.right - r.left + MARGIN, y1: b.bottom - r.top + MARGIN }
    })
  }

  /** Move q's target out of every clear rect, the shortest way. */
  const pushOut = (q: Placed, rects: Rect[]): void => {
    const [hw, hh] = half(q)
    for (let pass = 0; pass < 2; pass++)
      for (const r of rects) {
        if (q.tx + hw <= r.x0 || q.tx - hw >= r.x1 || q.ty + hh <= r.y0 || q.ty - hh >= r.y1) continue
        const moves: Point[] = [
          [r.x0 - (q.tx + hw), 0],
          [r.x1 - (q.tx - hw), 0],
          [0, r.y0 - (q.ty + hh)],
          [0, r.y1 - (q.ty - hh)]
        ]
        const [mx, my] = moves.reduce((a, b) => (Math.hypot(...b) < Math.hypot(...a) ? b : a))
        q.tx += mx
        q.ty += my
      }
    q.hidden = q.tx + hw < -hw * 0.4 || q.tx - hw > W + hw * 0.4 || q.ty + hh < 0 || q.ty - hh > H + hh * 0.4
  }

  const layout = (): void => {
    const rects = clearRects()
    const phone = W < PHONE
    const k = phone ? Math.min(0.9, Math.max(0.62, W / 520)) : Math.min(1.25, Math.max(0.6, Math.min(W / 1440, H / 900)))
    // The phone's bands: between the bar and the header, and under the header.
    const el = host.querySelector<HTMLElement>('[data-clear="head"]')
    const r = host.getBoundingClientRect()
    const b = el?.getBoundingClientRect()
    const head = b ? { y0: b.top - r.top - MARGIN, y1: b.bottom - r.top + MARGIN } : null
    const top = { y0: 64, y1: head ? head.y0 : H * 0.3 }
    const bottom = { y0: head ? head.y1 : H * 0.7, y1: H - 6 }
    for (const q of placed) {
      const p = q.piece
      if (phone) {
        if (!p.phone) {
          q.hidden = true
          continue
        }
        const band = p.phone.band === 'top' ? top : bottom
        q.s = k * (p.phone.size ?? 1)
        q.rot = (((p.phone.rot ?? p.rot ?? 0) * Math.PI) / 180) as number
        q.tx = p.phone.x * W + q.dx
        q.ty = band.y0 + p.phone.y * (band.y1 - band.y0) + q.dy
      } else {
        q.s = k * (p.size ?? 1)
        q.rot = ((p.rot ?? 0) * Math.PI) / 180
        q.tx = p.at[0] * W + q.dx
        q.ty = p.at[1] * H + q.dy
      }
      if (!q.dragging) pushOut(q, rects)
      else q.hidden = false
      if (first || still) {
        q.x = q.tx
        q.y = q.ty
      }
    }
    first = false
  }

  const fit = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    W = host.clientWidth
    H = host.clientHeight
    canvas.width = Math.max(1, Math.round(W * dpr))
    canvas.height = Math.max(1, Math.round(H * dpr))
    layout()
  }

  /** The hero point x, y in q's own units. */
  const toLocal = (q: Placed, x: number, y: number): Point => {
    const [cx, cy] = centre(q.piece)
    const dx = x - q.x
    const dy = y - q.y
    const c = Math.cos(-q.rot)
    const s = Math.sin(-q.rot)
    return [(dx * c - dy * s) / q.s + cx, (dx * s + dy * c) / q.s + cy]
  }

  const render = (now: number): void => {
    frame = 0
    const dt = last ? Math.min(0.5, (now - last) / 1000) : 0
    last = now
    clock += dt
    const dpr = canvas.width / Math.max(1, W)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const ease = Math.min(1, dt * 10)
    for (const q of placed) {
      if (q.hidden) continue
      if (!q.dragging) {
        q.x += (q.tx - q.x) * ease
        q.y += (q.ty - q.y) * ease
      }
      const [cx, cy] = centre(q.piece)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.translate(q.x, q.y)
      ctx.rotate(q.rot)
      ctx.scale(q.s, q.s)
      ctx.translate(-cx, -cy)
      const t = still ? (q.piece.still ?? 8) : clock
      q.piece.draw(g, t, pointer ? toLocal(q, pointer[0], pointer[1]) : null)
    }
    if (!still && visible && !document.hidden) frame = requestAnimationFrame(render)
    else last = 0
  }
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(render)
  }

  const hit = (x: number, y: number): Placed | null => {
    for (let i = placed.length - 1; i >= 0; i--) {
      const q = placed[i]
      if (q.hidden) continue
      const [lx, ly] = toLocal(q, x, y)
      const [x0, y0, x1, y1] = q.piece.box
      const pad = 6 / q.s
      if (lx >= x0 - pad && lx <= x1 + pad && ly >= y0 - pad && ly <= y1 + pad) return q
    }
    return null
  }

  /** A press at x, y: a drag when a piece is there, else null (the visitor's ink). */
  const grab = (x: number, y: number): Drag | null => {
    const q = hit(x, y)
    if (!q) return null
    placed.splice(placed.indexOf(q), 1)
    placed.push(q)
    q.dragging = true
    host.style.cursor = 'grabbing'
    let px = x
    let py = y
    return {
      move(nx, ny) {
        q.dx += nx - px
        q.dy += ny - py
        q.x += nx - px
        q.y += ny - py
        px = nx
        py = ny
        schedule()
      },
      end() {
        q.dragging = false
        // Keep where it was dropped, then step out of the clear areas.
        q.tx = q.x
        q.ty = q.y
        pushOut(q, clearRects())
        q.dx += q.tx - q.x
        q.dy += q.ty - q.y
        if (still) {
          q.x = q.tx
          q.y = q.ty
        }
        host.style.cursor = ''
        schedule()
      }
    }
  }

  const hover = (x: number, y: number): void => {
    pointer = [x, y]
    host.style.cursor = hit(x, y) ? 'grab' : ''
    if (still) schedule()
  }

  const onLeave = (): void => {
    pointer = null
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) schedule()
  })
  const onVisibility = (): void => {
    if (!document.hidden) schedule()
  }
  const resize = new ResizeObserver(() => {
    fit()
    schedule()
  })
  fit()
  resize.observe(host)
  observer.observe(host)
  document.addEventListener('visibilitychange', onVisibility)
  host.addEventListener('pointerleave', onLeave)
  schedule()

  return {
    grab,
    hover,
    stop(): void {
      cancelAnimationFrame(frame)
      resize.disconnect()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      host.removeEventListener('pointerleave', onLeave)
    }
  }
}
