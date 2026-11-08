#!/usr/bin/env node
/**
 * The agent bench: run the fixed scenarios (scenarios.mjs) with a real agent
 * client against an own Askaboard instance, and write the measurements.
 * This is a measurement, not a test: nothing passes or fails.
 *
 *   node scripts/bench/run.mjs [--scenarios S1,S2,S3,S4,P1,P2,P3] [--model opus] [--client claude|codex]
 *                              [--effort medium] [--codex-home <dir>]
 *                              [--out <dir>] [--dev] [--mcp-port 47870] [--debug-port 9470]
 *                              [--timeout-min 15] [--no-news-hook] [--no-web]
 *
 * Per conversation (S1+S2, S3+S4) it makes a scratch learning folder from
 * resources/learning-folder/, starts the app on it (built app from out/, or
 * `electron-vite dev` with --dev) with HOME, --user-data-dir and
 * SPACE_TRACE_DIR in the run folder, draws the learner's strokes with
 * scripts/drive.mjs, runs the agent headless from inside the folder
 * (`claude -p`, follow-ups resume the session by its id), and saves per scenario: the
 * session trace and its images, the trace report, the agent's reply, the final
 * window and whole-board screenshots, and metrics.json. All scenarios go into
 * results.json and summary.md in --out.
 *
 * The perception scenarios P1-P3 (not in the default selection) each get a
 * fresh folder and app: the bench seeds agent material over its own MCP
 * client and the learner's earlier ink, lets the agent look once (turn 0,
 * --model haiku, not measured), draws the learner's new work, then measures a
 * NEW agent run (turn 1). See PERCEPTION in scenarios.mjs. V1 is a
 * continuation instead: turn 0 is a real turn of the measured model ("explain
 * … use the board"), the learner sketches beside its drawing, and turn 1
 * resumes the same thread (codex exec resume / claude -p --resume).
 *
 * --client codex runs `codex exec --json` (the founder's model, gpt-6.1-sol at
 * reasoning effort medium, unless --model / --effort say otherwise) with a
 * scratch CODEX_HOME (--codex-home) whose config.toml holds only the bench's
 * askaboard server. Its auth.json is a symlink to ~/.codex/auth.json (the
 * runner makes it when it is missing). Follow-ups resume the thread by its id;
 * turn 0 of P scenarios uses the same model at effort low. Codex reports no
 * cost: the metrics hold its token usage, and brief_loaded says whether the
 * learning folder's AGENTS.md brief was in the agent's context.
 *
 * The agent turns are the lab's shared ones (claudeTurn, codexTurn and
 * prepareCodexHome in scripts/lab/common.mjs), so the bench runs the agents
 * as the lab and perf runs do (decision W10): all of the agent's own tools
 * with no permission prompts (Claude --permission-mode bypassPermissions;
 * Codex sandbox_mode "danger-full-access", approval_policy "never"), and the
 * web tools unless --no-web. The agent output is agent-claude.json or
 * agent-codex.jsonl, agent-stderr.txt (Codex also agent-reply.md).
 *
 * The agent gets the plugins' prompt hook (UserPromptSubmit runs `askaboard news
 * --client <label>` from the run's own HOME, at --mcp-port), so the board news reaches
 * each prompt as it does with the installed plugins; --no-news-hook leaves it out.
 * Claude gets it through --settings, Codex through a -c hooks override with
 * --dangerously-bypass-hook-trust (scratch config only).
 *
 * Built mode needs `npm run build` first. The ports must be free: the runner
 * never stops a process it did not start.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, closeSync } from 'node:fs'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_SCENARIOS, CONVERSATIONS, PERCEPTION, S_SCENARIOS, TURN0_CODEX_EFFORT, TURN0_MODEL, TURN0_PROMPT } from './scenarios.mjs'
import { seedBusy } from './busy.mjs'
import { analyzeFile, readJsonl, totalOf, rectText, LOOK_TOOLS } from '../trace-report.mjs'
import { SCRATCH_ROOT, claudeTurn, displaySwitches, codexRollout, codexTurn, prepareCodexHome } from '../lab/common.mjs'

const SPACE = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DRIVE = join(SPACE, 'scripts/drive.mjs')
const TEMPLATE = join(SPACE, 'resources/learning-folder')

// ---------- Arguments ----------

const argv = process.argv.slice(2)
function option(name, fallback) {
  const i = argv.indexOf(name)
  if (i === -1) return fallback
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}
const flag = (name) => argv.includes(name)

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const opts = {
  scenarios: option('--scenarios', S_SCENARIOS.join(','))
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  client: option('--client', 'claude'),
  model: option('--model', null),
  effort: option('--effort', null),
  codexHome: resolve(option('--codex-home', join(SCRATCH_ROOT, 'ls-bench-codex/codex-home'))),
  out: resolve(option('--out', join(SCRATCH_ROOT, `ls-bench/runs/${stamp}`))),
  dev: flag('--dev'),
  mcpPort: Number(option('--mcp-port', '47870')),
  debugPort: Number(option('--debug-port', '9470')),
  timeoutMs: Number(option('--timeout-min', '15')) * 60_000,
  // The board-news prompt hook (`askaboard news`), as the plugins install it. --no-news-hook measures without it.
  newsHook: !flag('--no-news-hook'),
  // The agent's web tools (Claude WebSearch and WebFetch, Codex --search). --no-web takes them away.
  web: !flag('--no-web')
}
if (opts.client === 'claude' && !opts.model) opts.model = 'opus'
// The founder's Codex setup (Codex Desktop): gpt-6.1-sol at reasoning effort medium.
if (opts.client === 'codex' && !opts.model) opts.model = 'gpt-6.1-sol'
if (opts.client === 'codex' && !opts.effort) opts.effort = 'medium'

const pids = { started: [], stopped: [] }
const log = (...parts) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...parts)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function validate() {
  for (const id of opts.scenarios) if (!ALL_SCENARIOS.includes(id)) throw new Error(`Unknown scenario ${id}. Known: ${ALL_SCENARIOS.join(', ')}`)
  for (const conv of CONVERSATIONS) {
    conv.scenarios.forEach((s, i) => {
      if (s.followUp && opts.scenarios.includes(s.id) && !opts.scenarios.includes(conv.scenarios[i - 1].id)) {
        throw new Error(`${s.id} continues ${conv.scenarios[i - 1].id}: select both (--scenarios ${conv.scenarios[i - 1].id},${s.id}).`)
      }
    })
  }
  if (!['claude', 'codex'].includes(opts.client)) throw new Error('--client is claude or codex')
  if (!opts.dev && !existsSync(join(SPACE, 'out/main/index.js'))) throw new Error('No built app in out/. Run `npm run build` in space/ first, or pass --dev.')
}

// ---------- The app instance ----------

function portInUse(port) {
  return new Promise((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })
}

/**
 * The AGENTS.md template with an empty, unedited brief block (src/main/brief-block.ts).
 * The app fills the block with the current brief when it opens the folder, so
 * the bench folder gets the same block as a folder set up in the app.
 */
