#!/usr/bin/env node
/**
 * Record a scene as a fixed-clock video: frame k shows scene time t0 + k/fps exactly, however long a frame takes to make.
 *
 *   node scripts/lab/record.mjs <job.json> [--copies 8] [--frames a-b] [--port 47950] [--keep-frames] [--no-audio]
 *
 * The job (paths relative to the job file):
 *   { "name": "inkland", "id": "inkland", "src": "inkland/src", "board": "Inkland", "scene": "inkland/scene.js",
 *     "camera": { "center": [0, 30], "zoom": 0.79 }, "fonts": "fonts", "fps": 60, "t0": 0, "frames": 4232,
 *     "mode": "board" | "node", "hidePanel": false, "stepFromStart": false,
 *     "viewport": [1280, 770], "boardHeight": 660, "width": 1920, "work": "~/.cache/ls-record/inkland", "out": "inkland.mp4" }
 * name: the scene's name; id (default name): a short word for the copies' folders. src holds <board>.board.json, scenes/, and optionally assets/ and voice/ (the voice clips of the scene record).
 * fonts: .ttf files that the copies get in their own HOME. mode "node": the clip is the scene's first world alone.
 * stepFromStart: the world integrates over its own frames, so each copy draws every frame from the start.
 *
 * It starts --copies lab apps (built: run `npm run build` first; under a headless mutter each on Linux without a
 * display), gives each a slice of the frames, and for each frame calls the dev hook scene.frameAt(t): the scene held at t,
 * every world drawn at exactly t, the page painted. Then one screenshot. The caption panel shows its playing look.
 * Then ffmpeg makes H.264 at fps, with the voice clips placed by scene time (AAC), into <out> and a poster <out>.jpg.
 * The frames stay in <work>/frames (deleted at the end unless --keep-frames). Ports: MCP <port>+i, debug <port>+100+i.
 * Repeated frames (a frame equal to the one before) are counted and listed in <work>/report.json.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { alive, args, cdpConnect, childPids, FFMPEG, instance, log, portInUse, resultText, sleep, startInstance, stopInstance, stopPids, withMcp } from './common.mjs'

const { option, flag, positional } = args()
if (!positional[0]) {
  console.log('usage: node scripts/lab/record.mjs <job.json> [--copies 8] [--frames a-b] [--port 47950] [--keep-frames] [--no-audio]')
  process.exit(1)
}
const jobFile = resolve(positional[0])
const job = JSON.parse(readFileSync(jobFile, 'utf8'))
const at = (p) => resolve(dirname(jobFile), p.replace(/^~(?=\/)/, homedir()))
const copies = Number(option('--copies', '8'))
const port = Number(option('--port', '47950'))
const work = at(job.work)
const frameDir = join(work, 'frames')
// Frame k's time. Each frame is 1 ns later than k/fps: a world that steps a fixed dt over the time between its frames
// (an accumulator, as Neuron's) then steps exactly once per 1/60 s frame. With k/fps alone the float difference of two
// frame times falls below 1/60 on every other frame, and such a world skips a step and takes two on the next frame.
const timeOf = (k, duration) => Math.min(job.t0 + k / job.fps + k * 1e-9, duration)
const S = 'window.__spaceDev.scene'
mkdirSync(frameDir, { recursive: true })

// ---------- The copies ----------

const headless = process.platform === 'linux' && !process.env.WAYLAND_DISPLAY && !process.env.DISPLAY
const started = [] // { name, pids: [compositor PIDs] }

/** A copy's learning folder: the board, its scenes, assets and voice clips; its HOME: the fonts; its state: the camera. */
function setUp(name) {
  const inst = instance(name)
  rmSync(inst.dir, { recursive: true, force: true })
  const src = at(job.src)
  const fonts = join(inst.home, '.local/share/fonts')
  mkdirSync(fonts, { recursive: true })
  mkdirSync(join(inst.home, '.config/fontconfig'), { recursive: true })
  if (job.fonts) for (const f of readdirSync(at(job.fonts))) copyFileSync(join(at(job.fonts), f), join(fonts, f))
  writeFileSync(join(inst.home, '.config/fontconfig/fonts.conf'), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>${fonts}</dir></fontconfig>\n`)
  if (process.platform === 'linux') try { execFileSync('fc-cache', ['-f'], { env: { ...process.env, HOME: inst.home }, stdio: 'ignore' }) } catch { /* no fontconfig tools */ }
  // The lab template first (lab.mjs makes it when AGENTS.md is missing), then the job's board over it.
  const template = resolve(dirname(new URL(import.meta.url).pathname), '../../resources/learning-folder')
  cpSync(template, inst.folder, { recursive: true })
  mkdirSync(join(inst.folder, 'boards/scenes'), { recursive: true })
  cpSync(join(src, 'scenes'), join(inst.folder, 'boards/scenes'), { recursive: true })
  if (existsSync(join(src, 'assets'))) cpSync(join(src, 'assets'), join(inst.folder, 'assets'), { recursive: true })
  if (existsSync(join(src, 'voice'))) cpSync(join(src, 'voice'), join(inst.folder, '.learning-space/voice'), { recursive: true })
  copyFileSync(join(src, `${job.board}.board.json`), join(inst.folder, `boards/${job.board}.board.json`))
  const key = `${inst.folder}::boards/${job.board}.board.json`
  mkdirSync(inst.userData, { recursive: true })
  writeFileSync(join(inst.userData, 'state.json'), JSON.stringify({ interfaceSize: 1, uncappedFrames: true, lastFolder: inst.folder, recent: [inst.folder], trustedFolders: [inst.folder], cameras: { [key]: job.camera }, lastBoards: { [inst.folder]: `boards/${job.board}.board.json` } }))
  return inst
}

/** Linux without a display: a headless mutter with one virtual monitor for this copy. */
async function compositor(name) {
  const display = `ls-rec-${name}`
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`
  const child = spawn('dbus-run-session', ['--', 'mutter', '--headless', '--wayland', '--no-x11', '--virtual-monitor', '1920x1200@60', '--wayland-display', display], { stdio: 'ignore', detached: true, env: { ...process.env, XDG_RUNTIME_DIR: runtime } })
  child.unref()
  for (let i = 0; i < 40 && !existsSync(join(runtime, display)); i++) await sleep(250)
  if (!existsSync(join(runtime, display))) throw new Error(`mutter for ${name} did not start`)
  return { display, pid: child.pid }
}

async function startCopy(i) {
  const name = `rec-${job.id ?? job.name}-${i}`
  const inst = setUp(name)
  const entry = { name, pids: [] }
  started.push(entry)
  const env = { ...process.env }
  if (headless) {
    const c = await compositor(name)
    entry.pids.push(c.pid)
    Object.assign(process.env, { WAYLAND_DISPLAY: c.display, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', LS_NATIVE_WAYLAND: '1' })
  }
  process.env.LEARNING_SPACE_TELEMETRY_ENABLED = 'false'
  // startInstance reads the environment when it spawns: one copy at a time.
  const state = await startInstance({ name, mcpPort: port + i, debugPort: port + 100 + i, built: true, spawnOnly: true })
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
  Object.assign(process.env, env)
  return { ...state, inst }
}

async function waitReady(copy) {
  const deadline = Date.now() + 180_000
  while (!(await portInUse(copy.mcpPort))) {
    if (Date.now() > deadline || !alive(copy.launcher)) throw new Error(`${copy.name}: no MCP port; see ${copy.inst.log}`)
    await sleep(500)
  }
  for (;;) {
    try {
      const cdp = await cdpConnect(copy.debugPort)
      if (await cdp.evaluate('typeof window.__spaceDev === "object" && !!window.__spaceDev.state().board')) return cdp
      cdp.close()
    } catch {
      // Still loading.
    }
    if (Date.now() > deadline) throw new Error(`${copy.name}: no board; see ${copy.inst.log}`)
    await sleep(500)
  }
}

async function stopAll() {
  for (const entry of started) {
    await stopInstance(entry.name).catch(() => undefined)
    // The compositor: dbus-run-session, its mutter and its bus, by their exact PIDs.
    await stopPids(entry.pids.flatMap((pid) => [...childPids(pid), pid]))
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void stopAll().then(() => process.exit(1)))

// ---------- One slice ----------

/** The scene playing, the capture area, and the panel's playing look. */
async function prepare(copy, cdp) {
  const metrics = (dsf) => cdp.send('Emulation.setDeviceMetricsOverride', { width: job.viewport[0], height: job.viewport[1], deviceScaleFactor: dsf, mobile: false })
  // The panel's ease has no real-time lag: it shows the held time at once.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  // The final layout before the scene starts: a scene that fits the camera to a box fits it to this canvas.
  await metrics(1)
  await sleep(1500)
  if (job.hidePanel) await cdp.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '.script-panel{display:none!important}'; document.head.appendChild(s) })()`)
  const written = resultText(await withMcp(copy.mcpPort, (c) => c('write_scene', { name: job.name, file: job.scene })))
  if (/error/i.test(written.slice(0, 200)) && !/"voice"/.test(written)) throw new Error(`${copy.name}: write_scene: ${written.slice(0, 300)}`)
  const r = JSON.parse(resultText(await withMcp(copy.mcpPort, (c) => c('play_scene', { action: 'start', name: job.name }))))
  await cdp.evaluate(`${S}.frameAt(0)`)
  let pauseSvg = null
  if (!job.hidePanel) {
    await cdp.evaluate(`${S}.seek(null)`)
    await sleep(400)
    pauseSvg = await cdp.evaluate(`document.querySelector('.script-panel__footer [aria-label="Pause"]')?.innerHTML ?? null`)
    await cdp.evaluate(`${S}.frameAt(0)`)
    if (!pauseSvg) throw new Error(`${copy.name}: the panel has no pause button`)
  }
  // A world that integrates its own frames starts again at 0 (a jump forward and back starts a new generation), so every copy
  // steps it from the same state: the scene played a moment in real time before it was held.
  if (job.stepFromStart) {
    await cdp.evaluate(`${S}.frameAt(1)`)
    await cdp.evaluate(`${S}.frameAt(0)`)
  }
  const liveId = await cdp.evaluate('(window.__spaceDev.live.items()[0] || {}).id ?? null')
  const box = async () => (job.mode === 'node' ? cdp.evaluate(`window.__spaceDev.nodeRect(${JSON.stringify(liveId)})`) : cdp.evaluate('window.__spaceDev.canvasRect()'))
  // The scale: the captured area is job.width px wide.
  const dsf = job.width / (await box()).width
  await metrics(dsf)
  await sleep(1500)
  const b = await box()
  const clip = job.mode === 'node' ? { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 } : { x: b.x, y: b.y, width: b.width, height: job.boardHeight, scale: 1 }
  // The panel's playing look without touching React's children (a replaced child crashes React's next update): classes and
  // the status text are set before each shot, and the pause icon is a CSS image over the hidden play icon.
  if (pauseSvg !== null) {
    const color = await cdp.evaluate(`getComputedStyle(document.querySelector('.script-panel__footer [aria-label="Play"]')).color`)
    const icon = pauseSvg.replace(/currentColor/g, color)
    const size = (/width="(\d+)"/.exec(icon) || [0, '14'])[1]
    const uri = 'data:image/svg+xml;utf8,' + encodeURIComponent(icon)
    const css = `.script-panel__footer [aria-label="Play"] > svg{display:none!important}.script-panel__footer [aria-label="Play"]::after{content:"";display:block;width:${size}px;height:${size}px;background:url("${uri}") center/contain no-repeat}`
    await cdp.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s) })()`)
  }
  return { steps: r.steps, duration: r.length_s, clip, dsf, panel: pauseSvg !== null }
}

