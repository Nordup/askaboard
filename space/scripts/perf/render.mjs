#!/usr/bin/env node
/**
 * The render benchmark: fixed scenes on a fresh app, on this machine as it is now.
 * Each run writes one line per phase to .lab/perf/render-history.jsonl and prints
 * a table with the change against the last run of the same scene, tune and mode.
 * What each number means: scripts/perf/README.md.
 *
 *   node scripts/perf/render.mjs [--scenes toon,many] [--tune <json>] [--label x] [--seconds 10] [--dev]
 *   node scripts/perf/render.mjs --scenes toon --matrix '[{"msaa":0},{"adaptive":0}]'
 *   node scripts/perf/render.mjs --report
 *   node scripts/perf/render.mjs --scenes toon --profile     # where the CPU goes: writes .lab/perf/profile-<scene>.json
 *   node scripts/perf/render.mjs --scenes toon --burst       # CPU of the first 30 s of a world, one line in .lab/perf/render-burst.jsonl
 *
 * pen, bigboard, memory, start: the board's own numbers, not the worlds'. meter (not in the default run): what the page meter costs.
 *
 * A run is uncapped by default, so pict/s shows the real headroom. --capped: the cap of a normal user. Each history line has `uncapped`.
 * --no-pan: toon without its pan phase. --dev: the dev renderer, not out/. The window opens at its normal place, with no focus.
 */
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { boardFile, HOLE, seedBusy } from '../bench/busy.mjs'
import { args, cdpConnect, childPids, drive, DRIVE, guardRun, portInUse, resultText, sceneHook, sleep, SPACE, startInstance, stopInstance, withMcp } from '../lab/common.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(SPACE, '.lab/perf')
const HISTORY = join(OUT, 'render-history.jsonl')
const REPORT = join(OUT, 'render-report.md')
const NAME = 'perf-render'
const run = promisify(execFile)
const { option, flag } = args()
const MCP_PORT = Number(option('--mcp-port', '47882'))
const DEBUG_PORT = Number(option('--debug-port', '9482'))
if ([MCP_PORT, DEBUG_PORT].includes(47821)) throw new Error('Port 47821 is the founder\'s app.')
const PAN_SECONDS = 5
const BIGBOARD_SECONDS = 8
const METER_SECONDS = 15
const START_RUNS = 3
/** Scenes with a file in render-scenes/. The others drive the board: see BOARD_SCENES. */
const ALL_SCENES = ['toon', 'many', 'three', 'ink', 'shapes', 'pen', 'bigboard', 'memory', 'start', 'meter']
/** The default run. The others are for one question: how a style looks, what the meter costs. */
const DEFAULT_SCENES = ['toon', 'many', 'three', 'ink', 'pen', 'bigboard', 'memory', 'start']

// ---------- What the machine does ----------

const LINUX = process.platform === 'linux'
/** The main PID of the app under measure: on Linux it picks the GPU card that the app's GPU process uses. */
let appMain = null

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
const listDir = (path) => {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** Linux: every process from /proc, with its CPU seconds (utime + stime), parent, short name and command line. */
const CLOCK_TICKS = LINUX ? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100 : 100
function procTable() {
  const rows = []
  for (const entry of listDir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const stat = readText(`/proc/${entry}/stat`)
    const close = stat.lastIndexOf(')')
    if (close < 0) continue
    const comm = stat.slice(stat.indexOf('(') + 1, close)
    const fields = stat.slice(close + 2).split(' ')
    // After the name: state ppid ... utime is field 14 of stat, here index 11.
    rows.push({ pid: Number(entry), ppid: Number(fields[1]), seconds: (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS, comm, command: readText(`/proc/${entry}/cmdline`).replaceAll('\0', ' ').trim() })
  }
  return rows
}

/** The PIDs under a process, at any depth: Linux renderers are children of the zygote, not of the main process. rows: { pid, ppid }. */
function descendants(main, rows) {
  const found = new Set([main])
  for (let grew = true; grew; ) {
    grew = false
    for (const { pid, ppid } of rows) if (found.has(ppid) && !found.has(pid)) grew = found.add(pid)
  }
  return found
}

/** Linux: the name of a process as macOS names Electron's helpers, so "Renderer" and "GPU" match on both systems. */
const ELECTRON_TYPES = { renderer: 'Renderer', 'gpu-process': 'GPU', utility: 'Utility', zygote: 'Zygote', broker: 'Broker' }
function linuxName({ comm, command }) {
  const type = /--type=([\w-]+)/.exec(command)?.[1]
  return type ? `${comm} (${ELECTRON_TYPES[type] ?? type})` : comm
}

/** Linux: the compositor processes, the window server of macOS. */
const COMPOSITORS = new Set(['gnome-shell', 'kwin_wayland', 'kwin_x11', 'Xorg', 'Xwayland', 'mutter', 'sway', 'Hyprland', 'weston'])
const isWindowServer = (name) => name === 'WindowServer' || COMPOSITORS.has(name)

/** Linux: the DRM cards with a busy counter (AMD), by PCI address. */
function busyCards() {
  const cards = new Map()
  for (const name of listDir('/sys/class/drm')) {
    if (!/^card\d+$/.test(name)) continue
    const busy = `/sys/class/drm/${name}/device/gpu_busy_percent`
    if (!existsSync(busy)) continue
    let pci = name
    try {
      pci = realpathSync(`/sys/class/drm/${name}/device`).split('/').at(-1)
    } catch {
      // Keep the card name.
    }
    cards.set(pci, busy)
  }
  return cards
}

/** Linux: the busy file of the card that the app's GPU process has open (drm-pdev in its fdinfo), cached per app. */
const gpuCardOf = new Map()
function appGpuCard(cards) {
  if (!appMain) return null
  if (gpuCardOf.has(appMain)) return gpuCardOf.get(appMain)
  const rows = procTable()
  const family = descendants(appMain, rows)
  const gpu = rows.find((p) => family.has(p.pid) && /--type=gpu-process/.test(p.command))
  let found = null
  for (const fd of gpu ? listDir(`/proc/${gpu.pid}/fdinfo`) : []) {
    const pdev = /^drm-pdev:\s*(\S+)/m.exec(readText(`/proc/${gpu.pid}/fdinfo/${fd}`))?.[1]
    if (pdev && cards.has(pdev)) {
      found = cards.get(pdev)
      break
    }
  }
  if (gpu) gpuCardOf.set(appMain, found)
  return found
}

/** GPU utilization in %. macOS: the IOAccelerator's Device Utilization. Linux (AMD): gpu_busy_percent of the app's card, or the busiest card. Null: no source. */
const gpuUtilization = async () => {
  if (LINUX) {
    const cards = busyCards()
    const card = appGpuCard(cards)
    const values = (card ? [card] : [...cards.values()]).map((path) => Number(readText(path).trim())).filter((n) => Number.isFinite(n))
    return values.length ? Math.max(...values) : null
  }
  const { stdout } = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { maxBuffer: 1 << 24 })
  const found = /"Device Utilization %"=(\d+)/.exec(stdout)
  return found ? Number(found[1]) : null
}

/** The 5 busiest processes, "%CPU name". Linux: the CPU of one second from /proc (procps' %CPU is the average since the start). */
const topProcesses = async () => {
  if (LINUX) {
    const from = new Map(procTable().map((p) => [p.pid, p.seconds]))
    await sleep(1000)
    return procTable()
      .filter((p) => from.has(p.pid))
      .map((p) => ({ name: linuxName(p), percent: (p.seconds - from.get(p.pid)) * 100 }))
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 5)
      .map((p) => `${p.percent.toFixed(1)} ${p.name}`)
  }
  const { stdout } = await run('ps', ['-Aceo', 'pcpu=,comm=', '-r'])
  return stdout.trim().split('\n').slice(0, 5).map((line) => line.trim().replace(/\s+/, ' '))
}

