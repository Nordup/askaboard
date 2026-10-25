import { isContent, isInk, newItemId, type BoardNode, type ContentNode } from '@shared/board-format'
import type { SceneContext, SceneDescription, SceneItem, SceneResult } from '@shared/live-scene'
import type { BoardHandle } from '../board/Board'
import type { NodeOverride, PlaybackTip } from '../board/playback'
import type { InkGroupTracker } from '../agent/groups'
import { viewOf, type Scene } from '../agent/placement'
import { compileScene, type CompiledScene, type SceneRevert } from './compile'
import { inkIndexOf, scenePlayer, sceneFrame, type SceneFrame } from './player'
import { multiply } from './timeline'

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
export function sceneContext(board: BoardHandle, s: Scene): SceneContext {
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
  return {
    nodes,
    names: Object.fromEntries(Object.entries(names).map(([key, value]) => [key, value.id])),
    view: rect(viewOf(board)),
    viewport: [Math.round(state.viewport[0]), Math.round(state.viewport[1])]
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

/** Take a committed scene off the board again (a skipped queued scene), as a new undo step. */
function revertScene(board: BoardHandle, revert: SceneRevert): void {
  const created = new Set(revert.created)
  const changed = new Map(revert.changed.map((node) => [node.id, node]))
  const current = board.liveState().nodes
  const present = new Set(current.map((node) => node.id))
  const next = current.filter((node) => !created.has(node.id)).map((node) => changed.get(node.id) ?? node)
  for (const node of revert.removed) if (!present.has(node.id)) next.push(node)
  board.agentCommit(next)
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

export function runScene(ctx: RunSceneContext, args: Record<string, unknown>): SceneResult {
  const desc = checkDescription(args.scene)
  const sceneId = newItemId('sc')
  const name = typeof args.name === 'string' && args.name ? args.name : null
  const s = ctx.scene()
  const compiled = compileScene(desc, s, sceneId, name)
  ctx.board.agentCommit(compiled.next)
  settleLayout(ctx.board, compiled)

  // A scene that changes a node an earlier scene still shows: the earlier scene's look of it starts from the new geometry.
  const earlier = scenePlayer.playingScenes()
  if (earlier.length) {
    const changes = new Map<string, [number, number, number, number, number, number]>()
    for (const object of compiled.play.objects) {
      if (compiled.play.timeline.object(object.id).kind !== 'node' || object.ghost) continue
      for (const target of object.targets) changes.set(target.nodeId, target.inverseBaked)
    }
    for (const play of earlier) for (const object of play.objects) for (const target of object.targets) {
      const change = changes.get(target.nodeId)
      if (change) target.inverseBaked = multiply(target.inverseBaked, change)
    }
  }

  // Each ink object is one ink group, as one draw_ink call is.
  const groupOf = new Map<number, string>()
  for (const { object, strokes } of compiled.inkGroups) groupOf.set(object, ctx.tracker.pin(strokes))
  const mode = args.when === 'now' ? 'now' : 'queue'
  const startsIn = scenePlayer.enqueue(ctx.board, compiled.play, {
    mode,
    speak: args.speak === true,
    voice: typeof args.voice === 'string' ? args.voice : null,
    revert: () => revertScene(ctx.board, compiled.revert)
  })

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
  const groupBounds = new Map<string, ReturnType<typeof rect>>()
  for (const group of s.groups) groupBounds.set(group.id, rect(group.bounds))
  const items: SceneItem[] = []
  const inFrame = new Set<number>()
  const framed = (objectId: number): boolean => {
    for (let current = timeline.object(objectId).parent; current !== undefined; current = timeline.object(current).parent) if (compiled.frames.some((frame) => frame.object === current)) return true
    return false
  }
  for (const frame of compiled.frames) {
    const desc = timeline.object(frame.object)
    if (desc.parent !== undefined && framed(frame.object)) continue
    const box = layout.get(frame.id)
    const firstLeaf = compiled.play.objects.find((object) => {
      for (let current = timeline.object(object.id).parent; current !== undefined; current = timeline.object(current).parent) if (current === frame.object) return true
      return false
    })
    items.push({ id: frame.id, kind: 'group', ...(desc.name ? { name: desc.name } : {}), bounds: box ? rect(box) : null, ...(firstLeaf && stepOf(firstLeaf.id) ? { step: stepOf(firstLeaf.id) } : {}) })
    inFrame.add(frame.object)
  }
  const groupBoxes = ctx.tracker.compute(state)
  for (const object of compiled.play.objects) {
    if (object.ghost) continue
    const desc = timeline.object(object.id)
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
  const present = new Set(state.nodes.map((node) => node.id))
  const lost = items.filter((item) => !item.id.startsWith('g') && !present.has(item.id))
  const warnings = [...desc.warnings, ...compiled.warnings]
  if (lost.length) warnings.push(`${lost.length} item(s) did not reach the board`)
  return {
    scene: sceneId,
    duration_s: Math.round(desc.duration * 1000) / 1000,
    starts_in_s: startsIn,
    steps: desc.steps.map((step) => ({ name: step.name, at_s: step.at, ...(step.pause ? { pause: true } : {}) })),
    items,
    cues: desc.cues.map((cue) => ({ text: cue.text, at_s: cue.at, dur_s: cue.dur })),
    log: desc.logs,
    warnings
  }
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
  clocks: Array<[string, { t: number; playing: boolean; step: string | null; end: number }]>
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
  const compiled = compileScene(desc, s, newItemId('sc'), null)
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
  const clocks = play.objects.flatMap((object) => object.targets.map((target) => [target.nodeId, clock] as [string, typeof clock]))
  return { t: Math.round(t * 1000) / 1000, label, nodes: [...nodes, ...out.inks], overrides: [...out.overrides], tips: out.tips.filter((tip) => tip.kind === 'pointer'), clocks }
}

/** scene_control. */
export function sceneControl(args: Record<string, unknown>): unknown {
  const action = args.action
  if (action !== 'status' && action !== 'pause' && action !== 'resume' && action !== 'stop' && action !== 'skip') throw new Error('action must be status, pause, resume, stop or skip.')
  return scenePlayer.control(action)
}
