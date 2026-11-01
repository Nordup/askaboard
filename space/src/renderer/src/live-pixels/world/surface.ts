import { nodeOpacity, type LiveNode } from '@shared/board-format'
import { LIVE_ORIGIN } from '@shared/live-libs'
import type { PageToWorld, WorldCamera, WorldKey, WorldPlacement, WorldStart, WorldStats, WorldToPage } from '@shared/world-protocol'
import type { WorldTune } from '@shared/world-tune'
import type { WorldPoints } from '@shared/world-links'
import type { NodeOverride } from '../../board/playback'
import type { Camera, Point } from '../../board/types'
import { paceFrames } from '../../frame-pace'
import * as worker from './worker'

/**
 * The world surface: one GPU canvas that draws every world of a board, between
 * the page content and the ink. See docs/learning-space/one-world-architecture.md.
 *
 * The worker runs in a hidden sandboxed frame (main/live-item-protocol.ts), with
 * the protocol of shared/world-protocol.ts over one port. It renders to no
 * visible canvas: it sends each finished picture with the camera it was made
 * for, and the page shows the picture in its own paint (`sync`), with the CSS
 * transform from that camera to the camera of the paint. So a world moves with
 * the ink in the same paint, and a slow page gets fewer pictures, not late ones.
 * A picture covers only what worlds reach, up to WORLD_MARGIN past the board on
 * each side, so a pan shows no empty edge before the next picture. It says where
 * it lies (`box`), and the canvas takes that place and size in the same paint.
 *
 * The frame and the worker start with the first world. A board with no world
 * pays one map lookup per paint.
 *
 * A step host (previews, stills) has a private surface with no canvas: its
 * pictures end at once, and only its captures reach the page.
 *
 * Recovery. The worker runs all worlds in one thread, so an endless loop in one
 * stops all. A worker that gives no answer for HANG_MS, or that lost its GPU
 * context, ends. A new worker takes every world again; each item starts a new
 * generation from its node. The world that ran last at a hang stays stopped with
 * the usual note. The last picture stays until the new worker shows a world.
 */

/** How often the surface asks the worker for an answer, and how long it waits for one. */
const PING_MS = 500
const HANG_MS = 2000
/** A world's setup can take this long: a molecule or a model is a lot of work. */
const SETUP_MS = 20000

/** How a world stands on the board now, from the board's state. */
export interface WorldPlace {
  node: LiveNode
  /** The nominal rect's top-left in board points, from the layout cache: no playback transform is in it. */
  x: number
  y: number
  override: NodeOverride | undefined
}

/** What the board gives its surface. */
export interface WorldBoard {
  /** Ask for a paint: the board calls `syncWorlds` in it. */
  paint(): void
  /** The place of a node, or null when it is not on the board. */
  place(id: string): WorldPlace | null
  /** The points of the picture this paint adopts: linked items move with it. */
  points(points: WorldPoints): void
  /** A world moved itself, by this much from its placed rect. */
  anchor(id: string, dx: number, dy: number): void
  /** What a world listens to changed. */
  wants(): void
  /** The cursor that a world asks for; '' gives it back to the board. */
  cursor(value: string): void
}

/** One generation of a world on a surface (host.ts). */
export interface WorldMember {
  readonly key: WorldKey
  readonly shown: boolean
  /** It failed or left: a new worker does not take it. */
  readonly ended: boolean
  /** Its code has run no frame yet. */
  readonly settingUp: boolean
  showPoints(points: Record<string, [number, number, boolean]> | undefined): void
  /** Its code ran and gave the turn back: a world with no frame loop has only this to show that it is there. */
  settled(): void
  receive(message: Extract<WorldToPage, { key: WorldKey }>): void
  failed(message: string): void
  lost(): void
}

type Picture = Extract<WorldToPage, { type: 'picture' }>

const IDENTITY: WorldPlacement['matrix'] = [1, 0, 0, 1, 0, 0]

/** The measuring switches of this run (SPACE_WORLD_TUNE). */
const tune: WorldTune = window.space?.worldTune ?? {}

