import type { BoardHandle } from '../board/Board'
import { revealPoints, type NodeOverride, type PlaybackFrame, type PlaybackTip } from '../board/playback'
import type { Point } from '../board/types'
import type { PlayObject, ScenePlay } from './compile'
import { apply, isIdentity, multiply, type Matrix } from './timeline'

/**
 * Plays live scenes on the board. Each scene's items are already on the
 * board in their final state; the player shows every moment before that by
 * sending the board a frame of overrides (playback.ts), at the display's
 * frame rate. Several scenes can play at once. Learner input never waits for
 * it: the player only changes how nodes show.
 */

interface Playing {
  play: ScenePlay
  /** performance.now() at scene time 0. */
  origin: number
  /** A fixed scene time while paused (seek), else null. */
  paused: number | null
}

/** What the dev hook (window.__spaceDev.scene) shows. */
export interface ScenePlayerState {
  playing: boolean
  current: string | null
  time: number | null
  duration: number | null
  steps: Array<{ name: string; at: number }>
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

function tipOnLines(lines: Point[][], share: number, total: number): Point | null {
  let left = share * total
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const length = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
      if (left <= length) {
        const k = length ? left / length : 0
        return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * k, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * k]
      }
      left -= length
    }
  }
  return null
}

/** True while a draw action is drawing (not undrawing) this object at t. */
function drawingNow(play: ScenePlay, object: PlayObject, t: number): boolean {
  for (const a of play.timeline.tracks[object.id].draw ?? []) {
    if (t >= a.start && t < a.start + a.dur && typeof a.to === 'number' && a.to > (typeof a.from === 'number' ? a.from : 0)) return true
  }
  return false
}

/** One scene's overrides and pen tips at scene time t. */
function sceneFrame(play: ScenePlay, t: number, overrides: Map<string, NodeOverride>, tips: PlaybackTip[]): void {
  const timeline = play.timeline
  for (const object of play.objects) {
    const desc = timeline.object(object.id)
    if (t >= object.settled && !object.ghost && t >= desc.created) continue
    const before = desc.vis === 'shown' && t < desc.created
    const draw = clamp01(timeline.number(object.id, 'draw', t))
    const fill = clamp01(timeline.number(object.id, 'fill', t))
    const opacity = before ? 0 : clamp01(timeline.number(object.id, 'opacity', t)) / object.finalOpacity
    const world = timeline.matrix(object.id, t)
    const colorChanging = timeline.hasTrack(object.id, 'color')
    const color = colorChanging ? timeline.color(object.id, t) : undefined
    const drawing = object.drawn && drawingNow(play, object, t)
    let tipDone = false
    for (const target of object.targets) {
      const matrix: Matrix = multiply(world, target.inverseBaked)
      const override: NodeOverride = {}
      if (!isIdentity(matrix)) override.matrix = matrix
      if (Math.abs(opacity - 1) > 0.001) override.opacity = draw <= 0 && fill <= 0 ? 0 : opacity
      else if (draw <= 0 && fill <= 0) override.opacity = 0
      if (color) override.color = color
      if (target.ink) {
        const [a, b] = target.range ?? [0, 1]
        const share = b > a ? clamp01((draw - a) / (b - a)) : draw >= b ? 1 : 0
        if (share < 1) override.reveal = share
      } else {
        if (draw < 1) override.reveal = draw
        if (fill < 1) override.fill = fill
      }
      if (override.matrix || override.opacity !== undefined || override.reveal !== undefined || override.fill !== undefined || override.color) overrides.set(target.nodeId, override)
      // The pen tip on a vector outline being drawn now (ink tips: ScenePlayer.inkTips).
      if (drawing && !tipDone && !before && !target.ink && target.tipLines && target.tipLength && draw > 0 && draw < 1) {
        const point = tipOnLines(target.tipLines, draw, target.tipLength)
        if (point) {
          tips.push({ point: apply(matrix, point), color: color ?? object.tipColor, size: target.tipWidth ?? 3 })
          tipDone = true
        }
      }
    }
  }
}

export class ScenePlayer {
  private board: BoardHandle | null = null
  private scenes: Playing[] = []
  private frame: number | null = null
  private last: string | null = null
  /** Ink points by node id, for pen tips (read from the board at start). */
  private inkPoints = new Map<string, { points: ReadonlyArray<readonly [number, number, number]>; offset: Point }>()

