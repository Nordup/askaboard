import { serializeNode, type BoardNode } from './board-format'
import type { SceneStep } from './live-scene'

/**
 * The story of a scene and the scene records (spec: docs/learning-space/drafts/
 * story-foundation-2026-10-27/spec.md, sections 1-6).
 *
 * The steps of a scene are computed once, by stepLines, when its description reaches the
 * board (renderer/live/run.ts): the player, the script panel, the agent's reads and the
 * record all read that one list. stepAt is the one rule for "the step at a time".
 *
 * A record file (.learning-space/scenes/<board id>.jsonl) holds one JSON line per event:
 * a scene line per accepted commit, a drop line when a scene leaves the stage without a new
 * version, a reset line on play_scene reset. Only the main process writes it (main/scene-store.ts).
 */

/** Two times this close are the same time. */
const SAME = 1e-6

/** The index of the step at time t (the last step that starts at or before t), or -1 before the first step. steps: in time order. */
export function stepAt(steps: readonly { at: number }[], t: number): number {
  let index = -1
  for (let i = 0; i < steps.length; i++) if (steps[i].at <= t + SAME) index = i
  return index
}

/**
 * The steps of a scene with their lines (indexes into lines), in time order. Each line belongs
 * to the step whose time contains it. When a line comes before the first step() (or the scene
 * has lines and no step), the scene gets a first step named after it (lead), at 0.
 */
export function stepLines(name: string | null, steps: readonly SceneStep[], lines: readonly { at: number }[]): SceneStep[] {
  const own = steps
    .filter((step) => !step.lead)
    .map((step, i) => ({ step, i }))
    .sort((a, b) => a.step.at - b.step.at || a.i - b.i)
    .map(({ step }) => {
      const { lines: _lines, ...rest } = step
      return { ...rest, lines: [] as number[] }
    })
  const first = own.length ? own[0].at : Infinity
  const out: SceneStep[] = lines.some((line) => line.at < first - SAME) ? [{ name: name || 'Scene', at: 0, lead: true, lines: [] }, ...own] : own
  lines.forEach((line, i) => {
    const index = stepAt(out, line.at)
    if (index >= 0) out[index].lines?.push(i)
  })
  return out
}

/** The steps a scene program wrote (without the lead step), for what reads step() calls only (code items). */
export const ownSteps = (steps: readonly SceneStep[]): SceneStep[] => steps.filter((step) => !step.lead)

// ---------- The record ----------

export interface StoryStep {
  name: string
  at: number
  pause?: boolean
  /** Indexes into the story's lines. */
  lines: number[]
}

export interface StoryLine {
  text: string
  at: number
  dur: number
}

/**
 * Which board nodes one scene object became. key: the object's name (name#2, #3 … when the
 * scene repeats a name), else o<n> (its order of creation in the scene); node:<id> for an item
 * the scene changed through board.node(). step: an index into the story's steps (null: before
 * the first step). made: the scene made it (false: it changed it).
 */
export interface StoryItem {
  key: string
  nodes: string[]
  step: number | null
  made: boolean
  /**
   * Each node's signature after the commit (nodeSig). For an item the scene changed, a read can tell which version the board shows
   * (an undo brings back the content of an earlier one); for both kinds, a replay after a restart tells which nodes are as the scene
   * left them (the others show as ghosts). Records from before 2026-10-29 have it only for changed items.
   */
  sigs?: string[]
  /**
   * The stage object these nodes belong to when this scene did not make it (a carried object it changed, or an earlier
   * object it brought back): the scene id and key of the scene that made it. held: every node the object shows through
   * after this scene. A rebuilt stage folds these, in stage order, into the object's nodes (renderer live/run.ts sceneRestore).
   */
  of?: [string, string]
  held?: string[]
}

/** The key scheme of the scene lines this app writes: "n:<escaped name>[#k]" and "o:<n>", given by the stage (stage/live-prelude.js keyFor). */
export const RECORD_VERSION = 2

/**
 * What the board measured when it committed a scene, which a re-run of the scene's program cannot know (renderer/live/run.ts
 * settleLayout, measureGlides): the place and size a node got once measured (text centred on a point, a group frame fitted to
 * what it holds, and the items in it), and where an item that went into a frame glides from. A replay after a restart applies
 * them to the re-run (spec section 4).
 */
export interface SceneSettle {
  /** Node id, x, y, and a content node's style width and height (null when the measure did not set them). */
  nodes: Array<[string, number, number, string | null, string | null]>
  /** The first node of an item that went into a frame, and its glide's start (an offset from its end place). */
  glides: Array<[string, number, number]>
}

/** A short signature of a node's content (its saved form without seq): equal content, equal signature. */
export function nodeSig(node: BoardNode): string {
  const text = serializeNode({ ...node, seq: 0 } as BoardNode)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(36)
}

/** What a reader knows of the board: whether a node is on it, and its content signature. */
export interface BoardLook {
  has(nodeId: string): boolean
  sig(nodeId: string): string | undefined
}

/** One version of a scene is what the board shows: a node it made is there, or a node it changed has the content it left. */
export function storyOnBoard(story: SceneStory, board: BoardLook): boolean {
  return story.items.some((item) => (item.made ? item.nodes.some((id) => board.has(id)) : item.nodes.some((id, k) => item.sigs?.[k] !== undefined && board.sig(id) === item.sigs[k])))
}

