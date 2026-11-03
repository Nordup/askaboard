import { stepAt } from '@shared/scene-story'
import { isLive, type BoardNode, type InkNode, type InkPoint } from '@shared/board-format'
import { followedWorlds, renamedFollows, type NodeFollows } from '@shared/world-links'
import { SCENE_EASES, type SceneStatus } from '@shared/live-scene'
import type { SceneEvent } from '@shared/space-api'
import type { BoardHandle } from '../board/Board'
import { clampZoom } from '../board/geometry'
import { revealPoints, type NodeOverride, type PlaybackFrame, type PlaybackTip } from '../board/playback'
import type { Point } from '../board/types'
import { sceneColor, withOpacity } from './colors'
import { allObjects, sampleD, type DynSample, type PlayEdit, type PlayObject, type ScenePlay } from './compile'
import { BLEND_GAP, paramSamplesOf, paramsAtTime } from './params'
import { blendStyle } from '../board/style-edits'
import { setSceneUiActions, setSceneUiState, type SceneCueState, type SceneListEntry, type SceneStart } from './state'
import { addRestored, canRebuild, clearRestored, rebuildFailure, requestRebuild, type RestoredScene } from './rebuild'
import { followVoice, stopVoice, voicedLineAt } from './voice'
import { isIdentity, multiply, type Matrix } from './timeline'

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
 *
 * The work per frame is for what changes on screen only. Each scene is cut
 * into units (an object, the edits of one node, an item that html()
 * replaces, the items a replay hides). A unit has a span of time in which
 * its look changes: before the span it looks the same at every time, after
 * it it shows nothing (or, for an item that the scene removes, the same
 * look). The player evaluates a unit once when it enters a constant part,
 * and every frame only while it is in its span. A unit keeps the overrides
 * it wrote; an override that has the same values as in the frame before
 * stays the same object, so the board writes to the DOM only for nodes whose
 * override changed (PlaybackFrame.changed). The frame loop runs only while a
 * scene plays: a paused scene or a scene that waits behind it gets no frames.
 *
 * A scene's clock never passes what the scene has ready (ScenePlay.ready): the
 * whole scene holds there and goes on by itself (ScenePlayer.hold).
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
  /** performance.now() when its clock reached what is ready, while it stands there (see ScenePlayer.hold), else null. */
  heldSince: number | null
  /** Take its items off the board again; `step` joins that keyed undo step (Board agentCommit). */
  revert: (step?: string) => void
  /** The scene time it starts from (0, or a replayed step). */
  startAt: number
}

/** What paused a scene: a step with {pause: true}, the learner's drawing, or play_scene pause. */
export type ScenePauseReason = 'pause step' | 'learner drawing' | 'play_scene pause'

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
  /** The current scene's name (write_scene name). */
  name: string | null
  time: number | null
  duration: number | null
  steps: Array<{ name: string; at: number }>
  paused: boolean
  queue: number
  /** When the latest scenes started and ended (Date ms). */
  played: Array<{ scene: string; name: string | null; start: number; end: number | null }>
}

/** Ink points by node id, with their world offset, for pen tips. */
export type InkIndex = Map<string, { points: ReadonlyArray<readonly [number, number, number]>; offset: Point }>

/** The scene clock of a world. */
interface Clock {
  t: number
  playing: boolean
  step: string | null
  end: number
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))
/** The override of a node that waits hidden. Shared, so it is never changed. */
const HIDDEN: NodeOverride = Object.freeze({ opacity: 0 })

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

/**
 * What an object's live form reads at moment t, or null when it shows as
 * committed. Within what the sweep has reached, its samples; past it, or
 * before its first sample has come, its seeds. An object with no seeds does
 * not change at any seeded moment.
 */
export function liveSamples(play: ScenePlay, object: PlayObject, t: number): DynSample[] | null {
  const { dyn } = object
  if (!dyn || t >= dyn.end) return null
  const samples = t <= play.ready() && dyn.samples.length ? dyn.samples : dyn.seeds
  return samples.length ? samples : null
}