/** The share of the app's window that is on screen and in no other window's shade, 0 to 1, on a grid. Null: no answer (always on Linux: macOS only). */
const COVER_SCRIPT = `
ObjC.import('AppKit'); ObjC.import('CoreGraphics');
function run(argv) {
  const pids = argv.map(Number), list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0)));
  const at = list.findIndex((w) => pids.includes(w.kCGWindowOwnerPID) && w.kCGWindowLayer <= 3);
  if (at < 0) {
    const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0))).find((w) => pids.includes(w.kCGWindowOwnerPID) && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width > 1000);
    return JSON.stringify({ share: 0, x: all?.kCGWindowBounds.X, y: all?.kCGWindowBounds.Y });
  }
  const r = list[at].kCGWindowBounds, front = list.slice(0, at).filter((w) => w.kCGWindowLayer <= 3 && w.kCGWindowAlpha > 0.5).map((w) => w.kCGWindowBounds);
  const known = $.NSScreen.screens, screens = Array.from({ length: known.count }, (_, i) => known.objectAtIndex(i).frame), top = screens[0].size.height;
  const onScreen = (x, y) => screens.some((s) => x >= s.origin.x && x < s.origin.x + s.size.width && y >= top - s.origin.y - s.size.height && y < top - s.origin.y);
  let open = 0, all = 0;
  for (let i = 0; i < 40; i++) for (let j = 0; j < 25; j++) {
    const x = r.X + ((i + 0.5) * r.Width) / 40, y = r.Y + ((j + 0.5) * r.Height) / 25;
    all++;
    if (onScreen(x, y) && !front.some((f) => x >= f.X && x < f.X + f.Width && y >= f.Y && y < f.Y + f.Height)) open++;
  }
  return JSON.stringify({ share: open / all, x: r.X, y: r.Y, width: r.Width, height: r.Height });
}`

async function windowShare(pids) {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', COVER_SCRIPT, ...pids.map(String)])
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

function codeIdentity() {
  const git = (...rest) => execFileSync('git', rest, { cwd: SPACE, encoding: 'utf8' }).trim()
  const version = (name) => JSON.parse(readFileSync(join(SPACE, 'node_modules', name, 'package.json'), 'utf8')).version
  return {
    commit: git('rev-parse', '--short', 'HEAD'),
    dirty: git('status', '--porcelain').length > 0,
    three: version('three'),
    electron: version('electron'),
    machine: machineModel()
  }
}

/** macOS: hw.model. Linux: the DMI product name. */
function machineModel() {
  if (LINUX) return readText('/sys/devices/virtual/dmi/id/product_name').trim() || 'unknown Linux machine'
  try {
    return execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown machine'
  }
}

// ---------- One phase ----------

const median = (list) => {
  const numbers = list.filter((n) => typeof n === 'number').sort((a, b) => a - b)
  return numbers.length ? numbers[Math.floor(numbers.length / 2)] : null
}

/**
 * One wheel event per display frame or fewer: a pan in a circle, then a pinch in and out. A cycle ends about where it began.
 * Each event waits for its answer, which holds it for a frame. onClock: 120 events a second with no wait, as a trackpad gives.
 */
async function panAndZoom(cdp, ms, onClock = false) {
  const rect = await cdp.evaluate('window.__spaceDev.canvasRect()')
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  // Not state(): it maps every item, which is a long task on a big board.
  const camera = () => cdp.evaluate('JSON.stringify(window.__spaceDev.boardToClient(0, 0))')
  const from = await camera()
  const start = Date.now()
  const pending = []
  let events = 0
  let moved = false
  for (;;) {
    const t = (Date.now() - start) / 1000
    if (events === 40) moved = (await camera()) !== from
    if (t * 1000 >= ms) break
    const cycle = t % 4
    const pinch = cycle >= 3
    const deltaX = pinch ? 0 : 14 * Math.cos((2 * Math.PI * cycle) / 3)
    const deltaY = pinch ? (cycle < 3.5 ? -3 : 3) : 9 * Math.sin((2 * Math.PI * cycle) / 3)
    const sent = cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: deltaX / (onClock ? 2 : 1), deltaY: deltaY / (onClock ? 2 : 1), modifiers: pinch ? 2 : 0, pointerType: 'mouse' })
    pending.push(sent)
    if (!onClock) await sent
    events++
    await sleep(onClock ? 7 : 14)
  }
  await Promise.all(pending)
  return { events, moved }
}

/** Measure for this many seconds, with work running beside it. A phase starts the meter new, so its 10 s window holds only this phase. */
async function measure(cdp, seconds, work) {
  await cdp.evaluate('window.__spaceDev.perf.stop(); window.__spaceDev.perf.start()')
  const motion = work?.(seconds * 1000)
  const reads = []
  const utilization = []
  const processes = []
  let topping = null
  let toppingError = null
  const start = Date.now()
  for (let i = 1; i <= seconds; i++) {
    await sleep(Math.max(0, start + i * 1000 - Date.now()))
    const [read, gpu] = await Promise.all([cdp.evaluate('window.__spaceDev.perf.read()'), gpuUtilization()])
    reads.push(read)
    utilization.push(gpu)
    // Not awaited here: on Linux it reads the CPU over one second.
    // The handler is on at once: a failed read must not stop Node before the finally that stops the app.
    if (i === Math.ceil(seconds / 2)) topping = topProcesses().then((list) => processes.push(...list), (error) => (toppingError = error))
  }
  await topping
  if (toppingError) throw toppingError
  const wheel = motion ? await motion : null
  const last = reads.at(-1)
  // The first window holds the start of the meter, so it does not count.
  const worlds = reads.map((read) => read.world).filter(Boolean).slice(1)
  const of = (key) => median(worlds.map((world) => world[key]))
  const world = worlds.length
    ? {
        picturesPerSecond: of('picturesPerSecond'),
        gpuSource: worlds.at(-1).gpuSource,
        gpuMs: of('gpuMsMedian'),
        gpuMsP95: of('gpuMsP95'),
        fenceMs: of('fenceMsMedian'),
        pictureMs: of('pictureMsMedian'),
        cpuMs: of('cpuMsMedian'),
        ticksPerSecond: of('ticksPerSecond'),
        tickMs: of('tickMsPerSecond'),
        checkMs: of('checkMsPerSecond'),
        planMs: of('planMsPerSecond'),
        resolution: Math.min(...worlds.map((w) => w.resolution)),
        megapixels: of('megapixels'),
        bitmapMegapixels: of('bitmapMegapixels'),
        drawCalls: of('drawCalls'),
        triangles: of('triangles'),
        passes: of('passes'),
        programs: of('programs'),
        textures: of('textures'),
        geometries: of('geometries'),
        targets: of('targets'),
        crops: worlds.at(-1).crops,
        worldsAlive: of('worldsAlive'),
        worldsRendered: of('worldsRendered'),
        worldsWaited: of('worldsWaited')
      }
    : null
  return {
    seconds,
    fps: median(reads.slice(1).map((read) => read.fps)),
    worstFrameMs: last.worstFrameMs,
    droppedFrames: last.droppedFrames,
    longTasks: last.longTasks,
    longTaskMs: last.longTaskMs,
    gpuUtilization: median(utilization),
    gpuUtilizationMax: Math.max(...utilization.filter((n) => n !== null)),
    wheelEvents: wheel?.events ?? 0,
    cameraMoved: wheel?.moved ?? null,
    topProcesses: processes,
    load: loadavg().map((n) => Math.round(n * 100) / 100),
    world
  }
}

