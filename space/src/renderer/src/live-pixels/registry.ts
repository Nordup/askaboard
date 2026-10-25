import type { LiveNode } from '@shared/board-format'
import { CanvasHost, canvasSyntaxError, type CanvasSize } from './sandbox'
import { shaderEngine, shaderError, type ShaderProgram } from './shader'

/**
 * Live pixel items on the page: their runners, visibility, status and frame
 * counts. Items outside the view pause (shaders are not drawn, canvas
 * workers stop their frame loop) and resume when they come back. There is
 * no frame-rate cap: items paint on every display frame.
 */

export type LiveState = 'starting' | 'running' | 'paused' | 'error' | 'stalled'

export interface LiveStatus {
  state: LiveState
  error?: string
  /** Frames painted since the item appeared on this page. */
  frames: number
}

/** A canvas worker that paints nothing for this long while visible is shown as not responding. */
const STALL_MS = 2000
/** Re-measure the on-screen size every this many display frames. */
const MEASURE_EVERY = 12

// ---------- Playback parameter overrides (scene playback, playback.ts) ----------

let playbackParams: ReadonlyMap<string, Record<string, number>> = new Map()

/** Scene playback (Board, each playback frame): the params each live item shows now, merged over its own. null ends it. */
export function setLivePlayback(frame: { overrides: ReadonlyMap<string, { params?: Record<string, number> }> } | null): void {
  const next = new Map<string, Record<string, number>>()
  if (frame) for (const [id, override] of frame.overrides) if (override.params) next.set(id, override.params)
  if (next.size === 0 && playbackParams.size === 0) return
  const before = playbackParams
  playbackParams = next
  for (const item of items.values()) {
    if (before.get(item.id) !== playbackParams.get(item.id)) item.paramsChanged()
  }
}

// ---------- Items ----------

const items = new Map<string, LiveItem>()

function pixelSize(element: HTMLElement, w: number, h: number): CanvasSize {
  const rect = element.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  let pw = Math.max(1, Math.round(rect.width * dpr))
  let ph = Math.max(1, Math.round(rect.height * dpr))
  // Never more pixels than the screen shows: a deep zoom into a big item stays affordable.
  const screen = Math.max(1, window.innerWidth * window.innerHeight * dpr * dpr)
  if (pw * ph > screen) {
    const k = Math.sqrt(screen / (pw * ph))
    pw = Math.max(1, Math.round(pw * k))
    ph = Math.max(1, Math.round(ph * k))
  }
  pw = Math.min(pw, 8192)
  ph = Math.min(ph, 8192)
  return { w: Math.max(1e-3, w), h: Math.max(1e-3, h), pw, ph }
}

/** One live item on the page, driven by its view (LiveView). */
export class LiveItem {
  node: LiveNode
  readonly start = performance.timeOrigin + performance.now()
  private visible = false
  private canvas: HTMLCanvasElement | null = null
  private host: CanvasHost | null = null
  private ctx2d: CanvasRenderingContext2D | null = null
  private program: ShaderProgram | null = null
  private programKey = ''
  private generation = -1
  private size: CanvasSize = { w: 1, h: 1, pw: 1, ph: 1 }
  private frames = 0
  private frameBase = 0
  private lastTickAt = 0
  private measureIn = 0
  status: LiveStatus = { state: 'starting', frames: 0 }

  constructor(
    readonly id: string,
    node: LiveNode,
    private container: HTMLElement,
    private onStatus: (status: LiveStatus) => void
  ) {
    this.node = node
    items.set(id, this)
    this.mount()
  }

  params(): Record<string, number> {
    const override = playbackParams.get(this.id)
    return override ? { ...this.node.params, ...override } : this.node.params
  }

  private setStatus(state: LiveState, error?: string): void {
    const frames = this.frameBase + this.frames
    if (this.status.state === state && this.status.error === error) {
      this.status = { ...this.status, frames }
      return
    }
    this.status = { state, error, frames }
    this.onStatus(this.status)
  }

