import { isContent, isInk, isLive, isOldLive, newItemId, type BoardNode, type ContentNode, type InkNode, type LiveNode } from '@shared/board-format'
import type { MomentsFailure } from '@shared/frames'
import type { DraftInfo, FrameMoment, FramePart, SceneContext, SceneDescription, SceneItem, SceneResult } from '@shared/live-scene'
import { sceneSteps } from '@shared/live-scene'
import { renamedFollows, type NodeFollows } from '@shared/world-links'
import type { BoardHandle } from '../board/Board'
import type { NodeOverride, PlaybackTip } from '../board/playback'
import type { InkGroupTracker } from '../agent/groups'
import { coveredOf, type Covered } from '../agent/covered'
import { viewOf, type Scene } from '../agent/placement'
import { itemNames } from '../agent/item-names'
import { ownBox } from '../board/rotation'
import { huggedNodes } from '../board/hug'
import { buildIndex, isFlowed } from '../board/scene'
import { allObjects, compileScene, packLines, type CompiledScene, type DynLookup, type PlayObject, type SceneRevert, type StageLookup } from './compile'
import { connectFrames, cutJob, objectOf, onFramesGrowth, takeFrames, type RunFrames } from './frames'
import { inkIndexOf, liveSamples, nodeSig, scenePlayer, sceneFrame, type SceneFrame, type SceneMemory } from './player'
import { apply, multiply, scaleOf } from './timeline'
import type { Camera, Point } from '../board/types'
import { clampZoom, glideCamera, inkBounds } from '../board/geometry'
import { tickOf, timeOfTick, type LiveTimeline } from '../live-pixels/clock'
import type { LiveStillRequest } from '../live-pixels/stills'
import { nodeSig as contentSig, stepAt, stepLines, type SceneSettle, type SceneStory, type StoryItem, type StoryRevert } from '@shared/scene-story'
import { clearRestored, forgetRestored, restoredScene, setFailed, setRestored, type RestoredScene } from './rebuild'

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

/**
 * The nodes after a revert of a scene: its new nodes go, the nodes it removed come back, and a node it changed comes back as
 * it was while it is still as the scene left it (revert.after); a node changed since (by the learner) keeps that change. The
 * one revert rule: a replace, a skipped scene, a place on the stage (sceneAt), in one session and after a restart. exact:
 * the board as it was before the scene (a replay's compile, sceneMemory): every node it changed or removed comes back as it
 * was, also one changed or deleted since.
 */
function revertedNodes(current: readonly BoardNode[], revert: SceneRevert, exact = false): BoardNode[] {
  const created = new Set(revert.created)
  const changed = new Map(revert.changed.map((node) => [node.id, node]))
  const present = new Set(current.map((node) => node.id))
  const back = (node: BoardNode): BoardNode => {
    const before = changed.get(node.id)
    if (!before) return node
    const after = revert.after?.[node.id]
    return exact || after === undefined || contentSig(node) === after ? before : node
  }
  const next = current.filter((node) => !created.has(node.id)).map(back)
  for (const node of revert.removed) if (!present.has(node.id)) next.push(node)
  if (exact) for (const node of revert.changed) if (!present.has(node.id)) next.push(node)
  return next
}

/**
 * The board as a program that runs at a place sees it: the board with the
 * place's scenes taken off (newest first, as a restage reverts them), and
 * the ids and names of their items (SceneContext.ahead). Without a place, the
 * board as it is.
 */
