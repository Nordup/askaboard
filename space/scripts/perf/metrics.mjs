/**
 * Shared parts of the perf scripts: paths, the code identity, and the numbers
 * computed from a run's tool calls (trace format: t, end, duration_ms, tool,
 * args, ok, result_text, images).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { LAB, SPACE } from '../lab/common.mjs'

export const PERF = join(SPACE, '.lab/perf')
export const PERF_RUNS = join(PERF, 'runs')
export const HISTORY = join(PERF, 'history.jsonl')
const REPO = resolve(SPACE, '..')

export function appendHistory(metrics) {
  mkdirSync(PERF, { recursive: true })
  appendFileSync(HISTORY, `${JSON.stringify(metrics)}\n`)
}

/** Which code was measured: HEAD, and a short hash of the uncommitted changes in space/src and space/resources. */
export function codeIdentity() {
  const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  const paths = ['space/src', 'space/resources']
  const commit = git('rev-parse', '--short=12', 'HEAD').trim()
  const diff = git('diff', 'HEAD', '--', ...paths)
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', ...paths).split('\n').filter(Boolean).sort()
  const h = createHash('sha256').update(diff)
  for (const f of untracked) {
    h.update(`\0${f}\0`)
    h.update(readFileSync(join(REPO, f)))
  }
  const dirty = diff.length > 0 || untracked.length > 0
  return { commit, dirty, diff_hash: dirty ? h.digest('hex').slice(0, 10) : null, untracked_files: untracked.length }
}

// ---------- Small helpers ----------

export const round = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d)
export function median(values) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const max = (values) => (values.length ? Math.max(...values) : null)

/** Total length of the union of [from, to] intervals (ms). Parallel calls count once. */
export function unionMs(spans) {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  let total = 0
  let cur = null
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0]
      cur = [a, b]
    } else cur[1] = Math.max(cur[1], b)
  }
  if (cur) total += cur[1] - cur[0]
  return total
}

/** The full length of a string the trace may have cut ("…[cut: N chars in all]"). */
export function fullLength(text) {
  if (typeof text !== 'string') return 0
  const m = /…\[cut: (\d+) chars in all\]$/.exec(text)
  return m ? Number(m[1]) : text.length
}
export const wasCut = (text) => typeof text === 'string' && /…\[cut: \d+ chars in all\]$/.test(text)

/** Any string in a (trace-capped) args object was cut. */
export function argsCut(value, depth = 0) {
  if (typeof value === 'string') return wasCut(value)
  if (value === null || typeof value !== 'object' || depth > 24) return false
  return Object.values(value).some((v) => argsCut(v, depth + 1))
}

/** Characters the model wrote into one call's arguments (the JSON of the args, with cut strings at full length). */
export function argsChars(args) {
  const json = JSON.stringify(args ?? {})
  let extra = 0
  const walk = (v, depth = 0) => {
    if (typeof v === 'string') {
      if (wasCut(v)) extra += fullLength(v) - v.length
    } else if (v && typeof v === 'object' && depth <= 24) for (const x of Object.values(v)) walk(x, depth + 1)
  }
  walk(args)
  return json.length + extra
}

/** difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() of each code against the one before it (null for the first). */
export function similarities(codes) {
  if (codes.length < 2) return codes.map(() => null)
  const script = 'import sys,json,difflib\nc=json.load(sys.stdin)\nprint(json.dumps([None]+[difflib.SequenceMatcher(None,c[i-1],c[i],autojunk=False).ratio() for i in range(1,len(c))]))'
  const out = execFileSync('python3', ['-I', '-c', script], { input: JSON.stringify(codes), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(out)
}

/** Width × height of a PNG file from its header, or null. */
function pngSize(file) {
  try {
    const fd = openSync(file, 'r')
    const b = Buffer.alloc(24)
    readSync(fd, b, 0, 24, 0)
    closeSync(fd)
    if (b.toString('ascii', 12, 16) !== 'IHDR') return null
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  } catch {
    return null
  }
}

function indexFiles(dir, ext) {
  const found = new Map()
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(ext)) found.set(e.name, p)
    }
  }
  walk(dir)
  return found
}

const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------- The numbers ----------