  /** A fresh <canvas> (a canvas can hand its control to a worker only once). */
  private mount(): void {
    this.unmount()
    const canvas = document.createElement('canvas')
    canvas.className = 'node-live__canvas'
    this.container.prepend(canvas)
    this.canvas = canvas
    this.size = pixelSize(this.container, this.node.w, this.node.h)
    canvas.width = this.size.pw
    canvas.height = this.size.ph
    this.frameBase += this.frames
    this.frames = 0
    if (this.node.mode === 'shader') {
      this.ctx2d = canvas.getContext('2d')
      this.compile()
    } else {
      this.lastTickAt = performance.now()
      try {
        this.host = new CanvasHost(canvas, this.node.code, this.size, this.params(), this.start, {
          onTick: (frames) => {
            this.frames = frames
            this.lastTickAt = performance.now()
            if (this.status.state === 'stalled' || this.status.state === 'starting') this.setStatus(this.visible ? 'running' : 'paused')
            else this.status = { ...this.status, frames: this.frameBase + frames }
          },
          onError: (message) => this.setStatus('error', message)
        })
        this.host.run(this.visible)
      } catch (error) {
        this.setStatus('error', error instanceof Error ? error.message : String(error))
      }
    }
  }

  private unmount(): void {
    this.host?.dispose()
    this.host = null
    this.ctx2d = null
    this.program = null
    this.programKey = ''
    this.canvas?.remove()
    this.canvas = null
  }

  private compile(): void {
    const key = `${this.node.code}\u0000${Object.keys(this.node.params).sort().join(',')}`
    if (key === this.programKey && this.generation === shaderEngine.generation) return
    this.programKey = key
    this.generation = shaderEngine.generation
    const result = shaderEngine.compile(this.node.code, this.node.params)
    if (result.ok) {
      this.program = result.program
      this.setStatus(this.visible ? 'running' : 'paused')
      this.paintShader(performance.now())
    } else {
      this.program = null
      this.setStatus('error', result.error)
    }
  }

  /** The view got a new node object. */
  update(node: LiveNode): void {
    const before = this.node
    this.node = node
    if (node.mode !== before.mode || (node.mode === 'canvas' && node.code !== before.code)) {
      this.setStatus('starting')
      this.mount()
      return
    }
    if (node.mode === 'shader') this.compile()
    if (node.w !== before.w || node.h !== before.h) this.measureIn = 0
    if (node.params !== before.params) this.paramsChanged()
  }

  paramsChanged(): void {
    if (this.node.mode === 'canvas') this.host?.setParams(this.params())
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.measureIn = 0
    if (this.node.mode === 'canvas') {
      if (!visible && this.host && this.status.state === 'stalled') {
        // A hung worker off screen: stop it; it starts again (fresh) when the item comes back.
        this.host.dispose()
        this.host = null
      }
      if (visible && !this.host && this.status.state !== 'error') this.mount()
      this.host?.run(visible)
      this.lastTickAt = performance.now()
    }
    if (this.status.state === 'running' || this.status.state === 'paused') this.setStatus(visible ? 'running' : 'paused')
    if (visible) ensureLoop()
  }

  get isVisible(): boolean {
    return this.visible
  }

  private measure(): void {
    if (--this.measureIn > 0) return
    this.measureIn = MEASURE_EVERY
    const next = pixelSize(this.container, this.node.w, this.node.h)
    const s = this.size
    if (next.pw === s.pw && next.ph === s.ph && next.w === s.w && next.h === s.h) return
    this.size = next
    if (this.node.mode === 'shader' && this.canvas) {
      this.canvas.width = next.pw
      this.canvas.height = next.ph
    } else this.host?.resize(next)
  }