// ---------- Where the CPU goes ----------

/** CPU seconds so far of the app's processes, and of the window server (Linux: the compositor). */
async function processTimes(main) {
  if (LINUX) {
    const rows = procTable()
    const family = descendants(main, rows)
    const times = {}
    for (const p of rows) {
      if (family.has(p.pid) || COMPOSITORS.has(p.comm)) times[p.pid] = { name: linuxName(p), seconds: p.seconds }
    }
    return times
  }
  const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=,time=,comm='])
  const seconds = (text) => text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
  const family = new Set([main, ...childPids(main)])
  const times = {}
  for (const line of stdout.trim().split('\n')) {
    const [pid, ppid, time, ...name] = line.trim().split(/\s+/)
    const comm = name.join(' ').split('/').at(-1)
    if (family.has(Number(pid)) || family.has(Number(ppid)) || comm === 'WindowServer') times[pid] = { name: comm, seconds: seconds(time) }
  }
  return times
}

/** Self time per function of one CPU profile, the top 10, in ms and as a share of the wall time. */
function selfTimes(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const self = new Map()
  profile.samples.forEach((id, i) => {
    const { functionName, url, lineNumber } = nodes.get(id).callFrame
    const key = `${functionName || '(anonymous)'} ${url.startsWith('data:') ? 'worker' : url.split('/').slice(-2).join('/')}:${lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[i] / 1000)
  })
  const wall = [...self.values()].reduce((a, b) => a + b, 0)
  return { wallMs: Math.round(wall), top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, ms]) => ({ name, ms: Math.round(ms), share: Math.round((ms / wall) * 1000) / 10 })) }
}

/** The page, and every frame and worker under it, through flat sessions. A frame gets the same auto-attach, so a worker in a sandboxed frame is found. */
async function profileTargets(cdp, ms) {
  const targets = [{ type: 'page', url: 'app page', session: undefined }]
  const auto = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
  cdp.on((method, params) => {
    if (method !== 'Target.attachedToTarget') return
    const info = params.targetInfo
    targets.push({ type: info.type, url: info.url.slice(0, 80), session: params.sessionId })
    if (info.type !== 'worker') cdp.send('Target.setAutoAttach', auto, params.sessionId).catch(() => undefined)
  })
  await cdp.send('Target.setAutoAttach', auto)
  await sleep(1000)
  const profiled = targets.filter((target) => target.type === 'page' || target.type === 'worker' || target.type === 'iframe')
  for (const target of profiled) {
    await cdp.send('Profiler.enable', {}, target.session)
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }, target.session)
    await cdp.send('Profiler.start', {}, target.session)
  }
  await sleep(ms)
  const result = []
  for (const target of profiled) {
    const { profile } = await cdp.send('Profiler.stop', {}, target.session)
    result.push({ type: target.type, url: target.url, ...selfTimes(profile) })
  }
  return { targets: targets.map(({ type, url }) => ({ type, url })), profiles: result }
}

/** A Chromium trace from the browser target: total ms per event name and thread, for what no JavaScript profile shows. Nested events count twice. */
async function traceThreads(ms) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    socket.onopen = ok
    socket.onerror = fail
  })
  const events = []
  let ended
  const over = new Promise((ok) => (ended = ok))
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.method === 'Tracing.dataCollected') events.push(...data.params.value)
    if (data.method === 'Tracing.tracingComplete') ended()
  }
  socket.send(JSON.stringify({ id: 1, method: 'Tracing.start', params: { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['v8', 'v8.gc', 'v8.compile', 'disabled-by-default-v8.gc', 'devtools.timeline', 'toplevel', 'cc', 'viz', 'gpu', 'blink'] } } }))
  await sleep(ms)
  socket.send(JSON.stringify({ id: 2, method: 'Tracing.end' }))
  await over
  socket.close()
  const threads = new Map()
  for (const event of events) if (event.ph === 'M' && event.name === 'thread_name') threads.set(`${event.pid}:${event.tid}`, event.args.name)
  const totals = new Map()
  for (const event of events) {
    if (event.ph !== 'X' || !event.dur) continue
    const key = `${(threads.get(`${event.pid}:${event.tid}`) ?? 'thread').replace(/\/\d+$/, '')} | ${event.name}`
    totals.set(key, (totals.get(key) ?? 0) + event.dur / 1000)
  }
  return [...totals].sort((a, b) => b[1] - a[1]).map(([name, total]) => ({ name, ms: Math.round(total) }))
}

/** Which process and thread uses the CPU, with no profiler on, and then the JavaScript of each thread that CDP can reach. */
async function profileScene(scene, state, cdp) {
  const main = state.pids[0]
  await cdp.screenshot(join(OUT, `shot-${scene}.png`))
  const from = await processTimes(main)
  const start = Date.now()
  await sleep(6000)
  const to = await processTimes(main)
  const wall = (Date.now() - start) / 1000
  const processes = Object.entries(to)
    .map(([pid, { name, seconds }]) => ({ pid: Number(pid), name, percent: Math.round(((seconds - (from[pid]?.seconds ?? seconds)) / wall) * 1000) / 10 }))
    .sort((a, b) => b.percent - a.percent)
  const busiest = processes.find((p) => p.name.includes('Renderer'))
  // `sample` (the stacks of the busiest renderer) is macOS only.
  const sampleFile = process.platform === 'darwin' ? join(OUT, `sample-${scene}.txt`) : 'not available on Linux'
  if (busiest && process.platform === 'darwin') await run('sample', [String(busiest.pid), '5', '1', '-file', sampleFile]).catch(() => undefined)
  const later = []
  for (let i = 0; i < 3; i++) {
    await sleep(20_000)
    const a = await processTimes(main)
    await sleep(5000)
    const b = await processTimes(main)
    later.push(Object.entries(b).filter(([pid]) => a[pid]).map(([pid, p]) => [p.name, Math.round((p.seconds - a[pid].seconds) * 20)]).sort((x, y) => y[1] - x[1]).slice(0, 3).join(' '))
  }
  console.log('later, 5 s windows:', later.join(' // '))
  const trace = await traceThreads(5000)
  const js = await profileTargets(cdp, 10_000)
  const file = join(OUT, `profile-${scene}.json`)
  writeFileSync(file, JSON.stringify({ processes, sampleFile, trace, ...js }, null, 1))
  console.log('trace, ms in 5 s:')
  for (const row of [...trace.slice(0, 8), ...trace.filter((t) => /Pool/.test(t.name)).slice(0, 14)]) console.log(`  ${String(row.ms).padStart(6)}  ${row.name}`)
  console.log(`processes, % of one core over ${wall.toFixed(0)} s:`)
  for (const p of processes.slice(0, 8)) console.log(`  ${String(p.percent).padStart(6)}  ${p.name} (${p.pid})`)
  console.log(`targets: ${js.targets.map((t) => t.type).join(', ')}`)
  for (const profile of js.profiles) {
    console.log(`${profile.type} ${profile.url}: ${profile.wallMs} ms`)
    for (const row of profile.top) console.log(`  ${String(row.ms).padStart(6)} ms ${String(row.share).padStart(5)}%  ${row.name}`)
  }
  console.log(`written: ${file}, ${sampleFile}`)
}

/** CPU of the app in the first 30 s of a world, from the moment the scene is sent: % of one core per window. Renderer: all renderer processes. */
async function burstScene(scene, state, cdp) {
  const main = state.pids[0]
  const group = (name) => (name.includes('Renderer') ? 'renderer' : name.includes('GPU') ? 'gpu' : isWindowServer(name) ? 'windowserver' : 'other')
  const start = Date.now()
  const marks = []
  const mark = async () => marks.push({ at: (Date.now() - start) / 1000, times: await processTimes(main) })
  await mark()
  const played = playScene(scene, state, cdp)
  for (const second of [5, 10, 20, 30]) {
    await sleep(Math.max(0, start + second * 1000 - Date.now()))
    await mark()
  }
  await played
  const windows = marks.slice(1).map((to, i) => {
    const from = marks[i]
    const used = {}
    for (const [pid, { name, seconds }] of Object.entries(to.times)) {
      const key = group(name)
      used[key] = (used[key] ?? 0) + seconds - (from.times[pid]?.seconds ?? 0)
    }
    const percent = Object.fromEntries(Object.entries(used).map(([key, value]) => [key, Math.round((value / (to.at - from.at)) * 100)]))
    return { from: Math.round(from.at), to: Math.round(to.at), ...percent }
  })
  for (const w of windows) console.log(`  ${w.from}-${w.to} s: renderer ${w.renderer ?? 0}%, gpu ${w.gpu ?? 0}%, windowserver ${w.windowserver ?? 0}%`)
  appendFileSync(join(OUT, 'render-burst.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), scene, ...codeIdentity(), uncapped: !flag('--capped'), label: option('--label', null), windows })}\n`)
}

// ---------- One run ----------

async function playScene(scene, state, cdp) {
  mkdirSync(join(state.folder, 'boards/scenes'), { recursive: true })
  cpSync(join(HERE, 'render-scenes'), join(state.folder, 'boards/scenes'), { recursive: true })
  await withMcp(state.mcpPort, async (call) => {
    const written = await call('write_scene', { name: scene, file: `${scene}.js` })
    if (written.isError) throw new Error(`write_scene ${scene}: ${resultText(written).slice(0, 400)}`)
    const played = await call('play_scene', { action: 'start', name: scene, when: 'now' })
    if (played.isError) throw new Error(`play_scene ${scene}: ${resultText(played).slice(0, 400)}`)
  })
  await sceneEnd(scene, cdp)
}

async function sceneEnd(scene, cdp) {
  const deadline = Date.now() + 90_000
  while ((await sceneHook(cdp))?.playing) {
    if (Date.now() > deadline) throw new Error(`scene ${scene} did not end in 90 s`)
    await sleep(100)
  }
  await sleep(500)
}

/** The busy board of the perception bench, with all of it in view. */
async function seedInk(state, cdp) {
  const busy = await withMcp(state.mcpPort, (call) => {
    const mcp = async (name, a) => {
      const result = await call(name, a)
      const body = resultText(result)
      if (result.isError) throw new Error(`seed ${name}: ${body.slice(0, 400)}`)
      try {
        return JSON.parse(body)
      } catch {
        return body
      }
    }
    return seedBusy({ x: -HOLE.halfWidth / 2, y: -HOLE.halfHeight / 2, width: HOLE.halfWidth, height: HOLE.halfHeight }, mcp)
  })
  for (const strokes of busy.learner) drive(state.debugPort, 'draw', '--strokes', JSON.stringify(strokes))
  await cdp.evaluate('window.__spaceDev.reveal(-1500, -1000, 3000, 2000)')
  await sleep(1000)
}

// ---------- The board's own numbers ----------

/**
 * The page side of a recorded phase, with no change to the app. start() wraps
 * requestAnimationFrame, so `paint` is the time in the app's frame callbacks: the
 * board's paint, which is JavaScript and the canvas calls, not the raster in the GPU
 * process. `latency`: from the oldest pen event that no paint has shown yet to
 * the end of the next paint. A pen down starts the numbers new, so a pen phase holds only its stroke.
 */
const RECORDER = `window.__perfRecorder ??= (() => {
  const native = window.requestAnimationFrame
  let s = null
  const fresh = () => ({ at: performance.now(), last: 0, frames: [], paint: [], latency: [], tasks: [], samples: 0, input: null })
  window.requestAnimationFrame = (callback) => native.call(window, (time) => {
    if (!s) return callback(time)
    const from = performance.now()
    callback(time)
    const to = performance.now()
    s.paint.push(to - from)
    if (s.input !== null) {
      s.latency.push(to - s.input)
      s.input = null
    }
  })
  const tick = () => {
    if (!s) return
    const now = performance.now()
    if (s.last) s.frames.push(now - s.last)
    s.last = now
    native.call(window, tick)
  }
  const down = (event) => {
    if (s && event.pointerType === 'pen') s = fresh()
  }
  const move = (event) => {
    if (!s || event.pointerType !== 'pen' || !event.buttons) return
    const held = event.getCoalescedEvents?.() ?? []
    s.samples += held.length || 1
    s.input ??= held[0]?.timeStamp ?? event.timeStamp
  }
  let observer = null
  const stats = (list) => {
    const sorted = [...list].sort((a, b) => a - b)
    const at = (share) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] : null)
    return { count: list.length, total: list.reduce((a, b) => a + b, 0), median: at(0.5), p95: at(0.95), worst: at(1) }
  }
  return {
    start() {
      s = fresh()
      addEventListener('pointerdown', down, true)
      addEventListener('pointermove', move, true)
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) s?.tasks.push(entry.duration)
      })
      observer.observe({ type: 'longtask' })
      native.call(window, tick)
    },
    stop() {
      const r = s
      s = null
      observer.disconnect()
      removeEventListener('pointerdown', down, true)
      removeEventListener('pointermove', move, true)
      const quarter = Math.floor(r.paint.length / 4)
      return {
        ms: performance.now() - r.at,
        frames: stats(r.frames),
        over20: r.frames.filter((ms) => ms > 20).length,
        paint: stats(r.paint),
        paintStart: stats(r.paint.slice(0, quarter)).median,
        paintEnd: stats(r.paint.slice(-quarter)).median,
        latency: stats(r.latency),
        tasks: stats(r.tasks),
        samples: r.samples
      }
    }
  }
})(); undefined`

const round1 = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : null)

