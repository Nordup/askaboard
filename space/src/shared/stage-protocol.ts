/**
 * The messages between the main process and the stage page (main/stage-process.ts,
 * stage/page.ts), over one MessagePort. Each side checks every message it
 * gets with the parser of its direction: a message of the wrong shape, type or
 * size is dropped and never reaches the code behind it.
 *
 * The stage page relays to its worker (stage/worker.ts) and back; those
 * messages are in stage/worker-protocol.ts.
 */

import type { StageModule, StageProgram } from './scene-program'

/**
 * How a program runs. "scene": run, describe, bake into the stage. "draft": run and describe; the stage is rebuilt after.
 * "replay": run and bake only (a rebuild: no sampling, no frames, no description).
 */
export type StageMode = 'scene' | 'draft' | 'replay'

/** Where the time of one program went, in ms (the worker's clock), and how many recipe evaluations the sampling made. */
export interface StageTiming {
  /** The program body and its virtual clock. */
  body: number
  /** __result(): the sampling of changing objects and the description. */
  result: number
  /** __bake(): the end of the scene becomes the start of the next. */
  bake: number
  /** Recipe evaluations the sampling made, and the evaluations that sampling every object over every span would make. */
  evaluations: number
  fullEvaluations: number
  /** The frames (shared/frames.ts): ms to encode them, ms the worker waited for the board's credit, and their bytes. */
  encode: number
  wait: number
  bytes: number
}

export type ToStage =
  | { t: 'init'; fontText: string; noCodeItems: boolean; noHtml: boolean }
  /** A new, empty context (a new worker with the scene library). */
  | { t: 'reset'; id: number }
  /** Run a program (shared/scene-program.ts: a script, or modules). */
  | { t: 'run'; id: number; program: StageProgram; ctxText: string; mode: StageMode }
  /** The board's answer to host request hid (JSON text). */
  | { t: 'answer'; hid: number; text: string }
  /** End the program that runs now: its worker stops at once. */
  | { t: 'cancel' }

/**
 * The reply to a reset or a run. json: the description without the samples (null for a reset and a replay);
 * frames: how many frame chunks the run sent to the board (shared/frames.ts), all acknowledged by the board before this reply.
 * An error's line is in the module file (a path in boards/scenes/), or in the inline code when file is null.
 */
export type StageReply =
  | { t: 'reply'; id: number; ok: true; json: string | null; frames: number; ms: number; timing: StageTiming | null }
  | { t: 'reply'; id: number; ok: false; error: string; line: number | null; file: string | null; ms: number }

export type FromStage =
  /** The page has the port and waits for init. */
  | { t: 'ready' }
  | StageReply
  /** A program asks the board (JSON text: text sizes, html, space, item); the program waits until the answer comes. */
  | { t: 'host'; hid: number; text: string }
  /** The page has the frames port that main sent last (the port to the board). */
  | { t: 'linked' }

/** Size caps (characters). Larger values are refused. */
export const STAGE_LIMITS = {
  font: 4 * 1024 * 1024,
  /** A script's code, or one module's. */
  code: 16 * 1024 * 1024,
  /** A module's path in boards/scenes/. */
  path: 4096,
  context: 64 * 1024 * 1024,
  host: 64 * 1024 * 1024,
  /** Near the largest string V8 can make. */
  description: 512 * 1024 * 1024 - 64,
  error: 64 * 1024
} as const

type Shape = Record<string, unknown>