/** When an object's look ends: its own last action, and the last change of its live form (it moves when a stream ends, so a replay clone reads it too). */
function settledOf(object: PlayObject): number {
  const end = object.dyn?.end
  return end !== undefined && Number.isFinite(end) ? Math.max(object.settled, end) : object.settled
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
const NO_LINES = { xy: new Float64Array(0), ends: new Uint32Array(0) }
const r2 = (value: number): number => Math.round(value * 100) / 100

function blendD(a: DynSample, b: DynSample, k: number): string | undefined {
  if (k <= 0 || !a.numbers || !b.numbers || !a.parts || a.parts !== b.parts || a.numbers.length !== b.numbers.length) return sampleD(a)
  const an = a.numbers
  const bn = b.numbers
  const parts = a.parts
  let out = parts[0]
  for (let i = 0; i < an.length; i++) out += String(r2(lerp(an[i], bn[i], k))) + parts[i + 1]
  return out
}

/**
 * The geometry of a changing ink object's strokes of now, kept from frame to
 * frame (the player keeps one per object; a preview makes a new one per
 * moment). The ink nodes are the same objects in each frame, with new points.
 */
export interface InkBuffers {
  /** The blended lines of now (local points). */
  lines: Point[][]
  /** Per line: the length of the local line. */
  lineLengths: number[]
  strokes: Array<{ node: InkNode; world: InkPoint[]; lengths: Float64Array; tail: InkPoint }>
}

const newInkBuffers = (): InkBuffers => ({ lines: [], lineLengths: [], strokes: [] })

/**
 * The lines between two samples (into the buffers' lines), or the first
 * sample's lines when they do not blend (another number of strokes). Each
 * point of a stroke in `a` blends with the point of the same stroke in `b` at
 * the same share of the stroke's length. The stage puts the ink points on a
 * grid along the length, so the number of points changes when a length
 * crosses a grid step, also for a line whose length stays the same up to
 * rounding: the blend must not depend on equal counts, or the ink holds its
 * earlier sample and lags the shapes, which always blend. The lines in the
 * buffers are the only array form of a sample's strokes: a play holds them packed.
 */
function blendLines(a: DynSample, b: DynSample, k: number, buffers: InkBuffers): Point[][] {
  const al = a.lines ?? NO_LINES
  const bl = b.lines ?? NO_LINES
  const out = buffers.lines
  const count = al.ends.length
  out.length = count
  const ax = al.xy
  const blend = k > 0 && count === bl.ends.length
  for (let i = 0; i < count; i++) {
    const from = i ? al.ends[i - 1] : 0
    const length = al.ends[i] - from
    const into = (out[i] ??= [])
    into.length = length
    if (!blend) {
      for (let j = 0; j < length; j++) {
        const p = (into[j] ??= [0, 0])
        p[0] = ax[2 * (from + j)]
        p[1] = ax[2 * (from + j) + 1]
      }
      continue
    }
    const bx = bl.xy
    const otherFrom = i ? bl.ends[i - 1] : 0
    const otherLength = bl.ends[i] - otherFrom
    const lineX = (j: number): number => ax[2 * (from + j)]
    const lineY = (j: number): number => ax[2 * (from + j) + 1]
    const otherX = (j: number): number => bx[2 * (otherFrom + j)]
    const otherY = (j: number): number => bx[2 * (otherFrom + j) + 1]
    if (length === otherLength || otherLength < 2 || length < 2) {
      for (let j = 0; j < length; j++) {
        const q = Math.min(j, otherLength - 1)
        const p = (into[j] ??= [0, 0])
        p[0] = lerp(lineX(j), otherLength ? otherX(q) : lineX(j), k)
        p[1] = lerp(lineY(j), otherLength ? otherY(q) : lineY(j), k)
      }
      continue
    }
    // Another count: walk both strokes by length share.
    let totalA = 0
    for (let j = 1; j < length; j++) totalA += Math.hypot(lineX(j) - lineX(j - 1), lineY(j) - lineY(j - 1))
    let totalB = 0
    for (let j = 1; j < otherLength; j++) totalB += Math.hypot(otherX(j) - otherX(j - 1), otherY(j) - otherY(j - 1))
    let atA = 0
    let s = 1
    let before = 0
    let segment = Math.hypot(otherX(1) - otherX(0), otherY(1) - otherY(0))
    for (let j = 0; j < length; j++) {
      if (j > 0) atA += Math.hypot(lineX(j) - lineX(j - 1), lineY(j) - lineY(j - 1))
      const target = (totalA > 0 ? atA / totalA : j / (length - 1)) * totalB
      while (s < otherLength - 1 && before + segment < target) {
        before += segment
        s++
        segment = Math.hypot(otherX(s) - otherX(s - 1), otherY(s) - otherY(s - 1))
      }
      const last = j === length - 1
      const f = last ? 1 : segment > 0 ? Math.max(0, Math.min(1, (target - before) / segment)) : 1
      const from2 = last ? otherLength - 1 : s - 1
      const to2 = last ? from2 : s
      const qx = otherX(from2) + (otherX(to2) - otherX(from2)) * f
      const qy = otherY(from2) + (otherY(to2) - otherY(from2)) * f
      const p = (into[j] ??= [0, 0])
      p[0] = lerp(lineX(j), qx, k)
      p[1] = lerp(lineY(j), qy, k)
    }
  }
  return out
}

/**
 * The first `share` of a stroke's points, by length (as revealPoints in
 * playback.ts), into `out`. `lengths`: the cumulative length at each point.
 * The cut point goes into `tail`.
 */
function revealInto(points: InkPoint[], lengths: Float64Array, share: number, out: InkPoint[], tail: InkPoint): void {
  out.length = 0
  if (share >= 1 || points.length < 2) {
    for (const point of points) out.push(point)
    return
  }
  if (share <= 0) return
  const target = lengths[points.length - 1] * share
  out.push(points[0])
  for (let i = 1; i < points.length; i++) {
    if (lengths[i] <= target) {
      out.push(points[i])
      continue
    }
    const span = lengths[i] - lengths[i - 1] || 1
    const k = (target - lengths[i - 1]) / span
    const a = points[i - 1]
    const b = points[i]
    tail[0] = a[0] + (b[0] - a[0]) * k
    tail[1] = a[1] + (b[1] - a[1]) * k
    tail[2] = a[2] + (b[2] - a[2]) * k
    out.push(tail)
    break
  }
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
  let follows: NonNullable<PlaybackTip['follows']> = []
  for (const action of play.pointer) {
    if (action.start > t) break
    const k = action.dur > 0 ? SCENE_EASES.inOut(clamp01((t - action.start) / action.dur)) : 1
    if (action.to === null) {
      alpha = alpha * (1 - k)
      continue
    }
    const to = action.to as Point
    // What came before gives way to this glide; the glide that starts from nothing comes in with its point.
    const first = !(pos && alpha > 0.01)
    follows = first ? [] : follows.map((link) => ({ ...link, share: link.share * (1 - k) })).filter((link) => link.share > 0.001)
    if (typeof action.follows?.world === 'string') follows.push({ world: action.follows.world, point: action.follows.point, at: to, share: first ? 1 : k })
    // The first glide comes in from a little below and to the right, as a hand does.
    const from: Point = pos && alpha > 0.01 ? pos : [to[0] + 40, to[1] + 56]
    const fromAlpha = pos && alpha > 0.01 ? alpha : 0
    pos = [lerp(from[0], to[0], k), lerp(from[1], to[1], k)]
    alpha = lerp(fromAlpha, 1, Math.min(1, k * 2))
  }
  if (!pos || alpha <= 0.01) return null
  return { point: pos, color: sceneColor('accent').hex, size: 9, kind: 'pointer', alpha, ...(follows.length ? { follows } : {}) }
}

export interface SceneFrame {
  overrides: Map<string, NodeOverride>
  tips: PlaybackTip[]
  inks: BoardNode[]
}

/** Where the look of a part of a scene goes: overrides by node, pen tips, and ink that exists only now. */
interface LookSink {
  override(id: string, override: NodeOverride): void
  /** The override of a node so far in this look (for the pen tip on moved ink). */
  current(id: string): NodeOverride | undefined
  tip(tip: PlaybackTip): void
  ink(node: InkNode): void
}

/** True when a node an earlier scene still makes or animates (that scene shows it until it is done). */
type ClaimedBefore = (nodeId: string) => boolean

/**
 * One object's look at scene time t. Nothing when it shows as committed
 * (after its last action, unless the scene removes it).
 */
function objectLook(play: ScenePlay, object: PlayObject, t: number, inkIndex: InkIndex | null, sink: LookSink, claimed?: ClaimedBefore, buffers?: InkBuffers): void {
  const timeline = play.timeline
  const desc = timeline.object(object.id)
  if (t >= settledOf(object) && !object.ghost && t >= desc.created) return
  // Its board items stay as they are until the sweep or a preview's seeds show it changes.
  if (desc.unchanged && !object.dyn?.samples.length && !object.dyn?.seeds.length) return
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
  const samples = t >= 0 || desc.carry ? liveSamples(play, object, t) : null
  const dyn = samples ? object.dyn : undefined
  const now = samples ? locate(samples, t) : null
  if (dyn && now && (dyn.kind === 'text' || dyn.kind === 'live')) world = multiply(world, boxMatrix(dyn.finalBounds, now.a.bounds, dyn.centered, dyn.kind === 'live'))

  // Changing ink: the strokes of now, painted on their own; the committed strokes wait hidden.
  if (dyn && now && dyn.kind === 'ink' && dyn.ink) {
    // A carried object that an earlier scene still makes or animates: that scene shows it until it is done.
    if (desc.carry && t < 0 && claimed && object.targets.some((target) => claimed(target.nodeId))) return
    const own = buffers ?? newInkBuffers()
    const lines = blendLines(now.a, now.b, now.k, own)
    const lengths = own.lineLengths
    lengths.length = lines.length
    let total = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let length = 0
      for (let j = 1; j < line.length; j++) length += Math.hypot(line[j][0] - line[j - 1][0], line[j][1] - line[j - 1][1])
      lengths[i] = length
      total += length
    }
    total ||= 1
    let at = 0
    const shown = before || (draw <= 0 && fill <= 0) ? 0 : clamp01(timeline.number(object.id, 'opacity', t))
    const inkColor = withOpacity(color ?? dyn.ink.color, shown)
    // The width blends as a shape's stroke width does.
    const ownWidth = now.a.width === undefined ? dyn.ink.width : now.k > 0 && now.b.width !== undefined ? lerp(now.a.width, now.b.width, now.k) : now.a.width
    const width = ownWidth * Math.sqrt(Math.abs(world[0] * world[3] - world[1] * world[2]))
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const share = clamp01((draw * total - at) / (lengths[i] || 1))
      at += lengths[i]
      if (share <= 0 || line.length < 2 || shown <= 0) continue
      const stroke = (own.strokes[i] ??= {
        node: { id: `${play.id}:${object.id}:${i}`, kind: 'ink', x: 0, y: 0, z: 0, author: 'agent', seq: 0, tool: dyn.ink.tool, color: inkColor, width, points: [] } as unknown as InkNode,
        world: [],
        lengths: new Float64Array(0),
        tail: [0, 0, 0.5]
      })
      // The stroke in world points, and its length at each point.
      const points = stroke.world
      points.length = line.length
      if (stroke.lengths.length < line.length) stroke.lengths = new Float64Array(Math.max(line.length, stroke.lengths.length * 2))
      const cumulative = stroke.lengths
      for (let j = 0; j < line.length; j++) {
        const [x, y] = line[j]
        const p = (points[j] ??= [0, 0, 0.5])
        p[0] = world[0] * x + world[2] * y + world[4]
        p[1] = world[1] * x + world[3] * y + world[5]
        p[2] = 0.5
        cumulative[j] = j === 0 ? 0 : cumulative[j - 1] + Math.hypot(p[0] - points[j - 1][0], p[1] - points[j - 1][1])
      }
      const node = stroke.node as InkNode & { points: InkPoint[] }
      revealInto(points, cumulative, share, node.points, stroke.tail)
      if (node.points.length < 2) continue
      node.tool = dyn.ink.tool
      node.color = inkColor
      node.width = width
      sink.ink(node)
      const end = node.points[node.points.length - 1]
      if (drawing && share < 1 && share > 0) sink.tip({ point: [end[0], end[1]], color: color ?? object.tipColor, size: dyn.ink.width })
    }
    for (const target of object.targets) sink.override(target.nodeId, HIDDEN)
    return
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
      else if (dyn.kind === 'live' && samples) override.params = paramsAtTime(paramSamplesOf(samples), t, BLEND_GAP) ?? undefined
    }
    if (override.matrix || override.opacity !== undefined || override.reveal !== undefined || override.fill !== undefined || override.color || override.d !== undefined || override.html !== undefined || override.params) {
      sink.override(target.nodeId, override)
    }
    // The pen tip on a vector outline being drawn now.
    if (drawing && !tipDone && !before && !target.ink && target.tipLines && target.tipLength && draw > 0 && draw < 1 && !dyn) {
      const point = tipOnLines(target.tipLines, draw, target.tipLength)
      if (point) {
        sink.tip({ point: [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]], color: color ?? object.tipColor, size: target.tipWidth ?? 3 })
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
        const override = sink.current(target.nodeId)
        const point: Point = [entry.offset[0] + end[0], entry.offset[1] + end[1]]
        const m = override?.matrix
        sink.tip({ point: m ? [m[0] * point[0] + m[2] * point[1] + m[4], m[1] * point[0] + m[3] * point[1] + m[5]] : point, color: override?.color ?? object.tipColor, size: target.tipWidth ?? 3 })
      }
    }
  }
}