/** The page's cumulative numbers from Chromium, in seconds: ThreadTime is the CPU of its main thread, ProcessTime of its whole process (the world worker is in it). */
async function pageMetrics(cdp) {
  await cdp.send('Performance.enable')
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]))
}

/** GPU utilization once a second while work runs. */
async function withGpuSamples(work) {
  const samples = []
  let running = true
  const sampling = (async () => {
    while (running) {
      samples.push(await gpuUtilization())
      await sleep(1000)
    }
  })()
  const processes = sleep(3000).then(() => (running ? topProcesses() : []))
  // A handler at once, so a failed read while work() still runs is no unhandled rejection; the await below still throws it.
  processes.catch(() => undefined)
  try {
    const result = await work()
    return { result, gpuUtilization: median(samples), gpuUtilizationMax: Math.max(...samples.filter((n) => n !== null)), topProcesses: await processes }
  } finally {
    running = false
    await sampling
  }
}

/** One recorded phase. The result has the fields of the rendering table, and `detail` with the numbers of this kind of phase. */
async function recorded(cdp, work) {
  await cdp.evaluate(RECORDER)
  const from = await pageMetrics(cdp)
  const start = Date.now()
  await cdp.evaluate('window.__perfRecorder.start()')
  const { result, ...gpu } = await withGpuSamples(async () => {
    const out = await work()
    await sleep(300) // The end of a stroke commits it: that cost is in the phase.
    return { out, rec: await cdp.evaluate('window.__perfRecorder.stop()') }
  })
  const to = await pageMetrics(cdp)
  const wall = Date.now() - start
  const { rec, out } = result
  const ms = (name) => Math.round((to[name] - from[name]) * 1000)
  return {
    work: out,
    seconds: Math.round(wall / 100) / 10,
    fps: rec.frames.count / (rec.ms / 1000),
    worstFrameMs: rec.frames.worst,
    droppedFrames: rec.over20,
    longTasks: rec.tasks.count,
    longTaskMs: rec.tasks.total,
    ...gpu,
    load: loadavg().map((n) => Math.round(n * 100) / 100),
    world: null,
    detail: {
      frameMedianMs: round1(rec.frames.median),
      frameP95Ms: round1(rec.frames.p95),
      frameWorstMs: round1(rec.frames.worst),
      framesOver20: rec.over20,
      longTasks: rec.tasks.count,
      longTaskWorstMs: round1(rec.tasks.worst),
      paints: rec.paint.count,
      paintTotalMs: Math.round(rec.paint.total),
      paintMedianMs: round1(rec.paint.median),
      paintP95Ms: round1(rec.paint.p95),
      paintWorstMs: round1(rec.paint.worst),
      paintStartMs: round1(rec.paintStart),
      paintEndMs: round1(rec.paintEnd),
      latencyMedianMs: round1(rec.latency.median),
      latencyP95Ms: round1(rec.latency.p95),
      latencyWorstMs: round1(rec.latency.worst),
      samples: rec.samples,
      mainThreadCpuMs: ms('ThreadTime'),
      mainThreadCpuShare: round1((ms('ThreadTime') / wall) * 100),
      rendererCpuMs: ms('ProcessTime'),
      rendererCpuShare: round1((ms('ProcessTime') / wall) * 100),
      scriptMs: ms('ScriptDuration'),
      wallMs: wall
    }
  }
}