const margin = (): number => tune.surfaceMargin ?? workerSide.WORLD_MARGIN

/** The board surfaces, and who listens to their stats. While nobody listens, no worker measures. */
const boardSurfaces: Set<WorldSurface> = (import.meta.hot?.data.boardSurfaces as Set<WorldSurface> | undefined) ?? new Set()
if (import.meta.hot) import.meta.hot.data.boardSurfaces = boardSurfaces
let statsListener: ((stats: WorldStats) => void) | null = null

/** Ask every board surface for one snapshot per second, now and after a new worker. null ends it. */
export function listenWorldStats(listener: ((stats: WorldStats) => void) | null): void {
  statsListener = listener
  for (const surface of boardSurfaces) surface.send({ type: 'stats', on: !!listener })
}

let uncapped = false

/** Tell every board surface, now and after a new worker: pictures wait only for the GPU. */
export function setWorldUncapped(on: boolean): void {
  uncapped = on
  paceFrames(!on && !tune.uncapped)
  for (const surface of boardSurfaces) surface.send({ type: 'uncapped', on })
}

const keyOf = (key: WorldKey): string => `${key.node}\u0000${key.generation}`

/** The placement of a world: its node and the playback overrides, so rotation, scale, fades and draw() reach the surface. */
function placement(member: WorldMember, place: WorldPlace): WorldPlacement {
  const { node, x, y, override } = place
  const m = override?.matrix
  // The override is a world matrix on the final geometry; the contract applies it around the rect's centre.
  const cx = x + node.w / 2
  const cy = y + node.h / 2
  const matrix: WorldPlacement['matrix'] = m ? [m[0], m[1], m[2], m[3], m[0] * cx + m[2] * cy + m[4] - cx, m[1] * cx + m[3] * cy + m[5] - cy] : IDENTITY
  return {
    ...member.key,
    x,
    y,
    w: node.w,
    h: node.h,
    matrix,
    opacity: nodeOpacity(node) * (override?.opacity ?? 1),
    reveal: override?.reveal ?? 1,
    z: node.z,
    shown: member.shown
  }
}

// ---------- Frame messages: one listener for every surface frame ----------

// A hot reload of the worker stops here, so the page's modules keep their state in dev.
let workerSide = worker
if (import.meta.hot) import.meta.hot.accept('./worker', (next) => {
  if (next) workerSide = next as unknown as typeof worker
})

const byWindow = new Map<Window, WorldSurface>()
let listening = false

function listen(): void {
  if (listening) return
  listening = true
  window.addEventListener('message', (event) => {
    const source = event.source as Window | null
    const surface = source ? byWindow.get(source) : undefined
    if (surface && event.origin === 'null') surface.fromFrame(event.data)
  })
}

export class WorldSurface {
  private readonly context: ImageBitmapRenderingContext | null
  private members = new Map<string, WorldMember>()
  private frame: HTMLIFrameElement | null = null
  private box: HTMLElement | null = null
  private channel: MessageChannel | null = null
  private disposed = false
  /** Messages wait here until the first size is known: `init` is the worker's first message. */
  private outbox: PageToWorld[] | null = []
  private opened = false
  /** Generations that left: they go in the paint that shows what replaces them. */
  private removals: WorldKey[] = []
  private waiting: Picture | null = null
  /** The camera of the picture on the canvas. */
  private shownCamera: WorldCamera | null = null
  /** Where that picture lies, in CSS pixels from the board's top-left corner at its camera. */
  private shownBox: Picture['box'] | null = null
  private size = ''
  private boxSize = ''
  private transform = ''
  private lastView = ''
  private seq = 0
  private watchdog = 0
  private checkedAt = 0
  /** When the worker last gave any message; 0 until it is ready. */
  private answeredAt = 0
  private pings = 0
  /** The world that runs now in the worker, as it last said. */
  private running: WorldKey | null = null
  /** After a recovery: the view with the first world shown. Pictures before it do not show. */
  private recovering: { seq: number } | null = null

