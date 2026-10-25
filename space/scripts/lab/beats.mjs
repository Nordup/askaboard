#!/usr/bin/env node
/**
 * Send a sequence of calls to the lab app while recording one video: beats
 * (small scenes sent back to back, with gaps like a model writing the next
 * one) and scene_control actions (replace, replay, cut, reset, …).
 *
 *   node scripts/lab/beats.mjs <plan.json> [--lab lab] [--title <text>] [--gap S] [--no-gallery]
 *
 * The plan is a JSON list of steps, run in order:
 *   {"run": "beat-1.js", "name": "beat 1"}       run_scene with that program (path relative to the plan)
 *   {"control": {"action": "replay", "step": "x"}} scene_control; "scene": "$2" means the scene id of the 2nd run
 *   {"replace": "$3", "with": "beat-3b.js"}       scene_control replace of run 3 with that program
 *   {"sleep": 4}                                  seconds
 *   {"until": "idle"}                             wait until nothing plays (pause steps are resumed)
 *   {"until": "time", "scene": "$1", "t": 2.5}    wait until that scene reaches t s
 * --gap S adds a sleep of S s after each run step that has no sleep after it (default 0).
 *
 * The run folder (space/.lab/runs/) gets plan.json, the programs, calls.json
 * (every call with its wall times and result), video-real.mp4, video.mp4, filmstrip.png (a frame at
 * each call), final.png, frames.json (when the board changed) and meta.json
 * with the numbers: time from the first call to the first visible change,
 * and the gaps with no visible change after it.
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import {
  args,
  canvasRect,
  cdpConnect,
  cropFilter,
  cropImage,
  encodeVideo,
  encodeWatchVideo,
  filmstrip,
  frameAt,
  LAB,
  log,
  requireState,
  resultText,
  runFolder,
  SCRATCH,
  sceneHook,
  sleep,
  startRecording,
  withMcp
} from './common.mjs'
import { writeGallery } from './gallery.mjs'

const { option, flag, positional } = args()
const say = (...p) => log('beats', ...p)

async function main() {
  const planPath = positional[0] ? resolve(positional[0]) : null
  if (!planPath) throw new Error('usage: beats.mjs <plan.json> [--lab lab] [--title <text>] [--gap S]')
  const planDir = dirname(planPath)
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
  const gap = Number(option('--gap', '0'))
  const state = requireState(option('--lab', 'lab'))
  const title = option('--title', basename(planPath).replace(/\.json$/, ''))
  const dir = runFolder(title)
  const framesDir = join(SCRATCH, 'frames', basename(dir))
  say(`run folder ${dir}`)
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2))

  const cdp = await cdpConnect(state.debugPort)
  const recording = await startRecording(cdp, framesDir)
  await sleep(400)
  const calls = []
  const scenes = []
  const ref = (value) => (typeof value === 'string' && /^\$\d+$/.test(value) ? scenes[Number(value.slice(1)) - 1] : value)
  const t0 = Date.now()

  await withMcp(state.mcpPort, async (call) => {
    const invoke = async (tool, toolArgs, label) => {
      const tCall = Date.now()
      let result = null
      let thrown = null
      try {
        result = await call(tool, toolArgs)
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error)
      }
      const tReturn = Date.now()
      const text = result ? resultText(result) : ''
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        // Not JSON.
      }
      const entry = { label, tool, args: { ...toolArgs, ...(toolArgs.code ? { code: `(${toolArgs.code.length} chars)` } : {}) }, t_call: tCall - t0, t_return: tReturn - t0, ok: !thrown && !result?.isError, error: thrown ?? (result?.isError ? text : null), result: parsed ?? text }
      calls.push(entry)
      say(`${label}: ${entry.ok ? 'ok' : 'ERROR'} in ${tReturn - tCall} ms${parsed?.starts_in_s !== undefined ? `, starts in ${parsed.starts_in_s} s, lasts ${parsed.duration_s} s` : ''}${entry.ok ? '' : ` ${String(entry.error).slice(0, 300)}`}`)
      return parsed
    }
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i]
      if (step.run) {
        const file = resolve(planDir, step.run)
        const code = readFileSync(file, 'utf8')
        copyFileSync(file, join(dir, basename(file)))
        const parsed = await invoke('run_scene', { code, name: step.name ?? basename(file, '.js'), ...(step.when ? { when: step.when } : {}), ...(step.wait ? { wait: step.wait } : {}) }, `run ${basename(file)}`)
        scenes.push(parsed?.scene ?? null)
        if (gap > 0 && !(plan[i + 1] && plan[i + 1].sleep !== undefined)) await sleep(gap * 1000)
      } else if (step.replace) {
        const file = resolve(planDir, step.with)
        copyFileSync(file, join(dir, basename(file)))
        await invoke('scene_control', { action: 'replace', scene: ref(step.replace), code: readFileSync(file, 'utf8') }, `replace ${step.replace} with ${basename(file)}`)
      } else if (step.control) {
        const a = { ...step.control }
        if (a.scene) a.scene = ref(a.scene)
        await invoke('scene_control', a, `scene_control ${a.action}`)
      } else if (step.sleep !== undefined) await sleep(step.sleep * 1000)
      else if (step.until === 'idle') {
        let pausedSince = null
        for (;;) {
          const hook = await sceneHook(cdp)
          if (!hook?.playing) break
          if (hook.paused) {
            pausedSince ??= Date.now()
            if (Date.now() - pausedSince > 2000) {
              await call('scene_control', { action: 'resume' })
              pausedSince = null
            }
          } else pausedSince = null
          await sleep(50)
        }
      } else if (step.until === 'time') {
        const id = ref(step.scene)
        for (;;) {
          const hook = await sceneHook(cdp)
          if (!hook?.playing || (hook.current === id && hook.time >= step.t)) break
          await sleep(20)
        }
      }
    }
  })
  // Play to the end.
  for (;;) {
    const hook = await sceneHook(cdp)
    if (!hook?.playing) break
    await sleep(50)
  }
  await sleep(1000)
  const tEnd = Date.now()
  const frames = await recording.stop()
  const played = (await cdp.evaluate('(() => { const s = window.__spaceDev && window.__spaceDev.scene; return s && s.played ? s.played : [] })()')) ?? []
  // Hand-offs: each scene's start against the end of the one before it; "queued" when it was sent before that end.
  const ours = played.filter((p) => p.start >= t0).sort((a, b) => a.start - b.start)
  const handoffs = ours.slice(1).map((p, i) => {
    const prev = ours[i]
    const sent = calls.find((c) => c.result && c.result.scene === p.scene)
    return { from: prev.scene, to: p.scene, gap_ms: prev.end === null ? null : p.start - prev.end, queued: !!sent && prev.end !== null && t0 + sent.t_return < prev.end }
  })
  const rect = flag('--no-crop') ? null : await canvasRect(cdp)
  const crop = frames.length ? cropFilter(frames[0].file, rect, frames[0].w) : ''
  const finalRaw = join(framesDir, 'final.png')
  await cdp.screenshot(finalRaw)
  cropImage(finalRaw, join(dir, 'final.png'), crop)
  cdp.close()

  // When the board changed: the canvas, without the top bar and the caption band, frame by frame.
  const spec = join(framesDir, 'frames-in.json')
  writeFileSync(spec, JSON.stringify({ frames: frames.map((f) => ({ file: f.file, t: f.t - t0 })), rect, cssW: frames[0]?.w ?? null }))
  const changes = JSON.parse(execFileSync('python3', ['-I', join(LAB, 'frame-changes.py'), spec], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  writeFileSync(join(dir, 'frames.json'), JSON.stringify(changes, null, 2))
  writeFileSync(join(dir, 'calls.json'), JSON.stringify(calls, null, 2))

  encodeVideo(frames, join(dir, 'video-real.mp4'), { from: t0, to: tEnd, crop })
  const labels = calls.map((c) => ({ from: t0 + c.t_call, to: t0 + c.t_return, label: `${c.label} running` }))
  const watch = encodeWatchVideo(frames, join(dir, 'video.mp4'), { from: t0, to: tEnd, crop, labels })
  const tiles = []
  calls.forEach((c, i) => {
    const out = join(framesDir, `strip-${i}.png`)
    cropImage(frameAt(frames, t0 + c.t_return + 1500).file, out, crop)
    tiles.push({ file: out, label: `${(c.t_return / 1000).toFixed(1)} s + 1.5  ${c.label}` })
  })
  const out = join(framesDir, 'strip-end.png')
  cropImage(finalRaw, out, crop)
  tiles.push({ file: out, label: 'end' })
  filmstrip(tiles, join(dir, 'filmstrip.png'))

  const firstCall = calls[0]?.t_call ?? 0
  const lastPlayEnd = changes.last_change_ms ?? null
  const meta = {
    kind: 'play',
    title,
    task: option('--task', title),
    client: 'beats.mjs',
    model: 'hand-written program',
    tool: 'run_scene',
    lab: { name: state.name, mode: state.mode, mcpPort: state.mcpPort },
    started: new Date(t0).toISOString(),
    ok: calls.every((c) => c.ok),
    numbers: {
      calls: calls.length,
      first_change_after_first_call_ms: changes.first_change_ms !== null ? changes.first_change_ms - firstCall : null,
      first_call_ms: calls[0] ? calls[0].t_return - calls[0].t_call : null,
      longest_still_ms: changes.longest_still_ms,
      stills_over_1s: changes.stills.filter((g) => g.ms > 1000),
      last_change_ms: lastPlayEnd,
      handoffs,
      recorded_s: Math.round((tEnd - t0) / 100) / 10,
      watch_s: watch.watch_s
    },
    cuts: watch.cuts
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  rmSync(framesDir, { recursive: true, force: true })
  if (!flag('--no-gallery')) say(`gallery ${writeGallery()}`)
  say(JSON.stringify(meta.numbers))
  say(`done: ${dir}`)
}

main().catch((error) => {
  console.error(`beats: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
