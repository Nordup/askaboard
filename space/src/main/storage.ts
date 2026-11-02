import { app, session, shell } from 'electron'
import { lstat, readdir, readFile, readlink, realpath, rm, rmdir } from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'
import { isBoardPath } from '@shared/board-format'
import { SCENES_DIR } from '@shared/scene-program'
import { isInside, type FolderSession } from './folder'
import { BOARD_ID, RECORD_DIR, type SceneStore } from './scene-store'
import { traceRoot } from './trace'
import { CLIP_DIR } from './voice'

/**
 * Automatic clean-up of what the app leaves on disk. It runs beside the work of opening a folder and of
 * launching, and a failure only logs.
 *
 *   clips and code copies   a file that no record names, once it is old: permanent, it is made again or it is a copy
 *   records of gone boards  to the Trash, once they are old, with the scene files, clips and code that only they name
 *   a board moved to the Trash   the same, at once, so a board put back with its files replays with its voice
 *   traces                  date folders past their age: permanent
 *   Chromium's caches       capped at launch; a lost entry costs a download or a compile, nothing else
 *
 * It touches only the names it expects, in .learning-space/voice, .learning-space/scenes, boards/scenes (the
 * scene files of a removed board) and the traces folder. What cannot be read stops the step: a record that
 * cannot be read can name a file, and a board that cannot be read is not a board that is gone.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** A clip or a code copy that no record names can be a draft's (drafts are in memory only), or a scene's whose line is about to be written. */
const UNUSED_KEEP_MS = DAY_MS
/** A records file with no board goes after this long: the board can be coming back, by a restore or a sync. */
const GONE_BOARD_KEEP_MS = 7 * DAY_MS
const TRACE_KEEP_MS = 14 * DAY_MS
/** The size each of Chromium's two caches is held to. */
const CACHE_LIMIT_BYTES = 100 * 1024 * 1024

const CLIP_FILE = /^[0-9a-f]{64}\.(?:wav|json)$/
const CODE_FILE = /^[0-9a-f]{64}\.js$/
const RECORD_FILE = /\.jsonl$/
const TRACE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const SHA = /[0-9a-f]{64}/g

interface Found {
  name: string
  path: string
  bytes: number
  mtimeMs: number
}

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** A folder of the learning folder, with its path checked; null when it is not there. */
async function folderPath(folder: FolderSession, rel: string): Promise<string | null> {
  try {
    return await folder.resolvePath(rel)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** The regular files of a folder of the learning folder whose names fit; null when the folder is not there. Only a file that went in between is skipped. */
async function listing(folder: FolderSession, rel: string, names: RegExp): Promise<Found[] | null> {
  const dir = await folderPath(folder, rel)
  if (!dir) return null
  const found: Found[] = []
  for (const name of await readdir(dir)) {
    if (!names.test(name)) continue
    const path = join(dir, name)
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info?.isFile()) found.push({ name, path, bytes: info.size, mtimeMs: info.mtimeMs })
  }
  return found
}

/** Each records file with its text. What cannot be read throws, also a name that is not a regular file: a record that is missed can name a file. */
async function* records(dir: string): AsyncGenerator<{ name: string; text: string }> {
  for (const name of await readdir(dir)) if (RECORD_FILE.test(name)) yield { name, text: await readFile(join(dir, name), 'utf8') }
}

const shasIn = (text: string): Set<string> => new Set(Array.from(text.matchAll(SHA), ([sha]) => sha))

/** Every SHA-256 that a record names, as a clip or as code. Null when there are no records. Throws when one cannot be read. */
async function namedShas(folder: FolderSession): Promise<Set<string> | null> {
  const dir = await folderPath(folder, RECORD_DIR)
  if (!dir) return null
  const shas = new Set<string>()
  for await (const record of records(dir)) for (const sha of shasIn(record.text)) shas.add(sha)
  return shas
}

/** Clips and code copies that no record names and that are old. A clip's WAV and its places are one thing: the newer one gives their age. */
async function removeUnused(folder: FolderSession): Promise<{ files: number; bytes: number }> {
  const files = [...((await listing(folder, CLIP_DIR, CLIP_FILE)) ?? []), ...((await listing(folder, `${RECORD_DIR}/code`, CODE_FILE)) ?? [])]
  const shaOf = (file: Found): string => file.name.slice(0, 64)
  const newest = new Map<string, number>()
  for (const file of files) newest.set(shaOf(file), Math.max(file.mtimeMs, newest.get(shaOf(file)) ?? 0))
  const now = Date.now()
  const old = files.filter((file) => now - (newest.get(shaOf(file)) as number) > UNUSED_KEEP_MS)
  const named = old.length ? await namedShas(folder) : null
  const gone = named ? old.filter((file) => !named.has(shaOf(file))) : []
  await Promise.all(gone.map((file) => rm(file.path, { force: true })))
  return { files: gone.length, bytes: gone.reduce((sum, file) => sum + file.bytes, 0) }
}

/** The module paths in a records file, from boards/scenes/. */
function modulePaths(text: string): Set<string> {
  const paths = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"t":"scene"')) continue
    try {
      const modules = (JSON.parse(line) as { source?: { modules?: Array<{ path?: unknown }> } }).source?.modules
      for (const module of modules ?? []) if (typeof module.path === 'string') paths.add(module.path)
    } catch {
      // A half-written line names nothing that this file does not name in another line.
    }
  }
  return paths
}

