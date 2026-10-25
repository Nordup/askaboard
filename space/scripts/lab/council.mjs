#!/usr/bin/env node
/**
 * The model council: a real agent works on a task on a fresh lab app while the
 * board is recorded, then the same session is interviewed about the tool.
 *
 *   node scripts/lab/council.mjs --client codex|claude --task <id|text>
 *        [--model M] [--effort E] [--title T] [--timeout-min 20]
 *        [--name council] [--mcp-port 47891] [--debug-port 9491] [--built]
 *        [--codex-home /private/tmp/claude-501/ls-lab/codex-home] [--no-news-hook] [--keep-app]
 *
 * Tasks: council/tasks.json (id → text; "learner": "S3" draws the bench's S3
 * strokes before the session), or any text. The prompt is council/purpose.md
 * plus the task. Defaults: Claude opus; Codex gpt-6.1-sol at effort medium.
 *
 * Phase 1 (work): `claude -p` (MCP config for the lab only, Learning Space tools
 * allowed) or `codex exec --json` (scratch CODEX_HOME, Learning Space tools
 * approved), run from inside the lab's learning folder, so AGENTS.md loads. The
 * window is recorded with the screencast for the whole phase, until the last
 * scene has played.
 * Phase 2 (interview): the SAME session resumed (`claude -p --resume <id>`,
 * `codex exec resume <thread>`) with council/interview.md; the answer is feedback.md.
 *
 * The run folder (space/.lab/runs/) gets video.mp4 (the watch video: stretches
 * with no visible change longer than 1.5 s play in 0.6 s, labelled with the real
 * wait and what happened, from the trace; a real-time clock in the corner),
 * video-real.mp4 (real time), filmstrip.png (a frame
 * after each board write), final.png, board.png (the whole board), program.js
 * (every run_scene program, or the write calls), calls.json, feedback.md,
 * the agent's output files and meta.json. The app instance starts fresh and
 * is stopped at the end (exact PIDs), unless --keep-app.
 */
import { spawn, execFileSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  LAB,
  SCRATCH,
  WRITE_TOOLS,
  args,
  canvasRect,
  cdpConnect,
  cropFilter,
  cropImage,
  drive,
  encodeVideo,
  encodeWatchVideo,
  scenePlaySpans,
  filmstrip,
  frameAt,
  log,
  resultText,
  runFolder,
  sceneHook,
  sleep,
  startInstance,
  startRecording,
  stopInstance,
  traceCalls,
  traceLabels,
  traceSessionOpen,
  withMcp
} from './common.mjs'
import { writeGallery } from './gallery.mjs'

const { option, flag } = args()
const say = (...p) => log('council', ...p)

const opts = {
  client: option('--client', 'codex'),
  model: option('--model', null),
  effort: option('--effort', null),
  task: option('--task', null),
  title: option('--title', null),
  name: option('--name', 'council'),
  mcpPort: Number(option('--mcp-port', '47891')),
  debugPort: Number(option('--debug-port', '9491')),
  built: flag('--built'),
  timeoutMs: Number(option('--timeout-min', '20')) * 60_000,
  codexHome: option('--codex-home', join(SCRATCH, 'codex-home')),
  newsHook: !flag('--no-news-hook'),
  keepApp: flag('--keep-app')
}
if (!['claude', 'codex'].includes(opts.client)) throw new Error('--client is claude or codex')
if (!opts.task) throw new Error('--task <id|text> is required')
if (opts.client === 'claude' && !opts.model) opts.model = 'opus'
if (opts.client === 'codex' && !opts.model) opts.model = 'gpt-6.1-sol'
if (opts.client === 'codex' && !opts.effort) opts.effort = 'medium'

const pids = []
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '').trim()

// ---------- The learner's S3 drawing (copied from scripts/bench/scenarios.mjs) ----------

const P = 0.55
function circle(cx, cy, r, steps = 40) {
  const points = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2
    points.push([Math.round((cx + r * Math.cos(a)) * 10) / 10, Math.round((cy + r * Math.sin(a)) * 10) / 10, P])
  }
  return points
}
function line(x1, y1, x2, y2, steps = 12) {
  const points = []
  for (let i = 0; i <= steps; i++) points.push([x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, P])
  return points
}
function questionMark(x, y) {
  const hook = []
  for (let i = 0; i <= 14; i++) {
    const a = Math.PI + (i / 14) * Math.PI * 1.4
    hook.push([x + 14 + 14 * Math.cos(a), y + 14 + 14 * Math.sin(a), P])
  }
  hook.push([x + 14, y + 34, P], [x + 14, y + 40, P])
  return [hook, line(x + 14, y + 50, x + 14.5, y + 52, 2)]
}
const LEARNER = {
  /** S3: two atoms side by side, an arrow from one to the other and a question mark. */
  S3: () => [circle(300, -200, 45), circle(520, -200, 45), line(360, -200, 460, -200), [[444, -212, P], [460, -200, P], [444, -188, P]], ...questionMark(396, -290)]
}