/** One stroke: rows that go right and left with a small wave, as long lines of writing. Each sample is about 3 points from the last. */
function longStroke(samples) {
  const rows = 11
  const [halfWidth, halfHeight] = [420, 230]
  const points = []
  for (let i = 0; i < samples; i++) {
    const along = (i / samples) * rows
    const row = Math.floor(along)
    const share = along - row
    const x = (row % 2 ? 1 - share : share) * 2 * halfWidth - halfWidth
    const y = ((row + 0.5) / rows) * 2 * halfHeight - halfHeight + 9 * Math.sin(i / 9)
    points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round((0.5 + 0.3 * Math.sin(i / 37)) * 100) / 100])
  }
  return points
}

const PEN_SAMPLES = 3000
/** An Apple Pencil on a 120 Hz iPad gives 240 samples a second. The stroke takes 12.5 s. */
const PEN_HZ = '240'
/** A new board file reaches the app through the folder watcher, which waits this long. */
const WATCH_WAIT_MS = 1500

/** Strokes through drive.mjs. drive runs apart, so the sampling goes on beside it. */
async function drawAt(state, strokes, ...options) {
  const file = join(state.dir, `strokes-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(strokes))
  await run(process.execPath, [DRIVE, '--port', String(state.debugPort), 'draw', file, ...options], { maxBuffer: 1 << 24 })
}

const itemCount = (cdp) => cdp.evaluate('window.__spaceDev.state().itemCount')

async function openBoard(state, cdp, board, create = false) {
  const start = Date.now()
  await withMcp(state.mcpPort, async (call) => {
    const opened = await call('open_board', { board, ...(create ? { create: true } : {}) })
    if (opened.isError) throw new Error(`open_board ${board}: ${resultText(opened).slice(0, 400)}`)
  })
  const deadline = Date.now() + 60_000
  while ((await cdp.evaluate('window.__spaceDev.state().board'))?.includes(`${board}.board.json`) !== true) {
    if (Date.now() > deadline) throw new Error(`The board ${board} did not open.`)
    await sleep(50)
  }
  await cdp.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))')
  return Date.now() - start
}

async function penScene({ state, cdp, base }) {
  const stroke = longStroke(PEN_SAMPLES)
  const lines = []
  const phase = async (name) => {
    const before = await itemCount(cdp)
    const measured = await recorded(cdp, () => drawAt(state, [stroke], '--hz', PEN_HZ))
    const { work: _work, ...rest } = measured
    lines.push({ ...(await base()), phase: name, ...rest, detail: { ...rest.detail, committed: (await itemCount(cdp)) === before + 1 } })
  }
  await phase('empty')
  await openBoard(state, cdp, 'busy', true)
  await seedInk(state, cdp)
  await phase('busy')
  return lines
}

async function bigboardScene({ state, cdp, base }) {
  const big = boardFile({ strokes: 5000, others: 200 })
  writeFileSync(join(state.folder, 'boards/big.board.json'), big.text)
  await sleep(WATCH_WAIT_MS)
  const openMs = await openBoard(state, cdp, 'big')
  const items = await itemCount(cdp)
  await cdp.evaluate(`window.__spaceDev.reveal(${big.rect.x}, ${big.rect.y}, ${big.rect.width}, ${big.rect.height})`)
  await sleep(1000)
  const lines = []
  const phase = async (name) => {
    const { work, ...rest } = await recorded(cdp, () => panAndZoom(cdp, BIGBOARD_SECONDS * 1000, true))
    lines.push({ ...(await base()), phase: name, ...rest, wheelEvents: work.events, cameraMoved: work.moved, detail: { ...rest.detail, items, strokes: big.strokes, others: big.items, openMs } })
  }
  await phase('pan')
  await zoomTo(cdp, 1)
  await phase('near')
  return lines
}

/** Pinch at the middle of the canvas until the board's zoom is about this. */
async function zoomTo(cdp, target) {
  const zoom = () => cdp.evaluate('window.__spaceDev.boardToClient(1, 0)[0] - window.__spaceDev.boardToClient(0, 0)[0]')
  const rect = await cdp.evaluate('window.__spaceDev.canvasRect()')
  const [x, y] = [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)]
  for (let i = 0; i < 200 && (await zoom()) < target * 0.9; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -20, modifiers: 2, pointerType: 'mouse' })
    await sleep(16)
  }
  await sleep(500)
}

/** The heaps after a collection, per target: the page, its workers and frames, and the other pages (the stage, the snapshot window). */
async function heaps(state) {
  const targets = await (await fetch(`http://127.0.0.1:${state.debugPort}/json/list`)).json()
  const found = []
  for (const target of targets.filter((t) => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview'))) {
    const socket = await cdpConnect(state.debugPort, target.webSocketDebuggerUrl)
    const children = []
    const auto = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
    socket.on((method, params) => {
      if (method !== 'Target.attachedToTarget') return
      children.push({ type: params.targetInfo.type, session: params.sessionId })
      if (params.targetInfo.type !== 'worker') socket.send('Target.setAutoAttach', auto, params.sessionId).catch(() => undefined)
    })
    await socket.send('Target.setAutoAttach', auto)
    await sleep(300)
    const name = target.url.includes('snapshot=1') ? 'snapshot' : target.url.startsWith('ls-stage') ? 'stage' : target.url.includes('renderer/index.html') ? 'page' : 'other'
    for (const part of [{ type: name, session: undefined }, ...children]) {
      try {
        await socket.send('HeapProfiler.collectGarbage', {}, part.session)
        const { usedSize } = await socket.send('Runtime.getHeapUsage', {}, part.session)
        found.push({ type: part.session ? `${name}-${part.type}` : name, mb: usedSize / 1048576 })
      } catch {
        // A worker that ended in between has no heap to read.
      }
    }
    socket.close()
  }
  return found
}

/** MB per process from `top`: the physical footprint, which counts compressed pages and the GPU memory of the process. RSS loses compressed pages. Null on Linux: no such measure. */
async function footprints() {
  if (process.platform !== 'darwin') return null
  const { stdout } = await run('top', ['-l', '1', '-stats', 'pid,mem', '-n', '1000'], { maxBuffer: 1 << 24 })
  const unit = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }
  const found = new Map()
  for (const match of stdout.matchAll(/^(\d+)\s+([\d.]+)([BKMG])\+?-?\s*$/gm)) found.set(Number(match[1]), Math.round(Number(match[2]) * unit[match[3]]))
  return found
}

/** RSS and footprint in MB of the app's processes, by Chromium's process type. */
async function processMemory(main) {
  const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=,rss=,command='], { maxBuffer: 1 << 24 })
  const footprint = await footprints()
  const groups = {}
  const prints = {}
  const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/))
  const family = descendants(main, rows.map(([pid, ppid]) => ({ pid: Number(pid), ppid: Number(ppid) })))
  for (const [pid, , rss, ...command] of rows) {
    if (!family.has(Number(pid))) continue
    const type = /--type=([\w-]+)/.exec(command.join(' '))?.[1] ?? 'main'
    ;(groups[type] ??= []).push(Math.round(Number(rss) / 1024))
    if (footprint) (prints[type] ??= []).push(footprint.get(Number(pid)) ?? 0)
  }
  return { rss: groups, footprint: footprint ? prints : null }
}

