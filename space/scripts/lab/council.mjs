#!/usr/bin/env node
/**
 * The model council: a real agent works on a task on a fresh lab app while the
 * board is recorded. With --interview, the same session is then interviewed
 * about the tool.
 *
 *   node scripts/lab/council.mjs --client codex|claude --task <id|text>
 *        [--model M] [--effort E] [--title T] [--timeout-min 20]
 *        [--name council] [--mcp-port 47891] [--debug-port 9491] [--built]
 *        [--codex-home <SCRATCH>/codex-home] [--no-news-hook] [--keep-app]
 *        [--brief-only] [--no-code] [--no-html] [--brief <file>] [--no-web] [--interview] [--wait-media]
 *        [--learner-board <program.js>] [--file <path>]
 *
 * Tasks: council/tasks.json (id → text; "learner": "<program.js>" names the
 * learner's work the board opens with), or any text. --learner-board opens the
 * board with the learner's own work: a scene program in council/learners/
 * (write(), stroke()) that learner-board.mjs turns into their ink with the app's
 * own code. meta.json: learner_board. --file copies the learner's own file (a
 * spreadsheet, a PDF) to the learning folder's top level. The prompt is council/purpose.md
 * plus the task. Defaults: Claude opus; Codex gpt-6.1-sol at effort medium.
 * --no-code starts the app with LS_LAB_NO_CODE=1 (src/main/lab-switch.ts): no
 * world() in scenes, and no word of them in the brief,
 * the guide or the tool descriptions. meta.json records it as no_code.
 * --no-html (LS_LAB_NO_HTML=1) does the same for html() and HTML material.
 * --brief <file> (LS_LAB_BRIEF) serves that file as the brief (AGENTS.md block,
 * get_brief), with the switches' markers applied. meta.json: no_html, brief.
 *
 * Phase 1 (work): `claude -p` (MCP config for the lab only, all tools, no
 * permission prompts) or `codex exec --json` (scratch CODEX_HOME, full access,
 * Learning Space tools approved), as the desktop apps run them (see
 * scripts/perf/README.md, "How close the lab is to the real apps"), run from inside the lab's learning folder, so AGENTS.md loads. The
 * window is recorded with the screencast for the whole phase, until the last
 * scene has played, plus 1 s.
 * Phase 2 (interview, only with --interview): the SAME session resumed
 * (`claude -p --resume <id>`, `codex exec resume <thread>`) with
 * council/interview.md; the answer is feedback.md.
 *
 * When the board is done, the script takes final.png and board.png from the
 * live app and stops the app (exact PIDs) at once, unless --keep-app. Then it
 * writes the filmstrip, program.js, calls.json and meta.json, and media.mjs
 * makes the videos in the background (log: media.log in the run folder), so the
 * next run can start. --wait-media waits for the videos before exiting.
 *
 * The run folder (space/.lab/runs/) gets video.mp4 (the watch video: stretches
 * with no visible change longer than 1.5 s play in 0.6 s, labelled with the real
 * wait and what happened, from the trace; a real-time clock in the corner),
 * video-real.mp4 (real time), filmstrip.png (a frame after each board write),
 * final.png, board.png (the whole board), program.js (every write_scene program (run_scene in older traces),
 * or the write calls), calls.json, feedback.md (with --interview), the agent's
 * output files and meta.json (numbers.after_agent_ms: the agent's end to the
 * app stopped; media: "pending" until the videos are made, then "done").
 */
import { spawn } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  LAB,
  SCRATCH,
  isWrite,
  args,
  canvasRect,
  cdpConnect,
  claudeTranscript,
  claudeTurn,
  codexRollout,
  codexTurn,
  cropFilter,
  cropImage,
  scenePlaySpans,
  filmstrip,
  frameAt,
  log,
  prepareCodexHome,
  runFolder,
  sceneHook,
  sleep,
  startInstance,
  startRecording,
  stopInstance,
  traceCalls,
  traceLabels,
  traceSessionOpen,
  withMcp
} from './common.mjs'
import { writeGallery } from './gallery.mjs'
import { learnerBoard } from './learner-board.mjs'

const { option, flag } = args()
const say = (...p) => log('council', ...p)

