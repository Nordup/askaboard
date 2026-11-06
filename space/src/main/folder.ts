import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import { downloadImage } from './asset-fetch'
import { BOARD_SUFFIX, BOARDS_DIR, boardName, emptyBoard, isBoardPath, parseBoard, sanitizeBoardName, serializeBoard } from '@shared/board-format'
import { MAX_ASSET_BYTES } from '@shared/limits'
import type { BoardChange, BoardList, BoardListEntry, FileNode, FilePreview, FileTree } from '@shared/space-api'

const MAX_DEPTH = 10
const MAX_ENTRIES = 5000
const MAX_TEXT_PREVIEW = 1024 * 1024
const MAX_IMAGE_PREVIEW = 20 * 1024 * 1024
const MAX_BOARD_BYTES = 64 * 1024 * 1024
const WATCH_DEBOUNCE_MS = 150
/** The boards list goes to the renderer at most this often: a burst of saves sends one list. */
const BOARD_LIST_DELAY_MS = 250
const ASSETS_DIR = 'assets'
const EXT_FOR_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg'
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

/** A voice clip, from the folder's root. */
const VOICE_CLIP = /^\.learning-space\/voice\/[^/]+\.wav$/i

/** Types of the other files that worlds read. */
const WORLD_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json'
}

/** Names the listing and the watcher skip: dotfiles, dot-dirs, node_modules. */
/** What a world may read: assets of these types. The folder also holds private notes, and world code has the network and third-party libraries. */
const WORLD_ASSETS = new Set('glb gltf bin obj mtl fbx stl ply dae usdz hdr exr ktx2 basis png jpg jpeg webp gif svg avif wav mp3 ogg mp4 webm ttf otf woff2 csv tsv json txt wasm js mjs'.split(' '))

/** The folders of the learning folder that a world may read. Every other folder can hold what the learner keeps private. */
const WORLD_FOLDERS = new Set(['materials', 'assets', BOARDS_DIR])

/** A path from the folder's root, with / between its names, that a world may read: an asset type, in a world folder, not a board. So no Markdown file, in any place. */
function isWorldAsset(rel: string): boolean {
  const names = rel.toLowerCase().split('/')
  const name = names[names.length - 1]
  return names.length > 1 && WORLD_FOLDERS.has(names[0]) && !name.endsWith(BOARD_SUFFIX) && WORLD_ASSETS.has(extname(name).slice(1))
}

const worldRefusal = (rel: string): string => `A world cannot read this file: ${rel}. It reads assets in materials/, assets/ and boards/, not boards themselves, notes or sessions.`

const isHiddenName = (name: string): boolean => name.startsWith('.') || name === 'node_modules'

const hashText = (text: string): string => createHash('sha1').update(text).digest('hex')

const fileIdentity = (info: { ino: number; mtimeMs: number; size: number }): string => `${info.ino}:${info.mtimeMs}:${info.size}`

const toPosix = (path: string): string => path.split(sep).join('/')

export function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined
}

/** The paths of the board files of a file tree. */
function boardPaths(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) => (node.children ? boardPaths(node.children) : isBoardPath(node.name) ? [node.path] : []))
}

/** A board of the sidebar list. `dir`: null in boards/, '/' at the folder root, else the board's folder. */
function boardEntry(path: string, editedAt: number): BoardListEntry {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return { path, name: boardName(path), dir: dir === BOARDS_DIR ? null : dir || '/', editedAt }
}

