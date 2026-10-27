#!/usr/bin/env node
/**
 * A model-free perf run: re-issue a recorded run's tool calls, in order and
 * with the same args, against a fresh app, and measure the app side. For
 * behind-the-scenes changes (preview speed, sandbox, result sizes) without
 * paying for a model.
 *
 *   node scripts/perf/replay.mjs --from <run folder> [--repeat N] [--gaps none|original] [--no-video] [--name <instance>]
 *        [--label <text>] [--dev|--built] [--mcp-port 47881] [--debug-port 9481] [--learner-ink N]
 *
 * --profile records a CPU profile of the app window (renderer.cpuprofile in
 * the run folder) and prints the functions with the most self time.
 * --learner-ink N draws N pen strokes on the board before the first call
 * (scripts/drive.mjs), so that the scenes play over a board with much
 * learner ink.
 * During scene playback, the page records each frame's interval and main
 * thread work (metrics.mjs FRAME_METER); metrics.json → frames has their
 * median, 95th percentile and worst values, and the frames over 50 ms.
 * Every image a call returns (for example a preview's storyboard) is in
 * trace/ (the app's trace); calls.json names it per call (image_files).
 * The board is recorded as video-real.mp4 and video.mp4 unless --no-video;
 * the screencast costs some CPU, so compare runs with the same setting.
 * --gaps none (default) sends each call when the one before has returned;
 * original also waits the recorded gap before each call (the model's time).
 * Scene and item ids differ in a fresh app: ids from the recorded results are
 * mapped to the new ones in later args.
 * Recordings from before 2026-10-26 use run_scene and scene_control; their
 * calls are sent as the new scene tools (translate below): run_scene →
 * write_scene, then preview_scene (at "steps") for a preview or play_scene
 * start for a play, each scene under a unique name ("<name> #<n>");
 * scene_control → play_scene (skip → clear_queue; replace → write_scene and
 * start under the replaced scene's name). calls.json lists the sent calls per
 * recorded call (sent). Recordings from before 2026-10-27 use the old read
 * tools; they are sent as the new ones: get_canvas_info → get_board {},
 * get_tree → get_board {part: {id} or "board", depth}, get_node_info →
 * get_item, get_html → get_item {as: "html"}, and get_screenshot's node_id,
 * region and target → part (target "changes" → the interval of the latest
 * get_changes result, else "view").
 * --save-results <dir> writes the full text of every result to
 * <dir>/<i>-<tool>.txt (the trace cuts long results). Nothing is skipped silently: a call
 * whose args the trace cut, a tool the app does not have, a call that fails now
 * or whose ok differs from the recording are listed in metrics.json → replay.
 *
 * Run folder: space/.lab/perf/runs/<stamp>-replay-<source>/ with calls.json
 * (per call: app ms, round-trip ms, result chars, ok), trace/ and metrics.json;
 * one line per repeat in .lab/perf/history.jsonl (kind "replay").
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { SCRATCH, args, canvasRect, cdpConnect, cropFilter, drive, log, resultText, runFolder, scenePlaySpans, sceneHook, sleep, startInstance, startRecording, stopInstance, traceCalls, traceLabels, withMcp } from '../lab/common.mjs'
import { makeMedia } from '../lab/media.mjs'
import { FRAME_METER, PERF_RUNS, appendHistory, argsCut, callMetrics, codeIdentity, collectFrames, frameChanges, frameStats, round } from './metrics.mjs'

const { option, flag } = args()
const say = (...p) => log('replay', ...p)

const opts = {
  from: option('--from', null),
  repeat: Number(option('--repeat', '1')),
  gaps: option('--gaps', 'none'),
  video: !flag('--no-video'),
  name: option('--name', 'perf-replay'),
  label: option('--label', null),
  built: flag('--built'),
  mcpPort: Number(option('--mcp-port', '47881')),
  debugPort: Number(option('--debug-port', '9481')),
  learnerInk: Number(option('--learner-ink', '0')),
  saveResults: option('--save-results', null),
  profile: flag('--profile')
}
if (!opts.from) throw new Error('--from <run folder> is required')
const source = resolve(opts.from)
if (!existsSync(join(source, 'calls.json'))) throw new Error(`No calls.json in ${source}`)
if (!['none', 'original'].includes(opts.gaps)) throw new Error('--gaps is none or original')
if (opts.built && flag('--dev')) throw new Error('--dev and --built exclude each other')
for (const port of [opts.mcpPort, opts.debugPort]) if ([47821, 47891, 47870, 9491, 9470].includes(port)) throw new Error(`Port ${port} belongs to another app (founder, council or bench).`)

// The lab instance (its folder and state under the lab scratch folder): one name per parallel replay.
const NAME = opts.name
const recorded = JSON.parse(readFileSync(join(source, 'calls.json'), 'utf8'))
const sourceMetrics = existsSync(join(source, 'metrics.json')) ? JSON.parse(readFileSync(join(source, 'metrics.json'), 'utf8')) : {}

const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The calls to send for one recorded call: itself, or for the scene tools
 * before 2026-10-26 (run_scene, scene_control) the new scene tools. ids: the
 * id map (an old scene id maps to its new scene name once its result is in).
 */
