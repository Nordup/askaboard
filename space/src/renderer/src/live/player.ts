import type { BoardNode, InkNode, InkPoint } from '@shared/board-format'
import { SCENE_EASES, type SceneStatus } from '@shared/live-scene'
import type { BoardHandle } from '../board/Board'
import { clampZoom } from '../board/geometry'
import { revealPoints, type NodeOverride, type PlaybackFrame, type PlaybackTip } from '../board/playback'
import type { Point } from '../board/types'
import { sceneColor, withOpacity } from './colors'
import type { DynSample, PlayEdit, PlayObject, ScenePlay } from './compile'
import { blendStyle } from '../board/style-edits'
import { clearSceneScript, setSceneUiActions, setSceneUiState, type SceneCueState, type SceneListEntry } from './state'
import { apply, isIdentity, multiply, type Matrix } from './timeline'

/**
 * Plays live scenes on the board. Each scene's items are already on the
 * board in their final state; the player shows every moment before that by
 * sending the board a frame of overrides (playback.ts), at the display's
 * frame rate.
 *
 * Scenes queue: a scene sent while another plays starts when it ends (its
 * items are committed at once and stay hidden until then); a scene sent with
 * when "now" plays at once, over the others. A scene stops at a pause step,
 * or at the next step when the learner starts drawing, until it is resumed.
 * Nothing is spoken: the lines (say) are text on the timeline that the app
 * shows at a reading pace (state.ts holds the current line and how far it
 * is read). It moves the learner's view (camera) until the learner moves
 * it, and shows a pointer (point).
 */

interface Playing {
  play: ScenePlay
  mode: 'queue' | 'now'
  /** performance.now() at scene time 0; null while it waits in the queue. */
  origin: number | null
  /** The scene time it is held at (paused), else null. */
  pausedAt: number | null
  /** Pause when the scene reaches this time (the learner started drawing). */
  pauseAt: number | null
  /** The scene time at the last frame (to see what was crossed since). */
  lastT: number
  /** Pause steps already passed. */
  passed: Set<number>
  /** Date.now() when it started playing. */
  startedEpoch: number
  cameraBlocked: boolean
  /** Why it stands paused (null while it plays). */
  pausedBy: ScenePauseReason | null
  /** Undo its commit (skip). */
  /** Take its items off the board again; `step` joins that keyed undo step (Board agentCommit). */
  revert: (step?: string) => void
  /** The scene time it starts from (0, or a replayed step). */
  startAt: number
}

/** What paused a scene: a step with {pause: true}, the learner's drawing, or scene_control pause. */
export type ScenePauseReason = 'pause step' | 'learner drawing' | 'scene_control pause'

/** A note for the board news: a scene paused because the learner drew. */
export interface ScenePauseNote {
  scene: string
  name: string | null
  step: string | null
  t: number
  duration: number
}

/** What the dev hook (window.__spaceDev.scene) shows. */
export interface ScenePlayerState {
  playing: boolean
  current: string | null
  time: number | null
  duration: number | null
  steps: Array<{ name: string; at: number }>
  paused: boolean
  queue: number
  /** When the latest scenes started and ended (Date ms). */
  played: Array<{ scene: string; start: number; end: number | null }>
}

/** Ink points by node id, with their world offset, for pen tips. */
export type InkIndex = Map<string, { points: ReadonlyArray<readonly [number, number, number]>; offset: Point }>

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
/** Two samples this close are frames of one motion: blend between them. */
const BLEND_GAP = 0.05

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
    if (t >= a.start && t < Math.min(a.start + a.dur, a.until ?? Infinity) && typeof a.to === 'number' && a.to > (typeof a.from === 'number' ? a.from : 0)) return true
  }
  return false
}

/** The sample at t and the next one to blend with (k = 0: none). */
function locate(samples: DynSample[], t: number): { a: DynSample; b: DynSample; k: number } {
  let lo = 0
  let hi = samples.length - 1
  if (t <= samples[0].t) return { a: samples[0], b: samples[0], k: 0 }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  const a = samples[lo]
  const b = samples[Math.min(lo + 1, samples.length - 1)]
  if (b === a || b.t - a.t > BLEND_GAP) return { a, b: a, k: 0 }
  return { a, b, k: (t - a.t) / (b.t - a.t) }
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k
const r2 = (value: number): number => Math.round(value * 100) / 100

function blendD(a: DynSample, b: DynSample, k: number): string | undefined {
  if (k <= 0 || !a.numbers || !b.numbers || a.skeleton !== b.skeleton || a.numbers.length !== b.numbers.length) return a.d
  let i = 0
  const an = a.numbers
  const bn = b.numbers
  return (a.skeleton as string).replace(/#/g, () => {
    const value = r2(lerp(an[i], bn[i], k))
    i++
    return String(value)
  })
}

function blendLines(a: DynSample, b: DynSample, k: number): Point[][] {
  const al = a.lines ?? []
  const bl = b.lines ?? []
  if (k <= 0 || al.length !== bl.length || al.some((line, i) => line.length !== bl[i].length)) return al
  return al.map((line, i) => line.map((p, j) => [lerp(p[0], bl[i][j][0], k), lerp(p[1], bl[i][j][1], k)] as Point))
}

function blendParams(a: DynSample, b: DynSample, k: number): Record<string, number> | undefined {
  if (!a.params) return undefined
  if (k <= 0 || !b.params) return a.params
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(a.params)) out[key] = typeof b.params[key] === 'number' ? lerp(value, b.params[key], k) : value
  return out
}

/** The matrix that takes the end state's box to the box of now (text and live items that change size or place). */
function boxMatrix(from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number }, centered: boolean, scale: boolean): Matrix {
  if (!scale) {
    const dx = centered ? to.x + to.width / 2 - (from.x + from.width / 2) : to.x - from.x
    const dy = centered ? to.y + to.height / 2 - (from.y + from.height / 2) : to.y - from.y
    return [1, 0, 0, 1, dx, dy]
  }
  const sx = from.width > 0 ? to.width / from.width : 1
  const sy = from.height > 0 ? to.height / from.height : 1
  return [sx, 0, 0, sy, to.x - sx * from.x, to.y - sy * from.y]
}