  /** canvas null: a private surface of the given size, with no board to follow. */
  constructor(
    private readonly canvas: HTMLCanvasElement | null,
    private board: WorldBoard | null,
    fixed?: { width: number; height: number; dpr: number }
  ) {
    this.context = canvas?.getContext('bitmaprenderer') ?? null
    if (canvas) boardSurfaces.add(this)
    if (fixed) this.begin({ type: 'init', ...fixed, margin: 0 })
  }

  get active(): boolean {
    return this.members.size > 0
  }

  setBoard(board: WorldBoard): void {
    this.board = board
    if (this.members.size) board.paint()
  }

  // ----- The worker -----

  private boot(): void {
    if (this.frame) return
    listen()
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('tabindex', '-1')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'width:100%;height:100%;border:0'
    frame.src = `${LIVE_ORIGIN}/frame.html`
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1;overflow:hidden'
    box.appendChild(frame)
    document.body.appendChild(box)
    this.frame = frame
    this.box = box
    if (frame.contentWindow) byWindow.set(frame.contentWindow, this)
    this.channel = new MessageChannel()
    this.channel.port1.onmessage = (event) => this.receive(event.data as WorldToPage)
    if (this.canvas && !this.watchdog) {
      this.checkedAt = performance.now()
      this.watchdog = window.setInterval(() => this.check(), PING_MS)
    }
  }

  /** Ask the worker for an answer. A window that was hidden or a machine that slept proves nothing. */
  private check(): void {
    const now = performance.now()
    const late = now - this.checkedAt > PING_MS * 3
    this.checkedAt = now
    if (!this.answeredAt || this.outbox) return
    if (late || document.visibilityState === 'hidden' || !this.members.size) this.answeredAt = now
    else if (now - this.answeredAt > ([...this.members.values()].some((member) => member.settingUp) ? SETUP_MS : HANG_MS)) {
      this.recover(this.running)
      return
    }
    this.channel?.port1.postMessage({ type: 'ping', n: ++this.pings } satisfies PageToWorld)
  }

  /** End the worker and start again. `fault`: the world that stays stopped. */
  private recover(fault: WorldKey | null): void {
    const members = [...this.members.values()]
    this.endWorker()
    this.members.clear()
    this.removals = []
    this.outbox = []
    this.opened = false
    this.size = ''
    this.lastView = ''
    this.running = null
    if (this.waiting) this.waiting.bitmap.close()
    this.waiting = null
    this.recovering = { seq: Number.POSITIVE_INFINITY }
    for (const member of members) {
      if (member.ended) continue
      if (fault && keyOf(fault) === keyOf(member.key)) member.failed('This world stopped answering.')
      else member.lost()
    }
  }

  private endWorker(): void {
    this.frame?.contentWindow?.postMessage({ type: 'stop' }, '*')
    this.channel?.port1.close()
    for (const [win, surface] of byWindow) if (surface === this) byWindow.delete(win)
    this.box?.remove()
    this.frame = null
    this.box = null
    this.channel = null
    this.answeredAt = 0
  }

  /** A message from the frame: it is ready, or the worker failed to load. */
  fromFrame(data: unknown): void {
    if (!data || typeof data !== 'object' || this.disposed) return
    const m = data as { type?: unknown; message?: unknown }
    if (m.type === 'ready' && this.channel) {
      const port = this.channel.port2
      this.frame?.contentWindow?.postMessage({ type: 'start', url: workerSide.worldWorkerUrl(), port, init: {} }, '*', [port])
    } else if (m.type === 'load-error') {
      const message = typeof m.message === 'string' && m.message ? m.message.replace(/^Uncaught /, '') : 'The world surface failed to load.'
      for (const member of [...this.members.values()]) member.failed(message)
    }
  }

  private post(message: PageToWorld): void {
    if (this.outbox) this.outbox.push(message)
    else this.channel?.port1.postMessage(message)
  }