function translate(rc, counter) {
  const a = rc.args ?? {}
  // The read tools before 2026-10-27.
  if (rc.tool === 'get_canvas_info') return [{ tool: 'get_board', args: {} }]
  if (rc.tool === 'get_tree') return [{ tool: 'get_board', args: { part: a.node_id ? { id: a.node_id } : 'board', ...(a.depth ? { depth: a.depth } : {}) } }]
  if (rc.tool === 'get_node_info') return [{ tool: 'get_item', args: { id: a.node_id } }]
  if (rc.tool === 'get_html') return [{ tool: 'get_item', args: { id: a.node_id, as: 'html', ...(a.include_ids !== undefined ? { include_ids: a.include_ids } : {}) } }]
  if (rc.tool === 'get_screenshot' && (a.node_id || a.region || a.target)) {
    const { node_id, region, target, ...rest } = a
    const part = node_id ? { id: node_id } : region && (!target || target === 'region') ? { region } : target === 'content' ? 'board' : target === 'selection' ? 'selection' : target === 'changes' ? (counter.handle ? { changes: counter.handle } : 'view') : 'view'
    return [{ tool: 'get_screenshot', args: { ...rest, part } }]
  }
  if (rc.tool === 'run_scene') {
    const name = `${a.name ?? 'scene'} #${++counter.n}`
    const write = { tool: 'write_scene', args: { name, code: a.code } }
    if (a.preview) return [write, { tool: 'preview_scene', args: { name, at: 'steps' } }]
    return [write, { tool: 'play_scene', args: { action: 'start', name, ...(a.when ? { when: a.when } : {}), ...(a.wait ? { wait: a.wait } : {}) } }]
  }
  if (rc.tool === 'scene_control') {
    const action = a.action === 'skip' ? 'clear_queue' : a.action
    if (action === 'replace') return [{ tool: 'write_scene', args: { name: a.scene, code: a.code } }, { tool: 'play_scene', args: { action: 'start', name: a.scene } }]
    if (action === 'replay') return [{ tool: 'play_scene', args: { action, ...(a.scene ? { name: a.scene } : {}), ...(a.step ? { from_step: a.step } : {}), ...(a.when ? { when: a.when } : {}) } }]
    if (action === 'cut') return [{ tool: 'play_scene', args: { action, ...(a.after_step ? { after_step: a.after_step } : {}) } }]
    return [{ tool: 'play_scene', args: { action } }]
  }
  return [{ tool: rc.tool, args: a }]
}

/** Old id → new id (an old scene id → the new scene name), from a recorded and a replayed scene result. */
function mapIds(map, oldText, newText) {
  const a = parse(oldText)
  const b = parse(newText)
  if (!a || !b) return
  const pair = (x, y) => {
    if (typeof x === 'string' && typeof y === 'string' && x !== y && x.length >= 3) map.set(x, y)
  }
  pair(a.scene, b.scene)
  // play_scene start's items: a list of every item before 2026-10-27, {total, by_kind, named: [{name, id}]} since; the named items pair by name, in order.
  const named = (items) => (Array.isArray(items) ? items.filter((item) => item?.name) : Array.isArray(items?.named) ? items.named : [])
  if (Array.isArray(a.items) && Array.isArray(b.items)) {
    for (let i = 0; i < Math.min(a.items.length, b.items.length); i++) pair(a.items[i]?.id, b.items[i]?.id)
    return
  }
  const left = named(a.items)
  const right = [...named(b.items)]
  for (const item of left) {
    const at = right.findIndex((other) => other.name === item.name && (other.kind === item.kind || !other.kind || !item.kind))
    if (at < 0) continue
    pair(item.id, right[at].id)
    right.splice(at, 1)
  }
}

