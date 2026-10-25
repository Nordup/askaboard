import type { BoardNode, InkNode, InkPoint } from '@shared/board-format'
import type { SceneStatus } from '@shared/live-scene'
import type { BoardHandle } from '../board/Board'
import { clampZoom } from '../board/geometry'
import { revealPoints, type NodeOverride, type PlaybackFrame, type PlaybackTip } from '../board/playback'
import type { Point } from '../board/types'
import { sceneColor, withOpacity } from './colors'
import type { DynSample, PlayObject, ScenePlay } from './compile'
import { setSceneUiActions, setSceneUiState, type SceneCueState } from './state'
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
 * It speaks its lines (say) when speech is on, moves the learner's view
 * (camera) until the learner moves it, and shows a pointer (point).
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
  speak: boolean
  voice: string | null
  /** Undo its commit (skip). */
  revert: () => void
  /** The cue being spoken and how far (word events). */
  spoken: { index: number; chars: number } | null
}

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
    if (t >= a.start && t < a.start + a.dur && typeof a.to === 'number' && a.to > (typeof a.from === 'number' ? a.from : 0)) return true
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
export function sceneFrame(play: ScenePlay, t: number, inkIndex: InkIndex | null, out: SceneFrame): void {
  const timeline = play.timeline
  for (const object of play.objects) {
    const desc = timeline.object(object.id)
    if (t >= object.settled && !object.ghost && t >= desc.created) continue
    const before = desc.kind !== 'node' && desc.vis === 'shown' && t < desc.created
    const draw = clamp01(timeline.number(object.id, 'draw', t))
    const fill = clamp01(timeline.number(object.id, 'fill', t))
    const opacity = before ? 0 : clamp01(timeline.number(object.id, 'opacity', t)) / object.finalOpacity
    let world = timeline.matrix(object.id, t)
    const colorChanging = timeline.hasTrack(object.id, 'color')
    const color = colorChanging ? timeline.color(object.id, t) : undefined
    const drawing = object.drawn && drawingNow(play, object, t)
    const dyn = object.dyn && t < object.dyn.end && t >= 0 ? object.dyn : undefined
    const now = dyn ? locate(dyn.samples, t) : null
    if (dyn && now && (dyn.kind === 'text' || dyn.kind === 'live')) world = multiply(world, boxMatrix(dyn.finalBounds, now.a.bounds, dyn.centered, dyn.kind === 'live'))

    // Changing ink: the strokes of now, painted on their own; the committed strokes wait hidden.
    if (dyn && now && dyn.kind === 'ink' && dyn.ink) {
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
      for (const target of object.targets) out.overrides.set(target.nodeId, { opacity: 0 })
      continue
    }

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
      if (dyn && now) {
        if (dyn.kind === 'shape') {
          override.d = blendD(now.a, now.b, now.k)
          if (now.a.width !== undefined) override.strokeWidth = now.k > 0 && now.b.width !== undefined ? lerp(now.a.width, now.b.width, now.k) : now.a.width
        } else if (dyn.kind === 'text' && now.a.html !== undefined) override.html = now.a.html
        else if (dyn.kind === 'live') override.params = blendParams(now.a, now.b, now.k)
      }
      if (override.matrix || override.opacity !== undefined || override.reveal !== undefined || override.fill !== undefined || override.color || override.d !== undefined || override.html !== undefined || override.params) {
        out.overrides.set(target.nodeId, override)
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

/** Speak a line with the system voice. */
function speakLine(text: string, voiceName: string | null, onBoundary: (chars: number) => void): void {
  if (typeof speechSynthesis === 'undefined') return
  const utterance = new SpeechSynthesisUtterance(text)
  const voices = speechSynthesis.getVoices()
  const voice =
    (voiceName && (voices.find((v) => v.name === voiceName) ?? voices.find((v) => v.name.startsWith(voiceName.replace(/\s*\(.*\)$/, ''))))) ||
    voices.find((v) => v.lang === 'en-US' && v.localService) ||
    voices.find((v) => v.lang.startsWith('en'))
  if (voice) utterance.voice = voice
  utterance.lang = voice?.lang ?? 'en-US'
  utterance.onboundary = (event) => onBoundary(event.charIndex + (event.charLength ?? 0))
  // Checked 2026-10-25 (Electron, macOS): getVoices() lists the system voices, speaking is true during a line, and onstart/onboundary/onend fire.
  const asked = performance.now()
  utterance.onstart = () => console.info(`speech: start after ${Math.round(performance.now() - asked)} ms: ${text.slice(0, 40)}`)
  utterance.onend = () => console.info(`speech: end after ${Math.round(performance.now() - asked)} ms`)
  utterance.onerror = (event) => console.warn(`speech: ${event.error}: ${text.slice(0, 40)}`)
  speechSynthesis.speak(utterance)
}

/**
 * Load the system voice before a scene's first line (a silent utterance): a
 * cold voice starts its first line 0.3 to 0.8 s late. Called when run_scene
 * starts (sceneContext), seconds before the scene plays.
 */
export function warmSpeech(): void {
  if (typeof speechSynthesis === 'undefined' || speechSynthesis.speaking) return
  const utterance = new SpeechSynthesisUtterance(' ')
  utterance.volume = 0
  speechSynthesis.speak(utterance)
}

function stopSpeech(): void {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}

export class ScenePlayer {
  private board: BoardHandle | null = null
  private scenes: Playing[] = []
  private frame: number | null = null
  private inkPoints: InkIndex = new Map()
  private wasDrawing = false
  private notes: ScenePauseNote[] = []
  private latest: { frame: PlaybackFrame | null } = { frame: null }

  constructor() {
    setSceneUiActions({ pause: () => void this.control('pause'), resume: () => void this.control('resume') })
  }

  /**
   * Add a scene: it plays now (mode "now", or nothing ahead of it), or after
   * the queued scenes ahead of it. Returns the seconds until it starts (pauses
   * not counted).
   */
  enqueue(board: BoardHandle, play: ScenePlay, options: { mode: 'queue' | 'now'; speak: boolean; voice: string | null; revert: () => void }): number {
    if (board !== this.board) this.stopAll()
    this.board = board
    const startsIn = options.mode === 'now' ? 0 : this.queueWait()
    this.scenes.push({
      play,
      mode: options.mode,
      origin: null,
      pausedAt: null,
      pauseAt: null,
      lastT: 0,
      passed: new Set(),
      startedEpoch: 0,
      cameraBlocked: false,
      speak: options.speak,
      voice: options.voice,
      revert: options.revert,
      spoken: null
    })
    const state = board.liveState()
    for (const [id, entry] of inkIndexOf(play, state.nodes, state.layout())) this.inkPoints.set(id, entry)
    this.render()
    this.schedule()
    return Math.round(startsIn * 1000) / 1000
  }

  /** Seconds until a scene added now to the queue would start. */
  private queueWait(): number {
    const now = performance.now()
    let wait = 0
    for (const scene of this.scenes) {
      if (scene.mode !== 'queue') continue
      if (scene.origin === null) wait += scene.play.duration
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
    stopSpeech()
    this.board?.setPlayback(null)
    this.latest.frame = null
    setSceneUiState(null)
  }

  /** The board went away (unmount, another board): forget it without touching it. */
  detach(board: BoardHandle | null): void {
    if (board && board !== this.board) return
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.scenes = []
    this.inkPoints.clear()
    stopSpeech()
    this.board = null
    this.latest.frame = null
    setSceneUiState(null)
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
      else this.pauseNow(scene, t, true)
    }
  }

  /** keepSpeech: a pause step lets the line being spoken end (it ends at the step on the timeline, give or take the voice's lag). */
  private pauseNow(scene: Playing, t: number, byLearner: boolean, keepSpeech = false): void {
    scene.pausedAt = Math.max(0, Math.min(scene.play.duration, t))
    scene.pauseAt = null
    if (!keepSpeech) stopSpeech()
    scene.spoken = null
    if (byLearner) {
      const step = scene.play.steps.find((entry) => Math.abs(entry.at - scene.pausedAt!) < 1e-6)?.name ?? this.stepNameAt(scene.play, scene.pausedAt)
      this.notes.push({ scene: scene.play.id, name: scene.play.name, step, t: Math.round(scene.pausedAt * 10) / 10, duration: scene.play.duration })
    }
  }

  /** Move on in each scene: start queued ones, stop at pauses, speak, move the camera. */
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
        scene.origin = now
        scene.startedEpoch = Date.now()
        scene.lastT = 0
      }
      let t = this.timeOf(scene, now)
      if (scene.pausedAt === null) {
        // A pause step, or the step where the learner's drawing pauses it.
        const steps = scene.play.steps
        for (let i = 0; i < steps.length; i++) {
          if (!steps[i].pause || scene.passed.has(i) || t < steps[i].at) continue
          scene.passed.add(i)
          this.pauseNow(scene, steps[i].at, false, true)
          t = steps[i].at
          break
        }
        if (scene.pausedAt === null && scene.pauseAt !== null && t >= scene.pauseAt) {
          this.pauseNow(scene, scene.pauseAt, true)
          t = scene.pausedAt as unknown as number
        }
      }
      // What starts between the last frame and now: spoken lines and camera moves.
      const from = scene.lastT
      if (t > from) {
        scene.play.cues.forEach((cue, index) => {
          if (cue.at < from || cue.at >= t || !scene.speak) return
          scene.spoken = { index, chars: 0 }
          speakLine(cue.text, scene.voice, (chars) => {
            if (scene.spoken && scene.spoken.index === index) scene.spoken.chars = chars
          })
        })
        for (const move of scene.play.camera) {
          if (move.start < from || move.start >= t) continue
          // The learner moved the view during this scene: the scene's later camera moves are skipped.
          if (state.learnerViewAt > scene.startedEpoch) scene.cameraBlocked = true
          if (scene.cameraBlocked) continue
          board.animateTo({ center: move.center, zoom: clampZoom(move.zoom) }, Math.max(1, move.dur * 1000))
        }
        scene.lastT = t
      }
      if (scene.pausedAt === null && t > scene.play.duration + 0.05) continue
      keep.push(scene)
    }
    this.scenes = keep
  }

  private render(): void {
    const board = this.board
    if (!board) return
    const now = performance.now()
    this.advance(now)
    if (!this.scenes.length) {
      this.inkPoints.clear()
      board.setPlayback(null)
      this.latest.frame = null
      setSceneUiState(null)
      return
    }
    const out: SceneFrame = { overrides: new Map(), tips: [], inks: [] }
    const clocks = new Map<string, { t: number; playing: boolean; step: string | null; end: number }>()
    // Later scenes first, so an earlier scene's look of a node it animates wins.
    for (let i = this.scenes.length - 1; i >= 0; i--) {
      const scene = this.scenes[i]
      const t = this.timeOf(scene, now)
      sceneFrame(scene.play, t, this.inkPoints, out)
      const clock = { t, playing: scene.origin !== null && scene.pausedAt === null, step: this.stepNameAt(scene.play, t), end: scene.play.duration }
      for (const object of scene.play.objects) for (const target of object.targets) clocks.set(target.nodeId, clock)
    }
    const frame: PlaybackFrame = { overrides: out.overrides, ghosts: this.ghostList(this.scenes), tips: out.tips, inks: out.inks, clocks }
    this.latest.frame = frame
    board.setPlayback(frame)
    this.publish(now)
  }

  private ghostCache: { key: string; list: PlaybackFrame['ghosts'] } = { key: '', list: [] }

  /** The same array while the set of scenes is the same (the board re-renders ghosts only when it changes). */
  private ghostList(scenes: Playing[]): PlaybackFrame['ghosts'] {
    const key = scenes.map((scene) => scene.play.id).join(',')
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
    scene.play.cues.forEach((cue, index) => {
      if (t >= cue.at && t < cue.at + cue.dur) {
        let spoken: string | undefined
        if (scene.spoken && scene.spoken.index === index && scene.spoken.chars > 0) spoken = cue.text.slice(0, scene.spoken.chars)
        else {
          const words = cue.text.split(/(\s+)/)
          const share = (t - cue.at) / Math.max(0.001, cue.dur)
          const count = Math.ceil((words.length / 2) * share)
          let seen = 0
          spoken = words.filter((_word, i) => (i % 2 === 0 ? seen++ < count : seen <= count)).join('')
        }
        currentCue = { text: cue.text, at_s: cue.at, dur_s: cue.dur, spokenSoFar: spoken }
      }
    })
    setSceneUiState({
      playing: true,
      paused: scene.pausedAt !== null,
      sceneName: scene.play.name ?? scene.play.id,
      stepName: stepIndex >= 0 ? steps[stepIndex].name : null,
      stepIndex,
      stepCount: steps.length,
      t: Math.round(Math.max(0, t) * 10) / 10,
      duration: scene.play.duration,
      queue: this.scenes.filter((entry) => entry.origin === null).length,
      currentCue
    })
  }

  /** scene_control. */
  control(action: 'status' | 'pause' | 'resume' | 'stop' | 'skip'): SceneStatus {
    const now = performance.now()
    if (action === 'pause') {
      for (const scene of this.scenes) if (scene.origin !== null && scene.pausedAt === null) this.pauseNow(scene, this.timeOf(scene, now), false)
    } else if (action === 'resume') {
      for (const scene of this.scenes) {
        if (scene.origin === null || scene.pausedAt === null) continue
        scene.origin = now - scene.pausedAt * 1000
        scene.lastT = scene.pausedAt
        scene.pausedAt = null
        scene.pauseAt = null
      }
    } else if (action === 'stop') {
      // The playing scenes jump to their end state; the next queued scene starts.
      this.scenes = this.scenes.filter((scene) => scene.origin === null)
      stopSpeech()
    } else if (action === 'skip') {
      const dropped = this.scenes.filter((scene) => scene.origin === null)
      this.scenes = this.scenes.filter((scene) => scene.origin !== null)
      // Their items were committed when they were sent: take them off again (newest first).
      for (const scene of dropped.reverse()) scene.revert()
    }
    this.render()
    this.schedule()
    return this.status()
  }

  status(): SceneStatus {
    const now = performance.now()
    const scene = this.current()
    const t = scene ? this.timeOf(scene, now) : null
    return {
      playing: !!scene && scene.pausedAt === null,
      scene: scene?.play.id ?? null,
      name: scene?.play.name ?? null,
      t: t === null ? null : Math.round(Math.max(0, t) * 100) / 100,
      duration: scene?.play.duration ?? null,
      step: scene && t !== null ? this.stepNameAt(scene.play, t) : null,
      paused: !!scene && scene.pausedAt !== null,
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
    } else {
      scene.pausedAt = Math.max(0, Math.min(scene.play.duration, t))
      // A seek passes the pause steps before it.
      scene.play.steps.forEach((step, i) => {
        if (step.pause && step.at <= scene.pausedAt!) scene.passed.add(i)
      })
      scene.lastT = scene.pausedAt
    }
    this.render()
    this.schedule()
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
      queue: this.scenes.filter((entry) => entry.origin === null).length
    }
  }
}

export const scenePlayer = new ScenePlayer()