/** edit(): an edited node shows its text and styles of the moment (the board holds the end state). `list`: its edits in time order. */
function editLook(nodeId: string, list: readonly PlayEdit[], t: number, sink: LookSink): void {
  const last = list[list.length - 1]
  if (t >= last.at + last.dur && list.every((edit) => t >= edit.at + edit.dur)) return
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
  if (override.html !== undefined || override.color || override.style) sink.override(nodeId, override)
}

/** A scene's edits by node, in the order the nodes are first edited (made once per play). */
const editCache = new WeakMap<ScenePlay, Array<[string, PlayEdit[]]>>()
function editsByNode(play: ScenePlay): Array<[string, PlayEdit[]]> {
  let groups = editCache.get(play)
  if (!groups) {
    const byNode = new Map<string, PlayEdit[]>()
    for (const edit of play.edits ?? []) {
      const list = byNode.get(edit.nodeId)
      if (list) list.push(edit)
      else byNode.set(edit.nodeId, [edit])
    }
    groups = [...byNode]
    editCache.set(play, groups)
  }
  return groups
}

/** Set a node's override; fields already set for it (by a later scene) stay unless this scene sets them too. */
function setOverride(out: SceneFrame, id: string, override: NodeOverride): void {
  const earlier = out.overrides.get(id)
  out.overrides.set(id, earlier ? { ...earlier, ...override } : override)
}

/**
 * One scene's look at scene time t: overrides for its nodes, pen tips, the
 * pointer, and ink that exists only now (changing ink). A negative t is a
 * scene that has not started: what it makes is hidden, what it changes shows
 * as before the scene. (Previews draw single moments with it; the player
 * evaluates the same looks part by part, see ScenePlayer.)
 */
export function sceneFrame(play: ScenePlay, t: number, inkIndex: InkIndex | null, out: SceneFrame): void {
  const sink: LookSink = {
    override: (id, override) => setOverride(out, id, override),
    current: (id) => out.overrides.get(id),
    tip: (tip) => out.tips.push(tip),
    ink: (node) => out.inks.push(node)
  }
  // A replay hides the items that changed since the scene: their look of then shows as ghosts.
  if (play.hidden && t <= play.duration) for (const id of play.hidden) setOverride(out, id, HIDDEN)
  // An item that html() replaces shows until the new material appears.
  if (play.vanish) for (const entry of play.vanish) if (t >= entry.at) for (const id of entry.ids) setOverride(out, id, HIDDEN)
  for (const object of allObjects(play)) objectLook(play, object, t, inkIndex, sink)
  for (const [nodeId, list] of editsByNode(play)) editLook(nodeId, list, t, sink)
  const pointer = pointerAt(play, t)
  if (pointer) out.tips.push(pointer)
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
  /** What a replay needs to rebuild it (run.ts sceneMemory) when its stream was cut. Scenes of a board with no record have none. */
  record?: RestoredScene
}

/** Its stream was cut, so a new run can give what it lacks. A stream that failed is whole as far as it can be: a replay reads it. */
function cutShort(play: ScenePlay): boolean {
  const stop = play.stopped()
  return stop !== null && !stop.failed
}

// ---------- Overrides that stay the same object while their values stay the same ----------

const sameRecord = (a: Readonly<Record<string, number | string>> | undefined, b: Readonly<Record<string, number | string>> | undefined): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

const sameMatrix = (a: NodeOverride['matrix'], b: NodeOverride['matrix']): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false
  return true
}

/** True when two overrides show the same look. */
function sameOverride(a: NodeOverride, b: NodeOverride): boolean {
  return (
    a.opacity === b.opacity &&
    a.reveal === b.reveal &&
    a.fill === b.fill &&
    a.color === b.color &&
    a.d === b.d &&
    a.strokeWidth === b.strokeWidth &&
    a.html === b.html &&
    sameMatrix(a.matrix, b.matrix) &&
    sameRecord(a.params, b.params) &&
    sameRecord(a.style, b.style)
  )
}

/**
 * The overrides of the frame, from the looks of all parts of all scenes. A
 * part sets a node's override at its rank; a higher rank sets its fields
 * over a lower one's (the order in which the scenes' looks are merged). A
 * node with one part shows that part's override object itself.
 */
class OverrideStore {
  /** The frame's overrides: the same map from frame to frame. */
  readonly merged = new Map<string, NodeOverride>()
  private readonly parts = new Map<string, Array<{ rank: number; value: NodeOverride }>>()
  private readonly dirty = new Set<string>()

  set(id: string, rank: number, value: NodeOverride | null): void {
    let list = this.parts.get(id)
    const at = list ? list.findIndex((part) => part.rank === rank) : -1
    if (value) {
      if (!list) this.parts.set(id, (list = []))
      if (at >= 0) list[at].value = value
      else {
        let i = list.length
        while (i > 0 && list[i - 1].rank > rank) i--
        list.splice(i, 0, { rank, value })
      }
    } else if (list && at >= 0) {
      list.splice(at, 1)
      if (!list.length) this.parts.delete(id)
    } else return
    this.dirty.add(id)
  }

  /** Merge the nodes whose parts changed; adds to `changed` the nodes whose override changed. */
  flush(changed: Set<string>): void {
    for (const id of this.dirty) {
      const list = this.parts.get(id)
      const next = !list ? undefined : list.length === 1 ? list[0].value : Object.assign({}, ...list.map((part) => part.value))
      if (next === this.merged.get(id)) continue
      if (next) this.merged.set(id, next)
      else this.merged.delete(id)
      changed.add(id)
    }
    this.dirty.clear()
  }

  clear(): void {
    this.merged.clear()
    this.parts.clear()
    this.dirty.clear()
  }
}

// ---------- A scene, part by part ----------

/**
 * A part of a scene whose look is evaluated as one: an object, the edits of
 * one node, an item that html() replaces, or the items a replay hides.
 * Before `from` its look is the same at every time; from `to` on it shows
 * nothing, or (`persist`) the same look at every time.
 */
interface Unit {
  rank: number
  from: number
  to: number
  persist: boolean
  /** Its look depends on the other scenes (a carried changing ink object while its scene waits): evaluated in every frame. */
  usesClaimed: boolean
  look: (t: number, sink: LookSink) => void
  /** The overrides it wrote at its last evaluation. */
  written: Map<string, NodeOverride>
  tips: PlaybackTip[]
  inks: InkNode[]
}

/** Ranks inside a scene: the hidden items, the items html() replaces, the objects, the edits (as sceneFrame merges them). */
const RANK_VANISH = 1
const RANK_OBJECT = 1_000
const RANK_EDIT = 5_000_000
/** The rank distance between two scenes. */
const RANK_SCENE = 10_000_000