const isShape = (value: unknown): value is Shape => typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const isMs = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isMode = (value: unknown): value is StageMode => value === 'scene' || value === 'draft' || value === 'replay'
/** Only these keys, and each of them. */
const keysAre = (value: Shape, keys: string[]): boolean => {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function parseTiming(value: unknown): StageTiming | null | undefined {
  if (value === null) return null
  if (!isShape(value) || !keysAre(value, ['body', 'result', 'bake', 'evaluations', 'fullEvaluations', 'encode', 'wait', 'bytes'])) return undefined
  const { body, result, bake, evaluations, fullEvaluations, encode, wait, bytes } = value
  if (![body, result, bake, evaluations, fullEvaluations, encode, wait, bytes].every(isMs)) return undefined
  return { body, result, bake, evaluations, fullEvaluations, encode, wait, bytes } as StageTiming
}

function parseProgram(value: unknown): StageProgram | null {
  if (!isShape(value)) return null
  if (value.kind === 'script') return keysAre(value, ['kind', 'code']) && isText(value.code, STAGE_LIMITS.code) ? { kind: 'script', code: value.code } : null
  if (value.kind !== 'modules' || !keysAre(value, ['kind', 'modules']) || !Array.isArray(value.modules)) return null
  const list = value.modules as unknown[]
  if (!list.length) return null
  const modules: StageModule[] = []
  for (const m of list) {
    if (!isShape(m) || !keysAre(m, ['path', 'code']) || !isText(m.code, STAGE_LIMITS.code)) return null
    if (!(m.path === null || (isText(m.path, STAGE_LIMITS.path) && m.path.length > 0))) return null
    modules.push({ path: m.path as string | null, code: m.code })
  }
  return { kind: 'modules', modules }
}

/** A message from the main process, checked (stage page side). */
export function parseToStage(value: unknown): ToStage | null {
  if (!isShape(value)) return null
  switch (value.t) {
    case 'init':
      return keysAre(value, ['t', 'fontText', 'noCodeItems', 'noHtml']) && isText(value.fontText, STAGE_LIMITS.font) && typeof value.noCodeItems === 'boolean' && typeof value.noHtml === 'boolean'
        ? { t: 'init', fontText: value.fontText, noCodeItems: value.noCodeItems, noHtml: value.noHtml }
        : null
    case 'reset':
      return keysAre(value, ['t', 'id']) && isId(value.id) ? { t: 'reset', id: value.id } : null
    case 'run': {
      const program = keysAre(value, ['t', 'id', 'program', 'ctxText', 'mode']) ? parseProgram(value.program) : null
      return program && isId(value.id) && isText(value.ctxText, STAGE_LIMITS.context) && isMode(value.mode) ? { t: 'run', id: value.id, program, ctxText: value.ctxText, mode: value.mode } : null
    }
    case 'answer':
      return keysAre(value, ['t', 'hid', 'text']) && isId(value.hid) && isText(value.text, STAGE_LIMITS.host) ? { t: 'answer', hid: value.hid, text: value.text } : null
    case 'cancel':
      return keysAre(value, ['t']) ? { t: 'cancel' } : null
    default:
      return null
  }
}

/** A reply to a reset or a run, checked (both the page, for the worker's replies, and the main process use it). */
export function parseReply(value: unknown): StageReply | null {
  if (!isShape(value) || value.t !== 'reply' || !isId(value.id) || !isMs(value.ms)) return null
  if (value.ok === true) {
    if (!keysAre(value, ['t', 'id', 'ok', 'json', 'frames', 'ms', 'timing']) || !isId(value.frames)) return null
    const json = value.json === null || isText(value.json, STAGE_LIMITS.description) ? (value.json as string | null) : undefined
    const timing = parseTiming(value.timing)
    if (json === undefined || timing === undefined) return null
    return { t: 'reply', id: value.id, ok: true, json, frames: value.frames, ms: value.ms, timing }
  }
  if (value.ok === false) {
    if (!keysAre(value, ['t', 'id', 'ok', 'error', 'line', 'file', 'ms'])) return null
    const line = value.line === null || (isId(value.line) && value.line > 0) ? (value.line as number | null) : undefined
    const file = value.file === null || isText(value.file, STAGE_LIMITS.path) ? (value.file as string | null) : undefined
    if (!isText(value.error, STAGE_LIMITS.error) || line === undefined || file === undefined) return null
    return { t: 'reply', id: value.id, ok: false, error: value.error, line, file, ms: value.ms }
  }
  return null
}

/** A message from the stage page, checked (main process side). */
export function parseFromStage(value: unknown): FromStage | null {
  if (!isShape(value)) return null
  switch (value.t) {
    case 'ready':
      return keysAre(value, ['t']) ? { t: 'ready' } : null
    case 'reply':
      return parseReply(value)
    case 'host':
      return keysAre(value, ['t', 'hid', 'text']) && isId(value.hid) && isText(value.text, STAGE_LIMITS.host) ? { t: 'host', hid: value.hid, text: value.text } : null
    case 'linked':
      return keysAre(value, ['t']) ? { t: 'linked' } : null
    default:
      return null
  }
}