const panelPatch = (n, total) => {
  const text = JSON.stringify(`Step ${n} of ${total}`)
  return `(() => { const p = document.querySelector('.script-panel'); if (!p) return
  p.classList.add('is-playing'); p.querySelector('.status-dot')?.classList.add('status-dot--play')
  const s = p.querySelector('.script-panel__status'); if (s && s.textContent !== ${text}) s.textContent = ${text} })()`
}

async function renderSlice(copy, cdp, from, to, progress) {
  const scene = await prepare(copy, cdp)
  const ms = { frameAt: 0, shot: 0 }
  const frameAt = async (t) => {
    const s = performance.now()
    const r = await cdp.evaluate(`${S}.frameAt(${t})`)
    ms.frameAt += performance.now() - s
    if (!r.ok) throw new Error(`${copy.name}: at t=${t} the worlds ${r.behind.join(', ')} showed no picture of t within 20 s`)
  }
  // The slice start. A world that integrates its own frames: every frame from the start, as slice 1 made them.
  // Any other: one jump (a world then steps from the scene start by itself), then 1 s of frames.
  const k0 = job.stepFromStart ? 0 : Math.max(0, from - job.fps)
  if (!job.stepFromStart && k0 > 0) {
    // The jump: a world steps all ticks from the start, which can take longer than one frameAt waits.
    for (let i = 0; ; i++) {
      const r = await cdp.evaluate(`${S}.frameAt(${timeOf(k0, scene.duration)})`)
      if (r.ok) break
      if (i === 5) throw new Error(`${copy.name}: the worlds ${r.behind.join(', ')} did not reach t=${timeOf(k0, scene.duration)}`)
    }
  }
  for (let k = k0; k < from; k++) await frameAt(timeOf(k, scene.duration))
  const began = Date.now()
  let prev = null, repeats = 0
  for (let k = from; k <= to; k++) {
    const t = timeOf(k, scene.duration)
    await frameAt(t)
    if (scene.panel) await cdp.evaluate(panelPatch(scene.steps.filter((s) => s.at_s <= t + 1e-6).length || 1, scene.steps.length))
    const s = performance.now()
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: scene.clip, optimizeForSpeed: true })
    ms.shot += performance.now() - s
    if (data === prev) repeats++
    prev = data
    await writeFile(join(frameDir, `f${String(k).padStart(6, '0')}.png`), Buffer.from(data, 'base64'))
    progress.done++
  }
  return { from, to, seconds: (Date.now() - began) / 1000, repeats, frameAtMs: Math.round(ms.frameAt / (to - k0 + 1)), shotMs: Math.round(ms.shot / (to - from + 1)), scene }
}

