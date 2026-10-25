import { isContent, isInk, newItemId, type BoardNode, type ContentNode, type InkNode } from '@shared/board-format'
import type { SceneContext, SceneDescription, SceneItem, SceneResult } from '@shared/live-scene'
import type { BoardHandle } from '../board/Board'
import type { NodeOverride, PlaybackTip } from '../board/playback'
import type { InkGroupTracker } from '../agent/groups'
import { viewOf, type Scene } from '../agent/placement'
import { compileScene, type CompiledScene, type PlayObject, type SceneRevert, type StageLookup } from './compile'
import { inkIndexOf, nodeSig, scenePlayer, sceneFrame, type SceneFrame, type SceneMemory } from './player'
import { apply, multiply, scaleOf } from './timeline'
import type { Point } from '../board/types'
import type { LiveClock } from '../live-pixels/program'

/**
 * The renderer half of run_scene. The main process runs the program in its
 * sandbox with sceneContext() as its view of the board, then sends the
 * description here: runScene() commits the final state as one undo step and
 * queues it for playback; previewScene() commits nothing and returns the
 * storyboard frames for the snapshot window.
 */

const r1 = (value: number): number => Math.round(value * 10) / 10
const rect = (box: { x: number; y: number; width: number; height: number }) => ({ x: r1(box.x), y: r1(box.y), width: r1(box.width), height: r1(box.height) })

/** Every node and ink group with its bounds, item names, and the learner's view: the board as a scene program sees it. */
export function sceneContext(board: BoardHandle, s: Scene, path?: string): SceneContext {
  const nodes: SceneContext['nodes'] = {}
  const names: Record<string, { id: string; seq: number }> = {}
  const name = (key: unknown, id: string, seq: number): void => {
    if (typeof key !== 'string' || !key) return
    const known = names[key]
    if (!known || seq >= known.seq) names[key] = { id, seq }
  }
  for (const group of s.groups) {
    nodes[group.id] = { kind: 'ink group', author: group.author, bounds: rect(group.bounds) }
    // Named ink (a named write() or stroke()) is found by its name as its ink group.
    const strokes = group.strokes.map((id) => s.index.byId.get(id)).filter((node): node is BoardNode => !!node)
    const first = strokes[0]?.name
    if (first && strokes.every((node) => node.name === first)) name(first, group.id, Math.max(...strokes.map((node) => node.seq ?? 0)))
  }
  for (const node of s.nodes) {
    const box = s.layout.get(node.id)
    if (!box) continue
    nodes[node.id] = {
      kind: node.kind,
      ...(typeof node.name === 'string' && node.name ? { name: node.name } : {}),
      ...(typeof node.author === 'string' ? { author: node.author } : {}),
      bounds: rect(box)
    }
    if (!isInk(node)) name(node.name, node.id, node.seq ?? 0)
  }
  const state = board.liveState()
  // The stage's objects that are still on the board, with their items (node ids, ink group id).
  const items: Record<string, string[]> = {}
  for (const [sid, record] of stageRecord.items) {
    const ids = record.nodeIds.filter((id) => s.index.byId.has(id))
    if (ids.length) items[String(sid)] = record.group ? [...ids, record.group] : ids
  }
  return {
    nodes,
    names: Object.fromEntries(Object.entries(names).map(([key, value]) => [key, value.id])),
    view: rect(viewOf(board)),
    viewport: [Math.round(state.viewport[0]), Math.round(state.viewport[1])],
    ...(path ? { board: path } : {}),
    stage: { epoch: stageRecord.epoch, items }
  }
}

function checkDescription(value: unknown): SceneDescription {
  const desc = value as SceneDescription
  if (!desc || !Array.isArray(desc.objects) || !Array.isArray(desc.actions) || !Array.isArray(desc.steps) || typeof desc.duration !== 'number') {
    throw new Error('The scene description is malformed.')
  }
  desc.camera ??= []
  desc.pointer ??= []
  desc.cues ??= []
  return desc
}