/** The time when an object's look starts to change (before it, the object looks the same at every time). */
function objectFrom(play: ScenePlay, object: PlayObject): number {
  const desc = play.timeline.object(object.id)
  let from = play.timeline.firstChange(object.id)
  if (object.glide) from = Math.min(from, object.glide.start)
  const dyn = object.dyn
  if (dyn) {
    // A carried changing ink object waits for the scenes before it (claimed), so it is evaluated at every time.
    if (desc.carry && dyn.kind === 'ink') return Number.NEGATIVE_INFINITY
    // Its first sample can still be on the way.
    from = Math.min(from, dyn.samples[0]?.t ?? 0)
    // A changing object shows its samples from scene time 0 (a carried one also before).
    if (!desc.carry) from = Math.min(from, 0)
  }
  return from
}

/** The time from which an object's look stays the same (or it shows as committed). */
function objectTo(object: PlayObject, play: ScenePlay): number {
  let to = Math.max(settledOf(object), play.timeline.object(object.id).created)
  if (object.ghost) {
    if (object.dyn) to = Math.max(to, object.dyn.end)
    if (object.glide) to = Math.max(to, object.glide.start + object.glide.dur)
  }
  return to
}

class SceneRun {
  /** The units in order of `from`. */
  private readonly units: Unit[]
  /** The units in their span now, in rank order. */
  private active: Unit[] = []
  /** The first unit (in order of `from`) that has not entered its span. */
  private next = 0
  /** The scene time of the last update (null: none yet). */
  private t: number | null = null
  private readonly scratch = new Map<string, NodeOverride>()
  private current: Unit | null = null
  private readonly sink: LookSink
  /** The objects that show each node (for later scenes: does this scene still make or animate it?). */
  private readonly byNode = new Map<string, PlayObject[]>()
  /** The live items it plays (they get its clock). */
  readonly liveTargets: string[]
  clock: Clock | null = null

  constructor(
    readonly play: ScenePlay,
    inkIndex: InkIndex,
    claimed: ClaimedBefore,
    liveIds: ReadonlySet<string>,
    /** Ghosts of this scene that an earlier scene holds too: they show that scene's look until it ends (ghostList). */
    lent: ReadonlySet<string>
  ) {
    const scratch = this.scratch
    this.sink = {
      override: (id, override) => {
        if (lent.has(id)) return
        const earlier = scratch.get(id)
        scratch.set(id, earlier ? { ...earlier, ...override } : override)
      },
      current: (id) => scratch.get(id),
      tip: (tip) => this.current?.tips.push(tip),
      ink: (node) => this.current?.inks.push(node)
    }
    const units: Unit[] = []
    const unit = (rank: number, from: number, to: number, persist: boolean, look: Unit['look'], usesClaimed = false): void => {
      units.push({ rank, from, to, persist, usesClaimed, look, written: new Map(), tips: [], inks: [] })
    }
    const hidden = play.hidden
    if (hidden?.length) unit(0, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, false, (t, sink) => {
      if (t <= play.duration) for (const id of hidden) sink.override(id, HIDDEN)
    })
    play.vanish?.forEach((entry, i) =>
      unit(RANK_VANISH + i, entry.at, entry.at, true, (t, sink) => {
        if (t >= entry.at) for (const id of entry.ids) sink.override(id, HIDDEN)
      })
    )
    const shown = allObjects(play)
    shown.forEach((object, i) => {
      const from = objectFrom(play, object)
      const buffers = object.dyn?.kind === 'ink' ? newInkBuffers() : undefined
      unit(RANK_OBJECT + i, from, objectTo(object, play), object.ghost, (t, sink) => objectLook(play, object, t, inkIndex, sink, claimed, buffers), from === Number.NEGATIVE_INFINITY)
      for (const target of object.targets) {
        const list = this.byNode.get(target.nodeId)
        if (list) list.push(object)
        else this.byNode.set(target.nodeId, [object])
      }
    })
    editsByNode(play).forEach(([nodeId, list], i) => {
      const from = Math.min(...list.map((edit) => edit.at))
      const to = Math.max(...list.map((edit) => edit.at + edit.dur))
      unit(RANK_EDIT + i, from, to, false, (t, sink) => editLook(nodeId, list, t, sink))
    })
    this.units = units.sort((a, b) => a.from - b.from)
    this.liveTargets = [...new Set(shown.flatMap((object) => object.targets.map((target) => target.nodeId)).filter((id) => liveIds.has(id)))]
  }

  /** True when an object of this scene still makes or animates the node at scene time t. */
  claims(nodeId: string, t: number): boolean {
    return this.byNode.get(nodeId)?.some((object) => object.ghost || t < settledOf(object)) ?? false
  }

  /** Bring the scene's look to scene time t: the store gets the overrides that changed. */
  update(t: number, rankBase: number, store: OverrideStore): void {
    if (this.t !== null && t === this.t) {
      // The same moment: only the units that depend on other scenes can change.
      for (const unit of this.active) if (unit.usesClaimed) this.evaluate(unit, t, rankBase, store)
      return
    }
    if (this.t === null || t < this.t) {
      // The first update, or back in time: sort every unit again.
      this.active = []
      this.next = 0
      for (const unit of this.units) {
        if (t < unit.from) this.evaluate(unit, t, rankBase, store)
        else {
          this.next++
          if (t >= unit.to) this.finish(unit, t, rankBase, store)
          else this.active.push(unit)
        }
      }
      this.active.sort((a, b) => a.rank - b.rank)
    } else {
      // Forward: the units whose span starts now join.
      while (this.next < this.units.length && this.units[this.next].from <= t) {
        const unit = this.units[this.next++]
        if (t >= unit.to) this.finish(unit, t, rankBase, store)
        else {
          let i = this.active.length
          while (i > 0 && this.active[i - 1].rank > unit.rank) i--
          this.active.splice(i, 0, unit)
        }
      }
    }
    this.t = t
    let keep = 0
    for (const unit of this.active) {
      if (t >= unit.to) {
        this.finish(unit, t, rankBase, store)
        continue
      }
      this.evaluate(unit, t, rankBase, store)
      this.active[keep++] = unit
    }
    this.active.length = keep
  }

  /** The pen tips and the ink of now, in the order of the units. */
  collect(tips: PlaybackTip[], inks: BoardNode[]): void {
    for (const unit of this.active) {
      for (const tip of unit.tips) tips.push(tip)
      for (const node of unit.inks) inks.push(node)
    }
  }

  private finish(unit: Unit, t: number, rankBase: number, store: OverrideStore): void {
    if (unit.persist) {
      this.evaluate(unit, t, rankBase, store)
      return
    }
    for (const id of unit.written.keys()) store.set(id, rankBase + unit.rank, null)
    unit.written.clear()
    unit.tips.length = 0
    unit.inks.length = 0
  }

  private evaluate(unit: Unit, t: number, rankBase: number, store: OverrideStore): void {
    const scratch = this.scratch
    scratch.clear()
    unit.tips.length = 0
    unit.inks.length = 0
    this.current = unit
    unit.look(t, this.sink)
    this.current = null
    const rank = rankBase + unit.rank
    for (const [id, override] of scratch) {
      const before = unit.written.get(id)
      if (before && sameOverride(before, override)) continue
      unit.written.set(id, override)
      store.set(id, rank, override)
    }
    for (const id of unit.written.keys()) {
      if (scratch.has(id)) continue
      unit.written.delete(id)
      store.set(id, rank, null)
    }
    scratch.clear()
  }
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
      steps: play.steps.map((step) => ({ name: step.name, at_s: step.at, ...(step.pause ? { pause: true } : {}), ...(step.lead ? { lead: true } : {}), lines: step.lines ?? [] })),
      items: playItems(play)
    }
    listCache.set(play, lists)
  }
  return lists
}

/** A queued scene that starts within this long of the one before it ends starts exactly at that end (no gap, no overlap). */
const HANDOFF_MS = 250
/** The longest wait of the clock's tick while a scene plays (the voice and the scene panel follow the clock at least this often). */
const WAKE_MS = 250
const NO_CLOCKS: ReadonlyMap<string, Clock> = new Map()

/** A scene's playback event for the session trace (main/trace.ts scene_event). Never throws. */
function report(kind: SceneEvent['kind'], play: ScenePlay, outcome?: SceneEvent['outcome'], t = Date.now(), ms?: number): void {
  try {
    window.space?.sceneEvent?.({ kind, scene: play.id, name: play.name ?? null, t: Math.round(t), ...(outcome ? { outcome } : {}), ...(ms !== undefined ? { ms: Math.round(ms) } : {}) })
  } catch {
    // The trace is for measures only.
  }
}

