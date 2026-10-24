import type { BoardRect, LearnerNews, NewsStroke } from '@shared/space-api'
import { getAgentLook, setAgentLook } from './state'

/**
 * Board news: what the learner drew or erased on the open board since an
 * agent app's last look at it.
 *
 * A "look" is a get_screenshot or get_changes call. The last look is kept per
 * agent app (the client label: "Codex", "Claude Code", …), learning folder and
 * board, in memory and in userData/state.json, so it survives a new MCP
 * connection and an app restart. It holds the board seq at that look; strokes
 * with a higher seq are news until the agent sees them: a screenshot whose
 * rect holds at least half of a stroke, or a get_changes call that lists it.
 *
 * The news line goes at the start of every tool result of that agent app, and
 * the read-only GET /news route serves it to `learning-space news` (the hooks
 * that run before each prompt). It states facts only.
 */

type NewsRequest = (since: number, seen: Record<string, number>) => Promise<LearnerNews | null>

export interface BoardNewsDeps {
  request: NewsRequest
  folderRoot(): string | null
  /** The board the window shows (folder-relative path), or null. */
  shownBoard(): string | null
}

/** What a look showed: a board rect (a screenshot), or every change after a seq (get_changes; null = none). */
export type LookCoverage = { rect: BoardRect } | { after: number | null }

export class BoardNews {
  constructor(private readonly deps: BoardNewsDeps) {}

  /** The news line for an agent app on the open board, or '' when nothing is new (or nothing is known). */
  async line(client: string): Promise<string> {
    const root = this.deps.folderRoot()
    const board = this.deps.shownBoard()
    if (!root || !board) return ''
    const look = getAgentLook(client, root, board)
    if (!look) return ''
    const news = await this.deps.request(look.seq, look.seen)
    if (!news || news.board !== board) return ''
    const unseen = news.added.length + news.erased.length
    // The board's seq went back (the window reloaded and lost unsaved strokes), or the
    // seen strokes are all that was new: start again from now.
    if (news.cursor < look.seq || (unseen === 0 && Object.keys(look.seen).length > 0)) {
      setAgentLook(client, root, board, { seq: Math.min(look.seq, news.cursor), at: look.at, seen: {} })
    }
    if (unseen === 0 || news.cursor < look.seq) return ''
    return formatNews(news, look.at, Date.now())
  }

  /** An agent app looked at `board` (cursor = the board seq at the look). */
  async looked(client: string, board: string, cursor: number, coverage: LookCoverage): Promise<void> {
    const root = this.deps.folderRoot()
    if (!root || board !== this.deps.shownBoard()) return
    const now = Date.now()
    const look = getAgentLook(client, root, board)
    if (!look || cursor < look.seq) {
      setAgentLook(client, root, board, { seq: cursor, at: now, seen: {} })
      return
    }
    const news = await this.deps.request(look.seq, look.seen)
    if (!news || news.board !== board) return
    const seen = { ...look.seen }
    let left = 0
    for (const stroke of [...news.added, ...news.erased]) {
      if (covers(coverage, stroke)) seen[stroke.id] = stroke.seq
      else left++
    }
    // Everything new was seen: this look is the new baseline. Otherwise keep the old one and remember what was seen.
    if (left === 0) setAgentLook(client, root, board, { seq: news.cursor, at: now, seen: {} })
    else setAgentLook(client, root, board, { seq: look.seq, at: look.at, seen })
  }
}

function covers(coverage: LookCoverage, stroke: NewsStroke): boolean {
  if ('after' in coverage) return coverage.after !== null && stroke.seq > coverage.after
  const b = stroke.bounds
  if (!b) return false
  const r = coverage.rect
  const width = Math.min(b.x + b.width, r.x + r.width) - Math.max(b.x, r.x)
  const height = Math.min(b.y + b.height, r.y + r.height) - Math.max(b.y, r.y)
  if (b.width <= 0 || b.height <= 0) {
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height
  }
  return width > 0 && height > 0 && width * height >= 0.5 * b.width * b.height
}

function ago(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} days`
}

const strokes = (count: number): string => `${count} stroke${count === 1 ? '' : 's'}`
const box = (r: BoardRect): string => `${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.x)}, ${Math.round(r.y)}`

const MAX_GROUPS = 4

/**
 * One line, facts only. For example:
 * Board news: since your last look at "Stars" (2 min ago) the learner drew 9 strokes: ink group g12
 * (280×210 at 310, -40) right of your SVG "Thermal spectra". The last change was 40 s ago. You have
 * not looked at these changes yet.
 */
export function formatNews(news: LearnerNews, lookAt: number, now: number): string {
  const clauses: string[] = []
  if (news.added.length) {
    const many = news.groups.length > 1
    const groups = news.groups.slice(0, MAX_GROUPS).map((group) => {
      const count = news.added.filter((stroke) => stroke.group === group.id).length
      return `${many ? `${count} in ` : ''}ink group ${group.id} (${box(group.bounds)})${group.where ? ` ${group.where}` : ''}`
    })
    const more = news.groups.length - MAX_GROUPS
    if (more > 0) groups.push(`${more} more group${more === 1 ? '' : 's'}`)
    clauses.push(`drew ${strokes(news.added.length)}${groups.length ? `: ${groups.join('; ')}` : ''}`)
  }
  if (news.erased.length) clauses.push(`erased ${strokes(news.erased.length)}${news.erasedWhere ? ` ${news.erasedWhere}` : ''}`)
  const times = [...news.added, ...news.erased].map((stroke) => stroke.at ?? 0).filter((at) => at > 0)
  const last = times.length ? Math.max(...times) : null
  return [
    `Board news: since your last look at "${news.boardName}" (${ago(now - lookAt)} ago) the learner ${clauses.join(', and ')}.`,
    last ? `The last change was ${ago(now - last)} ago.` : null,
    'You have not looked at these changes yet.'
  ]
    .filter(Boolean)
    .join(' ')
}
