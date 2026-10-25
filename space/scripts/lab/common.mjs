/**
 * Shared parts of the live-drawing lab: the scratch app instance, the MCP
 * client, CDP (screenshots, screencast, the dev hook), video and filmstrip.
 *
 * Copied in part from scripts/bench/run.mjs and scripts/drive.mjs. Never
 * import run.mjs: importing it starts a real bench.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LAB = dirname(fileURLToPath(import.meta.url))
export const SPACE = resolve(LAB, '../..')
export const DRIVE = join(SPACE, 'scripts/drive.mjs')
export const TEMPLATE = join(SPACE, 'resources/learning-folder')
export const SCRATCH = '/private/tmp/claude-501/ls-lab'
export const RUNS = join(SPACE, '.lab/runs')
export const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
export const FOUNDER_PORT = 47821
/** Tools that change the board. The first one is the first visible mark. */
export const WRITE_TOOLS = new Set(['run_scene', 'create_frame', 'write_html', 'update_styles', 'set_text', 'move_nodes', 'duplicate_nodes', 'delete_nodes', 'draw_ink'])

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
const BOOLEAN_FLAGS = new Set(['--built', '--dev', '--fresh', '--no-crop', '--no-news-hook', '--no-gallery', '--keep-app'])

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
 * exact PIDs to stop. fresh: start from an empty folder and board.
 */
export async function startInstance({ name, mcpPort, debugPort, built = false, fresh = false }) {
  if (mcpPort === FOUNDER_PORT) throw new Error(`Port ${FOUNDER_PORT} is the founder's app. Pick another.`)
  const inst = instance(name)
  const running = readState(name)
  if (running && running.pids.some(alive)) throw new Error(`The lab "${name}" is already running (PIDs ${running.pids.join(', ')}). Stop it first.`)
  for (const port of [mcpPort, debugPort]) if (await portInUse(port)) throw new Error(`Port ${port} is in use by another process. Pick free ports with --mcp-port / --debug-port.`)
  if (!built && !existsSync(join(SPACE, 'node_modules/.bin/electron-vite'))) throw new Error('No node_modules in space/. Run npm install there.')
  if (built && !existsSync(join(SPACE, 'out/main/index.js'))) throw new Error('No built app in out/. Run `npm run build` in space/ first.')
  if (fresh && existsSync(inst.dir)) rmSync(inst.dir, { recursive: true, force: true })
  for (const path of [inst.home, inst.userData, inst.traces]) mkdirSync(path, { recursive: true })
  if (!existsSync(join(inst.folder, 'AGENTS.md'))) setupFolder(inst.folder)

  const env = { ...process.env, HOME: inst.home, SPACE_FOLDER: inst.folder, SPACE_MCP_PORT: String(mcpPort), SPACE_REMOTE_DEBUG: String(debugPort), SPACE_TRACE_DIR: inst.traces, SPACE_SPEECH: process.env.SPACE_SPEECH ?? '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const logFd = openSync(inst.log, 'a')
  let child
  if (!built) {
    child = spawn(join(SPACE, 'node_modules/.bin/electron-vite'), ['dev', '--', `--user-data-dir=${inst.userData}`], { cwd: SPACE, env, stdio: ['ignore', logFd, logFd], detached: true })
  } else {
    const electron = createRequire(join(SPACE, 'package.json'))('electron')
    child = spawn(electron, [`--user-data-dir=${inst.userData}`, '.'], { cwd: SPACE, env, stdio: ['ignore', logFd, logFd], detached: true })
  }
  closeSync(logFd)
  child.unref()
  const state = { name, mode: built ? 'built' : 'dev', mcpPort, debugPort, pids: [child.pid], launcher: child.pid, started: new Date().toISOString(), ...inst }
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2))
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
  try {
    execFileSync('osascript', ['-e', 'tell application "Claude" to activate'], { stdio: 'ignore' })
  } catch {
    // Claude is not running.
  }
  return state
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

/** Attach to the app page (not the hidden snapshot window). Events go to on(method, params). */
export async function cdpConnect(port) {
  let targets
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  } catch {
    throw new Error(`No app with remote debugging on 127.0.0.1:${port}.`)
  }
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.includes('snapshot=1'))
  if (!page) throw new Error(`Port ${port} has no app page.`)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    socket.onopen = ok
    socket.onerror = () => fail(new Error(`Could not attach to the page on port ${port}.`))
  })
  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id === undefined) {
      for (const fn of listeners) fn(data.method, data.params)
      return
    }
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)
    if (data.error) entry.reject(new Error(`${entry.method}: ${data.error.message}`))
    else entry.resolve(data.result)
  }
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const id = ++nextId
      pending.set(id, { resolve: ok, reject: fail, method })
      socket.send(JSON.stringify({ id, method, params }))
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
    return await cdp.evaluate('(() => { const s = window.__spaceDev && window.__spaceDev.scene; if (!s) return null; const v = typeof s === "function" ? s() : s; return { playing: Boolean(v.playing), current: v.current ?? null, time: v.time ?? null, duration: v.duration ?? null, paused: Boolean(v.paused), hasSeek: typeof v.seek === "function" } })()')
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
 * run_scene") and a real-time clock burned in (recut.py, Pillow). labels:
 * [{from, to, label}] in wall ms (traceLabels). Returns {watch_s, real_s, cuts}.
 */
export function encodeWatchVideo(frames, out, { from, to, crop = '', labels = [], idleMs = 1500, cutMs = 600, fps = 30 }) {
  const m = /^crop=(\d+):(\d+):(\d+):(\d+)$/.exec(crop)
  const spec = join(dirname(out), '.recut.json')
  writeFileSync(spec, JSON.stringify({ frames: frames.map((f) => ({ file: f.file, t: f.t })), from, to, crop: m ? [Number(m[3]), Number(m[4]), Number(m[1]), Number(m[2])] : null, labels, idle_ms: idleMs, cut_ms: cutMs, fps, out, ffmpeg: FFMPEG }))
  try {
    const text = execFileSync('python3', ['-I', join(LAB, 'recut.py'), spec], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    return JSON.parse(text.trim().split('\n').pop())
  } finally {
    rmSync(spec, { force: true })
  }
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
    if (start > previous) labels.push({ from: previous, to: start, label: WRITE_TOOLS.has(c.tool) ? `model writing ${c.tool}` : 'model thinking' })
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

export function runFolder(slugSource) {
  const d = new Date()
  const p = (v) => String(v).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const slug =
    String(slugSource || 'run')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'run'
  const dir = join(RUNS, `${stamp}-${slug}`)
  mkdirSync(dir, { recursive: true })
  return dir
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