export class ScenePlayer {
  private board: BoardHandle | null = null
  private scenes: Playing[] = []
  private frame: number | null = null
  /**
   * The clock's own tick: one timer at the next scene event (an end, a pause step, a line, a camera move), at most WAKE_MS away.
   * A display frame does not come while the window is covered (Wayland sends a covered window no frame callbacks, a Mac
   * throttles it), and a scene must still end, the queue go on and the voice follow. Painting stays on the display frame.
   */
  private wake: ReturnType<typeof setTimeout> | null = null
  private inkPoints: InkIndex = new Map()
  private wasDrawing = false
  private notes: ScenePauseNote[] = []
  private latest: { frame: PlaybackFrame | null } = { frame: null }
  /** performance.now() when the last queued scene reached its end. */
  private queueEnd: number | null = null
  private history = new Map<string, SceneMemory>()
  /** The scenes that a replay or a preview holds, with the count of those that hold each (keepPlay, freePlay). */
  private holds = new Map<string, number>()
  /** How many scenes were in `scenes` after the last move on: fewer now means that scenes stopped playing. */
  private inPlay = 0
  /** Called when scenes lose what kept their play data over the budget: a hold ended, or they stopped playing. */
  private free: () => void = () => undefined
  private replays = 0
  /** Bumped when a scene's play changes in place (swap, a later commit that changes an earlier play): the runs are made again. */
  private epoch = 0
  /** When each scene started and ended on the clock (Date ms; for the lab's hand-off measures). */
  private playLog: Array<{ scene: string; name: string | null; start: number; end: number | null }> = []
  /** Scenes that started since the last frame went to the board: their first frame is reported when it is presented. */
  private firstFrames: ScenePlay[] = []
  /** The scenes as parts (one run per scene, in the order of `scenes`), and what they were made for. */
  private runs: SceneRun[] = []
  private runsFor: { scenes: Playing[]; epoch: number } = { scenes: [], epoch: -1 }
  private readonly store = new OverrideStore()
  /** performance.now() of the frame being made (later scenes ask whether an earlier scene still claims a node). */
  private frameNow = 0
  private clocks: ReadonlyMap<string, Clock> = NO_CLOCKS
  /** What the board got last: to send a frame only when something changed. */
  private sent: { tips: number; inks: number; ghosts: PlaybackFrame['ghosts'] | null; clocks: ReadonlyMap<string, Clock> | null } = { tips: 0, inks: 0, ghosts: null, clocks: null }