// ---------- The voice track (the scene record's lines at their scene times) ----------

function readWav(file) {
  const b = readFileSync(file)
  let rate = 0, channels = 1, bits = 16, data = null
  for (let p = 12; p + 8 <= b.length; ) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4)
    if (id === 'fmt ') {
      channels = b.readUInt16LE(p + 10)
      rate = b.readUInt32LE(p + 12)
      bits = b.readUInt16LE(p + 22)
    } else if (id === 'data') data = b.subarray(p + 8, p + 8 + size)
    p += 8 + size + (size & 1)
  }
  if (bits !== 16 || channels !== 1 || !data) throw new Error(`${file}: only 16-bit mono PCM`)
  return { rate, samples: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) }
}

function writeWav(file, rate, samples) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + samples.length * 2, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(samples.length * 2, 40)
  writeFileSync(file, Buffer.concat([h, Buffer.from(samples.buffer)]))
}

/**
 * Each voiced line's clip part at its scene time, as the app's player places it (clip position = from + (t - at)).
 * The hold fix: where the scene holds between two lines of one clip, the app pauses the clip at the line's end, 50 ms
 * before the next word, and a soft onset (a breath, an "s") is cut from its word. Here the hold's silence goes at the
 * quietest 10 ms of the natural pause between the lines, with 4 ms fades, and every word still starts at its own time.
 */
