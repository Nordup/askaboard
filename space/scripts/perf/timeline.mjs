/**
 * Where a run's time went, from the run folder only: the agent's transcript
 * (archived into the folder), the app's tool calls (calls.json) and the app's
 * scene events (trace/). One copy of this logic: run.mjs and metrics.mjs both
 * call runTimeline.
 *
 * - model turns: one model response each. Claude: start = its api-request
 *   entry, end = its last content block. Codex: start = the tool output (or
 *   the user message) before it, end = its token_usage_record. Output tokens
 *   include reasoning; context tokens are Claude input + cache read + cache
 *   write, Codex input.
 * - own calls: the agent's own tools (Claude: every tool that is not an MCP
 *   tool, and server web search; Codex: shell commands, sleeps, web searches,
 *   with failed exec scripts and failed MCP items as "could not do").
 * - partition: each instant of the wall time goes to one bucket, in this
 *   order: play_scene waits, MCP tools, own tools, model, startup (agent start
 *   to the first model request), tail (after the last call), unattributed.
 * - scene events: the board's first frame of each scene and its end (outcome).
 */
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
const jsonLines = (file) =>
  file && existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(parse)
        .filter(Boolean)
    : []
const r2 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100) / 100)
const len = (v) => (v === null || v === undefined ? 0 : typeof v === 'string' ? v.length : JSON.stringify(v).length)
const one = (s, n = 110) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

// ---------- Archive ----------

/** The archived transcript's name in a run folder. */
export const archiveName = (client) => (client === 'codex' ? 'rollout-codex.jsonl' : 'transcript-claude.jsonl')

/** Copy the agent's transcript into the run folder (when the original is there and the copy is not). Returns the copy's path or null. */
export function archiveTranscript(dir, client, original) {
  const copy = join(dir, archiveName(client))
  if (!existsSync(copy) && original && existsSync(original)) copyFileSync(original, copy)
  return existsSync(copy) ? copy : null
}

// ---------- Intervals ----------

function merge(spans) {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out = []
  for (const [a, b] of s) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}
const total = (spans) => spans.reduce((n, [a, b]) => n + (b - a), 0)
function subtract(from, cut) {
  const out = []
  for (const [s, e] of from) {
    let cur = s
    for (const [a, b] of cut) {
      if (b <= cur || a >= e) continue
      if (a > cur) out.push([cur, a])
      cur = Math.max(cur, b)
      if (cur >= e) break
    }
    if (cur < e) out.push([cur, e])
  }
  return out
}

// ---------- Claude ----------

const DENIED = /needs approval|permission|not allowed|denied|requires approval|was blocked|Operation not permitted/i