/** The pointer at scene time t, or null. */
function pointerAt(play: ScenePlay, t: number): PlaybackTip | null {
  if (!play.pointer.length || t < play.pointer[0].start || t > play.duration + 0.05) return null
  let pos: Point | null = null
  let alpha = 0
  for (const action of play.pointer) {
    if (action.start > t) break
    const k = action.dur > 0 ? ease(clamp01((t - action.start) / action.dur)) : 1
    if (action.to === null) {
      alpha = alpha * (1 - k)
      continue
    }
    const to = action.to as Point
    // The first glide comes in from a little below and to the right, as a hand does.
    const from: Point = pos && alpha > 0.01 ? pos : [to[0] + 40, to[1] + 56]
    const fromAlpha = pos && alpha > 0.01 ? alpha : 0
    pos = [lerp(from[0], to[0], k), lerp(from[1], to[1], k)]
    alpha = lerp(fromAlpha, 1, Math.min(1, k * 2))
  }
  if (!pos || alpha <= 0.01) return null
  return { point: pos, color: sceneColor('accent').hex, size: 9, kind: 'pointer', alpha }
}

export interface SceneFrame {
  overrides: Map<string, NodeOverride>
  tips: PlaybackTip[]
  inks: BoardNode[]
}

/**
 * One scene's look at scene time t: overrides for its nodes, pen tips, the
 * pointer, and ink that exists only now (changing ink). A negative t is a
 * scene that has not started: what it makes is hidden, what it changes shows
 * as before the scene.
 */
/** Set a node's override; fields already set for it (by a later scene) stay unless this scene sets them too. */
function setOverride(out: SceneFrame, id: string, override: NodeOverride): void {
  const earlier = out.overrides.get(id)
  out.overrides.set(id, earlier ? { ...earlier, ...override } : override)
}