function voiceTrack(folder, total, out) {
  const dir = join(folder, '.learning-space/scenes')
  const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'))
  if (!file) return null
  const records = readFileSync(join(dir, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const rec = records[records.length - 1]
  const cues = rec.story.lines.filter((c) => c.voice)
  if (!cues.length) return null
  const answers = new Map()
  for (const [q, a] of rec.source.answers ?? []) if (q.includes('"voiceLine"')) answers.set(JSON.parse(q).text, JSON.parse(a))
  const clips = new Map()
  let rate = 0
  for (const c of cues) if (!clips.has(c.voice.clip)) { const w = readWav(join(folder, c.voice.clip)); rate = w.rate; clips.set(c.voice.clip, w.samples) }
  const FADE = Math.round(0.004 * rate)
  const mix = new Int16Array(Math.round(total * rate))
  const quietest = (src, a, b) => {
    const win = Math.round(0.01 * rate)
    let best = Infinity, mid = Math.floor((a + b) / 2)
    for (let s = a; s < Math.max(a + 1, b - win); s += Math.round(0.002 * rate)) {
      let e = 0
      for (let j = s; j < s + win; j++) e += (src[j] ?? 0) ** 2
      if (e < best) { best = e; mid = s + Math.floor(win / 2) }
    }
    return mid
  }
  const pieces = cues.map((c) => [c.voice.clip, Math.round(c.voice.from * rate), Math.round((c.voice.from + c.dur) * rate), Math.round((c.at - job.t0) * rate)])
  for (let i = 0; i + 1 < pieces.length; i++) {
    const a = pieces[i], b = pieces[i + 1]
    const contiguous = a[0] === b[0] && Math.abs(a[2] - b[1]) <= 2
    const hold = b[3] - (a[3] + a[2] - a[1])
    if (contiguous && hold > 2) {
      const pauseFrom = Math.round(answers.get(cues[i].text).speech_end * rate) + Math.round(0.02 * rate)
      const pauseTo = b[1] + Math.round(0.03 * rate)
      if (pauseTo - pauseFrom > Math.round(0.03 * rate)) {
        const p = quietest(clips.get(a[0]), pauseFrom, pauseTo)
        b[3] -= b[1] - p // the part of the pause after p moves with line b: its words keep their time
        b[1] = p
        a[2] = p
      }
    } else if (contiguous) b[3] = a[3] + (a[2] - a[1]) // one sound: no gap, no overlap
  }
  pieces.forEach(([clip, s0, s1, d0], k) => {
    let seg = clips.get(clip).slice(s0, s1)
    const p = pieces[k - 1], n = pieces[k + 1]
    const prevJoined = p && p[0] === clip && p[2] === s0 && p[3] + (p[2] - p[1]) === d0
    const nextJoined = n && n[0] === clip && n[1] === s1 && d0 + (s1 - s0) === n[3]
    for (let j = 0; j < Math.min(FADE, seg.length); j++) {
      const g = 0.5 - 0.5 * Math.cos((Math.PI * (j + 0.5)) / FADE)
      if (!prevJoined) seg[j] = Math.trunc(seg[j] * g)
      if (!nextJoined) seg[seg.length - 1 - j] = Math.trunc(seg[seg.length - 1 - j] * g)
    }
    if (d0 < 0) { seg = seg.slice(-d0); d0 = 0 }
    mix.set(seg.subarray(0, Math.max(0, mix.length - d0)), d0)
  })
  writeWav(out, rate, mix)
  return cues.map((c) => ({ video_s: Math.round((c.at - job.t0) * 1000) / 1000, text: c.text }))
}

// ---------- Run ----------

const t0 = Date.now()
const frames = job.frames
const [a, b] = option('--frames') ? option('--frames').split('-').map(Number) : [0, frames - 1]
const n = Math.min(copies, b - a + 1)
log('record', `${job.name}: frames ${a}-${b} on ${n} copies${headless ? ' (headless mutter)' : ''}`)
let slices
const load = []
try {
  const list = []
  for (let i = 1; i <= n; i++) list.push(await startCopy(i))
  const cdps = await Promise.all(list.map(waitReady))
  log('record', `${n} copies up in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  const size = Math.ceil((b - a + 1) / n)
  const progress = { done: 0 }
  // The machine's CPU use (all cores, from /proc/stat) every 15 s.
  const cpuNow = () => { const v = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); return { idle: v[3] + v[4], all: v.reduce((x, y) => x + y, 0) } }
  let cpuBefore = process.platform === 'linux' ? cpuNow() : null
  const sampler = setInterval(() => {
    const c = cpuNow(), busy = Math.round(100 * (1 - (c.idle - cpuBefore.idle) / (c.all - cpuBefore.all)))
    cpuBefore = c
    load.push(busy)
    log('record', `${progress.done} frames, CPU ${busy}%`)
  }, 15000)
  if (process.platform !== 'linux') clearInterval(sampler)
  const renderStart = Date.now()
  slices = await Promise.all(list.map((copy, i) => renderSlice(copy, cdps[i], a + i * size, Math.min(b, a + (i + 1) * size - 1), progress)))
  clearInterval(sampler)
  const renderSeconds = (Date.now() - renderStart) / 1000
  log('record', `rendered ${b - a + 1} frames in ${renderSeconds.toFixed(0)} s (${((b - a + 1) / renderSeconds).toFixed(1)} per s, slices ${slices.map((s) => s.seconds.toFixed(0)).join('/')} s)`)
  for (const c of cdps) c.close()
  // Repeats over the whole run (the slices' seams too): equal files.
  const hashes = []
  for (let k = a; k <= b; k++) hashes.push(createHash('sha1').update(readFileSync(join(frameDir, `f${String(k).padStart(6, '0')}.png`))).digest('hex'))
  const repeated = []
  for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) repeated.push(a + i)
  // The video, when the whole scene was rendered.
  let cues = null
  if (a === 0 && b === frames - 1 && job.out) {
    const out = at(job.out)
    const total = frames / job.fps
    const wav = join(work, 'voice.wav')
    cues = flag('--no-audio') ? null : voiceTrack(list[0].inst.folder, total, wav)
    const audio = cues ? ['-i', wav, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000'] : []
    const vf = `scale=${job.width}:-2:flags=lanczos+accurate_rnd+full_chroma_int:sws_dither=ed:out_range=tv,format=yuv420p`
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-framerate', String(job.fps), '-i', join(frameDir, 'f%06d.png'), ...audio, '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-x264-params', 'aq-mode=3', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-r', String(job.fps), '-t', total.toFixed(4), '-movflags', '+faststart', out], { stdio: 'inherit' })
    // The poster: the last frame.
    execFileSync(FFMPEG, ['-y', '-v', 'error', '-i', join(frameDir, `f${String(frames - 1).padStart(6, '0')}.png`), '-vf', `scale=${job.width}:-2:flags=lanczos`, '-q:v', '3', out.replace(/\.mp4$/, '.jpg')], { stdio: 'inherit' })
    log('record', `wrote ${out}${cues ? ` with ${cues.length} voice lines` : ''}`)
  }
  const report = { job: job.name, frames: b - a + 1, copies: n, wallSeconds: (Date.now() - t0) / 1000, renderSeconds, framesPerSecond: (b - a + 1) / renderSeconds, cpuPercent: load, repeated, cues, slices: slices.map(({ scene, ...s }) => ({ ...s, dsf: scene.dsf, clip: scene.clip })) }
  writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 1))
  log('record', `${repeated.length} repeated frames; wall ${report.wallSeconds.toFixed(0)} s; report ${join(work, 'report.json')}`)
} finally {
  await stopAll()
  if (!flag('--keep-frames') && existsSync(frameDir) && slices) rmSync(frameDir, { recursive: true, force: true })
}