export interface RunSceneContext {
  board: BoardHandle
  scene: () => Scene
  tracker: InkGroupTracker
}

/** Take a committed scene off the board again (a skipped queued scene, a restage): a new undo step, or part of the keyed step `step`. */
function revertScene(board: BoardHandle, revert: SceneRevert, step?: string): void {
  const created = new Set(revert.created)
  const changed = new Map(revert.changed.map((node) => [node.id, node]))
  const current = board.liveState().nodes
  const present = new Set(current.map((node) => node.id))
  const next = current.filter((node) => !created.has(node.id)).map((node) => changed.get(node.id) ?? node)
  for (const node of revert.removed) if (!present.has(node.id)) next.push(node)
  board.agentCommit(next, step ? { step } : undefined)
}

/** Text centred on a point and group frames fitted to what they hold, once measured (the same undo step). */
function settleLayout(board: BoardHandle, compiled: CompiledScene): void {
  let state = board.liveState()
  if (compiled.centers.length) {
    const shifts = new Map<string, [number, number]>()
    for (const { nodeId, center } of compiled.centers) {
      const box = state.bounds(nodeId)
      if (box) shifts.set(nodeId, [center[0] - (box.x + box.width / 2), center[1] - (box.y + box.height / 2)])
    }
    if (shifts.size) {
      board.agentAmend(
        state.nodes.map((node) => {
          const shift = shifts.get(node.id)
          return shift && isContent(node) ? { ...node, x: r1(node.x + shift[0]), y: r1(node.y + shift[1]) } : node
        })
      )
      for (const object of compiled.play.objects) {
        for (const target of object.targets) {
          const shift = shifts.get(target.nodeId)
          if (shift) target.inverseBaked = multiply(target.inverseBaked, [1, 0, 0, 1, -shift[0], -shift[1]])
        }
      }
      state = board.liveState()
    }
  }
  // Each group frame: its box becomes the measured box of its children (innermost first).
  for (const { id } of compiled.frames) {
    state = board.liveState()
    const frame = state.nodes.find((node) => node.id === id) as ContentNode | undefined
    const box = state.layout().get(id)
    if (!frame || !box) continue
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const node of state.nodes) {
      if (node.parent !== id) continue
      const child = state.layout().get(node.id)
      if (!child) continue
      const pad = isInk(node) ? node.width : 0
      x0 = Math.min(x0, child.x - pad)
      y0 = Math.min(y0, child.y - pad)
      x1 = Math.max(x1, child.x + child.width + pad)
      y1 = Math.max(y1, child.y + child.height + pad)
    }
    if (x0 === Infinity) continue
    const PAD = 6
    const nx = Math.floor(x0 - PAD)
    const ny = Math.floor(y0 - PAD)
    const dx = nx - box.x
    const dy = ny - box.y
    const width = `${Math.ceil(x1 - nx + PAD)}px`
    const height = `${Math.ceil(y1 - ny + PAD)}px`
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && frame.style.width === width && frame.style.height === height) continue
    board.agentAmend(
      state.nodes.map((node) => {
        if (node.id === id) return { ...frame, x: r1(frame.x + dx), y: r1(frame.y + dy), style: { ...frame.style, width, height } } as BoardNode
        if (node.parent === id) return { ...node, x: r1((node.x as number) - dx), y: r1((node.y as number) - dy) } as BoardNode
        return node
      })
    )
  }
}

/** Items that went into a frame glide from where they were to where the frame put them (measured now). */
function measureGlides(board: BoardHandle, compiled: CompiledScene): void {
  if (!compiled.reparented.length) return
  const layout = board.liveState().layout()
  for (const entry of compiled.reparented) {
    const object = compiled.play.objects.find((play) => play.id === entry.object)
    const box = layout.get(entry.nodeId)
    if (!object?.glide || !box) continue
    const now: Point = entry.ink ? [box.ox, box.oy] : [box.x, box.y]
    // The first node of the item decides (an ink group moves as one).
    if (object.glide.from[0] === 0 && object.glide.from[1] === 0) object.glide.from = [r1(entry.before[0] - now[0]), r1(entry.before[1] - now[1])]
  }
}