export function sceneFrame(play: ScenePlay, t: number, inkIndex: InkIndex | null, out: SceneFrame, claimed?: ReadonlySet<string>): void {
  const timeline = play.timeline
  // A replay hides the items that changed since the scene: their look of then shows as ghosts.
  if (play.hidden && t <= play.duration) for (const id of play.hidden) setOverride(out, id, { opacity: 0 })
  // An item that html() replaces shows until the new material appears.
  if (play.vanish) for (const entry of play.vanish) if (t >= entry.at) for (const id of entry.ids) setOverride(out, id, { opacity: 0 })
  for (const object of play.objects) {
    const desc = timeline.object(object.id)
    if (t >= object.settled && !object.ghost && t >= desc.created) continue
    // A carried object (from an earlier scene) is on the board before this scene starts.
    const before = desc.kind !== 'node' && !desc.carry && desc.vis === 'shown' && t < desc.created
    const draw = clamp01(timeline.number(object.id, 'draw', t))
    const fill = clamp01(timeline.number(object.id, 'fill', t))
    const opacity = before ? 0 : clamp01(timeline.number(object.id, 'opacity', t)) / object.finalOpacity
    let world = timeline.matrix(object.id, t)
    if (object.glide) {
      // move(…, {into}): from its old place to its place in the frame.
      const g = object.glide
      const k = t <= g.start ? 0 : t >= g.start + g.dur || g.dur <= 0 ? 1 : SCENE_EASES[g.ease]((t - g.start) / g.dur)
      if (k < 1) world = multiply([1, 0, 0, 1, g.from[0] * (1 - k), g.from[1] * (1 - k)], world)
    }
    const colorChanging = timeline.hasTrack(object.id, 'color')
    const color = colorChanging ? timeline.color(object.id, t) : undefined
    const drawing = object.drawn && drawingNow(play, object, t)
    const dyn = object.dyn && t < object.dyn.end && (t >= 0 || desc.carry) ? object.dyn : undefined
    const now = dyn ? locate(dyn.samples, t) : null
    if (dyn && now && (dyn.kind === 'text' || dyn.kind === 'live')) world = multiply(world, boxMatrix(dyn.finalBounds, now.a.bounds, dyn.centered, dyn.kind === 'live'))

    // Changing ink: the strokes of now, painted on their own; the committed strokes wait hidden.
    if (dyn && now && dyn.kind === 'ink' && dyn.ink) {
      // A carried object that an earlier scene still makes or animates: that scene shows it until it is done.
      if (desc.carry && t < 0 && claimed && object.targets.some((target) => claimed.has(target.nodeId))) continue
      const lines = blendLines(now.a, now.b, now.k)
      const lengths = lines.map((line) => {
        let length = 0
        for (let i = 1; i < line.length; i++) length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
        return length
      })
      const total = lengths.reduce((sum, length) => sum + length, 0) || 1
      let at = 0
      const shown = before || (draw <= 0 && fill <= 0) ? 0 : clamp01(timeline.number(object.id, 'opacity', t))
      const inkColor = withOpacity(color ?? dyn.ink.color, shown)
      lines.forEach((line, i) => {
        const share = clamp01((draw * total - at) / (lengths[i] || 1))
        at += lengths[i]
        if (share <= 0 || line.length < 2 || shown <= 0) return
        const points = line.map(([x, y]) => {
          const [wx, wy] = apply(world, [x, y])
          return [wx, wy, 0.5] as InkPoint
        })
        const visible = revealPoints(points, share)
        if (visible.length < 2) return
        out.inks.push({ id: `${play.id}:${object.id}:${i}`, kind: 'ink', x: 0, y: 0, z: 0, author: 'agent', seq: 0, tool: dyn.ink!.tool, color: inkColor, width: (now.a.width ?? dyn.ink!.width) * Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2])), points: visible } as InkNode)
        if (drawing && share < 1 && share > 0) out.tips.push({ point: [visible[visible.length - 1][0], visible[visible.length - 1][1]], color: color ?? object.tipColor, size: dyn.ink!.width })
      })
      for (const target of object.targets) setOverride(out, target.nodeId, { opacity: 0 })
      continue
    }

    let tipDone = false
    for (const target of object.targets) {
      const matrix: Matrix = multiply(world, target.inverseBaked)
      const override: NodeOverride = {}
      if (!target.inner && !isIdentity(matrix)) override.matrix = matrix
      if (!target.ink && target.range) {
        // Material: the root, then its parts one after another, as the object is drawn.
        const [a, b] = target.range
        const share = b > a ? clamp01((draw - a) / (b - a)) : draw >= b ? 1 : 0
        const own = target.inherit ? 1 : opacity
        const shown = target.look === 'fade' ? own * share : own
        if (share <= 0 || shown <= 0.001) override.opacity = 0
        else if (Math.abs(shown - 1) > 0.001) override.opacity = shown
        if (share > 0 && share < 1 && target.look !== 'fade') override.reveal = share
        if (color && !target.inherit) override.color = color
      } else {
        if (Math.abs(opacity - 1) > 0.001) override.opacity = draw <= 0 && fill <= 0 ? 0 : opacity
        else if (draw <= 0 && fill <= 0) override.opacity = 0
        if (color) override.color = color
        if (target.ink) {
          const [a, b] = target.range ?? [0, 1]
          const share = b > a ? clamp01((draw - a) / (b - a)) : draw >= b ? 1 : 0
          if (share < 1) override.reveal = share
        } else {
          if (draw < 1) override.reveal = target.look === 'fade' ? undefined : draw
          if (draw < 1 && target.look === 'fade') override.opacity = (override.opacity ?? 1) * draw
          if (fill < 1) override.fill = fill
        }
      }
      if (dyn && now) {
        if (dyn.kind === 'shape') {
          override.d = blendD(now.a, now.b, now.k)
          if (now.a.width !== undefined) override.strokeWidth = now.k > 0 && now.b.width !== undefined ? lerp(now.a.width, now.b.width, now.k) : now.a.width
        } else if (dyn.kind === 'text' && now.a.html !== undefined) override.html = now.a.html
        else if (dyn.kind === 'live') override.params = blendParams(now.a, now.b, now.k)
      }
      if (override.matrix || override.opacity !== undefined || override.reveal !== undefined || override.fill !== undefined || override.color || override.d !== undefined || override.html !== undefined || override.params) {
        setOverride(out, target.nodeId, override)
      }
      // The pen tip on a vector outline being drawn now.
      if (drawing && !tipDone && !before && !target.ink && target.tipLines && target.tipLength && draw > 0 && draw < 1 && !dyn) {
        const point = tipOnLines(target.tipLines, draw, target.tipLength)
        if (point) {
          out.tips.push({ point: apply(matrix, point), color: color ?? object.tipColor, size: target.tipWidth ?? 3 })
          tipDone = true
        }
      }
    }
    // The pen tip on ink being drawn: the end of the drawn part of the stroke.
    if (drawing && !before && inkIndex && object.targets.some((target) => target.ink)) {
      const target = object.targets.find((entry) => entry.ink && entry.range && draw > entry.range[0] && draw < entry.range[1])
      const entry = target && inkIndex.get(target.nodeId)
      if (target && target.range && entry && entry.points.length >= 2) {
        const share = (draw - target.range[0]) / (target.range[1] - target.range[0])
        const shownPoints = revealPoints(entry.points, share)
        const end = shownPoints[shownPoints.length - 1]
        if (end) {
          const override = out.overrides.get(target.nodeId)
          const point: Point = [entry.offset[0] + end[0], entry.offset[1] + end[1]]
          out.tips.push({ point: override?.matrix ? apply(override.matrix, point) : point, color: override?.color ?? object.tipColor, size: target.tipWidth ?? 3 })
        }
      }
    }
  }
  if (play.edits) editFrame(play.edits, t, out)
  const pointer = pointerAt(play, t)
  if (pointer) out.tips.push(pointer)
}

/** edit(): each edited node shows its text and styles of the moment (the board holds the end state). */
function editFrame(edits: readonly PlayEdit[], t: number, out: SceneFrame): void {
  const byNode = new Map<string, PlayEdit[]>()
  for (const edit of edits) {
    const list = byNode.get(edit.nodeId)
    if (list) list.push(edit)
    else byNode.set(edit.nodeId, [edit])
  }
  for (const [nodeId, list] of byNode) {
    const last = list[list.length - 1]
    if (t >= last.at + last.dur && list.every((edit) => t >= edit.at + edit.dur)) continue
    const override: NodeOverride = {}
    // The words of now: before the first text change that has not happened yet.
    const pending = list.find((edit) => edit.before.html !== undefined && t < edit.at)
    if (pending) override.html = pending.before.html
    const style: Record<string, string> = {}
    const keys = new Set(list.flatMap((edit) => Object.keys(edit.after.style ?? {})))
    for (const key of keys) {
      let value: string | undefined
      for (const edit of list) {
        const to = edit.after.style?.[key]
        if (to === undefined) continue
        const from = edit.before.style?.[key] ?? ''
        if (t < edit.at) {
          value ??= from
          break
        }
        value = t >= edit.at + edit.dur || edit.dur <= 0 ? to : blendStyle(from, to, SCENE_EASES[edit.ease]((t - edit.at) / edit.dur))
      }
      if (value !== undefined) style[key] = value
    }
    if (list[0].ink) {
      if (style.color) override.color = style.color
    } else if (Object.keys(style).length) override.style = style
    if (override.html !== undefined || override.color || override.style) setOverride(out, nodeId, override)
  }
}

