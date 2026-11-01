#!/usr/bin/env node
/**
 * The render benchmark: fixed scenes on a fresh app, on this machine as it is now.
 * Each run writes one line per phase to .lab/perf/render-history.jsonl and prints
 * a table with the change against the last run of the same scene, tune and mode.
 * What each number means: scripts/perf/README.md.
 *
 *   node scripts/perf/render.mjs [--scenes film,plain] [--tune <json>] [--label x] [--seconds 10] [--dev]
 *   node scripts/perf/render.mjs --scenes film --matrix '[{"msaa":0},{"adaptive":0}]'
 *   node scripts/perf/render.mjs --report
 *   node scripts/perf/render.mjs --scenes film --profile     # where the CPU goes: writes .lab/perf/profile-<scene>.json
 *   node scripts/perf/render.mjs --scenes film --burst       # CPU of the first 30 s of a world, one line in .lab/perf/render-burst.jsonl
 *
 * A run is uncapped by default, so pict/s shows the real headroom. --capped: the cap of a normal user. Each history line has `uncapped`.
 * --no-pan: film without its pan phase. --dev: the dev renderer, not out/. The window opens at its normal place, with no focus.
 */
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { HOLE, seedBusy } from '../bench/busy.mjs'
import { args, cdpConnect, childPids, drive, guardRun, resultText, sceneHook, sleep, SPACE, startInstance, stopInstance, withMcp } from '../lab/common.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(SPACE, '.lab/perf')
const HISTORY = join(OUT, 'render-history.jsonl')
const REPORT = join(OUT, 'render-report.md')
const NAME = 'perf-render'
const MCP_PORT = 47882
const DEBUG_PORT = 9482
const PAN_SECONDS = 5
/** Scenes with a file in render-scenes/. ink has none: it seeds the busy board. */
const ALL_SCENES = ['film', 'plain', 'toon', 'many', 'three', 'ink']

const run = promisify(execFile)
const { option, flag } = args()

// ---------- What the machine does ----------

const gpuUtilization = async () => {
  const { stdout } = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], { maxBuffer: 1 << 24 })
  const found = /"Device Utilization %"=(\d+)/.exec(stdout)
  return found ? Number(found[1]) : null
}

const topProcesses = async () => {
  const { stdout } = await run('ps', ['-Aceo', 'pcpu=,comm=', '-r'])
  return stdout.trim().split('\n').slice(0, 5).map((line) => line.trim().replace(/\s+/, ' '))
}

/** The share of the app's window that is on screen and in no other window's shade, 0 to 1, on a grid. Null: this Mac gave no answer. */
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
  const screens = ObjC.deepUnwrap($.NSScreen.screens).map((s) => s.frame), top = screens[0].size.height;
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
    machine: execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim()
  }
}

// ---------- One phase ----------

const median = (list) => {
  const numbers = list.filter((n) => typeof n === 'number').sort((a, b) => a - b)
  return numbers.length ? numbers[Math.floor(numbers.length / 2)] : null
}

/** One wheel event per display frame or fewer: a pan in a circle, then a pinch in and out. A cycle ends about where it began. */
async function panAndZoom(cdp, ms) {
  const rect = await cdp.evaluate('window.__spaceDev.canvasRect()')
  const x = Math.round(rect.x + rect.width / 2)
  const y = Math.round(rect.y + rect.height / 2)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  const camera = () => cdp.evaluate('(() => { const s = window.__spaceDev.state(); return JSON.stringify([s.center, s.zoom]) })()')
  const from = await camera()
  const start = Date.now()
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
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: pinch ? 2 : 0, pointerType: 'mouse' })
    events++
    await sleep(14)
  }
  return { events, moved }
}