/**
 * The renderer's record of the stage (main/live-scene.ts): for each stage
 * object, the board items it shows through. A scene that carries an object
 * reuses these items; the sandbox learns from it which objects are still on
 * the board (sceneContext).
 */
const stageRecord: { epoch: string; items: Map<number, { nodeIds: string[]; group?: string }> } = { epoch: '', items: new Map() }

function adoptEpoch(epoch: string | undefined): void {
  if (!epoch || epoch === stageRecord.epoch) return
  stageRecord.epoch = epoch
  stageRecord.items.clear()
  scenePlayer.resetStage()
}

const stageLookup: StageLookup = (sid) => stageRecord.items.get(sid)

export interface CommittedScene {
  compiled: CompiledScene
  result: SceneResult
  snapshot: SceneMemory['snapshot']
}

/**
 * An earlier scene's ink object whose strokes a later scene commits again:
 * it shows its own strokes (as they are before that commit) as changing ink
 * from now on, so it never draws the later scene's geometry.
 */
function keepInkLook(object: PlayObject, s: Scene): void {
  if (object.dyn) {
    object.dyn.end = Number.POSITIVE_INFINITY
    return
  }
  const lines: Point[][] = []
  let width = 3
  let color = '#ececef'
  let tool: 'pen' | 'highlighter' = 'pen'
  for (const target of object.targets) {
    if (!target.ink) continue
    const node = s.index.byId.get(target.nodeId) as InkNode | undefined
    if (!node || node.kind !== 'ink') continue
    const offset = target.offset ?? [node.x, node.y]
    lines.push(node.points.map(([x, y]) => apply(target.inverseBaked, [x + offset[0], y + offset[1]])))
    width = node.width * scaleOf(target.inverseBaked)
    color = node.color
    tool = node.tool === 'highlighter' ? 'highlighter' : 'pen'
  }
  if (!lines.length) return
  const none = { x: 0, y: 0, width: 0, height: 0 }
  object.dyn = { kind: 'ink', samples: [{ t: 0, bounds: none, lines, width }], end: Number.POSITIVE_INFINITY, finalBounds: none, centered: false, ink: { color, width, tool } }
}

