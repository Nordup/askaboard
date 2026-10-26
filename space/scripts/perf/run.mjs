#!/usr/bin/env node
/**
 * A perf model run: a real agent does one perf task on a fresh app, and the
 * run's numbers go to metrics.json and one line of .lab/perf/history.jsonl.
 *
 *   node scripts/perf/run.mjs --client claude|codex --model <m> [--effort <e>] --task orbit
 *        [--repeat N] [--label <text>] [--no-video] [--name <instance>] [--dev|--built] [--no-web] [--no-news-hook]
 *        [--mcp-port 47880] [--debug-port 9480] [--timeout-min 15]
 *
 * Each run: a fresh app (instance "perf" under the lab scratch folder: its own
 * HOME, user-data-dir, learning folder and traces) on its own ports, the agent
 * headless from inside the learning folder (so AGENTS.md carries the brief and
 * the prompt is the task alone), the board news hook as in council.mjs. When the
 * agent is done and the last scene has played, the app stops (exact PIDs).
 * --dev (the default) runs electron-vite dev on the current source; --built runs out/.
 *
 * Run folder: space/.lab/perf/runs/<stamp>-<task>-<client>-<model>[-<effort>]/ with
 * prompt.md, the agent's output, reply.md, calls.json, trace/ (the app trace),
 * metrics.json and (unless --no-video) video-real.mp4, video.mp4 and frames.json.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  SCRATCH,
  args,
  canvasRect,
  cdpConnect,
  claudeTranscript,
  claudeTurn,
  codexRollout,
  codexTurn,
  cropFilter,
  log,
  prepareCodexHome,
  runFolder,
  scenePlaySpans,
  sceneHook,
  sleep,
  startInstance,
  startRecording,
  stopInstance,
  traceCalls,
  traceLabels,
  traceSessionOpen
} from '../lab/common.mjs'
import { makeMedia } from '../lab/media.mjs'
import { task as getTask } from './tasks.mjs'
import { PERF_RUNS, appendHistory, callMetrics, codeIdentity, frameChanges, round, unionMs } from './metrics.mjs'

const { option, flag } = args()
const say = (...p) => log('perf', ...p)

const opts = {
  client: option('--client', null),
  model: option('--model', null),
  effort: option('--effort', null),
  task: option('--task', 'orbit'),
  repeat: Number(option('--repeat', '1')),
  label: option('--label', null),
  video: !flag('--no-video'),
  name: option('--name', 'perf'),
  built: flag('--built'),
  mcpPort: Number(option('--mcp-port', '47880')),
  debugPort: Number(option('--debug-port', '9480')),
  timeoutMs: Number(option('--timeout-min', '15')) * 60_000,
  newsHook: !flag('--no-news-hook'),
  web: !flag('--no-web'),
  codexHome: option('--codex-home', join(SCRATCH, 'codex-home-perf'))
}
if (!['claude', 'codex'].includes(opts.client)) throw new Error('--client is claude or codex')
if (!opts.model) throw new Error('--model is required (Claude: opus, haiku; Codex: gpt-6.1-sol, gpt-6-luna)')
if (opts.built && flag('--dev')) throw new Error('--dev and --built exclude each other')
if (opts.client === 'codex' && !opts.effort) opts.effort = 'medium'
for (const port of [opts.mcpPort, opts.debugPort]) if ([47821, 47891, 47870, 9491, 9470].includes(port)) throw new Error(`Port ${port} belongs to another app (founder, council or bench).`)
if (!(opts.repeat >= 1)) throw new Error('--repeat N needs N ≥ 1')

// The lab instance (its folder and state under the lab scratch folder): one name per parallel run.
const NAME = opts.name

/** Codex: the turn's span in the rollout (task_started → task_complete), wall ms, or null. */
function codexSpan(rollout) {
  if (!rollout || !existsSync(rollout)) return null
  let start = null
  let end = null
  for (const line of readFileSync(rollout, 'utf8').split('\n')) {
    if (!line.includes('"task_started"') && !line.includes('"task_complete"')) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const t = Date.parse(e.timestamp)
    if (e.payload?.type === 'task_started' && start === null) start = t
    if (e.payload?.type === 'task_complete') end = t
  }
  return start !== null && end !== null ? { start, end } : null
}

