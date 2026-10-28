import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SceneSource } from '@shared/scene-program'
import { isStory, nodeSig, storyOnBoard, type BoardLook, type BoardStories, type BoardStory, type CommitRecord, type RecordLine, type SceneRecordLine, type SceneStory } from '@shared/scene-story'
import { parseBoard } from '@shared/board-format'
import { FOLDER_SETTINGS_DIR } from './guide'
import type { FolderSession } from './folder'

/**
 * The scene records (spec: docs/learning-space/drafts/story-foundation-2026-10-27/spec.md,
 * sections 1-6): one append-only JSON Lines file per board, `.learning-space/scenes/<board id>.jsonl`,
 * and the text of every module that ran, once, in `.learning-space/scenes/code/<sha>.js`.
 *
 * This is the only writer. mcp.ts calls it for each event: a `scene` line when the board accepted a
 * scene's commit (play_scene start, a replace, a cut, a scene that runs again in a restage), a `drop`
 * line when a scene leaves the stage without a new version (clear_queue; a later scene whose run
 * fails in a restage), a `reset` line on play_scene reset. One append per event. Every event names
 * its board (RecordBoard: the folder root, path and id, fixed when the event is made), so a queued
 * event never writes to another folder or board. A failed write is logged and never fails the tool:
 * the scene still plays. A scene line is written only after the code it names is on disk.
 *
 * Reading: the first time a board opens in this run (the renderer asks, main/index.ts), its file is
 * read once, line by line (a bad or half-written line is skipped and logged), into an index in
 * memory that holds the stories only, and compacted when superseded lines are more than half of it.
 * The renderer gets the stories (no source) then, and again after each new line. Reading rule: the
 * last scene line of a scene id wins; a later drop marks it dropped; scenes are in the order of
 * their first scene line.
 *
 * The board's id is in the board file (BoardDoc.id), which only the renderer writes: the renderer
 * gives a board its id at its first commit (renderer/live/run.ts), and takes the id this store gives
 * when the board that mounts has an id that is not valid or that another board of the folder has
 * (a copied file).
 */

const SCENES_DIR = `${FOLDER_SETTINGS_DIR}/scenes`
/** A board id as newItemId('b') makes it: it names a file, so nothing else is taken. */
const BOARD_ID = /^b_[0-9a-z]{4,32}$/
const SHA = /^[0-9a-f]{64}$/
/** How much of a board file is read to find its id (the id is near the top; the full file when it is not there). */
const HEAD_BYTES = 16 * 1024

/** The board an event is for, fixed when the event is made. */
export interface RecordBoard {
  root: string
  path: string
  id: string
}

interface SceneState {
  scene: string
  name: string | null
  version: number
  maxVersion: number
  segment: number
  at: string
  story: SceneStory
  dropped: boolean
  /** Source key (modules, seed, cut) → its version: the same program committed again keeps its version. */
  keys: Map<string, number>
  earlier: Array<{ version: number; story: SceneStory }>
}

interface RecordIndex {
  id: string
  file: string
  /** By scene id, in the order of their first scene line. */
  scenes: Map<string, SceneState>
  segment: number
  /** Lines in the file (a blank or bad line included). */
  lines: number
  /** The file does not end with a line break (a half-written last line, a failed append): the next append starts a new line. */
  openTail: boolean
}

const sourceKey = (source: SceneRecordLine['source']): string => JSON.stringify([source.modules.map((module) => module.sha), source.seed, source.cutAt])
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** A scene line with every field the index reads, of the right type. */
function isSceneLine(value: Record<string, unknown>): value is Record<string, unknown> & SceneRecordLine {
  const story = value.story
  const source = value.source
  return (
    typeof value.scene === 'string' &&
    Number.isInteger(value.version) &&
    Number.isInteger(value.segment) &&
    isStory(story) &&
    isRecord(source) &&
    Array.isArray(source.modules) &&
    source.modules.every((module) => isRecord(module) && typeof module.sha === 'string') &&
    typeof source.seed === 'number'
  )
}