  /** The first size: the waiting messages go after it. */
  private begin(init: Extract<PageToWorld, { type: 'init' }>): void {
    const waiting = this.outbox ?? []
    const stats: PageToWorld[] = this.canvas && statsListener ? [{ type: 'stats', on: true }] : []
    const rate: PageToWorld[] = this.canvas && uncapped ? [{ type: 'uncapped', on: true }] : []
    this.outbox = [{ ...init, tune }, ...stats, ...rate, ...waiting]
    this.opened = true
    this.flush()
  }

  private flush(): void {
    if (!this.outbox || !this.channel || !this.opened) return
    for (const message of this.outbox) this.channel.port1.postMessage(message)
    this.outbox = null
  }

  private receive(m: WorldToPage): void {
    if (this.disposed) return
    this.answeredAt = performance.now()
    if (m.type === 'picture') this.picture(m)
    else if (m.type === 'stats') statsListener?.(m.stats)
    else if (m.type === 'running') {
      if (this.running && (!m.running || keyOf(m.running) !== keyOf(this.running))) this.members.get(keyOf(this.running))?.settled()
      this.running = m.running
    }
    else if (m.type === 'lost') this.recover(null)
    else if ('key' in m) this.members.get(keyOf(m.key))?.receive(m)
  }

  private picture(m: Picture): void {
    if (!this.context || (this.recovering && m.seq < this.recovering.seq)) {
      m.bitmap.close()
      this.post({ type: 'presented', n: m.n })
      return
    }
    this.recovering = null
    this.waiting?.bitmap.close()
    this.waiting = m
    this.board?.paint()
  }

  // ----- Generations -----

  /** A new generation. `run`: it runs ticks. */
  add(member: WorldMember, world: WorldStart, run: boolean): void {
    this.members.set(keyOf(member.key), member)
    this.boot()
    this.post({ type: 'add', world })
    this.post({ type: 'run', key: member.key, on: run })
    if (!this.canvas) {
      const placement: WorldPlacement = { ...member.key, x: 0, y: 0, w: world.w, h: world.h, matrix: IDENTITY, opacity: 1, reveal: 1, z: 0, shown: true }
      this.post({ type: 'view', seq: ++this.seq, camera: { x: 0, y: 0, zoom: 1 }, placements: [placement] })
    }
    this.flush()
    this.board?.paint()
  }

  send(message: PageToWorld): void {
    this.post(message)
  }

  anchor(id: string, dx: number, dy: number): void {
    this.board?.anchor(id, dx, dy)
  }

  wantsChanged(): void {
    this.board?.wants()
  }

  cursor(value: string): void {
    this.board?.cursor(value)
  }

  /** A member's placement changed: the next paint sends it. */
  changed(): void {
    this.board?.paint()
  }

  /** A generation left. The worker hears it in the paint that sends the view without it. */
  remove(key: WorldKey): void {
    if (!this.members.delete(keyOf(key))) return
    if (this.canvas) {
      this.removals.push(key)
      this.board?.paint()
    } else this.post({ type: 'remove', key })
  }

  // ----- One paint -----

  /** In the board's paint: show the waiting picture, move the canvas to the camera of this paint, and tell the worker what changed. */
  sync(camera: Camera, viewport: Point): void {
    const [vw, vh] = viewport
    if (!this.canvas || !this.context || vw < 2 || vh < 2) return
    const view: WorldCamera = { x: camera.center[0] - vw / 2 / camera.zoom, y: camera.center[1] - vh / 2 / camera.zoom, zoom: camera.zoom }
    this.resize(vw, vh)
    this.adopt(this.context)
    this.follow(this.canvas, view)
    this.sendView(view)
  }