function agentsWithEmptyBrief() {
  const template = readFileSync(join(TEMPLATE, 'AGENTS.md'), 'utf8')
  const placeholder = '<!-- askaboard brief: placeholder (the app puts the brief here at setup) -->'
  if (!template.includes(placeholder)) throw new Error('The AGENTS.md template has no brief placeholder.')
  const sha = createHash('sha256').update('').digest('hex').slice(0, 12)
  const block = `<!-- askaboard brief: start (managed by the Askaboard app; edits here stop its updates) sha=${sha} -->\n<!-- askaboard brief: end -->`
  return template.replace(placeholder, block)
}

function setupFolder(folder) {
  for (const dir of ['sessions', 'topics', 'materials', 'boards', '.learning-space']) mkdirSync(join(folder, dir), { recursive: true })
  for (const dir of ['sessions', 'topics', 'materials']) writeFileSync(join(folder, dir, '.gitkeep'), '')
  for (const file of ['plan.md', 'learner.md', '.learning-space/guide.md']) copyFileSync(join(TEMPLATE, file), join(folder, file))
  writeFileSync(join(folder, 'AGENTS.md'), agentsWithEmptyBrief())
  writeFileSync(join(folder, 'boards/Board.board.json'), '{\n  "format": "learning-space.board",\n  "version": 2,\n  "nextSeq": 1,\n  "nodes": []\n}\n')
}

function drive(...args) {
  return execFileSync(process.execPath, [DRIVE, '--port', String(opts.debugPort), ...args], { encoding: 'utf8', timeout: 60_000 })
}

function childPids(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .map(Number)
      .filter(Boolean)
  } catch {
    return []
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function startApp(work) {
  for (const port of [opts.mcpPort, opts.debugPort]) {
    if (await portInUse(port)) throw new Error(`Port ${port} is in use by another process. Pick free ports with --mcp-port / --debug-port.`)
  }
  const env = {
    ...process.env,
    HOME: work.home,
    SPACE_FOLDER: work.folder,
    SPACE_MCP_PORT: String(opts.mcpPort),
    SPACE_REMOTE_DEBUG: String(opts.debugPort),
    SPACE_TRACE_DIR: work.traces,
    SPACE_NO_FOCUS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const logFd = openSync(join(work.dir, 'app.log'), 'a')
  let child
  if (opts.dev) {
    child = spawn(join(SPACE, 'node_modules/.bin/electron-vite'), ['dev', '--', `--user-data-dir=${work.userData}`, ...displaySwitches(env)], { cwd: SPACE, env, stdio: ['ignore', logFd, logFd] })
  } else {
    const electron = createRequire(join(SPACE, 'package.json'))('electron')
    child = spawn(electron, [`--user-data-dir=${work.userData}`, ...displaySwitches(env), '.'], { cwd: SPACE, env, stdio: ['ignore', logFd, logFd] })
  }
  closeSync(logFd)
  pids.started.push({ pid: child.pid, what: opts.dev ? 'electron-vite dev' : 'Electron (built app)' })
  log(`app started, PID ${child.pid} (${opts.dev ? 'dev' : 'built'}), MCP ${opts.mcpPort}, debug ${opts.debugPort}`)
  const app = { child, pid: child.pid }
  try {
    const deadline = Date.now() + 90_000
    while (!(await portInUse(opts.mcpPort))) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`The app did not open MCP port ${opts.mcpPort}; see ${join(work.dir, 'app.log')}`)
      await sleep(500)
    }
    for (;;) {
      try {
        const state = JSON.parse(drive('eval-state'))
        if (state.board) break
      } catch {
        // The page is still loading.
      }
      if (Date.now() > deadline) throw new Error(`The app did not open a board; see ${join(work.dir, 'app.log')}`)
      await sleep(500)
    }
    if (opts.dev) for (const pid of childPids(child.pid)) pids.started.push({ pid, what: 'Electron (dev child)' })
  } catch (error) {
    await stopApp(app)
    throw error
  }
  return app
}

/** Stop the app: its Electron process (the dev child first), then wait; SIGKILL only these exact PIDs. */
async function stopApp(app) {
  const targets = opts.dev ? [...childPids(app.pid), app.pid] : [app.pid]
  for (const pid of targets) {
    if (!alive(pid)) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Gone already.
    }
    const deadline = Date.now() + 10_000
    while (alive(pid) && Date.now() < deadline) await sleep(200)
    if (alive(pid)) process.kill(pid, 'SIGKILL')
    pids.stopped.push(pid)
  }
  log(`app stopped (PIDs ${targets.join(', ')})`)
  const deadline = Date.now() + 10_000
  while ((await portInUse(opts.mcpPort)) && Date.now() < deadline) await sleep(300)
}

// ---------- The agent ----------

/**
 * The agent of one turn for the lab's shared headless turns (scripts/lab/common.mjs): the same
 * tools, permissions and web as the lab and perf runs (decision W10). Its PIDs go to pids.started.
 */
function agentOf(model, effort, turnPids = []) {
  return { client: opts.client, model, effort, newsHook: opts.newsHook, web: opts.web, codexHome: opts.codexHome, timeoutMs: opts.timeoutMs, pids: turnPids, say: log }
}