/** Each line of a file, read as a stream (one line in memory at a time): its text, byte offset and length. openTail: the last line has no line break. */
async function eachLine(file: string, fn: (text: string, start: number, bytes: number) => void): Promise<{ openTail: boolean }> {
  let parts: Buffer[] = []
  let partBytes = 0
  let start = 0
  try {
    for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
      let from = 0
      for (let nl = chunk.indexOf(10, from); nl >= 0; nl = chunk.indexOf(10, from)) {
        const piece = chunk.subarray(from, nl)
        const bytes = partBytes + piece.length
        fn((partBytes ? Buffer.concat([...parts, piece]) : piece).toString('utf8'), start, bytes)
        start += bytes + 1
        parts = []
        partBytes = 0
        from = nl + 1
      }
      if (from < chunk.length) {
        parts.push(chunk.subarray(from))
        partBytes += chunk.length - from
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { openTail: false }
    throw error
  }
  if (partBytes) fn(Buffer.concat(parts).toString('utf8'), start, partBytes)
  return { openTail: partBytes > 0 }
}

export class SceneStore {
  /** The indexes read or written in this run, by folder root and board id. */
  private indexes = new Map<string, RecordIndex>()
  /** Board path → its id, by file identity (for finding a board id that two files have). */
  private heads = new Map<string, { identity: string; id: string | null }>()
  /** Appends and rewrites, one after another. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly folder: () => FolderSession | null,
    private readonly push: (stories: BoardStories) => void
  ) {}

  /** The learning folders open in this run: an event may write only into one of them. */
  private roots = new Set<string>()

  private folderNow(): FolderSession | null {
    const folder = this.folder()
    if (folder) this.roots.add(folder.root)
    return folder
  }

  /** The board of an event made now: the open folder's root, the board's path and id (null when no folder is open or the id is not valid). */
  board(path: string, id: string | null | undefined): RecordBoard | null {
    const root = this.folderNow()?.root
    return root && id && BOARD_ID.test(id) ? { root, path, id } : null
  }

  /** The board of a commit, as the board had it when it accepted the commit (null when its folder was never open here or its id is not valid). */
  boardOf(record: CommitRecord): RecordBoard | null {
    this.folderNow()
    return this.roots.has(record.root) && BOARD_ID.test(record.board) && typeof record.path === 'string' ? { root: record.root, path: record.path, id: record.board } : null
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  /**
   * A board mounted in the window (renderer App.tsx: an open, or a reload of the open board's file):
   * its stories, and the id the board must have. A new id when its id is not valid or another board of
   * the folder has it (then the records are copied to the new id). The new id is derived from the old
   * id and the path, so an open that the window drops, and the next open, agree on it.
   */
  openBoard(path: string, id: string | null): Promise<BoardStories> {
    const folder = this.folderNow()
    const root = folder?.root ?? null
    return this.serial(async () => {
      if (!folder || !root || !id) return { id: null, stories: [] }
      const dir = join(root, SCENES_DIR)
      let boardId = id
      const shared = BOARD_ID.test(id) ? await this.otherBoardWith(folder, path, id) : null
      if (!BOARD_ID.test(id) || shared) {
        boardId = derivedId(id, path)
        const target = join(dir, `${boardId}.jsonl`)
        if (shared && !(await stat(target).catch(() => null))) {
          await mkdir(dir, { recursive: true })
          await copyFile(join(dir, `${id}.jsonl`), target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
        console.log(`scene records: ${path} ${shared ? `has the id ${id} of ${shared}` : `has an id that is not valid (${JSON.stringify(id).slice(0, 40)})`}; it gets ${boardId}${shared ? ' and a copy of the records' : ''}`)
      }
      this.heads.delete(path)
      const index = await this.indexFor(root, boardId, () => boardLook(join(root, path)))
      return this.storiesOf(index)
    })
  }

  /** A scene's commit was accepted by the board: append its scene line (after the code it names). Never throws. */
  scene(board: RecordBoard, entry: { scene: string | null; source: SceneSource; name: string | null; seed: number; cutAt: number | null; ctxText: string; answers: Map<string, string> }, record: CommitRecord): Promise<void> {
    const sceneId = entry.scene
    if (!sceneId) return Promise.resolve()
    return this.serial(async () => {
      try {
        // The first line of a board's history is written only once the board file holds its id: no history without a board that points to it.
        if (record.newBoard && (await boardIdOf(join(board.root, board.path))) !== board.id) {
          console.error(`scene records: ${board.path} does not hold its new id ${board.id} on disk, so its first scene line is not written (the scene plays)`)
          return
        }
        const index = await this.indexFor(board.root, board.id)
        await this.saveCode(join(board.root, SCENES_DIR), entry.source)
        const source: SceneRecordLine['source'] = {
          entry: entry.source.entry,
          modules: entry.source.modules.map((module) => ({ path: module.path, sha: module.sha256 })),
          ...(entry.source.links?.length ? { links: entry.source.links } : {}),
          seed: entry.seed,
          cutAt: entry.cutAt,
          ctx: entry.ctxText,
          answers: [...entry.answers]
        }
        const state = index.scenes.get(sceneId)
        const version = state?.keys.get(sourceKey(source)) ?? (state ? state.maxVersion + 1 : 1)
        const line: SceneRecordLine = { t: 'scene', v: 1, scene: sceneId, name: entry.name, version, maxVersion: Math.max(version, state?.maxVersion ?? 0), segment: state?.segment ?? index.segment, at: new Date().toISOString(), app: app.getVersion(), source, story: record.story, revert: record.revert }
        await this.append(index, [line])
        this.push(this.storiesOf(index))
      } catch (error) {
        console.error(`scene records: the scene line of ${sceneId} on ${board.path} was not written: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /** Scenes left the board's stage without a new version: a drop line for each that has a record. Never throws. */
  drop(board: RecordBoard | null, sceneIds: string[]): Promise<void> {
    if (!board || !sceneIds.length) return Promise.resolve()
    return this.serial(async () => {
      try {
        const index = await this.indexFor(board.root, board.id)
        const at = new Date().toISOString()
        const lines: RecordLine[] = sceneIds.filter((id) => index.scenes.get(id) && !index.scenes.get(id)?.dropped).map((scene) => ({ t: 'drop', scene, at }))
        if (!lines.length) return
        await this.append(index, lines)
        this.push(this.storiesOf(index))
      } catch (error) {
        console.error(`scene records: the drop lines on ${board.path} were not written: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /** play_scene reset on the board: the next scene starts a new segment. A board with no records needs no line. Never throws. */
  reset(board: RecordBoard | null): Promise<void> {
    if (!board) return Promise.resolve()
    return this.serial(async () => {
      try {
        const index = await this.indexFor(board.root, board.id)
        if (!index.lines) return
        await this.append(index, [{ t: 'reset', segment: index.segment + 1, at: new Date().toISOString() }])
      } catch (error) {
        console.error(`scene records: the reset line on ${board.path} was not written: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /** A board file was renamed or went to the Trash: its records stay (they go by id); only the id cache of the path goes. */
  boardMoved(from: string): void {
    this.heads.delete(from)
  }

  // ---------- Inside ----------

  /** The index of a board id, read the first time in this run. Its file deleted since: it starts again from nothing. */
  private async indexFor(root: string, id: string, look?: () => Promise<BoardLook | null>): Promise<RecordIndex> {
    const known = this.indexes.get(`${root}\0${id}`)
    if (known) {
      if (known.lines && !(await stat(known.file).catch(() => null))) {
        console.log(`scene records: ${known.file} was deleted; the next line starts a new file`)
        return this.load(root, id, true)
      }
      return known
    }
    return this.load(root, id, false, look ? await look() : null)
  }

  /**
   * Read a board's records file into a new index, line by line. When the board's saved content is
   * known (look) and most lines are superseded, the file is compacted first: each scene keeps its
   * newest line and every older line whose version the board shows (an undo can leave it there).
   */
  private async load(root: string, id: string, compacted = false, look: BoardLook | null = null): Promise<RecordIndex> {
    const file = join(root, SCENES_DIR, `${id}.jsonl`)
    const index: RecordIndex = { id, file, scenes: new Map(), segment: 0, lines: 0, openTail: false }
    /** For compaction: each line's place in the file, each scene's first and last scene line, the drop after its last one, and the lines that stay. */
    const places: Array<[number, number]> = []
    const first = new Map<string, number>()
    const last = new Map<string, number>()
    /** Each scene's scene lines and their stories. */
    const sceneLines = new Map<string, Array<{ i: number; story: SceneStory }>>()
    const drops = new Map<string, number>()
    const kept = new Set<number>()
    const skip = (i: number, why: string): void => console.warn(`scene records: ${file} line ${i + 1} skipped (${why})`)
    const { openTail } = await eachLine(file, (text, start, bytes) => {
      const i = index.lines++
      places.push([start, bytes])
      if (!text.trim()) return
      let line: unknown
      try {
        line = JSON.parse(text)
      } catch (error) {
        skip(i, error instanceof Error ? error.message : String(error))
        return
      }
      try {
        if (!isRecord(line)) return skip(i, 'not a JSON object')
        if (line.t === 'scene') {
          if (!isSceneLine(line)) return skip(i, 'a scene line without its fields')
          const known = index.scenes.get(line.scene)
          if (known) known.earlier.push({ version: known.version, story: known.story })
          const state: SceneState = known ?? { scene: line.scene, name: null, version: 0, maxVersion: 0, segment: 0, at: '', story: line.story, dropped: false, keys: new Map(), earlier: [] }
          Object.assign(state, { name: typeof line.name === 'string' ? line.name : null, version: line.version, segment: line.segment, at: typeof line.at === 'string' ? line.at : '', story: line.story, dropped: false })
          state.keys.set(sourceKey(line.source), line.version)
          state.maxVersion = Math.max(state.maxVersion, line.version, Number.isInteger(line.maxVersion) ? line.maxVersion : 0)
          if (!known) {
            index.scenes.set(line.scene, state)
            first.set(line.scene, i)
          }
          last.set(line.scene, i)
          drops.delete(line.scene)
          const list = sceneLines.get(line.scene) ?? []
          list.push({ i, story: line.story })
          sceneLines.set(line.scene, list)
        } else if (line.t === 'drop' && typeof line.scene === 'string') {
          const state = index.scenes.get(line.scene)
          if (!state) return skip(i, 'a drop of a scene with no scene line before it')
          state.dropped = true
          drops.set(line.scene, i)
        } else if (line.t === 'reset' && Number.isInteger(line.segment)) {
          index.segment = Math.max(index.segment + 1, line.segment as number)
          kept.add(i)
        } else kept.add(i) // a kind of line of a newer app: kept as it is
      } catch (error) {
        skip(i, error instanceof Error ? error.message : String(error))
      }
    })
    index.openTail = openTail
    if (openTail && index.lines) console.warn(`scene records: ${file} ends in a half-written line; the next line starts after it`)
    for (const i of drops.values()) kept.add(i)
    /** The scene lines that stay, by scene: the newest, and the older ones whose version the board shows. */
    const keptOf = new Map<string, number[]>()
    for (const [scene, list] of sceneLines) {
      const newest = last.get(scene) as number
      const stay = list.filter(({ i, story }) => i === newest || (look !== null && storyOnBoard(story, look))).map(({ i }) => i)
      keptOf.set(scene, stay)
      for (const i of stay) kept.add(i)
    }
    this.indexes.set(`${root}\0${id}`, index)
    if (!compacted && look && index.lines - kept.size > index.lines / 2) {
      // A scene's lines that stay go where its first line was, in their order, so the scenes keep their order. One line in memory at a time.
      const sceneAt = new Map([...first].map(([scene, i]) => [i, keptOf.get(scene) as number[]]))
      const sceneLineSet = new Set([...sceneLines.values()].flatMap((list) => list.map(({ i }) => i)))
      const order = places.flatMap((_, i) => (sceneAt.has(i) ? (sceneAt.get(i) as number[]) : kept.has(i) && !sceneLineSet.has(i) ? [i] : []))
      await this.rewriteFrom(file, places, order)
      console.log(`scene records: ${file} compacted from ${index.lines} to ${order.length} lines`)
      return this.load(root, id, true)
    }
    return index
  }

  /** Write a records file again with these of its lines, in this order (a temp file, then a rename, as for boards). */
  private async rewriteFrom(file: string, places: Array<[number, number]>, order: number[]): Promise<void> {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    const source = await open(file, 'r')
    const out = await open(temp, 'w')
    try {
      for (const i of order) {
        const [start, bytes] = places[i]
        const buffer = Buffer.alloc(bytes + 1)
        await source.read(buffer, 0, bytes, start)
        buffer[bytes] = 10
        await out.write(buffer)
      }
      await out.close()
      await rename(temp, file)
    } catch (error) {
      await out.close().catch(() => undefined)
      await unlink(temp).catch(() => undefined)
      throw error
    } finally {
      await source.close()
    }
  }

  /** One append of the lines of one event. A failed append leaves the index as it was, and the next one starts on a new line. */
  private async append(index: RecordIndex, lines: RecordLine[]): Promise<void> {
    const text = `${index.openTail ? '\n' : ''}${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
    try {
      await mkdir(join(index.file, '..'), { recursive: true })
      await appendFile(index.file, text, 'utf8')
    } catch (error) {
      // Part of it may be in the file: the next append starts on a new line, so that part is one bad line.
      index.openTail = true
      throw error
    }
    index.openTail = false
    for (const line of lines) {
      index.lines++
      if (line.t === 'scene') {
        const state = index.scenes.get(line.scene)
        if (state) {
          state.earlier.push({ version: state.version, story: state.story })
          Object.assign(state, { name: line.name, version: line.version, segment: line.segment, at: line.at, story: line.story, dropped: false })
          state.keys.set(sourceKey(line.source), line.version)
          state.maxVersion = Math.max(state.maxVersion, line.maxVersion)
        } else {
          index.scenes.set(line.scene, { scene: line.scene, name: line.name, version: line.version, maxVersion: line.maxVersion, segment: line.segment, at: line.at, story: line.story, dropped: false, keys: new Map([[sourceKey(line.source), line.version]]), earlier: [] })
        }
      } else if (line.t === 'drop') {
        const state = index.scenes.get(line.scene)
        if (state) state.dropped = true
      } else index.segment = line.segment
    }
  }

  /** The text of each module once, by its SHA-256 (again when the file was deleted). Throws when one cannot be saved: no scene line may name code that is not on disk. */
  private async saveCode(dir: string, source: SceneSource): Promise<void> {
    const codeDir = join(dir, 'code')
    for (const module of source.modules) {
      if (!SHA.test(module.sha256)) throw new Error(`the module ${module.path ?? '(inline code)'} has no SHA-256`)
      const file = join(codeDir, `${module.sha256}.js`)
      if (await stat(file).catch(() => null)) continue
      await mkdir(codeDir, { recursive: true })
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      try {
        await writeFile(temp, module.text, 'utf8')
        await rename(temp, file)
      } catch (error) {
        await unlink(temp).catch(() => undefined)
        throw new Error(`the code ${module.sha256} could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private storiesOf(index: RecordIndex): BoardStories {
    const stories: BoardStory[] = [...index.scenes.values()].map((state) => ({ scene: state.scene, name: state.name, version: state.version, segment: state.segment, at: state.at, dropped: state.dropped, story: state.story, earlier: state.earlier }))
    return { id: index.id, stories }
  }

  /** Another board file of the folder whose id is id (a copy of the file), or null. */
  private async otherBoardWith(folder: FolderSession, path: string, id: string): Promise<string | null> {
    for (const board of await folder.boardFiles()) {
      if (board.path === path) continue
      let head = this.heads.get(board.path)
      if (!head || head.identity !== board.identity) {
        head = { identity: board.identity, id: await boardIdOf(join(folder.root, board.path)) }
        this.heads.set(board.path, head)
      }
      if (head.id === id) return board.path
    }
    return null
  }
}

/** The id a board with an id that is not its own gets: from that id and its path, so every open of that board agrees on it. */
function derivedId(id: string, path: string): string {
  const hash = createHash('sha256').update(`${id}|${path}`).digest()
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let out = 'b_'
  for (let i = 0; i < 8; i++) out += alphabet[hash[i] % alphabet.length]
  return out
}

/** The id in a board file (the top-level "id"), read from the top of the file when it is there; null when it has none or cannot be read. */
async function boardIdOf(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r')
    let head: string
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
      head = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
    // serializeBoard writes the top-level keys one per line, two spaces in, before "nodes".
    const top = /\n {2}"nodes":/.exec(head)
    if (top) {
      const match = /\n {2}"id": ("(?:[^"\\\n]|\\.)*"),?\n/.exec(head.slice(0, top.index + 1))
      return match ? (JSON.parse(match[1]) as string) : null
    }
    const raw = JSON.parse(await readFile(file, 'utf8')) as { id?: unknown }
    return typeof raw.id === 'string' ? raw.id : null
  } catch {
    return null
  }
}

/** What the saved board shows, for compaction (which older versions it still holds), or null when it cannot be read. */
async function boardLook(file: string): Promise<BoardLook | null> {
  try {
    const doc = parseBoard(await readFile(file, 'utf8'))
    const byId = new Map(doc.nodes.map((node) => [node.id, node]))
    const sigs = new Map<string, string>()
    return {
      has: (nodeId) => byId.has(nodeId),
      sig: (nodeId) => {
        const node = byId.get(nodeId)
        if (!node) return undefined
        let sig = sigs.get(nodeId)
        if (sig === undefined) sigs.set(nodeId, (sig = nodeSig(node)))
        return sig
      }
    }
  } catch {
    return null
  }
}