/** args with every mapped id replaced (whole strings, and inside code). */
function substitute(value, map, depth = 0) {
  if (!map.size) return value
  if (typeof value === 'string') {
    if (map.has(value)) return map.get(value)
    let out = value
    for (const [from, to] of map) if (from.length >= 6 && out.includes(from)) out = out.split(from).join(to)
    return out
  }
  if (value === null || typeof value !== 'object' || depth > 24) return value
  if (Array.isArray(value)) return value.map((v) => substitute(v, map, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, map, depth + 1)]))
}

/** The functions with the most self time in a CPU profile (Profiler.stop), as text lines. */
function topFunctions(profile, count) {
  const dt = new Map()
  const { samples = [], timeDeltas = [] } = profile
  for (let i = 0; i < samples.length; i++) dt.set(samples[i], (dt.get(samples[i]) ?? 0) + (timeDeltas[i] ?? 0))
  const self = new Map()
  for (const node of profile.nodes) {
    const f = node.callFrame
    const key = `${f.functionName || '(anonymous)'} ${basename(f.url || '')}:${f.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (dt.get(node.id) ?? 0))
  }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, count).map(([key, us]) => `${round(us / 1000, 1)} ms ${key}`)
}

/**
 * Draw `count` wavy pen strokes in a grid around the board's centre (scripts/drive.mjs
 * draw --fast: each stroke is one burst of pen events). Ink groups link strokes drawn
 * within 4 s more easily (LINK_TIME_MS in agent/groups.ts), and the rows are closer than
 * that link gap. So the even rows are drawn first, then the odd rows after a pause of
 * more than 4 s: each row stays its own ink group, as at pen speed.
 */
async function drawLearnerInk(debugPort, count, dir) {
  const columns = Math.ceil(Math.sqrt(count * 1.6))
  const passes = [[], []]
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns)
    const x0 = -560 + (i % columns) * (1120 / columns)
    const y0 = -360 + row * (720 / Math.ceil(count / columns))
    const points = []
    for (let k = 0; k <= 24; k++) points.push([round(x0 + k * 2.2, 1), round(y0 + 9 * Math.sin(k / 3 + i), 1), round(0.4 + 0.3 * Math.sin(k / 5), 2)])
    passes[row % 2].push(points)
  }
  const file = join(dir, 'learner-ink.json')
  const started = Date.now()
  for (const [index, strokes] of passes.entries()) {
    if (index > 0 && strokes.length) await sleep(4500)
    for (let i = 0; i < strokes.length; i += 40) {
      writeFileSync(file, JSON.stringify(strokes.slice(i, i + 40)))
      drive(debugPort, 'draw', file, '--fast')
    }
  }
  say(`drew ${count} learner strokes in ${round((Date.now() - started) / 1000, 1)} s`)
}

async function oneReplay(index) {
  const identity = codeIdentity()
  const dir = runFolder(`replay-${basename(source).replace(/^\d{8}-\d{6}-/, '')}`, PERF_RUNS)
  const framesDir = join(SCRATCH, 'frames', `perf-${basename(dir)}`)
  say(`replay ${index + 1}/${opts.repeat} of ${recorded.length} calls from ${source}: ${dir}`)
  for (const v of ['LS_LAB_NO_CODE', 'LS_LAB_NO_HTML', 'LS_LAB_BRIEF']) delete process.env[v]
  const state = await startInstance({ name: NAME, mcpPort: opts.mcpPort, debugPort: opts.debugPort, built: opts.built, fresh: true })
  say(`app ${state.mode} on MCP ${state.mcpPort}, PIDs ${state.pids.join(', ')}`)
  let cdp = null
  let stopped = false
  try {
    cdp = await cdpConnect(state.debugPort)
    if (opts.learnerInk > 0) await drawLearnerInk(state.debugPort, opts.learnerInk, dir)
    await cdp.evaluate(FRAME_METER)
    if (opts.profile) {
      await cdp.send('Profiler.enable', {})
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start', {})
    }
    const recording = opts.video ? await startRecording(cdp, framesDir) : null
    if (recording) await sleep(300)
    const results = []
    const problems = []
    const ids = new Map()
    let t0 = null
    let tLast = null
    await withMcp(state.mcpPort, async (call, client) => {
      const tools = new Set((await client.listTools()).tools.map((t) => t.name))
      t0 = Date.now()
      const counter = { n: 0 }
      for (let i = 0; i < recorded.length; i++) {
        const rc = recorded[i]
        const entry = { i, tool: rc.tool, recorded_ms: rc.ms, recorded_ok: rc.ok }
        const seq = translate(rc, counter)
        const missing = seq.filter((c) => !tools.has(c.tool)).map((c) => c.tool)
        if (missing.length) {
          problems.push({ i, tool: rc.tool, problem: `not replayed: the app has no tool ${missing.join(', ')}` })
          results.push({ ...entry, replayed: false })
          continue
        }
        if (argsCut(rc.args)) problems.push({ i, tool: rc.tool, problem: 'args were cut in the trace (200 KB); replayed with the cut text' })
        if (opts.gaps === 'original' && i > 0) {
          const gap = rc.gap_ms ?? Math.max(0, (rc.t_s - (recorded[i - 1].end_s ?? recorded[i - 1].t_s)) * 1000)
          if (gap > 0) await sleep(gap)
        }
        const tc = Date.now()
        let result = null
        let thrown = null
        let sentN = 0
        for (const c of seq) {
          sentN++
          try {
            result = await call(c.tool, substitute(c.args, ids))
          } catch (error) {
            thrown = error instanceof Error ? error.message : String(error)
          }
          if (thrown || result?.isError) break
        }
        const tr = Date.now()
        tLast = tr
        const text = result ? resultText(result) : ''
        const ok = !thrown && !result?.isError
        if (ok && seq.at(-1)?.tool === 'get_changes') {
          counter.handle = /\bc\d+-c\d+\b/.exec(text)?.[0] ?? counter.handle
          // A probe call can name the latest interval as "$LAST_HANDLE".
          if (counter.handle) ids.set('$LAST_HANDLE', counter.handle)
        }
        if (opts.saveResults) {
          mkdirSync(opts.saveResults, { recursive: true })
          writeFileSync(join(opts.saveResults, `${String(i).padStart(2, '0')}-${seq.at(-1)?.tool ?? rc.tool}.txt`), thrown ?? text)
        }
        if (ok && ['run_scene', 'scene_control', 'play_scene'].includes(rc.tool)) mapIds(ids, rc.result, text)
        if (!ok) problems.push({ i, tool: rc.tool, problem: `failed now${rc.ok ? ' (ok when recorded)' : ' (failed when recorded too)'}: ${(thrown ?? text).slice(0, 300)}` })
        else if (!rc.ok) problems.push({ i, tool: rc.tool, problem: 'ok now, failed when recorded' })
        results.push({ ...entry, replayed: true, sent: seq.slice(0, sentN).map((c) => c.tool), rtt_ms: tr - tc, ok, result_chars: text.length, images: (result?.content ?? []).filter((p) => p.type === 'image').length })
        say(`${i + 1}/${recorded.length} ${rc.tool}${rc.args?.preview ? ' (preview)' : ''}${seq.length > 1 || seq[0].tool !== rc.tool ? ` as ${seq.map((c) => c.tool).join(' + ')}` : ''}: ${ok ? 'ok' : 'ERROR'} ${tr - tc} ms (recorded ${rc.ms} ms)`)
      }
    })
    // Until the last scene has played (a paused scene has no learner to resume it: it counts as played).
    for (let i = 0; i < 1200; i++) {
      const h = await sceneHook(cdp)
      if (!h?.playing || h.paused) break
      await sleep(100)
    }
    const tIdle = Date.now()
    const frameTimes = await collectFrames(cdp)
    if (opts.profile) {
      const { profile } = await cdp.send('Profiler.stop', {})
      writeFileSync(join(dir, 'renderer.cpuprofile'), JSON.stringify(profile))
      for (const line of topFunctions(profile, 25)) say(`  profile: ${line}`)
    }
    writeFileSync(join(dir, 'frame-times.json'), JSON.stringify(frameTimes))
    let frames = []
    let rect = null
    if (recording) {
      await sleep(1000)
      frames = await recording.stop()
      rect = await canvasRect(cdp)
    }
    const tEnd = Date.now()
    cdp.close()
    cdp = null
    await sleep(500) // the trace has the last calls
    say(`app stopped (PIDs ${(await stopInstance(NAME)).join(', ')})`)
    stopped = true

    // App-side numbers from the app's own trace of the replay client.
    const calls = traceCalls(state.traces, t0, { skipClient: null })
    const sentCount = results.reduce((n, r) => n + (r.replayed ? r.sent.length : 0), 0)
    if (calls.length !== sentCount) problems.push({ problem: `the trace has ${calls.length} calls, ${sentCount} were sent` })
    cpSync(state.traces, join(dir, 'trace'), { recursive: true })
    let k = 0
    const traceFiles = new Map(readdirSync(join(dir, 'trace'), { recursive: true }).map((f) => [basename(String(f)), join('trace', String(f))]))
    // A recorded call sent as several calls (a translated scene call): their app ms add up.
    for (const r of results) if (r.replayed) {
      const part = calls.slice(k, k + r.sent.length)
      k += part.length
      r.app_ms = part.length ? part.reduce((n, c) => n + (c?.duration_ms ?? 0), 0) : null
      const images = part.flatMap((c) => c?.images ?? [])
      if (images.length) r.image_files = images.map((img) => traceFiles.get(img.file) ?? img.file)
    }
    writeFileSync(join(dir, 'calls.json'), JSON.stringify(results, null, 2))

    const m = callMetrics(calls, { t0, wallEnd: tLast ?? t0, tracesDir: join(dir, 'trace') })
    // First visible change after the first scene program, from the screencast (app time only: no model).
    let firstVisible = null
    if (frames.length) {
      const changes = frameChanges(frames, rect, t0, framesDir)
      writeFileSync(join(dir, 'frames.json'), JSON.stringify(changes, null, 2))
      const from = m.time.first_scene !== null ? m.time.first_scene * 1000 : null
      const after = from === null ? [] : changes.changes.filter((t) => t >= from)
      firstVisible = after.length ? round(after[0] / 1000, 2) : null
    }
    const perToolMs = {}
    for (const r of results) if (r.replayed) {
      const p = (perToolMs[r.tool] ??= { calls: 0, app_ms: 0, recorded_ms: 0 })
      p.calls++
      p.app_ms += r.app_ms ?? 0
      p.recorded_ms += r.recorded_ms ?? 0
    }
    const metrics = {
      kind: 'replay',
      task: sourceMetrics.task ?? null,
      client: sourceMetrics.client ?? null,
      model: sourceMetrics.model ?? null,
      effort: sourceMetrics.effort ?? null,
      label: opts.label,
      timestamp: new Date(t0).toISOString(),
      mode: state.mode,
      code: identity,
      dir,
      source,
      gaps: opts.gaps,
      video: frames.length > 0,
      learner_ink: opts.learnerInk,
      ok: problems.length === 0,
      time: { ...m.time, first_visible: firstVisible, idle_after_calls: round((tIdle - (tLast ?? t0)) / 1000, 2), total_with_playback: round((tIdle - t0) / 1000, 2) },
      calls: m.calls,
      written: m.written,
      read: m.read,
      app: m.app,
      frames: frameStats(frameTimes),
      usage: { cost_usd: null, num_turns: null, tokens: null },
      per_tool: m.per_tool,
      replay: { recorded: recorded.length, replayed: results.filter((r) => r.replayed).length, app_ms_total: results.reduce((n, r) => n + (r.app_ms ?? 0), 0), recorded_ms_total: recorded.reduce((n, r) => n + (r.ms ?? 0), 0), per_tool_ms: perToolMs, problems }
    }
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2))
    appendHistory(metrics)
    const f = metrics.frames
    say(`playback frames ${f.count}: interval median ${f.interval_ms.median} p95 ${f.interval_ms.p95} max ${f.interval_ms.max} ms; work median ${f.work_ms.median} p95 ${f.work_ms.p95} max ${f.work_ms.max} ms; ${f.long_50ms} over 50 ms`)
    say(`app ms ${metrics.replay.app_ms_total} (recorded ${metrics.replay.recorded_ms_total}); calls done ${m.time.wall} s, played out ${metrics.time.total_with_playback} s; ${problems.length} problems`)
    for (const p of problems) say(`  problem: ${JSON.stringify(p)}`)
    if (frames.length) makeMedia({ dir, framesDir, frames, from: t0, to: tEnd, crop: cropFilter(frames[0].file, rect, frames[0].w), labels: traceLabels(calls, { from: t0 }), playing: scenePlaySpans(calls) })
    return metrics
  } finally {
    if (cdp) cdp.close()
    if (!stopped) say(`app stopped (PIDs ${(await stopInstance(NAME)).join(', ')})`)
    // makeMedia deletes the frames; after a failure they are deleted here.
    rmSync(framesDir, { recursive: true, force: true })
  }
}

async function main() {
  for (let i = 0; i < opts.repeat; i++) await oneReplay(i)
  say('done; compare with: node scripts/perf/report.mjs --kind replay')
}

main().catch((error) => {
  console.error(`replay: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