async function runAgent(scenario, work, dir, model = opts.model, effort = opts.effort) {
  const turnPids = []
  const agent = agentOf(model, effort, turnPids)
  const state = { dir: work.dir, folder: work.folder, home: work.home, mcpPort: opts.mcpPort }
  try {
    if (opts.client === 'codex') return await runCodex(scenario, work, dir, agent, state)
    // A follow-up resumes the folder's last Claude session.
    if (scenario.followUp && !work.claudeSession) throw new Error(`${scenario.id} is a follow-up, but the conversation has no Claude session.`)
    const turn = await claudeTurn(agent, state, dir, scenario.prompt, 'agent', scenario.followUp ? work.claudeSession : null)
    if (turn.session) work.claudeSession = turn.session
    return {
      exit_code: turn.exit_code,
      reply: turn.reply,
      is_error: turn.is_error,
      cost_usd: turn.cost_usd,
      num_turns: turn.num_turns,
      client_duration_ms: turn.raw?.duration_ms ?? null
    }
  } finally {
    for (const pid of turnPids) pids.started.push({ pid, what: `${opts.client} agent` })
  }
}

/** Was the learning folder's brief (AGENTS.md) in the agent's context? Looks at the context items, not at tool results. */
function briefInRollout(file) {
  if (!file) return null
  const marker = 'askaboard brief: start'
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes(marker)) continue
    try {
      const entry = JSON.parse(line)
      const p = entry.payload ?? {}
      if (entry.type === 'world_state' || entry.type === 'turn_context') return true
      if (entry.type === 'response_item' && p.type === 'message' && p.role !== 'assistant') return true
    } catch {
      // A partial line.
    }
  }
  return false
}

/** The board news the prompt hook added in this run (hook context after startedMs), '' when none, null without a rollout. */
function newsInRollout(file, startedMs) {
  if (!file) return null
  const texts = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('hooks.additional_context')) continue
    try {
      const entry = JSON.parse(line)
      if (Date.parse(entry.timestamp) < startedMs) continue
      for (const part of entry.payload?.content ?? []) if (typeof part.text === 'string' && part.text.startsWith('Board news')) texts.push(part.text)
    } catch {
      // A partial line.
    }
  }
  return texts.join('\n')
}

async function runCodex(scenario, work, dir, agent, state) {
  // A follow-up resumes this conversation's thread by id; anything else is a new `codex exec`.
  const resume = scenario.followUp && work.codexThread
  if (scenario.followUp && !work.codexThread) throw new Error(`${scenario.id} is a follow-up, but the conversation has no Codex thread.`)
  const startedMs = Date.now()
  const turn = await codexTurn(agent, state, dir, scenario.prompt, 'agent', resume || null)
  const threadId = turn.session
  const tokens = { ...turn.tokens }
  // On a resumed thread, turn.completed reports the thread's running total: keep this run's share.
  const totals = { ...tokens }
  if (resume && work.codexTokens) for (const key of Object.keys(tokens)) tokens[key] = Math.max(0, tokens[key] - work.codexTokens[key])
  if ((!String(scenario.id).endsWith('-turn0') || scenario.keepThread) && threadId && (resume || !scenario.followUp)) {
    work.codexThread = threadId
    work.codexTokens = totals
  }

  const rollout = codexRollout(opts.codexHome, threadId)
  if (rollout) copyFileSync(rollout, join(dir, 'codex-rollout.jsonl'))
  let clientMs = null
  if (rollout) {
    // The duration of this run's last task in the thread.
    for (const line of readFileSync(rollout, 'utf8').split('\n')) {
      if (!line.includes('"task_complete"')) continue
      try {
        clientMs = JSON.parse(line).payload?.duration_ms ?? clientMs
      } catch {
        // A partial line.
      }
    }
  }
  const failedCalls = new Set(turn.failed_tool_calls)
  const clientErrors = turn.errors.filter((e) => !failedCalls.has(e))
  return {
    exit_code: turn.exit_code,
    reply: turn.reply,
    is_error: turn.is_error,
    ...(clientErrors.length ? { client_errors: clientErrors } : {}),
    client_failed_tool_calls: turn.failed_tool_calls,
    effort: agent.effort,
    codex_thread: threadId,
    resumed: Boolean(resume),
    brief_loaded: briefInRollout(rollout),
    news_hook: opts.newsHook,
    news_in_prompt: opts.newsHook ? newsInRollout(rollout, startedMs) : null,
    tokens,
    cost_usd: null,
    num_turns: turn.turns || null,
    client_duration_ms: clientMs
  }
}

// ---------- Measurements ----------

const ms = (iso) => Date.parse(iso)
const area = (r) => (r ? Math.max(0, r.width) * Math.max(0, r.height) : 0)

function union(rects) {
  const list = rects.filter(Boolean)
  if (!list.length) return null
  const x = Math.min(...list.map((r) => r.x))
  const y = Math.min(...list.map((r) => r.y))
  return { x, y, width: Math.max(...list.map((r) => r.x + r.width)) - x, height: Math.max(...list.map((r) => r.y + r.height)) - y }
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const w = Math.min(a.x + a.width, b.x + b.width) - x
  const h = Math.min(a.y + a.height, b.y + b.height) - y
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null
}

function strokeBounds(strokes, pad = 3) {
  const pts = strokes.flat()
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs) - pad
  const y = Math.min(...ys) - pad
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y }
}

function traceFiles(dir) {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl') && entry.name !== 'learner-edits.jsonl') out.push(path)
    }
  }
  walk(dir)
  return out
}

function learnerEditsSince(traces, sinceMs) {
  const edits = []
  for (const day of existsSync(traces) ? readdirSync(traces) : []) {
    const file = join(traces, day, 'learner-edits.jsonl')
    if (existsSync(file)) edits.push(...readJsonl(file).filter((e) => ms(e.t) >= sinceMs))
  }
  return edits.sort((a, b) => ms(a.t) - ms(b.t))
}

