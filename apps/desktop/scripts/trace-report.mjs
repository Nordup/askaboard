#!/usr/bin/env node
/**
 * Summarise Askaboard session traces (see src/main/trace.ts).
 *
 *   node scripts/trace-report.mjs <trace.jsonl | folder> [--json] [--all]
 *
 * A folder is searched recursively for *.jsonl session traces
 * (learner-edits.jsonl is read as learner edits, not as a session). Sessions of
 * the bench's own client ("ls-bench") are skipped unless --all is given.
 *
 * Per session and in total: wall time (session open to the end of the last call), calls, per-tool count and time, tool
 * time vs gap time, screenshots and image bytes, time to the first board
 * write, new top-level frames, words of visible text written to the board, the
 * board rect of every screenshot, the boards the session touched, and the
 * learner's edits on those boards from the first call to 2 minutes after the
 * last one.
 *
 * Gaps (time between calls) fall into two classes: up to 60 s ("model time,
 * probably") and over 60 s ("idle or long thinking": the person thinking or
 * talking). This is a heuristic: MCP has no turn boundaries.
 *
 * Learner edits come from learner-edits.jsonl in the day folders the session
 * spans, plus the copies that older session files hold (duplicates dropped by
 * board + time + ids). A call's board is its `board` field; older files without
 * it fall back to the board named by session_open, open_board and the results.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// play_scene (start, cut, clear_queue) writes since 2026-10-26, run_scene from stage 4 (2026-10-25) to then; the others are in traces from before.
export const WRITE_TOOLS = new Set(['play_scene', 'run_scene', 'create_frame', 'write_html', 'update_styles', 'set_text', 'move_nodes', 'duplicate_nodes', 'delete_nodes', 'draw_ink'])
const PLAY_WRITES = new Set(['start', 'cut', 'clear_queue'])
/** A call that changed the board: a write tool, except a run_scene preview (it draws nothing) and play_scene's other actions. */
export const isWrite = (call) => WRITE_TOOLS.has(call.tool) && !(call.tool === 'run_scene' && call.args?.preview) && !(call.tool === 'play_scene' && !PLAY_WRITES.has(call.args?.action))
// list_items since 2026-10-27 (get_board for a day before it; get_canvas_info and get_tree in older traces).
export const LOOK_TOOLS = new Set(['get_screenshot', 'get_changes', 'list_items', 'get_board', 'get_canvas_info', 'get_tree'])
export const BENCH_CLIENT = 'ls-bench'
/** A gap up to this long counts as the model's time; a longer one as idle or long thinking. */
export const MODEL_GAP_MS = 60_000
/** Learner edits up to this long after a session's last call still belong to it. */
export const EDIT_TAIL_MS = 2 * 60_000

// ---------- Reading ----------

export function readJsonl(file) {
  const events = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A line cut by a crash: skip it.
    }
  }
  return events
}

export function findTraceFiles(target) {
  const full = resolve(target)
  if (!existsSync(full)) throw new Error(`No such file or folder: ${target}`)
  if (statSync(full).isFile()) return [full]
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl') && entry.name !== 'learner-edits.jsonl') out.push(path)
    }
  }
  walk(full)
  return out.sort()
}

const editsCache = new Map()
function readEditsFile(path) {
  if (!editsCache.has(path)) editsCache.set(path, existsSync(path) ? readJsonl(path).filter((e) => e.type === 'learner_edit') : [])
  return editsCache.get(path)
}

const pad2 = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/**
 * learner-edits.jsonl of every day folder from fromMs to toMs (local dates, as trace.ts names
 * them), when the trace sits in a <root>/<YYYY-MM-DD>/ folder; else the file beside it.
 */
function learnerEditsAround(file, fromMs, toMs) {
  const dayDir = dirname(file)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(basename(dayDir)) || fromMs === null || toMs === null) return readEditsFile(join(dayDir, 'learner-edits.jsonl'))
  const root = dirname(dayDir)
  const days = new Set([basename(dayDir)])
  for (let t = fromMs; t <= toMs + 86_400_000; t += 86_400_000) {
    const day = localDate(new Date(Math.min(t, toMs)))
    days.add(day)
  }
  return [...days].sort().flatMap((day) => readEditsFile(join(root, day, 'learner-edits.jsonl')))
}

