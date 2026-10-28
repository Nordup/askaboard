import { isContent, isInk, isLive, newItemId, type BoardNode, type ContentNode, type InkNode, type LiveNode } from '@shared/board-format'
import type { DraftInfo, FrameMoment, FramePart, SceneContext, SceneDescription, SceneItem, SceneResult } from '@shared/live-scene'
import type { BoardHandle } from '../board/Board'
import type { NodeOverride, PlaybackTip } from '../board/playback'
import type { InkGroupTracker } from '../agent/groups'
import { coveredOf } from '../agent/covered'
import { viewOf, type Scene } from '../agent/placement'
import { itemNames } from '../agent/item-names'
import { buildIndex } from '../board/scene'
import { compileScene, type CompiledScene, type DynLookup, type PlayObject, type SceneRevert, type StageLookup } from './compile'
import { connectFrames, takeFrames, type RunFrames } from './frames'
import { inkIndexOf, nodeSig, scenePlayer, sceneFrame, type SceneFrame, type SceneMemory } from './player'
import { apply, multiply, scaleOf } from './timeline'
import type { Point } from '../board/types'
import { inkBounds } from '../board/geometry'
import type { LiveTimeline } from '../live-pixels/clock'
import type { LiveStillRequest } from '../live-pixels/stills'

/**
 * The renderer half of the scene tools. The main process runs the program in
 * its sandbox with sceneContext() as its view of the board, then sends the
 * description here (without the samples of its changing objects: those came
 * as frames from the stage, frames.ts, and the description names them by
 * their job): sceneDraft() compiles a draft (write_scene), keeps the
 * compile under the draft's key and commits nothing; sceneFrames() returns
 * frames of a draft or of a committed scene at chosen moments for the
 * snapshot window (preview_scene); runScene() commits the final state of a
 * draft (by its key) or of a description as one undo step and queues it for
 * playback (play_scene start, restage).
 */

connectFrames()

const r1 = (value: number): number => Math.round(value * 10) / 10
const rect = (box: { x: number; y: number; width: number; height: number }) => ({ x: r1(box.x), y: r1(box.y), width: r1(box.width), height: r1(box.height) })

/**
 * Where a new version of a scene runs (main/mcp.ts placeAt): at the place of
 * the scene it replaces, so the board it sees has neither that scene's items
 * nor those of the scenes after it. scenes: those scenes in stage order, the
 * replaced one first.
 */
export interface ScenePlace {
  scenes: Array<{ id: string; name: string }>
}

/** What each committed scene did to the board, to take it off again (by scene id; for the current epoch of the stage). */
const sceneReverts = new Map<string, SceneRevert>()

/** The nodes after a revert of a scene: its new nodes go, the nodes it changed or removed come back as they were. */
function revertedNodes(current: readonly BoardNode[], revert: SceneRevert): BoardNode[] {
  const created = new Set(revert.created)
  const changed = new Map(revert.changed.map((node) => [node.id, node]))
  const present = new Set(current.map((node) => node.id))
  const next = current.filter((node) => !created.has(node.id)).map((node) => changed.get(node.id) ?? node)
  for (const node of revert.removed) if (!present.has(node.id)) next.push(node)
  return next
}

/**
 * The board as a program that runs at a place sees it: the board with the
 * place's scenes taken off (newest first, as a restage reverts them), and
 * the ids and names of their items (SceneContext.ahead). Without a place, the
 * board as it is.
 */
export function sceneAt(s: Scene, place: ScenePlace | null | undefined): { scene: Scene; ahead: NonNullable<SceneContext['ahead']> | null } {
  if (!place || !place.scenes.length) return { scene: s, ahead: null }
  const ahead: NonNullable<SceneContext['ahead']> = {}
  let nodes: readonly BoardNode[] = s.nodes
  place.scenes.forEach((entry, k) => {
    const revert = sceneReverts.get(entry.id)
    if (!revert) return
    const info = { scene: entry.name, earlier: k === 0 }
    const created = new Set(revert.created)
    for (const id of revert.created) {
      ahead[id] ??= info
      const node = s.index.byId.get(id)
      if (node && typeof node.name === 'string' && node.name) ahead[node.name] ??= info
    }
    for (const group of s.groups) {
      if (!group.strokes.length || !group.strokes.every((id) => created.has(id))) continue
      ahead[group.id] ??= info
    }
  })
  for (const entry of [...place.scenes].reverse()) {
    const revert = sceneReverts.get(entry.id)
    if (revert) nodes = revertedNodes(nodes, revert)
  }
  if (nodes === s.nodes) return { scene: s, ahead }
  const index = buildIndex(nodes)
  const groups = s.groups.filter((group) => group.strokes.every((id) => index.byId.has(id)))
  return { scene: { nodes, index, layout: s.layout, groups, groupById: new Map(groups.map((group) => [group.id, group])) }, ahead }
}

