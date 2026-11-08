import type { FramesChunk, MomentsAnswer } from '../shared/frames'
import type { StageProgram } from '../shared/scene-program'
import type { StageMode, StageReply, StageSwept } from '../shared/stage-protocol'

/**
 * The messages between the stage page (page.ts) and its worker (worker.ts).
 *
 * Host answers do not come as messages: while a program waits for the board,
 * its worker blocks in Atomics.wait and cannot receive messages. The page
 * writes the answer into the bridge (a SharedArrayBuffer), in chunks of at most
 * BRIDGE_CHUNK bytes:
 *
 *   Int32 [0] state: 0 = the worker waits, 1 = a chunk is ready
 *   Int32 [1] the chunk's length in bytes
 *   Int32 [2] 1 when this chunk is the last one of the answer
 *   Int32 [3] the bytes of frames on the way to the board: the worker adds a
 *             chunk's bytes before it sends it, and the page takes them off
 *             when the board acknowledges the chunk (shared/frames.ts, CREDIT_BYTES)
 *   bytes from BRIDGE_HEADER: the chunk (UTF-8)
 *
 * After a chunk that is not the last, the worker sets the state to 0 and
 * sends "more"; the page then writes the next chunk.
 */

export const BRIDGE_HEADER = 16
export const BRIDGE_CHUNK = 1024 * 1024

export type ToWorker =
  | { t: 'init'; fontText: string; noCodeItems: boolean; noHtml: boolean; bridge: SharedArrayBuffer }
  | { t: 'run'; id: number; program: StageProgram; ctxText: string; mode: StageMode }
  /** A preview's moments past what the sweep of program id has reached. */
  | { t: 'moments'; id: number; ask: number; times: number[] }
  /** The sweep gives way to the learner, or runs at full speed. */
  | { t: 'pace'; calm: boolean }

export type FromWorker =
  /** The scene library is loaded and the context is locked. */
  | { t: 'ready' }
  | { t: 'failed'; error: string }
  | StageReply
  | StageSwept
  /** The script could not be parsed. The worker cannot see where: the page finds the line (page.ts, syntaxLine). Modules were parsed in main (main/scene-files.ts). */
  | { t: 'parse-error'; id: number; error: string; ms: number }
  | { t: 'host'; text: string }
  | { t: 'more' }
  /** A chunk of frames of program id (shared/frames.ts); its buffers are transferred. */
  | (Omit<FramesChunk, 't' | 'job'> & { t: 'frames'; id: number })
  /** The moments of an ask have gone as frames, or failed. */
  | (Omit<MomentsAnswer, 'job'> & { id: number })