/** Commit a scene's final state (a new undo step, or part of the keyed step `step`) and list its items. starts_in_s is filled in by the caller. */
function commitScene(ctx: RunSceneContext, desc: SceneDescription, sceneId: string, name: string | null, step: string | null): CommittedScene {
  const s = ctx.scene()
  const compiled = compileScene(desc, s, sceneId, name, stageLookup)
  ctx.board.agentCommit(compiled.next, step ? { step } : undefined)
  settleLayout(ctx.board, compiled)
  measureGlides(ctx.board, compiled)

  // A scene that changes a node an earlier scene still shows: the earlier scene's look of it starts from the new geometry.
  const earlier = scenePlayer.playingScenes().filter((play) => play.id !== sceneId)
  if (earlier.length) {
    const changes = new Map<string, [number, number, number, number, number, number]>()
    const replaced = new Map<string, [number, number, number, number, number, number]>()
    for (const object of compiled.play.objects) {
      if (object.ghost) continue
      const kind = compiled.play.timeline.object(object.id)
      if (kind.kind === 'node') for (const target of object.targets) changes.set(target.nodeId, target.inverseBaked)
      // A carried object's node holds this scene's end state now.
      else if (kind.carry) for (const target of object.targets) replaced.set(target.nodeId, target.inverseBaked)
    }
    for (const play of earlier) {
      for (const object of play.objects) {
        // Ink this scene redraws: the earlier scene keeps drawing its own strokes (the board's strokes are this scene's end now).
        if (object.targets.some((target) => target.ink && replaced.has(target.nodeId))) keepInkLook(object, s)
        for (const target of object.targets) {
          const change = changes.get(target.nodeId)
          if (change) target.inverseBaked = multiply(target.inverseBaked, change)
          const fresh = replaced.get(target.nodeId)
          if (fresh) target.inverseBaked = fresh
        }
      }
    }
  }

  // Each ink object is one ink group; a carried one keeps its group.
  const groupOf = new Map<number, string>()
  for (const { object, strokes, group } of compiled.inkGroups) groupOf.set(object, group ? ctx.tracker.repin(group, strokes) : ctx.tracker.pin(strokes))

  // The items, as the learner can pick them up: a named group is one item, then each object's own item.
  const state = ctx.board.liveState()
  const layout = state.layout()
  const timeline = compiled.play.timeline
  const stepOf = (objectId: number): string | undefined => {
    const desc = timeline.object(objectId)
    const reveal = (timeline.tracks[objectId].draw ?? []).find((a) => typeof a.to === 'number' && a.to > 0)?.start ?? (timeline.tracks[objectId].opacity ?? []).find((a) => typeof a.to === 'number' && a.to > 0)?.start
    const at = desc.vis === 'hidden' ? (reveal ?? desc.created) : desc.created
    let step: string | undefined
    for (const entry of desc.kind === 'group' ? [] : compiled.play.steps) if (entry.at <= at + 1e-6) step = entry.name
    return step
  }
  const items: SceneItem[] = []
  const framed = (objectId: number): boolean => {
    for (let current = timeline.object(objectId).parent; current !== undefined; current = timeline.object(current).parent) if (compiled.frames.some((frame) => frame.object === current)) return true
    return false
  }
  for (const frame of compiled.frames) {
    const desc = timeline.object(frame.object)
    if (desc.sid !== undefined) stageRecord.items.set(desc.sid, { nodeIds: [frame.id] })
    if (desc.parent !== undefined && framed(frame.object)) continue
    const box = layout.get(frame.id)
    const firstLeaf = compiled.play.objects.find((object) => {
      for (let current = timeline.object(object.id).parent; current !== undefined; current = timeline.object(current).parent) if (current === frame.object) return true
      return false
    })
    items.push({ id: frame.id, kind: 'group', ...(desc.name ? { name: desc.name } : {}), bounds: box ? rect(box) : null, ...(firstLeaf && stepOf(firstLeaf.id) ? { step: stepOf(firstLeaf.id) } : {}) })
  }
  const groupBoxes = ctx.tracker.compute(state)
  for (const object of compiled.play.objects) {
    const desc = timeline.object(object.id)
    if (desc.sid !== undefined && desc.kind !== 'node' && desc.kind !== 'group') {
      if (object.ghost) stageRecord.items.delete(desc.sid)
      else stageRecord.items.set(desc.sid, { nodeIds: object.records ?? object.targets.map((target) => target.nodeId), ...(groupOf.has(object.id) ? { group: groupOf.get(object.id) } : {}) })
    }
    if (object.ghost) continue
    if (desc.kind === 'node' || framed(object.id)) continue
    const group = groupOf.get(object.id)
    const step = stepOf(object.id)
    if (group) {
      const box = groupBoxes.find((entry) => entry.id === group)?.bounds
      object.item = group
      items.push({ id: group, kind: 'ink group', ...(desc.name ? { name: desc.name } : {}), bounds: box ? rect(box) : null, ...(step ? { step } : {}) })
      continue
    }
    for (const nodeId of compiled.nodesOf.get(object.id) ?? []) {
      const node = state.nodes.find((entry) => entry.id === nodeId)
      if (!node) continue
      const box = layout.get(nodeId)
      object.item = nodeId
      items.push({ id: nodeId, kind: node.kind, ...(desc.name ? { name: desc.name } : {}), bounds: box ? rect(box) : node.kind === 'live' ? liveBox(node) : null, ...(step ? { step } : {}) })
    }
  }
  // The scene's items as they are now, for a replay after later scenes change them.
  const snapshot: SceneMemory['snapshot'] = new Map()
  const byId = new Map(state.nodes.map((node) => [node.id, node]))
  for (const object of compiled.play.objects) {
    if (object.ghost) continue
    for (const target of object.targets) {
      const node = byId.get(target.nodeId)
      if (!node || snapshot.has(node.id)) continue
      const box = layout.get(node.id) as { x: number; y: number; ox?: number; oy?: number } | undefined
      const ghost = isInk(node) ? { ...node, parent: undefined, x: box?.ox ?? node.x, y: box?.oy ?? node.y } : { ...node, parent: undefined, x: box?.x ?? (node as ContentNode).x, y: box?.y ?? (node as ContentNode).y }
      snapshot.set(node.id, { sig: nodeSig(node), ghost: ghost as BoardNode })
    }
  }
  const present = new Set(state.nodes.map((node) => node.id))
  const lost = items.filter((item) => !item.id.startsWith('g') && !present.has(item.id))
  const warnings = [...desc.warnings, ...compiled.warnings]
  if (lost.length) warnings.push(`${lost.length} item(s) did not reach the board`)
  const result: SceneResult = {
    scene: sceneId,
    duration_s: Math.round(desc.duration * 1000) / 1000,
    starts_in_s: 0,
    steps: desc.steps.map((step) => ({ name: step.name, at_s: step.at, ...(step.pause ? { pause: true } : {}) })),
    items,
    cues: desc.cues.map((cue) => ({ text: cue.text, at_s: cue.at, dur_s: cue.dur, ...(cue.marks?.length ? { marks: Object.fromEntries(cue.marks.map((mark) => [mark.name, mark.at])) } : {}) })),
    log: desc.logs,
    warnings
  }
  return { compiled, result, snapshot }
}

