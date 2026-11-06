/**
 * Helpers for the use case animations, and the placeholders: the hero's window drawings
 * (components/hero/scene.ts), drawn bigger on the shell's board until the real animations come.
 */
import { Pen } from '@/lib/board/kit'
import type { Draw } from '../hero/scene'
import type { Animation } from './index'

/** The room the tool pill takes at the bottom of the board, in CSS px on screen (the chrome shows at 0.8). */
export const PILL_ROOM = 52

/**
 * The scale and offset that fit a drawing of dw × dh units in the board (w × h CSS px), centred
 * above the tool pill, with `pad` px round it and at most `max` × its own size.
 */
export function fit(dw: number, dh: number, w: number, h: number, pad = 32, max = 2.4): { s: number; x: number; y: number } {
  const room = h - PILL_ROOM
  const s = Math.max(0.1, Math.min(max, (w - 2 * pad) / dw, (room - 2 * pad) / dh))
  return { s, x: (w - dw * s) / 2, y: (room - dh * s) / 2 }
}

/**
 * A hero drawing (its body is dw × dh units) as a use case animation. From `duration` on it shows
 * the finished drawing without motion (the hero's `still`), so a stroke that still draws on at
 * that time ends there, and the reduced motion frame is whole.
 */
export function fromHero(make: () => Draw, dw: number, dh: number, duration: number): Animation {
  const draw = make()
  let pen: Pen | null = null
  return {
    duration,
    draw(ctx, w, h, t) {
      if (pen?.ctx !== ctx) pen = new Pen(ctx)
      const g = pen
      const f = fit(dw, dh, w, h)
      g.at(f.x, f.y, 0, f.s, () => draw(g, t, t >= duration))
    }
  }
}