/** One list of learner edits, sorted by time, each edit once (by board + time + ids). */
export function dedupeEdits(edits) {
  const seen = new Set()
  const out = []
  for (const edit of edits) {
    const key = `${edit.board}\n${edit.t}\n${(edit.ids ?? []).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(edit)
  }
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
}

/** The board named in a call's result text (screenshots, get_changes, canvas info), if any. */
function boardInResult(call) {
  const text = call.result_text ?? ''
  const match = /^Board "([^"]+)"/.exec(text) ?? /"board":\s*(?:\{\s*"path":\s*)?"([^"]+\.board\.json)"/.exec(text)
  return match ? match[1] : null
}

/**
 * The board of each call: its own `board` field. Older traces lack it, and their session_open
 * board was read at connect time (it can be a board the person left before the first call), so
 * there the board comes from open_board targets and boards named in results: carried forward to
 * later calls, back to the calls before the first one named, and session_open's only when no call
 * names any board.
 */
export function callBoards(open, calls) {
  if (calls.every((call) => call.board !== undefined)) return calls.map((call) => call.board ?? null)
  const named = calls.map((call) =>
    call.board !== undefined
      ? call.board
      : call.tool === 'open_board' && call.ok && typeof (call.args?.board ?? call.args?.path) === 'string'
        ? (call.args.board ?? call.args.path)
        : boardInResult(call)
  )
  const first = named.find(Boolean) ?? open?.board ?? null
  let current = first
  return named.map((board) => (current = board ?? current))
}

// ---------- Text on the board ----------

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Words of visible text: tags stripped, a $math$ span counts as one word. */
export function countWords(text) {
  if (typeof text !== 'string' || !text) return 0
  let plain = text
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
  plain = decodeEntities(plain)
  let words = 0
  plain = plain.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g, () => {
    words++
    return ' '
  })
  const tokens = plain.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu)
  return words + (tokens ? tokens.length : 0)
}

/**
 * Visible words an agent call put on the board. drafts: the session's
 * write_scene programs by name (filled here), so play_scene start counts the
 * program it plays.
 */
export function wordsOfCall(call, drafts = new Map()) {
  if (!call.ok) return 0
  const args = call.args ?? {}
  if (call.tool === 'write_scene') {
    if (typeof args.name === 'string' && typeof args.code === 'string') drafts.set(args.name, args.code)
    return 0
  }
  const code = call.tool === 'run_scene' ? (args.preview ? null : args.code) : call.tool === 'play_scene' && args.action === 'start' ? drafts.get(args.name) : null
  if (call.tool === 'run_scene' || call.tool === 'play_scene') {
    // An estimate from the program's text: the literal text it puts on the board (html(), text(), write(), label(), edit()).
    if (typeof code !== 'string') return 0
    if (call.tool === 'play_scene') drafts.delete(args.name)
    let words = 0
    for (const match of code.matchAll(/\b(?:html|text|write|label|edit)\(\s*(?:[\w.]+\s*,\s*)?(?:\{\s*text:\s*)?(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g)) words += countWords(match[2].replace(/\$\{[^}]*\}/g, ' '))
    return words
  }
  if (call.tool === 'write_html') return countWords(args.html)
  if (call.tool === 'set_text') return (args.updates ?? []).reduce((sum, update) => sum + countWords(update?.text), 0)
  return 0
}

function parseResult(call) {
  try {
    return JSON.parse(call.result_text ?? '')
  } catch {
    return null
  }
}

/**
 * New frames made by a call: play_scene start's (run_scene's) material whose root is a frame
 * (items of kind "frame", and "group" frames of named groups) that no
 * earlier call of the session listed (`seen` holds the ids already counted);
 * in traces from before stage 4, create_frame, or write_html into "root".
 */
export function newTopLevel(call, seen = new Set()) {
  if (!call.ok) return 0
  if (call.tool === 'run_scene' || (call.tool === 'play_scene' && call.args?.action === 'start')) {
    if (call.args?.preview) return 0
    const items = parseResult(call)?.items
    if (!Array.isArray(items)) return 0
    let count = 0
    for (const item of items) {
      if ((item?.kind !== 'frame' && item?.kind !== 'group') || seen.has(item.id)) continue
      seen.add(item.id)
      count++
    }
    return count
  }
  if (call.tool === 'create_frame') return 1
  if (call.tool === 'write_html' && call.args?.target_id === 'root' && (call.args?.mode ?? 'insert_children') === 'insert_children') {
    const created = parseResult(call)?.created
    return Array.isArray(created) ? created.length : 1
  }
  return 0
}

// ---------- Screenshots ----------

/** The board rect a screenshot covered, from its result text. */
export function screenshotRect(call) {
  const match = /covers the board rect (\{[^}]*\})/.exec(call.result_text ?? '')
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

export function screenshotRequest(call) {
  const args = call.args ?? {}
  // part since 2026-10-27; node_id, region and target before.
  const part = args.part
  if (part !== undefined) {
    if (typeof part === 'string') return `part ${part}`
    if (part.region) return `region ${rectText(part.region)}`
    return `part ${JSON.stringify(part)}`
  }
  if (args.node_id) return `node ${args.node_id}`
  if (args.region) return `region ${rectText(args.region)}`
  return `target ${args.target ?? 'viewport'}`
}

export const rectText = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}` : '-')

// ---------- Analysis ----------

const ms = (iso) => Date.parse(iso)

/**
 * learnerEdits: edits from learner-edits.jsonl (any board, any time); the edits copied into older
 * session files are added. Only edits on the boards the session's calls used, in the same folder,
 * from the first call to EDIT_TAIL_MS after the last call's end, belong to the session.
 */
export function analyzeSession(events, { file = null, learnerEdits = [] } = {}) {
  const open = events.find((e) => e.type === 'session_open') ?? null
  const close = events.find((e) => e.type === 'session_close') ?? null
  const calls = events.filter((e) => e.type === 'tool_call')
  const boardOfCall = callBoards(open, calls)
  const boards = [...new Set(boardOfCall.filter(Boolean))]
  const pool = dedupeEdits([...learnerEdits, ...events.filter((e) => e.type === 'learner_edit')])
  const windowFrom = calls.length ? ms(calls[0].t) : null
  const windowTo = calls.length ? Math.max(...calls.map((c) => ms(c.end ?? c.t))) + EDIT_TAIL_MS : null
  const sameFolder = (edit) => !edit.folder || !open?.folder || edit.folder === open.folder
  const edits =
    windowFrom === null ? [] : pool.filter((e) => boards.includes(e.board) && sameFolder(e) && ms(e.t) >= windowFrom && ms(e.t) <= windowTo)
  const startMs = open ? ms(open.t) : calls.length ? ms(calls[0].t) : null
  const lastCallEnd = calls.length ? Math.max(...calls.map((c) => ms(c.end ?? c.t))) : startMs
  // Wall time ends at the last call: clients like `claude -p` exit without closing, so session_close can come much later.
  const endMs = calls.length ? lastCallEnd : close ? ms(close.t) : startMs

  const perTool = {}
  let toolMs = 0
  let gapMs = 0
  const gaps = { model_ms: 0, model_count: 0, idle_ms: 0, idle_count: 0 }
  let imageBytes = 0
  let words = 0
  let frames = 0
  const framesSeen = new Set()
  const drafts = new Map()
  let firstWrite = null
  const screenshots = []
  for (const call of calls) {
    const entry = (perTool[call.tool] ??= { calls: 0, ms: 0, errors: 0 })
    entry.calls++
    entry.ms += call.duration_ms ?? 0
    if (!call.ok) entry.errors++
    toolMs += call.duration_ms ?? 0
    gapMs += call.gap_ms ?? 0
    if ((call.gap_ms ?? 0) > MODEL_GAP_MS) {
      gaps.idle_ms += call.gap_ms
      gaps.idle_count++
    } else {
      gaps.model_ms += call.gap_ms ?? 0
      gaps.model_count++
    }
    words += wordsOfCall(call, drafts)
    frames += newTopLevel(call, framesSeen)
    if (firstWrite === null && isWrite(call) && call.ok) firstWrite = call
    for (const image of call.images ?? []) imageBytes += image.bytes ?? 0
    if (call.tool === 'get_screenshot') {
      screenshots.push({
        t: call.t,
        request: screenshotRequest(call),
        args: call.args ?? {},
        rect: screenshotRect(call),
        images: call.images ?? [],
        bytes: (call.images ?? []).reduce((sum, image) => sum + (image.bytes ?? 0), 0),
        ok: call.ok
      })
    }
  }

  // Learner edit -> the agent's next look (in this session).
  const editToLook = edits.map((edit) => {
    const look = calls.find((c) => LOOK_TOOLS.has(c.tool) && ms(c.t) >= ms(edit.t))
    return { t: edit.t, board: edit.board, ids: edit.ids, strokes: edit.strokes ?? null, bounds: edit.bounds, next_look_ms: look ? ms(look.t) - ms(edit.t) : null, next_look_tool: look?.tool ?? null }
  })
  // The learner's last edit before the session opened -> the first look.
  let lastEditToFirstLookMs = null
  const firstBoard = boards[0] ?? open?.board ?? null
  if (startMs !== null && pool.length) {
    const before = pool.filter((e) => ms(e.t) <= startMs && sameFolder(e) && (!firstBoard || e.board === firstBoard))
    const firstLook = calls.find((c) => LOOK_TOOLS.has(c.tool))
    if (before.length && firstLook) lastEditToFirstLookMs = ms(firstLook.t) - ms(before[before.length - 1].t)
  }

  return {
    file: file ? basename(file) : null,
    session_id: open?.session_id ?? null,
    client: open?.client ?? null,
    board: firstBoard,
    open_board: open?.board ?? null,
    boards,
    start: startMs !== null ? new Date(startMs).toISOString() : null,
    closed: Boolean(close),
    wall_ms: startMs !== null && endMs !== null ? endMs - startMs : 0,
    calls: calls.length,
    errors: calls.filter((c) => !c.ok).length,
    tool_ms: toolMs,
    gap_ms: gapMs,
    gap_model_ms: gaps.model_ms,
    gap_model_count: gaps.model_count,
    gap_idle_ms: gaps.idle_ms,
    gap_idle_count: gaps.idle_count,
    per_tool: perTool,
    screenshots: screenshots.length,
    image_bytes: imageBytes,
    first_write_ms: firstWrite && startMs !== null ? ms(firstWrite.t) - startMs : null,
    first_write_tool: firstWrite?.tool ?? null,
    new_top_level: frames,
    words,
    screenshot_list: screenshots,
    learner_edits: editToLook,
    learner_strokes: edits.reduce((sum, e) => sum + (e.strokes ?? 0), 0),
    learner_window: windowFrom === null ? null : { from: new Date(windowFrom).toISOString(), to: new Date(windowTo).toISOString() },
    last_learner_edit_to_first_look_ms: lastEditToFirstLookMs
  }
}

export function analyzeFile(file) {
  const events = readJsonl(file)
  const calls = events.filter((e) => e.type === 'tool_call')
  const open = events.find((e) => e.type === 'session_open')
  const from = open ? ms(open.t) : calls.length ? ms(calls[0].t) : null
  const to = calls.length ? Math.max(...calls.map((c) => ms(c.end ?? c.t))) + EDIT_TAIL_MS : from
  return analyzeSession(events, { file, learnerEdits: learnerEditsAround(file, from, to) })
}

export function totalOf(sessions) {
  const perTool = {}
  for (const s of sessions) {
    for (const [tool, entry] of Object.entries(s.per_tool)) {
      const sum = (perTool[tool] ??= { calls: 0, ms: 0, errors: 0 })
      sum.calls += entry.calls
      sum.ms += entry.ms
      sum.errors += entry.errors
    }
  }
  const add = (key) => sessions.reduce((sum, s) => sum + (s[key] ?? 0), 0)
  return {
    sessions: sessions.length,
    wall_ms: add('wall_ms'),
    calls: add('calls'),
    errors: add('errors'),
    tool_ms: add('tool_ms'),
    gap_ms: add('gap_ms'),
    gap_model_ms: add('gap_model_ms'),
    gap_model_count: add('gap_model_count'),
    gap_idle_ms: add('gap_idle_ms'),
    gap_idle_count: add('gap_idle_count'),
    per_tool: perTool,
    screenshots: add('screenshots'),
    image_bytes: add('image_bytes'),
    new_top_level: add('new_top_level'),
    words: add('words')
  }
}

export function report(target, { all = false } = {}) {
  const sessions = findTraceFiles(target)
    .map(analyzeFile)
    .filter((s) => all || s.client?.name !== BENCH_CLIENT)
  return { sessions, total: totalOf(sessions) }
}

// ---------- Printing ----------

const sec = (value) => (value === null || value === undefined ? '-' : `${(value / 1000).toFixed(1)} s`)
/** Local wall-clock time of an ISO timestamp, HH:MM:SS. */
const localTime = (iso) => {
  const d = new Date(iso)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`

function table(rows, header) {
  const all = [header, ...rows].map((row) => row.map((cell) => String(cell)))
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i].length)))
  const line = (row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ')
  return [line(all[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...all.slice(1).map(line)].join('\n')
}

function toolTable(perTool) {
  const rows = Object.entries(perTool)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([tool, e]) => [tool, e.calls, sec(e.ms), e.errors || ''])
  return table(rows, ['tool', 'calls', 'time', 'errors'])
}

function summaryLines(s) {
  return [
    `wall ${sec(s.wall_ms)}   calls ${s.calls}${s.errors ? ` (${s.errors} failed)` : ''}   tool time ${sec(s.tool_ms)}   time between calls ${sec(s.gap_ms)}:`,
    `  model time, probably (gaps up to ${MODEL_GAP_MS / 1000} s): ${sec(s.gap_model_ms)} in ${s.gap_model_count} gaps   idle or long thinking (gaps over ${MODEL_GAP_MS / 1000} s): ${sec(s.gap_idle_ms)} in ${s.gap_idle_count} gaps`,
    `screenshots ${s.screenshots} (${kb(s.image_bytes)})   new top-level ${s.new_top_level}   words on the board ${s.words}` +
      (s.first_write_ms !== undefined ? `   first write ${sec(s.first_write_ms)}${s.first_write_tool ? ` (${s.first_write_tool})` : ''}` : '')
  ]
}

export function printReport({ sessions, total }) {
  const out = []
  for (const s of sessions) {
    out.push(`== ${s.file}  ${s.client?.name ?? '?'} ${s.client?.version ?? ''}  ${s.start ? localTime(s.start) : ''}${s.closed ? '' : '  (no session_close)'}`)
    out.push(`boards touched: ${s.boards.length ? s.boards.join(', ') : '-'}${s.open_board && !s.boards.includes(s.open_board) ? `   (shown at connect: ${s.open_board})` : ''}`)
    out.push(...summaryLines(s))
    if (s.last_learner_edit_to_first_look_ms !== null) out.push(`learner's last edit before the session -> first look: ${sec(s.last_learner_edit_to_first_look_ms)}`)
    out.push('', toolTable(s.per_tool))
    if (s.screenshot_list.length) {
      out.push(
        '',
        table(
          s.screenshot_list.map((shot, i) => [i + 1, shot.request, rectText(shot.rect), kb(shot.bytes), localTime(shot.t)]),
          ['#', 'asked for', 'board rect covered', 'image', 'time']
        )
      )
    }
    if (s.learner_window) {
      out.push(
        '',
        `learner edits on these boards, ${localTime(s.learner_window.from)} to ${localTime(s.learner_window.to)} (first call to last call + ${EDIT_TAIL_MS / 60_000} min): ${s.learner_edits.length} edits, ${s.learner_strokes} strokes` +
          (s.learner_edits.length ? `, last at ${localTime(s.learner_edits[s.learner_edits.length - 1].t)}` : '')
      )
    }
    for (const edit of s.learner_edits) out.push(`learner edit ${localTime(edit.t)} ${s.boards.length > 1 ? `${edit.board} ` : ''}${rectText(edit.bounds)} -> next look ${sec(edit.next_look_ms)} (${edit.next_look_tool ?? '-'})`)
    out.push('')
  }
  if (sessions.length > 1) {
    out.push(`== total: ${total.sessions} sessions`)
    out.push(...summaryLines({ ...total, first_write_ms: undefined }))
    out.push('', toolTable(total.per_tool), '')
  }
  if (!sessions.length) out.push('No session traces found.')
  else out.push(`The gap split is a heuristic: MCP has no turn boundaries, so a gap over ${MODEL_GAP_MS / 1000} s is counted as the person thinking or talking. Times are local.`)
  return out.join('\n')
}

// ---------- CLI ----------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const all = args.includes('--all')
  const target = args.find((arg) => !arg.startsWith('--'))
  if (!target) {
    console.error('usage: node scripts/trace-report.mjs <trace.jsonl | folder> [--json] [--all]')
    process.exit(1)
  }
  try {
    const result = report(target, { all })
    console.log(asJson ? JSON.stringify(result, null, 2) : printReport(result))
  } catch (error) {
    console.error(`trace-report: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