/** Every node and ink group with its bounds, item names, the learner's view and the board's revision: the board as a scene program sees it (at a place: sceneAt). */
export function sceneContext(board: BoardHandle, now: Scene, path?: string, place?: ScenePlace | null): SceneContext {
  const { scene: s, ahead } = sceneAt(now, place)
  const nodes: SceneContext['nodes'] = {}
  for (const group of s.groups) nodes[group.id] = { kind: 'ink group', author: group.author, bounds: rect(group.bounds) }
  for (const node of s.nodes) {
    const box = s.layout.get(node.id)
    if (!box) continue
    nodes[node.id] = {
      kind: node.kind,
      ...(typeof node.name === 'string' && node.name ? { name: node.name } : {}),
      ...(typeof node.author === 'string' ? { author: node.author } : {}),
      bounds: rect(box)
    }
  }
  const state = board.liveState()
  const covered = coveredOf(board)
  // The stage's objects that are still on the board, with their items (node ids, ink group id).
  const items: Record<string, string[]> = {}
  for (const [sid, record] of stageRecord.items) {
    const ids = record.nodeIds.filter((id) => s.index.byId.has(id))
    if (ids.length) items[String(sid)] = record.group ? [...ids, record.group] : ids
  }
  return {
    nodes,
    // Named ink (a named write() or stroke()) is found by its name as its ink group.
    names: itemNames(s),
    view: rect(viewOf(board)),
    ...(covered.length ? { covered } : {}),
    viewport: [Math.round(state.viewport[0]), Math.round(state.viewport[1])],
    // The board's next sequence number: every edit (also one that keeps all bounds, such as new text) makes it larger.
    revision: state.nextSeq,
    ...(path ? { board: path } : {}),
    stage: { epoch: stageRecord.epoch, items },
    ...(ahead ? { ahead } : {})
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
  board.agentCommit(revertedNodes(board.liveState().nodes, revert), step ? { step } : undefined)
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
 * the board (sceneContext). The main process owns the stage's epoch: the
 * record is for the epoch of the last description or reset it sent, and
 * starts empty for a new one. `revision` counts the changes of `items`: a
 * compiled draft is for one revision.
 */
const stageRecord: { epoch: string; items: Map<number, { nodeIds: string[]; group?: string }>; revision: number } = { epoch: '', items: new Map(), revision: 0 }

function adoptEpoch(epoch: string | undefined): void {
  if (!epoch || epoch === stageRecord.epoch) return
  stageRecord.epoch = epoch
  if (stageRecord.items.size) stageRecord.revision++
  stageRecord.items.clear()
  sceneReverts.clear()
  scenePlayer.resetStage()
}

const stageLookup: StageLookup = (sid) => stageRecord.items.get(sid)

/** What a commit needs of a scene's description besides its compile. */
type SceneSummary = Pick<SceneDescription, 'duration' | 'steps' | 'cues' | 'logs' | 'stage'>

/**
 * The compiled drafts, by the key that the main process gives each version
 * of a draft (write_scene). A draft compiles once: its previews and its
 * commit (play_scene start) use that compile, and the main process sends
 * the description only once. The compile is for one board and one record of
 * the stage. When either changes, the draft compiles again from its
 * description and its frames, which it keeps (the compile holds the same
 * samples). A draft that is not here (the window loaded again, or it was
 * dropped for newer ones) or that ran in another epoch of the stage is
 * DraftMissing: the main process runs its program again.
 */
interface CompiledDraft {
  summary: SceneSummary
  compiled: CompiledScene
  desc: SceneDescription
  frames: RunFrames
  /** The board and the stage's record that the compile is for. */
  nodes: readonly BoardNode[]
  layout: Scene['layout']
  groups: string
  stage: number
  /** Where the draft runs: a new version of a scene runs at that scene's place (sceneAt); its compile and previews show the board without the version it replaces. */
  place: ScenePlace | null
  /** The nodes that the previews draw and their ink index, made at the first preview. */
  preview?: { nodes: BoardNode[]; inkIndex: ReturnType<typeof inkIndexOf> }
}

/** The answer when the renderer does not have the draft of a key (the window loaded again, or newer drafts took its place): the main process runs it again. */
export interface DraftMissing {
  draftMissing: true
}

const drafts = new Map<string, CompiledDraft>()
/** The drafts kept at most, and the bytes of their frames at most (the oldest goes first). */
const MAX_DRAFTS = 8
const MAX_DRAFT_BYTES = 256 * 1024 * 1024

function keepDraft(key: string, draft: CompiledDraft): void {
  drafts.delete(key)
  drafts.set(key, draft)
  let bytes = 0
  for (const entry of drafts.values()) bytes += entry.frames.bytes
  for (const [old, entry] of drafts) {
    if (drafts.size <= 1 || (drafts.size <= MAX_DRAFTS && bytes <= MAX_DRAFT_BYTES)) break
    drafts.delete(old)
    bytes -= entry.frames.bytes
  }
}

/**
 * The samples of each object from the frames of its run, checked against the
 * description (same kind, same number of samples).
 */
function dynLookup(frames: RunFrames): DynLookup {
  return (object) => {
    if (object.kind !== 'shape' && object.kind !== 'ink' && object.kind !== 'text' && object.kind !== 'live') return undefined
    const found = object.sid !== undefined ? frames.objects.get(object.sid) : undefined
    const math = object.kind === 'text' && !!object.math
    if (!found || found.kind !== object.kind || found.math !== math || found.samples.length !== object.samples) {
      throw new Error(`The frames of ${object.api} ${object.sid ?? object.id} do not match the scene. Write the scene again.`)
    }
    return found.samples
  }
}

const groupsKey = (s: Scene): string => s.groups.map((group) => `${group.id}:${group.strokes.join(',')}`).join(';')

function sameLayout(a: Scene['layout'], b: Scene['layout']): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, box] of a) {
    const other = b.get(id)
    if (!other || other.x !== box.x || other.y !== box.y || other.width !== box.width || other.height !== box.height || other.ox !== box.ox || other.oy !== box.oy) return false
  }
  return true
}