/**
 * runScene: commit the scene and queue it. With `slot`, the scene takes the
 * place of the queued or playing scene with the same id (replace, cut),
 * keeping its place in the queue and its clock. `step`: the key of the
 * undo step the commit joins (a restage's reverts and commits are one step).
 */
export function runScene(ctx: RunSceneContext, args: Record<string, unknown>): SceneResult & { ends_in_s: number } {
  const desc = checkDescription(args.scene)
  adoptEpoch(desc.stage)
  const sceneId = typeof args.sceneId === 'string' && args.sceneId ? args.sceneId : newItemId('sc')
  const name = typeof args.name === 'string' && args.name ? args.name : null
  const { compiled, result, snapshot } = commitScene(ctx, desc, sceneId, name, typeof args.step === 'string' && args.step ? args.step : null)
  const revert = (step?: string): void => revertScene(ctx.board, compiled.revert, step)
  let startsIn: number
  if (args.slot === true && scenePlayer.swap(ctx.board, sceneId, compiled.play, revert)) startsIn = scenePlayer.startsIn(sceneId)
  else startsIn = scenePlayer.enqueue(ctx.board, compiled.play, { mode: args.when === 'now' ? 'now' : 'queue', revert })
  scenePlayer.remember({ play: compiled.play, snapshot })
  // A playing scene (cut) started before now: its start is negative, its end is still ahead.
  result.starts_in_s = Math.max(0, startsIn)
  return { ...result, ends_in_s: Math.round((startsIn + result.duration_s) * 1000) / 1000 }
}

function liveBox(node: BoardNode): { x: number; y: number; width: number; height: number } {
  const live = node as unknown as { x: number; y: number; w: number; h: number }
  return rect({ x: live.x, y: live.y, width: live.w, height: live.h })
}

/** One storyboard frame: the board at one moment of a scene that is not committed. */
export interface PreviewFrame {
  t: number
  label: string
  nodes: BoardNode[]
  overrides: Array<[string, NodeOverride]>
  tips: PlaybackTip[]
  /** The scene clock at t for each node the scene plays (program items draw that moment). */
  clocks: Array<[string, LiveClock]>
}

export interface PreviewResult {
  scene: string
  duration_s: number
  frames: PreviewFrame[]
  /** The board region the frames show. */
  rect: { x: number; y: number; width: number; height: number }
  view: { x: number; y: number; width: number; height: number }
  background: string
  steps: Array<{ name: string; at_s: number; pause?: boolean }>
  cues: Array<{ text: string; at_s: number; dur_s: number }>
  log: string[]
  warnings: string[]
}

