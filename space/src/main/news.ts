import { ago, clusterByPlace, placeText as box, plural, unionRegions } from '@shared/board-digest'
import type { BoardRect, LearnerNews, NewsItem } from '@shared/space-api'
import { getAgentLook, setAgentLook } from './state'

/**
 * Board news: what the learner did on the open board (drew, erased, added,
 * restored, moved, resized, edited or deleted items), delivered once to each
 * agent app.
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
      if (!news.added.length && !news.erased.length && !news.items.length && !news.scenePauses?.length) return ''
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

/**
 * Up to this many ink groups, and up to this many items per kind of change, are named one by
 * one. Above it the news gives a summary by unit and place, and points to get_changes, which
 * lists each change. Nothing is dropped: every change is in a count.
 */
const MANY = 4
/** Changes this close (board points) count as one area in a summary. */
const AREA_GAP = 400

/** Entries clustered by place, each area with its box. */
function areasOf<T>(entries: readonly T[], boundsOf: (entry: T) => BoardRect | null): Array<{ entries: T[]; bounds: BoardRect | null }> {
  return clusterByPlace(entries, boundsOf, AREA_GAP).map((list) => ({ entries: list, bounds: unionRegions(list.map(boundsOf)) }))
}

/** The verbs, in the order the line names them. */
const VERBS: Array<[NewsItem['change'], string]> = [
  ['added', 'added'],
  ['restored', 'restored'],
  ['moved', 'moved'],
  ['resized', 'resized'],
  ['edited', 'edited'],
  ['changed', 'changed'],
  ['deleted', 'deleted']
]

/** "600 pt right, 40 pt up", or '' for no offset. */
function offsetWords(offset: NewsItem['offset']): string {
  if (!offset) return ''
  const parts: string[] = []
  if (Math.round(offset.dx)) parts.push(`${Math.abs(Math.round(offset.dx))} pt ${offset.dx > 0 ? 'right' : 'left'}`)
  if (Math.round(offset.dy)) parts.push(`${Math.abs(Math.round(offset.dy))} pt ${offset.dy > 0 ? 'down' : 'up'}`)
  return parts.join(', ')
}

/** One item: 'your image "Fig 2A" 600 pt right (now 4200,0 1100×800)'. */
function itemWords(item: NewsItem): string {
  const offset = offsetWords(item.offset)
  const where = item.bounds && item.change !== 'deleted' ? ` (${item.change === 'added' ? '' : 'now '}${box(item.bounds)})` : ''
  return `${item.label}${offset ? ` ${offset}` : ''}${where}`
}

/** One clause per kind of change: 'moved your image "Fig 2A" 600 pt right (now …); ink group g3 …'. */
function itemClauses(items: readonly NewsItem[]): string[] {
  const clauses: string[] = []
  for (const [change, verb] of VERBS) {
    const these = items.filter((item) => item.change === change)
    if (!these.length) continue
    if (these.length <= MANY) {
      clauses.push(`${verb} ${these.map(itemWords).join('; ')}`)
      continue
    }
    // Many: by unit (whose and what kind), then by area.
    const units = new Map<string, number>()
    for (const item of these) units.set(item.unit ?? 'item', (units.get(item.unit ?? 'item') ?? 0) + 1)
    const areas = areasOf(these, (item) => item.bounds)
    const unitWords = [...units].map(([unit, count]) => `${unit} ${count}`).join(', ')
    const areaWords = areas.map((area) => `${area.entries.length} in ${area.bounds ? box(area.bounds) : 'no place'}`).join('; ')
    clauses.push(`${verb} ${these.length} items (${unitWords}) in ${plural(areas.length, 'area')}: ${areaWords}`)
  }
  return clauses
}

/**
 * One line, facts only. For example:
 * Board news for "Stars", since your last look or news 2 min ago: the learner drew 9 strokes:
 * ink group g12 (310,-40 280×210) right of your svg "Thermal spectra", and moved your image "Fig 2A"
 * 600 pt right (now 4200,0 1100×800). The last change was 40 s ago.
 */
export function formatNews(news: LearnerNews, since: number, now: number): string {
  const clauses: string[] = []
  const countIn = (id: string): number => news.added.filter((stroke) => stroke.group === id).length
  if (news.added.length && news.groups.length <= MANY) {
    const many = news.groups.length > 1
    const groups = news.groups.map((group) => `${many ? `${countIn(group.id)} in ` : ''}ink group ${group.id} (${box(group.bounds)})${group.where ? ` ${group.where}` : ''}`)
    clauses.push(`drew ${plural(news.added.length, 'stroke')}${groups.length ? `: ${groups.join('; ')}` : ''}`)
  } else if (news.added.length) {
    // Many groups: by area, each with its stroke count, group ids, box and place.
    const areas = areasOf(news.groups, (group) => group.bounds).map((area) => {
      const count = area.entries.reduce((sum, group) => sum + countIn(group.id), 0)
      const where = area.entries.find((group) => group.where)?.where
      return `${count} in ${area.entries.map((group) => group.id).join(', ')} (${area.bounds ? box(area.bounds) : 'no place'})${where ? ` ${where}` : ''}`
    })
    clauses.push(`drew ${plural(news.added.length, 'stroke')} in ${news.groups.length} ink groups, in ${plural(areas.length, 'area')}: ${areas.join('; ')}`)
  }
  const summarised = news.groups.length > MANY || VERBS.some(([change]) => news.items.filter((item) => item.change === change).length > MANY)
  if (news.erased.length) clauses.push(`erased ${plural(news.erased.length, 'stroke')}${news.erasedWhere ? ` ${news.erasedWhere}` : ''}`)
  clauses.push(...itemClauses(news.items))
  const times = [...news.added, ...news.erased, ...news.items].map((change) => change.at ?? 0).filter((at) => at > 0)
  const last = times.length ? Math.max(...times) : null
  // A live scene that paused because the learner started drawing.
  const marks = (news.marks ?? []).map((mark) => `The learner ${mark}.`)
  const pauses = (news.scenePauses ?? []).map(
    (pause) =>
      `Your scene ${pause.name ? `"${pause.name}"` : pause.scene} paused${pause.step ? ` at step "${pause.step}"` : ''} (${pause.t} s of ${Math.round(pause.duration * 10) / 10} s) because the learner started drawing; play_scene({action: "resume"}) continues it.`
  )
  return [
    clauses.length ? `Board news for "${news.boardName}", since your last look or news ${ago(since, now)}: the learner ${clauses.join(', and ')}.` : `Board news for "${news.boardName}":`,
    ...marks,
    ...pauses,
    last ? `The last change was ${ago(last, now)}.` : null,
    summarised ? 'get_changes() lists each change.' : null
  ]
    .filter(Boolean)
    .join(' ')
}