/** Ink points of a scene's ink targets, from a node list (the board, or a preview's nodes). */
export function inkIndexOf(play: ScenePlay, nodes: readonly BoardNode[], layout: ReadonlyMap<string, { ox: number; oy: number }> | null): InkIndex {
  const index: InkIndex = new Map()
  const ids = new Set(play.objects.flatMap((object) => object.targets.filter((target) => target.ink).map((target) => target.nodeId)))
  const ghostIds = new Set(play.ghosts.map((node) => node.id))
  const offsets = new Map<string, Point>()
  for (const object of play.objects) for (const target of object.targets) if (target.offset) offsets.set(target.nodeId, target.offset)
  for (const node of [...nodes, ...play.ghosts]) {
    if (node.kind !== 'ink' || !ids.has(node.id)) continue
    const ink = node as { x: number; y: number; points: Array<[number, number, number]> }
    const box = ghostIds.has(node.id) || !layout ? null : layout.get(node.id)
    index.set(node.id, { points: ink.points, offset: box ? [box.ox, box.oy] : (offsets.get(node.id) ?? [ink.x, ink.y]) })
  }
  return index
}

/** A node as a comparable string (its sequence number left out), to tell whether it changed since a scene. */
export function nodeSig(node: BoardNode): string {
  const { seq: _seq, ...rest } = node as BoardNode & { seq?: number }
  return JSON.stringify(rest)
}

/** A scene as it was committed, for replay: its play and its items then (as top-level ghosts, in world coordinates). */
export interface SceneMemory {
  play: ScenePlay
  snapshot: Map<string, { sig: string; ghost: BoardNode }>
}

/**
 * The reading pace of say() lines, as in live-prelude.js (measureLine): word
 * k of a line is reached 0.3 + k / 3.5 s after the line starts (the first
 * word at once). Returns the words read so far and the share of the line's time.
 */
const WORDS_PER_S = 3.5
function readAt(text: string, elapsed: number, dur: number): { text: string; progress: number } {
  let out = ''
  let word = 0
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue
    if (/^\s+$/.test(part)) {
      if (out) out += part
      continue
    }
    const reached = word === 0 ? 0 : 0.3 + word / WORDS_PER_S
    if (reached > elapsed + 1e-6) break
    out += part
    word++
  }
  return { text: out.trimEnd(), progress: Math.round(Math.max(0, Math.min(1, elapsed / Math.max(0.001, dur))) * 1000) / 1000 }
}

/** The board items a scene draws, moves or changes (its objects' nodes, and the nodes its edits change). */
function playItems(play: ScenePlay): string[] {
  const items = new Set<string>()
  for (const object of play.objects) {
    for (const target of object.targets) items.add(target.nodeId)
    for (const id of object.records ?? []) items.add(id)
  }
  for (const edit of play.edits ?? []) items.add(edit.nodeId)
  return [...items]
}

/** A scene for the UI store (its id, the scene it plays, name, lines and steps), made once per play (the store compares them by reference). */
const listCache = new WeakMap<ScenePlay, SceneListEntry>()
function sceneLists(play: ScenePlay): SceneListEntry {
  let lists = listCache.get(play)
  if (!lists) {
    lists = {
      id: play.id,
      of: play.id.replace(/~r\d+$/, ''),
      name: play.name ?? null,
      cues: play.cues.map((cue) => ({ text: cue.text, at_s: cue.at, dur_s: cue.dur, ...(cue.marks?.length ? { marks: Object.fromEntries(cue.marks.map((mark) => [mark.name, mark.at])) } : {}) })),
      steps: play.steps.map((step) => ({ name: step.name, at_s: step.at, ...(step.pause ? { pause: true } : {}) })),
      items: playItems(play)
    }
    listCache.set(play, lists)
  }
  return lists
}

/** A queued scene that starts within this long of the one before it ends starts exactly at that end (no gap, no overlap). */
const HANDOFF_MS = 250