function lookAccuracy(ink, sessions) {
  const shots = sessions.flatMap((s) => s.screenshot_list).filter((shot) => shot.rect)
  const list = shots.map((shot) => {
    const overlap = intersection(ink, shot.rect)
    const coverage = area(ink) ? area(overlap) / area(ink) : 0
    return { request: shot.request, rect: shot.rect, ratio: area(shot.rect) ? area(ink) / area(shot.rect) : null, coverage: Math.round(coverage * 1000) / 1000 }
  })
  const containing = list.filter((s) => s.coverage >= 0.99)
  return {
    ink_bounds: ink,
    screenshots: list,
    any_contains: containing.length > 0,
    any_overlap: list.some((s) => s.coverage > 0),
    best_ratio: containing.length ? Math.max(...containing.map((s) => s.ratio)) : null
  }
}

/** Run fn(client) on a new MCP connection as the bench client "ls-bench" (trace-report skips its sessions). */
async function withBenchClient(fn) {
  const require = createRequire(join(SPACE, 'package.json'))
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
  const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
  const client = new Client({ name: 'ls-bench', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${opts.mcpPort}/mcp`))
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await transport.terminateSession().catch(() => undefined)
    await client.close().catch(() => undefined)
  }
}

/** A picture of the whole board through MCP, as the bench client. */
async function contentScreenshot(file) {
  return withBenchClient(async (client) => {
    const result = await client.callTool({ name: 'get_screenshot', arguments: { part: 'board', max_size: 2400 } })
    const image = result.content?.find((part) => part.type === 'image')
    if (image) writeFileSync(file, Buffer.from(image.data, 'base64'))
    return Boolean(image)
  })
}

async function runScenario(scenario, work) {
  const dir = join(opts.out, scenario.id)
  mkdirSync(join(dir, 'trace'), { recursive: true })
  log(`${scenario.id} (${scenario.title}): ${scenario.prompt}`)

  let drawStart = null
  let ink = null
  if (scenario.strokes) {
    drawStart = Date.now()
    drive('draw', '--strokes', JSON.stringify(scenario.strokes))
    await sleep(1500) // the autosave (400 ms) records the learner edit
    const edits = learnerEditsSince(work.traces, drawStart - 50)
    ink = union(edits.map((e) => e.bounds)) ?? strokeBounds(scenario.strokes)
    ink.lastEditAt = edits.length ? edits[edits.length - 1].t : new Date().toISOString()
  }

  const before = new Set(traceFiles(work.traces))
  const t0 = Date.now()
  const agent = await runAgent(scenario, work, dir)
  const t1 = Date.now()
  await sleep(1000) // trace writes and images are queued
  const files = traceFiles(work.traces).filter((f) => !before.has(f))

  const sessions = files.map(analyzeFile).filter((s) => s.client?.name !== 'ls-bench')
  for (const file of files) {
    copyFileSync(file, join(dir, 'trace', basename(file)))
    const stem = basename(file, '.jsonl')
    for (const png of readdirSync(dirname(file)).filter((n) => n.startsWith(`${stem}-`) && n.endsWith('.png'))) copyFileSync(join(dirname(file), png), join(dir, 'trace', png))
  }
  const total = totalOf(sessions)
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ sessions, total }, null, 2))
  writeFileSync(join(dir, 'reply.txt'), agent.reply ?? '')

  try {
    drive('screenshot', join(dir, 'window.png'))
  } catch (error) {
    log(`window screenshot failed: ${String(error.message ?? error)}`)
  }
  try {
    await contentScreenshot(join(dir, 'board-content.png'))
  } catch (error) {
    log(`board screenshot failed: ${String(error.message ?? error)}`)
  }

  const firstWrites = sessions.filter((s) => s.first_write_ms !== null).map((s) => ms(s.start) + s.first_write_ms)
  const looks = sessions.flatMap((s) => s.screenshot_list.map((shot) => ms(shot.t)))
  const allCalls = files.flatMap((f) => readJsonl(f)).filter((e) => e.type === 'tool_call')
  const firstLookAfterInk = ink ? allCalls.filter((c) => LOOK_TOOLS.has(c.tool) && ms(c.t) >= ms(ink.lastEditAt)).map((c) => ms(c.t)) : []
  const metrics = {
    scenario: scenario.id,
    title: scenario.title,
    prompt: scenario.prompt,
    client: opts.client,
    model: opts.model,
    mode: opts.dev ? 'dev' : 'built',
    wall_ms: t1 - t0,
    first_write_ms: firstWrites.length ? Math.min(...firstWrites) - t0 : null,
    first_screenshot_ms: looks.length ? Math.min(...looks) - t0 : null,
    calls: total.calls,
    errors: total.errors,
    screenshots: total.screenshots,
    image_bytes: total.image_bytes,
    agent_ms: total.gap_ms,
    tool_ms: total.tool_ms,
    words: total.words,
    chat_words: wordCount(agent.reply),
    new_top_level: total.new_top_level,
    per_tool: total.per_tool,
    trace_files: files.map((f) => basename(f)),
    ...agent,
    ...(ink
      ? {
          ink_to_first_look_ms: firstLookAfterInk.length ? Math.min(...firstLookAfterInk) - ms(ink.lastEditAt) : null,
          look: lookAccuracy({ x: ink.x, y: ink.y, width: ink.width, height: ink.height }, sessions)
        }
      : {})
  }
  delete metrics.reply
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2))
  log(`${scenario.id} done: ${(metrics.wall_ms / 1000).toFixed(1)} s, ${metrics.calls} calls, ${metrics.screenshots} screenshots, ${metrics.words} words, ${metrics.chat_words} chat words`)
  return { ...metrics, reply: agent.reply }
}

// ---------- Perception scenarios ----------

/** Copy trace files (and their images) into dir/trace. */
function copyTraces(files, dir) {
  mkdirSync(join(dir, 'trace'), { recursive: true })
  for (const file of files) {
    copyFileSync(file, join(dir, 'trace', basename(file)))
    const stem = basename(file, '.jsonl')
    for (const png of readdirSync(dirname(file)).filter((n) => n.startsWith(`${stem}-`) && n.endsWith('.png'))) copyFileSync(join(dirname(file), png), join(dir, 'trace', png))
  }
}

/** One agent turn: run it, then collect the trace files it wrote and the agent sessions in them. */
async function agentTurn(scenario, work, dir, model, effort) {
  mkdirSync(dir, { recursive: true })
  const before = new Set(traceFiles(work.traces))
  const t0 = Date.now()
  const agent = await runAgent(scenario, work, dir, model, effort)
  const t1 = Date.now()
  await sleep(1000) // trace writes and images are queued
  const files = traceFiles(work.traces).filter((f) => !before.has(f))
  copyTraces(files, dir)
  writeFileSync(join(dir, 'reply.txt'), agent.reply ?? '')
  const sessions = files.map(analyzeFile).filter((s) => s.client?.name !== 'ls-bench')
  return { agent, t0, t1, files, sessions }
}

/** The whole board's outline (list_items with a region part as large as the board can be, so every item is listed), through the bench client. */
async function treeText(client) {
  const result = await client.callTool({ name: 'list_items', arguments: { part: { region: { x: -100000, y: -100000, width: 200000, height: 200000 } } } })
  return result.content.find((c) => c.type === 'text')?.text ?? ''
}

/**
 * The items of a list_items outline: unit lines ('  svg "name" n_x · x,y w×h · …', '  ink g3 · x,y w×h · …').
 * The section says the author: "Learner's work" is the learner's; elsewhere a line says "learner" when it is.
 */
function topLevel(tree) {
  const items = []
  let learnerSection = false
  for (const line of tree.split('\n')) {
    if (!/^\s/.test(line)) {
      learnerSection = line.startsWith("Learner's work")
      continue
    }
    const unit = /^\s+(\w+)(?: ".*?")? ((?:n_|g)\w+) · (-?[\d.]+),(-?[\d.]+) ([\d.]+)×([\d.]+)/.exec(line)
    if (unit) items.push({ kind: unit[1], id: unit[2], x: +unit[3], y: +unit[4], width: +unit[5], height: +unit[6], author: learnerSection || / · learner(?: ·|$)/.test(line) ? 'learner' : 'agent' })
  }
  return items
}

/** What the bench needs of the board (as get_canvas_info gave before 2026-10-27): content bounds, the learner's view, item counts by kind. */
async function boardFacts(client) {
  const text = await treeText(client)
  const items = topLevel(text)
  const view = /^View (-?[\d.]+),(-?[\d.]+) ([\d.]+)×([\d.]+)/m.exec(text)
  const counts = {}
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1
  const x = Math.min(...items.map((i) => i.x))
  const y = Math.min(...items.map((i) => i.y))
  const contentBounds = items.length ? { x, y, width: Math.max(...items.map((i) => i.x + i.width)) - x, height: Math.max(...items.map((i) => i.y + i.height)) - y } : null
  return { contentBounds, viewport: view ? { x: +view[1], y: +view[2], width: +view[3], height: +view[4] } : null, counts }
}

/**
 * An empty rect of `size` ({width, height}) near the board item `near`, from
 * the scene API's space(), asked with a write_scene draft: nothing is drawn
 * or committed.
 */
async function emptySpot(client, size, near) {
  const code = `const r = space(${size.width}, ${size.height}, { near: board.node(${JSON.stringify(near)}), inView: false })\nconsole.log(JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }))`
  const result = await client.callTool({ name: 'write_scene', arguments: { code, name: 'bench empty spot' } })
  const body = result.content?.find((part) => part.type === 'text')?.text ?? ''
  if (result.isError) throw new Error(`empty spot near ${near} failed: ${body}`)
  const line = JSON.parse(body).log?.at(-1)
  if (!line) throw new Error(`empty spot near ${near}: no answer in ${body.slice(0, 300)}`)
  return JSON.parse(line)
}

async function runPerception(p, work) {
  const dir = join(opts.out, p.id)
  mkdirSync(dir, { recursive: true })
  log(`${p.id} (${p.title}): ${p.prompt}`)

  // 1. Seed: the busy background round the scenario's area (agent material over the bench's
  // own MCP client, learner pieces with drive.mjs), the scenario's agent material, then the
  // learner's earlier ink.
  const drawLearner = (strokes) => drive('draw', '--strokes', JSON.stringify(strokes))
  const { ctx, busy } = await withBenchClient(async (client) => {
    const mcp = async (name, args) => {
      const result = await client.callTool({ name, arguments: args })
      const body = result.content?.find((part) => part.type === 'text')?.text ?? ''
      if (result.isError) throw new Error(`seed ${name} failed: ${body}`)
      try {
        return JSON.parse(body)
      } catch {
        return body
      }
    }
    const busy = await seedBusy(p.area, mcp)
    return { busy, ctx: await p.seed(mcp) }
  })
  // Drawn after the MCP session closes: a session held open through long drawing drops.
  for (const strokes of busy.learner) drawLearner(strokes)
  delete busy.learner
  if (p.earlier) drawLearner(p.earlier(ctx))
  await sleep(1500) // the autosave records the learner edits

  // The learner's view: the new work up and left of the centre, with neighbours round it, not the whole board.
  const viewOn = (r) => [Math.round(r.x + r.width / 2 + 220), Math.round(r.y + r.height / 2 + 110)]
  let cameraAt
  const setCamera = () => JSON.parse(drive('camera', String(cameraAt[0]), String(cameraAt[1])))
  let turn0
  if (p.lesson) {
    // 2. Turn 0 of a continuation: a real turn of the measured model, in a thread the bench keeps.
    // The learner's view is on the free hole, so the agent's material lands there.
    cameraAt = [Math.round(p.area.x + p.area.width / 2), Math.round(p.area.y + p.area.height / 2)]
    setCamera()
    const before = await withBenchClient(async (client) => topLevel(await treeText(client)))
    turn0 = await agentTurn({ id: `${p.id}-turn0`, prompt: p.lesson.prompt, keepThread: true }, work, join(dir, 'turn0'), opts.model, opts.effort)
    log(`${p.id} turn 0 (lesson) done: ${((turn0.t1 - turn0.t0) / 1000).toFixed(1)} s, exit ${turn0.agent.exit_code}, ${totalOf(turn0.sessions).calls} calls`)
    // The learner sketches beside the agent's newest drawing: an empty spot next to it.
    Object.assign(
      ctx,
      await withBenchClient(async (client) => {
        const known = new Set(before.map((item) => item.id))
        const added = topLevel(await treeText(client)).filter((item) => !known.has(item.id) && item.author !== 'learner')
        if (!added.length) throw new Error(`${p.id}: turn 0 put nothing on the board`)
        const anchor = [...added].reverse().find((item) => item.kind === 'svg') ?? added[added.length - 1]
        const spot = await emptySpot(client, p.sketch, anchor.id)
        return { added, anchor, spot }
      })
    )
    cameraAt = viewOn(strokeBounds(p.work(ctx).flatMap((a) => a.draw ?? a.erase)))
    setCamera()
    writeFileSync(join(dir, 'seed.json'), JSON.stringify({ ctx, busy, camera_at: cameraAt }, null, 2))
  } else {
    cameraAt = viewOn(strokeBounds(p.work(ctx).flatMap((a) => a.draw ?? a.erase)))
    setCamera()
    writeFileSync(join(dir, 'seed.json'), JSON.stringify({ ctx, busy, camera_at: cameraAt }, null, 2))

    // 2. Turn 0: the agent app looks once. Not measured; its trace is kept in turn0/.
    turn0 = await agentTurn(
      { id: `${p.id}-turn0`, prompt: TURN0_PROMPT },
      work,
      join(dir, 'turn0'),
      opts.client === 'claude' ? TURN0_MODEL : opts.model,
      opts.client === 'codex' ? TURN0_CODEX_EFFORT : opts.effort
    )
    log(`${p.id} turn 0 done: ${((turn0.t1 - turn0.t0) / 1000).toFixed(1)} s, exit ${turn0.agent.exit_code}`)
  }

  // 3. The learner's new work, in the learner's view (drawing does not move a camera that already shows it).
  const camera = setCamera()
  const workStart = Date.now()
  const actions = p.work(ctx)
  for (const action of actions) {
    if (action.erase) drive('draw', '--tool', 'eraser', '--strokes', JSON.stringify(action.erase))
    else drive('draw', '--strokes', JSON.stringify(action.draw))
  }
  await sleep(1500) // the autosave (400 ms) records the learner edit
  const cameraAfter = JSON.parse(drive('eval-state'))
  if (Math.hypot(cameraAfter.center[0] - camera.center[0], cameraAfter.center[1] - camera.center[1]) > 1 || cameraAfter.zoom !== camera.zoom) {
    log(`${p.id}: the camera moved while drawing (${JSON.stringify(camera.center)} → ${JSON.stringify(cameraAfter.center)}, zoom ${camera.zoom} → ${cameraAfter.zoom})`)
  }
  const edits = learnerEditsSince(work.traces, workStart - 50)
  const drawn = actions.flatMap((a) => a.draw ?? [])
  const ink = union(edits.map((e) => e.bounds)) ?? strokeBounds(drawn)
  const newIds = [...new Set(edits.flatMap((e) => e.ids ?? []))]
  const lastEditAt = edits.length ? edits[edits.length - 1].t : new Date().toISOString()

  // 4. Turn 1: the scenario prompt, measured. A new agent run, or for a continuation the same thread resumed.
  const turn = await agentTurn(p.lesson ? { ...p, followUp: true } : p, work, dir, opts.model)
  const { agent, t0, t1, files, sessions } = turn
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ sessions, total: totalOf(sessions) }, null, 2))
  try {
    drive('screenshot', join(dir, 'window.png'))
  } catch (error) {
    log(`window screenshot failed: ${String(error.message ?? error)}`)
  }
  try {
    await contentScreenshot(join(dir, 'board-content.png'))
  } catch (error) {
    log(`board screenshot failed: ${String(error.message ?? error)}`)
  }
  let canvas = null
  try {
    canvas = await withBenchClient(boardFacts)
  } catch (error) {
    log(`canvas info failed: ${String(error.message ?? error)}`)
  }

  const total = totalOf(sessions)
  const inkRect = { x: ink.x, y: ink.y, width: ink.width, height: ink.height }
  const look = lookAccuracy(inkRect, sessions)
  // One trace file per MCP session: the agent's calls are those in the files of its sessions.
  const agentFiles = new Set(sessions.map((s) => s.file))
  const calls = files
    .filter((f) => agentFiles.has(basename(f)))
    .flatMap((f) => readJsonl(f))
    .filter((e) => e.type === 'tool_call')
    .sort((a, b) => ms(a.t) - ms(b.t))
  const holding = sessions
    .flatMap((s) => s.screenshot_list)
    .filter((shot) => shot.rect && area(inkRect) && area(intersection(inkRect, shot.rect)) / area(inkRect) >= 0.99)
    .sort((a, b) => ms(a.t) - ms(b.t))[0]

  // Did the first get_changes list the learner's new items?
  const firstChanges = calls.find((c) => c.tool === 'get_changes')
  let firstGetChanges = 'no call'
  let firstGetChangesListed = null
  if (firstChanges) {
    let listed = []
    const body = firstChanges.result_text ?? ''
    try {
      // Before 2026-10-27 get_changes was JSON with each item; since then it is net text by unit (learner ink by ink group), so naming the learner's ink counts as listing it.
      const result = JSON.parse(body)
      listed = (result.changed ?? []).filter((item) => item.by === 'learner').map((item) => item.id)
    } catch {
      if (/^Learner:\n\s+ink /m.test(body)) listed = [...newIds]
    }
    const hits = newIds.filter((id) => listed.includes(id)).length
    firstGetChangesListed = { new_ids: newIds.length, listed: hits, args: firstChanges.args ?? null }
    firstGetChanges = (newIds.length && hits === newIds.length ? 'yes' : hits ? 'part' : 'no') + (firstChanges.args?.since !== undefined ? ` (since ${firstChanges.args.since})` : '')
  }

  const reply = agent.reply ?? ''
  const checks = p.checks.map((c) => ({ name: c.name, soft: Boolean(c.soft), pass: Boolean(c.test(reply)) }))
  const metrics = {
    scenario: p.id,
    kind: 'perception',
    title: p.title,
    prompt: p.prompt,
    client: opts.client,
    model: opts.model,
    mode: opts.dev ? 'dev' : 'built',
    found: look.any_contains,
    look,
    content_bounds: canvas?.contentBounds ?? null,
    content_area: canvas?.contentBounds ? Math.round(area(canvas.contentBounds)) : null,
    ink_share: canvas?.contentBounds ? Math.round((area(inkRect) / area(canvas.contentBounds)) * 1e5) / 1e5 : null,
    learner_view: { center: cameraAfter.center, zoom: cameraAfter.zoom, canvas: camera.canvas, viewport: canvas?.viewport ?? null },
    board_items: canvas?.counts ?? null,
    new_learner_ids: newIds,
    screenshots: total.screenshots,
    calls: total.calls,
    calls_before_ink_shot: holding ? calls.filter((c) => ms(c.t) < ms(holding.t)).length : null,
    ink_shot_ms: holding ? ms(holding.t) - t0 : null,
    ink_to_first_look_ms: (() => {
      const looks = calls.filter((c) => LOOK_TOOLS.has(c.tool) && ms(c.t) >= ms(lastEditAt)).map((c) => ms(c.t))
      return looks.length ? Math.min(...looks) - ms(lastEditAt) : null
    })(),
    first_get_changes: firstGetChanges,
    first_get_changes_detail: firstGetChangesListed,
    checks,
    wall_ms: t1 - t0,
    agent_ms: total.gap_ms,
    tool_ms: total.tool_ms,
    image_bytes: total.image_bytes,
    errors: total.errors,
    chat_words: wordCount(reply),
    per_tool: total.per_tool,
    trace_files: files.map((f) => basename(f)),
    continuation: Boolean(p.lesson),
    turn0: (() => {
      const t0Total = totalOf(turn0.sessions)
      const firstWrites = turn0.sessions.filter((s) => s.first_write_ms !== null).map((s) => ms(s.start) + s.first_write_ms)
      return {
        prompt: p.lesson?.prompt ?? TURN0_PROMPT,
        wall_ms: turn0.t1 - turn0.t0,
        exit_code: turn0.agent.exit_code,
        cost_usd: turn0.agent.cost_usd,
        tokens: turn0.agent.tokens ?? null,
        calls: t0Total.calls,
        screenshots: t0Total.screenshots,
        words: t0Total.words,
        new_top_level: t0Total.new_top_level,
        first_write_ms: firstWrites.length ? Math.min(...firstWrites) - turn0.t0 : null,
        per_tool: t0Total.per_tool,
        codex_thread: turn0.agent.codex_thread ?? null,
        trace_files: turn0.files.map((f) => basename(f))
      }
    })(),
    ...agent
  }
  delete metrics.reply
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2))
  log(
    `${p.id} done: ${(metrics.wall_ms / 1000).toFixed(1)} s, found ${metrics.found ? 'yes' : 'no'}, ${metrics.screenshots} screenshots, first get_changes ${firstGetChanges}, checks ${checks.map((c) => `${c.name} ${c.pass ? 'pass' : 'fail'}`).join(', ')}`
  )
  return { ...metrics, reply }
}

// ---------- Summary ----------

/** Words in the agent's final chat reply. */
function wordCount(text) {
  return typeof text === 'string' ? text.split(/\s+/).filter(Boolean).length : 0
}

const s1 = (v) => (v === null || v === undefined ? '-' : (v / 1000).toFixed(1))
/** Codex token usage in thousands: input / cached input / output. */
const tok = (t) => (t ? `${(t.input / 1000).toFixed(1)}/${(t.cached_input / 1000).toFixed(1)}/${(t.output / 1000).toFixed(1)}` : '-')
const cost = (r) => (r.cost_usd === null || r.cost_usd === undefined ? '-' : r.cost_usd.toFixed(3))

function gitState() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: SPACE, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: SPACE, encoding: 'utf8' }).trim() ? ' (dirty)' : ''
    return `${head}${dirty}`
  } catch {
    return 'unknown'
  }
}

function summary(results) {
  const lines = [
    `# Bench run ${stamp}`,
    '',
    `- Client: ${opts.client}${opts.model ? `, model ${opts.model}` : ''}${opts.effort ? `, effort ${opts.effort}` : ''}; app: ${opts.dev ? 'dev renderer' : 'built'}; commit ${gitState()}`,
    `- Times are seconds from the prompt. "agent" is the sum of gaps between tool calls (model time); "tool" is the sum of tool durations. "words" are words written on the board; "chat words" are the words of the agent's final reply.`,
    `- Look ratio: area of the learner's new ink ÷ area of the tightest screenshot that holds all of it (1.0 = a perfect crop; - = no screenshot held it).`,
    `- tokens k: the client's token usage in thousands, input/cached input/output (Codex only; Claude reports cost instead).`,
    '',
    '| Scenario | wall | 1st write | 1st shot | calls | shots | image KB | agent | tool | words | chat words | new frames | look ratio | ink seen | ink→look | turns | cost $ | tokens k |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |'
  ]
  const sResults = results.filter((r) => r.kind !== 'perception')
  const pResults = results.filter((r) => r.kind === 'perception')
  for (const r of sResults) {
    const look = r.look
    lines.push(
      `| ${r.scenario} ${r.title} | ${s1(r.wall_ms)} | ${s1(r.first_write_ms)} | ${s1(r.first_screenshot_ms)} | ${r.calls} | ${r.screenshots} | ${(r.image_bytes / 1024).toFixed(0)} | ${s1(r.agent_ms)} | ${s1(r.tool_ms)} | ${r.words} | ${r.chat_words ?? '-'} | ${r.new_top_level} | ${look ? (look.best_ratio === null ? '-' : look.best_ratio.toFixed(2)) : ''} | ${look ? (look.any_contains ? 'all' : look.any_overlap ? 'part' : 'no') : ''} | ${r.ink_to_first_look_ms !== undefined ? s1(r.ink_to_first_look_ms) : ''} | ${r.num_turns ?? '-'} | ${cost(r)} | ${tok(r.tokens)} |`
    )
  }
  if (pResults.length) {
    lines.push(
      '',
      '## Perception scenarios (turn 1: a new connection; V1: the same thread resumed)',
      '',
      '- found: a screenshot held all of the learner\'s new ink. "calls before" / "to shot": tool calls and seconds before the first such screenshot. "1st get_changes": whether the first get_changes call listed all the new learner items (part = some; "since N" = the agent passed its own since, so the cursor was not used).',
      '',
      '- board: the content bounds of the whole board (board points); ink share: the new ink\'s area ÷ the content area (a whole-board screenshot has a look ratio near this).',
      '',
      '| Scenario | found | look ratio | ink share | board | shots | calls before | to shot | 1st get_changes | checks | chat words | wall | agent | cost $ | tokens k |',
      '| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |'
    )
    for (const r of pResults) {
      const checks = r.checks.map((c) => `${c.name}${c.soft ? ' (soft)' : ''}: ${c.pass ? 'pass' : 'FAIL'}`).join('; ')
      lines.push(
        `| ${r.scenario} ${r.title} | ${r.found ? 'yes' : 'no'} | ${r.look.best_ratio === null ? '-' : r.look.best_ratio.toFixed(2)} | ${r.ink_share === null ? '-' : r.ink_share.toFixed(4)} | ${r.content_bounds ? `${Math.round(r.content_bounds.width)}×${Math.round(r.content_bounds.height)}` : '-'} | ${r.screenshots} | ${r.calls_before_ink_shot ?? '-'} | ${s1(r.ink_shot_ms)} | ${r.first_get_changes} | ${checks} | ${r.chat_words} | ${s1(r.wall_ms)} | ${s1(r.agent_ms)} | ${cost(r)} | ${tok(r.tokens)} |`
      )
    }
  }
  for (const r of results) {
    lines.push('', `## ${r.scenario} — ${r.title}`, '', `Prompt: ${r.prompt}`, '')
    if (r.exit_code !== 0 || r.is_error) lines.push(`**Agent exit code ${r.exit_code}${r.is_error ? ', error result' : ''}.**`, '')
    if (r.client_errors) lines.push(`Client errors: ${r.client_errors.join(' | ')}`, '')
    if (r.client_failed_tool_calls?.length) lines.push(`**Tool calls the client failed (not in the trace): ${r.client_failed_tool_calls.join(' | ')}**`, '')
    if (r.brief_loaded !== undefined) lines.push(`Brief (AGENTS.md) in context: ${r.brief_loaded === null ? 'unknown' : r.brief_loaded ? 'yes' : 'no'}${r.resumed ? ' (resumed thread)' : ''}`, '')
    if (r.news_hook !== undefined) lines.push(`Board news hook: ${r.news_hook ? (r.news_in_prompt ? `in the prompt: "${r.news_in_prompt}"` : r.news_in_prompt === null ? 'on (rollout missing)' : 'on, no news') : 'off'}`, '')
    if (r.continuation) {
      const t0 = r.turn0
      lines.push(
        `Turn 0 (lesson, "${t0.prompt}"): ${s1(t0.wall_ms)} s, ${t0.calls} calls, first write ${s1(t0.first_write_ms)} s, ${t0.words} words on the board. Tools: ${Object.entries(t0.per_tool).map(([tool, e]) => `${tool} ×${e.calls}`).join(', ') || 'none'}`,
        ''
      )
      lines.push(`Turn 1 (same thread${r.resumed ? ', resumed' : ''}):`, '')
    }
    lines.push(`Tools: ${Object.entries(r.per_tool).map(([tool, e]) => `${tool} ×${e.calls}`).join(', ') || 'none'}`, '')
    if (r.look) {
      lines.push(`Learner ink: ${rectText(r.look.ink_bounds)}`)
      for (const shot of r.look.screenshots) lines.push(`- screenshot ${shot.request} → ${rectText(shot.rect)}: ratio ${shot.ratio === null ? '-' : shot.ratio.toFixed(3)}, ink covered ${(shot.coverage * 100).toFixed(0)}%`)
      lines.push('')
    }
    const reply = (r.reply ?? '').trim()
    lines.push('Reply:', '', ...reply.split('\n').map((l) => `> ${l}`))
  }
  return `${lines.join('\n')}\n`
}