const opts = {
  client: option('--client', 'codex'),
  model: option('--model', null),
  effort: option('--effort', null),
  task: option('--task', null),
  title: option('--title', null),
  name: option('--name', 'council'),
  mcpPort: Number(option('--mcp-port', '47891')),
  debugPort: Number(option('--debug-port', '9491')),
  built: flag('--built'),
  timeoutMs: Number(option('--timeout-min', '20')) * 60_000,
  codexHome: option('--codex-home', join(SCRATCH, 'codex-home')),
  newsHook: !flag('--no-news-hook'),
  keepApp: flag('--keep-app'),
  // Phase 2, the interview about the tool: off unless asked for.
  interview: flag('--interview'),
  // Wait for the videos before exiting (the old behaviour); by default they are made in the background.
  waitMedia: flag('--wait-media'),
  // Only the task as the prompt, as in a real session: the brief reaches the agent through the folder's AGENTS.md.
  briefOnly: flag('--brief-only'),
  // The lab switch LS_LAB_NO_CODE: worlds do not exist for the agent.
  noCode: flag('--no-code'),
  // The lab switch LS_LAB_NO_HTML: HTML material does not exist for the agent.
  noHtml: flag('--no-html'),
  // LS_LAB_BRIEF: a draft brief served instead of resources/brief.md (absolute path).
  brief: option('--brief', null) ? resolve(option('--brief', null)) : null,
  // Web search and fetch, as the agent apps have in real sessions; --no-web turns them off.
  web: !flag('--no-web'),
  // A file of the learner's (a spreadsheet, a PDF) at the learning folder's top level, as when they drop it there.
  file: option('--file', null) ? resolve(option('--file', null)) : null,
  // The learner's own work on the board before the agent starts: a scene program made the learner's ink
  // (learner-board.mjs; council/learners/*.js).
  learnerBoard: option('--learner-board', null) ? resolve(option('--learner-board', null)) : null
}
if (!['claude', 'codex'].includes(opts.client)) throw new Error('--client is claude or codex')
if (opts.brief && !existsSync(opts.brief)) throw new Error(`--brief: no file ${opts.brief}`)
if (opts.file && !existsSync(opts.file)) throw new Error(`--file: no file ${opts.file}`)
if (opts.learnerBoard && !existsSync(opts.learnerBoard)) throw new Error(`--learner-board: no file ${opts.learnerBoard}`)
if (!opts.task) throw new Error('--task <id|text> is required')
if (opts.client === 'claude' && !opts.model) opts.model = 'opus'
if (opts.client === 'codex' && !opts.model) opts.model = 'gpt-6.1-sol'
if (opts.client === 'codex' && !opts.effort) opts.effort = 'medium'

const pids = []
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '').trim()

// ---------- Agents ----------

// The headless turns (claudeTurn, codexTurn, prepareCodexHome) are in common.mjs, shared with perf/run.mjs.
const agent = { client: opts.client, model: opts.model, effort: opts.effort, newsHook: opts.newsHook, web: opts.web, codexHome: opts.codexHome, timeoutMs: opts.timeoutMs, pids, say }

// ---------- Main ----------