  constructor() {
    setSceneUiActions({
      pause: () => void this.control('pause'),
      resume: () => void this.control('resume'),
      nextStep: () => this.nextStep(),
      replay: (list) => this.replayList(list),
      playFrom: (scene, from) => this.playFrom(scene, from),
      // Main's failure state comes first (rebuild.ts mirrors it): play data never overrides it.
      canReplay: (scene) => !rebuildFailure(scene) && (this.history.has(scene) || canRebuild(scene)),
      time: () => {
        const scene = this.current()
        return scene ? Math.max(0, this.timeOf(scene, performance.now())) : null
      }
    })
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
      heldSince: null,
      revert: options.revert,
      startAt
    })
    const state = board.liveState()
    for (const [id, entry] of inkIndexOf(play, state.nodes, state.layout())) this.inkPoints.set(id, entry)
    this.render()
    this.schedule()
    return Math.round(startsIn * 1000) / 1000
  }

  /** The board the player works on, before a scene plays on it (a stage restored from the records: run.ts sceneRestore). Another board ends what plays and forgets the history. */
  adopt(board: BoardHandle): void {
    if (board === this.board) return
    this.stopAll()
    this.history.clear()
    this.board = board
  }

  /** Keep a committed scene for replay (also one a replay rebuilt from the records after a restart: run.ts sceneMemory). */
  remember(memory: SceneMemory): void {
    this.history.set(memory.play.id, memory)
  }

  /** The bytes of the frames that the replay history holds. */
  heldBytes(): number {
    let bytes = 0
    for (const memory of this.history.values()) bytes += memory.play.size()
    return bytes
  }

  /** A replay or a preview needs these scenes soon: release leaves them until freePlay, whatever their size. */
  keepPlay(ids: readonly string[]): void {
    for (const id of ids) this.holds.set(id, (this.holds.get(id) ?? 0) + 1)
  }

  freePlay(ids: readonly string[]): void {
    for (const id of ids) {
      const count = this.holds.get(id) ?? 0
      if (count > 1) this.holds.set(id, count - 1)
      else this.holds.delete(id)
    }
    this.free()
  }

  /** The owner of the scene budget (run.ts) trims when protection ends: at the end of a hold, and when scenes stop playing. */
  onFree(listener: () => void): void {
    this.free = listener
  }

  /**
   * Give up the play data of finished scenes, the oldest first, for at least
   * `bytes`. From now on a replay rebuilds them, as restored scenes (decision
   * B22). What plays, waits or is held now stays, and so does a scene with no record. Returns the bytes freed.
   */
  release(bytes: number): number {
    let freed = 0
    for (const [id, memory] of this.history) {
      if (freed >= bytes) break
      if (!memory.record || this.holds.has(id) || this.scenes.some((scene) => scene.play.id === id || scene.play.id.startsWith(`${id}~r`))) continue
      this.history.delete(id)
      addRestored(memory.record)
      freed += memory.play.size()
    }
    return freed
  }

  /** A stream was cut: the scenes of it are no longer held, so a replay never reads a partial stream. It rebuilds them (requestRebuild, main/mcp.ts playable). What plays now plays on. */
  forgetCut(): void {
    for (const [id, memory] of this.history) {
      if (!cutShort(memory.play)) continue
      this.history.delete(id)
      if (memory.record) addRestored(memory.record)
    }
  }

  /** The stage started new: earlier scenes can no longer be replayed. */
  resetStage(): void {
    this.history.clear()
  }

  /** A scene that was committed again (replace, cut): the new play takes its place, keeping its place in the queue and its clock. */
  swap(board: BoardHandle, id: string, play: ScenePlay, revert: (step?: string) => void, why: 'cut' | 'replaced' = 'replaced'): boolean {
    const scene = this.scenes.find((entry) => entry.play.id === id)
    if (!scene) return false
    report('replaced', play, why)
    scene.play = play
    scene.revert = revert
    this.epoch++
    const state = board.liveState()
    for (const [nodeId, entry] of inkIndexOf(play, state.nodes, state.layout())) this.inkPoints.set(nodeId, entry)
    this.render()
    this.schedule()
    return true
  }

  /** Take a scene out of the queue, waiting or playing, and forget it (its items are already off the board, or as a restage left them). */
  drop(id: string): void {
    for (const scene of this.scenes) if (scene.play.id === id) report('end', scene.play, 'cancelled')
    this.scenes = this.scenes.filter((scene) => scene.play.id !== id)
    this.history.delete(id)
    this.render()
    // A queued scene behind the dropped one may start now: it needs the frame and the clock's tick.
    this.schedule()
  }

  /** When scenes started and ended on the clock (Date ms), oldest first (list_items's "last played"). */
  playedLog(): ReadonlyArray<{ scene: string; name: string | null; start: number; end: number | null }> {
    return this.playLog
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
  replay(board: BoardHandle, target: { scene?: string; step?: string | number; at?: number }, mode: 'queue' | 'now'): { scene: string; of: string; from: number; starts_in_s: number } | { error: string } {
    let memory: SceneMemory | undefined
    let from = 0
    if (target.scene) {
      memory = this.history.get(target.scene)
      if (!memory) return { error: `The board's player no longer holds this scene (the window reloaded or the board was opened again), so it cannot be replayed.` }
      if (target.at !== undefined) from = Math.max(0, Math.min(memory.play.duration, target.at))
      else if (target.step !== undefined) {
        const steps = memory.play.steps
        const step = typeof target.step === 'number' ? steps[target.step - 1] : steps.find((entry) => entry.name === target.step)
        if (!step) return { error: `The scene "${memory.play.name ?? target.scene}" has no step ${typeof target.step === 'number' ? target.step : `"${target.step}"`}. Its steps: ${steps.map((entry, i) => `${i + 1} "${entry.name}"`).join(', ') || 'none'}.` }
        from = step.at
      }
    } else if (typeof target.step === 'string') {
      for (const entry of [...this.history.values()].reverse()) {
        const step = entry.play.steps.find((s) => s.name === target.step)
        if (step) {
          memory = entry
          from = step.at
          break
        }
      }
      if (!memory) return { error: `No scene of this stage has a step "${target.step}".` }
    } else return { error: 'replay needs name, or from_step as a step name.' }
    // The scene that plays last goes last when the history must shrink.
    this.history.delete(memory.play.id)
    this.history.set(memory.play.id, memory)
    const clone = this.replayClone(board, memory, `${memory.play.id}~r${++this.replays}`)
    const startsIn = this.enqueue(board, clone, { mode, revert: () => undefined, startAt: from })
    return { scene: clone.id, of: memory.play.id, from, starts_in_s: startsIn }
  }

  /**
   * A scene as it was committed, to play (replay) or to draw at a moment
   * (preview_scene): items it made or changed that are different now are
   * ghosts with their look of then, over the hidden current items.
   */
  replayClone(board: BoardHandle, memory: SceneMemory, id: string): ScenePlay {
    const play = memory.play
    const present = new Map(board.liveState().nodes.map((node) => [node.id, node]))
    const ghosts: BoardNode[] = []
    const hidden: string[] = []
    const remap = new Map<string, string>()
    for (const object of allObjects(play)) {
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
    // What follows a world that shows as it was follows that world: such an item is a ghost too.
    for (const object of allObjects(play)) {
      for (const t of object.targets) {
        const snap = memory.snapshot.get(t.nodeId)
        const follows = (snap?.ghost as { follows?: NodeFollows } | undefined)?.follows
        if (!snap || !follows || remap.has(t.nodeId) || !followedWorlds(follows).some((world) => remap.has(world))) continue
        const ghostId = `${id}:${t.nodeId}`
        remap.set(t.nodeId, ghostId)
        ghosts.push({ ...snap.ghost, id: ghostId } as BoardNode)
        if (present.has(t.nodeId)) hidden.push(t.nodeId)
      }
    }
    const rename = (node: string): string => remap.get(node) ?? node
    const relinked = ghosts.map((node) => {
      const follows = (node as { follows?: NodeFollows }).follows
      return follows ? ({ ...node, follows: renamedFollows(follows, rename) } as BoardNode) : node
    })
    const moved = <T extends { follows?: { world: number | string; point: string } }>(action: T): T => (typeof action.follows?.world === 'string' ? { ...action, follows: { ...action.follows, world: rename(action.follows.world) } } : action)
    // dyn stays shared: a clone of a scene that streams reads the same stream.
    const clone = (object: PlayObject): PlayObject => ({ ...object, targets: object.targets.map((t) => (remap.has(t.nodeId) ? { ...t, nodeId: remap.get(t.nodeId) as string } : t)) })
    return { ...play, id, objects: play.objects.map(clone), quiet: play.quiet.map(clone), ghosts: [...play.ghosts, ...relinked], hidden, pointer: play.pointer.map(moved), camera: play.camera.map(moved) }
  }

  /** Seconds until a scene added now to the queue would start. */
  private queueWait(): number {
    const now = performance.now()
    let wait = 0
    for (const scene of this.scenes) {
      if (scene.mode !== 'queue') continue
      if (scene.origin === null) wait += scene.play.duration - scene.startAt
      else wait += Math.max(0, scene.play.duration - this.timeOf(scene, now))
    }
    return wait
  }

  /** Earlier scenes that show a node: a later scene that changes it shifts their overrides (run.ts, then playsChanged). */
  playingScenes(): ScenePlay[] {
    return this.scenes.map((scene) => scene.play)
  }

  /** A scene waits in a pause. */
  paused(): boolean {
    return this.scenes.some((scene) => scene.pausedAt !== null)
  }

  /** The seconds of frames ahead of the clock, for the scenes that run or wait to start. Infinity: none needs more. */
  sweepLead(): number {
    const now = performance.now()
    let lead = Number.POSITIVE_INFINITY
    for (const scene of this.scenes) if (scene.pausedAt === null) lead = Math.min(lead, scene.play.ready() - (scene.origin === null ? 0 : this.timeOf(scene, now)))
    return lead
  }

  /** The plays of the playing scenes changed in place (run.ts after a later commit): evaluate them again from the start. */
  playsChanged(): void {
    this.epoch++
  }

  /** End every scene at once (a board switch): items stay in their final state. */
  stopAll(): void {
    this.unschedule()
    for (const scene of this.scenes) report('end', scene.play, 'removed')
    this.scenes = []
    this.inkPoints.clear()
    this.dropRuns()
    this.board?.setPlayback(null)
    this.latest.frame = null
    this.idle()
  }

  /** The board went away (unmount, another board): forget it without touching it. */
  detach(board: BoardHandle | null): void {
    if (board && board !== this.board) return
    this.unschedule()
    for (const scene of this.scenes) report('end', scene.play, 'removed')
    this.scenes = []
    this.inkPoints.clear()
    this.dropRuns()
    this.board = null
    this.latest.frame = null
    this.history.clear()
    // The restored scenes were for that board.
    clearRestored()
    this.idle()
  }

  /**
   * A frame on the next display frame, and the clock's tick at the next scene event, while a scene plays (not while every
   * started scene is paused, or nothing plays). Both run render(), and render() is a function of the clock: each event
   * happens once, whichever runs first (an ended scene leaves `scenes`, a started one has its origin, a passed pause step
   * is in `passed`, a camera move starts in (lastT, t], the voice follows the clock).
   */
  private schedule(): void {
    if (!this.scenes.some((scene) => scene.origin !== null && scene.pausedAt === null)) {
      this.unschedule()
      return
    }
    if (this.frame === null) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null
        this.render()
        this.schedule()
      })
    }
    if (this.wake !== null) clearTimeout(this.wake)
    this.wake = setTimeout(() => {
      this.wake = null
      this.render()
      this.schedule()
    }, this.nextEventIn(performance.now()))
  }

  private unschedule(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    if (this.wake !== null) clearTimeout(this.wake)
    this.wake = null
  }

  /** Milliseconds to the next event of a running scene (its end, a pause step, a line's start or end, a camera move), at most WAKE_MS. */
  private nextEventIn(now: number): number {
    let next = WAKE_MS / 1000
    const at = (t: number, event: number): void => {
      if (event > t) next = Math.min(next, event - t)
    }
    for (const scene of this.scenes) {
      if (scene.origin === null || scene.pausedAt !== null || scene.heldSince !== null) continue
      const t = this.timeOf(scene, now)
      const play = scene.play
      at(t, play.duration)
      if (scene.pauseAt !== null) at(t, scene.pauseAt)
      for (const step of play.steps) if (step.pause) at(t, step.at)
      for (const cue of play.cues) {
        at(t, cue.at)
        at(t, cue.at + cue.dur)
      }
      for (const move of play.camera) at(t, move.start)
    }
    // A little after the event, so the clock stands at or past it when the timer runs.
    return Math.max(0, Math.ceil(next * 1000) + 2)
  }

  /** The scene clock. Every consumer reads this one, so all of a scene stops together when it holds. */
  private timeOf(scene: Playing, now: number): number {
    if (scene.origin === null) return -1
    return Math.min(scene.pausedAt ?? (now - scene.origin) / 1000, this.holdAt(scene), scene.play.duration)
  }

  /**
   * Where the clock stands when it holds: at what the scene has ready, or at
   * the time it shows already (lastT), when a seek or a replay from a step
   * put it ahead of the stream. A hold never moves the clock back: the board
   * shows the seek time from the seeds (liveSamples) until the samples reach it.
   */
  private holdAt(scene: Playing): number {
    return Math.max(scene.play.ready(), scene.lastT)
  }

  /**
   * The clock stands at holdAt, and goes on by itself when more is ready. A
   * hold is not a pause, and it is no mode: it comes from the clock, ready()
   * and the time shown alone, so a pause, a resume or a seek owes it nothing.
   * While it holds, origin moves with the wall clock, so time goes on from the
   * held time with no jump. A scene that has all it needs (ready at its end or
   * after) never holds, and ends at its exact time.
   */
  private hold(scene: Playing, now: number): void {
    const ready = scene.play.ready()
    const at = this.holdAt(scene)
    if ((scene.pausedAt ?? (now - (scene.origin as number)) / 1000) >= at && ready < scene.play.duration) {
      scene.origin = now - at * 1000
      scene.heldSince ??= now
    } else if (scene.heldSince !== null) {
      report('hold', scene.play, undefined, performance.timeOrigin + scene.heldSince, now - scene.heldSince)
      scene.heldSince = null
    }
  }

  /** Its clock moves: it has started, is not paused and does not hold. What follows the clock reads this (worlds, the voice), not the published pause, which misses a hold. */
  private advancing(scene: Playing): boolean {
    return scene.origin !== null && scene.pausedAt === null && scene.heldSince === null
  }

  /** True while this scene is on the board and its clock holds (a camera glide of the scene stands with it). */
  private held(scene: Playing): boolean {
    return scene.heldSince !== null && this.scenes.includes(scene)
  }

  private stepNameAt(play: ScenePlay, t: number): string | null {
    return play.steps[stepAt(play.steps, t)]?.name ?? null
  }

  /** The scene ends at `at` (performance.now() time): the queue goes on from there, and the log and the trace get its end. */
  private ended(scene: Playing, at: number): void {
    if (scene.mode === 'queue') this.queueEnd = at
    const logged = [...this.playLog].reverse().find((entry) => entry.scene === scene.play.id && entry.end === null)
    if (logged) logged.end = Math.round(performance.timeOrigin + at)
    report('end', scene.play, 'played', performance.timeOrigin + at)
    // A mark that a scene put around a part of a world stays on that part.
    for (const object of scene.play.objects) {
      if (scene.play.timeline.object(object.id).api === 'around') for (const target of object.targets) this.board?.pinMark(target.nodeId, 'agent')
    }
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
        this.playLog.push({ scene: scene.play.id, name: scene.play.name ?? null, start: Math.round(performance.timeOrigin + at), end: null })
        if (this.playLog.length > 200) this.playLog.splice(0, this.playLog.length - 200)
        this.firstFrames.push(scene.play)
        scene.lastT = scene.startAt
      }
      this.hold(scene, now)
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
          // A move to a point of a world goes on following it until the scene ends.
          const link = move.follows
          const follow = typeof link?.world === 'string' ? (): Point | null => (this.scenes.includes(scene) ? (board.worldPoint(link.world as string, link.point) ?? move.center) : null) : undefined
          board.animateTo({ center: move.center, zoom: clampZoom(move.zoom) }, Math.max(1, move.dur * 1000), () => this.held(scene), follow)
        }
        scene.lastT = t
      }
      if (scene.pausedAt === null && t >= scene.play.duration) {
        this.ended(scene, (scene.origin as number) + scene.play.duration * 1000)
        continue
      }
      keep.push(scene)
    }
    this.scenes = keep
  }

  private dropRuns(): void {
    this.runs = []
    this.runsFor = { scenes: [], epoch: -1 }
    this.store.clear()
    this.clocks = NO_CLOCKS
    this.sent = { tips: 0, inks: 0, ghosts: null, clocks: null }
  }

  /** The runs for the scenes of now; made again when the scenes or their plays changed (then every node may have changed: true). */
  private syncRuns(board: BoardHandle): boolean {
    const was = this.runsFor
    if (was.epoch === this.epoch && was.scenes.length === this.scenes.length && was.scenes.every((scene, i) => scene === this.scenes[i])) return false
    this.store.clear()
    const state = board.liveState()
    const liveIds = new Set<string>()
    for (const node of state.nodes) if (isLive(node)) liveIds.add(node.id)
    for (const scene of this.scenes) for (const node of scene.play.ghosts) if (isLive(node)) liveIds.add(node.id)
    const held = new Set<string>()
    this.runs = this.scenes.map((scene, i) => {
      const lent = new Set(scene.play.ghosts.filter((node) => held.has(node.id)).map((node) => node.id))
      for (const node of scene.play.ghosts) held.add(node.id)
      // The nodes that the scenes before this one still make or animate (a carried changing ink object leaves them to those scenes).
      const claimed: ClaimedBefore = (nodeId) => {
        for (let j = 0; j < i; j++) if (this.runs[j].claims(nodeId, this.timeOf(this.scenes[j], this.frameNow))) return true
        return false
      }
      return new SceneRun(scene.play, this.inkPoints, claimed, liveIds, lent)
    })
    this.runsFor = { scenes: [...this.scenes], epoch: this.epoch }
    return true
  }

  private render(): void {
    const board = this.board
    if (!board) {
      return
    }
    const now = performance.now()
    this.advance(now)
    const stopped = this.scenes.length < this.inPlay
    this.inPlay = this.scenes.length
    if (stopped) this.free()
    if (!this.scenes.length) {
      this.firstFrames = []
      this.inkPoints.clear()
      this.dropRuns()
      board.setPlayback(null)
      this.latest.frame = null
      this.idle()
      return
    }
    this.frameNow = now
    const full = this.syncRuns(board)
    const count = this.scenes.length
    // Later scenes merge first, so an earlier scene's look of a node it animates wins (a higher rank).
    for (let i = 0; i < count; i++) this.runs[i].update(this.timeOf(this.scenes[i], now), (count - 1 - i) * RANK_SCENE, this.store)
    const changed = new Set<string>()
    this.store.flush(changed)
    const tips: PlaybackTip[] = []
    const inks: BoardNode[] = []
    for (let i = count - 1; i >= 0; i--) {
      const t = this.timeOf(this.scenes[i], now)
      this.runs[i].collect(tips, inks)
      const pointer = pointerAt(this.scenes[i].play, t)
      if (pointer) tips.push(pointer)
    }
    const ghosts = this.ghostList()
    const clocks = this.clocksNow(now)
    const sent = this.sent
    const same = !full && changed.size === 0 && !tips.length && !sent.tips && !inks.length && !sent.inks && ghosts === sent.ghosts && clocks === sent.clocks
    const frame: PlaybackFrame = { overrides: this.store.merged, changed: full ? null : changed, ghosts, tips, inks, clocks }
    this.latest.frame = frame
    if (!same) {
      this.sent = { tips: tips.length, inks: inks.length, ghosts, clocks }
      board.setPlayback(frame)
    }
    if (this.firstFrames.length) {
      // The frame is presented before the next animation frame starts: that is when the learner sees the scene's first frame.
      const started = this.firstFrames
      this.firstFrames = []
      requestAnimationFrame(() => {
        for (const play of started) report('first_frame', play)
      })
    }
    this.publish(now)
  }

  /** The scene clock of each live item a scene plays; the same map while no clock changed. */
  private clocksNow(now: number): ReadonlyMap<string, Clock> {
    let changed = false
    let any = false
    this.scenes.forEach((scene, i) => {
      const run = this.runs[i]
      if (!run.liveTargets.length) return
      any = true
      const t = this.timeOf(scene, now)
      const playing = this.advancing(scene)
      const step = this.stepNameAt(scene.play, t)
      const end = scene.play.duration
      const was = run.clock
      if (was && was.t === t && was.playing === playing && was.step === step && was.end === end) return
      run.clock = { t, playing, step, end }
      changed = true
    })
    if (!any) return (this.clocks = NO_CLOCKS)
    if (!changed && this.clocks !== NO_CLOCKS) return this.clocks
    // Later scenes first, so an earlier scene's clock of a node wins.
    const clocks = new Map<string, Clock>()
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const run = this.runs[i]
      if (run.clock) for (const id of run.liveTargets) clocks.set(id, run.clock)
    }
    return (this.clocks = clocks)
  }

  private ghostCache: { key: string; list: PlaybackFrame['ghosts'] } = { key: '', list: [] }

  /**
   * The same array while the set of scenes is the same (the board re-renders ghosts only when it changes). One ghost per node:
   * replays of a scene share what it removed. The earliest scene that holds a ghost shows it, and a later one takes it when that scene ends (SceneRun lent).
   */
  private ghostList(): PlaybackFrame['ghosts'] {
    const key = `${this.epoch}|${this.scenes.map((scene) => scene.play.id).join(',')}`
    if (key !== this.ghostCache.key) {
      const byId = new Map<string, BoardNode>()
      for (const scene of this.scenes) for (const node of scene.play.ghosts) if (!byId.has(node.id)) byId.set(node.id, node)
      this.ghostCache = { key, list: [...byId.values()] }
    }
    return this.ghostCache.list
  }

  /** The scene that shows now: the first started one (a queued scene before the "now" ones). */
  private current(): Playing | null {
    return this.scenes.find((scene) => scene.origin !== null && scene.mode === 'queue') ?? this.scenes.find((scene) => scene.origin !== null) ?? null
  }

  private publish(now: number): void {
    const scene = this.current()
    if (!scene) {
      this.idle()
      return
    }
    const t = this.timeOf(scene, now)
    const steps = scene.play.steps
    const stepIndex = stepAt(steps, t)
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
      pausedBy: scene.pausedAt !== null ? (scene.pausedBy ?? 'play_scene pause') : null,
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
    // One voice: the newest scene with a line now, at its own clock (a "now" scene over a queued one), else the scene that shows.
    const speaker = [...this.scenes].reverse().find((entry) => entry.origin !== null && voicedLineAt(entry.play.cues, this.timeOf(entry, now))) ?? scene
    followVoice(speaker.play.cues, this.timeOf(speaker, now), this.advancing(speaker))
  }

  /** No scene shows: the panel and the voice go quiet together. */
  private idle(): void {
    if (this.wake !== null) clearTimeout(this.wake)
    this.wake = null
    setSceneUiState(null)
    stopVoice()
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
      this.ended(scene, now)
    }
    this.render()
    this.schedule()
  }

  /** The panel's step bar, step replay and line clicks: the scene that shows goes to the start of the step (or to the time) and plays on (its pause steps after it hold again); another committed scene is replayed from there. */
  playFrom(sceneOf: string, from: SceneStart): boolean {
    const scene = this.current()
    if (scene && scene.play.id.replace(/~r\d+$/, '') === sceneOf && !cutShort(scene.play)) {
      const at = from.at !== undefined ? Math.max(0, Math.min(scene.play.duration, from.at)) : scene.play.steps[from.step - 1]?.at
      if (at === undefined) return false
      const now = performance.now()
      scene.passed.clear()
      scene.play.steps.forEach((entry, i) => {
        if (entry.pause && entry.at < at - 1e-6) scene.passed.add(i)
      })
      scene.origin = now - at * 1000
      scene.pausedAt = null
      scene.pauseAt = null
      scene.pausedBy = null
      // The time cursor goes back with the clock, so the camera moves from the step on run again (as on a replay), and a learner's earlier view change no longer blocks them.
      scene.lastT = at
      scene.cameraBlocked = false
      scene.startedEpoch = Date.now()
      this.render()
      this.schedule()
      return true
    }
    return this.replayList([{ scene: sceneOf, ...from }])
  }

  /**
   * The script panel's restart and step replay: what plays and waits ends at
   * once (its items are on the board in their final state), then the scenes
   * play again in order, the first from the given step. False (and nothing
   * changes) when a scene can no longer be replayed (another stage started).
   */
  replayList(list: Array<{ scene: string } & Partial<SceneStart>>): boolean {
    const board = this.board
    if (!board || !list.length) return false
    if (list.some((entry) => rebuildFailure(entry.scene))) return false
    if (!list.every((entry) => this.history.has(entry.scene))) {
      // Scenes restored from the records (after a restart): main runs their programs again first (rebuild.ts), then they play.
      if (!list.every((entry) => this.history.has(entry.scene) || canRebuild(entry.scene))) return false
      const scenes = list.map((entry) => entry.scene)
      this.keepPlay(scenes)
      void requestRebuild(scenes.filter((id) => !this.history.has(id))).then(() => {
        if (this.board === board && list.every((entry) => this.history.has(entry.scene))) this.replayList(list)
        this.freePlay(scenes)
      })
      return true
    }
    // Held until all of them are in the queue: what stops playing here frees room while later scenes of the list still wait for their turn.
    const scenes = list.map((entry) => entry.scene)
    this.keepPlay(scenes)
    this.scenes = []
    this.queueEnd = null
    list.forEach((entry, i) => this.replay(board, { scene: entry.scene, ...(i === 0 && entry.at !== undefined ? { at: entry.at } : i === 0 && entry.step ? { step: entry.step } : {}) }, 'queue'))
    this.freePlay(scenes)
    return true
  }

  /** play_scene's playback actions. */
  control(action: 'status' | 'pause' | 'resume' | 'stop' | 'skip'): SceneStatus {
    const now = performance.now()
    if (action === 'pause') {
      for (const scene of this.scenes) if (scene.origin !== null && scene.pausedAt === null) this.pauseNow(scene, this.timeOf(scene, now), 'play_scene pause')
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
      for (const scene of this.scenes) if (scene.origin !== null) report('end', scene.play, 'stopped')
      this.scenes = this.scenes.filter((scene) => scene.origin === null)
      this.queueEnd = null
    } else if (action === 'skip') {
      const dropped = this.scenes.filter((scene) => scene.origin === null)
      this.scenes = this.scenes.filter((scene) => scene.origin !== null)
      // Their items were committed when they were sent: take them off again (newest first), as one undo step.
      const step = `skip-${performance.now()}`
      for (const scene of dropped.reverse()) {
        report('end', scene.play, 'cancelled')
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
      else wait += Math.max(0, scene.play.duration - this.timeOf(scene, now))
    }
    return 0
  }

  /** The player holds this scene: it waits, plays, or is in the stage's history. */
  isKnown(id: string): boolean {
    return this.history.has(id) || this.scenes.some((scene) => scene.play.id === id)
  }

  /** A committed scene of the current stage, by id (for preview_scene). */
  memory(id: string): SceneMemory | undefined {
    return this.history.get(id)
  }

  /** The scene ids that wait in the queue (not started), in order. */
  waiting(): string[] {
    return this.scenes.filter((scene) => scene.origin === null).map((scene) => scene.play.id)
  }

  /** The scene that plays now and its time, or null. */
  playing(): { id: string; name: string | null; t: number; duration: number; steps: ScenePlay['steps'] } | null {
    const scene = this.current()
    if (!scene) return null
    return { id: scene.play.id, name: scene.play.name ?? null, t: Math.max(0, this.timeOf(scene, performance.now())), duration: scene.play.duration, steps: scene.play.steps }
  }

  /** A started scene that stands paused (playback stops there until it is resumed), or null. */
  private pausedScene(): Playing | null {
    return this.scenes.find((scene) => scene.origin !== null && scene.pausedAt !== null) ?? null
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
      ...(scene && scene.heldSince !== null ? { held: true } : {}),
      ...(paused ? { paused_by: paused.pausedBy ?? 'play_scene pause', paused_scene: paused.play.id, paused_name: paused.play.name ?? null, paused_step: this.stepNameAt(paused.play, paused.pausedAt as number), paused_t: Math.round((paused.pausedAt as number) * 100) / 100 } : {}),
      queue: this.scenes.filter((entry) => entry.origin === null).map((entry) => ({ scene: entry.play.id, name: entry.play.name, duration_s: entry.play.duration }))
    }
  }

  /** The board news: scenes that paused because the learner drew (each note once). */
  takeNotes(): ScenePauseNote[] {
    const out = this.notes
    this.notes = []
    return out
  }

  /**
   * What the learner sees now, for a screenshot during playback; null when
   * nothing plays. A copy: the player changes its own frame in place.
   */
  snapshot(): { frame: PlaybackFrame; status: SceneStatus } | null {
    // The moment of now, not of the last animation frame: a window in the background gets no frames, so its last one can be old.
    this.render()
    const frame = this.latest.frame
    if (!this.scenes.length || !frame) return null
    const inks = (frame.inks ?? []).map((node) => ({ ...node, points: (node as InkNode).points.map((point) => [point[0], point[1], point[2]]) }) as BoardNode)
    return { frame: { ...frame, overrides: new Map(frame.overrides), changed: null, tips: [...frame.tips], inks }, status: this.status() }
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
      scene.pausedBy = 'play_scene pause'
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
      name: scene ? (scene.play.name ?? null) : null,
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