/** Compile a draft for the board s (at its place: sceneAt). The draft keeps s's nodes, layout and ink groups to know when to compile again. */
function compileDraft(desc: SceneDescription, frames: RunFrames, s: Scene, place: ScenePlace | null): CompiledDraft {
  const { duration, steps, cues, logs, stage } = desc
  return {
    summary: { duration, steps, cues, logs, stage },
    // The board after play_scene start: without the version it replaces (the later scenes come back after it).
    compiled: compileScene(desc, sceneAt(s, place && { scenes: place.scenes.slice(0, 1) }).scene, newItemId('sc'), null, stageLookup, dynLookup(frames)),
    desc,
    frames,
    nodes: s.nodes,
    layout: s.layout,
    groups: groupsKey(s),
    stage: stageRecord.revision,
    place
  }
}

/** The draft of a key, compiled for the board and the stage's record now (again when either changed), else null. */
function currentDraft(ctx: RunSceneContext, key: unknown): CompiledDraft | null {
  if (typeof key !== 'string') return null
  let draft = drafts.get(key)
  if (!draft || draft.summary.stage !== stageRecord.epoch) return null
  const s = ctx.scene()
  if (draft.nodes !== s.nodes || draft.stage !== stageRecord.revision || !sameLayout(draft.layout, s.layout) || draft.groups !== groupsKey(s)) {
    draft = compileDraft(draft.desc, draft.frames, s, draft.place)
    drafts.set(key, draft)
  }
  return draft
}

/**
 * The draft of a key for its commit, with the scene's id and name. The
 * renderer forgets the draft: its new node ids go on the board now, so the
 * same compile must never be committed twice.
 */
function takeDraft(ctx: RunSceneContext, key: unknown, sceneId: string, name: string | null): { summary: SceneSummary; compiled: CompiledScene } | null {
  const draft = currentDraft(ctx, key)
  if (!draft) return null
  drafts.delete(key as string)
  const { compiled } = draft
  const draftId = compiled.play.id
  compiled.play.id = sceneId
  compiled.play.name = name
  // The nodes that the compile made carry the scene's id.
  for (const node of compiled.next) if ((node as { scene?: string }).scene === draftId) (node as { scene?: string }).scene = sceneId
  return { summary: draft.summary, compiled }
}

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

/** Commit a compiled scene's final state (a new undo step, or part of the keyed step `step`) and list its items. starts_in_s is filled in by the caller. */
function commitScene(ctx: RunSceneContext, desc: SceneSummary, compiled: CompiledScene, step: string | null): CommittedScene {
  const s = ctx.scene()
  const sceneId = compiled.play.id
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
    scenePlayer.playsChanged()
  }

  // Each ink object is one ink group; a carried one keeps its group.
  const groupOf = new Map<number, string>()
  for (const { object, strokes, group } of compiled.inkGroups) groupOf.set(object, group ? ctx.tracker.repin(group, strokes) : ctx.tracker.pin(strokes))

  // The items, as the learner can pick them up: a named group is one item, then each object's own item.
  const state = ctx.board.liveState()
  const layout = state.layout()
  // The result lists only items that are on the board.
  const present = new Set(state.nodes.map((node) => node.id))
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
    if (!present.has(frame.id)) continue
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
  stageRecord.revision++
  const result: SceneResult = {
    scene: sceneId,
    duration_s: Math.round(desc.duration * 1000) / 1000,
    starts_in_s: 0,
    steps: desc.steps.map((step) => ({ name: step.name, at_s: step.at, ...(step.pause ? { pause: true } : {}) })),
    items,
    cues: desc.cues.map((cue) => ({ text: cue.text, at_s: cue.at, dur_s: cue.dur, ...(cue.marks?.length ? { marks: Object.fromEntries(cue.marks.map((mark) => [mark.name, mark.at])) } : {}) })),
    log: desc.logs
  }
  return { compiled, result, snapshot }
}