  /** Start a scene now. Its first frame shows before this returns. */
  start(board: BoardHandle, play: ScenePlay): void {
    if (board !== this.board) this.stopAll()
    this.board = board
    this.scenes.push({ play, origin: performance.now(), paused: null })
    this.last = play.id
    const state = board.liveState()
    const ids = new Set(play.objects.flatMap((object) => object.targets.filter((target) => target.ink).map((target) => target.nodeId)))
    // The final geometry as committed (ghosts are top level): the pen tip runs along it.
    const layout = state.layout()
    const ghostIds = new Set(play.ghosts.map((node) => node.id))
    for (const node of [...state.nodes, ...play.ghosts]) {
      if (node.kind !== 'ink' || !ids.has(node.id)) continue
      const ink = node as { x: number; y: number; points: Array<[number, number, number]> }
      const box = ghostIds.has(node.id) ? null : layout.get(node.id)
      this.inkPoints.set(node.id, { points: ink.points, offset: box ? [box.ox, box.oy] : [ink.x, ink.y] })
    }
    this.render()
    this.schedule()
  }

  /** End every scene at once (a board switch): items stay in their final state. */
  stopAll(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.scenes = []
    this.inkPoints.clear()
    this.board?.setPlayback(null)
  }

  /** The board went away (unmount, another board): forget it without touching it. */
  detach(board: BoardHandle | null): void {
    if (board && board !== this.board) return
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.scenes = []
    this.inkPoints.clear()
    this.board = null
  }

  private schedule(): void {
    if (this.frame !== null || !this.scenes.length) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.render()
      this.schedule()
    })
  }

  private render(): void {
    const board = this.board
    if (!board) return
    const now = performance.now()
    const overrides = new Map<string, NodeOverride>()
    const tips: PlaybackTip[] = []
    const keep: Playing[] = []
    for (const scene of this.scenes) {
      const t = scene.paused ?? (now - scene.origin) / 1000
      if (scene.paused === null && t > scene.play.duration + 0.05) continue
      keep.push(scene)
      sceneFrame(scene.play, t, overrides, tips)
      this.inkTips(scene, t, overrides, tips)
    }
    this.scenes = keep
    if (!keep.length) {
      this.inkPoints.clear()
      board.setPlayback(null)
      return
    }
    const ghosts = this.ghostList(keep)
    const frame: PlaybackFrame = { overrides, ghosts, tips }
    board.setPlayback(frame)
  }

  private ghostCache: { key: string; list: PlaybackFrame['ghosts'] } = { key: '', list: [] }

  /** The same array while the set of playing scenes is the same (the board re-renders ghosts only when it changes). */
  private ghostList(scenes: Playing[]): PlaybackFrame['ghosts'] {
    const key = scenes.map((scene) => scene.play.id).join(',')
    if (key !== this.ghostCache.key) this.ghostCache = { key, list: scenes.flatMap((scene) => scene.play.ghosts) }
    return this.ghostCache.list
  }

  /** Pen tips on ink being drawn: the end of the drawn part of the stroke. */
  private inkTips(scene: Playing, t: number, overrides: Map<string, NodeOverride>, tips: PlaybackTip[]): void {
    const play = scene.play
    for (const object of play.objects) {
      if (!object.drawn || !drawingNow(play, object, t)) continue
      const desc = play.timeline.object(object.id)
      if (desc.vis === 'shown' && t < desc.created) continue
      const draw = play.timeline.number(object.id, 'draw', t)
      const target = object.targets.find((entry) => entry.ink && entry.range && draw > entry.range[0] && draw < entry.range[1])
      if (!target || !target.range) continue
      const entry = this.inkPoints.get(target.nodeId)
      if (!entry || entry.points.length < 2) continue
      const { points, offset } = entry
      const share = (draw - target.range[0]) / (target.range[1] - target.range[0])
      const shown = revealPoints(points, share)
      const end = shown[shown.length - 1]
      if (!end) continue
      const override = overrides.get(target.nodeId)
      const point: Point = [offset[0] + end[0], offset[1] + end[1]]
      tips.push({ point: override?.matrix ? apply(override.matrix, point) : point, color: override?.color ?? object.tipColor, size: target.tipWidth ?? 3 })
    }
  }

  /** Dev: hold the current scene at time t (seconds), or let it run again with null. */
  seek(t: number | null): void {
    const scene = this.scenes.find((entry) => entry.play.id === this.last) ?? this.scenes[this.scenes.length - 1]
    if (!scene) return
    if (t === null) {
      if (scene.paused !== null) scene.origin = performance.now() - scene.paused * 1000
      scene.paused = null
    } else scene.paused = Math.max(0, Math.min(scene.play.duration, t))
    this.render()
    this.schedule()
  }

  /** Dev: end every scene now. */
  finish(): void {
    this.stopAll()
  }

  state(): ScenePlayerState {
    const scene = this.scenes.find((entry) => entry.play.id === this.last) ?? null
    const time = scene ? (scene.paused ?? (performance.now() - scene.origin) / 1000) : null
    return {
      playing: this.scenes.length > 0,
      current: scene ? scene.play.id : null,
      time: time === null ? null : Math.round(time * 1000) / 1000,
      duration: scene ? scene.play.duration : null,
      steps: scene ? scene.play.steps : []
    }
  }
}

export const scenePlayer = new ScenePlayer()
