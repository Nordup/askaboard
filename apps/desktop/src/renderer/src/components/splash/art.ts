/**
 * The splash band (decision U20): a quiet work of art in the background of the start screen. Under it, always, the
 * breathing grid: the board's dot grid, where slow waves lift some dots and turn them from white ink toward the accent
 * blue. Over it the artwork (ARTWORKS; now one, the blossom tree), varied by the launch's seed with the grid, so no two
 * launches look the same.
 *
 * Two canvases at devicePixelRatio and one rAF loop. Under, WebGL (gl.ts): the ground, the grid and the grown tree on
 * the GPU. Over it, 2D: the tree while it grows. Without WebGL, or when its context is lost, the 2D canvas paints
 * everything (grid.ts, the artwork's draw()). The loop waits while the document is hidden and stops when the band
 * unmounts, which also frees the GL context. Reduced motion: one still frame.
 */
import { seeded, type Artwork, type Palette, type Size } from './artworks'
import { startGl } from './gl'
import { grid2D } from './grid'
import { tree } from './tree'

/** The artworks the band picks from, one per launch. A new one is its own module (artworks.ts has the shape). */
export const ARTWORKS: Artwork[] = [tree]

/** The grid moves this far against the pointer, in CSS px at the band's edge (an artwork says its own). */
const PARALLAX_GRID = 3
/** The artwork comes in over this many seconds; the time a still frame (reduced motion) shows. */
const FADE_IN = 1.6
const STILL_T = 7
/**
 * After the entry the motion is slow (the fastest thing, a falling petal, moves about 10 px a second), so the band paints
 * at most 30 times a second: half the raster and compositing work, with no visible change. While the parallax is still
 * catching up with the pointer it paints every display frame, so the pointer stays smooth.
 */
const CALM_AFTER = 6
const CALM_INTERVAL = 1 / 30