  private paintShader(now: number): void {
    if (!this.program || !this.ctx2d) return
    const time = (performance.timeOrigin + now - this.start) / 1000
    if (shaderEngine.render(this.program, this.size.pw, this.size.ph, time, this.frames, this.params(), this.ctx2d)) this.frames++
  }

  /** One display frame (visible items only). */
  tick(now: number): void {
    this.measure()
    if (this.node.mode === 'shader') {
      if (this.generation !== shaderEngine.generation) this.compile()
      this.paintShader(now)
      this.status = { ...this.status, frames: this.frameBase + this.frames }
    } else if (this.host && this.status.state !== 'error' && now - this.lastTickAt > STALL_MS && this.status.state !== 'stalled') {
      this.setStatus('stalled')
    }
  }

  /** The current pixels as a PNG data URL (for agent screenshots), or null. */
  async still(): Promise<string | null> {
    if (this.node.mode === 'shader') {
      if (!this.canvas || !this.program) return null
      if (!this.visible) this.paintShader(performance.now())
      try {
        return this.canvas.toDataURL('image/png')
      } catch {
        return null
      }
    }
    return this.host ? this.host.still() : null
  }

  dispose(): void {
    this.unmount()
    if (items.get(this.id) === this) items.delete(this.id)
  }
}

// ---------- The frame loop ----------

let loop = 0

function ensureLoop(): void {
  if (loop) return
  const step = (now: number): void => {
    loop = 0
    let any = false
    if (document.visibilityState !== 'hidden') {
      for (const item of items.values()) {
        if (!item.isVisible) continue
        any = true
        item.tick(now)
      }
    } else any = items.size > 0
    if (any) loop = requestAnimationFrame(step)
  }
  loop = requestAnimationFrame(step)
}

// ---------- Visibility ----------

let observer: IntersectionObserver | null = null
const byElement = new WeakMap<Element, LiveItem>()

export function observe(element: HTMLElement, item: LiveItem): void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) byElement.get(entry.target)?.setVisible(entry.isIntersecting)
    },
    { root: null, rootMargin: '64px', threshold: 0 }
  )
  byElement.set(element, item)
  observer.observe(element)
}

export function unobserve(element: HTMLElement): void {
  observer?.unobserve(element)
  byElement.delete(element)
}

document.addEventListener('visibilitychange', () => {
  for (const item of items.values()) if (item.node.mode === 'canvas') item.setVisible(item.isVisible)
})

// ---------- For agents, the snapshot path and dev checks ----------

/** The status of a live item on this page, or null when it is not shown. */
export function liveStatus(id: string): LiveStatus | null {
  return items.get(id)?.status ?? null
}

/** The current pixels of a live item as a PNG data URL, or null. */
export function liveStill(id: string): Promise<string | null> {
  return items.get(id)?.still() ?? Promise.resolve(null)
}

/** One line for get_tree: "shader, params k=1 omega=2, code 532 chars, running". */
export function liveSummary(node: LiveNode): string {
  const params = Object.entries(node.params)
    .map(([name, value]) => `${name}=${Math.round(value * 1000) / 1000}`)
    .join(' ')
  const status = liveStatus(node.id)
  const state = status ? (status.state === 'error' ? 'error (get_node_info shows it)' : status.state) : 'not shown'
  return `${node.mode}${params ? `, params ${params}` : ''}, code ${node.code.length} chars, ${state}`
}

/** Every live item on the page with its status (dev checks). */
export function liveItems(): Array<{ id: string; mode: string; visible: boolean } & LiveStatus> {
  return [...items.values()].map((item) => ({ id: item.id, mode: item.node.mode, visible: item.isVisible, ...item.status }))
}

/** Check live code: the shader compile log or the canvas syntax error, or null when it is fine. */
export async function validateLiveCode(mode: 'shader' | 'canvas', code: string, params: Record<string, number> = {}): Promise<string | null> {
  return mode === 'shader' ? shaderError(code, params) : canvasSyntaxError(code)
}