async function memorySnapshot(state, base) {
  await sleep(1000)
  const heap = await heaps(state)
  const { rss: processes, footprint } = await processMemory(state.pids[0])
  const sum = (list) => Math.round((list ?? []).reduce((a, b) => a + b, 0))
  // No footprint (Linux): null, not 0, so a growth is null too.
  const print = (list) => (footprint ? sum(list) : null)
  const heapOf = (test) => round1(heap.filter((h) => test(h.type)).reduce((a, h) => a + h.mb, 0))
  return { ...base, seconds: null, heap: heap.map((h) => ({ ...h, mb: round1(h.mb) })), processes, footprint, detail: { pageHeapMb: heapOf((t) => t === 'page'), workerHeapMb: heapOf((t) => t.includes('worker')), stageHeapMb: heapOf((t) => t.startsWith('stage')), rendererRssMb: sum(processes.renderer), rendererLargestRssMb: Math.max(...(processes.renderer ?? [0])), gpuRssMb: sum(processes['gpu-process']), mainRssMb: sum(processes.main), allRssMb: sum(Object.values(processes).flat()), rendererFootprintMb: print(footprint?.renderer), gpuFootprintMb: print(footprint?.['gpu-process']), allFootprintMb: print(Object.values(footprint ?? {}).flat()) } }
}

/** Small wiggles in rows, inside the view, and one eraser line along each row. */
function wigglesAndRows(count) {
  const columns = 25
  const strokes = []
  for (let i = 0; i < count; i++) {
    const x = -480 + (i % columns) * 40
    const y = -240 + Math.floor(i / columns) * 24
    strokes.push(Array.from({ length: 12 }, (_, k) => [x + k * 2.6, y + (k % 2 ? 8 : -8), 0.55]))
  }
  const rows = []
  for (let row = 0; row * columns < count; row++) {
    rows.push(Array.from({ length: 170 }, (_, k) => [-492 + k * 6, -240 + row * 24, 0.55]))
  }
  return { strokes, rows }
}

async function memoryScene({ state, cdp, base }) {
  const lines = []
  const take = async (phase) => lines.push({ ...(await memorySnapshot(state, await base())), phase })
  await sleep(4000) // The stage and the snapshot window start a few seconds after the board.
  await take('fresh')
  await playScene('long', state, cdp)
  await take('scene')
  await withMcp(state.mcpPort, async (call) => {
    const replayed = await call('play_scene', { action: 'replay', name: 'long', when: 'now' })
    if (replayed.isError) throw new Error(`replay: ${resultText(replayed).slice(0, 400)}`)
  })
  await sleep(1000)
  await sceneEnd('long', cdp)
  await take('replay')
  const board = boardFile({ strokes: 300, others: 20 })
  for (let i = 1; i <= 10; i++) writeFileSync(join(state.folder, `boards/m${i}.board.json`), board.text)
  await sleep(WATCH_WAIT_MS)
  for (let i = 1; i <= 10; i++) {
    await openBoard(state, cdp, `m${i}`)
    await sleep(300)
  }
  await take('boards')
  await openBoard(state, cdp, 'ink-board', true)
  const { strokes, rows } = wigglesAndRows(500)
  await drawAt(state, strokes, '--fast')
  const drawn = await itemCount(cdp)
  await drawAt(state, rows, '--tool', 'eraser', '--hz', PEN_HZ)
  const left = await itemCount(cdp)
  await take('strokes')
  const first = lines[0].detail
  for (const line of lines) {
    line.detail.growthPageHeapMb = round1(line.detail.pageHeapMb - first.pageHeapMb)
    line.detail.growthRendererRssMb = line.detail.rendererRssMb - first.rendererRssMb
    line.detail.growthAllRssMb = line.detail.allRssMb - first.allRssMb
    line.detail.growthAllFootprintMb = first.allFootprintMb === null ? null : line.detail.allFootprintMb - first.allFootprintMb
  }
  lines.at(-1).detail.strokesDrawn = drawn
  lines.at(-1).detail.strokesLeft = left
  return lines
}

/** Same launch, the meter off and on: the GPU of the whole machine, on a still board and in pan and zoom. The meter is the pill's own page loop; the pill adds only one React update a second. */
async function meterScene({ state, cdp, base }) {
  await seedInk(state, cdp)
  const lines = []
  for (const [phase, on, motion] of [['still-off', false, false], ['still-on', true, false], ['pan-off', false, true], ['pan-on', true, true]]) {
    await cdp.evaluate(on ? 'window.__spaceDev.perf.start()' : 'window.__spaceDev.perf.stop()')
    await sleep(1500)
    const from = await pageMetrics(cdp)
    const start = Date.now()
    const { result, ...gpu } = await withGpuSamples(() => (motion ? panAndZoom(cdp, METER_SECONDS * 1000) : sleep(METER_SECONDS * 1000)))
    const to = await pageMetrics(cdp)
    const wall = Date.now() - start
    const read = on ? await cdp.evaluate('window.__spaceDev.perf.read()') : null
    lines.push({ ...(await base()), phase, seconds: METER_SECONDS, fps: read?.fps ?? null, ...gpu, load: loadavg().map((n) => Math.round(n * 100) / 100), world: null, cameraMoved: result?.moved ?? null, detail: { meter: on, rendererCpuShare: round1(((to.ProcessTime - from.ProcessTime) * 100000) / wall) } })
  }
  return lines
}

