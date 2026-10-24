#!/usr/bin/env node
/**
 * Summarise Learning Space session traces (see src/main/trace.ts).
 *
 *   node scripts/trace-report.mjs <trace.jsonl | folder> [--json] [--all]
 *
 * A folder is searched recursively for *.jsonl session traces
 * (learner-edits.jsonl is read as learner edits, not as a session). Sessions of
 * the bench's own client ("ls-bench") are skipped unless --all is given.
 *
 * Per session and in total: wall time (session open to the end of the last call), calls, per-tool count and time, tool
 * time vs gap (agent) time, screenshots and image bytes, time to the first
 * board write, new top-level frames, words of visible text written to the
 * board, and the board rect of every screenshot.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WRITE_TOOLS = new Set(['create_frame', 'write_html', 'update_styles', 'set_text', 'move_nodes', 'duplicate_nodes', 'delete_nodes', 'draw_ink'])
export const LOOK_TOOLS = new Set(['get_screenshot', 'get_changes', 'get_canvas_info', 'get_tree'])
export const BENCH_CLIENT = 'ls-bench'

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

/** learner-edits.jsonl beside a trace file, if any. */
function learnerEditsBeside(file) {
  const path = join(dirname(file), 'learner-edits.jsonl')
  return existsSync(path) ? readJsonl(path) : []
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

/** Visible words an agent call put on the board. */
export function wordsOfCall(call) {
  if (!call.ok) return 0
  const args = call.args ?? {}
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

/** New top-level frames/nodes made by a call: create_frame, or write_html into "root". */
export function newTopLevel(call) {
  if (!call.ok) return 0
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
  if (args.node_id) return `node ${args.node_id}`
  if (args.region) return `region ${rectText(args.region)}`
  return `target ${args.target ?? 'viewport'}`
}

export const rectText = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}` : '-')

// ---------- Analysis ----------

const ms = (iso) => Date.parse(iso)

export function analyzeSession(events, { file = null, learnerEdits = [] } = {}) {
  const open = events.find((e) => e.type === 'session_open') ?? null
  const close = events.find((e) => e.type === 'session_close') ?? null
  const calls = events.filter((e) => e.type === 'tool_call')
  const edits = events.filter((e) => e.type === 'learner_edit')
  const startMs = open ? ms(open.t) : calls.length ? ms(calls[0].t) : null
  const lastCallEnd = calls.length ? Math.max(...calls.map((c) => ms(c.end ?? c.t))) : startMs
  // Wall time ends at the last call: clients like `claude -p` exit without closing, so session_close can come much later.
  const endMs = calls.length ? lastCallEnd : close ? ms(close.t) : startMs

  const perTool = {}
  let toolMs = 0
  let gapMs = 0
  let imageBytes = 0
  let words = 0
  let frames = 0
  let firstWrite = null
  const screenshots = []
  for (const call of calls) {
    const entry = (perTool[call.tool] ??= { calls: 0, ms: 0, errors: 0 })
    entry.calls++
    entry.ms += call.duration_ms ?? 0
    if (!call.ok) entry.errors++
    toolMs += call.duration_ms ?? 0
    gapMs += call.gap_ms ?? 0
    words += wordsOfCall(call)
    frames += newTopLevel(call)
    if (firstWrite === null && WRITE_TOOLS.has(call.tool) && call.ok) firstWrite = call
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
    return { t: edit.t, ids: edit.ids, bounds: edit.bounds, next_look_ms: look ? ms(look.t) - ms(edit.t) : null, next_look_tool: look?.tool ?? null }
  })
  // The learner's last edit before the session opened -> the first look.
  let lastEditToFirstLookMs = null
  if (startMs !== null && learnerEdits.length) {
    const before = learnerEdits.filter((e) => ms(e.t) <= startMs && (!open?.board || e.board === open.board))
    const firstLook = calls.find((c) => LOOK_TOOLS.has(c.tool))
    if (before.length && firstLook) lastEditToFirstLookMs = ms(firstLook.t) - ms(before[before.length - 1].t)
  }

  return {
    file: file ? basename(file) : null,
    session_id: open?.session_id ?? null,
    client: open?.client ?? null,
    board: open?.board ?? null,
    start: startMs !== null ? new Date(startMs).toISOString() : null,
    closed: Boolean(close),
    wall_ms: startMs !== null && endMs !== null ? endMs - startMs : 0,
    calls: calls.length,
    errors: calls.filter((c) => !c.ok).length,
    tool_ms: toolMs,
    gap_ms: gapMs,
    per_tool: perTool,
    screenshots: screenshots.length,
    image_bytes: imageBytes,
    first_write_ms: firstWrite && startMs !== null ? ms(firstWrite.t) - startMs : null,
    first_write_tool: firstWrite?.tool ?? null,
    new_top_level: frames,
    words,
    screenshot_list: screenshots,
    learner_edits: editToLook,
    last_learner_edit_to_first_look_ms: lastEditToFirstLookMs
  }
}

export function analyzeFile(file) {
  return analyzeSession(readJsonl(file), { file, learnerEdits: learnerEditsBeside(file) })
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
    `wall ${sec(s.wall_ms)}   calls ${s.calls}${s.errors ? ` (${s.errors} failed)` : ''}   tool time ${sec(s.tool_ms)}   agent (gap) time ${sec(s.gap_ms)}`,
    `screenshots ${s.screenshots} (${kb(s.image_bytes)})   new top-level ${s.new_top_level}   words on the board ${s.words}` +
      (s.first_write_ms !== undefined ? `   first write ${sec(s.first_write_ms)}${s.first_write_tool ? ` (${s.first_write_tool})` : ''}` : '')
  ]
}

export function printReport({ sessions, total }) {
  const out = []
  for (const s of sessions) {
    out.push(`== ${s.file}  ${s.client?.name ?? '?'} ${s.client?.version ?? ''}  board ${s.board ?? '-'}  ${s.start ?? ''}${s.closed ? '' : '  (no session_close)'}`)
    out.push(...summaryLines(s))
    if (s.last_learner_edit_to_first_look_ms !== null) out.push(`learner's last edit before the session -> first look: ${sec(s.last_learner_edit_to_first_look_ms)}`)
    out.push('', toolTable(s.per_tool))
    if (s.screenshot_list.length) {
      out.push(
        '',
        table(
          s.screenshot_list.map((shot, i) => [i + 1, shot.request, rectText(shot.rect), kb(shot.bytes), shot.t.slice(11, 19)]),
          ['#', 'asked for', 'board rect covered', 'image', 'time']
        )
      )
    }
    for (const edit of s.learner_edits) out.push(`learner edit ${edit.t.slice(11, 19)} ${rectText(edit.bounds)} -> next look ${sec(edit.next_look_ms)} (${edit.next_look_tool ?? '-'})`)
    out.push('')
  }
  if (sessions.length > 1) {
    out.push(`== total: ${total.sessions} sessions`)
    out.push(...summaryLines({ ...total, first_write_ms: undefined }))
    out.push('', toolTable(total.per_tool), '')
  }
  if (!sessions.length) out.push('No session traces found.')
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
