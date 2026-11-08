#!/usr/bin/env node
/**
 * Play a program on the lab app and record it.
 *
 *   node scripts/lab/play.mjs <program.js> [--name <scene>] [--title <text>] [--task <text>] [--model <who wrote it>]
 *   node scripts/lab/play.mjs --tool <name> --args '<json>' [--title <text>]    any other tool, for example get_screenshot
 *   common options: [--lab lab] [--seconds N] [--pause-hold S] [--no-crop] [--no-gallery]
 *
 * It calls write_scene ({ name, code }) and then play_scene start on the lab
 * app (lab.mjs start), records the window with CDP Page.startScreencast from
 * the start call until the playback ends (followed through the dev hook
 * window.__spaceDev.scene; pause steps are resumed with play_scene resume
 * after --pause-hold s, default 2; --seconds N is a
 * minimum after the call returns), and writes a run folder in
 * apps/desktop/.lab/runs/: program.js, result.json, video.mp4 (the watch video),
 * video-real.mp4 (real speed, from the scene's start), filmstrip.png (the
 * frame on screen when the scene reached each step, or 8 frames), final.png
 * and meta.json. Then it rebuilds apps/desktop/.lab/index.html (the gallery).
 * Exit code 1 when the tool returns an error (the run folder is still written).
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
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
const say = (...p) => log('play', ...p)

async function main() {
  // The default: a scene program (write_scene, then play_scene start).
  const tool = option('--tool', 'play_scene')
  const programPath = positional[0] ? resolve(positional[0]) : null
  let toolArgs
  let code = null
  const isScene = tool === 'play_scene' && !option('--args', null)
  if (isScene) {
    if (!programPath) throw new Error('usage: play.mjs <program.js> [--name] [--title]   or   play.mjs --tool <name> --args <json>')
    code = readFileSync(programPath, 'utf8')
    const name = option('--name', basename(programPath).replace(/\.[^.]+$/, ''))
    toolArgs = { action: 'start', name }
  } else {
    const raw = option('--args', '{}')
    toolArgs = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw)
  }
  const title = option('--title', toolArgs.name ?? tool)
  const state = requireState(option('--lab', 'lab'))
  const dir = runFolder(title)
  const framesDir = join(SCRATCH, 'frames', basename(dir))
  say(`run folder ${dir}`)

  // The draft first (the learner sees nothing of it), so the recording starts with the play.
  let written = null
  if (isScene) {
    written = await withMcp(state.mcpPort, (call) => call('write_scene', { name: toolArgs.name, code })).catch((error) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }))
    say(written?.isError ? `write_scene error: ${resultText(written).slice(0, 400)}` : 'draft written')
  }

  const cdp = await cdpConnect(state.debugPort)
  const hookBefore = await sceneHook(cdp)
  const recording = await startRecording(cdp, framesDir)
  await sleep(300) // a first frame of the board before the call

  const tCall = Date.now()
  let result = null
  let thrown = null
  try {
    result = written?.isError ? written : await withMcp(state.mcpPort, (call) => call(tool, toolArgs))
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  const tReturn = Date.now()
  const text = result ? resultText(result) : ''
  const isError = Boolean(thrown || result?.isError)
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON: keep the text.
  }
  const duration = !isError && typeof parsed?.length_s === 'number' ? parsed.length_s : null
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : []
  say(isError ? `error: ${thrown ?? text.slice(0, 400)}` : `returned in ${tReturn - tCall} ms${duration !== null ? `, duration ${duration} s, ${steps.length} steps` : ''}`)

  // Record until the playback ends: follow the scene through the dev hook (its time, pauses), log
  // wall time against scene time (for the filmstrip), and resume pause steps after --pause-hold s.
  const seconds = option('--seconds', null)
  const minEnd = tReturn + (seconds !== null ? Number(seconds) * 1000 : 0)
  const pauseHoldMs = Number(option('--pause-hold', '2')) * 1000
  const sceneName = !isError && typeof parsed?.scene === 'string' ? parsed.scene : null
  const timeLog = [] // [{ wall, t }] while this scene is the current one
  let tEnd
  if (sceneName && hookBefore) {
    let seen = false
    let pausedSince = null
    for (;;) {
      const hook = await sceneHook(cdp)
      const now = Date.now()
      if (hook?.name === sceneName) {
        seen = true
        if (typeof hook.time === 'number') timeLog.push({ wall: now, t: hook.time })
        if (hook.paused) {
          pausedSince ??= now
          if (now - pausedSince >= pauseHoldMs) {
            say(`resume after a pause at ${hook.time} s`)
            await withMcp(state.mcpPort, (call) => call('play_scene', { action: 'resume' }))
            pausedSince = null
          }
        } else pausedSince = null
      } else if (seen || !hook?.playing) break
      await sleep(50)
    }
    tEnd = Math.max(Date.now() + 1000, minEnd)
  } else {
    // No scene hook (or not a scene): hold for the result's duration.
    const holdMs = seconds !== null ? Number(seconds) * 1000 : isError ? 1000 : duration !== null ? duration * 1000 + 1000 : 3000
    tEnd = tReturn + holdMs
  }
  while (Date.now() < tEnd) await sleep(50)
  const frames = await recording.stop()
  say(`${frames.length} frames over ${((tEnd - tCall) / 1000).toFixed(1)} s`)
  /** The wall time at which the scene reached time t (the first log entry at or after it), or null. */
  const wallAt = (t) => {
    const hit = timeLog.find((entry) => entry.t >= t - 1e-3)
    return hit ? hit.wall : timeLog.length ? timeLog[timeLog.length - 1].wall : null
  }
  const sceneStart = timeLog.length ? timeLog[0].wall - (timeLog[0].t * 1000) : null

  const rect = flag('--no-crop') ? null : await canvasRect(cdp)
  const crop = frames.length ? cropFilter(frames[0].file, rect, frames[0].w) : ''

  // Files.
  if (code !== null) writeFileSync(join(dir, 'program.js'), code)
  const shownArgs = { ...toolArgs }
  if (code !== null) shownArgs.code = `(${code.length} characters: program.js)`
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ tool, args: shownArgs, ok: !isError, error: thrown, isError: Boolean(result?.isError), text, parsed, call_ms: tReturn - tCall }, null, 2))
  if (code === null) writeFileSync(join(dir, 'program.js'), `// ${tool}\n${JSON.stringify(toolArgs, null, 2)}\n`)

  // The real-speed video starts with the scene (a moment before it); the watch video also shows the call.
  encodeVideo(frames, join(dir, 'video-real.mp4'), { from: sceneStart !== null ? Math.max(tCall, sceneStart - 300) : tCall, to: tEnd, crop })
  const watch = encodeWatchVideo(frames, join(dir, 'video.mp4'), { from: tCall, to: tEnd, crop, labels: [{ from: tCall, to: tReturn, label: `${tool} running` }] })

  const finalRaw = join(framesDir, 'final.png')
  await cdp.screenshot(finalRaw)
  cropImage(finalRaw, join(dir, 'final.png'), crop)

  // The filmstrip: a frame at each step and at the end, or 8 evenly spaced frames. Each tile is the
  // screencast frame on screen when the scene reached that time (from the time log, so pauses and a
  // late start count); without a log, the time after the call returned.
  let times
  if (steps.length) times = [...steps.map((s) => ({ t: s.at_s, label: `${Number(s.at_s).toFixed(1)} s  ${s.name}` })), { t: duration, label: `${Number(duration).toFixed(1)} s  end` }]
  else {
    const span = duration ?? (tEnd - tReturn) / 1000
    times = Array.from({ length: 8 }, (_, i) => {
      const t = (span * (i + 1)) / 8
      return { t, label: `${t.toFixed(1)} s` }
    })
  }
  // A frame shows a little after the scene time is reached (the next paint).
  const PAINT_MS = 120
  const tiles = []
  for (let i = 0; i < times.length; i++) {
    const out = join(framesDir, `strip-${i}.png`)
    const wall = timeLog.length ? wallAt(times[i].t) : tReturn + times[i].t * 1000
    cropImage(frameAt(frames, wall + PAINT_MS).file, out, crop)
    tiles.push({ file: out, label: times[i].label })
  }
  filmstrip(tiles, join(dir, 'filmstrip.png'))
  cdp.close()

  const meta = {
    kind: isScene ? 'play' : 'tool',
    title,
    task: option('--task', title),
    client: 'play.mjs',
    model: option('--model', isScene ? 'hand-written program' : 'direct tool call'),
    tool,
    scene: parsed?.scene ?? toolArgs.name ?? null,
    lab: { name: state.name, mode: state.mode, mcpPort: state.mcpPort },
    started: new Date(tCall).toISOString(),
    ok: !isError,
    error: isError ? (thrown ?? text) : null,
    numbers: {
      first_mark_ms: isError ? null : tReturn - tCall,
      calls: 1,
      call_ms: tReturn - tCall,
      duration_s: duration,
      recorded_s: Math.round((tEnd - tCall) / 100) / 10,
      watch_s: watch.watch_s,
      frames: frames.length,
      steps: steps.length
    },
    cuts: watch.cuts,
    filmstrip_source: timeLog.length ? 'screencast at scene times' : 'screencast after the call',
    scene_hook: Boolean(hookBefore)
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  rmSync(framesDir, { recursive: true, force: true })
  if (!flag('--no-gallery')) say(`gallery ${writeGallery()}`)
  say(`done: ${dir}`)
  if (isError) process.exitCode = 1
}

main().catch((error) => {
  console.error(`play: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