/** Start the band on `canvas` (sized to `band`); returns the stop function. */
export function startArt(canvas: HTMLCanvasElement, band: HTMLElement): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  const css = getComputedStyle(band)
  const palette: Palette = { get: (name) => css.getPropertyValue(`--${name}`).trim() }
  const ground = palette.get('bg-canvas') || '#161618'
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const seed = (Math.random() * 2 ** 32) >>> 0
  const random = seeded(seed)
  const artwork = ARTWORKS[Math.floor(random() * ARTWORKS.length)]
  let art = artwork.init((random() * 2 ** 32) >>> 0, palette)
  /** The grid's own variation: where its waves start. */
  const gridPhase = random() * 100
  const drawGrid = grid2D(palette)

  // The WebGL layer, under the 2D canvas.
  const glCanvas = document.createElement('canvas')
  glCanvas.className = canvas.className
  glCanvas.setAttribute('aria-hidden', 'true')
  canvas.before(glCanvas)
  const gl = startGl(glCanvas, palette)
  /** Whether the 2D canvas holds a picture (it is cleared once when an artwork draws only on the GPU). */
  let painted2D = false

  const size: Size = { w: 1, h: 1 }
  let dpr = 1

  function layout(): void {
    const rect = band.getBoundingClientRect()
    size.w = Math.max(1, rect.width)
    size.h = Math.max(1, rect.height)
    dpr = window.devicePixelRatio || 1
    canvas.width = glCanvas.width = Math.round(size.w * dpr)
    canvas.height = glCanvas.height = Math.round(size.h * dpr)
    painted2D = false
  }

  // ---------- Pointer parallax ----------

  const target = [0, 0]
  const shift = [0, 0]
  const onPointer = (event: PointerEvent): void => {
    if (ignorePointer) return
    target[0] = Math.max(-1, Math.min(1, (event.clientX - window.innerWidth / 2) / (window.innerWidth / 2)))
    target[1] = Math.max(-1, Math.min(1, (event.clientY - window.innerHeight / 2) / (window.innerHeight / 2)))
  }

  // ---------- The frame ----------

  let clock = 0
  /** Dev only: the last frames' cost in ms, for a frame-time check over the debug port. */
  const costs: number[] | null = import.meta.env.DEV ? [] : null
  if (costs) (window as unknown as { __splashFrameMs?: number[] }).__splashFrameMs = costs
  /**
   * Dev only, over the debug port: window.__splash.show({ seed, t, fps, pointer }) restarts the artwork with that seed,
   * at time t (seconds; t null runs the clock from 0, a number holds that still frame); fps sets the calm cap.
   */
  let held: number | null = null
  /** Dev: show({ pointer: false }) ignores the pointer, so a measurement is not moved by a mouse passing by. */
  let ignorePointer = false
  /** The calm frame interval (dev: show({ fps }) changes it for a measurement). */
  let calmInterval = CALM_INTERVAL
  if (import.meta.env.DEV) {
    ;(window as unknown as { __splash?: unknown }).__splash = {
      show(o: { seed?: number; t?: number | null; fps?: number; pointer?: boolean }): string {
        calmInterval = o.fps ? 1 / o.fps : CALM_INTERVAL
        ignorePointer = o.pointer === false
        if (ignorePointer) target[0] = target[1] = shift[0] = shift[1] = 0
        art = artwork.init((o.seed ?? (Math.random() * 2 ** 32)) >>> 0, palette)
        held = o.t ?? null
        clock = held ?? 0
        frame()
        return `${artwork.id} seed ${o.seed ?? 'random'} t ${held ?? 'running'}`
      }
    }
  }

  // A frame paints from the back: the breathing grid, then the artwork.
  function frame(): void {
    const begin = costs ? performance.now() : 0
    const t = reduced ? STILL_T : clock
    const fade = reduced ? 1 : Math.min(1, clock / FADE_IN)
    const ease = fade * fade * (3 - 2 * fade)
    const gridShift: [number, number] = [shift[0] * PARALLAX_GRID, shift[1] * PARALLAX_GRID]
    const artShift: [number, number] = [shift[0] * artwork.parallax, shift[1] * artwork.parallax]
    ctx!.setTransform(1, 0, 0, 1, 0, 0)
    if (gl && !gl.lost) {
      // The tree on the GPU once grown (its growth stays 2D).
      const treeGpu = art.gpu?.tree && gl.canTree && art.gpu.tree.ready(t) ? art.gpu.tree : null
      const gpu = !!treeGpu
      gl.draw(
        size,
        dpr,
        t + gridPhase,
        gridShift,
        treeGpu ? { gpu: treeGpu, frame: treeGpu.frame(t, size, dpr, shift as [number, number]), pointer: shift as [number, number], fade: ease, alpha: Math.min(1, 0.55 + ease) } : null
      )
      if (!gpu || painted2D) ctx!.clearRect(0, 0, canvas.width, canvas.height)
      if (gpu) {
        // Nothing on the 2D canvas: cleared once, then left alone (an unchanged canvas costs nothing to composite).
        painted2D = false
        return finish(begin)
      }
      painted2D = true
    } else {
      // The 2D fallback paints the ground and the grid too.
      ctx!.fillStyle = ground
      ctx!.fillRect(0, 0, canvas.width, canvas.height)
      ctx!.setTransform(dpr, 0, 0, dpr, -dpr * gridShift[0], -dpr * gridShift[1])
      drawGrid(ctx!, t + gridPhase, size)
      painted2D = true
    }
    ctx!.setTransform(dpr, 0, 0, dpr, -dpr * artShift[0], -dpr * artShift[1])
    art.draw(ctx!, t, size, ease, shift as [number, number])
    finish(begin)
  }

  function finish(begin: number): void {
    // Dev only: whether this frame painted the tree on the GPU (false on the 2D fallback).
    if (import.meta.env.DEV) (window as unknown as { __splashGpuTree?: boolean }).__splashGpuTree = !!(gl && !gl.lost && art.gpu?.tree && gl.canTree && art.gpu.tree.ready(reduced ? STILL_T : clock))
    if (costs) {
      costs.push(performance.now() - begin)
      if (costs.length > 1200) costs.splice(0, costs.length - 1200)
    }
  }

  // ---------- The loop ----------

  let raf = 0
  let lastTime = 0
  /** Seconds since the last painted frame. */
  let unpainted = 0
  const loop = (now: number): void => {
    // A long gap (a hidden window, a stall) does not jump the art ahead.
    const dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0
    lastTime = now
    if (held === null) clock += dt
    const follow = 1 - Math.exp(-dt / 0.5)
    shift[0] += (target[0] - shift[0]) * follow
    shift[1] += (target[1] - shift[1]) * follow
    unpainted += dt
    const catching = Math.abs(target[0] - shift[0]) + Math.abs(target[1] - shift[1]) > 0.004
    // 2 ms of slack: a 60 Hz display paints every second frame, not every third.
    if (clock < CALM_AFTER || catching || unpainted >= calmInterval - 0.002) {
      unpainted = 0
      frame()
    }
    raf = requestAnimationFrame(loop)
  }
  const run = (): void => {
    if (raf || reduced || document.hidden) return
    lastTime = 0
    raf = requestAnimationFrame(loop)
  }
  const pause = (): void => {
    cancelAnimationFrame(raf)
    raf = 0
  }
  const onVisibility = (): void => (document.hidden ? pause() : run())

  layout()
  frame()
  const observer = new ResizeObserver(() => {
    layout()
    frame()
  })
  observer.observe(band)
  if (!reduced) {
    window.addEventListener('pointermove', onPointer)
    document.addEventListener('visibilitychange', onVisibility)
    run()
  }
  return () => {
    pause()
    observer.disconnect()
    gl?.release()
    glCanvas.remove()
    window.removeEventListener('pointermove', onPointer)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