/**
 * runScene: commit the scene and queue it. With `slot`, the scene takes the
 * place of the queued or playing scene with the same id (replace, cut),
 * keeping its place in the queue and its clock. `step`: the key of the
 * undo step the commit joins (a restage's reverts and commits are one step).
 */
export function runScene(ctx: RunSceneContext, args: Record<string, unknown>): (SceneResult & { ends_in_s: number }) | DraftMissing {
  const sceneId = typeof args.sceneId === 'string' && args.sceneId ? args.sceneId : newItemId('sc')
  const name = typeof args.name === 'string' && args.name ? args.name : null
  let desc: SceneSummary
  let compiled: CompiledScene
  if (args.scene) {
    const full = checkDescription(args.scene)
    const frames = takeFrames(args.job, args.frames)
    adoptEpoch(full.stage)
    compiled = compileScene(full, ctx.scene(), sceneId, name, stageLookup, dynLookup(frames))
    desc = full
  } else {
    // A draft compiled before (write_scene): its compile becomes the scene.
    const draft = takeDraft(ctx, args.draft, sceneId, name)
    if (!draft) return { draftMissing: true }
    ;({ summary: desc, compiled } = draft)
  }
  const { result, snapshot } = commitScene(ctx, desc, compiled, typeof args.step === 'string' && args.step ? args.step : null)
  const revert = (step?: string): void => revertScene(ctx.board, compiled.revert, step)
  sceneReverts.set(sceneId, compiled.revert)
  let startsIn: number
  // settled: the scene goes back on the board in its end state and does not play (a failed replace of a scene that had played).
  if (args.settled === true) startsIn = 0
  else if (args.slot === true && scenePlayer.swap(ctx.board, sceneId, compiled.play, revert, args.slotWhy === 'cut' ? 'cut' : 'replaced')) startsIn = scenePlayer.startsIn(sceneId)
  else startsIn = scenePlayer.enqueue(ctx.board, compiled.play, { mode: args.when === 'now' ? 'now' : 'queue', revert })
  scenePlayer.remember({ play: compiled.play, snapshot, revert })
  // A playing scene (cut) started before now: its start is negative, its end is still ahead.
  result.starts_in_s = Math.max(0, startsIn)
  return { ...result, ends_in_s: Math.round((startsIn + result.duration_s) * 1000) / 1000 }
}

function liveBox(node: BoardNode): { x: number; y: number; width: number; height: number } {
  const live = node as unknown as { x: number; y: number; w: number; h: number }
  return rect({ x: live.x, y: live.y, width: live.w, height: live.h })
}

/** One frame: the board at one moment of a scene (a draft, or a committed scene drawn as it was then). */
export interface PreviewFrame {
  t: number
  label: string
  /** The ink that exists only at this moment (changing ink), drawn over the shared nodes. */
  inks: BoardNode[]
  overrides: Array<[string, NodeOverride]>
  tips: PlaybackTip[]
}

/** A live item of the frames: the scene's items step through the scene's time (t); other items show as they are on the board (t null). */
export type FramesLiveItem = Omit<LiveStillRequest, 'moments'> & { moments: Array<{ frame: number; t: number | null }> }

type Box = { x: number; y: number; width: number; height: number }


export interface FramesResult {
  scene: string
  duration_s: number
  /** The nodes of all frames (the board with the scene's end state and its ghosts). */
  nodes: BoardNode[]
  frames: PreviewFrame[]
  /** The live items in the region and the moment of each frame: their stills are made apart (live-pixels/stills.ts). */
  live: FramesLiveItem[]
  /** The board region the frames show. */
  rect: Box
  view: Box
  /** Parts of the view that app UI covers while scenes play (agent/covered.ts). */
  covered: Box[]
  background: string
}


const fmt = (t: number): string => `${Math.round(t * 10) / 10} s`
const r3 = (value: number): number => Math.round(value * 1000) / 1000

/** The step each object appears in (as commitScene's items list it). */
export function stepOfObject(play: CompiledScene['play'], objectId: number): string | undefined {
  const timeline = play.timeline
  const desc = timeline.object(objectId)
  const reveal = (timeline.tracks[objectId].draw ?? []).find((a) => typeof a.to === 'number' && a.to > 0)?.start ?? (timeline.tracks[objectId].opacity ?? []).find((a) => typeof a.to === 'number' && a.to > 0)?.start
  const at = desc.vis === 'hidden' ? (reveal ?? desc.created) : desc.created
  let step: string | undefined
  for (const entry of desc.kind === 'group' ? [] : play.steps) if (entry.at <= at + 1e-6) step = entry.name
  return step
}

