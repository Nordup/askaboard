/**
 * Shared parts of the live-drawing lab: the scratch app instance, the MCP
 * client, CDP (screenshots, screencast, the dev hook), video and filmstrip.
 *
 * Copied in part from scripts/bench/run.mjs and scripts/drive.mjs. Never
 * import run.mjs: importing it starts a real bench.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findAppPage } from '../app-page.mjs'

export const LAB = dirname(fileURLToPath(import.meta.url))
export const SPACE = resolve(LAB, '../..')
export const DRIVE = join(SPACE, 'scripts/drive.mjs')
export const TEMPLATE = join(SPACE, 'resources/learning-folder')
/**
 * The scratch root of the lab, the bench and perf runs: /tmp/claude-<uid>, with /tmp as its
 * real path (/private/tmp on macOS, so the Mac path stays /private/tmp/claude-501). The real
 * path matters: an orphan app is found by its --user-data-dir in the command line.
 * LS_SCRATCH_ROOT sets another root.
 */
export const SCRATCH_ROOT = process.env.LS_SCRATCH_ROOT ? resolve(process.env.LS_SCRATCH_ROOT) : join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', `claude-${process.getuid?.() ?? 'user'}`)
export const SCRATCH = join(SCRATCH_ROOT, 'ls-lab')
export const RUNS = join(SPACE, '.lab/runs')
export const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
export const FOUNDER_PORT = 47821
/** Tools that change the board. The first one is the first visible mark. */
// play_scene (start, cut, clear_queue) writes since 2026-10-26, run_scene from stage 4 to then; the others are in traces from before.
export const WRITE_TOOLS = new Set(['play_scene', 'run_scene', 'create_frame', 'write_html', 'update_styles', 'set_text', 'move_nodes', 'duplicate_nodes', 'delete_nodes', 'draw_ink'])
/** The play_scene actions that change the board. */
export const PLAY_WRITES = new Set(['start', 'cut', 'clear_queue'])
/** A call that changed the board: a write tool, except a run_scene preview (it draws nothing) and play_scene's other actions. */
export const isWrite = (c) => WRITE_TOOLS.has(c.tool) && !(c.tool === 'run_scene' && c.args?.preview) && !(c.tool === 'play_scene' && !PLAY_WRITES.has(c.args?.action))
/** A scene program the model wrote: write_scene, or run_scene in traces from before 2026-10-26. */
export const isProgram = (c) => c.tool === 'write_scene' || c.tool === 'run_scene'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (tag, ...parts) => console.log(`[${tag} ${new Date().toISOString().slice(11, 19)}]`, ...parts)

// ---------- Arguments ----------

export function args(argv = process.argv.slice(2)) {
  const option = (name, fallback = null) => {
    const i = argv.indexOf(name)
    if (i === -1) return fallback
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
    return value
  }
  const flag = (name) => argv.includes(name)
  // Words that are not options or option values.
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !BOOLEAN_FLAGS.has(argv[i])) i++
      continue
    }
    positional.push(argv[i])
  }
  return { option, flag, positional }
}
const BOOLEAN_FLAGS = new Set(['--video', '--profile', '--no-pan', '--built', '--dev', '--fresh', '--no-crop', '--no-news-hook', '--no-gallery', '--keep-app', '--interview', '--wait-media', '--brief-only', '--no-web'])

// ---------- Processes ----------

export function portInUse(port) {
  return new Promise((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })
}

export function childPids(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .map(Number)
      .filter(Boolean)
  } catch {
    return []
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** SIGTERM each exact PID, wait, SIGKILL only that PID if it stays. */
export async function stopPids(pids) {
  const stopped = []
  for (const pid of pids) {
    if (!pid || !alive(pid)) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      continue
    }
    const deadline = Date.now() + 10_000
    while (alive(pid) && Date.now() < deadline) await sleep(200)
    if (alive(pid)) process.kill(pid, 'SIGKILL')
    stopped.push(pid)
  }
  return stopped
}

// ---------- The lab instance ----------