function claudeTranscript(file, t0) {
  const rows = jsonLines(file)
  const requests = rows.filter((r) => r.type === 'api-request' && (r.querySource ?? 'sdk') === 'sdk').map((r) => Date.parse(r.timestamp))
  const results = new Map()
  const msgs = new Map()
  const own = []
  let lastInput = null
  let firstPrompt = null
  const harness = { client: 'claude', version: null, permission_mode: null }
  for (const r of rows) {
    if (r.version && !harness.version) harness.version = r.version
    if (r.permissionMode && !harness.permission_mode) harness.permission_mode = r.permissionMode
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isSidechain) continue
    const t = Date.parse(r.timestamp)
    const content = r.message?.content
    if (r.type === 'user') {
      if (typeof content === 'string') firstPrompt ??= t
      else for (const b of content ?? []) if (b?.type === 'tool_result') results.set(b.tool_use_id, { t, block: b, extra: r.toolUseResult })
      lastInput = t
      continue
    }
    const id = r.message?.id
    if (!msgs.has(id)) msgs.set(id, { after: lastInput, end: t, usage: r.message.usage ?? {}, texts: [], tools: [] })
    const m = msgs.get(id)
    m.end = Math.max(m.end, t)
    m.usage = r.message.usage ?? m.usage
    for (const b of content ?? []) {
      if (b?.type === 'text') m.texts.push(b.text)
      else if (b?.type === 'tool_use' || b?.type === 'server_tool_use') m.tools.push({ id: b.id, name: b.type === 'server_tool_use' ? `server:${b.name}` : b.name, input: b.input ?? {}, t })
      else if (b?.type === 'web_search_tool_result') results.set(b.tool_use_id, { t, block: b })
    }
  }
  const list = [...msgs.values()]
  const turns = list.map((m, i) => {
    const u = m.usage
    const start = requests.length === list.length ? requests[i] : (m.after ?? m.end)
    return {
      n: i + 1,
      start,
      end: m.end,
      out: u.output_tokens ?? 0,
      reasoning: u.output_tokens_details?.thinking_tokens ?? null,
      ctx: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cached: u.cache_read_input_tokens ?? 0,
      calls: m.tools.map((x) => x.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')),
      text: one(m.texts.join(' '), 90)
    }
  })
  for (const m of list)
    for (const x of m.tools) {
      if (x.name.startsWith('mcp__')) continue
      const res = results.get(x.id)
      const block = res?.block
      const isError = Boolean(block?.is_error)
      const text = typeof block?.content === 'string' ? block.content : Array.isArray(block?.content) ? block.content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join(' ') : ''
      const input = x.input
      const detail = x.name === 'Bash' ? input.command : ['Write', 'Edit', 'MultiEdit', 'Read'].includes(x.name) ? input.file_path : x.name === 'ToolSearch' ? input.query : JSON.stringify(input)
      own.push({ start: x.t, end: res ? res.t : x.t, tool: x.name.replace(/^server:/, ''), detail: one(detail), chars: len(block?.content), status: !res ? 'no result' : isError ? (DENIED.test(text) ? 'denied' : 'failed') : 'ok', error: isError ? text.slice(0, 300) : null })
    }
  // What the agent received: the request shapes (system prompt and tools, per change).
  const shapes = rows
    .filter((r) => r.type === 'api-request-shape' && r.shape)
    .map((r) => {
      const tools = r.shape.tools ?? []
      const mcp = tools.filter((x) => String(x?.name ?? '').startsWith('mcp__'))
      return { t_s: r2((Date.parse(r.timestamp) - t0) / 1000), system_chars: len(r.shape.system), tools: tools.length, tools_chars: len(tools), mcp_tools: mcp.length, mcp_tools_chars: len(mcp) }
    })
  return { turns, own, could: [], firstRequest: requests.length ? requests[0] : turns[0]?.start ?? null, firstPrompt, received: { shapes }, harness }
}

// ---------- Codex ----------