export function sceneAt(s: Scene, place: ScenePlace | null | undefined, exact = false): { scene: Scene; ahead: NonNullable<SceneContext['ahead']> | null } {
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
    if (revert) nodes = revertedNodes(nodes, revert, exact)
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

/** A description from the stage, with its steps as the story has them (stepLines: in time order, with their lines, and a first step named after the scene when lines come before the first step()). */
function checkDescription(value: unknown, name: string | null): SceneDescription {
  const desc = value as SceneDescription
  if (!desc || !Array.isArray(desc.objects) || !Array.isArray(desc.actions) || !Array.isArray(desc.steps) || typeof desc.duration !== 'number') {
    throw new Error('The scene description is malformed.')
  }
  desc.camera ??= []
  desc.pointer ??= []
  desc.cues ??= []
  desc.steps = stepLines(name, desc.steps, desc.cues)
  return desc
}

export interface RunSceneContext {
  board: BoardHandle
  scene: () => Scene
  tracker: InkGroupTracker
  /** The learning folder and the board's path (a commit's record names them, main/scene-store.ts). */
  where?: { root: string; path: string }
}

/** Take a committed scene off the board again (a skipped queued scene, a restage): a new undo step, or part of the keyed step `step`. */
function revertScene(board: BoardHandle, revert: SceneRevert, step?: string): void {
  const nodes = board.liveState().nodes
  board.agentCommit(nodes, revertedNodes(nodes, revert), step ? { step } : undefined)
}

/** The player's way to take a scene off the board: by its revert in sceneReverts, the one owner, read when it runs. */
function revertOf(board: BoardHandle, sceneId: string): (step?: string) => void {
  return (step) => {
    const revert = sceneReverts.get(sceneId)
    if (revert) revertScene(board, revert, step)
  }
}

/** A restage's calls name the board they are for (main/mcp.ts restage): another board refuses them. */
function sameBoard(ctx: RunSceneContext, args: Record<string, unknown>): void {
  if (typeof args.boardId === 'string' && (ctx.board.boardId() ?? null) !== args.boardId) throw new Error('The board changed while the scene ran, so this board is not changed.')
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
        state.nodes,
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
  // Each group frame hugs its children, as the board keeps it after every measure (board/hug.ts).
  state = board.liveState()
  const hugged = huggedNodes(state.nodes, state.layout())
  if (hugged) board.agentAmend(state.nodes, hugged)
}

/** Items that went into a frame glide from where they were to where the frame put them (measured now). */
function measureGlides(board: BoardHandle, compiled: CompiledScene): void {
  if (!compiled.reparented.length) return
  const layout = board.liveState().layout()
  for (const entry of compiled.reparented) {
    const object = compiled.play.objects.find((play) => play.id === entry.object)
    const box = layout.get(entry.nodeId)
    if (!object?.glide || !box) continue
    const now: Point = entry.ink ? [box.ox, box.oy] : [ownBox(box).x, ownBox(box).y]
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

/**
 * The owner of each stage object of this epoch: the scene id and key of the scene that made it (kept also when the object
 * leaves the board). A scene that changes or brings back an earlier object names it so in its record (StoryItem.of).
 */
const stageOwners = new Map<number, [string, string]>()

function adoptEpoch(epoch: string | undefined): void {
  if (!epoch || epoch === stageRecord.epoch) return
  stageRecord.epoch = epoch
  if (stageRecord.items.size) stageRecord.revision++
  stageRecord.items.clear()
  stageOwners.clear()
  sceneReverts.clear()
  clearRestored()
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
/** The drafts kept at most. */
const MAX_DRAFTS = 8
/** The bytes of the frames of the drafts and of the replay history together, at most. A stream counts as it grows. */
const MAX_SCENE_BYTES = 128 * 1024 * 1024

/**
 * Keep the scenes' frames inside the budget, at each insert and each chunk.
 * Finished scenes go first, the oldest first: a replay runs their program
 * again from the record (decision B22). Then the oldest drafts. Main runs a
 * dropped draft again. What plays now, what a replay or a preview holds
 * (scenePlayer.keepPlay) and the newest draft stay, whatever their size.
 */
function trimScenes(): void {
  let bytes = scenePlayer.heldBytes()
  for (const entry of drafts.values()) bytes += entry.frames.bytes
  if (bytes > MAX_SCENE_BYTES) bytes -= scenePlayer.release(bytes - MAX_SCENE_BYTES)
  for (const [old, entry] of drafts) {
    if (drafts.size <= 1 || (drafts.size <= MAX_DRAFTS && bytes <= MAX_SCENE_BYTES)) break
    drafts.delete(old)
    bytes -= entry.frames.bytes
  }
}

onFramesGrowth(trimScenes)
scenePlayer.onFree(trimScenes)

function keepDraft(key: string, draft: CompiledDraft): void {
  drafts.delete(key)
  drafts.set(key, draft)
  trimScenes()
}

/**
 * The frames of each object from its run, checked against the description (same kind). While the stream is open every
 * dynamic object gets its live entry, so samples can still start. Once it has ended, an object with no samples has none to play.
 */
function dynLookup(frames: RunFrames): DynLookup {
  return (object) => {
    if ((object.kind !== 'shape' && object.kind !== 'ink' && object.kind !== 'text' && object.kind !== 'live') || object.sid === undefined) return undefined
    const math = object.kind === 'text' && !!object.math
    if (frames.ended && !frames.objects.get(object.sid)?.samples.length) return undefined
    const found = objectOf(frames, object.sid, object.kind, math)
    if (found.kind !== object.kind || found.math !== math) throw new Error(`The frames of ${object.api} ${object.sid ?? object.id} do not match the scene. Write the scene again.`)
    return found
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
    compiled: compileScene(desc, sceneAt(s, place && { scenes: place.scenes.slice(0, 1) }).scene, newItemId('sc'), null, stageLookup, dynLookup(frames), frames),
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
  // A stream that was cut leaves a draft with missing moments: it runs again.
  const stop = draft?.frames.stopped()
  if (!draft || (stop && !stop.failed) || draft.summary.stage !== stageRecord.epoch) return null
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
  // A failed stream stays as a draft for preview_scene, and it never plays. It can fail while the start waits for the stage.
  const stop = draft.frames.stopped()
  if (stop?.failed) throw new Error(`The draft "${name}" cannot start: its sweep failed, and it is complete only up to ${stop.at} s. Nothing played, and the draft is kept. Change it with write_scene.`)
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
  // A constant dynamic ink has an empty dyn: its strokes are on the board, not in the stream.
  if (object.dyn && (object.dyn.samples.length || object.dyn.seeds.length)) {
    object.settled = Math.max(object.settled, object.dyn.end)
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
  object.dyn = { kind: 'ink', seeds: [], samples: [{ t: 0, bounds: none, lines: packLines(lines), width }], end: Number.POSITIVE_INFINITY, finalBounds: none, centered: false, ink: { color, width, tool } }
}

/** Commit a compiled scene's final state (a new undo step, or part of the keyed step `step`) and list its items. starts_in_s is filled in by the caller. */
function commitScene(ctx: RunSceneContext, desc: SceneSummary, compiled: CompiledScene, step: string | null): CommittedScene {
  const s = ctx.scene()
  const sceneId = compiled.play.id
  ctx.board.agentCommit(compiled.base, compiled.next, step ? { step } : undefined)
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
  const stepOf = (objectId: number): string | undefined => compiled.play.steps[stepOfObject(compiled.play, objectId)]?.name
  const items: SceneItem[] = []
  const framed = (objectId: number): boolean => {
    for (let current = timeline.object(objectId).parent; current !== undefined; current = timeline.object(current).parent) if (compiled.frames.some((frame) => frame.object === current)) return true
    return false
  }
  for (const frame of compiled.frames) {
    const desc = timeline.object(frame.object)
    if (desc.sid !== undefined) stageRecord.items.set(desc.sid, { nodeIds: [frame.id] })
    if (desc.sid !== undefined && desc.key && !desc.carry) stageOwners.set(desc.sid, [sceneId, desc.key])
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
    if (desc.sid !== undefined && desc.key && !desc.carry && desc.kind !== 'node') stageOwners.set(desc.sid, [sceneId, desc.key])
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
  for (const object of allObjects(compiled.play)) {
    if (object.ghost) continue
    for (const target of object.targets) {
      const node = byId.get(target.nodeId)
      if (!node || snapshot.has(node.id)) continue
      const placed = layout.get(node.id)
      const box = placed && ownBox(placed)
      const ghost = isInk(node) ? { ...node, parent: undefined, x: box?.ox ?? node.x, y: box?.oy ?? node.y } : { ...node, parent: undefined, x: box?.x ?? (node as ContentNode).x, y: box?.y ?? (node as ContentNode).y }
      snapshot.set(node.id, { sig: nodeSig(node), ghost: ghost as BoardNode })
    }
  }
  stageRecord.revision++
  // Each changed node as the scene left it (after the measures): a later revert keeps a node edited since.
  const after = new Map(state.nodes.map((node) => [node.id, node]))
  compiled.revert.after = Object.fromEntries(compiled.revert.changed.flatMap((node) => (after.has(node.id) ? [[node.id, contentSig(after.get(node.id) as BoardNode)]] : [])))
  // The board's id: the first scene record of a board gives it one (spec section 2); main writes the record.
  let boardId = ctx.board.boardId()
  const newBoard = !boardId
  if (!boardId) {
    boardId = newItemId('b')
    ctx.board.setBoardId(boardId)
  }
  const result: SceneResult = {
    scene: sceneId,
    duration_s: Math.round(desc.duration * 1000) / 1000,
    starts_in_s: 0,
    steps: desc.steps.map((step) => ({ name: step.name, at_s: step.at, ...(step.pause ? { pause: true } : {}) })),
    items,
    cues: desc.cues.map((cue) => ({ text: cue.text, at_s: cue.at, dur_s: cue.dur, ...(cue.marks?.length ? { marks: Object.fromEntries(cue.marks.map((mark) => [mark.name, mark.at])) } : {}) })),
    log: desc.logs,
    ...(ctx.where ? { record: { board: boardId, root: ctx.where.root, path: ctx.where.path, ...(newBoard ? { newBoard: true } : {}), story: storyOf(compiled, desc, state.nodes), revert: compiled.revert, settle: settleOf(compiled, state.nodes) } } : {})
  }
  return { compiled, result, snapshot }
}

/**
 * What the board measured at a commit (SceneSettle), for a replay after a restart: each node the scene made or
 * changed whose place or size the board set after the compile (settleLayout: centred text, fitted frames and what
 * they hold), and the glide start of each item that went into a frame (measureGlides).
 */
function settleOf(compiled: CompiledScene, after: readonly BoardNode[]): SceneSettle {
  const compiledNodes = new Map(compiled.next.map((node) => [node.id, node]))
  const ids = new Set([...compiled.revert.created, ...compiled.revert.changed.map((node) => node.id)])
  const nodes: SceneSettle['nodes'] = []
  for (const node of after) {
    const before = compiledNodes.get(node.id)
    if (!before || before === node || !ids.has(node.id)) continue
    const now = node as { x?: unknown; y?: unknown }
    const was = before as { x?: unknown; y?: unknown }
    if (typeof now.x !== 'number' || typeof now.y !== 'number') continue
    const size = (key: 'width' | 'height'): string | null => (isContent(node) && isContent(before) && node.style[key] !== before.style[key] ? (node.style[key] ?? null) : null)
    const width = size('width')
    const height = size('height')
    if (now.x !== was.x || now.y !== was.y || width !== null || height !== null) nodes.push([node.id, now.x, now.y, width, height])
  }
  const glides: SceneSettle['glides'] = []
  for (const object of compiled.play.objects) {
    if (!object.glide || (!object.glide.from[0] && !object.glide.from[1])) continue
    const first = compiled.reparented.find((entry) => entry.object === object.id)
    if (first) glides.push([first.nodeId, object.glide.from[0], object.glide.from[1]])
  }
  return { nodes, glides }
}

/**
 * The story of a committed scene for its record (shared/scene-story.ts): its steps with their
 * lines, its lines, and which board nodes each object became (made) or changed, with the step.
 * present: the node ids on the board after the commit. Membership comes from the commit's revert,
 * which holds every change kind (the nodes the scene made, and the ones it changed by an action,
 * an edit() or a move into a frame); the step of a change is the time of its first change (changeTime).
 */
function storyOf(compiled: CompiledScene, desc: SceneSummary, after: readonly BoardNode[]): SceneStory {
  const byId = new Map(after.map((node) => [node.id, node]))
  const present: ReadonlySet<string> = new Set(byId.keys())
  const play = compiled.play
  const timeline = play.timeline
  const created = new Set(compiled.revert.created)
  const changed = new Set(compiled.revert.changed.map((node) => node.id))
  const keys = objectKeys(play)
  const items: StoryItem[] = []
  const stepIndex = (k: number): number | null => (k >= 0 ? k : null)
  const nodesOf = (object: PlayObject): string[] => [...new Set(object.records ?? object.targets.map((target) => target.nodeId))].filter((id) => present.has(id))
  for (const object of play.objects) {
    if (object.ghost) continue
    const o = timeline.object(object.id)
    if (o.kind === 'group') continue
    const nodes = nodesOf(object)
    // The stage object of an earlier scene that this scene changed or brought back: its owner, and every node it shows through now.
    const owner = o.kind !== 'node' && o.sid !== undefined && !keys.has(object.id) ? stageOwners.get(o.sid) : undefined
    const of = owner ? { of: owner, held: nodes } : {}
    if (o.kind === 'node' || o.carry) {
      // An item that was on the board before: in the story when this scene changed it, at the step of its first change.
      const touched = nodes.filter((id) => changed.has(id) || created.has(id))
      if (touched.length) items.push({ key: `node:${touched[0]}`, nodes: touched, step: stepIndex(stepAt(play.steps, changeTime(play, object))), made: false, sigs: touched.map((id) => contentSig(byId.get(id) as BoardNode)), ...of })
      continue
    }
    const key = keys.get(object.id)
    if (nodes.length && key) items.push({ key, nodes, step: stepIndex(stepOfObject(play, object.id)), made: true, sigs: nodes.map((id) => contentSig(byId.get(id) as BoardNode)) })
    // An earlier object this scene brings back (it was gone): new nodes, made here, for that object.
    else if (nodes.length && owner) items.push({ key: `node:${nodes[0]}`, nodes, step: stepIndex(stepOfObject(play, object.id)), made: true, sigs: nodes.map((id) => contentSig(byId.get(id) as BoardNode)), ...of })
  }
  // The frames of named groups: the step of the group's first object.
  for (const { object: objectId, id: frameId } of compiled.frames) {
    if (!present.has(frameId)) continue
    const leaf = play.objects.find((object) => {
      for (let current = timeline.object(object.id).parent; current !== undefined; current = timeline.object(current).parent) if (current === objectId) return true
      return false
    })
    const key = keys.get(objectId)
    if (key) items.push({ key, nodes: [frameId], step: leaf ? stepIndex(stepOfObject(play, leaf.id)) : null, made: true, sigs: [contentSig(byId.get(frameId) as BoardNode)] })
  }
  // Every other node the commit made or changed (the revert sees every change kind, also what the
  // compile moved itself, such as learner ink kept in replaced HTML material): the step of the item
  // that now holds it (its nearest parent in the story), else none.
  const listed = new Set(items.flatMap((item) => item.nodes))
  const stepOfNode = new Map(items.flatMap((item) => item.nodes.map((id) => [id, item.step] as const)))
  for (const id of [...created, ...changed]) {
    if (listed.has(id) || !present.has(id)) continue
    let step: number | null = null
    for (let parent = byId.get(id)?.parent; typeof parent === 'string'; parent = byId.get(parent)?.parent) {
      if (stepOfNode.has(parent)) {
        step = stepOfNode.get(parent) ?? null
        break
      }
    }
    const made = created.has(id)
    items.push({ key: `node:${id}`, nodes: [id], step, made, sigs: [contentSig(byId.get(id) as BoardNode)] })
    listed.add(id)
  }
  return {
    duration: desc.duration,
    steps: play.steps.map((step) => ({ name: step.name, at: step.at, ...(step.pause ? { pause: true } : {}), lines: step.lines ?? [] })),
    lines: desc.cues.map((cue) => ({ text: cue.text, at: cue.at, dur: cue.dur, ...(cue.voice ? { voice: cue.voice } : {}) })),
    items
  }
}

/**
 * The key of every object this scene made (spec section 4), as the stage gave it when the program
 * made it (stage/live-prelude.js keyFor), so a key never depends on what survives to the end or on
 * the stage-wide id: its name (name#2, #3 … when the scene repeats a name), else o<n>, its order of
 * creation in the scene. A re-run of the program gives its objects the same keys. Objects of earlier
 * scenes (carried) and board.node() references have none; the nodes of an object without a key are
 * in the story by node id.
 */
function objectKeys(play: CompiledScene['play']): Map<number, string> {
  const keys = new Map<number, string>()
  for (let id = 0; id < play.timeline.tracks.length; id++) {
    const o = play.timeline.object(id)
    if (o.kind === 'node' || o.carry || !o.key) continue
    keys.set(id, o.key)
  }
  return keys
}

/** When a scene first changes an object it did not make: its first action, edit() of one of its nodes, or move into a frame; else when the scene took hold of it. */
function changeTime(play: CompiledScene['play'], object: PlayObject): number {
  let first = Infinity
  for (const list of Object.values(play.timeline.tracks[object.id])) for (const action of list ?? []) first = Math.min(first, action.start)
  const nodes = new Set(object.targets.map((target) => target.nodeId))
  for (const edit of play.edits ?? []) if (nodes.has(edit.nodeId)) first = Math.min(first, edit.at)
  if (object.glide) first = Math.min(first, object.glide.start)
  return first === Infinity ? play.timeline.object(object.id).created : first
}

/**
 * runScene: commit the scene and queue it. With `slot`, the scene takes the
 * place of the queued or playing scene with the same id (replace, cut),
 * keeping its place in the queue and its clock. `step`: the key of the
 * undo step the commit joins (a restage's reverts and commits are one step).
 * `nodeIds`: the id (and z) the compile's new nodes take, in their order
 * (a restage's rollback commits an earlier program again as its nodes
 * were); kept_ids says whether they matched.
 */
export function runScene(ctx: RunSceneContext, args: Record<string, unknown>): (SceneResult & { ends_in_s: number; kept_ids?: boolean }) | DraftMissing {
  sameBoard(ctx, args)
  const sceneId = typeof args.sceneId === 'string' && args.sceneId ? args.sceneId : newItemId('sc')
  const name = typeof args.name === 'string' && args.name ? args.name : null
  let desc: SceneSummary
  let compiled: CompiledScene
  if (args.scene) {
    const full = checkDescription(args.scene, name)
    const frames = takeFrames(args.job, args.frames)
    adoptEpoch(full.stage)
    compiled = compileScene(full, ctx.scene(), sceneId, name, stageLookup, dynLookup(frames), frames)
    desc = full
  } else {
    // A draft compiled before (write_scene): its compile becomes the scene.
    const draft = takeDraft(ctx, args.draft, sceneId, name)
    if (!draft) return { draftMissing: true }
    ;({ summary: desc, compiled } = draft)
  }
  const nodeIds = Array.isArray(args.nodeIds) ? (args.nodeIds as Array<[string, number | null]>) : null
  const keptIds = !!nodeIds && nodeIds.length === compiled.revert.created.length
  if (nodeIds && keptIds) {
    renameNodes(compiled, new Map(compiled.revert.created.map((id, k) => [id, nodeIds[k][0]])))
    const z = new Map(nodeIds.filter(([, value]) => value !== null))
    compiled.next = compiled.next.map((node) => (z.has(node.id) ? ({ ...node, z: z.get(node.id) } as BoardNode) : node))
  }
  const { result, snapshot } = commitScene(ctx, desc, compiled, typeof args.step === 'string' && args.step ? args.step : null)
  const revert = revertOf(ctx.board, sceneId)
  sceneReverts.set(sceneId, compiled.revert)
  let startsIn: number
  // settled: the scene goes back on the board in its end state and does not play (a failed replace of a scene that had played).
  if (args.settled === true) startsIn = 0
  else if (args.slot === true && scenePlayer.swap(ctx.board, sceneId, compiled.play, revert, args.slotWhy === 'cut' ? 'cut' : 'replaced')) startsIn = scenePlayer.startsIn(sceneId)
  else startsIn = scenePlayer.enqueue(ctx.board, compiled.play, { mode: args.when === 'now' ? 'now' : 'queue', revert })
  const { record } = result
  scenePlayer.remember({ play: compiled.play, snapshot, ...(record ? { record: { id: sceneId, name, story: record.story, revert: record.revert, settle: record.settle ?? null } } : {}) })
  trimScenes()
  forgetRestored(sceneId)
  // A playing scene (cut) started before now: its start is negative, its end is still ahead.
  result.starts_in_s = Math.max(0, startsIn)
  return { ...result, ends_in_s: Math.round((startsIn + result.duration_s) * 1000) / 1000, ...(nodeIds ? { kept_ids: keptIds } : {}) }
}

/** A scene of the stage that main rebuilt from the records (main/mcp.ts restoreStage); a malformed line gives only its id and name. */
interface RestoreArgs {
  id: string
  name: string | null
  story?: SceneStory
  revert?: StoryRevert
  settle?: SceneSettle | null
}

/**
 * sceneRestore: the renderer's part of a stage that main rebuilt from the board's records (each
 * board mount: after a restart, another board, a window that loaded again), so the board works with
 * those scenes as in one session. The new epoch drops what the renderer held of an earlier stage.
 * Then the stage's identities (keys: stage id, scene id and key of each object) and failures, the
 * scenes' reverts (a replace takes their items off), the stage's record (a new scene finds their
 * objects on the board: each object's key gives its nodes in the record's story.items, and the
 * changes later scenes made to an object, StoryItem.of and held, are folded in stage order), and the
 * restored scenes, which a replay rebuilds (sceneMemory). Nothing on the board changes. stale: the
 * board is not the one main restored (another board mounted meanwhile); main starts again.
 */
export function sceneRestore(ctx: RunSceneContext, args: Record<string, unknown>): { restored: number } | { stale: true } {
  if ((ctx.board.boardId() ?? null) !== (typeof args.boardId === 'string' ? args.boardId : null)) return { stale: true }
  adoptEpoch(typeof args.epoch === 'string' ? args.epoch : undefined)
  scenePlayer.adopt(ctx.board)
  // The owner of each object the rebuild made: stage ids never shift (main/live-scene.ts StageEntry.range), so this holds for the epoch.
  for (const [sid, scene, key] of Array.isArray(args.keys) ? (args.keys as Array<[number, string, string]>) : []) stageOwners.set(sid, [scene, key])
  setFailed(Array.isArray(args.failed) ? (args.failed as Array<[string, string]>) : [])
  const s = ctx.scene()
  const list = Array.isArray(args.scenes) ? (args.scenes as RestoreArgs[]) : []
  const restored: RestoredScene[] = []
  const nodeEntry = (ids: readonly string[]): { nodeIds: string[]; group?: string } => {
    const group = s.groups.find((entry) => entry.strokes.includes(ids[0]))?.id
    return { nodeIds: [...ids], ...(group ? { group } : {}) }
  }
  const sidOf = new Map([...stageOwners].map(([sid, [scene, key]]) => [`${scene}\0${key}`, sid]))
  for (const scene of list) {
    if (!scene.story || !scene.revert) continue
    for (const item of scene.story.items) {
      const sid = item.of ? sidOf.get(`${item.of[0]}\0${item.of[1]}`) : item.made && !item.key.startsWith('node:') ? sidOf.get(`${scene.id}\0${item.key}`) : undefined
      const nodeIds = item.of ? item.held : item.nodes
      if (sid !== undefined && nodeIds?.length) stageRecord.items.set(sid, nodeEntry(nodeIds))
    }
    sceneReverts.set(scene.id, { created: [...scene.revert.created], changed: scene.revert.changed as BoardNode[], removed: scene.revert.removed as BoardNode[], ...(scene.revert.after ? { after: scene.revert.after } : {}) })
    restored.push({ id: scene.id, name: scene.name, story: scene.story, revert: scene.revert, settle: scene.settle ?? null })
  }
  stageRecord.revision++
  setRestored(restored)
  return { restored: restored.length }
}

/**
 * sceneMemory: a restored scene's program ran again on the rebuilt stage (main/live-scene.ts
 * resample); its run becomes the player's memory of the scene, so it replays as in one session.
 * Nothing is committed: its items are on the board. The run compiles on the board as it was before
 * the scene (args.place: the scene and the ones after it come off, by their recorded before-state:
 * sceneAt exact), then each node it makes takes the id of the board's node (recordIds). The board's
 * measures at the commit (settle) are applied. A node that the board no longer shows as the scene left
 * it shows as a ghost, as in one session. error: the re-run does not match the record (main marks the
 * scene).
 */
export function sceneMemory(ctx: RunSceneContext, args: Record<string, unknown>): { ok: true } | { error: string } | { stale: true } {
  const sceneId = String(args.sceneId)
  let frames: RunFrames
  try {
    // Taken first, also when the run is no longer wanted: the frames of a run are the board's to drop.
    frames = takeFrames(args.job, args.frames)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  // A board that mounted since holds no restored scenes of the board before (scenePlayer.detach).
  const info = restoredScene(sceneId)
  if (!info) return { stale: true }
  try {
    const desc = checkDescription(args.scene, info.name)
    if (desc.stage !== stageRecord.epoch) return { stale: true }
    const before = sceneAt(ctx.scene(), (args.place as ScenePlace | undefined) ?? { scenes: [{ id: sceneId, name: info.name ?? sceneId }] }, true).scene
    const compiled = compileScene(desc, before, sceneId, info.name, stageLookup, dynLookup(frames), frames)
    renameNodes(compiled, recordIds(compiled, info.story, info.revert.created))
    applySettle(compiled, info.settle)
    // Main holds what it asks for (holdPlay), so the scene is still here when its replay starts.
    scenePlayer.remember({ play: compiled.play, snapshot: restoredSnapshot(compiled, info.story, ctx.board), record: info })
    trimScenes()
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The board node id of each node a re-run made (re-run id → record id). An object's key gives its
 * nodes in the record's story.items, in their order (the same filter as storyOf: the nodes it shows
 * through at the end); an earlier object that the scene brought back goes by its owner (StoryItem.of);
 * the nodes of no object go in their order of creation (the record's revert.created). Throws when the
 * re-run and the record do not have the same objects and nodes: never maps a node to another object's.
 */
function recordIds(compiled: CompiledScene, story: SceneStory, recordCreated: readonly string[]): Map<string, string> {
  const play = compiled.play
  const keys = objectKeys(play)
  const made = new Set(compiled.revert.created)
  const present = new Set(compiled.next.map((node) => node.id))
  const recorded = new Map<string, string[]>()
  for (const item of story.items) {
    if (!item.made) continue
    const key = item.of ? `of:${item.of[0]}\0${item.of[1]}` : item.key.startsWith('node:') ? null : item.key
    if (key === null) continue
    if (recorded.has(key)) throw new Error(`the record has the object "${key}" twice`)
    recorded.set(key, item.nodes)
  }
  const map = new Map<string, string>()
  const paired = new Set<string>()
  const pair = (key: string, ids: string[]): void => {
    const nodes = recorded.get(key)
    if (!nodes) throw new Error(`the object "${key}" is not in the record`)
    if (paired.has(key)) throw new Error(`two objects have the key "${key}"`)
    if (nodes.length !== ids.length) throw new Error(`the object "${key}" makes ${ids.length} items now and ${nodes.length} in the record`)
    ids.forEach((id, k) => {
      if (made.has(id)) map.set(id, nodes[k])
      else if (id !== nodes[k]) throw new Error(`the object "${key}" shows through other items than in the record`)
    })
    paired.add(key)
  }
  for (const object of play.objects) {
    if (object.ghost) continue
    const o = play.timeline.object(object.id)
    if (o.kind === 'group' || o.kind === 'node' || o.carry) continue
    const owner = !keys.has(object.id) && o.sid !== undefined ? stageOwners.get(o.sid) : undefined
    const key = keys.get(object.id) ?? (owner ? `of:${owner[0]}\0${owner[1]}` : undefined)
    if (!key) continue
    const ids = [...new Set(object.records ?? object.targets.map((target) => target.nodeId))].filter((id) => present.has(id))
    if (ids.length) pair(key, ids)
  }
  for (const { object, id } of compiled.frames) {
    const key = keys.get(object)
    if (key && present.has(id)) pair(key, [id])
  }
  for (const key of recorded.keys()) if (!paired.has(key)) throw new Error(`the object "${key}" of the record is not made now`)
  const taken = new Set(map.values())
  const rest = compiled.revert.created.filter((id) => !map.has(id))
  const recordRest = recordCreated.filter((id) => !taken.has(id))
  if (rest.length !== recordRest.length) throw new Error(`${rest.length} items inside material now and ${recordRest.length} in the record`)
  rest.forEach((id, k) => map.set(id, recordRest[k]))
  return map
}

/** Give a compiled scene's nodes other ids (old → new), everywhere the compile names them. */
function renameNodes(compiled: CompiledScene, map: ReadonlyMap<string, string>): void {
  const r = (id: string): string => map.get(id) ?? id
  const node = <T extends BoardNode>(entry: T): T => {
    const parent = (entry as { parent?: unknown }).parent
    const follows = (entry as { follows?: NodeFollows }).follows
    return { ...entry, id: r(entry.id), ...(typeof parent === 'string' ? { parent: r(parent) } : {}), ...(follows ? { follows: renamedFollows(follows, r) } : {}) }
  }
  const followed = <T extends { follows?: { world: number | string; point: string } }>(action: T): T => (typeof action.follows?.world === 'string' ? { ...action, follows: { ...action.follows, world: r(action.follows.world) } } : action)
  compiled.next = compiled.next.map(node)
  const play = compiled.play
  play.ghosts = play.ghosts.map(node)
  play.camera = play.camera.map(followed)
  play.pointer = play.pointer.map(followed)
  for (const object of play.objects) {
    object.targets = object.targets.map((target) => ({ ...target, nodeId: r(target.nodeId) }))
    if (object.records) object.records = object.records.map(r)
  }
  if (play.edits) play.edits = play.edits.map((edit) => ({ ...edit, nodeId: r(edit.nodeId) }))
  if (play.vanish) play.vanish = play.vanish.map((entry) => ({ ...entry, ids: entry.ids.map(r) }))
  compiled.centers = compiled.centers.map((entry) => ({ ...entry, nodeId: r(entry.nodeId) }))
  compiled.frames = compiled.frames.map((entry) => ({ ...entry, id: r(entry.id) }))
  compiled.reparented = compiled.reparented.map((entry) => ({ ...entry, nodeId: r(entry.nodeId) }))
  compiled.inkGroups = compiled.inkGroups.map((entry) => ({ ...entry, strokes: entry.strokes.map(r) }))
  compiled.contentIds = compiled.contentIds.map(r)
  compiled.nodesOf = new Map([...compiled.nodesOf].map(([object, ids]) => [object, ids.map(r)]))
  compiled.revert = { ...compiled.revert, created: compiled.revert.created.map(r) }
}

/** The board's measures at the commit (SceneSettle) on a re-run: what settleLayout and measureGlides did, from the record. */
function applySettle(compiled: CompiledScene, settle: SceneSettle | null): void {
  if (!settle) return
  const at = new Map(compiled.next.map((node, i) => [node.id, i]))
  const centred = new Set(compiled.centers.map((entry) => entry.nodeId))
  for (const [id, x, y, width, height] of settle.nodes) {
    const i = at.get(id)
    if (i === undefined) continue
    const node = compiled.next[i]
    const was = node as unknown as { x: number; y: number }
    const shift: Point = [x - was.x, y - was.y]
    const sized = isContent(node) && (width !== null || height !== null) ? { style: { ...node.style, ...(width !== null ? { width } : {}), ...(height !== null ? { height } : {}) } } : {}
    compiled.next[i] = { ...node, x, y, ...sized } as BoardNode
    // Text centred once measured: its look while it plays stays where the program put it (as settleLayout does).
    if (!centred.has(id) || (!shift[0] && !shift[1])) continue
    for (const object of compiled.play.objects) for (const target of object.targets) if (target.nodeId === id) target.inverseBaked = multiply(target.inverseBaked, [1, 0, 0, 1, -shift[0], -shift[1]])
  }
  for (const [id, fx, fy] of settle.glides) {
    const entry = compiled.reparented.find((reparented) => reparented.nodeId === id)
    const object = entry ? compiled.play.objects.find((play) => play.id === entry.object) : undefined
    if (object?.glide) object.glide.from = [fx, fy]
  }
}

/**
 * The scene's items as it left them, for a replay of a re-run (commitScene's snapshot): a node the
 * board shows as the scene left it (the record's signature) plays on the board's node; any other
 * (moved, changed or deleted since) shows as a ghost of the re-run's node, in world coordinates.
 */
function restoredSnapshot(compiled: CompiledScene, story: SceneStory, board: BoardHandle): SceneMemory['snapshot'] {
  const state = board.liveState()
  const layout = state.layout()
  const onBoard = new Map(state.nodes.map((node) => [node.id, node]))
  const recorded = new Map<string, string>()
  for (const item of story.items) item.nodes.forEach((id, k) => item.sigs?.[k] !== undefined && recorded.set(id, item.sigs[k]))
  const byId = new Map(compiled.next.map((node) => [node.id, node]))
  const snapshot: SceneMemory['snapshot'] = new Map()
  for (const object of allObjects(compiled.play)) {
    if (object.ghost) continue
    for (const target of object.targets) {
      const id = target.nodeId
      const node = byId.get(id)
      if (!node || snapshot.has(id)) continue
      const now = onBoard.get(id)
      const sig = recorded.get(id)
      // No signature (a record from before 2026-10-29): unknown, so the node shows as a ghost of the re-run.
      const same = !!now && sig !== undefined && contentSig(now) === sig
      const placed = same || (now && isFlowed(node, byId)) ? layout.get(id) : undefined
      const box = placed && ownBox(placed)
      snapshot.set(id, { sig: same && now ? nodeSig(now) : '', ghost: worldGhost(node, byId, box) })
    }
  }
  return snapshot
}

/** A node as a top-level ghost in world coordinates: by its measured box, else its place plus its ancestors'. */
function worldGhost(node: BoardNode, byId: ReadonlyMap<string, BoardNode>, box: { x: number; y: number; ox?: number; oy?: number } | undefined): BoardNode {
  const own = node as unknown as { x: number; y: number }
  if (box) return (isInk(node) ? { ...node, parent: undefined, x: box.ox ?? own.x, y: box.oy ?? own.y } : { ...node, parent: undefined, x: box.x, y: box.y }) as BoardNode
  let x = own.x
  let y = own.y
  for (let parent = node.parent as string | undefined; typeof parent === 'string'; parent = byId.get(parent)?.parent as string | undefined) {
    const up = byId.get(parent) as unknown as { x?: number; y?: number } | undefined
    if (!up) break
    x += up.x ?? 0
    y += up.y ?? 0
  }
  return { ...node, parent: undefined, x, y } as BoardNode
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
  /** The learner's view at this moment (after the scene's camera moves so far), and the parts of it that app UI covers. */
  view: Box
  covered: Covered[]
}

/**
 * The camera at time t of a scene that starts from `start`, as the player moves it (player.ts):
 * each camera move glides from where the view is when it starts (also in the middle of an
 * earlier glide) to its target over its length, with Board.animateTo's ease (glideCamera).
 */
function cameraAt(start: Camera, moves: ReadonlyArray<{ start: number; dur: number; center: [number, number]; zoom: number }>, t: number): Camera {
  let glide: { from: Camera; to: Camera; start: number; dur: number } | null = null
  const at = (time: number): Camera => (glide ? glideCamera(glide.from, glide.to, (time - glide.start) / glide.dur) : start)
  for (const move of [...moves].sort((a, b) => a.start - b.start)) {
    // The player starts a move on the first frame after its start.
    if (move.start >= t) break
    glide = { from: at(move.start), to: { center: move.center, zoom: clampZoom(move.zoom) }, start: move.start, dur: Math.max(0.001, move.dur) }
  }
  return at(t)
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
  background: string
}


const fmt = (t: number): string => `${Math.round(t * 10) / 10} s`
const r3 = (value: number): number => Math.round(value * 1000) / 1000

/** The index of the step an object appears in (its first reveal when it starts hidden, else when it is made), or -1 (before the first step, or a group). */
export function stepOfObject(play: CompiledScene['play'], objectId: number): number {
  const timeline = play.timeline
  const desc = timeline.object(objectId)
  if (desc.kind === 'group') return -1
  const reveal = (timeline.tracks[objectId].draw ?? []).find((a) => typeof a.to === 'number' && a.to > 0)?.start ?? (timeline.tracks[objectId].opacity ?? []).find((a) => typeof a.to === 'number' && a.to > 0)?.start
  return stepAt(play.steps, desc.vis === 'hidden' ? (reveal ?? desc.created) : desc.created)
}

/**
 * The end of write_scene's sampling pass: compile the draft (its description
 * and its frames, args.job) against the board now (nothing is committed) for
 * a short list of what it makes. The compile is kept under
 * the key args.draft for the preview and the commit.
 */
export function sceneDraft(ctx: RunSceneContext, args: Record<string, unknown>): DraftInfo {
  const desc = checkDescription(args.scene, typeof args.name === 'string' && args.name ? args.name : null)
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
    const step = play.steps[stepOfObject(play, object.id)]?.name
    if (o.name) named.push({ name: o.name, kind, ...(step ? { step } : {}) })
  }
  for (const frame of compiled.frames) {
    const o = play.timeline.object(frame.object)
    total++
    byKind.group = (byKind.group ?? 0) + 1
    if (o.name) named.push({ name: o.name, kind: 'group' })
  }
  const steps = sceneSteps(desc.steps, desc.duration)
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
  for (const object of allObjects(play)) {
    // A changing shape: the bounds of its sample of now, where its object is now.
    const samples = object.dyn?.kind === 'shape' ? liveSamples(play, object, t) : null
    let sample = samples?.[0]
    if (samples) for (const entry of samples) if (entry.t <= t) sample = entry
    for (const target of object.targets) {
      if (sample) {
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
  const stepLabel = (t: number): string => {
    const name = play.steps[stepAt(play.steps, t)]?.name
    return name ? ` · step "${name}"` : ''
  }
  for (const moment of moments) {
    if (moment.kind === 'end') out.push({ t: play.duration, label: `end · ${fmt(play.duration)}` })
    else if (moment.kind === 't') {
      if (moment.t > play.duration + 1e-6) throw new Error(`The time ${moment.t} s is past the end of ${what}: it is ${fmt(play.duration)} long. Use a time from 0 to ${Math.round(play.duration * 1000) / 1000}, or "end".`)
      out.push({ t: moment.t, label: `${fmt(moment.t)}${stepLabel(moment.t)}` })
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
        const step = play.steps[stepAt(play.steps, from)]
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
 * moments, of the given part of the board. The learner's board does not change. A time past what the
 * sweep has reached is seeded on demand, with no wait for the sweep; "end" and steps read the seeds.
 */
export async function sceneFrames(ctx: RunSceneContext, args: Record<string, unknown>): Promise<FramesResult | DraftMissing | { pastCutoff: number } | { momentFailed: MomentsFailure }> {
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
  const asked = (args.moments as FrameMoment[] | undefined) ?? [{ kind: 'end' }]
  const moments = momentsOf(play, asked, what)
  // A live item draws at its tick, which can be just before the moment.
  const failed = await play.moments(asked.flatMap((moment) => (moment.kind === 't' ? [moment.t, timeOfTick(tickOf(moment.t))] : [])))
  if (failed) return { momentFailed: failed }
  // The end is the committed state, so a stream that stopped still shows it. Any other moment past the cutoff does not exist.
  const stop = play.stopped()
  if (stop && moments.some((moment) => moment.t > stop.at && moment.t < play.duration)) return { pastCutoff: stop.at }
  // Each moment evaluated once: the drawn overrides, and the boxes that framing and live stills use.
  const ends = endBoxes(play, s, nodes)
  const evaluated = moments.map((moment) => {
    const frame: SceneFrame = { overrides: new Map(), tips: [], inks: [] }
    sceneFrame(play, moment.t, inkIndex, frame)
    return { moment, frame, boxes: frameBoxes(play, ends, frame, moment.t) }
  })
  const state = ctx.board.liveState()
  const view = rect(viewOf(ctx.board))
  // Each frame marks the learner's view and its covered parts for the camera at its moment.
  const marks = evaluated.map(({ moment }) => {
    const camera = cameraAt(state.camera, play.camera, moment.t)
    return { view: rect(viewOf(ctx.board, camera)), covered: coveredOf(ctx.board, camera) }
  })
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
    frames: evaluated.map(({ moment, frame }, i) => ({ t: r3(moment.t), label: moment.label, inks: frame.inks, overrides: [...frame.overrides], tips: frame.tips.filter((tip) => tip.kind === 'pointer'), ...marks[i] })),
    live: liveItemsOf(play, evaluated, nodes, s, region),
    rect: region,
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
  const ready = play.ready()
  for (const object of allObjects(play)) {
    for (const target of object.targets) ofScene.add(target.nodeId)
    if (play.timeline.object(object.id).kind !== 'live') continue
    // Past what the sweep has reached, the seeds.
    const known = object.dyn?.kind === 'live' ? [...object.dyn.samples, ...object.dyn.seeds.filter((seed) => seed.t > ready)] : []
    const samples = known.filter((sample) => sample.params).map((sample) => [sample.t, sample.params] as [number, Record<string, number>])
    for (const target of object.targets) timelines.set(target.nodeId, { params: samples.length ? samples : null, steps })
  }
  for (const node of play.ghosts) ofScene.add(node.id)
  const out: FramesLiveItem[] = []
  for (const node of nodes) {
    if (!isLive(node) || isOldLive(node)) continue
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
  const ids = (scenes: unknown): string[] => (Array.isArray(scenes) ? scenes.map(String) : [])
  // board_id: for main's record events (main/scene-store.ts), never for the agent.
  const status = (): Record<string, unknown> => ({ ...scenePlayer.status(), waiting: scenePlayer.waiting(), playing_scene: scenePlayer.playing(), board_id: ctx.board.boardId() ?? null })
  switch (action) {
    case 'next':
      scenePlayer.nextStep()
      return status()
    case 'known':
      // The player still holds this scene (it waits, plays, or is in the stage's history), or it was restored from the records (its revert is known).
      return { known: scenePlayer.isKnown(String(args.scene)) || sceneReverts.has(String(args.scene)) }
    case 'remembered': {
      // Of these scenes: the ones the player holds play data of, and the ones restored from the records (a re-run can rebuild them; main owns whether it can).
      const scenes = ids(args.scenes)
      return { held: scenes.filter((id) => scenePlayer.memory(id) !== undefined), restored: scenes.filter((id) => restoredScene(id) !== undefined) }
    }
    case 'status':
    case 'pause':
    case 'resume':
    case 'stop':
    case 'skip':
      scenePlayer.control(action)
      return status()
    case 'revert': {
      // Take scenes' items off the board again, to commit them anew. ids: in stage order; each scene's revert (sceneReverts,
      // the one owner, wherever its play data is) runs in reverse stage order, newest first. Main gets each scene's node ids
      // and their z (a rollback gives them back to its run: runScene nodeIds) and, for the scenes in keep (marked: their program cannot
      // run again), what the revert takes off (putBack).
      sameBoard(ctx, args)
      const ids = Array.isArray(args.scenes) ? (args.scenes as string[]) : []
      const keep = new Set(Array.isArray(args.keep) ? (args.keep as string[]) : [])
      const step = typeof args.step === 'string' && args.step ? args.step : newItemId('step')
      const created: Record<string, Array<[string, number | null]>> = {}
      const z = new Map(ctx.board.liveState().nodes.map((node) => [node.id, typeof node.z === 'number' ? node.z : null]))
      const taken: Record<string, { nodes: BoardNode[]; revert: SceneRevert }> = {}
      for (const id of [...ids].reverse()) {
        const revert = sceneReverts.get(id)
        if (!revert) continue
        created[id] = revert.created.map((nodeId) => [nodeId, z.get(nodeId) ?? null])
        if (keep.has(id)) {
          const touched = new Set([...revert.created, ...revert.changed.map((node) => node.id)])
          taken[id] = { nodes: ctx.board.liveState().nodes.filter((node) => touched.has(node.id)), revert }
        }
        revertScene(ctx.board, revert, step)
      }
      return { ...status(), created, taken }
    }
    case 'putBack': {
      // A marked scene that a cancelled restage took off (its program cannot run again): its items as the revert took them, while the board still shows each node as the revert left it.
      sameBoard(ctx, args)
      const id = String(args.scene)
      const { nodes, revert } = args.taken as { nodes: BoardNode[]; revert: SceneRevert }
      const left = new Map([...revert.changed, ...revert.removed].map((node) => [node.id, contentSig(node)]))
      const saved = new Map(nodes.map((node) => [node.id, node]))
      const removed = new Set(revert.removed.map((node) => node.id))
      const current = ctx.board.liveState().nodes
      const asLeft = (node: BoardNode): boolean => left.get(node.id) === contentSig(node)
      const next = current.flatMap((node) => (removed.has(node.id) && asLeft(node) ? [] : saved.has(node.id) && asLeft(node) ? [saved.get(node.id) as BoardNode] : [node]))
      const present = new Set(current.map((node) => node.id))
      for (const node of nodes) if (revert.created.includes(node.id) && !present.has(node.id)) next.push(node)
      ctx.board.agentCommit(current, next, { step: String(args.step) })
      sceneReverts.set(id, revert)
      scenePlayer.drop(id)
      return status()
    }
    case 'streamCut':
      cutJob(args.job, args.failed === true)
      return {}
    case 'holdPlay':
      // Main needs the play data of these scenes for its next calls (main/mcp.ts withPlayable).
      scenePlayer.keepPlay(ids(args.scenes))
      return {}
    case 'freePlay':
      scenePlayer.freePlay(ids(args.scenes))
      return {}
    case 'failures':
      // The stage's failure state after it changed (main/mcp.ts publishFailures): it replaces the renderer's copy.
      if (args.epoch !== stageRecord.epoch) return { applied: false }
      setFailed(Array.isArray(args.failed) ? (args.failed as Array<[string, string]>) : [])
      return { applied: true }
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
    case 'stepScene': {
      const found = scenePlayer.sceneOfStep(String(args.step))
      if ('error' in found) throw new Error(found.error)
      return found
    }
    case 'resetStage':
      adoptEpoch(typeof args.epoch === 'string' ? args.epoch : undefined)
      return status()
    default:
      throw new Error('action must be status, pause, resume, next, stop, skip or replay.')
  }
}