/** Paths of a named lab instance. */
export function instance(name) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Bad instance name "${name}"`)
  const dir = join(SCRATCH, name)
  return { name, dir, home: join(dir, 'home'), userData: join(dir, 'user-data'), folder: join(dir, 'folder'), traces: join(dir, 'traces'), log: join(dir, 'app.log'), stateFile: join(dir, 'state.json') }
}

export function readState(name) {
  const inst = instance(name)
  if (!existsSync(inst.stateFile)) return null
  return JSON.parse(readFileSync(inst.stateFile, 'utf8'))
}

/** The state of a running instance, or an error that says how to start it. */
export function requireState(name) {
  const state = readState(name)
  if (!state || !state.pids.some(alive)) throw new Error(`The lab "${name}" is not running. Start it: node scripts/lab/lab.mjs start${name === 'lab' ? '' : ` --name ${name}`}`)
  return state
}

/** The AGENTS.md template with an empty brief block; the app fills it when it opens the folder. */
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

/**
 * Start a lab app: scratch HOME, user-data-dir, learning folder and traces under
 * SCRATCH/<name>/. Detached, so it outlives the script; the state file holds the
 * exact PIDs to stop. fresh: start from an empty folder and board. spawnOnly: return
 * right after the spawn, with the clock of the spawn in `spawnedAt`: the caller times the start.
 */
export async function startInstance({ name, mcpPort, debugPort, built = false, fresh = false, spawnOnly = false }) {
  if (mcpPort === FOUNDER_PORT) throw new Error(`Port ${FOUNDER_PORT} is the founder's app. Pick another.`)
  const inst = instance(name)
  const running = readState(name)
  if (running?.owner && running.owner !== process.pid && alive(running.owner)) throw new Error(`The lab "${name}" is in use by PID ${running.owner}. Stop it first.`)
  // A run that died left its app: it must not block the next run.
  if (running) {
    const pids = await stopInstance(name)
    if (pids.length) console.error(`lab: stopped the app of a dead run (PIDs ${pids.join(', ')})`)
  }
  for (const port of [mcpPort, debugPort]) await stopOrphan(port, inst)
  for (const port of [mcpPort, debugPort]) if (await portInUse(port)) throw new Error(`Port ${port} is in use by another process. Pick free ports with --mcp-port / --debug-port.`)
  if (!built && !existsSync(join(SPACE, 'node_modules/.bin/electron-vite'))) throw new Error('No node_modules in space/. Run npm install there.')
  if (built && !existsSync(join(SPACE, 'out/main/index.js'))) throw new Error('No built app in out/. Run `npm run build` in space/ first.')
  if (fresh && existsSync(inst.dir)) rmSync(inst.dir, { recursive: true, force: true })
  for (const path of [inst.home, inst.userData, inst.traces]) mkdirSync(path, { recursive: true })
  if (!existsSync(join(inst.folder, 'AGENTS.md'))) setupFolder(inst.folder)

  const env = { ...process.env, HOME: inst.home, SPACE_FOLDER: inst.folder, SPACE_MCP_PORT: String(mcpPort), SPACE_REMOTE_DEBUG: String(debugPort), SPACE_TRACE_DIR: inst.traces, SPACE_NO_FOCUS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const logFd = openSync(inst.log, 'a')
  const spawnedAt = Date.now()
  let child
  if (!built) {
    child = spawn(join(SPACE, 'node_modules/.bin/electron-vite'), ['dev', '--', `--user-data-dir=${inst.userData}`, ...displaySwitches(env)], { cwd: SPACE, env, stdio: ['ignore', logFd, logFd], detached: true })
  } else {
    const electron = createRequire(join(SPACE, 'package.json'))('electron')
    child = spawn(electron, [`--user-data-dir=${inst.userData}`, ...displaySwitches(env), '.'], { cwd: SPACE, env, stdio: ['ignore', logFd, logFd], detached: true })
  }
  closeSync(logFd)
  child.unref()
  const state = { name, mode: built ? 'built' : 'dev', mcpPort, debugPort, pids: [child.pid], launcher: child.pid, owner: process.pid, started: new Date().toISOString(), ...inst }
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2))
  if (spawnOnly) return { ...state, spawnedAt }
  try {
    const deadline = Date.now() + 120_000
    while (!(await portInUse(mcpPort))) {
      if (Date.now() > deadline || !alive(child.pid)) throw new Error(`The app did not open MCP port ${mcpPort}; see ${inst.log}`)
      await sleep(500)
    }
    for (;;) {
      try {
        const s = JSON.parse(drive(debugPort, 'eval-state'))
        if (s.board) break
      } catch {
        // Still loading.
      }
      if (Date.now() > deadline) throw new Error(`The app did not open a board; see ${inst.log}`)
      await sleep(500)
    }
    // Dev: electron-vite (node) starts Electron as its child. Stop the child first.
    if (!built) state.pids = [...childPids(child.pid), child.pid]
    writeFileSync(inst.stateFile, JSON.stringify(state, null, 2))
  } catch (error) {
    await stopInstance(name)
    throw error
  }
  return state
}

/**
 * The display switches of every app instance that the lab, bench and perf scripts start.
 * GNOME Wayland sends a covered window no frame callbacks, so requestAnimationFrame stops in a
 * check instance behind other windows (no frames recorded, scenes never end); under XWayland
 * it runs on. LS_NATIVE_WAYLAND=1 keeps native Wayland, for runs that test Wayland itself.
 */