// ---------- Main ----------

async function main() {
  validate()
  if (opts.client === 'codex') prepareCodexHome(agentOf(opts.model, opts.effort), { mcpPort: opts.mcpPort })
  mkdirSync(opts.out, { recursive: true })
  log(`out: ${opts.out}`)
  const results = []
  const newWork = (id) => {
    const dir = join(opts.out, 'work', id)
    const work = { dir, folder: join(dir, 'folder'), home: join(dir, 'home'), userData: join(dir, 'user-data'), traces: join(dir, 'traces') }
    for (const path of [work.home, work.userData, work.traces]) mkdirSync(path, { recursive: true })
    setupFolder(work.folder)
    return work
  }
  for (const conv of CONVERSATIONS) {
    const scenarios = conv.scenarios.filter((s) => opts.scenarios.includes(s.id))
    if (!scenarios.length) continue
    const work = newWork(conv.id)
    const app = await startApp(work)
    try {
      for (const scenario of scenarios) {
        try {
          results.push(await runScenario(scenario, work))
        } catch (error) {
          log(`${scenario.id} failed: ${error instanceof Error ? error.message : String(error)}`)
          break // a follow-up makes no sense without its first turn
        }
      }
    } finally {
      await stopApp(app)
    }
  }
  for (const p of PERCEPTION.filter((p) => opts.scenarios.includes(p.id))) {
    const work = newWork(p.id)
    const app = await startApp(work)
    try {
      results.push(await runPerception(p, work))
    } catch (error) {
      log(`${p.id} failed: ${error instanceof Error ? error.stack : String(error)}`)
    } finally {
      await stopApp(app)
    }
  }
  writeFileSync(join(opts.out, 'results.json'), JSON.stringify({ options: opts, pids, results }, null, 2))
  writeFileSync(join(opts.out, 'summary.md'), summary(results))
  log(`wrote ${join(opts.out, 'summary.md')}`)
  log(`PIDs started: ${pids.started.map((p) => `${p.pid} (${p.what})`).join(', ')}`)
  log(`PIDs stopped by the runner: ${pids.stopped.join(', ') || 'none'}`)
}

main().catch((error) => {
  console.error(`bench: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