/**
 * The end of write_scene's sampling pass: compile the draft (its description
 * and its frames, args.job) against the board now (nothing is committed) for
 * a short list of what it makes. The compile is kept under
 * the key args.draft for the preview and the commit.
 */
export function sceneDraft(ctx: RunSceneContext, args: Record<string, unknown>): DraftInfo {
  const desc = checkDescription(args.scene)
  adoptEpoch(desc.stage)
  const draft = compileDraft(desc, takeFrames(args.job, args.frames), ctx.scene(), (args.place as ScenePlace | undefined) ?? null)
  if (typeof args.draft === 'string') keepDraft(args.draft, draft)
  const { compiled } = draft
  const play = compiled.play
  const kinds = new Map(compiled.next.map((node) => [node.id, node.kind as string]))
  const inkObjects = new Set(compiled.inkGroups.map((entry) => entry.object))
  const byKind: Record<string, number> = {}
  const named: DraftInfo['items']['named'] = []
  let total = 0
  let removed = 0
  for (const object of play.objects) {
    const o = play.timeline.object(object.id)
    if (o.kind === 'node') continue
    if (object.ghost) {
      removed++
      continue
    }
    const kind = inkObjects.has(object.id) ? 'ink group' : (kinds.get((compiled.nodesOf.get(object.id) ?? [])[0] ?? '') ?? o.kind)
    total++
    byKind[kind] = (byKind[kind] ?? 0) + 1
    const step = stepOfObject(play, object.id)
    if (o.name) named.push({ name: o.name, kind, ...(step ? { step } : {}) })
  }
  for (const frame of compiled.frames) {
    const o = play.timeline.object(frame.object)
    total++
    byKind.group = (byKind.group ?? 0) + 1
    if (o.name) named.push({ name: o.name, kind: 'group' })
  }
  const steps = desc.steps.map((step, i) => {
    const next = desc.steps.slice(i + 1).find((entry) => entry.at > step.at + 1e-6)
    return { number: i + 1, name: step.name, start_s: r3(step.at), length_s: r3((next ? next.at : desc.duration) - step.at), ...(step.pause ? { pause: true } : {}) }
  })
  return {
    duration_s: r3(desc.duration),
    steps,
    items: { total, by_kind: byKind, named, removed_by_end: removed },
    cues: desc.cues.map((cue) => ({ text: cue.text, at_s: cue.at, dur_s: cue.dur })),
    log: desc.logs
  }
}

/** The box that a matrix makes of a box (the bounds of its four corners). */
function transformBox(m: readonly number[], b: Box): Box {
  const corners = [
    [b.x, b.y],
    [b.x + b.width, b.y + b.height],
    [b.x + b.width, b.y],
    [b.x, b.y + b.height]
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

/**
 * The end box of each node that the scene shows through (its committed
 * geometry, from which the override matrix of a frame moves it): the
 * measured box of a node on the board, else the box of the node that the
 * compile made.
 */
function endBoxes(play: CompiledScene['play'], s: Scene, nodes: readonly BoardNode[]): Map<string, Box> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const out = new Map<string, Box>()
  const add = (id: string, offset: Point | undefined, objectId: number | null): void => {
    if (out.has(id)) return
    const measured = s.layout.get(id)
    if (measured) {
      out.set(id, measured)
      return
    }
    const node = byId.get(id)
    if (!node) return
    if (isInk(node)) {
      const box = inkBounds(node, offset ?? [node.x, node.y])
      if (box) out.set(id, box)
    } else if (isLive(node)) out.set(id, liveBox(node))
    else if (objectId !== null) {
      // A new content node: the bounds of its object at the end of the scene.
      const o = play.timeline.object(objectId)
      if (o.kind !== 'group' && o.kind !== 'node') out.set(id, transformBox(play.timeline.matrix(objectId, play.duration), o.bounds))
    }
  }
  for (const object of play.objects) for (const target of object.targets) add(target.nodeId, target.offset, object.id)
  for (const node of play.ghosts) add(node.id, undefined, null)
  for (const edit of play.edits ?? []) add(edit.nodeId, undefined, null)
  return out
}

/**
 * The boxes of what one evaluated frame shows of the scene, by node id (the
 * changing ink by its own id): the end box of each node, moved by its
 * override in that frame. A node that the frame hides has no box. The
 * framing of a preview and its live stills use these boxes, so they agree
 * with the drawn frame.
 */
function frameBoxes(play: CompiledScene['play'], ends: ReadonlyMap<string, Box>, frame: SceneFrame, t: number): Map<string, Box> {
  const out = new Map<string, Box>()
  const place = (id: string, box: Box | undefined): void => {
    if (!box) return
    const override = frame.overrides.get(id)
    if (override?.opacity === 0) return
    out.set(id, override?.matrix ? transformBox(override.matrix, box) : box)
  }
  for (const object of play.objects) {
    // A changing shape: the bounds of its sample of now, where its object is now.
    const dyn = object.dyn?.kind === 'shape' && t < object.dyn.end ? object.dyn : null
    let sample = dyn?.samples[0]
    if (dyn) for (const entry of dyn.samples) if (entry.t <= t) sample = entry
    for (const target of object.targets) {
      if (dyn && sample) {
        if (frame.overrides.get(target.nodeId)?.opacity !== 0) out.set(target.nodeId, transformBox(play.timeline.matrix(object.id, t), sample.bounds))
      } else place(target.nodeId, ends.get(target.nodeId))
    }
  }
  for (const node of play.ghosts) place(node.id, ends.get(node.id))
  for (const edit of play.edits ?? []) place(edit.nodeId, ends.get(edit.nodeId))
  for (const ink of frame.inks) {
    const box = isInk(ink) ? inkBounds(ink, [ink.x, ink.y]) : null
    if (box) out.set(ink.id, box)
  }
  return out
}

class BoxUnion {
  x0 = Infinity
  y0 = Infinity
  x1 = -Infinity
  y1 = -Infinity
  add(b: Box | null | undefined): void {
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.width)) return
    this.x0 = Math.min(this.x0, b.x)
    this.y0 = Math.min(this.y0, b.y)
    this.x1 = Math.max(this.x1, b.x + b.width)
    this.y1 = Math.max(this.y1, b.y + b.height)
  }
  get empty(): boolean {
    return this.x0 === Infinity
  }
  padded(pad: (size: number) => number): Box {
    const p = pad(Math.max(this.x1 - this.x0, this.y1 - this.y0))
    return rect({ x: this.x0 - p, y: this.y0 - p, width: this.x1 - this.x0 + p * 2, height: this.y1 - this.y0 + p * 2 })
  }
}