export function displaySwitches(env = process.env) {
  return process.platform === 'linux' && env.WAYLAND_DISPLAY && env.DISPLAY && env.LS_NATIVE_WAYLAND !== '1' ? ['--ozone-platform=x11'] : []
}

/** The PIDs that listen on a TCP port: from lsof, or from ss (iproute2) where there is no lsof. */
function portHolders(port) {
  try {
    return execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean)
  } catch (error) {
    // lsof exits 1 when nothing listens.
    if (error.code !== 'ENOENT') return []
  }
  try {
    const out = execFileSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8' })
    return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))]
  } catch {
    return []
  }
}

/** An app of this instance that holds a port with no state file: found by its user-data-dir, so it is never another app. */
async function stopOrphan(port, inst) {
  const holders = portHolders(port)
  const command = (pid) => {
    try {
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    } catch {
      return ''
    }
  }
  const parent = (pid) => {
    try {
      return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }))
    } catch {
      return 0
    }
  }
  for (const pid of holders) {
    if (!command(pid).includes(inst.userData)) continue
    const launcher = parent(pid)
    const pids = [pid, ...(launcher > 1 && command(launcher).includes(inst.userData) ? [launcher] : [])]
    console.error(`lab: stopped an orphan app on port ${port} (PIDs ${(await stopPids(pids)).join(', ')})`)
  }
}

/**
 * A run that ends in any way stops its app, and an end that is not the normal one
 * says so and exits 1: a promise that never settles, a signal, an uncaught error.
 * Returns done(), to call when the run is over.
 */
export function guardRun(name, label) {
  let over = false
  const end = async (why) => {
    if (over) return
    over = true
    console.error(`${label}: ${why}; stopping the app`)
    await stopInstance(name).catch((error) => console.error(`${label}: stop failed: ${error.message}`))
    process.exit(1)
  }
  process.on('beforeExit', () => void end('the event loop ran out before the run ended'))
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void end(`${signal}`))
  return () => {
    over = true
  }
}

/**
 * The lid is closed and that puts the machine to sleep: a run measures nothing then.
 * macOS: ioreg. Linux: the ACPI lid state, and logind's lid action that applies now
 * (docked, then on external power, then the plain one). Without busctl: sleep unless an
 * external display is connected (logind's defaults).
 */
