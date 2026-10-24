#!/usr/bin/env node
/**
 * The agent bench: run the fixed scenarios (scenarios.mjs) with a real agent
 * client against an own Learning Space instance, and write the measurements.
 * This is a measurement, not a test: nothing passes or fails.
 *
 *   node scripts/bench/run.mjs [--scenarios S1,S2,S3,S4] [--model opus] [--client claude|codex]
 *                              [--out <dir>] [--dev] [--mcp-port 47870] [--debug-port 9470]
 *                              [--timeout-min 15]
 *
 * Per conversation (S1+S2, S3+S4) it makes a scratch learning folder from
 * resources/learning-folder/, starts the app on it (built app from out/, or
 * `electron-vite dev` with --dev) with HOME, --user-data-dir and
 * SPACE_TRACE_DIR in the run folder, draws the learner's strokes with
 * scripts/drive.mjs, runs the agent headless from inside the folder
 * (`claude -p`, follow-ups with --continue), and saves per scenario: the
 * session trace and its images, the trace report, the agent's reply, the final
 * window and whole-board screenshots, and metrics.json. All scenarios go into
 * results.json and summary.md in --out.
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
import { ALL_SCENARIOS, CONVERSATIONS } from './scenarios.mjs'
import { analyzeFile, readJsonl, totalOf, rectText, LOOK_TOOLS } from '../trace-report.mjs'

const SPACE = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DRIVE = join(SPACE, 'scripts/drive.mjs')
const TEMPLATE = join(SPACE, 'resources/learning-folder')
const CODEX_HOME = '/private/tmp/claude-501/ls-bench/codex-home'

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
  scenarios: option('--scenarios', ALL_SCENARIOS.join(','))
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  client: option('--client', 'claude'),
  model: option('--model', null),
  out: resolve(option('--out', `/private/tmp/claude-501/ls-bench/runs/${stamp}`)),
  dev: flag('--dev'),
  mcpPort: Number(option('--mcp-port', '47870')),
  debugPort: Number(option('--debug-port', '9470')),
  timeoutMs: Number(option('--timeout-min', '15')) * 60_000
}
if (opts.client === 'claude' && !opts.model) opts.model = 'opus'

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
  const placeholder = '<!-- learning-space brief: placeholder (the app puts the brief here at setup) -->'
  if (!template.includes(placeholder)) throw new Error('The AGENTS.md template has no brief placeholder.')
  const sha = createHash('sha256').update('').digest('hex').slice(0, 12)
  const block = `<!-- learning-space brief: start (managed by the Learning Space app; edits here stop its updates) sha=${sha} -->\n<!-- learning-space brief: end -->`
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
    SPACE_TRACE_DIR: work.traces
  }
  delete env.ELECTRON_RUN_AS_NODE
  const logFd = openSync(join(work.dir, 'app.log'), 'a')
  let child
  if (opts.dev) {
    child = spawn(join(SPACE, 'node_modules/.bin/electron-vite'), ['dev', '--', `--user-data-dir=${work.userData}`], { cwd: SPACE, env, stdio: ['ignore', logFd, logFd] })
  } else {
    const electron = createRequire(join(SPACE, 'package.json'))('electron')
    child = spawn(electron, [`--user-data-dir=${work.userData}`, '.'], { cwd: SPACE, env, stdio: ['ignore', logFd, logFd] })
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
  try {
    execFileSync('osascript', ['-e', 'tell application "Claude" to activate'], { stdio: 'ignore' })
  } catch {
    // Not on the founder's Mac, or Claude is not running.
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

function runProcess(command, args, { cwd, env, stdoutFile, stderrFile }) {
  return new Promise((done) => {
    const out = openSync(stdoutFile, 'w')
    const err = openSync(stderrFile, 'w')
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', out, err] })
    pids.started.push({ pid: child.pid, what: `${basename(command)} agent` })
    const timer = setTimeout(() => {
      log(`agent timed out after ${opts.timeoutMs / 60000} min; stopping PID ${child.pid}`)
      child.kill('SIGTERM')
      pids.stopped.push(child.pid)
    }, opts.timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      closeSync(out)
      closeSync(err)
      done(code)
    })
  })
}

async function runAgent(scenario, work, dir) {
  const mcpUrl = `http://127.0.0.1:${opts.mcpPort}/mcp`
  const stdoutFile = join(dir, 'agent-stdout.txt')
  const stderrFile = join(dir, 'agent-stderr.txt')
  if (opts.client === 'claude') {
    const config = join(work.dir, 'mcp.json')
    writeFileSync(config, JSON.stringify({ mcpServers: { 'learning-space': { type: 'http', url: mcpUrl } } }, null, 2))
    // The prompt goes before --allowedTools: that flag takes every word after it.
    const args = ['-p', scenario.prompt, ...(scenario.followUp ? ['--continue'] : []), '--model', opts.model, '--mcp-config', config, '--strict-mcp-config', '--setting-sources', 'project,local', '--output-format', 'json', '--allowedTools', 'mcp__learning-space__*']
    const code = await runProcess('claude', args, { cwd: work.folder, env: process.env, stdoutFile, stderrFile })
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(stdoutFile, 'utf8'))
    } catch {
      // Not JSON (a crash or a timeout): keep the raw text.
    }
    return {
      exit_code: code,
      reply: parsed?.result ?? readFileSync(stdoutFile, 'utf8'),
      is_error: parsed ? Boolean(parsed.is_error) : true,
      cost_usd: parsed?.total_cost_usd ?? null,
      num_turns: parsed?.num_turns ?? null,
      client_duration_ms: parsed?.duration_ms ?? null
    }
  }
  // Codex: a scratch CODEX_HOME so the founder's config (and its learning-space entry) stays out.
  if (!existsSync(join(CODEX_HOME, 'auth.json'))) {
    throw new Error(`Codex needs a login in the scratch CODEX_HOME. Run once: CODEX_HOME=${CODEX_HOME} codex login`)
  }
  writeFileSync(
    join(CODEX_HOME, 'config.toml'),
    `approval_policy = "never"\nsandbox_mode = "read-only"\n${opts.model ? `model = ${JSON.stringify(opts.model)}\n` : ''}\n[mcp_servers.learning-space]\nurl = ${JSON.stringify(mcpUrl)}\n`
  )
  const lastMessage = join(dir, 'reply.txt')
  const args = scenario.followUp
    ? ['exec', 'resume', '--last', '--skip-git-repo-check', '--output-last-message', lastMessage, scenario.prompt]
    : ['exec', '--skip-git-repo-check', '--output-last-message', lastMessage, scenario.prompt]
  const code = await runProcess('codex', args, { cwd: work.folder, env: { ...process.env, CODEX_HOME }, stdoutFile, stderrFile })
  return {
    exit_code: code,
    reply: existsSync(lastMessage) ? readFileSync(lastMessage, 'utf8') : '',
    is_error: code !== 0,
    cost_usd: null,
    num_turns: null,
    client_duration_ms: null
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

/** A picture of the whole board through MCP, as the bench client (trace-report skips its session). */
async function contentScreenshot(file) {
  const require = createRequire(join(SPACE, 'package.json'))
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
  const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
  const client = new Client({ name: 'ls-bench', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${opts.mcpPort}/mcp`))
  await client.connect(transport)
  try {
    const result = await client.callTool({ name: 'get_screenshot', arguments: { target: 'content', max_size: 2400 } })
    const image = result.content?.find((part) => part.type === 'image')
    if (image) writeFileSync(file, Buffer.from(image.data, 'base64'))
    return Boolean(image)
  } finally {
    await transport.terminateSession().catch(() => undefined)
    await client.close().catch(() => undefined)
  }
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

// ---------- Summary ----------

/** Words in the agent's final chat reply. */
function wordCount(text) {
  return typeof text === 'string' ? text.split(/\s+/).filter(Boolean).length : 0
}

const s1 = (v) => (v === null || v === undefined ? '-' : (v / 1000).toFixed(1))

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
    `- Client: ${opts.client}${opts.model ? `, model ${opts.model}` : ''}; app: ${opts.dev ? 'dev renderer' : 'built'}; commit ${gitState()}`,
    `- Times are seconds from the prompt. "agent" is the sum of gaps between tool calls (model time); "tool" is the sum of tool durations. "words" are words written on the board; "chat words" are the words of the agent's final reply.`,
    `- Look ratio: area of the learner's new ink ÷ area of the tightest screenshot that holds all of it (1.0 = a perfect crop; - = no screenshot held it).`,
    '',
    '| Scenario | wall | 1st write | 1st shot | calls | shots | image KB | agent | tool | words | chat words | new frames | look ratio | ink seen | ink→look | turns | cost $ |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |'
  ]
  for (const r of results) {
    const look = r.look
    lines.push(
      `| ${r.scenario} ${r.title} | ${s1(r.wall_ms)} | ${s1(r.first_write_ms)} | ${s1(r.first_screenshot_ms)} | ${r.calls} | ${r.screenshots} | ${(r.image_bytes / 1024).toFixed(0)} | ${s1(r.agent_ms)} | ${s1(r.tool_ms)} | ${r.words} | ${r.chat_words ?? '-'} | ${r.new_top_level} | ${look ? (look.best_ratio === null ? '-' : look.best_ratio.toFixed(2)) : ''} | ${look ? (look.any_contains ? 'all' : look.any_overlap ? 'part' : 'no') : ''} | ${r.ink_to_first_look_ms !== undefined ? s1(r.ink_to_first_look_ms) : ''} | ${r.num_turns ?? '-'} | ${r.cost_usd === null || r.cost_usd === undefined ? '-' : r.cost_usd.toFixed(3)} |`
    )
  }
  for (const r of results) {
    lines.push('', `## ${r.scenario} — ${r.title}`, '', `Prompt: ${r.prompt}`, '')
    if (r.exit_code !== 0 || r.is_error) lines.push(`**Agent exit code ${r.exit_code}${r.is_error ? ', error result' : ''}.**`, '')
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
  mkdirSync(opts.out, { recursive: true })
  log(`out: ${opts.out}`)
  const results = []
  for (const conv of CONVERSATIONS) {
    const scenarios = conv.scenarios.filter((s) => opts.scenarios.includes(s.id))
    if (!scenarios.length) continue
    const dir = join(opts.out, 'work', conv.id)
    const work = { dir, folder: join(dir, 'folder'), home: join(dir, 'home'), userData: join(dir, 'user-data'), traces: join(dir, 'traces') }
    for (const path of [work.home, work.userData, work.traces]) mkdirSync(path, { recursive: true })
    setupFolder(work.folder)
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
