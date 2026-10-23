import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import { downloadImage } from './asset-fetch'
import { BOARD_SUFFIX, BOARDS_DIR, emptyBoard, isBoardPath, serializeBoard } from '@shared/board-format'
import type { BoardChange, FileNode, FilePreview, FileTree } from '@shared/space-api'

const MAX_DEPTH = 10
const MAX_ENTRIES = 5000
const MAX_TEXT_PREVIEW = 1024 * 1024
const MAX_IMAGE_PREVIEW = 20 * 1024 * 1024
const MAX_BOARD_BYTES = 64 * 1024 * 1024
const WATCH_DEBOUNCE_MS = 150
/** Images that agents bring in (downloads, data: URLs) are capped at this size. */
const MAX_ASSET_BYTES = 10 * 1024 * 1024
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

/** Names the listing and the watcher skip: dotfiles, dot-dirs, node_modules. */
const isHiddenName = (name: string): boolean => name.startsWith('.') || name === 'node_modules'

const hashText = (text: string): string => createHash('sha1').update(text).digest('hex')

const toPosix = (path: string): string => path.split(sep).join('/')

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined
}

/** File-name-safe board name: no separators, no control characters, no leading dots. */
export function sanitizeBoardName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
}

export interface FolderEvents {
  filesChanged(tree: FileTree): void
  boardChanged(change: BoardChange): void
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
    let count = 0
    let truncated = false
    const walk = async (dir: string, depth: number): Promise<FileNode[]> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
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
    return { nodes, truncated }
  }

  startWatching(events: FolderEvents): void {
    this.stopWatching()
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
    const changed = [...this.pending]
    this.pending.clear()
    events.filesChanged(await this.listFiles())
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
      if (this.knownHashes.get(rel) === hash) continue // our own write, or nothing new
      this.knownHashes.set(rel, hash)
      events.boardChanged({ path: rel, deleted: false })
    }
  }

  stopWatching(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.pending.clear()
  }

  // ---------- Boards ----------

  private async resolveBoard(rel: unknown, options: { allowMissing?: boolean } = {}): Promise<string> {
    if (typeof rel !== 'string' || !isBoardPath(rel)) throw new Error(`Not a board file: ${String(rel)}`)
    return this.resolvePath(rel, options)
  }

  async readBoard(rel: string): Promise<string> {
    const full = await this.resolveBoard(rel)
    const text = await readFile(full, 'utf8')
    this.knownHashes.set(rel, hashText(text))
    return text
  }

  /** Atomic write: a temp dotfile in the same folder, then rename over the target. */
  async writeBoard(rel: string, text: unknown): Promise<void> {
    if (typeof text !== 'string' || text.length > MAX_BOARD_BYTES) throw new Error('Invalid board content.')
    const full = await this.resolveBoard(rel, { allowMissing: true })
    await mkdir(dirname(full), { recursive: true })
    const temp = join(dirname(full), `.${basename(full)}.${process.pid}.${Date.now()}.tmp`)
    this.knownHashes.set(rel, hashText(text)) // set first, so the watcher ignores the echo
    try {
      await writeFile(temp, text, 'utf8')
      await rename(temp, full)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }

  async createBoard(): Promise<string> {
    const dir = await this.resolvePath(BOARDS_DIR, { allowMissing: true })
    await mkdir(dir, { recursive: true })
    const existing = new Set((await readdir(dir)).map((name) => name.toLowerCase()))
    for (let n = 1; ; n++) {
      const name = n === 1 ? 'Untitled' : `Untitled ${n}`
      if (existing.has(`${name}${BOARD_SUFFIX}`.toLowerCase())) continue
      const rel = posix.join(BOARDS_DIR, `${name}${BOARD_SUFFIX}`)
      await this.writeBoard(rel, serializeBoard(emptyBoard()))
      return rel
    }
  }

  async renameBoard(rel: string, newName: unknown): Promise<string> {
    const from = await this.resolveBoard(rel)
    const name = sanitizeBoardName(typeof newName === 'string' ? newName : '')
    if (!name) throw new Error('A board name cannot be empty.')
    const dir = posix.dirname(rel)
    const target = dir === '.' ? `${name}${BOARD_SUFFIX}` : `${dir}/${name}${BOARD_SUFFIX}`
    if (target === rel) return rel
    const to = await this.resolveBoard(target, { allowMissing: true })
    // macOS folders are usually case-insensitive: "a" -> "A" is the same file.
    const caseOnly = target.toLowerCase() === rel.toLowerCase()
    if (!caseOnly && (await stat(to).then(() => true, () => false))) {
      throw new Error(`A board named "${name}" already exists here.`)
    }
    await rename(from, to)
    const hash = this.knownHashes.get(rel)
    this.knownHashes.delete(rel)
    if (hash) this.knownHashes.set(target, hash)
    return target
  }

  async deleteBoard(rel: string): Promise<void> {
    const full = await this.resolveBoard(rel)
    await shell.trashItem(full)
    this.knownHashes.delete(rel)
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
   * An image file for an image node (served to <img> by the space-asset:
   * protocol). Same path guard as every other read; images only.
   */
  async readAsset(rel: string): Promise<{ data: Buffer; type: string }> {
    const full = await this.resolvePath(rel)
    const type = IMAGE_TYPES[extname(full).toLowerCase()]
    if (!type) throw new Error(`Not an image: ${rel}`)
    const info = await stat(full)
    if (!info.isFile()) throw new Error(`Not a file: ${rel}`)
    if (info.size > MAX_IMAGE_PREVIEW) throw new Error(`Image too large: ${rel}`)
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
    const full = await this.resolvePath(rel)
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