export function lidSleeps() {
  if (process.platform === 'linux') {
    const closed = readdirSafe('/proc/acpi/button/lid').some((lid) => /closed/.test(readSafe(join('/proc/acpi/button/lid', lid, 'state'))))
    const logind = lidSettings()
    if (logind) {
      const action = logind.Docked ? logind.HandleLidSwitchDocked : logind.OnExternalPower && logind.HandleLidSwitchExternalPower ? logind.HandleLidSwitchExternalPower : logind.HandleLidSwitch
      return closed && ['suspend', 'hibernate', 'hybrid-sleep', 'suspend-then-hibernate'].includes(action)
    }
    const docked = readdirSafe('/sys/class/drm').some((name) => /^card\d+-/.test(name) && !/-(eDP|LVDS|DSI)-/.test(name) && readSafe(join('/sys/class/drm', name, 'status')).trim() === 'connected')
    return closed && !docked
  }
  try {
    const out = execFileSync('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], { encoding: 'utf8' })
    return /"AppleClamshellState" = Yes/.test(out) && /"AppleClamshellCausesSleep" = Yes/.test(out)
  } catch {
    return false
  }
}

/** Linux: logind's lid settings over D-Bus, or null without busctl. An empty HandleLidSwitchExternalPower means HandleLidSwitch. */
export function lidSettings() {
  const names = ['HandleLidSwitch', 'HandleLidSwitchExternalPower', 'HandleLidSwitchDocked', 'Docked', 'OnExternalPower']
  try {
    const out = execFileSync('busctl', ['get-property', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', ...names], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    const values = out.trim().split('\n').map((line) => {
      const [, type, raw] = /^(\w)\s+(.*)$/.exec(line.trim()) ?? []
      return type === 'b' ? raw === 'true' : type === 's' ? JSON.parse(raw) : undefined
    })
    if (values.length !== names.length || values.includes(undefined)) return null
    return Object.fromEntries(names.map((name, i) => [name, values[i]]))
  } catch {
    return null
  }
}

function readSafe(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function readdirSafe(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Keep the machine from idle sleep while this process lives. macOS: caffeinate. Linux: a
 * systemd-inhibit lock held by a `tail --pid` that ends with this process. A closed lid
 * still sleeps on a Mac: sleptSeconds tells.
 */
export function stayAwake() {
  const [command, argv] =
    process.platform === 'linux'
      ? ['systemd-inhibit', ['--what=idle:sleep', '--who=learning-space-scripts', '--why=A lab, bench or perf run measures', '--mode=block', 'tail', `--pid=${process.pid}`, '-f', '/dev/null']]
      : ['caffeinate', ['-i', '-m', '-s', '-w', String(process.pid)]]
  try {
    const child = spawn(command, argv, { stdio: 'ignore', detached: true })
    // A missing command arrives as an event, not a throw.
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // No such command here.
  }
}

/** Seconds the machine was asleep or in dark wake between two times (ms), from the macOS power log; null when unknown (always on Linux). */
export function sleptSeconds(from, to) {
  if (process.platform !== 'darwin') return null
  let log
  try {
    log = execFileSync('pmset', ['-g', 'log'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  } catch {
    return null
  }
  const events = []
  for (const line of log.split('\n')) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}) (Sleep|Wake|DarkWake)\s\s+/.exec(line)
    if (m) events.push({ t: Date.parse(m[1].replace(' ', 'T').replace(' ', '')), state: m[2] })
  }
  let slept = 0
  for (let i = 0; i < events.length; i++) {
    if (events[i].state === 'Wake') continue
    const lo = Math.max(events[i].t, from)
    const hi = Math.min(events[i + 1]?.t ?? to, to)
    if (hi > lo) slept += hi - lo
  }
  return Math.round(slept / 1000)
}

/** Stop the exact PIDs in the instance's state file (and the dev child, if it changed). */
export async function stopInstance(name) {
  const state = readState(name)
  if (!state) return []
  const pids = [...new Set([...(state.mode === 'dev' ? childPids(state.launcher) : []), ...state.pids])]
  const stopped = await stopPids(pids)
  const deadline = Date.now() + 10_000
  while ((await portInUse(state.mcpPort)) && Date.now() < deadline) await sleep(300)
  rmSync(state.stateFile, { force: true })
  return stopped
}

export function drive(debugPort, ...rest) {
  return execFileSync(process.execPath, [DRIVE, '--port', String(debugPort), ...rest], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
}

// ---------- MCP ----------

/** Run fn(call) on a new MCP connection as client "ls-lab". call(name, args) returns the raw result. */
export async function withMcp(mcpPort, fn) {
  const require = createRequire(join(SPACE, 'package.json'))
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
  const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))
  const client = new Client({ name: 'ls-lab', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`))
  await client.connect(transport)
  try {
    return await fn((name, a) => client.callTool({ name, arguments: a }, undefined, { timeout: 300_000 }), client)
  } finally {
    await transport.terminateSession().catch(() => undefined)
    await client.close().catch(() => undefined)
  }
}

export const resultText = (result) => result?.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? ''

// ---------- CDP ----------

/** Attach to the app page (not the hidden snapshot window), or to the target at socketUrl. Events go to on(method, params). */
export async function cdpConnect(port, socketUrl = null) {
  // The board window by its URL; a loading stage page (empty URL) is never picked.
  const page = socketUrl ? { webSocketDebuggerUrl: socketUrl } : await findAppPage(port)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    socket.onopen = ok
    socket.onerror = () => fail(new Error(`Could not attach to the page on port ${port}.`))
  })
  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  // A call on a dead socket must fail. A promise that never settles lets node exit with code 0, and no finally runs.
  const failAll = (why) => {
    for (const entry of pending.values()) entry.reject(new Error(`${entry.method}: ${why}`))
    pending.clear()
  }
  socket.onclose = () => failAll('the debug socket closed')
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id === undefined) {
      for (const fn of listeners) fn(data.method, data.params, data.sessionId)
      return
    }
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.error) entry.reject(new Error(`${entry.method}: ${data.error.message}`))
    else entry.resolve(data.result)
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      if (socket.readyState !== WebSocket.OPEN) {
        fail(new Error(`${method}: the debug socket is closed`))
        return
      }
      const id = ++nextId
      pending.set(id, { resolve: ok, reject: fail, method })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  const screenshot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(data, 'base64'))
  }
  return { send, evaluate, screenshot, on: (fn) => listeners.add(fn), close: () => socket.close() }
}

/**
 * Record the page with Page.startScreencast. Frames go to dir as JPEG files;
 * each has its wall-clock time (ms). Chromium sends a frame only when the page
 * changes, so a still board gives few frames. stop() returns the frame list.
 */
export async function startRecording(cdp, dir) {
  mkdirSync(dir, { recursive: true })
  const frames = []
  let n = 0
  cdp.on((method, params) => {
    if (method !== 'Page.screencastFrame') return
    const file = join(dir, `f${String(++n).padStart(6, '0')}.jpg`)
    writeFileSync(file, Buffer.from(params.data, 'base64'))
    const ts = params.metadata?.timestamp ? params.metadata.timestamp * 1000 : Date.now()
    frames.push({ file, t: ts, w: params.metadata?.deviceWidth, h: params.metadata?.deviceHeight })
    cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 })
  const started = Date.now()
  return {
    started,
    frames,
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => undefined)
      await sleep(150)
      return frames.sort((a, b) => a.t - b.t)
    }
  }
}

/** The canvas rect in CSS pixels, from the dev hook (null when unknown). */
export async function canvasRect(cdp) {
  try {
    return await cdp.evaluate('window.__spaceDev && window.__spaceDev.canvasRect()')
  } catch {
    return null
  }
}

/** The scene dev hook ({ playing, current, time, duration, paused, hasSeek }) or null when the app has none. */
export async function sceneHook(cdp) {
  try {
    return await cdp.evaluate('(() => { const s = window.__spaceDev && window.__spaceDev.scene; if (!s) return null; const v = typeof s === "function" ? s() : s; return { playing: Boolean(v.playing), current: v.current ?? null, name: v.name ?? null, time: v.time ?? null, duration: v.duration ?? null, paused: Boolean(v.paused), hasSeek: typeof v.seek === "function" } })()')
  } catch {
    return null
  }
}

export async function sceneSeek(cdp, t) {
  return cdp.evaluate(`(async () => { const s = window.__spaceDev.scene; const v = typeof s === "function" ? s() : s; await v.seek(${Number(t)}); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return true })()`)
}

// ---------- Video and filmstrip ----------

function imageSize(file) {
  const out = execFileSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  const [w, h] = out.trim().split(',').map(Number)
  return { w, h }
}

/**
 * The ffmpeg crop filter for a CSS-pixel rect on frames of a page whose CSS size is
 * cssW (the image may be scaled by the device pixel ratio). '' when no crop.
 */
export function cropFilter(frameFile, rect, cssW) {
  if (!rect || !cssW) return ''
  const { w, h } = imageSize(frameFile)
  const k = w / cssW
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2)
  const x = Math.max(0, Math.round(rect.x * k))
  const y = Math.max(0, Math.round(rect.y * k))
  const cw = even(Math.min(w - x, rect.width * k))
  const ch = even(Math.min(h - y, rect.height * k))
  return `crop=${cw}:${ch}:${x}:${y}`
}

/**
 * Encode frames (with wall times) into an H.264 MP4 at real speed: each frame
 * shows until the next one. from/to (ms) clip the time range; the last frame
 * is held until `to`.
 */
export function encodeVideo(frames, out, { from, to, crop = '', fps = 30 }) {
  const list = frames.filter((f) => f.t <= to)
  if (!list.length) throw new Error('No frames were recorded.')
  // Frames before `from` collapse to the last one before it.
  let startIndex = 0
  for (let i = 0; i < list.length; i++) if (list[i].t <= from) startIndex = i
  const used = list.slice(startIndex)
  const lines = []
  for (let i = 0; i < used.length; i++) {
    const start = Math.max(from, used[i].t)
    const end = i + 1 < used.length ? Math.max(from, used[i + 1].t) : to
    const duration = Math.max(0, (end - start) / 1000)
    if (duration <= 0 && i + 1 < used.length) continue
    // Exact durations: the screencast sends up to 60 frames a second, and padding each to 1/fps
    // stretched the video (content ran slow and the end was cut off by -t). fps=30 resamples.
    lines.push(`file '${used[i].file}'`, `duration ${Math.max(duration, 0.0005).toFixed(4)}`)
  }
  // The concat demuxer ignores the last duration unless the last file is repeated.
  lines.push(`file '${used[used.length - 1].file}'`)
  const listFile = `${out}.concat.txt`
  writeFileSync(listFile, lines.join('\n') + '\n')
  // At most 1280 px wide (phones, level 4.1); TV range yuv420p, as players expect.
  const filters = [crop, "scale='min(1280,trunc(iw/2)*2)':-2:out_range=tv", 'format=yuv420p', `fps=${fps}`].filter(Boolean).join(',')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', filters, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-profile:v', 'high', '-level', '4.1', '-movflags', '+faststart', '-t', ((to - from) / 1000).toFixed(3), out], { stdio: 'pipe' })
  rmSync(listFile, { force: true })
}

/**
 * The watch video: like encodeVideo, but every stretch with no visible change
 * longer than idleMs plays in cutMs, with a label ("38 s  model writing
 * run_scene") and a real-time clock burned in (recut.py, Pillow and one
 * ffmpeg pass). labels: [{from, to, label}] in wall ms (traceLabels); the
 * model's own time ("model writing …", "model thinking", …) is cut even when
 * a live item keeps moving, except while a scene plays (playing: [{from, to}]
 * in wall ms, scenePlaySpans). Returns {watch_s, real_s, cuts}.
 */
export function encodeWatchVideo(frames, out, { from, to, crop = '', labels = [], playing = [], idleMs = 1500, cutMs = 600, fps = 30 }) {
  const m = /^crop=(\d+):(\d+):(\d+):(\d+)$/.exec(crop)
  const spec = join(dirname(out), '.recut.json')
  writeFileSync(spec, JSON.stringify({ frames: frames.map((f) => ({ file: f.file, t: f.t })), from, to, crop: m ? [Number(m[3]), Number(m[4]), Number(m[1]), Number(m[2])] : null, labels, playing, idle_ms: idleMs, cut_ms: cutMs, fps, out, ffmpeg: FFMPEG }))
  try {
    const text = execFileSync('python3', ['-I', join(LAB, 'recut.py'), spec], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    return JSON.parse(text.trim().split('\n').pop())
  } finally {
    rmSync(spec, { force: true })
  }
}

/**
 * When scenes played, from the trace's play_scene start calls (run_scene in
 * traces from before 2026-10-26; wall ms): from the call's end + starts_in_s
 * to its end + ends_in_s, plus a second for a pause the result could not know
 * about. Previews play nothing.
 */
export function scenePlaySpans(calls) {
  const spans = []
  for (const c of calls) {
    const play = (c.tool === 'run_scene' && !c.args?.preview) || (c.tool === 'play_scene' && c.args?.action === 'start')
    if (!play || !c.ok) continue
    try {
      const r = JSON.parse(c.result_text)
      const end = Date.parse(c.end ?? c.t)
      const startsIn = typeof r.starts_in_s === 'number' ? r.starts_in_s : 0
      const endsIn = typeof r.ends_in_s === 'number' ? r.ends_in_s : startsIn + (typeof r.length_s === 'number' ? r.length_s : typeof r.duration_s === 'number' ? r.duration_s : 0)
      // wait "end" (until 2026-10-28): the call returned after the scene played.
      if (r.played !== undefined) spans.push({ from: Date.parse(c.t), to: end + 1000 })
      else spans.push({ from: end + startsIn * 1000, to: end + endsIn * 1000 + 1000 })
    } catch {
      // No result to read.
    }
  }
  return spans
}

/**
 * What happened in each stretch of a session, from its trace calls, for the
 * labels of cut stretches: before the session opened "session starting"; a
 * tool call's own time "<tool> running"; the time before a call (the model
 * generating it) "model writing <tool>" for a write, "model thinking" before a
 * read; after the last call until turnEnd "model answering".
 */
export function traceLabels(calls, { from, opened = null, turnEnd = null }) {
  const labels = []
  if (opened && opened > from) labels.push({ from, to: opened, label: 'session starting' })
  let previous = opened ?? from
  for (const c of [...calls].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))) {
    const start = Date.parse(c.t)
    const end = Date.parse(c.end ?? c.t)
    if (start > previous) labels.push({ from: previous, to: start, label: isWrite(c) || isProgram(c) ? `model writing ${c.tool}` : 'model thinking' })
    if (end > start) labels.push({ from: start, to: end, label: `${c.tool} running` })
    previous = Math.max(previous, end)
  }
  if (turnEnd && turnEnd > previous) labels.push({ from: previous, to: turnEnd, label: 'model answering' })
  return labels
}

/** When the traced session (not the lab's own client) opened, in wall ms, or null. */
export function traceSessionOpen(tracesDir, sinceMs, { skipClient = 'ls-lab' } = {}) {
  let found = null
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl') && entry.name !== 'learner-edits.jsonl') {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          let e
          try {
            e = JSON.parse(line)
          } catch {
            continue
          }
          if (e.type !== 'session_open' || e.client?.name === skipClient) continue
          const t = Date.parse(e.t)
          if (t >= sinceMs && (found === null || t < found)) found = t
        }
      }
    }
  }
  walk(tracesDir)
  return found
}

/** The frame on screen at wall time t (the last frame at or before t). */
export function frameAt(frames, t) {
  let pick = frames[0]
  for (const f of frames) if (f.t <= t) pick = f
  return pick
}

/** Crop (optional) an image into a PNG. */
export function cropImage(input, output, crop) {
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', input, ...(crop ? ['-vf', crop] : []), '-frames:v', '1', output], { stdio: 'pipe' })
}

/** A grid of labelled frames: tiles = [{ file, label }]. Uses Python Pillow (ffmpeg here has no drawtext). */
export function filmstrip(tiles, out, { columns = 4, width = 480 } = {}) {
  const spec = join(dirname(out), '.filmstrip.json')
  writeFileSync(spec, JSON.stringify({ tiles, out, columns, width }))
  try {
    execFileSync('python3', ['-I', join(LAB, 'filmstrip.py'), spec], { stdio: 'pipe' })
  } finally {
    rmSync(spec, { force: true })
  }
}

// ---------- Runs ----------

export function runFolder(slugSource, root = RUNS) {
  const d = new Date()
  const p = (v) => String(v).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const slug =
    String(slugSource || 'run')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'run'
  const dir = join(root, `${stamp}-${slug}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------- Headless agents (council.mjs, perf/run.mjs, bench/run.mjs) ----------
//
// agent: { client, model, effort, newsHook, web, codexHome, timeoutMs, pids, say }.
// pids collects the agent processes; say logs.

function runProcess(agent, command, argv, { cwd, env, stdoutFile, stderrFile }) {
  return new Promise((done) => {
    const out = openSync(stdoutFile, 'w')
    const err = openSync(stderrFile, 'w')
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', out, err] })
    agent.pids.push(child.pid)
    const timer = setTimeout(() => {
      agent.say(`agent timed out after ${agent.timeoutMs / 60000} min; stopping PID ${child.pid}`)
      child.kill('SIGTERM')
    }, agent.timeoutMs)
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

/** Claude: one `claude -p` turn. resume = the session id of phase 1. raw: the parsed JSON output. */
export async function claudeTurn(agent, state, dir, prompt, phase, resume = null) {
  const config = join(state.dir, 'mcp.json')
  writeFileSync(config, JSON.stringify({ mcpServers: { 'learning-space': { type: 'http', url: `http://127.0.0.1:${state.mcpPort}/mcp` } } }, null, 2))
  const hookArgs = []
  if (agent.newsHook) {
    const settings = join(state.dir, 'claude-settings.json')
    writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: newsHookCommand(state)('Claude Code'), timeout: 5 }] }] } }, null, 2))
    hookArgs.push('--settings', settings)
  }
  // As in the desktop app with permissions bypassed: every built-in tool (Bash too), no permission prompts, only the
  // Learning Space server (no MCP servers or plugins of the founder's own setup). --no-web takes the web tools away.
  // The prompt goes before --disallowedTools: that flag takes every word after it.
  const argv = ['-p', prompt, ...(resume ? ['--resume', resume] : []), '--model', agent.model, ...(agent.effort ? ['--effort', agent.effort] : []), '--mcp-config', config, '--strict-mcp-config', '--setting-sources', 'project,local', ...hookArgs, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', ...(agent.web ? [] : ['--disallowedTools', 'WebSearch', 'WebFetch'])]
  const stdoutFile = join(dir, `${phase}-claude.jsonl`)
  const code = await runProcess(agent, 'claude', argv, { cwd: state.folder, env: process.env, stdoutFile, stderrFile: join(dir, `${phase}-stderr.txt`) })
  // One event per line. A crash or a timeout has no result, but its session and its last words are there.
  let parsed = null
  let session = resume
  let lastText = ''
  for (const line of readFileSync(stdoutFile, 'utf8').split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    session = event.session_id ?? session
    // Each turn of a session gives a result (a background task's end starts a turn): add up what is per turn.
    if (event.type === 'result') parsed = { ...event, duration_ms: (parsed?.duration_ms ?? 0) + (event.duration_ms ?? 0), num_turns: (parsed?.num_turns ?? 0) + (event.num_turns ?? 0) }
    if (event.type === 'assistant') lastText = (event.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || lastText
  }
  return {
    exit_code: code,
    reply: parsed?.result ?? lastText,
    is_error: parsed ? Boolean(parsed.is_error) : true,
    session,
    cost_usd: parsed?.total_cost_usd ?? null,
    num_turns: parsed?.num_turns ?? null,
    raw: parsed
  }
}

/** The lab's own CODEX_HOME: auth.json is a symlink to the founder's login (never read or copied); config.toml has only the lab server. */
export function prepareCodexHome(agent, state) {
  const home = agent.codexHome
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
    agent.say(`linked ${auth} -> ${real}`)
  }
  try {
    execFileSync('codex', ['login', 'status'], { env: { ...process.env, CODEX_HOME: home }, stdio: 'pipe' })
  } catch (error) {
    throw new Error(`\`codex login status\` failed with CODEX_HOME=${home}: ${String(error.stderr ?? error.message ?? error).trim()}`)
  }
  writeFileSync(
    join(home, 'config.toml'),
    [
      // As the founder's Codex desktop app runs: full access (network on), no approvals. Web search: codexTurn's --search.
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      `model = ${JSON.stringify(agent.model)}`,
      `model_reasoning_effort = ${JSON.stringify(agent.effort)}`,
      'service_tier = "default"',
      '',
      '[mcp_servers.learning-space]',
      `url = ${JSON.stringify(`http://127.0.0.1:${state.mcpPort}/mcp`)}`,
      // With approval "never", the sandbox declines MCP write tools unless they are approved here.
      'default_tools_approval_mode = "approve"',
      ''
    ].join('\n')
  )
}