function codexRolloutParse(file, t0) {
  const rows = jsonLines(file)
  const turns = []
  const own = []
  const could = []
  let start = null
  let pendingText = ''
  let pendingCalls = []
  let firstPrompt = null
  const harness = { client: 'codex', version: null, sandbox: null, approval: null, network: null }
  const received = { base_instructions_chars: null, tools: null, agents_md_chars: null }
  const execs = new Map()
  for (const r of rows) {
    const p = r.payload ?? {}
    const t = Date.parse(r.timestamp)
    if (r.type === 'session_meta') {
      harness.version = p.cli_version ?? null
      received.base_instructions_chars = typeof p.base_instructions === 'object' ? len(p.base_instructions?.text) : len(p.base_instructions)
    } else if (r.type === 'turn_context' && !harness.sandbox) {
      harness.sandbox = p.sandbox_policy?.type ?? null
      harness.network = p.sandbox_policy?.network_access ?? (p.sandbox_policy?.type === 'danger-full-access' ? true : null)
      harness.approval = p.approval_policy ?? null
    } else if (r.type === 'world_state' && received.agents_md_chars === null) received.agents_md_chars = len(p.state?.agents_md?.text) || null
    else if (r.type === 'response_item' && p.type === 'additional_tools' && !received.tools) {
      const flat = (p.tools ?? []).flatMap((ns) => (ns.tools ? ns.tools.map((x) => ({ ...x, ns: ns.name })) : [ns]))
      received.tools = { count: flat.length, chars: len(p.tools), names: flat.map((x) => x.name) }
    }
    if (r.type === 'event_msg' && p.type === 'item_completed') {
      const it = p.item ?? {}
      const s = p.started_at_ms ?? t
      const e = p.completed_at_ms ?? t
      if (it.type === 'UserMessage' && firstPrompt === null) {
        firstPrompt = s
        start = e
      } else if (it.type === 'CommandExecution') {
        const cmd = Array.isArray(it.command) ? it.command[it.command.length - 1] : String(it.command ?? '')
        const ok = it.exit_code === 0 || it.exit_code === null || it.exit_code === undefined
        const out = String(it.aggregated_output ?? '')
        own.push({ start: s, end: e, tool: 'shell', detail: one(cmd), chars: out.length, status: ok ? 'ok' : DENIED.test(out) || /sandbox/i.test(out) ? 'denied' : 'failed', error: ok ? null : `exit ${it.exit_code}: ${out.slice(-300)}` })
      } else if (it.type === 'Extension') {
        own.push({ start: s, end: e, tool: it.kind ?? 'extension', detail: it.durationMs ? `${it.durationMs} ms` : '', chars: 0, status: 'ok', error: null })
      } else if (it.type === 'WebSearch' || /search/i.test(it.type ?? '')) {
        own.push({ start: s, end: e, tool: 'web_search', detail: one(it.query ?? JSON.stringify(it.action ?? '')), chars: 0, status: 'ok', error: null })
      } else if (it.type === 'FileChange') {
        own.push({ start: s, end: e, tool: 'apply_patch', detail: one((Array.isArray(it.changes) ? it.changes : Object.values(it.changes ?? {})).map((c) => c?.path ?? '').join(', ')), chars: 0, status: it.status === 'failed' ? 'failed' : 'ok', error: it.status === 'failed' ? one(JSON.stringify(it), 300) : null })
      } else if (it.type === 'McpToolCall' && it.status && it.status !== 'completed') {
        could.push({ t: s, tool: `mcp ${it.tool}`, status: 'failed', error: one(JSON.stringify(it.error ?? it.result ?? it.status), 300) })
      }
    }
    if (r.type === 'response_item' && p.type === 'message' && p.role === 'assistant') pendingText = (p.content ?? []).map((c) => c?.text ?? '').join(' ')
    if (r.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      execs.set(p.call_id, { t, name: p.name, input: p.input ?? p.arguments ?? '' })
      pendingCalls.push(p.name)
    }
    if (r.type === 'response_item' && (p.type === 'custom_tool_call_output' || p.type === 'function_call_output')) {
      const call = execs.get(p.call_id)
      const text = Array.isArray(p.output) ? p.output.map((c) => c?.text ?? '').join('\n') : String(p.output ?? '')
      if (call && /^Script (failed|error)|^Error|Uncaught|TypeError|ReferenceError|SyntaxError/m.test(text.slice(0, 400)) && !/^Script completed/.test(text)) {
        could.push({ t: call.t, tool: `${call.name} script`, status: 'failed', error: text.slice(0, 300) })
      }
      start = t
    }
    if (r.type === 'token_usage_record') {
      const u = p.usage ?? {}
      turns.push({ n: turns.length + 1, start: start ?? t, end: t, out: u.output_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? null, ctx: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, calls: pendingCalls, text: one(pendingText, 90) })
      pendingText = ''
      pendingCalls = []
      start = null
    }
  }
  return { turns, own, could, firstRequest: turns[0]?.start ?? null, firstPrompt, received, harness }
}

// ---------- App scene events ----------

/** The scene events of the app trace (trace.ts scene_event), from sinceMs on, oldest first. */
export function sceneEvents(tracesDir, sinceMs = 0) {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl') && e.name !== 'learner-edits.jsonl') for (const x of jsonLines(p)) if (x.type === 'scene_event' && Date.parse(x.t) >= sinceMs) out.push(x)
    }
  }
  walk(tracesDir)
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
}