  private resize(vw: number, vh: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, tune.dpr ?? Infinity)
    const size = `${vw}x${vh}@${dpr}`
    if (size === this.size) return
    const first = !this.size
    this.size = size
    if (first) this.begin({ type: 'init', width: vw, height: vh, dpr, margin: margin() })
    else this.post({ type: 'resize', width: vw, height: vh, dpr })
  }

  private adopt(context: ImageBitmapRenderingContext): void {
    if (this.members.size === 0) {
      // No world is left: no picture is due.
      if (this.waiting) this.settle(this.waiting)
      if (this.shownCamera) context.transferFromImageBitmap(null)
      this.shownCamera = null
      return
    }
    const picture = this.waiting
    if (!picture) return
    context.transferFromImageBitmap(picture.bitmap)
    this.shownCamera = picture.camera
    this.shownBox = picture.box
    for (const member of this.members.values()) member.showPoints(picture.points[member.key.node])
    this.board?.points(picture.points)
    this.settle(picture)
  }

  private settle(picture: Picture): void {
    picture.bitmap.close()
    this.waiting = null
    this.post({ type: 'presented', n: picture.n })
  }

  /** The picture's place: its box at its camera, then the transform from that camera to the camera of this paint, around the board's top-left corner. */
  private follow(canvas: HTMLCanvasElement, view: WorldCamera): void {
    const shown = this.shownCamera
    const box = this.shownBox
    if (!shown || !box) return
    const size = `${box.width}x${box.height}`
    if (size !== this.boxSize) {
      this.boxSize = size
      canvas.style.width = `${box.width}px`
      canvas.style.height = `${box.height}px`
    }
    const transform = `translate(${(shown.x - view.x) * view.zoom}px, ${(shown.y - view.y) * view.zoom}px) scale(${view.zoom / shown.zoom}) translate(${box.x}px, ${box.y}px)`
    if (transform === this.transform) return
    this.transform = transform
    canvas.style.transform = transform
  }

  private sendView(view: WorldCamera): void {
    const placements: WorldPlacement[] = []
    for (const member of this.members.values()) {
      const place = this.board?.place(member.key.node)
      if (place) placements.push(placement(member, place))
    }
    const text = JSON.stringify([view, placements])
    if (text !== this.lastView) {
      this.lastView = text
      this.post({ type: 'view', seq: ++this.seq, camera: view, placements })
      if (this.recovering && placements.some((placement) => placement.shown)) this.recovering.seq = Math.min(this.recovering.seq, this.seq)
    }
    for (const key of this.removals) this.post({ type: 'remove', key })
    this.removals = []
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    boardSurfaces.delete(this)
    this.waiting?.bitmap.close()
    this.waiting = null
    clearInterval(this.watchdog)
    this.endWorker()
    this.context?.transferFromImageBitmap(null)
  }
}

// ---------- One surface per board ----------

// One per board, also across a hot reload of this file in dev.
const surfaces: WeakMap<HTMLElement, WorldSurface> = (import.meta.hot?.data.surfaces as WeakMap<HTMLElement, WorldSurface> | undefined) ?? new WeakMap()
const sides: WeakMap<HTMLElement, WorldBoard> = (import.meta.hot?.data.sides as WeakMap<HTMLElement, WorldBoard> | undefined) ?? new WeakMap()
if (import.meta.hot) Object.assign(import.meta.hot.data, { surfaces, sides })

/** The surface of the board around `inside`. Its canvas is in the board's markup. */
export function boardSurface(inside: HTMLElement): WorldSurface {
  const board = inside.closest<HTMLElement>('.board')
  const canvas = board?.querySelector<HTMLCanvasElement>(':scope > .board__world')
  if (!board || !canvas) throw new Error('A world needs a board.')
  let surface = surfaces.get(board)
  if (!surface) {
    surface = new WorldSurface(canvas, sides.get(board) ?? null)
    surfaces.set(board, surface)
  }
  return surface
}

/** The board joins its surface, now or when the first world starts. The cleanup ends the surface. */
export function bindWorldBoard(element: HTMLElement, side: WorldBoard): () => void {
  sides.set(element, side)
  surfaces.get(element)?.setBoard(side)
  return () => {
    sides.delete(element)
    surfaces.get(element)?.dispose()
    surfaces.delete(element)
  }
}

/** The board has worlds now: a change of their look needs a paint, as ink does. */
export function hasWorlds(element: HTMLElement | null): boolean {
  return !!element && !!surfaces.get(element)?.active
}

/** In the board's paint. */
export function syncWorlds(element: HTMLElement | null, camera: Camera, viewport: Point): void {
  if (element) surfaces.get(element)?.sync(camera, viewport)
}