/** Storyboard frames of a scene, committing nothing: the end of each step, and the end. */
export function previewScene(ctx: RunSceneContext, args: Record<string, unknown>): PreviewResult {
  const desc = checkDescription(args.scene)
  const s = ctx.scene()
  const compiled = compileScene(desc, s, newItemId('sc'), null, stageLookup)
  const play = compiled.play
  const nodes = [...compiled.next, ...play.ghosts]
  const inkIndex = inkIndexOf(play, nodes, null)
  // Segments: before the first step (when something happens there), each step, to the end.
  const bounds = [...new Set([0, ...play.steps.map((step) => step.at), play.duration])].sort((a, b) => a - b)
  const frames: PreviewFrame[] = []
  const fmt = (t: number): string => `${Math.round(t * 10) / 10} s`
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i]
    const to = bounds[i + 1]
    const step = [...play.steps].reverse().find((entry) => entry.at <= from + 1e-6)
    const last = i === bounds.length - 2
    const t = last ? play.duration : Math.max(from, to - 0.001)
    const label = `${step ? `step "${step.name}"${step.pause ? ' (pause)' : ''}` : 'before the first step'} · ${fmt(from)}–${fmt(to)}${last ? ' · end' : ''}`
    frames.push(frameAt(play, t, label, nodes, inkIndex))
  }
  if (!frames.length) frames.push(frameAt(play, play.duration, `end · ${fmt(play.duration)}`, nodes, inkIndex))
  // The region: everything the scene makes or touches, with the learner's view if they meet.
  const state = ctx.board.liveState()
  const view = rect(viewOf(ctx.board))
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (b: { x: number; y: number; width: number; height: number } | null | undefined): void => {
    if (!b || !Number.isFinite(b.x)) return
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.width)
    y1 = Math.max(y1, b.y + b.height)
  }
  for (const object of play.objects) {
    const o = play.timeline.object(object.id)
    if (o.kind === 'group') continue
    for (const t of [...bounds, play.duration]) {
      const m = play.timeline.matrix(object.id, t)
      const b = o.kind === 'node' ? (s.layout.get(o.ref) ?? s.groupById.get(o.ref)?.bounds ?? o.bounds) : o.bounds
      const corners = [
        [b.x, b.y],
        [b.x + b.width, b.y + b.height],
        [b.x + b.width, b.y],
        [b.x, b.y + b.height]
      ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      if (o.kind === 'node') add(b)
      else add({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) })
    }
  }
  for (const move of play.camera) {
    const w = state.viewport[0] / move.zoom
    const h = state.viewport[1] / move.zoom
    add({ x: move.center[0] - w / 2, y: move.center[1] - h / 2, width: w, height: h })
  }
  if (x0 === Infinity) add(view)
  const pad = Math.max(24, 0.05 * Math.max(x1 - x0, y1 - y0))
  return {
    scene: play.id,
    duration_s: Math.round(desc.duration * 1000) / 1000,
    frames,
    rect: rect({ x: x0 - pad, y: y0 - pad, width: x1 - x0 + pad * 2, height: y1 - y0 + pad * 2 }),
    view,
    background: getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim() || '#161618',
    steps: desc.steps.map((step) => ({ name: step.name, at_s: step.at, ...(step.pause ? { pause: true } : {}) })),
    cues: desc.cues.map((cue) => ({ text: cue.text, at_s: cue.at, dur_s: cue.dur })),
    log: desc.logs,
    warnings: [...desc.warnings, ...compiled.warnings]
  }
}