/** The end of step i (0-based): just before the next step that starts later, or the scene's end. */
function stepEnd(play: CompiledScene['play'], i: number): number {
  const step = play.steps[i]
  const next = play.steps.slice(i + 1).find((entry) => entry.at > step.at + 1e-6)
  return next ? Math.max(step.at, next.at - 0.001) : play.duration
}

function stepList(play: CompiledScene['play']): string {
  return play.steps.length ? play.steps.map((step, i) => `${i + 1} "${step.name}"`).join(', ') : 'none'
}

/** The moments to draw, with their labels. Throws an agent-readable error for an unknown step or a time past the end. */
function momentsOf(play: CompiledScene['play'], moments: FrameMoment[], what: string): Array<{ t: number; label: string }> {
  const out: Array<{ t: number; label: string }> = []
  const stepAt = (t: number): string => {
    let name: string | null = null
    for (const entry of play.steps) if (entry.at <= t + 1e-6) name = entry.name
    return name ? ` · step "${name}"` : ''
  }
  for (const moment of moments) {
    if (moment.kind === 'end') out.push({ t: play.duration, label: `end · ${fmt(play.duration)}` })
    else if (moment.kind === 't') {
      if (moment.t > play.duration + 1e-6) throw new Error(`The time ${moment.t} s is past the end of ${what}: it is ${fmt(play.duration)} long. Use a time from 0 to ${Math.round(play.duration * 1000) / 1000}, or "end".`)
      out.push({ t: moment.t, label: `${fmt(moment.t)}${stepAt(moment.t)}` })
    } else if (moment.kind === 'step') {
      const i = typeof moment.step === 'number' ? moment.step - 1 : play.steps.findIndex((entry) => entry.name === moment.step)
      if (i < 0 || i >= play.steps.length || (typeof moment.step === 'number' && !Number.isInteger(moment.step))) {
        throw new Error(`${what[0].toUpperCase()}${what.slice(1)} has no step ${typeof moment.step === 'number' ? moment.step : `"${moment.step}"`}. Its steps: ${stepList(play)}.`)
      }
      const step = play.steps[i]
      out.push({ t: stepEnd(play, i), label: `end of step ${i + 1} "${step.name}"${step.pause ? ' (pause)' : ''} · ${fmt(stepEnd(play, i))}` })
    } else {
      // One frame per step: before the first step (when something happens there), each step, to the end.
      const bounds = [...new Set([0, ...play.steps.map((step) => step.at), play.duration])].sort((a, b) => a - b)
      const before = out.length
      for (let i = 0; i < bounds.length - 1; i++) {
        const from = bounds[i]
        const to = bounds[i + 1]
        const step = [...play.steps].reverse().find((entry) => entry.at <= from + 1e-6)
        const last = i === bounds.length - 2
        const t = last ? play.duration : Math.max(from, to - 0.001)
        out.push({ t, label: `${step ? `step "${step.name}"${step.pause ? ' (pause)' : ''}` : 'before the first step'} · ${fmt(from)}–${fmt(to)}${last ? ' · end' : ''}` })
      }
      if (out.length === before) out.push({ t: play.duration, label: `end · ${fmt(play.duration)}` })
    }
  }
  return out
}