// ---------- The timeline of a run ----------

const isWait = (c) => (c.tool === 'play_scene' && (c.args?.wait === 'end' || c.args?.action === 'wait')) || (c.tool === 'scene_control' && c.args?.action === 'wait')

/**
 * The timeline of one model run. metrics: its metrics.json (client, timestamp,
 * time.wall); calls: calls.json; dir: the run folder. Returns the new
 * metrics fields (null where the run has no data) and the timeline.md text.
 */
export function runTimeline(dir, metrics, calls) {
  const t0 = Date.parse(metrics.timestamp)
  const wallEnd = t0 + (metrics.time?.wall ?? 0) * 1000
  const rel = (ms) => r2((ms - t0) / 1000)
  const file = existsSync(join(dir, archiveName(metrics.client))) ? join(dir, archiveName(metrics.client)) : null
  const agent = !file ? { turns: [], own: [], could: [], firstRequest: null, firstPrompt: null, received: null, harness: null } : metrics.client === 'codex' ? codexRolloutParse(file, t0) : claudeTranscript(file, t0)
  const mcp = calls.map((c) => ({ start: t0 + c.t_s * 1000, end: t0 + (c.end_s ?? c.t_s) * 1000, c }))
  const waits = mcp.filter((x) => isWait(x.c))
  const tools = mcp.filter((x) => !isWait(x.c))

  // The partition of the wall time.
  let rest = [[t0, wallEnd]]
  const parts = {}
  const take = (name, spans) => {
    const m = merge(spans.map(([a, b]) => [Math.max(a, t0), Math.min(b, wallEnd)]))
    const before = total(rest)
    rest = subtract(rest, m)
    parts[name] = r2((before - total(rest)) / 1000)
  }
  const lastCall = Math.max(t0, ...mcp.map((x) => x.end), ...agent.own.map((x) => x.end))
  take('waits_s', waits.map((x) => [x.start, x.end]))
  take('mcp_s', tools.map((x) => [x.start, x.end]))
  take('own_s', agent.own.map((x) => [x.start, x.end]))
  take('model_s', agent.turns.map((x) => [x.start, x.end]))
  take('startup_s', agent.firstRequest ? [[t0, agent.firstRequest]] : [])
  take('tail_s', [[lastCall, wallEnd]])
  parts.unattributed_s = r2(total(rest) / 1000)
  parts.wall_s = r2((wallEnd - t0) / 1000)

  // Turns.
  const turns = agent.turns.map((x) => {
    const dur = (x.end - x.start) / 1000
    return { n: x.n, start_s: rel(x.start), end_s: rel(x.end), s: r2(dur), out: x.out, reasoning: x.reasoning, ctx: x.ctx, cached: x.cached, tok_s: dur > 0 ? r2(x.out / dur) : null, calls: x.calls, text: x.text }
  })
  const speeds = turns.map((x) => x.tok_s).filter((v) => v !== null).sort((a, b) => a - b)
  const model = turns.length
    ? {
        turns: turns.length,
        output_tokens: turns.reduce((n, x) => n + x.out, 0),
        reasoning_tokens: turns.reduce((n, x) => n + (x.reasoning ?? 0), 0),
        first_context: turns[0].ctx,
        max_context: Math.max(...turns.map((x) => x.ctx)),
        tok_s_median: speeds.length ? speeds[Math.floor(speeds.length / 2)] : null,
        generation_s: r2(turns.reduce((n, x) => n + x.s, 0))
      }
    : null

  // Own calls and what could not be done.
  const own = agent.own.map((x) => ({ start_s: rel(x.start), s: r2((x.end - x.start) / 1000), tool: x.tool, detail: x.detail, chars: x.chars, status: x.status, error: x.error }))
  const couldNot = [
    ...own.filter((x) => x.status !== 'ok').map((x) => ({ t_s: x.start_s, what: `${x.tool}: ${x.detail}`, status: x.status, error: (x.error ?? '').slice(0, 300) })),
    // A failed MCP item of the client that the app also traced as failed is listed once, from the app.
    ...agent.could
      .filter((x) => !(x.tool.startsWith('mcp ') && calls.some((c) => !c.ok && `mcp ${c.tool}` === x.tool && Math.abs(t0 + c.t_s * 1000 - x.t) < 2000)))
      .map((x) => ({ t_s: rel(x.t), what: x.tool, status: x.status, error: x.error })),
    ...calls.filter((c) => !c.ok).map((c) => ({ t_s: r2(c.t_s), what: `MCP ${c.tool} ${one(JSON.stringify(c.args ?? {}), 80)}`, status: 'failed', error: String(c.error ?? c.result ?? '').slice(0, 300) }))
  ].sort((a, b) => a.t_s - b.t_s)
  const ownByTool = {}
  for (const x of own) {
    const p = (ownByTool[x.tool] ??= { calls: 0, failed: 0, denied: 0, s: 0 })
    p.calls++
    if (x.status === 'failed') p.failed++
    if (x.status === 'denied') p.denied++
    p.s = r2(p.s + (x.s ?? 0))
  }

  // App spans and scene events.
  const events = sceneEvents(join(dir, 'trace'), t0)
  const firstFrames = events.filter((e) => e.kind === 'first_frame')
  const ends = events.filter((e) => e.kind === 'end')
  const visibleEnds = ends.filter((e) => e.outcome === 'played' || e.outcome === 'stopped')
  const scenes = {}
  for (const e of events) {
    const s = (scenes[e.scene] ??= { scene: e.scene, name: e.name, first_frame_s: null, end_s: null, outcome: null, replaced: [] })
    if (e.kind === 'first_frame' && s.first_frame_s === null) s.first_frame_s = rel(Date.parse(e.t))
    if (e.kind === 'end') {
      s.end_s = rel(Date.parse(e.t))
      s.outcome = e.outcome ?? null
    }
    if (e.kind === 'replaced') s.replaced.push({ t_s: rel(Date.parse(e.t)), how: e.outcome ?? null })
  }
  const spans = calls.filter((c) => c.spans).map((c) => ({ t_s: r2(c.t_s), tool: c.tool, ms: c.ms, ...c.spans }))

  // Milestones.
  const at = (pred) => {
    const c = calls.find(pred)
    return c ? r2(c.t_s) : null
  }
  const milestones = {
    first_model_request: agent.firstRequest ? rel(agent.firstRequest) : null,
    first_mcp_call: calls.length ? r2(calls[0].t_s) : null,
    first_write_scene: at((c) => c.tool === 'write_scene' || c.tool === 'run_scene'),
    first_play: at((c) => (c.tool === 'play_scene' && c.args?.action === 'start') || (c.tool === 'run_scene' && !c.args?.preview)),
    first_stroke: firstFrames.length ? rel(Date.parse(firstFrames[0].t)) : null,
    scene_ends: Object.values(scenes).map((s) => ({ name: s.name, end_s: s.end_s, outcome: s.outcome })),
    last_call_end: rel(lastCall),
    agent_exit: rel(wallEnd)
  }

  // Reads and sizes.
  const guide = calls.filter((c) => c.tool === 'get_guide').map((c) => ({ t_s: r2(c.t_s), topic: c.args?.topic ?? '(all)', chars: len(c.result) }))
  const readByTool = {}
  for (const c of calls) {
    const p = (readByTool[c.tool] ??= { calls: 0, chars: 0, images: 0 })
    p.calls++
    p.chars += len(c.result)
    p.images += (c.images ?? []).length
  }

  const fields = {
    transcript_file: file ? basename(file) : null,
    harness: agent.harness,
    partition: file ? parts : { ...parts, note: 'no transcript: model, own tools and startup are not known' },
    milestones,
    model,
    turns,
    own_calls: { total: own.length, failed: own.filter((x) => x.status === 'failed').length, denied: own.filter((x) => x.status === 'denied').length, by_tool: ownByTool, list: own },
    could_not_do: couldNot,
    received: agent.received,
    reads: { by_tool: readByTool, guide_topics: guide },
    app_spans: { calls: spans, scenes: Object.values(scenes) },
    done_from_events: visibleEnds.length ? rel(Math.max(...visibleEnds.map((e) => Date.parse(e.t)))) : null
  }
  return { fields, markdown: timelineMarkdown(metrics, fields, mcp, agent, t0) }
}

