import { boardName, parseBoard, BOARD_SUFFIX } from '@shared/board-format'
import { boardTexts, digestBoard, savedCorners, searchTexts, type BoardDigest, type TextEntry, type TextMatch } from '@shared/board-digest'
import type { FolderSession } from './folder'

/**
 * The view of the learning folder for list_boards, open_board and move_board (docs/learning-space/drafts/board-tools-redesign-2026-10-27.md, 4b):
 * one summary per board and the text each board holds, for list_boards and its search.
 *
 * Nothing is indexed ahead of time. Each call walks the folder and stats
 * every board; a board whose file identity (inode, mtime, size) is the one
 * cached is not read again. So the cache is right after the app's own saves
 * (an atomic save makes a new inode), after changes on disk that the watcher
 * does not report, and after a rename or trash (moved, forget). The open board
 * comes from the renderer's memory, with its unsaved changes.
 */

/** The open board as the renderer holds it (handler.ts boardDigest). */
export interface OpenBoardInfo {
  path: string
  unsaved: boolean
  digest: BoardDigest
  /** The learner's ink groups on it. */
  groups: number
  matches?: Array<TextMatch & { place: string }>
}

interface Cached {
  identity: string
  digest: BoardDigest | null
  texts: TextEntry[]
  corners: Map<string, [number, number]>
  error?: string
}

export interface BoardFile {
  path: string
  mtimeMs: number
  cached: Cached
}

const num = (value: number): string => Math.round(value).toLocaleString('en-US')
const plural = (count: number, word: string, many = `${word}s`): string => `${num(count)} ${count === 1 ? word : many}`
const q = (value: string): string => JSON.stringify(value)
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')