/**
 * The numbers of one run's tool calls. t0: the run's start (wall ms). wallEnd:
 * the end of the agent's work (wall ms). tracesDir: for the screenshot sizes.
 */
export function callMetrics(calls, { t0, wallEnd, tracesDir = null }) {
  const at = (c) => Date.parse(c.t)
  const endOf = (c) => Date.parse(c.end ?? c.t)
  const s = (ms) => round(ms / 1000, 2)
  // The scene tools since 2026-10-26 (write_scene, preview_scene, play_scene) and run_scene / scene_control before: the same counts.
  // Program text: write_scene code (new) or run_scene code (old). Previews: preview_scene calls or run_scene with preview.
  // Plays: play_scene start or run_scene without preview.
  const isOldPreview = (c) => c.tool === 'run_scene' && c.args?.preview
  const isPlay = (c) => (c.tool === 'run_scene' && !c.args?.preview) || (c.tool === 'play_scene' && c.args?.action === 'start')
  const programs = calls.filter((c) => c.tool === 'run_scene' || c.tool === 'write_scene')
  const previews = calls.filter((c) => isOldPreview(c) || c.tool === 'preview_scene')
  const plays = calls.filter(isPlay)
  const sceneErrors = calls.filter((c) => !c.ok && (c.tool === 'run_scene' || c.tool === 'write_scene' || (c.tool === 'play_scene' && c.args?.action === 'start')))
  const sceneWaits = calls.filter((c) => (c.tool === 'scene_control' || c.tool === 'play_scene') && c.args?.action === 'wait')
  const playWaits = plays.filter((c) => c.args?.wait === 'end')

  // When the last scene ends: each play's end + ends_in_s, or its return with wait "end".
  let doneMs = null
  for (const c of plays) {
    if (!c.ok) continue
    const r = parse(c.result_text)
    if (!r) continue
    const end = r.played !== undefined ? endOf(c) : endOf(c) + (typeof r.ends_in_s === 'number' ? r.ends_in_s : (r.starts_in_s ?? 0) + (r.length_s ?? r.duration_s ?? 0)) * 1000
    doneMs = Math.max(doneMs ?? 0, end)
  }

  const toolMs = unionMs(calls.map((c) => [at(c), endOf(c)]))
  const wallMs = wallEnd - t0

  // Written.
  const perTool = {}
  for (const c of calls) {
    const p = (perTool[c.tool] ??= { calls: 0, errors: 0, ms: 0, written: 0, read: 0 })
    p.calls++
    if (!c.ok) p.errors++
    p.ms += c.duration_ms ?? endOf(c) - at(c)
    p.written += argsChars(c.args)
    p.read += fullLength(c.result_text)
  }
  const codes = programs.map((c) => (typeof c.args?.code === 'string' ? c.args.code : ''))
  const ratios = similarities(codes)
  let repeatChars = 0
  const codeChars = codes.reduce((n, code) => n + fullLength(code), 0)
  ratios.forEach((r, i) => {
    if (r !== null && r >= 0.9) repeatChars += fullLength(codes[i])
  })

  // Read.
  const pngs = tracesDir ? indexFiles(tracesDir, '.png') : new Map()
  let images = 0
  let imageBytes = 0
  let imagePixels = 0
  let pixelsUnknown = 0
  for (const c of calls)
    for (const img of c.images ?? []) {
      images++
      imageBytes += img.bytes ?? 0
      const size = pngs.has(img.file) ? pngSize(pngs.get(img.file)) : null
      if (size) imagePixels += size.w * size.h
      else pixelsUnknown++
    }
  const resultsCut = calls.filter((c) => wasCut(c.result_text)).length

  const ms = (list) => list.map((c) => c.duration_ms ?? endOf(c) - at(c))
  return {
    time: {
      wall: s(wallMs),
      first_call: calls.length ? s(at(calls[0]) - t0) : null,
      first_scene: programs.length ? s(at(programs[0]) - t0) : null,
      first_play: plays.length ? s(at(plays[0]) - t0) : null,
      done: doneMs !== null ? s(doneMs - t0) : null,
      tool_s: s(toolMs),
      agent_s: s(Math.max(0, wallMs - toolMs))
    },
    calls: {
      total: calls.length,
      errors: calls.filter((c) => !c.ok).length,
      per_tool: Object.fromEntries(Object.entries(perTool).map(([k, v]) => [k, v.calls])),
      scene_previews: previews.length,
      scene_plays: plays.length,
      scene_errors: sceneErrors.length,
      scene_wait_end: playWaits.length,
      scene_waits: sceneWaits.length
    },
    written: {
      total: calls.reduce((n, c) => n + argsChars(c.args), 0),
      scene_code: codeChars,
      repeat_chars: repeatChars,
      repeat_share: codeChars ? round(repeatChars / codeChars, 3) : null,
      similarity_to_previous: ratios.map((r) => round(r, 3))
    },
    read: {
      result_chars: calls.reduce((n, c) => n + fullLength(c.result_text), 0),
      results_cut_in_trace: resultsCut,
      images,
      image_bytes: imageBytes,
      image_pixels: imagePixels,
      images_without_size: pixelsUnknown
    },
    app: {
      preview_ms_median: median(ms(previews)),
      preview_ms_max: max(ms(previews)),
      play_ms_median: median(ms(plays)),
      play_ms_max: max(ms(plays)),
      wait_ms_total: ms([...sceneWaits, ...playWaits]).reduce((a, b) => a + b, 0)
    },
    per_tool: perTool
  }
}