export class ScenePlayer {
  private board: BoardHandle | null = null
  private scenes: Playing[] = []
  private frame: number | null = null
  private inkPoints: InkIndex = new Map()
  private wasDrawing = false
  private notes: ScenePauseNote[] = []
  private latest: { frame: PlaybackFrame | null } = { frame: null }
  /** performance.now() when the last queued scene reached its end. */
  private queueEnd: number | null = null
  private history = new Map<string, SceneMemory>()
  private replays = 0
  private swaps = 0
  /** When each scene started and ended on the clock (Date ms; for the lab's hand-off measures). */
  private playLog: Array<{ scene: string; start: number; end: number | null }> = []
  private waiters: Array<{ done: () => boolean; resolve: () => void }> = []
  private waitTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    setSceneUiActions({
      pause: () => void this.control('pause'),
      resume: () => void this.control('resume'),
      nextStep: () => this.nextStep(),
      replay: (list) => this.replayList(list),
      learnerActedSince: (ms) => this.learnerActedSince(ms)
    })
  }

  /** The learner wrote, drew or changed something on this board after `ms` (epoch ms). */
  private learnerActedSince(ms: number): boolean {
    const board = this.board
    if (!board) return true
    const state = board.liveState()
    if (state.learnerInkAt > ms || state.drawing) return true
    return state.nodes.some((node) => state.editor(node.id) === 'learner' && (state.changedAt(node.id) ?? 0) > ms)
  }

  /**
   * Add a scene: it plays now (mode "now", or nothing ahead of it), or after
   * the queued scenes ahead of it. Returns the seconds until it starts (pauses
   * not counted). startAt: the scene time it starts from (a replayed step).
   */
  enqueue(board: BoardHandle, play: ScenePlay, options: { mode: 'queue' | 'now'; revert: (step?: string) => void; startAt?: number }): number {
    if (board !== this.board) {
      this.stopAll()
      this.history.clear()
      clearSceneScript()
    }
    this.board = board
    const startsIn = options.mode === 'now' ? 0 : this.queueWait()
    const startAt = Math.max(0, Math.min(play.duration, options.startAt ?? 0))
    const passed = new Set<number>()
    play.steps.forEach((step, i) => {
      if (step.pause && step.at < startAt - 1e-6) passed.add(i)
    })
    this.scenes.push({
      play,
      mode: options.mode,
      origin: null,
      pausedAt: null,
      pauseAt: null,
      lastT: startAt,
      passed,
      startedEpoch: 0,
      cameraBlocked: false,
      pausedBy: null,
      revert: options.revert,
      startAt
    })
    const state = board.liveState()
    for (const [id, entry] of inkIndexOf(play, state.nodes, state.layout())) this.inkPoints.set(id, entry)
    this.render()
    this.schedule()
    return Math.round(startsIn * 1000) / 1000
  }

  /** Keep a committed scene for replay. */
  remember(memory: SceneMemory): void {
    this.history.set(memory.play.id, memory)
  }

  /** The stage started new: earlier scenes can no longer be replayed. */
  resetStage(): void {
    this.history.clear()
  }

  /** A scene that was committed again (replace, cut): the new play takes its place, keeping its place in the queue and its clock. */
  swap(board: BoardHandle, id: string, play: ScenePlay, revert: (step?: string) => void): boolean {
    const scene = this.scenes.find((entry) => entry.play.id === id)
    if (!scene) return false
    scene.play = play
    scene.revert = revert
    this.swaps++
    const state = board.liveState()
    for (const [nodeId, entry] of inkIndexOf(play, state.nodes, state.layout())) this.inkPoints.set(nodeId, entry)
    const memory = this.history.get(id)
    if (memory) memory.play = play
    this.render()
    this.schedule()
    return true
  }

  /** Take a waiting scene out of the queue (its items are already reverted). */
  drop(id: string): void {
    this.scenes = this.scenes.filter((scene) => scene.play.id !== id || scene.origin !== null)
    this.history.delete(id)
    this.render()
  }

  /** The scenes of the stage that were committed, oldest first (for replay). */
  memories(): SceneMemory[] {
    return [...this.history.values()]
  }

  /**
   * Play an earlier scene again, or from one of its steps: items it made or
   * changed that are different now show as they were then (ghosts over the
   * hidden current item), then play forward. Returns the replay's id and
   * where it starts, or an error text.
   */
  replay(board: BoardHandle, target: { scene?: string; step?: string }, mode: 'queue' | 'now'): { scene: string; of: string; from: number; starts_in_s: number } | { error: string } {
    let memory: SceneMemory | undefined
    let from = 0
    if (target.scene) {
      memory = this.history.get(target.scene)
      if (!memory) return { error: `There is no scene "${target.scene}" in this stage to replay (scenes of the current stage: ${[...this.history.keys()].join(', ') || 'none'}).` }
      if (target.step) {
        const step = memory.play.steps.find((entry) => entry.name === target.step)
        if (!step) return { error: `Scene ${target.scene} has no step "${target.step}" (its steps: ${memory.play.steps.map((entry) => entry.name).join(', ') || 'none'}).` }
        from = step.at
      }
    } else if (target.step) {
      for (const entry of [...this.history.values()].reverse()) {
        const step = entry.play.steps.find((s) => s.name === target.step)
        if (step) {
          memory = entry
          from = step.at
          break
        }
      }
      if (!memory) return { error: `No scene of this stage has a step "${target.step}".` }
    } else return { error: 'replay needs scene or step.' }
    const play = memory.play
    const id = `${play.id}~r${++this.replays}`
    const present = new Map(board.liveState().nodes.map((node) => [node.id, node]))
    const ghosts: BoardNode[] = []
    const hidden: string[] = []
    const remap = new Map<string, string>()
    for (const object of play.objects) {
      for (const t of object.targets) {
        if (remap.has(t.nodeId)) continue
        const snap = memory.snapshot.get(t.nodeId)
        if (!snap) continue
        const now = present.get(t.nodeId)
        if (now && nodeSig(now) === snap.sig) continue
        const ghostId = `${id}:${t.nodeId}`
        remap.set(t.nodeId, ghostId)
        ghosts.push({ ...snap.ghost, id: ghostId } as BoardNode)
        if (now) hidden.push(t.nodeId)
      }
    }
    const objects = play.objects.map((object) => ({ ...object, targets: object.targets.map((t) => (remap.has(t.nodeId) ? { ...t, nodeId: remap.get(t.nodeId) as string } : t)) }))
    const clone: ScenePlay = { ...play, id, objects, ghosts: [...play.ghosts, ...ghosts], hidden }
    const startsIn = this.enqueue(board, clone, { mode, revert: () => undefined, startAt: from })
    return { scene: id, of: play.id, from, starts_in_s: startsIn }
  }

  /** Seconds until a scene added now to the queue would start. */
  private queueWait(): number {
    const now = performance.now()
    let wait = 0
    for (const scene of this.scenes) {
      if (scene.mode !== 'queue') continue
      if (scene.origin === null) wait += scene.play.duration - scene.startAt
      else wait += Math.max(0, scene.play.duration - (scene.pausedAt ?? (now - scene.origin) / 1000))
    }
    return wait
  }

  /** Earlier scenes that show a node: a later scene that changes it shifts their overrides (run.ts). */
  playingScenes(): ScenePlay[] {
    return this.scenes.map((scene) => scene.play)
  }

  /** End every scene at once (a board switch): items stay in their final state. */
  stopAll(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.scenes = []
    this.inkPoints.clear()
    this.board?.setPlayback(null)
    this.latest.frame = null
    setSceneUiState(null)
    this.settleWaiters()
  }

  /** The board went away (unmount, another board): forget it without touching it. */
  detach(board: BoardHandle | null): void {
    if (board && board !== this.board) return
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.scenes = []
    this.inkPoints.clear()
    this.board = null
    this.latest.frame = null
    this.history.clear()
    setSceneUiState(null)
    clearSceneScript()
    this.settleWaiters()
  }

  private schedule(): void {
    if (this.frame !== null || !this.scenes.length) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.render()
      this.schedule()
    })
  }

  private timeOf(scene: Playing, now: number): number {
    if (scene.origin === null) return -1
    return scene.pausedAt ?? (now - scene.origin) / 1000
  }

  private stepNameAt(play: ScenePlay, t: number): string | null {
    let name: string | null = null
    for (const step of play.steps) if (step.at <= t + 1e-6) name = step.name
    return name
  }

  /** The learner started drawing: each playing scene pauses at its next step, or now when none is left. */
  private interrupt(now: number): void {
    for (const scene of this.scenes) {
      if (scene.origin === null || scene.pausedAt !== null || scene.pauseAt !== null) continue
      const t = this.timeOf(scene, now)
      const next = scene.play.steps.find((step) => step.at > t + 0.05)
      if (next) scene.pauseAt = next.at
      else this.pauseNow(scene, t, 'learner drawing')
    }
  }

  private pauseNow(scene: Playing, t: number, reason: ScenePauseReason): void {
    scene.pausedAt = Math.max(0, Math.min(scene.play.duration, t))
    scene.pauseAt = null
    scene.pausedBy = reason
    if (reason === 'learner drawing') {
      const step = scene.play.steps.find((entry) => Math.abs(entry.at - scene.pausedAt!) < 1e-6)?.name ?? this.stepNameAt(scene.play, scene.pausedAt)
      this.notes.push({ scene: scene.play.id, name: scene.play.name, step, t: Math.round(scene.pausedAt * 10) / 10, duration: scene.play.duration })
    }
  }

  /** Move on in each scene: start queued ones, stop at pauses, move the camera. */
  private advance(now: number): void {
    const board = this.board
    if (!board) return
    const state = board.liveState()
    if (state.drawing && !this.wasDrawing) this.interrupt(now)
    this.wasDrawing = state.drawing
    const keep: Playing[] = []
    for (const scene of this.scenes) {
      if (scene.origin === null) {
        const blocked = scene.mode === 'queue' && keep.some((other) => other.mode === 'queue')
        if (blocked) {
          keep.push(scene)
          continue
        }
        // Back to back: a scene that follows the one before starts at its exact end, so the pen goes on without a gap.
        const at = scene.mode === 'queue' && this.queueEnd !== null && now - this.queueEnd < HANDOFF_MS ? this.queueEnd : now
        scene.origin = at - scene.startAt * 1000
        scene.startedEpoch = Date.now()
        this.playLog.push({ scene: scene.play.id, start: Math.round(performance.timeOrigin + at), end: null })
        if (this.playLog.length > 200) this.playLog.splice(0, this.playLog.length - 200)
        scene.lastT = scene.startAt
      }
      let t = this.timeOf(scene, now)
      if (scene.pausedAt === null) {
        // A pause step, or the step where the learner's drawing pauses it.
        const steps = scene.play.steps
        for (let i = 0; i < steps.length; i++) {
          if (!steps[i].pause || scene.passed.has(i) || t < steps[i].at) continue
          scene.passed.add(i)
          this.pauseNow(scene, steps[i].at, 'pause step')
          t = steps[i].at
          break
        }
        if (scene.pausedAt === null && scene.pauseAt !== null && t >= scene.pauseAt) {
          this.pauseNow(scene, scene.pauseAt, 'learner drawing')
          t = scene.pausedAt as unknown as number
        }
      }
      // What starts between the last frame and now: camera moves.
      const from = scene.lastT
      if (t > from) {
        for (const move of scene.play.camera) {
          if (move.start < from || move.start >= t) continue
          // The learner moved the view during this scene: the scene's later camera moves are skipped.
          if (state.learnerViewAt > scene.startedEpoch) scene.cameraBlocked = true
          if (scene.cameraBlocked) continue
          board.animateTo({ center: move.center, zoom: clampZoom(move.zoom) }, Math.max(1, move.dur * 1000))
        }
        scene.lastT = t
      }
      if (scene.pausedAt === null && t >= scene.play.duration) {
        if (scene.mode === 'queue') this.queueEnd = (scene.origin as number) + scene.play.duration * 1000
        const logged = [...this.playLog].reverse().find((entry) => entry.scene === scene.play.id && entry.end === null)
        if (logged) logged.end = Math.round(performance.timeOrigin + (scene.origin as number) + scene.play.duration * 1000)
        continue
      }
      keep.push(scene)
    }
    this.scenes = keep
  }

  private render(): void {
    const board = this.board
    if (!board) {
      this.settleWaiters()
      return
    }
    const now = performance.now()
    this.advance(now)
    if (!this.scenes.length) {
      this.inkPoints.clear()
      board.setPlayback(null)
      this.latest.frame = null
      setSceneUiState(null)
      this.settleWaiters()
      return
    }
    const out: SceneFrame = { overrides: new Map(), tips: [], inks: [] }
    const clocks = new Map<string, { t: number; playing: boolean; step: string | null; end: number }>()
    // The nodes each scene's earlier scenes still animate (a later scene that carries one leaves it to them).
    const claimedBefore: Array<Set<string>> = []
    let claimed = new Set<string>()
    for (const scene of this.scenes) {
      claimedBefore.push(claimed)
      const t = this.timeOf(scene, now)
      const next = new Set(claimed)
      for (const object of scene.play.objects) if (object.ghost || t < object.settled) for (const target of object.targets) next.add(target.nodeId)
      claimed = next
    }
    // Later scenes first, so an earlier scene's look of a node it animates wins.
    for (let i = this.scenes.length - 1; i >= 0; i--) {
      const scene = this.scenes[i]
      const t = this.timeOf(scene, now)
      sceneFrame(scene.play, t, this.inkPoints, out, claimedBefore[i])
      const clock = { t, playing: scene.origin !== null && scene.pausedAt === null, step: this.stepNameAt(scene.play, t), end: scene.play.duration }
      for (const object of scene.play.objects) for (const target of object.targets) clocks.set(target.nodeId, clock)
    }
    const frame: PlaybackFrame = { overrides: out.overrides, ghosts: this.ghostList(this.scenes), tips: out.tips, inks: out.inks, clocks }
    this.latest.frame = frame
    board.setPlayback(frame)
    this.publish(now)
    this.settleWaiters()
  }

  private ghostCache: { key: string; list: PlaybackFrame['ghosts'] } = { key: '', list: [] }

  /** The same array while the set of scenes is the same (the board re-renders ghosts only when it changes). */
  private ghostList(scenes: Playing[]): PlaybackFrame['ghosts'] {
    const key = `${this.swaps}|${scenes.map((scene) => scene.play.id).join(',')}`
    if (key !== this.ghostCache.key) this.ghostCache = { key, list: scenes.flatMap((scene) => scene.play.ghosts) }
    return this.ghostCache.list
  }

  /** The scene that shows now: the first started one (a queued scene before the "now" ones). */
  private current(): Playing | null {
    return this.scenes.find((scene) => scene.origin !== null && scene.mode === 'queue') ?? this.scenes.find((scene) => scene.origin !== null) ?? null
  }

  private publish(now: number): void {
    const scene = this.current()
    if (!scene) {
      setSceneUiState(null)
      return
    }
    const t = this.timeOf(scene, now)
    const steps = scene.play.steps
    let stepIndex = -1
    steps.forEach((step, i) => {
      if (step.at <= t + 1e-6) stepIndex = i
    })
    let currentCue: SceneCueState | null = null
    for (const cue of scene.play.cues) {
      if (t < cue.at || t >= cue.at + cue.dur) continue
      const read = readAt(cue.text, t - cue.at, cue.dur)
      currentCue = { text: cue.text, at_s: cue.at, dur_s: cue.dur, readSoFar: read.text, progress: read.progress }
    }
    const lists = sceneLists(scene.play)
    setSceneUiState({
      playing: true,
      paused: scene.pausedAt !== null,
      sceneName: scene.play.name ?? scene.play.id,
      sceneOf: lists.of,
      stepName: stepIndex >= 0 ? steps[stepIndex].name : null,
      stepIndex,
      stepCount: steps.length,
      t: Math.round(Math.max(0, t) * 10) / 10,
      duration: scene.play.duration,
      queue: this.scenes.filter((entry) => entry.origin === null).length,
      currentCue,
      cues: lists.cues,
      steps: lists.steps,
      scenes: this.sceneEntries()
    })
  }

  private entriesCache: SceneListEntry[] = []

  /** The scenes that play or wait, for the UI store (the same array while they are the same). */
  private sceneEntries(): SceneListEntry[] {
    const next = this.scenes.map((scene) => sceneLists(scene.play))
    if (next.length !== this.entriesCache.length || next.some((entry, i) => entry !== this.entriesCache[i])) this.entriesCache = next
    return this.entriesCache
  }

  /**
   * The script panel's "Next step": the scene that shows goes to the start of
   * its next step and plays on (a pause step there stops it again); with no
   * next step, it ends and the next queued scene starts.
   */
  nextStep(): void {
    const scene = this.current()
    if (!scene) return
    const now = performance.now()
    const t = this.timeOf(scene, now)
    const next = scene.play.steps.find((step) => step.at > t + 0.05)
    if (next) {
      scene.play.steps.forEach((step, i) => {
        if (step.pause && step.at < next.at - 1e-6) scene.passed.add(i)
      })
      scene.origin = now - next.at * 1000
      scene.pausedAt = null
      scene.pauseAt = null
      scene.pausedBy = null
    } else {
      this.scenes = this.scenes.filter((entry) => entry !== scene)
      this.queueEnd = null
    }
    this.render()
    this.schedule()
  }

  /**
   * The script panel's restart and step replay: what plays and waits ends at
   * once (its items are on the board in their final state), then the scenes
   * play again in order, the first from the given step. False (and nothing
   * changes) when a scene can no longer be replayed (another stage started).
   */
  replayList(list: Array<{ scene: string; step?: string }>): boolean {
    const board = this.board
    if (!board || !list.length || !list.every((entry) => this.history.has(entry.scene))) return false
    this.scenes = []
    this.queueEnd = null
    list.forEach((entry, i) => this.replay(board, { scene: entry.scene, ...(i === 0 && entry.step ? { step: entry.step } : {}) }, 'queue'))
    return true
  }

  /** scene_control. */
  control(action: 'status' | 'pause' | 'resume' | 'stop' | 'skip'): SceneStatus {
    const now = performance.now()
    if (action === 'pause') {
      for (const scene of this.scenes) if (scene.origin !== null && scene.pausedAt === null) this.pauseNow(scene, this.timeOf(scene, now), 'scene_control pause')
    } else if (action === 'resume') {
      for (const scene of this.scenes) {
        if (scene.origin === null || scene.pausedAt === null) continue
        scene.origin = now - scene.pausedAt * 1000
        scene.lastT = scene.pausedAt
        scene.pausedAt = null
        scene.pauseAt = null
        scene.pausedBy = null
      }
    } else if (action === 'stop') {
      // The playing scenes jump to their end state; the next queued scene starts.
      this.scenes = this.scenes.filter((scene) => scene.origin === null)
      this.queueEnd = null
    } else if (action === 'skip') {
      const dropped = this.scenes.filter((scene) => scene.origin === null)
      this.scenes = this.scenes.filter((scene) => scene.origin !== null)
      // Their items were committed when they were sent: take them off again (newest first), as one undo step.
      const step = `skip-${performance.now()}`
      for (const scene of dropped.reverse()) {
        scene.revert(step)
        this.history.delete(scene.play.id)
      }
    }
    this.render()
    this.schedule()
    return this.status()
  }

  /** Seconds until this scene starts (pauses not counted); negative for a scene that plays now (its time so far). */
  startsIn(id: string): number {
    const now = performance.now()
    let wait = 0
    for (const scene of this.scenes) {
      if (scene.play.id === id) return Math.round((scene.origin === null ? wait : -this.timeOf(scene, now)) * 1000) / 1000
      if (scene.mode !== 'queue') continue
      if (scene.origin === null) wait += scene.play.duration - scene.startAt
      else wait += Math.max(0, scene.play.duration - (scene.pausedAt ?? (now - scene.origin) / 1000))
    }
    return 0
  }

  /** Take these scenes' items off the board again (newest first); they stay in the queue until swapped or dropped. */
  revertScenes(ids: string[], step: string): void {
    for (const scene of [...this.scenes].reverse()) if (ids.includes(scene.play.id)) scene.revert(step)
  }

  /** The scene ids that wait in the queue (not started), in order. */
  waiting(): string[] {
    return this.scenes.filter((scene) => scene.origin === null).map((scene) => scene.play.id)
  }

  /** The scene that plays now and its time, or null. */
  playing(): { id: string; t: number; duration: number; steps: ScenePlay['steps'] } | null {
    const scene = this.current()
    if (!scene) return null
    return { id: scene.play.id, t: Math.max(0, this.timeOf(scene, performance.now())), duration: scene.play.duration, steps: scene.play.steps }
  }

  /** Resolve when done() holds (checked every frame, and twice a second when frames stop, as in a hidden window). */
  private waitFor(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve()
    return new Promise((resolve) => {
      this.waiters.push({ done, resolve })
      this.waitTimer ??= setInterval(() => this.render(), 500)
    })
  }

  private settleWaiters(): void {
    if (!this.waiters.length) return
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.done()) return true
      waiter.resolve()
      return false
    })
    if (!this.waiters.length && this.waitTimer !== null) {
      clearInterval(this.waitTimer)
      this.waitTimer = null
    }
  }

  /** A started scene that stands paused (playback stops there until it is resumed), or null. */
  private pausedScene(): Playing | null {
    return this.scenes.find((scene) => scene.origin !== null && scene.pausedAt !== null) ?? null
  }

  /**
   * Resolves when this scene (and so every queued scene before it) has played
   * to its end (true), or when playback stops at a pause before that: a pause
   * step, the learner's drawing or scene_control pause (false; status() says
   * which). A scene that is not playing or waiting has ended.
   */
  async untilPlayed(id: string): Promise<boolean> {
    const gone = (): boolean => !this.scenes.some((scene) => scene.play.id === id)
    await this.waitFor(() => gone() || this.pausedScene() !== null)
    return gone()
  }

  /** Resolves when nothing plays or waits, or a scene stands paused (a pause step, the learner, scene_control pause). */
  untilIdleOrPaused(): Promise<void> {
    return this.waitFor(() => !this.scenes.length || this.pausedScene() !== null)
  }

  status(): SceneStatus {
    const now = performance.now()
    const scene = this.current()
    const t = scene ? this.timeOf(scene, now) : null
    const paused = this.pausedScene()
    return {
      playing: !!scene && scene.pausedAt === null,
      scene: scene?.play.id ?? null,
      name: scene?.play.name ?? null,
      t: t === null ? null : Math.round(Math.max(0, t) * 100) / 100,
      duration: scene?.play.duration ?? null,
      step: scene && t !== null ? this.stepNameAt(scene.play, t) : null,
      paused: !!scene && scene.pausedAt !== null,
      ...(paused ? { paused_by: paused.pausedBy ?? 'scene_control pause', paused_scene: paused.play.id, paused_step: this.stepNameAt(paused.play, paused.pausedAt as number), paused_t: Math.round((paused.pausedAt as number) * 100) / 100 } : {}),
      queue: this.scenes.filter((entry) => entry.origin === null).map((entry) => ({ scene: entry.play.id, name: entry.play.name, duration_s: entry.play.duration }))
    }
  }

  /** The board news: scenes that paused because the learner drew (each note once). */
  takeNotes(): ScenePauseNote[] {
    const out = this.notes
    this.notes = []
    return out
  }

  /** What the learner sees now, for a screenshot during playback; null when nothing plays. */
  snapshot(): { frame: PlaybackFrame; status: SceneStatus } | null {
    // The moment of now, not of the last animation frame: a window in the background gets no frames, so its last one can be old.
    this.render()
    if (!this.scenes.length || !this.latest.frame) return null
    return { frame: this.latest.frame, status: this.status() }
  }

  /** Dev: hold the current scene at time t (seconds), or let it run again with null. */
  seek(t: number | null): void {
    const scene = this.current() ?? this.scenes[this.scenes.length - 1]
    if (!scene) return
    const now = performance.now()
    if (scene.origin === null) {
      scene.origin = now
      scene.startedEpoch = Date.now()
    }
    if (t === null) {
      if (scene.pausedAt !== null) {
        scene.origin = now - scene.pausedAt * 1000
        scene.lastT = scene.pausedAt
      }
      scene.pausedAt = null
      scene.pausedBy = null
    } else {
      scene.pausedAt = Math.max(0, Math.min(scene.play.duration, t))
      scene.pausedBy = 'scene_control pause'
      // A seek passes the pause steps before it.
      scene.play.steps.forEach((step, i) => {
        if (step.pause && step.at <= scene.pausedAt!) scene.passed.add(i)
      })
      scene.lastT = scene.pausedAt
    }
    this.render()
    this.schedule()
  }

  /** Dev: the overrides of the last frame (node id → override), for the lab. */
  debugFrame(): Array<[string, NodeOverride]> {
    return this.latest.frame ? [...this.latest.frame.overrides] : []
  }

  /** Dev: end every scene now. */
  finish(): void {
    this.stopAll()
  }

  state(): ScenePlayerState {
    const scene = this.current()
    const time = scene ? this.timeOf(scene, performance.now()) : null
    return {
      playing: this.scenes.length > 0,
      current: scene ? scene.play.id : null,
      time: time === null ? null : Math.round(time * 1000) / 1000,
      duration: scene ? scene.play.duration : null,
      steps: scene ? scene.play.steps : [],
      paused: !!scene && scene.pausedAt !== null,
      queue: this.scenes.filter((entry) => entry.origin === null).length,
      played: this.playLog.slice(-100)
    }
  }
}

export const scenePlayer = new ScenePlayer()