/**
 * preview_scene: frames of a draft (args.draft, the key of its compile; it
 * compiles again when the board changed; nothing is committed) or of a committed scene of the stage
 * (args.sceneId, drawn as it was then over the board now) at the given
 * moments, of the given part of the board. The learner's board does not change.
 */
export function sceneFrames(ctx: RunSceneContext, args: Record<string, unknown>): FramesResult | DraftMissing {
  const s = ctx.scene()
  const what = typeof args.label === 'string' ? args.label : 'the scene'
  let play: CompiledScene['play']
  let nodes: BoardNode[]
  let inkIndex: ReturnType<typeof inkIndexOf>
  if (args.draft !== undefined) {
    const draft = currentDraft(ctx, args.draft)
    if (!draft) return { draftMissing: true }
    play = draft.compiled.play
    if (!draft.preview) {
      const all = [...draft.compiled.next, ...play.ghosts]
      draft.preview = { nodes: all, inkIndex: inkIndexOf(play, all, null) }
    }
    ;({ nodes, inkIndex } = draft.preview)
  } else {
    const id = String(args.sceneId)
    const memory = scenePlayer.memory(id)
    if (!memory) throw new Error(`${what[0].toUpperCase()}${what.slice(1)} is no longer known to the board's player (the board was opened again, or the stage started new), so it cannot be drawn at a moment. get_screenshot shows the board as it is now.`)
    const state = ctx.board.liveState()
    play = scenePlayer.replayClone(ctx.board, memory, `${id}~p`)
    const hidden = new Set(play.hidden ?? [])
    nodes = [...state.nodes.filter((node) => !hidden.has(node.id)), ...play.ghosts]
    inkIndex = inkIndexOf(play, nodes, state.layout())
  }
  const moments = momentsOf(play, (args.moments as FrameMoment[] | undefined) ?? [{ kind: 'end' }], what)
  // Each moment evaluated once: the drawn overrides, and the boxes that framing and live stills use.
  const ends = endBoxes(play, s, nodes)
  const evaluated = moments.map((moment) => {
    const frame: SceneFrame = { overrides: new Map(), tips: [], inks: [] }
    sceneFrame(play, moment.t, inkIndex, frame)
    return { moment, frame, boxes: frameBoxes(play, ends, frame, moment.t) }
  })
  const state = ctx.board.liveState()
  const view = rect(viewOf(ctx.board))
  const part = (args.part as FramePart | undefined) ?? { kind: 'scene' }
  let region: Box
  if (part.kind === 'view') region = view
  else if (part.kind === 'region') region = rect(part.rect)
  else if (part.kind === 'items') {
    const union = new BoxUnion()
    const fallback = new BoxUnion()
    const missing: string[] = []
    for (const item of part.items) {
      // An object of the scene by its name or its board item (node id, ink group id), else any item on the board.
      const objects = play.objects.filter((object) => {
        const o = play.timeline.object(object.id)
        return o.name === item || object.item === item || object.targets.some((target) => target.nodeId === item)
      })
      const groups = play.objects.filter((object) => {
        for (let current = play.timeline.object(object.id).parent; current !== undefined; current = play.timeline.object(current).parent) if (play.timeline.object(current).name === item) return true
        return false
      })
      const found = [...objects, ...groups]
      if (found.length) {
        // The item where each frame shows it: its nodes, and its changing ink (ids "<scene>:<object>:<stroke>").
        const ids = new Set(found.flatMap((object) => object.targets.map((target) => target.nodeId)))
        const prefixes = found.map((object) => `${play.id}:${object.id}:`)
        for (const { boxes } of evaluated) for (const [id, box] of boxes) if (ids.has(id) || prefixes.some((prefix) => id.startsWith(prefix))) union.add(box)
        // An item that no frame shows: its box at the end of the scene.
        for (const id of ids) fallback.add(ends.get(id))
        continue
      }
      const box = s.layout.get(item) ?? s.groupById.get(item)?.bounds
      if (box) union.add(box)
      else missing.push(item)
    }
    if (missing.length) {
      const names = [...new Set(play.objects.map((object) => play.timeline.object(object.id).name).filter((name): name is string => !!name))]
      throw new Error(`No item ${missing.map((item) => `"${item}"`).join(', ')} in ${what} or on the board. Use the name of an object of the scene${names.length ? ` (named here: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', …' : ''})` : ' (this scene names none)'}, or a node or ink group id from list_items.`)
    }
    const shown = union.empty ? fallback : union
    region = shown.empty ? view : shown.padded((size) => Math.max(16, 0.15 * size))
  } else {
    // Everything that the frames show of the scene, with the camera's views.
    const union = new BoxUnion()
    for (const { boxes } of evaluated) for (const box of boxes.values()) union.add(box)
    for (const move of play.camera) {
      const w = state.viewport[0] / move.zoom
      const h = state.viewport[1] / move.zoom
      union.add({ x: move.center[0] - w / 2, y: move.center[1] - h / 2, width: w, height: h })
    }
    if (union.empty) union.add(view)
    region = union.padded((size) => Math.max(24, 0.05 * size))
  }
  return {
    scene: play.id,
    duration_s: r3(play.duration),
    nodes,
    frames: evaluated.map(({ moment, frame }) => ({ t: r3(moment.t), label: moment.label, inks: frame.inks, overrides: [...frame.overrides], tips: frame.tips.filter((tip) => tip.kind === 'pointer') })),
    live: liveItemsOf(play, evaluated, nodes, s, region),
    rect: region,
    view,
    covered: coveredOf(ctx.board),
    background: getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim() || '#161618'
  }
}