async function oneRun(task, index) {
  const identity = codeIdentity()
  const dir = runFolder(`${task.id}-${opts.client}-${opts.model}${opts.effort ? `-${opts.effort}` : ''}`, PERF_RUNS)
  const framesDir = join(SCRATCH, 'frames', `perf-${basename(dir)}`)
  say(`run ${index + 1}/${opts.repeat}: ${dir}`)
  const prompt = task.text
  writeFileSync(join(dir, 'prompt.md'), `${prompt}\n`)
  // A perf run measures the product: no lab switches.
  for (const v of ['LS_LAB_NO_CODE', 'LS_LAB_NO_HTML', 'LS_LAB_BRIEF']) delete process.env[v]

  const pids = []
  const agent = { client: opts.client, model: opts.model, effort: opts.effort, newsHook: opts.newsHook, web: opts.web, codexHome: opts.codexHome, timeoutMs: opts.timeoutMs, pids, say }
  const state = await startInstance({ name: NAME, mcpPort: opts.mcpPort, debugPort: opts.debugPort, built: opts.built, fresh: true })
  say(`app ${state.mode} on MCP ${state.mcpPort}, debug ${state.debugPort}, PIDs ${state.pids.join(', ')}`)
  let cdp = null
  let stopped = false
  try {
    if (opts.client === 'codex') prepareCodexHome(agent, state)
    cdp = await cdpConnect(state.debugPort)
    const recording = opts.video ? await startRecording(cdp, framesDir) : null
    if (recording) await sleep(300)

    const t0 = Date.now()
    const work = opts.client === 'claude' ? await claudeTurn(agent, state, dir, prompt, 'work') : await codexTurn(agent, state, dir, prompt, 'work')
    const t1 = Date.now()
    say(`agent done in ${((t1 - t0) / 1000).toFixed(1)} s, exit ${work.exit_code}${work.is_error ? ' (error)' : ''}`)

    // Wait until the last scene has played: the trace's play spans, then the scene hook.
    await sleep(1000)
    let calls = traceCalls(state.traces, t0)
    const playEnd = Math.max(0, ...scenePlaySpans(calls).map((s) => s.to - 1000))
    while (Date.now() < playEnd) await sleep(100)
    for (let i = 0; i < 600; i++) {
      const h = await sceneHook(cdp)
      if (!h?.playing || h.paused) break
      await sleep(100)
    }
    const tIdle = Date.now()
    let frames = []
    let changes = null
    let rect = null
    if (recording) {
      await sleep(1000)
      frames = await recording.stop()
      rect = await canvasRect(cdp)
    }
    const tEnd = Date.now()
    cdp.close()
    cdp = null
    say(`app stopped (PIDs ${(await stopInstance(NAME)).join(', ')})`)
    stopped = true
    calls = traceCalls(state.traces, t0)

    // Files.
    cpSync(state.traces, join(dir, 'trace'), { recursive: true })
    const rel = (iso) => round((Date.parse(iso) - t0) / 1000, 3)
    writeFileSync(
      join(dir, 'calls.json'),
      JSON.stringify(calls.map((c) => ({ t_s: rel(c.t), end_s: rel(c.end ?? c.t), gap_ms: c.gap_ms ?? null, tool: c.tool, ms: c.duration_ms, ok: c.ok, error: c.error ?? null, args: c.args, result: c.result_text, images: c.images ?? null })), null, 2)
    )
    writeFileSync(join(dir, 'reply.md'), `${work.reply ?? ''}\n`)

    const m = callMetrics(calls, { t0, wallEnd: t1, tracesDir: join(dir, 'trace') })
    // First visible change after the first scene program (write_scene; run_scene in older runs), from the screencast.
    let firstVisible = null
    let lastVisible = null
    if (frames.length) {
      changes = frameChanges(frames, rect, t0, framesDir)
      writeFileSync(join(dir, 'frames.json'), JSON.stringify(changes, null, 2))
      const from = m.time.first_scene !== null ? m.time.first_scene * 1000 : null
      const after = from === null ? [] : changes.changes.filter((t) => t >= from)
      firstVisible = after.length ? round(after[0] / 1000, 2) : null
      lastVisible = changes.last_change_ms !== null ? round(changes.last_change_ms / 1000, 2) : null
    }
    // Model time from the client.
    const raw = work.raw ?? null
    let model = null
    if (opts.client === 'claude' && raw) {
      model = { source: 'claude json', duration_s: round((raw.duration_ms ?? NaN) / 1000, 2), api_s: round((raw.duration_api_ms ?? NaN) / 1000, 2) }
    } else if (opts.client === 'codex') {
      const span = codexSpan(codexRollout(opts.codexHome, work.session))
      if (span) {
        const inside = unionMs(calls.map((c) => [Math.max(span.start, Date.parse(c.t)), Math.min(span.end, Date.parse(c.end ?? c.t))]))
        model = { source: 'codex rollout (task_started→task_complete minus tool time)', duration_s: round((span.end - span.start) / 1000, 2), api_s: round((span.end - span.start - inside) / 1000, 2) }
      }
    }
    const metrics = {
      kind: 'model',
      task: task.id,
      client: opts.client,
      model: opts.model,
      effort: opts.effort,
      label: opts.label,
      timestamp: new Date(t0).toISOString(),
      mode: state.mode,
      code: identity,
      dir,
      ok: work.exit_code === 0 && !work.is_error,
      error: work.is_error ? (work.errors?.join(' | ') || `exit ${work.exit_code}`) : null,
      session: work.session,
      transcript: opts.client === 'claude' ? claudeTranscript(work.session) : codexRollout(opts.codexHome, work.session),
      time: { ...m.time, first_visible: firstVisible, last_visible: lastVisible, idle_after_agent: round((tIdle - t1) / 1000, 2), model_s: model?.api_s ?? null, model_source: model?.source ?? null, client_duration_s: model?.duration_s ?? null },
      calls: m.calls,
      written: m.written,
      read: m.read,
      app: m.app,
      usage:
        opts.client === 'claude'
          ? { cost_usd: raw?.total_cost_usd ?? null, num_turns: raw?.num_turns ?? null, tokens: raw?.usage ? { input: raw.usage.input_tokens ?? 0, cache_read: raw.usage.cache_read_input_tokens ?? 0, cache_write: raw.usage.cache_creation_input_tokens ?? 0, output: raw.usage.output_tokens ?? 0 } : null }
          : { cost_usd: null, num_turns: null, tokens: work.tokens ?? null },
      per_tool: m.per_tool,
      video: frames.length > 0,
      agent_pids: pids,
      recorded_s: round((tEnd - t0) / 1000, 1)
    }
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2))
    appendHistory(metrics)
    const t = metrics.time
    say(`wall ${t.wall} s, first scene ${t.first_scene ?? '-'} s, first visible ${t.first_visible ?? '-'} s, done ${t.done ?? '-'} s; ${m.calls.total} calls, ${m.calls.scene_previews} previews, ${m.calls.scene_plays} plays; written ${m.written.total}, read ${m.read.result_chars}`)

    // The videos, after the app has stopped and before the next run starts.
    if (frames.length) {
      const crop = cropFilter(frames[0].file, rect, frames[0].w)
      const labels = traceLabels(calls, { from: t0, opened: traceSessionOpen(state.traces, t0), turnEnd: t1 })
      makeMedia({ dir, framesDir, frames, from: t0, to: tEnd, crop, labels, playing: scenePlaySpans(calls) })
    }
    return metrics
  } finally {
    if (cdp) cdp.close()
    if (!stopped) say(`app stopped (PIDs ${(await stopInstance(NAME)).join(', ')})`)
    // makeMedia deletes the frames; after a failure they are deleted here.
    rmSync(framesDir, { recursive: true, force: true })
  }
}

async function main() {
  const task = getTask(opts.task)
  for (let i = 0; i < opts.repeat; i++) await oneRun(task, i)
  say('done; compare with: node scripts/perf/report.mjs')
}

main().catch((error) => {
  console.error(`perf: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