// ---------- timeline.md ----------

function timelineMarkdown(metrics, f, mcp, agent, t0) {
  const L = []
  const rel = (ms) => ((ms - t0) / 1000).toFixed(2)
  const cell = (v) => (v === null || v === undefined ? '' : String(v).replace(/\|/g, '/'))
  L.push(`# Timeline: ${basename(metrics.dir ?? '')}`, '')
  L.push(`${metrics.client} ${metrics.model}${metrics.effort ? ` ${metrics.effort}` : ''} · task ${metrics.task} · ${metrics.timestamp} · ok ${metrics.ok}${metrics.error ? ` (${metrics.error})` : ''}`)
  if (f.harness) L.push('', `Harness: ${Object.entries(f.harness).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  L.push('', 'Times are seconds from the agent start. Generated by scripts/perf/timeline.mjs.', '')

  L.push('## Timeline', '', '| # | start | end | dur s | kind | step | detail | result chars | out tok | ctx tok | tok/s | note |', '|---|---|---|---|---|---|---|---|---|---|---|---|')
  const rows = []
  for (const x of f.turns) rows.push({ s: x.start_s, e: x.end_s, kind: 'model', step: `turn ${x.n}`, detail: `calls: ${x.calls.join(', ') || '(text only)'}`, chars: '', out: x.out, ctx: x.ctx, tps: x.tok_s, note: x.text ? `text: ${x.text}` : '' })
  for (const x of mcp) {
    const sp = x.c.spans ? Object.entries(x.c.spans).filter(([k]) => k !== 'news_ms' || x.c.spans.news_ms > 5).map(([k, v]) => `${k} ${v}`).join(', ') : ''
    rows.push({ s: Number(rel(x.start)), e: Number(rel(x.end)), kind: isWait(x.c) ? 'wait' : 'mcp', step: x.c.tool, detail: one(JSON.stringify(x.c.args ?? {}), 100), chars: len(x.c.result), out: '', ctx: '', tps: '', note: [x.c.ok ? '' : `FAILED: ${one(x.c.error, 120)}`, sp ? `app: ${sp}` : ''].filter(Boolean).join(' ') })
  }
  for (const x of f.own_calls.list) rows.push({ s: x.start_s, e: r2(x.start_s + (x.s ?? 0)), kind: 'own', step: x.tool, detail: x.detail, chars: x.chars, out: '', ctx: '', tps: '', note: x.status === 'ok' ? '' : `${x.status.toUpperCase()}: ${one(x.error, 120)}` })
  for (const s of f.app_spans.scenes) {
    if (s.first_frame_s !== null) rows.push({ s: s.first_frame_s, e: s.first_frame_s, kind: 'board', step: 'first frame', detail: s.name ?? s.scene, chars: '', out: '', ctx: '', tps: '', note: '' })
    if (s.end_s !== null) rows.push({ s: s.end_s, e: s.end_s, kind: 'board', step: 'scene end', detail: s.name ?? s.scene, chars: '', out: '', ctx: '', tps: '', note: s.outcome ?? '' })
  }
  rows.sort((a, b) => a.s - b.s || a.e - b.e)
  rows.forEach((x, i) => L.push(`| ${i + 1} | ${Number(x.s).toFixed(2)} | ${Number(x.e).toFixed(2)} | ${(x.e - x.s).toFixed(2)} | ${x.kind} | ${cell(x.step)} | ${cell(x.detail)} | ${cell(x.chars)} | ${cell(x.out)} | ${cell(x.ctx)} | ${cell(x.tps)} | ${cell(x.note)} |`))

  const p = f.partition
  L.push('', '## Where the wall time went (exclusive)', '', 'Each instant goes to one bucket, in this order: waits, MCP tools, own tools, model, startup, tail, unattributed.', '', '| bucket | s |', '|---|---|')
  for (const [k, v] of Object.entries(p)) L.push(`| ${k.replace(/_s$/, '')} | ${cell(v)} |`)

  const m = f.milestones
  L.push('', '## Milestones', '', '| milestone | s |', '|---|---|')
  for (const k of ['first_model_request', 'first_mcp_call', 'first_write_scene', 'first_play', 'first_stroke', 'last_call_end', 'agent_exit']) L.push(`| ${k.replace(/_/g, ' ')} | ${cell(m[k])} |`)
  for (const s of m.scene_ends) L.push(`| scene end: ${cell(s.name)} | ${cell(s.end_s)} ${cell(s.outcome)} |`)
  L.push(`| done (last scene end, from scene events) | ${cell(f.done_from_events)} |`)

  if (f.model) {
    L.push('', '## Model', '', `- Turns ${f.model.turns}; output tokens ${f.model.output_tokens} (reasoning ${f.model.reasoning_tokens}); generation ${f.model.generation_s} s.`)
    L.push(`- Context: first turn ${f.model.first_context}, max ${f.model.max_context} tokens.`, `- Speed: median ${f.model.tok_s_median} tok/s (out tokens / turn duration, time to first token included).`)
  }

  L.push('', '## What the agent tried and could not do', '')
  if (!f.could_not_do.length) L.push('Nothing failed or was denied.')
  else {
    L.push('| t s | what | status | error (first 300 chars) |', '|---|---|---|---|')
    for (const x of f.could_not_do) L.push(`| ${x.t_s} | ${cell(one(x.what, 120))} | ${x.status} | ${cell(one(x.error, 300))} |`)
  }

  L.push('', '## Reads and sizes', '', '| MCP tool | calls | result chars | images |', '|---|---|---|---|')
  for (const [k, v] of Object.entries(f.reads.by_tool)) L.push(`| ${k} | ${v.calls} | ${v.chars} | ${v.images} |`)
  if (f.reads.guide_topics.length) L.push('', `get_guide topics: ${f.reads.guide_topics.map((g) => `\`${g.topic}\` ${g.chars} chars at ${g.t_s} s`).join('; ')}`)
  const r = f.received
  if (r?.shapes) for (const s of r.shapes) L.push('', `Request shape at ${s.t_s} s: system prompt ${s.system_chars} chars, ${s.tools} tools in ${s.tools_chars} chars (MCP: ${s.mcp_tools} tools, ${s.mcp_tools_chars} chars).`)
  if (r && 'base_instructions_chars' in r) L.push('', `Received: base instructions ${r.base_instructions_chars} chars, AGENTS.md ${r.agents_md_chars} chars, tools ${r.tools?.count ?? '?'} in ${r.tools?.chars ?? '?'} chars.`)

  if (f.app_spans.calls.length) {
    L.push('', '## App spans (ms)', '', '| t s | tool | call ms | spans |', '|---|---|---|---|')
    for (const s of f.app_spans.calls) {
      const { t_s, tool, ms, ...rest } = s
      L.push(`| ${t_s} | ${tool} | ${ms} | ${Object.entries(rest).map(([k, v]) => `${k} ${v}`).join(', ')} |`)
    }
  }
  if (f.app_spans.scenes.length) {
    L.push('', '## Scenes on the board', '', '| scene | name | first frame s | end s | outcome | cut / replaced |', '|---|---|---|---|---|---|')
    for (const s of f.app_spans.scenes) L.push(`| ${s.scene} | ${cell(s.name)} | ${cell(s.first_frame_s)} | ${cell(s.end_s)} | ${cell(s.outcome)} | ${s.replaced.map((x) => `${x.how} at ${x.t_s}`).join('; ')} |`)
  }
  return `${L.join('\n')}\n`
}