/** A path of a scene file in boards/scenes/, as a record names it. */
const isScenePath = (path: string): boolean => !/[\\\0]/.test(path) && !isBoardPath(path) && path.split('/').every((name) => name !== '' && !name.startsWith('.'))

/**
 * The scene files of paths that no other file in boards/scenes/ names: a scene that has not played has no record, and it can import any of
 * them. A plain search for the name errs towards keeping. A file that stays keeps what it names too, so the search repeats until nothing changes.
 */
async function namedNowhereElse(top: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return paths
  const texts = new Map<string, string>()
  for (const entry of await readdir(top, { recursive: true, withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(entry.parentPath, entry.name)
    const text = entry.isFile() ? await readFile(full, 'utf8') : entry.isSymbolicLink() ? await readlink(full) : null
    if (text !== null) texts.set(relative(top, full).split(sep).join('/'), text)
  }
  const own = new Set(paths)
  for (let changed = true; changed; ) {
    changed = false
    for (const path of own) {
      const name = posix.basename(path)
      if ([...texts].some(([other, text]) => !own.has(other) && text.includes(name))) changed = own.delete(path)
    }
  }
  return [...own]
}

/** A scene file as a regular file whose real path is in boards/scenes/, or null: a link stays, and so does a file that a link in its path leads out to. */
async function realSceneFile(top: string, path: string): Promise<string | null> {
  const file = join(top, path)
  const info = await lstat(file).catch(() => null)
  if (!info?.isFile()) return null
  const real = await realpath(file)
  return isInside(await realpath(top), real) ? real : null
}

/** After a file left boards/scenes/: the folders it leaves empty go, up to boards/scenes/ itself. Both paths are real. */
async function dropEmptyFolders(top: string, file: string): Promise<void> {
  for (let dir = dirname(file); dir !== top && isInside(top, dir); dir = dirname(dir)) {
    const names = await readdir(dir)
    if (names.some((name) => name !== '.DS_Store')) return
    await rm(join(dir, '.DS_Store'), { force: true })
    await rmdir(dir)
  }
}

/**
 * A board is gone: what only its records file names goes to the Trash with it, so it can be put back in its place: scene files, clips and code
 * copies. In the store's queue, so no line is written or read in between, and with the board ids of that moment: an open board can have taken
 * the records since. The records file goes last: while it is there every file it names counts as used, so a stop halfway deletes nothing for good.
 * One file that does not go logs, and the others go. Throws, with nothing moved, when a record or a scene file cannot be read.
 */
function trashBoardData(folder: FolderSession, store: SceneStore, id: string): Promise<{ files: number; bytes: number }> {
  return store.serial(async () => {
    const moved = { files: 0, bytes: 0 }
    const dir = await folderPath(folder, RECORD_DIR)
    const ids = await folder.boardIds()
    if (!dir || !ids || ids.has(id)) return moved
    const name = `${id}.jsonl`
    const text = await readFile(join(dir, name), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (text === null) return moved
    let scenePaths = [...modulePaths(text)].filter(isScenePath)
    const shas = shasIn(text)
    for await (const other of records(dir)) {
      if (other.name === name) continue
      scenePaths = scenePaths.filter((path) => !other.text.includes(JSON.stringify(path)))
      for (const sha of shasIn(other.text)) shas.delete(sha)
    }
    const top = await folderPath(folder, SCENES_DIR)
    const sceneFiles = top ? await Promise.all((await namedNowhereElse(top, scenePaths)).map((path) => realSceneFile(top, path))) : []
    const clipDir = await folderPath(folder, CLIP_DIR)
    const codeDir = await folderPath(folder, `${RECORD_DIR}/code`)
    const trash = async (file: string): Promise<void> => {
      const info = await lstat(file).catch(() => null)
      if (!info?.isFile()) return
      await shell.trashItem(file)
      moved.files++
      moved.bytes += info.size
    }
    const files: string[] = []
    for (const sha of shas) {
      if (clipDir) files.push(join(clipDir, `${sha}.wav`), join(clipDir, `${sha}.json`))
      if (codeDir) files.push(join(codeDir, `${sha}.js`))
    }
    const realTop = top && (await realpath(top))
    for (const file of sceneFiles) {
      if (!file || !realTop) continue
      await trash(file).then(() => dropEmptyFolders(realTop, file)).catch((error) => console.error(`storage: ${file} stays: ${String(error)}`))
    }
    for (const file of files) await trash(file).catch((error) => console.error(`storage: ${file} stays: ${String(error)}`))
    await trash(join(dir, name))
    store.forget(folder.root, id)
    return moved
  })
}

/** The records of boards that no board file holds any more, once they are old. Nothing goes when a board cannot be read. */
async function trashGoneRecords(folder: FolderSession, store: SceneStore): Promise<{ files: number; bytes: number }> {
  const now = Date.now()
  const old = ((await listing(folder, RECORD_DIR, RECORD_FILE)) ?? []).filter((file) => BOARD_ID.test(file.name.slice(0, -'.jsonl'.length)) && now - file.mtimeMs > GONE_BOARD_KEEP_MS)
  const moved = { files: 0, bytes: 0 }
  if (!old.length) return moved
  const ids = await folder.boardIds()
  if (!ids) {
    console.warn('storage: a board could not be read, so no records of gone boards are removed')
    return moved
  }
  for (const file of old) {
    const id = file.name.slice(0, -'.jsonl'.length)
    if (ids.has(id)) continue
    const one = await trashBoardData(folder, store, id)
    moved.files += one.files
    moved.bytes += one.bytes
  }
  return moved
}

/** The clean-up of a learning folder, when it opens. The records go first, so what only they named goes in the same pass. */
export async function cleanFolder(folder: FolderSession, store: SceneStore): Promise<void> {
  const trashed = await trashGoneRecords(folder, store).catch((error) => {
    console.error(`storage: records of gone boards: ${String(error)}`)
    return { files: 0, bytes: 0 }
  })
  const removed = await store.serial(() => removeUnused(folder))
  if (removed.files || trashed.files) console.log(`storage: ${folder.name}: removed ${removed.files} unused files, ${megabytes(removed.bytes)}; ${trashed.files} files of gone boards to the Trash, ${megabytes(trashed.bytes)}`)
}

/** A board went to the Trash and the stage and the store let it go (main/index.ts): its data goes after it, unless a copy of the board holds the same id. */
export async function removedBoardData(folder: FolderSession, store: SceneStore, id: string): Promise<void> {
  if (!BOARD_ID.test(id)) return
  const moved = await trashBoardData(folder, store, id)
  if (moved.files) console.log(`storage: ${moved.files} files of board ${id} to the Trash, ${megabytes(moved.bytes)}`)
}

/** The bytes of the files under a folder; 0 when it is not there. */
async function bytesUnder(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  let bytes = 0
  for (const entry of entries) if (entry.isFile()) bytes += (await lstat(join(entry.parentPath, entry.name)).catch(() => null))?.size ?? 0
  return bytes
}

/** The trace folders past their age, by the date in their name, at launch. */
export async function cleanTraces(): Promise<void> {
  const root = traceRoot()
  const now = Date.now()
  let folders = 0
  let bytes = 0
  for (const name of await readdir(root).catch(() => [])) {
    const date = TRACE_DATE.exec(name)
    if (!date) continue
    const day = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]))
    if (Number.isNaN(day.getTime()) || now - day.getTime() <= TRACE_KEEP_MS) continue
    const path = join(root, name)
    if (!(await lstat(path)).isDirectory()) continue
    bytes += await bytesUnder(path)
    await rm(path, { recursive: true })
    folders++
  }
  if (folders) console.log(`storage: removed ${folders} old trace folders, ${megabytes(bytes)}`)
}

/** Holds the HTTP cache to its limit, also at launch when it is over it. Before app ready: it is a Chromium switch. */
export function limitDiskCache(): void {
  app.commandLine.appendSwitch('disk-cache-size', String(CACHE_LIMIT_BYTES))
}

/**
 * The switch does not reach the Code Cache (measured on Electron 45), so at launch it is cleared when it is over the limit. The default
 * session is the only one on disk: the board, the worlds in it and the snapshot window use it, and the stage's session is in memory.
 */
export async function trimCodeCache(): Promise<void> {
  const bytes = await bytesUnder(join(app.getPath('userData'), 'Code Cache'))
  if (bytes <= CACHE_LIMIT_BYTES) return
  await session.defaultSession.clearCodeCaches({})
  console.log(`storage: cleared the code cache, ${megabytes(bytes)}`)
}