const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/**
 * The live items with the frames in which they show inside the region. An
 * item of the scene steps through the scene's time from its start (tick 0)
 * with the params and steps of each moment (its timeline), and is where the
 * evaluated frame puts it; a frame that hides it needs no still. Any other
 * live item shows as it is on the board now.
 */
function liveItemsOf(play: CompiledScene['play'], evaluated: ReadonlyArray<{ moment: { t: number }; boxes: ReadonlyMap<string, Box> }>, nodes: BoardNode[], s: Scene, region: Box): FramesLiveItem[] {
  const steps = play.steps.map((entry) => [entry.at, entry.name] as [number, string])
  const timelines = new Map<string, LiveTimeline>()
  const ofScene = new Set<string>()
  for (const object of play.objects) {
    for (const target of object.targets) ofScene.add(target.nodeId)
    if (play.timeline.object(object.id).kind !== 'live') continue
    const samples = object.dyn?.kind === 'live' ? object.dyn.samples.filter((sample) => sample.params).map((sample) => [sample.t, sample.params] as [number, Record<string, number>]) : []
    for (const target of object.targets) timelines.set(target.nodeId, { params: samples.length ? samples : null, steps })
  }
  for (const node of play.ghosts) ofScene.add(node.id)
  const out: FramesLiveItem[] = []
  for (const node of nodes) {
    if (!isLive(node)) continue
    const timeline = timelines.get(node.id) ?? null
    const still = s.layout.get(node.id) ?? liveBox(node)
    const moments: FramesLiveItem['moments'] = []
    evaluated.forEach(({ moment, boxes }, frame) => {
      const box = ofScene.has(node.id) ? boxes.get(node.id) : still
      if (box && overlap(box, region)) moments.push({ frame, t: timeline ? moment.t : null })
    })
    if (moments.length) out.push({ node: node as LiveNode, timeline, moments })
  }
  return out
}

/**
 * play_scene's playback actions. Besides them, the main process uses it to
 * restage (revert scenes, drop one, read the cut time), replay and reset the
 * stage's record. No action waits for the playback: each answers at once.
 */
export async function sceneControl(ctx: RunSceneContext, args: Record<string, unknown>): Promise<unknown> {
  const action = args.action
  const status = (): Record<string, unknown> => ({ ...scenePlayer.status(), waiting: scenePlayer.waiting(), playing_scene: scenePlayer.playing() })
  switch (action) {
    case 'next':
      scenePlayer.nextStep()
      return status()
    case 'known':
      // The player still holds this scene (it waits, plays, or is in the stage's history).
      return { known: scenePlayer.isKnown(String(args.scene)) }
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
      if (typeof args.after_step === 'string' || typeof args.after_step === 'number') {
        const index = typeof args.after_step === 'number' ? args.after_step - 1 : playing.steps.findIndex((step) => step.name === args.after_step)
        if (index < 0 || index >= playing.steps.length) {
          throw new Error(`The playing scene "${playing.name ?? playing.id}" has no step ${typeof args.after_step === 'number' ? args.after_step : `"${args.after_step}"`}. Its steps: ${playing.steps.map((step, i) => `${i + 1} "${step.name}"`).join(', ') || 'none'}.`)
        }
        const next = playing.steps.slice(index + 1).find((step) => step.at > playing.steps[index].at + 1e-6)
        at = next ? Math.max(next.at, playing.t) : playing.duration
      }
      return { scene: playing.id, at: Math.round(at * 1000) / 1000, duration: playing.duration }
    }
    case 'replay': {
      const step = typeof args.step === 'string' || typeof args.step === 'number' ? args.step : undefined
      const out = scenePlayer.replay(ctx.board, { scene: typeof args.scene === 'string' ? args.scene : undefined, step }, args.when === 'now' ? 'now' : 'queue')
      if ('error' in out) throw new Error(out.error)
      return { replay: out, ...status() }
    }
    case 'resetStage':
      adoptEpoch(typeof args.epoch === 'string' ? args.epoch : undefined)
      return status()
    default:
      throw new Error('action must be status, pause, resume, next, stop, skip or replay.')
  }
}