/** Newest edit first, then by name (numeric, case-insensitive), then by path. */
function byEdit(a: BoardListEntry, b: BoardListEntry): number {
  return b.editedAt - a.editedAt || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

export interface FolderEvents {
  filesChanged(tree: FileTree): void
  boardChanged(change: BoardChange): void
  /** The boards list changed (an own write, create, rename, trash or a change on disk). */
  boardsChanged(list: BoardList): void
}

/**
 * One open learning folder. Every path from the renderer goes through
 * `resolvePath`, which refuses paths that leave the folder, also through
 * symlinks.
 */
export class FolderSession {
  readonly name: string
  private watcher: FSWatcher | null = null
  private pending = new Set<string>()
  private debounce: ReturnType<typeof setTimeout> | null = null
  /** Content hash of the last version of each board we wrote or read. */
  private knownHashes = new Map<string, string>()
  /**
   * The file identity (inode, mtime, size) of each board just after our own write. A watch
   * event for a board that still has this identity is our own write: the watcher skips it
   * before any listing, reading or hashing.
   */
  private ownWrites = new Map<string, string>()
  /** The watching session's events (startWatching), null when the folder is not the open one. */
  private events: FolderEvents | null = null
  // The boards list (boardList): one list at a time, in order, each with the next seq.
  private listed: BoardListEntry[] | null = null
  private listSeq = 0
  private listChain: Promise<unknown> = Promise.resolve()
  /** The next list walks the folder (a create, rename, trash or a change on disk); else own saves only patch the last list. */
  private listWalk = true
  /** Own saves since the last list: path → mtime. */
  private listEdits = new Map<string, number>()
  private listTimer: ReturnType<typeof setTimeout> | null = null

  private constructor(readonly root: string) {
    this.name = basename(root)
  }

  /** Open a folder. `path` must be an absolute path to a directory. */
  static async open(path: string): Promise<FolderSession> {
    if (!isAbsolute(path)) throw new Error(`Not an absolute path: ${path}`)
    const root = await realpath(path)
    if (!(await stat(root)).isDirectory()) throw new Error(`Not a folder: ${path}`)
    return new FolderSession(root)
  }

  /**
   * The one path check. Resolve a relative path from the renderer to an
   * absolute path inside the folder, or throw.
   * With `allowMissing`, the path itself may not exist yet (create, write);
   * then its nearest existing ancestor must be inside the folder.
   */
  async resolvePath(rel: unknown, options: { allowMissing?: boolean } = {}): Promise<string> {
    if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) throw new Error('Invalid path.')
    if (isAbsolute(rel)) throw new Error('Paths must be relative to the learning folder.')
    const full = resolve(this.root, rel)
    if (!isInside(this.root, full) || full === this.root) throw new Error(`Path leaves the learning folder: ${rel}`)
    let probe = full
    for (;;) {
      try {
        const real = await realpath(probe)
        if (!isInside(this.root, real)) throw new Error(`Path leaves the learning folder through a link: ${rel}`)
        return full
      } catch (error) {
        if (errorCode(error) === 'ENOENT' && options.allowMissing && probe !== this.root) {
          probe = dirname(probe)
          continue
        }
        throw error
      }
    }
  }

  private relOf(full: string): string {
    return toPosix(relative(this.root, full))
  }

  // ---------- Listing and watching ----------

  async listFiles(): Promise<FileTree> {
    const { nodes, truncated } = await this.walkTree()
    return { nodes, truncated }
  }

  /** The file tree. unread: a folder of it could not be listed, so the tree can miss files. */
  private async walkTree(): Promise<FileTree & { unread: boolean }> {
    let count = 0
    let truncated = false
    let unread = false
    const walk = async (dir: string, depth: number): Promise<FileNode[]> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        unread = true
        return []
      }
      entries = entries
        .filter((entry) => !isHiddenName(entry.name) && (entry.isDirectory() || entry.isFile()))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        })
      const nodes: FileNode[] = []
      for (const entry of entries) {
        if (count >= MAX_ENTRIES) {
          truncated = true
          break
        }
        count++
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          let children: FileNode[] = []
          if (depth < MAX_DEPTH) children = await walk(full, depth + 1)
          else truncated = true
          nodes.push({ name: entry.name, path: this.relOf(full), kind: 'dir', children })
        } else {
          nodes.push({ name: entry.name, path: this.relOf(full), kind: 'file' })
        }
      }
      return nodes
    }
    const nodes = await walk(this.root, 0)
    return { nodes, truncated, unread }
  }

  startWatching(events: FolderEvents): void {
    this.stopWatching()
    this.events = events
    this.listWalk = true
    try {
      this.watcher = watch(this.root, { recursive: true }, (_type, filename) => {
        if (!filename) return
        const rel = toPosix(filename.toString())
        if (rel.split('/').some(isHiddenName)) return
        this.pending.add(rel)
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => void this.flushWatch(events), WATCH_DEBOUNCE_MS)
      })
      this.watcher.on('error', (error) => console.error(`watch error: ${String(error)}`))
    } catch (error) {
      console.error(`could not watch ${this.root}: ${String(error)}`)
    }
  }

  private async flushWatch(events: FolderEvents): Promise<void> {
    this.debounce = null
    const paths = [...this.pending]
    this.pending.clear()
    const changed: string[] = []
    for (const rel of paths) if (!(await this.isOwnWrite(rel))) changed.push(rel)
    if (!changed.length) return
    console.log(`watch: changed outside the app: ${changed.join(', ')}`)
    events.filesChanged(await this.listFiles())
    // The list before the board events: a board gone on disk is gone from the list when the renderer closes it.
    this.listWalk = true
    try {
      const list = await this.nextList()
      if (this.events === events) events.boardsChanged(list)
    } catch (error) {
      console.error(`boards list: ${String(error)}`)
    }
    for (const rel of changed) {
      if (!isBoardPath(rel)) continue
      let text: string
      try {
        text = await readFile(join(this.root, rel), 'utf8')
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          this.knownHashes.delete(rel)
          events.boardChanged({ path: rel, deleted: true })
        }
        continue
      }
      const hash = hashText(text)
      if (this.knownHashes.get(rel) === hash) continue // last defence: our own write, or nothing new
      this.knownHashes.set(rel, hash)
      events.boardChanged({ path: rel, deleted: false })
    }
  }

  /** True when the file at `rel` is still the one our last write made. */
  private async isOwnWrite(rel: string): Promise<boolean> {
    const own = this.ownWrites.get(rel)
    if (!own) return false
    try {
      return fileIdentity(await stat(join(this.root, rel))) === own
    } catch {
      return false
    }
  }

  stopWatching(): void {
    this.events = null
    if (this.listTimer) clearTimeout(this.listTimer)
    this.listTimer = null
    this.watcher?.close()
    this.watcher = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.pending.clear()
  }

  // ---------- Boards ----------

  private async boardFullPath(rel: unknown, options: { allowMissing?: boolean } = {}): Promise<string> {
    if (typeof rel !== 'string' || !isBoardPath(rel)) throw new Error(`Not a board file: ${String(rel)}`)
    return this.resolvePath(rel, options)
  }

  async readBoard(rel: string): Promise<string> {
    const full = await this.boardFullPath(rel)
    const text = await readFile(full, 'utf8')
    this.knownHashes.set(rel, hashText(text))
    return text
  }

  /** Atomic write: a temp dotfile in the same folder, then rename over the target. */
  async writeBoard(rel: string, text: unknown): Promise<void> {
    if (typeof text !== 'string' || text.length > MAX_BOARD_BYTES) throw new Error('Invalid board content.')
    const full = await this.boardFullPath(rel, { allowMissing: true })
    await mkdir(dirname(full), { recursive: true })
    const temp = join(dirname(full), `.${basename(full)}.${process.pid}.${Date.now()}.tmp`)
    this.knownHashes.set(rel, hashText(text)) // set first, so the watcher ignores the echo
    try {
      await writeFile(temp, text, 'utf8')
      await rename(temp, full)
      const info = await stat(full)
      this.ownWrites.set(rel, fileIdentity(info))
      this.listEdits.set(rel, info.mtimeMs)
      this.boardsSoon()
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }

  /**
   * A new empty board in `folder` (default boards/). Without a name it is "Untitled N";
   * with a name, an existing board of that name is an error.
   */
  async createBoard(name?: unknown, folder?: unknown): Promise<string> {
    let dirRel = BOARDS_DIR
    if (folder !== undefined && folder !== null && folder !== '') {
      if (typeof folder !== 'string') throw new Error('folder must be a path inside the learning folder.')
      dirRel = toPosix(folder).replace(/^\.\/+/, '').replace(/\/+$/, '')
      if (!dirRel || dirRel === '.') throw new Error('A board must go in a subfolder of the learning folder, for example "boards".')
      if (dirRel.split('/').some((part) => isHiddenName(part) || part === '..')) throw new Error(`"${folder}" is not a folder for boards (hidden folders and ".." are not allowed).`)
    }
    const dir = await this.resolvePath(dirRel, { allowMissing: true })
    await mkdir(dir, { recursive: true })
    const existing = new Set((await readdir(dir)).map((entry) => entry.toLowerCase()))
    const make = async (base: string): Promise<string> => {
      const rel = posix.join(dirRel, `${base}${BOARD_SUFFIX}`)
      await this.writeBoard(rel, serializeBoard(emptyBoard()))
      this.ownWrites.delete(rel) // a new file: the watcher must list it
      return rel
    }
    if (name !== undefined && name !== null) {
      const clean = sanitizeBoardName(typeof name === 'string' ? name : '')
      if (!clean) throw new Error('A board name cannot be empty.')
      if (existing.has(`${clean}${BOARD_SUFFIX}`.toLowerCase())) throw new Error(`A board named "${clean}" already exists: ${posix.join(dirRel, `${clean}${BOARD_SUFFIX}`)}. open_board({board: "${posix.join(dirRel, `${clean}${BOARD_SUFFIX}`)}"}) opens it.`)
      return make(clean)
    }
    for (let n = 1; ; n++) {
      const base = n === 1 ? 'Untitled' : `Untitled ${n}`
      if (existing.has(`${base}${BOARD_SUFFIX}`.toLowerCase())) continue
      return make(base)
    }
  }

  /** Every board file of the file tree (the walk of listFiles: hidden folders skipped, the same caps), with its file identity and change time. */
  async boardFiles(): Promise<Array<{ path: string; identity: string; mtimeMs: number }>> {
    const paths = boardPaths((await this.listFiles()).nodes)
    const out = await Promise.all(
      paths.map(async (path) => {
        try {
          const info = await stat(join(this.root, path))
          return { path, identity: fileIdentity(info), mtimeMs: info.mtimeMs }
        } catch {
          return null
        }
      })
    )
    return out.filter((entry): entry is { path: string; identity: string; mtimeMs: number } => entry !== null)
  }

  /**
   * The boards list of the sidebar, newest edit first, read from the folder now. The main process owns the list:
   * it also sends it (events.boardsChanged) after own saves, creates, renames, trashes and changes on disk.
   */
  boardList(): Promise<BoardList> {
    this.listWalk = true
    return this.nextList()
  }

  /**
   * The next list, after the lists under way, so each list is newer than the one before (seq). A walk lists the board
   * files (boardFiles, the walk list_boards uses too); without one, the own saves since the last list patch it.
   */
  private nextList(): Promise<BoardList> {
    const run = this.listChain.then(async () => {
      const edits = this.listEdits
      this.listEdits = new Map()
      const known = this.listed ? new Set(this.listed.map((entry) => entry.path)) : null
      const walk = this.listWalk || !known || [...edits.keys()].some((path) => !known.has(path))
      this.listWalk = false
      let entries: BoardListEntry[]
      try {
        entries = walk ? (await this.boardFiles()).map(({ path, mtimeMs }) => boardEntry(path, mtimeMs)) : (this.listed as BoardListEntry[]).slice()
      } catch (error) {
        this.listWalk = true
        throw error
      }
      if (edits.size) entries = entries.map((entry) => (edits.has(entry.path) ? { ...entry, editedAt: Math.max(entry.editedAt, edits.get(entry.path) as number) } : entry))
      entries.sort(byEdit)
      this.listed = entries
      return { root: this.root, seq: ++this.listSeq, boards: entries }
    })
    this.listChain = run.catch(() => undefined)
    return run
  }

  /** Send the boards list soon: at most once per BOARD_LIST_DELAY_MS, so a burst of saves sends one list (the timer is not reset, so steady saves still send). */
  private boardsSoon(walk = false): void {
    if (walk) this.listWalk = true
    if (this.listTimer || !this.events) return
    const events = this.events
    this.listTimer = setTimeout(() => {
      this.listTimer = null
      this.nextList().then(
        (list) => {
          if (this.events === events) events.boardsChanged(list)
        },
        (error: unknown) => console.error(`boards list: ${String(error)}`)
      )
    }, BOARD_LIST_DELAY_MS)
  }

  /**
   * The id of every board of the folder, for finding the records of boards that are gone (main/storage.ts). Null when
   * the tree is not complete or a board cannot be read or parsed: a board that cannot be read is not a board that is gone.
   */
  async boardIds(): Promise<Set<string> | null> {
    const { nodes, truncated, unread } = await this.walkTree()
    if (truncated || unread) return null
    const ids = new Set<string>()
    for (const path of boardPaths(nodes)) {
      try {
        const { id } = parseBoard(await readFile(join(this.root, path), 'utf8'))
        if (id) ids.add(id)
      } catch {
        return null
      }
      await new Promise((done) => setImmediate(done))
    }
    return ids
  }

  /** A board file's text for list_boards. Unlike readBoard, it does not touch the watcher's record of known versions. */
  async readBoardText(rel: string): Promise<string> {
    return readFile(await this.boardFullPath(rel), 'utf8')
  }

  async renameBoard(rel: string, newName: unknown): Promise<string> {
    const from = await this.boardFullPath(rel)
    const name = sanitizeBoardName(typeof newName === 'string' ? newName : '')
    if (!name) throw new Error('A board name cannot be empty.')
    const dir = posix.dirname(rel)
    const target = dir === '.' ? `${name}${BOARD_SUFFIX}` : `${dir}/${name}${BOARD_SUFFIX}`
    if (target === rel) return rel
    const to = await this.boardFullPath(target, { allowMissing: true })
    // rename() replaces an existing target on every platform, so refuse any target that is another file. On a
    // case-insensitive folder (macOS, usually) "a" -> "A" names the same file (same dev and ino), and that rename is allowed.
    const existing = await stat(to).catch(() => null)
    if (existing) {
      const source = await stat(from)
      if (existing.dev !== source.dev || existing.ino !== source.ino) {
        throw new Error(`A board named "${name}" already exists: ${target}. Choose another name.`)
      }
    }
    await rename(from, to)
    this.listEdits.delete(rel)
    this.boardsSoon(true)
    const hash = this.knownHashes.get(rel)
    this.knownHashes.delete(rel)
    this.ownWrites.delete(rel)
    if (hash) this.knownHashes.set(target, hash)
    return target
  }

  async deleteBoard(rel: string): Promise<void> {
    const full = await this.boardFullPath(rel)
    await shell.trashItem(full)
    this.listEdits.delete(rel)
    this.boardsSoon(true)
    this.knownHashes.delete(rel)
    this.ownWrites.delete(rel)
  }

  // ---------- Other files ----------

  async readPreview(rel: string): Promise<FilePreview> {
    const full = await this.resolvePath(rel)
    const info = await stat(full)
    if (!info.isFile()) throw new Error(`Not a file: ${rel}`)
    const size = info.size
    const imageType = IMAGE_TYPES[extname(full).toLowerCase()]
    if (imageType) {
      if (size > MAX_IMAGE_PREVIEW) return { kind: 'too-large', size }
      const data = await readFile(full)
      return { kind: 'image', dataUrl: `data:${imageType};base64,${data.toString('base64')}`, size }
    }
    const handle = await open(full, 'r')
    try {
      const length = Math.min(size, MAX_TEXT_PREVIEW)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      if (buffer.subarray(0, 8000).includes(0)) return { kind: 'binary', size }
      return { kind: 'text', text: buffer.toString('utf8'), truncated: size > MAX_TEXT_PREVIEW, size }
    } finally {
      await handle.close()
    }
  }

  /**
   * A file for a world's code (main/live-item-protocol.ts): a regular file in the
   * folder, with no hidden name on its real path, so .learning-space/ stays apart.
   * A missing file throws ENOENT, as a directory does; any other refused path throws too.
   */
  async worldFile(rel: string): Promise<{ path: string; size: number; tag: string; type: string }> {
    // Before the file system, so a refused name gives 403 also when no such file exists. After it, so a link cannot lead to a refused file.
    if (!isWorldAsset(toPosix(relative(this.root, resolve(this.root, rel))))) throw new Error(worldRefusal(rel))
    const path = await realpath(await this.resolvePath(rel))
    const real = toPosix(relative(this.root, path))
    if (real.split('/').some(isHiddenName)) throw new Error(`Path is hidden: ${rel}`)
    if (!isWorldAsset(real)) throw new Error(worldRefusal(rel))
    const info = await stat(path)
    if (!info.isFile()) throw Object.assign(new Error(`Not a file: ${rel}`), { code: 'ENOENT' })
    const ext = extname(path).toLowerCase()
    return { path, size: info.size, tag: `${info.size}-${info.mtimeMs}`, type: IMAGE_TYPES[ext] ?? WORLD_TYPES[ext] ?? 'application/octet-stream' }
  }

  /**
   * An image file for an image node (served to <img> by the space-asset:
   * protocol). Same path guard as every other read; images only, and the
   * voice clips of said lines (main/voice.ts), which nothing else serves.
   */
  async readAsset(rel: string): Promise<{ data: Buffer; type: string }> {
    const full = await this.resolvePath(rel)
    const voice = VOICE_CLIP.test(toPosix(relative(this.root, full)))
    const type = voice ? 'audio/wav' : IMAGE_TYPES[extname(full).toLowerCase()]
    if (!type) throw new Error(`Not an image: ${rel}`)
    const info = await stat(full)
    if (!info.isFile()) throw new Error(`Not a file: ${rel}`)
    // A clip is as long as its scene.
    if (!voice && info.size > MAX_IMAGE_PREVIEW) throw new Error(`Image too large: ${rel}`)
    return { data: await readFile(full), type }
  }

  /**
   * Bring an image into the folder for an image node. Returns the
   * folder-relative path. https URLs are downloaded into assets/ through the
   * SSRF-checked downloader (public addresses, size cap, image types only); data: URLs are decoded into assets/; a relative
   * path must be an existing image inside the folder.
   */
  async importAsset(src: string): Promise<string> {
    const value = src.trim()
    if (/^data:/i.test(value)) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value)
      if (!match) throw new Error('A data: image must be base64 with an image/* type.')
      const ext = EXT_FOR_TYPE[match[1].toLowerCase()]
      if (!ext) throw new Error(`Image type ${match[1]} is not supported.`)
      const data = Buffer.from(match[2].replace(/\s+/g, ''), 'base64')
      if (data.length > MAX_ASSET_BYTES) throw new Error(`The image is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB.`)
      return this.saveAsset(data, 'image', ext)
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      // Agent-chosen URL: https only, public addresses only (see asset-fetch.ts).
      const { data, type, url } = await downloadImage(value, MAX_ASSET_BYTES, EXT_FOR_TYPE)
      const stem = basename(url.pathname).replace(/\.[^.]*$/, '')
      return this.saveAsset(data, stem, EXT_FOR_TYPE[type])
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error('Images must be https URLs, data: URLs or paths inside the learning folder.')
    const rel = value.replace(/^\.\//, '')
    let full: string
    try {
      full = await this.resolvePath(rel)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new Error(`There is no file ${rel} in the learning folder.`)
      throw error
    }
    if (!IMAGE_TYPES[extname(full).toLowerCase()]) throw new Error(`Not an image file: ${rel}`)
    const info = await stat(full)
    if (!info.isFile()) throw new Error(`Not a file: ${rel}`)
    return this.relOf(full)
  }

  /** Write image bytes to assets/<safe stem>-<hash>.<ext>; the same bytes reuse one file. */
  private async saveAsset(data: Buffer, stem: string, ext: string): Promise<string> {
    const safe = (stem.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image').toLowerCase()
    const hash = createHash('sha1').update(data).digest('hex').slice(0, 8)
    const rel = `${ASSETS_DIR}/${safe}-${hash}${ext}`
    const full = await this.resolvePath(rel, { allowMissing: true })
    await mkdir(dirname(full), { recursive: true })
    try {
      await stat(full)
    } catch {
      await writeFile(full, data)
    }
    return rel
  }

  /** Show a file in Finder. `.` opens the folder itself. */
  async reveal(rel: string): Promise<void> {
    if (rel === '.') {
      await shell.openPath(this.root)
      return
    }
    shell.showItemInFolder(await this.resolvePath(rel))
  }
}
