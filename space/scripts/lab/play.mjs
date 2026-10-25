#!/usr/bin/env node
/**
 * Play a program on the lab app and record it.
 *
 *   node scripts/lab/play.mjs <program.js> [--name <scene>] [--title <text>] [--task <text>] [--model <who wrote it>]
 *   node scripts/lab/play.mjs --tool <name> --args '<json>' [--title <text>]    any other tool, for example draw_ink
 *   common options: [--lab lab] [--seconds N] [--no-crop] [--no-gallery]
 *
 * It calls run_scene ({ code, name }) on the lab app (lab.mjs start), records
 * the window with CDP Page.startScreencast from the call until the playback
 * ends (duration_s + 1 s, or --seconds N after the call returns), and writes
 * a run folder in space/.lab/runs/: program.js, result.json, video.mp4 (H.264
 * at real speed), filmstrip.png (a frame at each step, or 8 frames), final.png
 * and meta.json. Then it rebuilds space/.lab/index.html (the gallery).
 * When the dev hook window.__spaceDev.scene has seek(t), the filmstrip frames
 * are taken by seeking (crisp); otherwise they come from the screencast.
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
  sceneSeek,
  sleep,
  startRecording,
  withMcp
} from './common.mjs'
import { writeGallery } from './gallery.mjs'

const { option, flag, positional } = args()
const say = (...p) => log('play', ...p)

async function main() {
  const tool = option('--tool', 'run_scene')
  const programPath = positional[0] ? resolve(positional[0]) : null
  let toolArgs
  let code = null
  if (tool === 'run_scene') {
    if (!programPath) throw new Error('usage: play.mjs <program.js> [--name] [--title]   or   play.mjs --tool <name> --args <json>')
    code = readFileSync(programPath, 'utf8')
    const name = option('--name', basename(programPath).replace(/\.[^.]+$/, ''))
    toolArgs = { code, name }
  } else {
    const raw = option('--args', '{}')
    toolArgs = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw)
  }
  const title = option('--title', toolArgs.name ?? tool)
  const state = requireState(option('--lab', 'lab'))
  const dir = runFolder(title)
  const framesDir = join(SCRATCH, 'frames', basename(dir))
  say(`run folder ${dir}`)

  const cdp = await cdpConnect(state.debugPort)
  const hookBefore = await sceneHook(cdp)
  const recording = await startRecording(cdp, framesDir)
  await sleep(300) // a first frame of the board before the call

  const tCall = Date.now()
  let result = null
  let thrown = null
  try {
    result = await withMcp(state.mcpPort, (call) => call(tool, toolArgs))
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
  const duration = !isError && typeof parsed?.duration_s === 'number' ? parsed.duration_s : null
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : []
  say(isError ? `error: ${thrown ?? text.slice(0, 400)}` : `returned in ${tReturn - tCall} ms${duration !== null ? `, duration ${duration} s, ${steps.length} steps` : ''}`)

  // Record until the playback ends.
  const seconds = option('--seconds', null)
  const holdMs = seconds !== null ? Number(seconds) * 1000 : isError ? 1000 : duration !== null ? duration * 1000 + 1000 : 3000
  let tEnd = tReturn + holdMs
  while (Date.now() < tEnd) await sleep(100)
  // The scene hook may say playback runs longer than the result said: wait up to 10 s more.
  for (let i = 0; i < 100; i++) {
    const hook = await sceneHook(cdp)
    if (!hook?.playing) break
    await sleep(100)
    tEnd = Date.now() + 500
  }
  while (Date.now() < tEnd) await sleep(50)
  const frames = await recording.stop()
  say(`${frames.length} frames over ${((tEnd - tCall) / 1000).toFixed(1)} s`)

  const rect = flag('--no-crop') ? null : await canvasRect(cdp)
  const crop = frames.length ? cropFilter(frames[0].file, rect, frames[0].w) : ''

  // Files.
  if (code !== null) writeFileSync(join(dir, 'program.js'), code)
  const shownArgs = { ...toolArgs }
  if (code !== null) shownArgs.code = `(${code.length} characters: program.js)`
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ tool, args: shownArgs, ok: !isError, error: thrown, isError: Boolean(result?.isError), text, parsed, call_ms: tReturn - tCall }, null, 2))
  if (code === null) writeFileSync(join(dir, 'program.js'), `// ${tool}\n${JSON.stringify(toolArgs, null, 2)}\n`)

  encodeVideo(frames, join(dir, 'video-real.mp4'), { from: tCall, to: tEnd, crop })
  const watch = encodeWatchVideo(frames, join(dir, 'video.mp4'), { from: tCall, to: tEnd, crop, labels: [{ from: tCall, to: tReturn, label: `${tool} running` }] })

  const finalRaw = join(framesDir, 'final.png')
  await cdp.screenshot(finalRaw)
  cropImage(finalRaw, join(dir, 'final.png'), crop)

  // The filmstrip: a frame at each step and at the end, or 8 evenly spaced frames.
  const tPlay = tReturn // playback starts when run_scene returns
  let times
  if (steps.length) times = [...steps.map((s) => ({ t: s.at_s, label: `${Number(s.at_s).toFixed(1)} s  ${s.name}` })), { t: duration, label: `${Number(duration).toFixed(1)} s  end` }]
  else {
    const span = duration ?? (tEnd - tPlay) / 1000
    times = Array.from({ length: 8 }, (_, i) => {
      const t = (span * (i + 1)) / 8
      return { t, label: `${t.toFixed(1)} s` }
    })
  }
  const hook = await sceneHook(cdp)
  const useSeek = Boolean(hook?.hasSeek && duration !== null)
  const tiles = []
  for (let i = 0; i < times.length; i++) {
    const out = join(framesDir, `strip-${i}.png`)
    if (useSeek) {
      const raw = join(framesDir, `seek-${i}.png`)
      await sceneSeek(cdp, times[i].t)
      await cdp.screenshot(raw)
      cropImage(raw, out, crop)
    } else {
      cropImage(frameAt(frames, tPlay + times[i].t * 1000).file, out, crop)
    }
    tiles.push({ file: out, label: times[i].label })
  }
  if (useSeek) await sceneSeek(cdp, duration)
  filmstrip(tiles, join(dir, 'filmstrip.png'))
  cdp.close()

  const meta = {
    kind: tool === 'run_scene' ? 'play' : 'tool',
    title,
    task: option('--task', title),
    client: 'play.mjs',
    model: option('--model', tool === 'run_scene' ? 'hand-written program' : 'direct tool call'),
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
      steps: steps.length,
      warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.length : null
    },
    cuts: watch.cuts,
    filmstrip_source: useSeek ? 'seek' : 'screencast',
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