/** The frame-changes.py result for screencast frames (times in ms from t0). */
export function frameChanges(frames, rect, t0, framesDir) {
  const spec = join(framesDir, 'frames-in.json')
  writeFileSync(spec, JSON.stringify({ frames: frames.map((f) => ({ file: f.file, t: f.t - t0 })), rect, cssW: frames[0]?.w ?? null }))
  return JSON.parse(execFileSync('python3', ['-I', join(LAB, 'frame-changes.py'), spec], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
}

// ---------- Playback frame times ----------

/**
 * A page script for the app window (Runtime.evaluate). It records each
 * animation frame while a scene plays and is not paused (the dev hook
 * window.__spaceDev.scene). Per frame it keeps two times:
 * - interval: the time from the frame before. The learner sees this time; a long one is a stall.
 * - work: the time from the frame's start to the first task after its
 *   rendering. This is the main thread's work for the frame (rAF callbacks,
 *   style, layout, paint).
 * Install it before the first call. collectFrames reads it.
 */
export const FRAME_METER = `(() => {
  if (window.__perfFrames) return true
  const meter = (window.__perfFrames = { frames: [] })
  const channel = new MessageChannel()
  let last = null
  let pending = null
  channel.port1.onmessage = () => {
    if (!pending) return
    pending.work = performance.now() - pending.start
    meter.frames.push(pending)
    pending = null
  }
  const tick = (start) => {
    const hook = window.__spaceDev && window.__spaceDev.scene
    const scene = hook ? (typeof hook === 'function' ? hook() : hook) : null
    const playing = Boolean(scene && scene.playing && !scene.paused)
    if (playing && last !== null && !pending) {
      pending = { start, interval: start - last }
      channel.port2.postMessage(0)
    }
    last = playing ? start : null
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
})()`

/** The frames that the meter recorded: [interval ms, work ms], to 0.1 ms. */
export async function collectFrames(cdp) {
  try {
    return (await cdp.evaluate('(window.__perfFrames ? window.__perfFrames.frames : []).map((f) => [Math.round(f.interval * 10) / 10, Math.round(f.work * 10) / 10])')) ?? []
  } catch {
    return []
  }
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null)

/** The median, the 95th percentile and the worst value of the frame intervals and of the work times, and the count of frames longer than 50 ms. */
export function frameStats(frames) {
  const intervals = frames.map((f) => f[0]).sort((a, b) => a - b)
  const work = frames.map((f) => f[1]).sort((a, b) => a - b)
  const stats = (sorted) => ({ median: round(median(sorted), 1), p95: round(quantile(sorted, 0.95), 1), max: round(sorted.length ? sorted[sorted.length - 1] : null, 1) })
  return { count: frames.length, interval_ms: stats(intervals), work_ms: stats(work), long_50ms: intervals.filter((v) => v > 50).length }
}
