import type { BoardRect, LearnerNews } from '@shared/space-api'
import { getAgentLook, setAgentLook } from './state'

/**
 * Board news: what the learner drew or erased on the open board, delivered
 * once to each agent app.
 *
 * Per agent app (the client label: "Codex", "Claude Code", …), learning folder
 * and board, the app keeps the board seq up to which the learner's changes
 * were delivered, in memory and in userData/state.json, so it survives a new
 * MCP connection and an app restart. News is delivered when it is sent: as the
 * first line of a tool result, or through GET /news (the `learning-space news`
 * prompt hook). A look (get_screenshot, get_changes) also counts as delivered.
 * The next news covers only the learner's changes after that. So the hook,
 * which runs before the prompt, and the tool results of the same turn never
 * send the same news twice.
 *
 * The state also keeps the seq of the app's last look, where a new
 * connection's change cursor starts (see AgentServer.startCursor), so
 * get_changes after a hook still lists the strokes the news named.
 */

type NewsRequest = (since: number) => Promise<LearnerNews | null>

export interface BoardNewsDeps {
  request: NewsRequest
  folderRoot(): string | null
  /** The board the window shows (folder-relative path), or null. */
  shownBoard(): string | null
}

export class BoardNews {
  /** Per app label: one delivery at a time, so two concurrent calls cannot both send the same news. */
  private readonly busy = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: BoardNewsDeps) {}

  private serial<T>(client: string, work: () => Promise<T>): Promise<T> {
    const previous = this.busy.get(client) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.catch(() => undefined)
    this.busy.set(client, settled)
    void settled.then(() => {
      if (this.busy.get(client) === settled) this.busy.delete(client)
    })
    return next
  }

  /**
   * Deliver the news for an agent app on the open board: the line, or '' when
   * nothing is new (or the app has never looked at this board). Marks it delivered.
   */
  deliver(client: string): Promise<string> {
    return this.serial(client, async () => {
      const root = this.deps.folderRoot()
      const board = this.deps.shownBoard()
      if (!root || !board) return ''
      const state = getAgentLook(client, root, board)
      if (!state) return ''
      const news = await this.deps.request(state.seq)
      if (!news || news.board !== board) return ''
      // The board's seq went back (the window reloaded and lost unsaved strokes): start again from now.
      if (news.cursor < state.seq) {
        setAgentLook(client, root, board, { seq: news.cursor, at: state.at, lookSeq: Math.min(state.lookSeq, news.cursor) })
        return ''
      }
      if (!news.added.length && !news.erased.length) return ''
      const now = Date.now()
      setAgentLook(client, root, board, { seq: news.cursor, at: now, lookSeq: state.lookSeq })
      return formatNews(news, state.at, now)
    })
  }

  /** An agent app looked at `board` (cursor = the board seq at the look): everything up to it counts as delivered. */
  looked(client: string, board: string, cursor: number): Promise<void> {
    return this.serial(client, async () => {
      const root = this.deps.folderRoot()
      if (!root || board !== this.deps.shownBoard()) return
      setAgentLook(client, root, board, { seq: cursor, at: Date.now(), lookSeq: cursor })
    })
  }
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
 * Board news for "Stars", since your last look or news 2 min ago: the learner drew 9 strokes:
 * ink group g12 (280×210 at 310, -40) right of your SVG "Thermal spectra". The last change was 40 s ago.
 */
export function formatNews(news: LearnerNews, since: number, now: number): string {
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
    `Board news for "${news.boardName}", since your last look or news ${ago(now - since)} ago: the learner ${clauses.join(', and ')}.`,
    last ? `The last change was ${ago(now - last)} ago.` : null
  ]
    .filter(Boolean)
    .join(' ')
}