async function main() {
  const tasks = JSON.parse(readFileSync(join(LAB, 'council/tasks.json'), 'utf8'))
  const known = tasks[opts.task]
  const task = known ? { id: opts.task, ...known } : { id: 'custom', title: opts.task.slice(0, 60), text: opts.task }
  // The learner's work the board opens with: the run's own, else the task's.
  const learnerProgram = opts.learnerBoard ?? (task.learner ? join(LAB, 'council/learners', task.learner) : null)
  const title = opts.title ?? `${task.title} — ${opts.client} ${opts.model}${opts.effort ? ` ${opts.effort}` : ''}${opts.noCode ? ' — no worlds' : ''}${opts.noHtml ? ' — no HTML' : ''}${opts.brief ? ` — brief ${basename(opts.brief)}` : ''}${learnerProgram ? ` — learner's board ${basename(learnerProgram)}` : ''}`
  const purpose = stripComments(readFileSync(join(LAB, 'council/purpose.md'), 'utf8'))
  const interview = stripComments(readFileSync(join(LAB, 'council/interview.md'), 'utf8'))
  const prompt = opts.briefOnly ? task.text : `${purpose}\n\n## The task\n\n${task.text}`

  const dir = runFolder(`${task.id}-${opts.client}-${opts.model}`)
  const framesDir = join(SCRATCH, 'frames', basename(dir))
  say(`run folder ${dir}`)
  writeFileSync(join(dir, 'prompt.md'), `${prompt}\n`)

  if (opts.noCode) process.env.LS_LAB_NO_CODE = '1'
  else delete process.env.LS_LAB_NO_CODE
  if (opts.noHtml) process.env.LS_LAB_NO_HTML = '1'
  else delete process.env.LS_LAB_NO_HTML
  if (opts.brief) process.env.LS_LAB_BRIEF = opts.brief
  else delete process.env.LS_LAB_BRIEF
  const board = learnerProgram ? await learnerBoard(learnerProgram) : null
  const state = await startInstance({ name: opts.name, mcpPort: opts.mcpPort, debugPort: opts.debugPort, built: opts.built, fresh: true, board })
  if (board) say(`the board opens with the learner's work ${basename(learnerProgram)}`)
  say(`app ${state.mode} on MCP ${state.mcpPort}, debug ${state.debugPort}, PIDs ${state.pids.join(', ')}`)
  let cdp = null
  let appStopped = false
  let mediaJob = null
  try {
    if (opts.client === 'codex') prepareCodexHome(agent, state)
    if (opts.file) {
      copyFileSync(opts.file, join(state.folder, basename(opts.file)))
      say(`put the learner's file ${basename(opts.file)} in the folder`)
    }

    // Phase 1: work, recorded.
    cdp = await cdpConnect(state.debugPort)
    const recording = await startRecording(cdp, framesDir)
    await sleep(300)
    const t0 = Date.now()
    say(`phase 1: ${opts.client} ${opts.model}${opts.effort ? ` (${opts.effort})` : ''} on "${task.text}"`)
    const work = opts.client === 'claude' ? await claudeTurn(agent, state, dir, prompt, 'work') : await codexTurn(agent, state, dir, prompt, 'work')
    const t1 = Date.now()
    say(`phase 1 done in ${((t1 - t0) / 1000).toFixed(1)} s, exit ${work.exit_code}, session ${work.session}`)

    // Record until the last scene has played: the end of each played scene from the trace
    // (previews play nothing; starts_in_s counts), then the scene hook, then a short tail.
    await sleep(1000) // the trace has the last calls
    const calls = traceCalls(state.traces, t0)
    let tEnd = Math.max(Date.now(), ...scenePlaySpans(calls).map((s) => s.to))
    while (Date.now() < tEnd) await sleep(100)
    // A paused scene waits for the learner, and there is none: it counts as played.
    for (let i = 0; i < 300; i++) {
      const s = await sceneHook(cdp)
      if (!s?.playing || s.paused) break
      await sleep(100)
    }
    tEnd = Date.now() + 1000
    while (Date.now() < tEnd) await sleep(50)
    const frames = await recording.stop()
    say(`${frames.length} frames over ${((tEnd - t0) / 1000).toFixed(1)} s; board done ${((tEnd - t1) / 1000).toFixed(1)} s after the agent`)

    // What needs the live app: the crop, the final picture and the whole board.
    // The pictures never stop the run: a failure is recorded.
    const mediaErrors = []
    const media = async (what, fn) => {
      try {
        return await fn()
      } catch (error) {
        const message = `${what}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000)
        mediaErrors.push(message)
        say(`${message} (continuing)`)
        return null
      }
    }
    const rect = await canvasRect(cdp)
    const crop = frames.length ? cropFilter(frames[0].file, rect, frames[0].w) : ''
    const finalRaw = join(framesDir, 'final.png')
    await media('final picture', async () => {
      await cdp.screenshot(finalRaw)
      cropImage(finalRaw, join(dir, 'final.png'), crop)
    })
    await media('board picture', () =>
      withMcp(state.mcpPort, async (call) => {
        const shot = await call('get_screenshot', { part: 'board', max_size: 2400 })
        const image = shot.content?.find((p) => p.type === 'image')
        if (image) writeFileSync(join(dir, 'board.png'), Buffer.from(image.data, 'base64'))
      })
    )
    cdp.close()
    cdp = null

    // Phase 2 (only with --interview): the same session, while the app still runs.
    let answer = null
    let i0 = null
    let i1 = null
    if (opts.interview) {
      say('phase 2: interview')
      i0 = Date.now()
      answer = work.session ? (opts.client === 'claude' ? await claudeTurn(agent, state, dir, interview, 'interview', work.session) : await codexTurn(agent, state, dir, interview, 'interview', work.session)) : null
      i1 = Date.now()
      writeFileSync(join(dir, 'feedback.md'), answer ? `${answer.reply.trim()}\n` : '_No session to resume: phase 1 failed._\n')
      say(answer ? `phase 2 done in ${((i1 - i0) / 1000).toFixed(1)} s, exit ${answer.exit_code}` : 'phase 2 skipped')
    }

    // The board is done: stop the app now. Everything below works on files.
    if (!opts.keepApp) say(`app stopped (PIDs ${(await stopInstance(opts.name)).join(', ')})`)
    appStopped = true
    const tStop = Date.now()
    say(`${opts.keepApp ? 'app kept' : 'app stopped'} ${((tStop - t1) / 1000).toFixed(1)} s after the agent finished`)

    // The filmstrip: the board after each write (at most 12), or 8 evenly spaced frames.
    const writes = calls.filter((c) => isWrite(c))
    const rel = (iso) => (Date.parse(iso) - t0) / 1000
    let times = writes.map((c) => ({ t: rel(c.end ?? c.t) + 0.5, label: `${rel(c.t).toFixed(1)} s  ${c.tool}${c.ok ? '' : ' (error)'}` }))
    const span = (tEnd - t0) / 1000
    const even = (n) => Array.from({ length: n }, (_, i) => ({ t: (span * (i + 1)) / n, label: `${((span * (i + 1)) / n).toFixed(1)} s` }))
    if (times.length > 12) times = even(8)
    // Few writes: fill up to 8 frames with evenly spaced ones, in time order.
    else if (times.length < 8) times = [...times, ...even(8 - times.length)].sort((a, b) => a.t - b.t)
    if (frames.length)
      await media('filmstrip', () => {
        const tiles = times.map((x, i) => {
          const out = join(framesDir, `strip-${i}.png`)
          cropImage(frameAt(frames, t0 + x.t * 1000).file, out, crop)
          return { file: out, label: x.label }
        })
        filmstrip(tiles, join(dir, 'filmstrip.png'))
      })

    // The programs.
    const scenes = calls.filter((c) => c.tool === 'write_scene' || c.tool === 'run_scene')
    const program = scenes.length
      ? scenes.map((c, i) => `// ---- ${c.tool} ${i + 1} of ${scenes.length} at ${rel(c.t).toFixed(1)} s${c.args?.name ? ` (${c.args.name})` : ''}${c.ok ? '' : ' (error)'} ----\n${c.args?.code ?? ''}\n`).join('\n')
      : writes.map((c) => `// ---- ${c.tool} at ${rel(c.t).toFixed(1)} s${c.ok ? '' : ' (error)'} ----\n${c.args?.html ?? c.args?.svg_path ?? JSON.stringify(c.args, null, 2)}\n`).join('\n')
    if (program) writeFileSync(join(dir, 'program.js'), program)
    writeFileSync(join(dir, 'calls.json'), JSON.stringify(calls.map((c) => ({ t_s: rel(c.t), tool: c.tool, ms: c.duration_ms, ok: c.ok, error: c.error ?? null, args: c.args, result: c.result_text })), null, 2))

    // A resumed Codex thread reports the thread's running total: keep the interview's own share.
    if (answer?.tokens && work.tokens) for (const key of Object.keys(answer.tokens)) answer.tokens[key] = Math.max(0, answer.tokens[key] - (work.tokens[key] ?? 0))
    const perTool = {}
    for (const c of calls) perTool[c.tool] = (perTool[c.tool] ?? 0) + 1
    const firstWrite = writes.find((c) => c.ok)
    const meta = {
      kind: 'council',
      title,
      task: task.text,
      task_id: task.id,
      client: opts.client,
      model: opts.model,
      effort: opts.effort,
      brief_only: opts.briefOnly,
      no_code: opts.noCode,
      no_html: opts.noHtml,
      brief: opts.brief,
      learner_board: learnerProgram,
      started: new Date(t0).toISOString(),
      ok: work.exit_code === 0 && !work.is_error,
      error: work.is_error ? (work.errors?.join(' | ') || `exit ${work.exit_code}`) : null,
      session: work.session,
      resumed_same_session: answer ? answer.session === work.session : null,
      transcript: opts.client === 'claude' ? claudeTranscript(work.session) : codexRollout(opts.codexHome, work.session),
      lab: { name: state.name, mode: state.mode, mcpPort: state.mcpPort, folder: state.folder, traces: state.traces },
      numbers: {
        first_mark_ms: firstWrite ? Date.parse(firstWrite.t) - t0 : null,
        calls: calls.length,
        write_calls: writes.length,
        scenes: scenes.length,
        errors: calls.filter((c) => !c.ok).length,
        wall_ms: t1 - t0,
        recorded_s: Math.round((tEnd - t0) / 100) / 10,
        watch_s: null,
        // From the agent's end to the app stopped: the last scene playing, the pictures and the interview.
        after_agent_ms: tStop - t1,
        interview_ms: answer ? i1 - i0 : null,
        frames: frames.length
      },
      per_tool: perTool,
      cuts: [],
      media: frames.length ? 'pending' : 'none',
      media_errors: mediaErrors,
      work: { exit_code: work.exit_code, is_error: work.is_error, cost_usd: work.cost_usd ?? null, num_turns: work.num_turns ?? null, tokens: work.tokens ?? null },
      interview: answer ? { exit_code: answer.exit_code, is_error: answer.is_error, session: answer.session, cost_usd: answer.cost_usd ?? null, tokens: answer.tokens ?? null } : null,
      agent_pids: pids
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    writeFileSync(join(dir, 'reply.md'), `${work.reply ?? ''}\n`)
    say(`first mark ${meta.numbers.first_mark_ms ?? '-'} ms, ${calls.length} calls (${writes.length} writes), wall ${(meta.numbers.wall_ms / 1000).toFixed(1)} s`)

    // The videos: after the app has stopped, in the background unless --wait-media.
    if (frames.length) {
      const labels = traceLabels(calls, { from: t0, opened: traceSessionOpen(state.traces, t0), turnEnd: t1 })
      const jobFile = join(framesDir, 'job.json')
      writeFileSync(jobFile, JSON.stringify({ dir, framesDir, frames, from: t0, to: tEnd, crop, labels, playing: scenePlaySpans(calls) }))
      mediaJob = { jobFile, logFile: join(dir, 'media.log') }
    }
  } finally {
    if (cdp) cdp.close()
    if (!appStopped && !opts.keepApp) say(`app stopped (PIDs ${(await stopInstance(opts.name)).join(', ')})`)
    // The media job owns the frames from here and deletes them; otherwise delete them now.
    if (!mediaJob) rmSync(framesDir, { recursive: true, force: true })
  }
  say(`gallery ${writeGallery()}`)
  if (mediaJob) {
    const out = openSync(mediaJob.logFile, 'a')
    // nice: the next run's app and screencast come first.
    const child = spawn('nice', ['-n', '10', process.execPath, join(LAB, 'media.mjs'), mediaJob.jobFile], { stdio: ['ignore', out, out], detached: !opts.waitMedia })
    closeSync(out)
    if (opts.waitMedia) {
      const tm = Date.now()
      const code = await new Promise((done) => child.on('exit', done))
      say(`videos made in ${((Date.now() - tm) / 1000).toFixed(1)} s (exit ${code}; log ${mediaJob.logFile})`)
    } else {
      child.unref()
      say(`videos are being made in the background (PID ${child.pid}; log ${mediaJob.logFile})`)
    }
  }
  say(`done: ${dir}`)
}

main().catch((error) => {
  console.error(`council: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