// ---------- Agents ----------

function runProcess(command, argv, { cwd, env, stdoutFile, stderrFile }) {
  return new Promise((done) => {
    const out = openSync(stdoutFile, 'w')
    const err = openSync(stderrFile, 'w')
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', out, err] })
    pids.push(child.pid)
    const timer = setTimeout(() => {
      say(`agent timed out after ${opts.timeoutMs / 60000} min; stopping PID ${child.pid}`)
      child.kill('SIGTERM')
    }, opts.timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      closeSync(out)
      closeSync(err)
      done(code)
    })
  })
}

function newsHookCommand(state) {
  const shim = join(state.home, '.learning-space/bin/learning-space')
  return (label) => `LEARNING_SPACE_PORT=${state.mcpPort} '${shim}' news --client '${label}' 2>/dev/null || true`
}

/** Claude: one `claude -p` turn. resume = the session id of phase 1. */
async function claudeTurn(state, dir, prompt, phase, resume = null) {
  const config = join(state.dir, 'mcp.json')
  writeFileSync(config, JSON.stringify({ mcpServers: { 'learning-space': { type: 'http', url: `http://127.0.0.1:${state.mcpPort}/mcp` } } }, null, 2))
  const hookArgs = []
  if (opts.newsHook) {
    const settings = join(state.dir, 'claude-settings.json')
    writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: newsHookCommand(state)('Claude Code'), timeout: 5 }] }] } }, null, 2))
    hookArgs.push('--settings', settings)
  }
  // The prompt goes before --allowedTools: that flag takes every word after it.
  const argv = ['-p', prompt, ...(resume ? ['--resume', resume] : []), '--model', opts.model, ...(opts.effort ? ['--effort', opts.effort] : []), '--mcp-config', config, '--strict-mcp-config', '--setting-sources', 'project,local', ...hookArgs, '--output-format', 'json', '--allowedTools', 'mcp__learning-space__*']
  const stdoutFile = join(dir, `${phase}-claude.json`)
  const code = await runProcess('claude', argv, { cwd: state.folder, env: process.env, stdoutFile, stderrFile: join(dir, `${phase}-stderr.txt`) })
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(stdoutFile, 'utf8'))
  } catch {
    // A crash or a timeout: keep the raw text.
  }
  return {
    exit_code: code,
    reply: parsed?.result ?? readFileSync(stdoutFile, 'utf8'),
    is_error: parsed ? Boolean(parsed.is_error) : true,
    session: parsed?.session_id ?? resume,
    cost_usd: parsed?.total_cost_usd ?? null,
    num_turns: parsed?.num_turns ?? null
  }
}

/** The lab's own CODEX_HOME: auth.json is a symlink to the founder's login (never read or copied); config.toml has only the lab server. */
function prepareCodexHome(state) {
  const home = opts.codexHome
  mkdirSync(home, { recursive: true })
  const auth = join(home, 'auth.json')
  let present = false
  try {
    lstatSync(auth)
    present = true
  } catch {
    // Missing: link it.
  }
  if (!present) {
    const real = join(homedir(), '.codex/auth.json')
    if (!existsSync(real)) throw new Error(`No Codex login at ${real}. Log in with \`codex login\` first.`)
    symlinkSync(real, auth)
    say(`linked ${auth} -> ${real}`)
  }
  try {
    execFileSync('codex', ['login', 'status'], { env: { ...process.env, CODEX_HOME: home }, stdio: 'pipe' })
  } catch (error) {
    throw new Error(`\`codex login status\` failed with CODEX_HOME=${home}: ${String(error.stderr ?? error.message ?? error).trim()}`)
  }
  writeFileSync(
    join(home, 'config.toml'),
    [
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      `model = ${JSON.stringify(opts.model)}`,
      `model_reasoning_effort = ${JSON.stringify(opts.effort)}`,
      'service_tier = "default"',
      '',
      '[features]',
      'js_repl = false',
      'multi_agent_v2 = true',
      '',
      '[mcp_servers.learning-space]',
      `url = ${JSON.stringify(`http://127.0.0.1:${state.mcpPort}/mcp`)}`,
      // A read-only sandbox with approval "never" declines write tools unless they are approved here.
      'default_tools_approval_mode = "approve"',
      ''
    ].join('\n')
  )
}