/** The rollout file of a Codex thread in codexHome, or null. */
export function codexRollout(codexHome, threadId) {
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
  walk(join(codexHome, 'sessions'))
  return found[0] ?? null
}

/** Codex: one `codex exec` turn, or `codex exec resume <thread>`. stdout_file: the --json event stream. */
export async function codexTurn(agent, state, dir, prompt, phase, thread = null) {
  const stdoutFile = join(dir, `${phase}-codex.jsonl`)
  const lastMessage = join(dir, `${phase}-reply.md`)
  const common = ['--json', '--skip-git-repo-check', '-m', agent.model, '-c', `model_reasoning_effort=${JSON.stringify(agent.effort)}`, '-o', lastMessage]
  if (agent.newsHook) {
    const hook = `{type="command",command=${JSON.stringify(newsHookCommand(state)('Codex'))},timeout=5}`
    common.push('-c', `hooks.UserPromptSubmit=[{hooks=[${hook}]}]`, '--dangerously-bypass-hook-trust')
  }
  const web = agent.web ? ['--search'] : []
  const argv = thread ? [...web, 'exec', 'resume', ...common, thread, prompt] : [...web, 'exec', ...common, prompt]
  const code = await runProcess(agent, 'codex', argv, { cwd: state.folder, env: { ...process.env, CODEX_HOME: agent.codexHome }, stdoutFile, stderrFile: join(dir, `${phase}-stderr.txt`) })
  let threadId = thread
  const tokens = { input: 0, cached_input: 0, output: 0, reasoning_output: 0 }
  let turns = 0
  const errors = []
  // The tool calls Codex failed itself (for example a declined approval): they never reach the app trace. Also in errors.
  const failedToolCalls = []
  for (const l of readFileSync(stdoutFile, 'utf8').split('\n')) {
    let event
    try {
      event = JSON.parse(l)
    } catch {
      continue
    }
    if (event.type === 'thread.started') threadId = event.thread_id
    if (event.type === 'turn.completed') {
      turns += 1
      const u = event.usage ?? {}
      tokens.input += u.input_tokens ?? 0
      tokens.cached_input += u.cached_input_tokens ?? 0
      tokens.output += u.output_tokens ?? 0
      tokens.reasoning_output += u.reasoning_output_tokens ?? 0
    }
    if (event.type === 'turn.failed' || event.type === 'error') errors.push(event.error?.message ?? event.message ?? JSON.stringify(event))
    if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item.status === 'failed') {
      const failed = `${event.item.tool}: ${event.item.error?.message ?? 'failed'}`
      errors.push(failed)
      failedToolCalls.push(failed)
    }
  }
  return {
    exit_code: code,
    reply: existsSync(lastMessage) ? readFileSync(lastMessage, 'utf8') : '',
    is_error: code !== 0 || errors.length > 0,
    errors,
    failed_tool_calls: failedToolCalls,
    session: threadId,
    tokens,
    turns,
    stdout_file: stdoutFile
  }
}

/** The transcript of a Claude session in ~/.claude/projects, or null. */
export function claudeTranscript(sessionId) {
  if (!sessionId) return null
  const root = join(homedir(), '.claude/projects')
  if (!existsSync(root)) return null
  for (const project of readdirSync(root)) {
    const file = join(root, project, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

/** Tool calls from the app traces written after sinceMs (all sessions except the lab's own client). */
export function traceCalls(tracesDir, sinceMs, { skipClient = 'ls-lab' } = {}) {
  const calls = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl') && entry.name !== 'learner-edits.jsonl') {
        let client = null
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          let e
          try {
            e = JSON.parse(line)
          } catch {
            continue
          }
          if (e.type === 'session_open') client = e.client?.name ?? null
          if (e.type === 'tool_call' && client !== skipClient && Date.parse(e.t) >= sinceMs) calls.push({ ...e, client })
        }
      }
    }
  }
  walk(tracesDir)
  return calls.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
}