/** From the spawn: the first contentful paint of the window, the board on screen, the MCP port open. The first run has no user data: it is a first start. */
async function startRun(fresh) {
  const state = await startInstance({ name: NAME, mcpPort: MCP_PORT, debugPort: DEBUG_PORT, built: true, fresh, spawnOnly: true })
  const zero = state.spawnedAt
  const deadline = zero + 60_000
  const overdue = (what) => {
    if (Date.now() > deadline) throw new Error(`start: no ${what} in 60 s`)
  }
  const portOpen = (async () => {
    while (!(await portInUse(MCP_PORT))) {
      overdue('MCP port')
      await sleep(15)
    }
    return Date.now() - zero
  })()
  let cdp = null
  while (!cdp) {
    try {
      cdp = await cdpConnect(DEBUG_PORT)
    } catch {
      overdue('page')
      await sleep(15)
    }
  }
  let boardAt = null
  while (!boardAt) {
    overdue('board')
    boardAt = await cdp.evaluate(`(() => { const d = window.__spaceDev; return d?.state()?.board && d.canvasRect() ? new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(Date.now())))) : null })()`).catch(() => null)
    if (!boardAt) await sleep(15)
  }
  const mcpMs = await portOpen
  let paintAt = null
  while (!paintAt) {
    overdue('first paint')
    paintAt = await cdp.evaluate(`(() => { const p = performance.getEntriesByName('first-contentful-paint')[0]; return p ? performance.timeOrigin + p.startTime : null })()`)
    if (!paintAt) await sleep(50)
  }
  return { cdp, state, detail: { cold: fresh, windowMs: Math.round(paintAt - zero), boardMs: boardAt - zero, mcpMs } }
}

async function startScene({ label, identity, capped, tune }) {
  const lines = []
  for (let i = 1; i <= START_RUNS; i++) {
    const { cdp, state, detail } = await startRun(i === 1)
    try {
      const size = await cdp.evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState, zoom: window.__spaceDev.state().zoom })')
      lines.push({ at: new Date().toISOString(), scene: 'start', label, mode: 'built', uncapped: !capped, tune: tune ?? null, ...identity, window: size, phase: `run${i}`, seconds: null, world: null, load: loadavg().map((n) => Math.round(n * 100) / 100), detail })
    } finally {
      cdp.close()
      await stopInstance(state.name)
    }
    await sleep(1000)
  }
  return lines
}

/** Scenes that drive the board and measure it, in place of a scene with a hold phase. */
const BOARD_SCENES = { pen: penScene, bigboard: bigboardScene, memory: memoryScene, meter: meterScene }

async function runScene(scene, { tune: given, label, seconds, dev, profile, burst, noPan, capped, shots, identity }) {
  const tune = capped ? given : { uncapped: 1, ...given }
  if (tune) process.env.SPACE_WORLD_TUNE = JSON.stringify(tune)
  else delete process.env.SPACE_WORLD_TUNE
  if (scene === 'start') return startScene({ label, identity, capped, tune })
  const state = await startInstance({ name: NAME, mcpPort: MCP_PORT, debugPort: DEBUG_PORT, built: !dev, fresh: true })
  appMain = state.pids[0]
  const lines = []
  let cdp = null
  try {
    cdp = await cdpConnect(DEBUG_PORT)
    if (burst) {
      await burstScene(scene, state, cdp)
      return []
    }
    const base = async () => {
      const size = await cdp.evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState, zoom: window.__spaceDev.boardToClient(1, 0)[0] - window.__spaceDev.boardToClient(0, 0)[0] })')
      const windowAt = await windowShare(state.pids)
      return { at: new Date().toISOString(), scene, label, mode: dev ? 'dev' : 'built', uncapped: !capped, tune: tune ?? null, ...identity, window: { ...size, visibleShare: windowAt?.share ?? null, x: windowAt?.x ?? null, y: windowAt?.y ?? null, width: windowAt?.width ?? size.width, height: windowAt?.height ?? size.height } }
    }
    if (BOARD_SCENES[scene]) {
      lines.push(...(await BOARD_SCENES[scene]({ state, cdp, base })))
      const after = await windowShare(state.pids)
      for (const line of lines) line.window.visibleShareEnd = after?.share ?? null
      return lines
    }
    if (scene === 'ink') await seedInk(state, cdp)
    else await playScene(scene, state, cdp)
    if (profile) {
      await profileScene(scene, state, cdp)
      return []
    }
    if (shots) await cdp.screenshot(join(shots, `${scene}${label ? `-${label}` : ''}.png`))
    const motion = (ms) => panAndZoom(cdp, ms)
    const line = await base()
    lines.push({ ...line, phase: scene === 'ink' ? 'pan' : 'hold', ...(await measure(cdp, seconds, scene === 'ink' ? motion : null)) })
    if (scene === 'toon' && !noPan) lines.push({ ...line, window: { ...line.window }, phase: 'pan', ...(await measure(cdp, PAN_SECONDS, motion)) })
    await cdp.evaluate('window.__spaceDev.perf.stop()')
    const after = await windowShare(state.pids)
    for (const line of lines) line.window.visibleShareEnd = after?.share ?? null
  } finally {
    cdp?.close()
    await stopInstance(NAME)
  }
  return lines
}

// ---------- Output ----------

const fixed = (value, digits = 1) => (typeof value === 'number' ? value.toFixed(digits) : '-')
const sceneName = (l) => `${l.scene}${l.phase === 'hold' ? '' : `:${l.phase}`}`
const COLUMNS = [
  ['scene', (l) => sceneName(l)],
  ['pict/s', (l) => fixed(l.world?.picturesPerSecond)],
  ['GPU ms', (l) => fixed(l.world?.gpuMs)],
  ['p95', (l) => fixed(l.world?.gpuMsP95)],
  ['timer', (l) => l.world?.gpuSource ?? '-'],
  ['wall ms', (l) => fixed(l.world?.pictureMs)],
  ['CPU ms', (l) => fixed(l.world?.cpuMs)],
  ['tick', (l) => fixed(l.world?.tickMs)],
  ['check', (l) => fixed(l.world?.checkMs)],
  ['plan', (l) => fixed(l.world?.planMs)],
  ['fps', (l) => fixed(l.fps, 0)],
  ['worst', (l) => fixed(l.worstFrameMs, 0)],
  ['drop', (l) => fixed(l.droppedFrames, 0)],
  ['long', (l) => fixed(l.longTasks, 0)],
  ['draws', (l) => fixed(l.world?.drawCalls, 0)],
  ['tris', (l) => fixed(l.world?.triangles, 0)],
  ['pass', (l) => fixed(l.world?.passes, 0)],
  ['MP', (l) => fixed(l.world?.megapixels, 2)],
  ['bmp', (l) => fixed(l.world?.bitmapMegapixels, 2)],
  ['res', (l) => fixed(l.world?.resolution, 2)],
  ['util%', (l) => fixed(l.gpuUtilization, 0)],
  ['load', (l) => fixed(l.load?.[0], 2)],
  ['seen', (l) => fixed(l.window?.visibleShare, 2)],
  ['zoom', (l) => fixed(l.window?.zoom, 2)]
]