function frameAt(play: CompiledScene['play'], t: number, label: string, nodes: BoardNode[], inkIndex: ReturnType<typeof inkIndexOf>): PreviewFrame {
  const out: SceneFrame = { overrides: new Map(), tips: [], inks: [] }
  sceneFrame(play, t, inkIndex, out)
  let step: string | null = null
  for (const entry of play.steps) if (entry.at <= t + 1e-6) step = entry.name
  const clock = { t, playing: false, step, end: play.duration }
  const steps = play.steps.map((entry) => [entry.at, entry.name] as [number, string])
  const clocks = play.objects.flatMap((object) => {
    // A program item is run from the moment it appears up to this frame's moment (its own state over time), with the params of each moment.
    const desc = play.timeline.object(object.id)
    let own: LiveClock = clock
    if (desc.kind === 'live' && desc.mode === 'program') {
      const from = desc.carry ? 0 : Math.max(0, desc.created)
      const samples = object.dyn?.kind === 'live' ? object.dyn.samples.filter((sample) => sample.params).map((sample) => [sample.t, sample.params] as [number, Record<string, number>]) : []
      if (t >= from) own = { ...clock, sim: { from, to: t, params: samples.length ? samples : null, steps } }
    }
    return object.targets.map((target) => [target.nodeId, own] as [string, LiveClock])
  })
  return { t: Math.round(t * 1000) / 1000, label, nodes: [...nodes, ...out.inks], overrides: [...out.overrides], tips: out.tips.filter((tip) => tip.kind === 'pointer'), clocks }
}

/**
 * scene_control. Besides the playback actions, the main process uses it to
 * restage (revert scenes, drop one, read the cut time), replay, reset the
 * stage's record, and wait for the playback.
 */
export async function sceneControl(ctx: RunSceneContext, args: Record<string, unknown>): Promise<unknown> {
  const action = args.action
  const status = (): Record<string, unknown> => ({ ...scenePlayer.status(), waiting: scenePlayer.waiting(), playing_scene: scenePlayer.playing() })
  switch (action) {
    case 'status':
    case 'pause':
    case 'resume':
    case 'stop':
    case 'skip':
      scenePlayer.control(action)
      return status()
    case 'revert': {
      // Take scenes' items off the board again (newest first), to commit them anew.
      const ids = Array.isArray(args.scenes) ? (args.scenes as string[]) : []
      scenePlayer.revertScenes(ids, typeof args.step === 'string' && args.step ? args.step : newItemId('step'))
      return status()
    }
    case 'drop':
      scenePlayer.drop(String(args.scene))
      return status()
    case 'cutTime': {
      // The time to cut the playing scene at: the start of the step after after_step, or now.
      const playing = scenePlayer.playing()
      if (!playing) throw new Error('No scene is playing, so there is nothing to cut.')
      let at = playing.t
      if (typeof args.after_step === 'string') {
        const index = playing.steps.findIndex((step) => step.name === args.after_step)
        if (index < 0) throw new Error(`The playing scene ${playing.id} has no step "${args.after_step}" (its steps: ${playing.steps.map((step) => step.name).join(', ') || 'none'}).`)
        const next = playing.steps.slice(index + 1).find((step) => step.at > playing.steps[index].at + 1e-6)
        at = next ? Math.max(next.at, playing.t) : playing.duration
      }
      return { scene: playing.id, at: Math.round(at * 1000) / 1000, duration: playing.duration }
    }
    case 'replay': {
      const out = scenePlayer.replay(ctx.board, { scene: typeof args.scene === 'string' ? args.scene : undefined, step: typeof args.step === 'string' ? args.step : undefined }, args.when === 'now' ? 'now' : 'queue')
      if ('error' in out) throw new Error(out.error)
      return { replay: out, ...status() }
    }
    case 'resetStage':
      stageRecord.items.clear()
      stageRecord.epoch = typeof args.epoch === 'string' ? args.epoch : ''
      scenePlayer.resetStage()
      return status()
    case 'waitPlayed': {
      // Ends with the scene's end, or where playback stops at a pause before it (status says why).
      const ended = await scenePlayer.untilPlayed(String(args.scene))
      return { ...status(), ended }
    }
    case 'wait':
      await scenePlayer.untilIdleOrPaused()
      return status()
    default:
      throw new Error('action must be status, pause, resume, stop, skip, replay or wait.')
  }
}