function codexRollout(threadId) {
  if (!threadId) return null
  const found = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith(`${threadId}.jsonl`)) found.push(path)
    }
  }
  walk(join(opts.codexHome, 'sessions'))
  return found[0] ?? null
}

/** Codex: one `codex exec` turn, or `codex exec resume <thread>`. */
async function codexTurn(state, dir, prompt, phase, thread = null) {
  const stdoutFile = join(dir, `${phase}-codex.jsonl`)
  const lastMessage = join(dir, `${phase}-reply.md`)
  const common = ['--json', '--skip-git-repo-check', '-m', opts.model, '-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`, '-o', lastMessage]
  if (opts.newsHook) {
    const hook = `{type="command",command=${JSON.stringify(newsHookCommand(state)('Codex'))},timeout=5}`
    common.push('-c', `hooks.UserPromptSubmit=[{hooks=[${hook}]}]`, '--dangerously-bypass-hook-trust')
  }
  const argv = thread ? ['exec', 'resume', ...common, thread, prompt] : ['exec', ...common, prompt]
  const code = await runProcess('codex', argv, { cwd: state.folder, env: { ...process.env, CODEX_HOME: opts.codexHome }, stdoutFile, stderrFile: join(dir, `${phase}-stderr.txt`) })
  let threadId = thread
  const tokens = { input: 0, cached_input: 0, output: 0, reasoning_output: 0 }
  const errors = []
  for (const l of readFileSync(stdoutFile, 'utf8').split('\n')) {
    let event
    try {
      event = JSON.parse(l)
    } catch {
      continue
    }
    if (event.type === 'thread.started') threadId = event.thread_id
    if (event.type === 'turn.completed') {
      const u = event.usage ?? {}
      tokens.input += u.input_tokens ?? 0
      tokens.cached_input += u.cached_input_tokens ?? 0
      tokens.output += u.output_tokens ?? 0
      tokens.reasoning_output += u.reasoning_output_tokens ?? 0
    }
    if (event.type === 'turn.failed' || event.type === 'error') errors.push(event.error?.message ?? event.message ?? JSON.stringify(event))
    if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item.status === 'failed') errors.push(`${event.item.tool}: ${event.item.error?.message ?? 'failed'}`)
  }
  return {
    exit_code: code,
    reply: existsSync(lastMessage) ? readFileSync(lastMessage, 'utf8') : '',
    is_error: code !== 0 || errors.length > 0,
    errors,
    session: threadId,
    tokens
  }
}