function printTable(lines) {
  const rows = [COLUMNS.map(([name]) => name), ...lines.map((line) => COLUMNS.map(([, cell]) => String(cell(line))))]
  const widths = COLUMNS.map((_, i) => Math.max(...rows.map((row) => row[i].length)))
  for (const row of rows) console.log(row.map((cell, i) => (i ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  '))
}

/** The numbers of the board scenes, one line per phase. */
function printDetails(lines) {
  for (const line of lines) if (line.detail) console.log(`${sceneName(line)}: ${Object.entries(line.detail).map(([key, value]) => `${key} ${value}`).join(', ')}`)
}

const keyOf = (l) => JSON.stringify([l.scene, l.phase, l.tune, l.mode, !!l.uncapped])
const readHistory = () => (existsSync(HISTORY) ? readFileSync(HISTORY, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])

function printChange(lines, before) {
  for (const line of lines) {
    const old = before.findLast((entry) => keyOf(entry) === keyOf(line))
    if (!old) continue
    const change = (name, a, b) => (typeof a === 'number' && typeof b === 'number' && a ? `${name} ${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%` : null)
    const parts = [change('GPU ms', old.world?.gpuMs, line.world?.gpuMs), change('pict/s', old.world?.picturesPerSecond, line.world?.picturesPerSecond), change('util', old.gpuUtilization, line.gpuUtilization), change('dropped', old.droppedFrames, line.droppedFrames)].filter(Boolean)
    console.log(`${line.scene}:${line.phase} against ${old.commit}${old.label ? ` (${old.label})` : ''}, ${old.at.slice(0, 16)}: ${parts.join(', ') || 'no number to compare'}`)
  }
}

/** Every number must be real: this lists what is empty, zero or against what the scene does. */
function problems(line) {
  const found = []
  const world = line.world
  const d = line.detail
  if (line.window.visibility !== 'visible') found.push(`the page is ${line.window.visibility}`)
  if (line.scene === 'pen') {
    if (d.samples < PEN_SAMPLES * 0.9) found.push(`the page got ${d.samples} samples of ${PEN_SAMPLES}`)
    if (!d.committed) found.push('the stroke is not on the board')
    if (!d.paints || !d.mainThreadCpuMs) found.push('a paint or CPU number is zero')
  }
  if (line.scene === 'bigboard' && d.items < 5000) found.push(`the board has ${d.items} items`)
  if (line.scene === 'memory' && (!d.pageHeapMb || !d.rendererRssMb || (d.rendererFootprintMb !== null && !d.rendererFootprintMb))) found.push('no memory numbers')
  if (d?.strokesLeft > 5) found.push(`the eraser left ${d.strokesLeft} strokes`)
  if (line.scene === 'memory' || line.scene === 'start') return found
  if (!line.fps && line.scene !== 'meter') found.push('no paints')
  if (!Object.hasOwn(BOARD_SCENES, line.scene) && line.scene !== 'ink') {
    if (!world) found.push('no world stats')
    else if (!world.picturesPerSecond || !world.gpuMs || !world.drawCalls || !world.megapixels) found.push('a world number is zero')
  }
  if (line.cameraMoved === false) found.push('the wheel did not move the camera')
  if (line.gpuUtilization === null) found.push('no GPU utilization')
  return found
}

function writeReport(history) {
  const rows = ['# Render history', '', 'One row per commit, scene and tune: the last run of each. `.lab/perf/render-history.jsonl` holds all runs.', '', '| Date | Commit | Mode | Scene | Tune | Label | Pict/s | GPU ms | Source | fps | Worst ms | Dropped | Draws | MP | Util % | Load |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  const last = new Map()
  for (const l of history) last.set(JSON.stringify([l.commit, l.dirty, keyOf(l), l.label]), l)
  for (const l of [...last.values()].sort((a, b) => `${a.at.slice(0, 10)}${a.commit}${a.scene}`.localeCompare(`${b.at.slice(0, 10)}${b.commit}${b.scene}`))) {
    rows.push(`| ${l.at.slice(0, 10)} | ${l.commit}${l.dirty ? '+' : ''} | ${l.mode} | ${sceneName(l)} | ${l.tune ? `\`${JSON.stringify(l.tune)}\`` : ''} | ${l.label ?? ''} | ${fixed(l.world?.picturesPerSecond)} | ${fixed(l.world?.gpuMs)} | ${l.world?.gpuSource ?? ''} | ${fixed(l.fps, 0)} | ${fixed(l.worstFrameMs, 0)} | ${fixed(l.droppedFrames, 0)} | ${fixed(l.world?.drawCalls, 0)} | ${fixed(l.world?.megapixels, 2)} | ${fixed(l.gpuUtilization, 0)} | ${fixed(l.load?.[0], 2)} |`)
  }
  const details = [...last.values()].filter((l) => l.detail)
  if (details.length) rows.push('', '## The board scenes', '', '| Date | Commit | Scene | Label | Numbers |', '| --- | --- | --- | --- | --- |', ...details.map((l) => `| ${l.at.slice(0, 10)} | ${l.commit}${l.dirty ? '+' : ''} | ${sceneName(l)} | ${l.label ?? ''} | ${Object.entries(l.detail).map(([key, value]) => `${key} ${value}`).join(', ')} |`))
  mkdirSync(OUT, { recursive: true })
  writeFileSync(REPORT, `${rows.join('\n')}\n`)
  console.log(`report: ${REPORT}`)
}

async function main() {
  if (flag('--report')) return writeReport(readHistory())
  const scenes = option('--scenes', DEFAULT_SCENES.join(',')).split(',').filter(Boolean)
  for (const scene of scenes) if (!ALL_SCENES.includes(scene)) throw new Error(`Unknown scene "${scene}". Scenes: ${ALL_SCENES.join(', ')}`)
  const matrix = option('--matrix', null)
  if (matrix && scenes.length !== 1) throw new Error('--matrix runs one scene: give one with --scenes.')
  const tune = option('--tune', null)
  const tunes = matrix ? JSON.parse(matrix) : [tune ? JSON.parse(tune) : null]
  const common = { label: option('--label', null), seconds: Number(option('--seconds', '10')), dev: flag('--dev'), profile: flag('--profile'), burst: flag('--burst'), capped: flag('--capped'), shots: option('--shots', null), noPan: flag('--no-pan'), identity: codeIdentity() }
  const done = guardRun(NAME, 'render')
  mkdirSync(OUT, { recursive: true })
  const before = readHistory()
  const lines = []
  for (const given of tunes) {
    for (const scene of scenes) {
      console.log(`${scene}${given ? ` ${JSON.stringify(given)}` : ''}...`)
      const result = await runScene(scene, { ...common, tune: given })
      for (const line of result) appendFileSync(HISTORY, `${JSON.stringify(line)}\n`)
      lines.push(...result)
    }
  }
  done()
  if (!lines.length) return
  printTable(lines)
  printDetails(lines)
  printChange(lines, before)
  const failed = lines.flatMap((line) => problems(line).map((text) => `${line.scene}:${line.phase}: ${text}`))
  for (const text of failed) console.log(`PROBLEM ${text}`)
  console.log(`${common.capped ? 'capped' : 'uncapped'}, ${common.identity.machine}, ${common.identity.commit}${common.identity.dirty ? ' (dirty)' : ''}, three ${common.identity.three}, Electron ${common.identity.electron}, window ${lines[0].window.width}x${lines[0].window.height} @${lines[0].window.dpr}`)
  if (failed.length) process.exitCode = 1
}

main().catch(async (error) => {
  console.error(`render: ${error instanceof Error ? error.message : String(error)}`)
  await stopInstance(NAME).catch(() => undefined)
  process.exit(1)
})