/**
 * The one rule for which version of a scene the board shows (an undo can bring back an earlier one): the index of the
 * newest of these versions (oldest first) that storyOnBoard finds on the board, or -1 when none is. The story reader
 * (renderer live/stories.ts) and a rebuilt stage (main/scene-store.ts restorable) both use it.
 */
export function shownVersion(stories: readonly SceneStory[], board: BoardLook): number {
  for (let i = stories.length - 1; i >= 0; i--) if (storyOnBoard(stories[i], board)) return i
  return -1
}

/** A story whose every field a reader uses has its type (a bad record line is skipped, never read). */
export function isStory(value: unknown): value is SceneStory {
  const story = value as SceneStory
  const int = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0
  return (
    !!story &&
    typeof story === 'object' &&
    typeof story.duration === 'number' &&
    Array.isArray(story.steps) &&
    Array.isArray(story.lines) &&
    Array.isArray(story.items) &&
    story.lines.every((line) => !!line && typeof line.text === 'string' && typeof line.at === 'number' && typeof line.dur === 'number') &&
    story.steps.every((step) => !!step && typeof step.name === 'string' && typeof step.at === 'number' && Array.isArray(step.lines) && step.lines.every((i) => int(i) && i < story.lines.length)) &&
    story.items.every(
      (item) =>
        !!item &&
        typeof item.key === 'string' &&
        typeof item.made === 'boolean' &&
        Array.isArray(item.nodes) &&
        item.nodes.every((id) => typeof id === 'string') &&
        (item.step === null || (int(item.step) && (item.step as number) < story.steps.length)) &&
        (item.sigs === undefined || (Array.isArray(item.sigs) && item.sigs.every((sig) => typeof sig === 'string')))
    )
  )
}

export interface SceneStory {
  duration: number
  steps: StoryStep[]
  lines: StoryLine[]
  items: StoryItem[]
}

/**
 * What a scene changed on the board (renderer/live/compile.ts SceneRevert): node ids it made, nodes as they were before it
 * changed or removed them, and (from 2026-10-29) each changed node's signature as the scene left it (nodeSig): a revert puts
 * a changed node back only while it is still as the scene left it, so a later edit of it stays.
 */
export interface StoryRevert {
  created: string[]
  changed: unknown[]
  removed: unknown[]
  after?: Record<string, string>
}

/** What the board tells main about a commit it accepted (runScene's result): the board's id and the scene's story and revert. newBoard: this commit gave the board its id (main saves the board file before the first line). */
export interface CommitRecord {
  board: string
  /** The learning folder and the board path at the moment the board accepted the commit (the event's board, whatever opens later). */
  root: string
  path: string
  newBoard?: boolean
  story: SceneStory
  revert: StoryRevert
  settle?: SceneSettle
}

export interface SceneRecordLine {
  t: 'scene'
  /** 1: records from before 2026-10-29 (other object keys); RECORD_VERSION now. */
  v: 1 | 2
  scene: string
  name: string | null
  version: number
  /** The highest version of this scene so far (this line included), so the count goes on after a compaction drops older lines. */
  maxVersion: number
  segment: number
  at: string
  app: string
  source: {
    entry: string | null
    modules: Array<{ path: string | null; sha: string }>
    links?: Array<[string, string]>
    seed: number
    cutAt: number | null
    ctx: string
    answers: Array<[string, string]>
    /** The objects of earlier programs that ctx's stage.items held, by owner (scene id, key) with their item ids (main/live-scene.ts StageEntry.objects). */
    objects?: Array<[string, string, string[]]>
  }
  story: SceneStory
  revert: StoryRevert
  /** The board's measures at the commit (records from before 2026-10-29 have none). */
  settle?: SceneSettle
}

export interface DropRecordLine {
  t: 'drop'
  scene: string
  at: string
}

export interface ResetRecordLine {
  t: 'reset'
  segment: number
  at: string
}

export type RecordLine = SceneRecordLine | DropRecordLine | ResetRecordLine

/** One scene of a board as the renderer gets it: the newest version's story, without its source. */
export interface BoardStory {
  scene: string
  name: string | null
  version: number
  segment: number
  /** When this version was played (ISO time). */
  at: string
  /** It left the stage without a new version (a later drop line). */
  dropped: boolean
  story: SceneStory
  /**
   * The stories of its earlier scene lines that main read or wrote in this run (oldest first): an undo
   * of a replace, a cut or clear_queue puts their nodes back on the board, and their nodes keep their steps.
   */
  earlier: Array<{ version: number; story: SceneStory }>
}

/** The stories of one board, in reading order (segment, then the first scene line of each scene). */
export interface BoardStories {
  /** The board's id, or null when it has none (no scene was recorded for it). */
  id: string | null
  stories: BoardStory[]
}

/** "synapse#2" → the scene "synapse", step 2 (from 1). Null when text is not of that form. */
export function parseStepRef(text: string): { scene: string; step: number } | null {
  const match = /^(.+)#(\d+)$/.exec(text.trim())
  if (!match) return null
  const step = Number(match[2])
  return step >= 1 ? { scene: match[1], step } : null
}