function claudeTranscript(sessionId) {
  if (!sessionId) return null
  const root = join(homedir(), '.claude/projects')
  if (!existsSync(root)) return null
  for (const project of readdirSync(root)) {
    const file = join(root, project, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

// ---------- Main ----------

async function main() {
  const tasks = JSON.parse(readFileSync(join(LAB, 'council/tasks.json'), 'utf8'))
  const known = tasks[opts.task]
  const task = known ? { id: opts.task, ...known } : { id: 'custom', title: opts.task.slice(0, 60), text: opts.task }
  const title = opts.title ?? `${task.title} — ${opts.client} ${opts.model}${opts.effort ? ` ${opts.effort}` : ''}`
  const purpose = stripComments(readFileSync(join(LAB, 'council/purpose.md'), 'utf8'))
  const interview = stripComments(readFileSync(join(LAB, 'council/interview.md'), 'utf8'))
  const prompt = `${purpose}\n\n## The task\n\n${task.text}`

  const dir = runFolder(`${task.id}-${opts.client}-${opts.model}`)
  const framesDir = join(SCRATCH, 'frames', basename(dir))
  say(`run folder ${dir}`)
  writeFileSync(join(dir, 'prompt.md'), `${prompt}\n`)

  const state = await startInstance({ name: opts.name, mcpPort: opts.mcpPort, debugPort: opts.debugPort, built: opts.built, fresh: true })
  say(`app ${state.mode} on MCP ${state.mcpPort}, debug ${state.debugPort}, PIDs ${state.pids.join(', ')}`)
  let cdp = null
  try {
    if (opts.client === 'codex') prepareCodexHome(state)
    if (task.learner) {
      drive(state.debugPort, 'draw', '--strokes', JSON.stringify(LEARNER[task.learner]()))
      await sleep(1500) // the autosave records the learner's edit
      say(`drew the learner's ${task.learner} strokes`)
    }

    // Phase 1: work, recorded.
    cdp = await cdpConnect(state.debugPort)
    const recording = await startRecording(cdp, framesDir)
    await sleep(300)
    const t0 = Date.now()
    say(`phase 1: ${opts.client} ${opts.model}${opts.effort ? ` (${opts.effort})` : ''} on "${task.text}"`)
    const work = opts.client === 'claude' ? await claudeTurn(state, dir, prompt, 'work') : await codexTurn(state, dir, prompt, 'work')
    const t1 = Date.now()
    say(`phase 1 done in ${((t1 - t0) / 1000).toFixed(1)} s, exit ${work.exit_code}, session ${work.session}`)

    // Record until the last scene has played: its run_scene end + duration_s, or the scene hook.
    await sleep(1000)
    const calls = traceCalls(state.traces, t0)
    let tEnd = t1 + 1000
    for (const c of calls.filter((c) => c.tool === 'run_scene' && c.ok)) {
      try {
        const d = JSON.parse(c.result_text).duration_s
        if (typeof d === 'number') tEnd = Math.max(tEnd, Date.parse(c.end ?? c.t) + d * 1000 + 1000)
      } catch {
        // No duration.
      }
    }
    while (Date.now() < tEnd) await sleep(100)
    for (let i = 0; i < 300 && (await sceneHook(cdp))?.playing; i++) {
      await sleep(100)
      tEnd = Date.now() + 500
    }
    while (Date.now() < tEnd) await sleep(50)
    const frames = await recording.stop()
    const rect = await canvasRect(cdp)
    const crop = frames.length ? cropFilter(frames[0].file, rect, frames[0].w) : ''
    say(`${frames.length} frames over ${((tEnd - t0) / 1000).toFixed(1)} s`)
    // The videos and pictures never stop the run: a failure is recorded and the interview still runs.
    const mediaErrors = []
    const media = async (what, fn) => {
      try {
        return await fn()
      } catch (error) {
        const message = `${what}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000)
        mediaErrors.push(message)
        say(`${message} (continuing)`)
        return null
      }
    }
    let tv = Date.now()
    await media('real-speed video', () => encodeVideo(frames, join(dir, 'video-real.mp4'), { from: t0, to: tEnd, crop }))
    say(`real-speed video in ${((Date.now() - tv) / 1000).toFixed(1)} s`)
    const labels = traceLabels(calls, { from: t0, opened: traceSessionOpen(state.traces, t0), turnEnd: t1 })
    tv = Date.now()
    const watch = (await media('watch video', () => encodeWatchVideo(frames, join(dir, 'video.mp4'), { from: t0, to: tEnd, crop, labels, playing: scenePlaySpans(calls) }))) ?? { watch_s: null, real_s: (tEnd - t0) / 1000, cuts: [] }
    say(`watch video ${watch.watch_s} s of ${watch.real_s} s real (${watch.cuts.length} cuts), made in ${((Date.now() - tv) / 1000).toFixed(1)} s`)
    const finalRaw = join(framesDir, 'final.png')
    await media('final picture', async () => {
      await cdp.screenshot(finalRaw)
      cropImage(finalRaw, join(dir, 'final.png'), crop)
    })
    try {
      await withMcp(state.mcpPort, async (call) => {
        const shot = await call('get_screenshot', { target: 'content', max_size: 2400 })
        const image = shot.content?.find((p) => p.type === 'image')
        if (image) writeFileSync(join(dir, 'board.png'), Buffer.from(image.data, 'base64'))
      })
    } catch (error) {
      say(`board screenshot failed: ${error.message}`)
    }

    // The filmstrip: the board after each write (at most 12), or 8 evenly spaced frames.
    const writes = calls.filter((c) => WRITE_TOOLS.has(c.tool))
    const rel = (iso) => (Date.parse(iso) - t0) / 1000
    let times = writes.map((c) => ({ t: rel(c.end ?? c.t) + 0.5, label: `${rel(c.t).toFixed(1)} s  ${c.tool}${c.ok ? '' : ' (error)'}` }))
    const span = (tEnd - t0) / 1000
    const even = (n) => Array.from({ length: n }, (_, i) => ({ t: (span * (i + 1)) / n, label: `${((span * (i + 1)) / n).toFixed(1)} s` }))
    if (times.length > 12) times = even(8)
    // Few writes: fill up to 8 frames with evenly spaced ones, in time order.
    else if (times.length < 8) times = [...times, ...even(8 - times.length)].sort((a, b) => a.t - b.t)
    await media('filmstrip', () => {
      const tiles = times.map((x, i) => {
        const out = join(framesDir, `strip-${i}.png`)
        cropImage(frameAt(frames, t0 + x.t * 1000).file, out, crop)
        return { file: out, label: x.label }
      })
      filmstrip(tiles, join(dir, 'filmstrip.png'))
    })
    cdp.close()
    cdp = null

    // The programs.
    const scenes = calls.filter((c) => c.tool === 'run_scene')
    const program = scenes.length
      ? scenes.map((c, i) => `// ---- run_scene ${i + 1} of ${scenes.length} at ${rel(c.t).toFixed(1)} s${c.args?.name ? ` (${c.args.name})` : ''}${c.ok ? '' : ' (error)'} ----\n${c.args?.code ?? ''}\n`).join('\n')
      : writes.map((c) => `// ---- ${c.tool} at ${rel(c.t).toFixed(1)} s${c.ok ? '' : ' (error)'} ----\n${c.args?.html ?? c.args?.svg_path ?? JSON.stringify(c.args, null, 2)}\n`).join('\n')
    if (program) writeFileSync(join(dir, 'program.js'), program)
    writeFileSync(join(dir, 'calls.json'), JSON.stringify(calls.map((c) => ({ t_s: rel(c.t), tool: c.tool, ms: c.duration_ms, ok: c.ok, error: c.error ?? null, args: c.args, result: c.result_text })), null, 2))

    // Phase 2: the interview, in the same session.
    say('phase 2: interview')
    const i0 = Date.now()
    const answer = work.session ? (opts.client === 'claude' ? await claudeTurn(state, dir, interview, 'interview', work.session) : await codexTurn(state, dir, interview, 'interview', work.session)) : null
    const i1 = Date.now()
    writeFileSync(join(dir, 'feedback.md'), answer ? `${answer.reply.trim()}\n` : '_No session to resume: phase 1 failed._\n')
    say(answer ? `phase 2 done in ${((i1 - i0) / 1000).toFixed(1)} s, exit ${answer.exit_code}` : 'phase 2 skipped')

    // A resumed Codex thread reports the thread's running total: keep the interview's own share.
    if (answer?.tokens && work.tokens) for (const key of Object.keys(answer.tokens)) answer.tokens[key] = Math.max(0, answer.tokens[key] - (work.tokens[key] ?? 0))
    const perTool = {}
    for (const c of calls) perTool[c.tool] = (perTool[c.tool] ?? 0) + 1
    const firstWrite = writes.find((c) => c.ok)
    const meta = {
      kind: 'council',
      title,
      task: task.text,
      task_id: task.id,
      client: opts.client,
      model: opts.model,
      effort: opts.effort,
      started: new Date(t0).toISOString(),
      ok: work.exit_code === 0 && !work.is_error,
      error: work.is_error ? (work.errors?.join(' | ') || `exit ${work.exit_code}`) : null,
      session: work.session,
      resumed_same_session: Boolean(answer && answer.session === work.session),
      transcript: opts.client === 'claude' ? claudeTranscript(work.session) : codexRollout(work.session),
      lab: { name: state.name, mode: state.mode, mcpPort: state.mcpPort, folder: state.folder, traces: state.traces },
      numbers: {
        first_mark_ms: firstWrite ? Date.parse(firstWrite.t) - t0 : null,
        calls: calls.length,
        write_calls: writes.length,
        scenes: scenes.length,
        errors: calls.filter((c) => !c.ok).length,
        wall_ms: t1 - t0,
        recorded_s: Math.round((tEnd - t0) / 100) / 10,
        watch_s: watch.watch_s,
        interview_ms: answer ? i1 - i0 : null,
        frames: frames.length
      },
      per_tool: perTool,
      cuts: watch.cuts,
      media_errors: mediaErrors,
      work: { exit_code: work.exit_code, is_error: work.is_error, cost_usd: work.cost_usd ?? null, num_turns: work.num_turns ?? null, tokens: work.tokens ?? null },
      interview: answer ? { exit_code: answer.exit_code, is_error: answer.is_error, session: answer.session, cost_usd: answer.cost_usd ?? null, tokens: answer.tokens ?? null } : null,
      agent_pids: pids
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    writeFileSync(join(dir, 'reply.md'), `${work.reply ?? ''}\n`)
    say(`first mark ${meta.numbers.first_mark_ms ?? '-'} ms, ${calls.length} calls (${writes.length} writes), wall ${(meta.numbers.wall_ms / 1000).toFixed(1)} s`)
  } finally {
    if (cdp) cdp.close()
    rmSync(framesDir, { recursive: true, force: true })
    if (!opts.keepApp) say(`app stopped (PIDs ${(await stopInstance(opts.name)).join(', ')})`)
  }
  say(`gallery ${writeGallery()}`)
  say(`done: ${dir}`)
}

main().catch((error) => {
  console.error(`council: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