function ago(ms: number, now: number): string {
  const seconds = Math.max(1, Math.round((now - ms) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return new Date(ms).toISOString().slice(0, 10)
}

export class BoardIndex {
  private readonly cache = new Map<string, Cached>()

  /** Every board of the folder, read from its file when it changed since the last call. readMs: time spent reading and parsing. */
  async files(folder: FolderSession): Promise<{ files: BoardFile[]; read: number; readMs: number }> {
    const listed = await folder.boardFiles()
    const seen = new Set<string>()
    let read = 0
    const start = performance.now()
    const files: BoardFile[] = []
    for (const { path, identity, mtimeMs } of listed) {
      seen.add(path)
      let cached = this.cache.get(path)
      if (!cached || cached.identity !== identity) {
        read++
        cached = await readOne(folder, path, identity)
        this.cache.set(path, cached)
      }
      files.push({ path, mtimeMs, cached })
    }
    for (const path of [...this.cache.keys()]) if (!seen.has(path)) this.cache.delete(path)
    return { files, read, readMs: performance.now() - start }
  }

  /** A board was renamed (the file keeps its identity). */
  moved(from: string, to: string | null): void {
    const cached = this.cache.get(from)
    this.cache.delete(from)
    if (cached && to) this.cache.set(to, cached)
  }

  clear(): void {
    this.cache.clear()
  }
}

async function readOne(folder: FolderSession, path: string, identity: string): Promise<Cached> {
  try {
    const doc = parseBoard(await folder.readBoardText(path))
    return { identity, digest: digestBoard(doc.nodes), texts: boardTexts(doc.nodes), corners: savedCorners(doc.nodes) }
  } catch (error) {
    return { identity, digest: null, texts: [], corners: new Map(), error: error instanceof Error ? error.message : String(error) }
  }
}

/** "learner ink 340 strokes in 12 groups · yours 8 items, 3 scenes · other 2 · “title”". */
function countsText(digest: BoardDigest, groups: number | null): string {
  const parts: string[] = []
  if (digest.learnerStrokes) parts.push(`learner ink ${plural(digest.learnerStrokes, 'stroke')}${groups !== null ? ` in ${plural(groups, 'group')}` : ''}`)
  const yours: string[] = []
  if (digest.agentItems) yours.push(plural(digest.agentItems, 'item'))
  if (digest.agentStrokes) yours.push(`${plural(digest.agentStrokes, 'ink stroke')}`)
  if (digest.scenes) yours.push(plural(digest.scenes, 'scene'))
  if (yours.length) parts.push(`yours ${yours.join(', ')}`)
  if (digest.other) parts.push(`other ${plural(digest.other, 'item')}`)
  if (!parts.length) parts.push('empty')
  if (digest.title) parts.push(`“${digest.title}”`)
  return parts.join(' · ')
}

/** list_boards without a query: one line per board, grouped by folder when there are several, newest first. */
export function listText(folderName: string, files: BoardFile[], open: OpenBoardInfo | null, now: number): string {
  const byDir = new Map<string, BoardFile[]>()
  for (const file of files) byDir.set(dirOf(file.path), [...(byDir.get(dirOf(file.path)) ?? []), file])
  const dirs = [...byDir.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  const line = (file: BoardFile): string => {
    const isOpen = open?.path === file.path
    const state = isOpen ? `open${open.unsaved ? ', unsaved changes' : ''} · ` : ''
    const digest = isOpen ? open.digest : file.cached.digest
    const counts = digest ? countsText(digest, isOpen ? open.groups : null) : `cannot be read: ${file.cached.error ?? 'unknown error'}`
    return `${file.path} · ${state}changed ${ago(file.mtimeMs, now)} · ${counts}`
  }
  const lines = [
    `${plural(files.length, 'board')} in the learning folder ${q(folderName)}${open ? `; the open board is ${open.path}` : '; none is open'}. Each line: path, last change, the learner's ink in strokes (in ink groups only for the open board), your items and scenes, other items, and the first words of the title.`
  ]
  if (!files.length) lines.push('No boards yet: open_board({board: "…", create: true}) makes one.')
  for (const dir of dirs) {
    const list = (byDir.get(dir) as BoardFile[]).sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (dirs.length > 1) lines.push(`${dir === '.' ? 'At the top of the folder' : `${dir}/`} (${list.length}):`)
    for (const file of list) lines.push(`${dirs.length > 1 ? '  ' : ''}${line(file)}`)
  }
  if (files.length) lines.push('', 'Deeper: list_boards({query: "…"}) searches their text · open_board({board: "…"}) opens one.')
  return lines.join('\n')
}

/** Above this many matches in all boards, a search gives one line per board, and each board opens in full with one call. */
const FIND_SUMMARY_AT = 25

/** list_boards with a query: the matches per board, with their words in context, ids and places. */
export function findText(query: string, files: BoardFile[], open: OpenBoardInfo | null, only: string | null): string {
  const needle = query.toLowerCase().trim()
  if (!needle) throw new Error('query needs the words to search for.')
  type Block = { path: string; head: string; lines: string[]; count: number; first: string }
  const blocks: Block[] = []
  for (const file of files) {
    if (only && file.path !== only) continue
    const isOpen = open?.path === file.path
    const lines: string[] = []
    if (boardName(file.path).toLowerCase().includes(needle)) lines.push(`  the board's name “${boardName(file.path)}”`)
    if (isOpen) {
      for (const match of open.matches ?? []) lines.push(`  ${matchLabel(match)} · ${match.place} · ${matchWords(match)}`)
    } else {
      for (const match of searchTexts(file.cached.texts, query)) {
        const corner = file.cached.corners.get(match.id)
        lines.push(`  ${matchLabel(match)} · ${corner ? `at ${Math.round(corner[0])},${Math.round(corner[1])}` : 'no place'} · ${matchWords(match)}`)
      }
    }
    if (!lines.length) continue
    const head = isOpen ? `${file.path} (the open board${open.unsaved ? ', with its unsaved changes' : ''}; places are "x,y w×h"):` : `${file.path} (closed; places are the saved top-left corners, "at x,y"):`
    blocks.push({ path: file.path, head, lines, count: lines.length, first: lines[0].trim() })
  }
  const total = blocks.reduce((sum, block) => sum + block.count, 0)
  const scope = only ? `the board ${only}` : `${plural(files.length, 'board')}`
  const out = [`Search for ${q(query)} in ${scope} (board and item names, text, HTML, SVG text, image files, code): ${plural(total, 'match', 'matches')}${blocks.length ? ` in ${plural(blocks.length, 'board')}` : ''}.`]
  if (!only && total > FIND_SUMMARY_AT) {
    out.push('One line per board; its call shows all its matches:')
    for (const block of blocks) out.push(`${block.path}: ${plural(block.count, 'match', 'matches')}, first ${block.first} · list_boards({query: ${q(query)}, board: ${q(block.path)}})`)
  } else {
    for (const block of blocks) out.push(block.head, ...block.lines)
  }
  out.push("Handwriting is not text: the app cannot read ink. To read the learner's writing, open the board and use get_screenshot.")
  if (blocks.length) out.push(`Deeper: open_board({board: "…"}), then list_items({query: ${q(query)}}) shows the matches in place.`)
  return out.join('\n')
}

function matchLabel(match: TextMatch): string {
  return `${match.kind}${match.name ? ` ${q(match.name)}` : ''} ${match.id}${match.parent ? ` · inside ${match.parent}` : ''}`
}

function matchWords(match: TextMatch): string {
  return `${match.field === 'text' || match.field === 'svg text' ? '' : `${match.field} `}“${match.context}”`
}

/**
 * The board a path or a name points at. A path must be a board of the folder; a name
 * (with or without ".board.json", any case) must be the name of exactly one board.
 */
export function resolveBoard(files: BoardFile[], ref: string, exactOnly: boolean): { path: string } | { error: string } {
  const text = ref.trim()
  const exact = files.find((file) => file.path === text)
  if (exact) return { path: exact.path }
  if (exactOnly) {
    const named = files.filter((file) => boardName(file.path).toLowerCase() === boardName(text).toLowerCase())
    return { error: `${q(text)} is not the path of a board in this folder. move_board takes an exact path from list_boards() or list_items()${named.length ? `, such as ${named.map((file) => q(file.path)).join(' or ')}` : ''}.` }
  }
  const name = (text.endsWith(BOARD_SUFFIX) ? boardName(text) : text).toLowerCase()
  const named = files.filter((file) => boardName(file.path).toLowerCase() === name)
  if (named.length === 1) return { path: named[0].path }
  if (named.length > 1) return { error: `${plural(named.length, 'board')} have the name ${q(text)}, so none was opened. Open one by its path:\n${named.map((file) => `  open_board({board: ${q(file.path)}})`).join('\n')}` }
  const near = files.filter((file) => boardName(file.path).toLowerCase().includes(name))
  return { error: `No board has the path or name ${q(text)}.${near.length ? ` Names that hold it: ${near.map((file) => q(file.path)).join(', ')}.` : ''} list_boards() lists the boards.` }
}