/** Measure for this many seconds, with work running beside it. A phase starts the meter new, so its 10 s window holds only this phase. */
async function measure(cdp, seconds, work) {
  await cdp.evaluate('window.__spaceDev.perf.stop(); window.__spaceDev.perf.start()')
  const motion = work?.(seconds * 1000)
  const reads = []
  const utilization = []
  const processes = []
  const start = Date.now()
  for (let i = 1; i <= seconds; i++) {
    await sleep(Math.max(0, start + i * 1000 - Date.now()))
    const [read, gpu] = await Promise.all([cdp.evaluate('window.__spaceDev.perf.read()'), gpuUtilization()])
    reads.push(read)
    utilization.push(gpu)
    if (i === Math.ceil(seconds / 2)) processes.push(...(await topProcesses()))
  }
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
        resolution: Math.min(...worlds.map((w) => w.resolution)),
        megapixels: of('megapixels'),
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

/** CPU seconds so far of the app's processes, and of the window server. */
async function processTimes(main) {
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
  const sampleFile = join(OUT, `sample-${scene}.txt`)
  if (busiest) await run('sample', [String(busiest.pid), '5', '1', '-file', sampleFile]).catch(() => undefined)
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
  const group = (name) => (name.includes('Renderer') ? 'renderer' : name.includes('GPU') ? 'gpu' : name === 'WindowServer' ? 'windowserver' : 'other')
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
  const deadline = Date.now() + 60_000
  while ((await sceneHook(cdp))?.playing) {
    if (Date.now() > deadline) throw new Error(`scene ${scene} did not end in 60 s`)
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

async function runScene(scene, { tune: given, label, seconds, dev, profile, burst, noPan, capped, identity }) {
  const tune = capped ? given : { uncapped: 1, ...given }
  if (tune) process.env.SPACE_WORLD_TUNE = JSON.stringify(tune)
  else delete process.env.SPACE_WORLD_TUNE
  const state = await startInstance({ name: NAME, mcpPort: MCP_PORT, debugPort: DEBUG_PORT, built: !dev, fresh: true })
  const lines = []
  let cdp = null
  try {
    cdp = await cdpConnect(DEBUG_PORT)
    if (burst) {
      await burstScene(scene, state, cdp)
      return []
    }
    if (scene === 'ink') await seedInk(state, cdp)
    else await playScene(scene, state, cdp)
    if (profile) {
      await profileScene(scene, state, cdp)
      return []
    }
    const motion = (ms) => panAndZoom(cdp, ms)
    const size = await cdp.evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState, zoom: window.__spaceDev.state().zoom })')
    const windowAt = await windowShare(state.pids)
    const base = { at: new Date().toISOString(), scene, label, mode: dev ? 'dev' : 'built', uncapped: !capped, tune: tune ?? null, ...identity, window: { ...size, visibleShare: windowAt?.share ?? null, x: windowAt?.x ?? null, y: windowAt?.y ?? null, width: windowAt?.width ?? size.width, height: windowAt?.height ?? size.height } }
    lines.push({ ...base, phase: scene === 'ink' ? 'pan' : 'hold', ...(await measure(cdp, seconds, scene === 'ink' ? motion : null)) })
    if (scene === 'film' && !noPan) lines.push({ ...base, phase: 'pan', ...(await measure(cdp, PAN_SECONDS, motion)) })
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
const COLUMNS = [
  ['scene', (l) => `${l.scene}${l.phase === 'pan' ? ':pan' : ''}`],
  ['pict/s', (l) => fixed(l.world?.picturesPerSecond)],
  ['GPU ms', (l) => fixed(l.world?.gpuMs)],
  ['p95', (l) => fixed(l.world?.gpuMsP95)],
  ['timer', (l) => l.world?.gpuSource ?? '-'],
  ['wall ms', (l) => fixed(l.world?.pictureMs)],
  ['CPU ms', (l) => fixed(l.world?.cpuMs)],
  ['fps', (l) => fixed(l.fps, 0)],
  ['worst', (l) => fixed(l.worstFrameMs, 0)],
  ['drop', (l) => fixed(l.droppedFrames, 0)],
  ['long', (l) => fixed(l.longTasks, 0)],
  ['draws', (l) => fixed(l.world?.drawCalls, 0)],
  ['tris', (l) => fixed(l.world?.triangles, 0)],
  ['pass', (l) => fixed(l.world?.passes, 0)],
  ['MP', (l) => fixed(l.world?.megapixels, 2)],
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
  if (line.window.visibility !== 'visible') found.push(`the page is ${line.window.visibility}`)
  if (!line.fps) found.push('no paints')
  if (line.scene !== 'ink') {
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
    rows.push(`| ${l.at.slice(0, 10)} | ${l.commit}${l.dirty ? '+' : ''} | ${l.mode} | ${l.scene}${l.phase === 'pan' ? ':pan' : ''} | ${l.tune ? `\`${JSON.stringify(l.tune)}\`` : ''} | ${l.label ?? ''} | ${fixed(l.world?.picturesPerSecond)} | ${fixed(l.world?.gpuMs)} | ${l.world?.gpuSource ?? ''} | ${fixed(l.fps, 0)} | ${fixed(l.worstFrameMs, 0)} | ${fixed(l.droppedFrames, 0)} | ${fixed(l.world?.drawCalls, 0)} | ${fixed(l.world?.megapixels, 2)} | ${fixed(l.gpuUtilization, 0)} | ${fixed(l.load?.[0], 2)} |`)
  }
  mkdirSync(OUT, { recursive: true })
  writeFileSync(REPORT, `${rows.join('\n')}\n`)
  console.log(`report: ${REPORT}`)
}

async function main() {
  if (flag('--report')) return writeReport(readHistory())
  const scenes = option('--scenes', ALL_SCENES.join(',')).split(',').filter(Boolean)
  for (const scene of scenes) if (!ALL_SCENES.includes(scene)) throw new Error(`Unknown scene "${scene}". Scenes: ${ALL_SCENES.join(', ')}`)
  const matrix = option('--matrix', null)
  if (matrix && scenes.length !== 1) throw new Error('--matrix runs one scene: give one with --scenes.')
  const tune = option('--tune', null)
  const tunes = matrix ? JSON.parse(matrix) : [tune ? JSON.parse(tune) : null]
  const common = { label: option('--label', null), seconds: Number(option('--seconds', '10')), dev: flag('--dev'), profile: flag('--profile'), burst: flag('--burst'), capped: flag('--capped'), noPan: flag('--no-pan'), identity: codeIdentity() }
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
