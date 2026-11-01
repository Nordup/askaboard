# Perf: measure one change

Change one thing, measure it, and compare. The scripts write to `space/.lab/perf/`
(local only): one folder per run in `runs/`, one JSON line per run in
`history.jsonl`, and the latest table in `report.md`.

## Rendering: `render.mjs`

`render.mjs` measures what the worlds and the board cost on this machine, as it is now. The standard condition is the founder's M1 MacBook Air (2020) with Firefox, ChatGPT and Claude Code open (decision P20). Do not ask for a quiet machine: the load average and the top processes go in each run.

Run `npm run build` first. From `space/`:

```sh
node scripts/perf/render.mjs --label before                     # all scenes, about 3 minutes
node scripts/perf/render.mjs --scenes film,plain --label after  # the table shows the change against the last equal run
node scripts/perf/render.mjs --scenes film --tune '{"msaa":0}'
node scripts/perf/render.mjs --scenes film --matrix '[{"msaa":0},{"dpr":1},{"adaptive":0}]'
node scripts/perf/render.mjs --report                           # writes .lab/perf/render-report.md, a table over commits
```

Other options: `--seconds 10`, `--no-pan`, `--dev` (the dev renderer, slower than `out/`). `--scenes film --profile` writes `.lab/perf/profile-film.json` and `sample-film.txt`: CPU per process, a macOS `sample` of the busiest renderer, a Chromium trace, and CPU profiles of the page and the worker. It also saves `shot-film.png`.

One run starts a fresh app on ports 47882 / 9482, plays the scene, waits for its end, holds 10 s, and stops the app (exact PIDs). `film` also has a `pan` phase: 5 s of wheel pan and pinch zoom. `ink` has no world: it is the busy board of `scripts/bench/busy.mjs`, with pan and zoom for the whole run. The scenes are in `render-scenes/`:

| Scene | What it is |
| --- | --- |
| `film` | One molecule of 24 meshes in the film look. |
| `plain` | The same molecule in the plain look. |
| `toon` | The plain look with toon materials and a hull for each mesh. |
| `many` | One world with 400 separate meshes, turning. |
| `three` | Three worlds side by side, turning. |
| `ink` | The busy board, no world. |

Each phase adds one line to `.lab/perf/render-history.jsonl`. The line also has the window size and pixel ratio, the camera zoom, the top 5 processes, the commit and dirty flag, the three.js and Electron versions, the machine, the tune and the label. A table column with `-` has no value: `ink` has no world numbers. A line `PROBLEM` means that the run is not valid, and the exit code is 1.

| Column | Meaning |
| --- | --- |
| `pict/s` | Pictures per second that the world worker sent to the page. It follows the scene: a world that turns gives up to one per display frame. A still world gives none. |
| `GPU ms`, `p95` | The timer query per picture, median and 95th percentile. See the note under this table. |
| `timer` | The source of `GPU ms`. `timer`: `EXT_disjoint_timer_query_webgl2`, which works on the M1. `fence`: wall time from flush to fence, which is not pure GPU time. |
| `wall ms` | Wall time from the first render call of a picture to its fence. |
| `CPU ms` | Worker CPU time per picture in the render calls and the bitmap transfer. It does not include the world's own frame code. |
| `fps` | Page paints in one second (`requestAnimationFrame`). The meter's own loop asks for these paints. |
| `worst` | The longest page frame in the phase, in ms. |
| `drop` | Page frames over 20 ms in the phase. |
| `long` | Long tasks of the main thread in the phase. |
| `draws`, `tris`, `pass` | Draw calls, triangles and `renderer.render` calls per picture, over all passes. |
| `MP` | Output pixels of the worlds rendered per picture, in millions. A pass inside a world can use more pixels than this. |
| `res` | The lowest resolution share of a shown world in the phase. 1 is full resolution. Dynamic resolution lowers it while worlds move. |
| `util%` | `Device Utilization %` of `ioreg`, median over the phase. It is the whole GPU: this app, the window server and the other apps. |
| `load` | The 1-minute load average at the end of the phase. |
| `seen` | The share of the app window that shows on the screen, at the start of the phase. |
| `zoom` | The board zoom. `MP` changes with its square, so compare only runs with the same zoom. |

`wall ms` is the number for the frame budget. `GPU ms` is not. ANGLE's Metal backend adds up the GPU start-to-end span of each command buffer, with no handling of overlap (`QueryMtl.mm`, `onCommandBufferCompleted`). So `GPU ms` grows with the number of command buffers: a test with `gl.finish` after each pass took `three` from 40.6 to 314 ms, and `wall ms` stayed at 20.5 to 20.9 ms. Compare `GPU ms` only between runs with the same passes. `wall ms` has a fence poll step of about 1 to 4 ms, and it includes GPU work of other apps that comes first.

A run must never take the founder's screen. With `SPACE_WINDOW_AWAY=1` the window opens with no focus, 100 points past the right edge of every display, at 1280 x 770 points. It pins nothing. A `PROBLEM` line says when any of it shows on a display. `seen` is then 0, and this is a plain fact and no fault. In this state the page still paints at 60 per second, and wheel input moves the camera. `GPU ms`, `wall ms` and `pict/s` were the same as for a window in front (`film` 12.8 and 12.5 ms, `plain` 2.9 and 3.1 ms). `util%` holds no window server work for this window: compare it only between runs with the same `seen`. The window in front and the window away gave a difference inside the noise of `util%` in 2 scenes, and one other reading of `plain` was 55%. The cause of that reading is not confirmed.

`SPACE_WORLD_TUNE` holds JSON with measuring switches. An absent key changes nothing. They are not settings for users. `node scripts/lab/lab.mjs start --tune '<json>'` passes them to a lab app.

| Key | Effect |
| --- | --- |
| `msaa` | Samples of the scene target. The default is 4. |
| `hdr` | 0: 8-bit targets in place of HalfFloat. The floor shadow stays HalfFloat. The film look changes, because no value goes over 1. |
| `dpr` | A cap on the pixel ratio of the live path. |
| `adaptive` | 0: the resolution stays at the full share, so dynamic resolution hides no cost. Worlds still take turns inside the budget of a picture. |
| `bloom`, `dof`, `floor`, `env`, `shadows` | 0: that part is off for every world, in the film look too. |
| `surfaceMargin` | Overscan in CSS pixels per side. The default is 256. |

A world costs much more CPU in its first 20 s: the renderer with the worker used about 80% of one core 0 to 11 s after the scene ended, and 12% after 25 s. Compare CPU only at the same time after start. GPU numbers do not show this.

In the app, `window.__spaceDev.perf` has `start()`, `stop()` and `read()`. `src/renderer/src/perf-meter.ts` owns the page state and merges the worker's snapshot, which comes once per second. While it is off, neither the page nor the worker measures anything.

## Which runs to use

| Change | Measure with |
| --- | --- |
| Behaviour: the brief, the guide, tool descriptions, what the model sees | Big models: Claude `--model opus --effort medium`, Codex `--model gpt-6.1-sol --effort medium` |
| Behind the scenes: preview speed, the sandbox, waits, result sizes | `replay.mjs` (no model), or small models: Claude `--model haiku --effort high`, Codex `--model gpt-6-luna --effort high` |

Do not use effort `low` on the small models: their output is too degraded.
Give each code state a `--label`, and run the same command before and after the change.

## How close the lab is to the real apps

The lab runs the agents as the founder's desktop apps run them, so that what it measures is what a learner gets.

The same:

- The agent CLI and model of the real app (`claude`, `codex`), with the effort given.
- All of the agent's own tools, with no permission prompts. Claude: `--permission-mode bypassPermissions`, no tool allow-list (Bash, Write, Edit, Read, ToolSearch, sub-agents, WebSearch and WebFetch). Codex: `sandbox_mode = "danger-full-access"` (network on), `approval_policy = "never"`, `--search` (live web search). This is how the founder's own Codex config runs. `--no-web` takes the web tools away (Claude: `--disallowedTools WebSearch WebFetch`; Codex: no `--search`).
- The learning folder: `AGENTS.md` with the brief, `plan.md`, `learner.md`, an empty board; the agent starts inside it.
- The Learning Space MCP server with the same tools and texts, and the board news hook (`UserPromptSubmit`).
- The app itself: `--dev` (the default) runs the current source as `npm run dev` does.

Known differences:

- Headless: `claude -p` and `codex exec`, one prompt, no person who answers, watches or draws. No voice.
- A fresh session, a fresh app and an empty folder per run: no history, memory or earlier boards; caches start cold (the prompt cache too).
- A clean install: Claude loads only project and local settings (`--setting-sources project,local`) and only the Learning Space server (`--strict-mcp-config`); Codex uses its own `CODEX_HOME` with only the lab server. The founder's plugins, skills, other MCP servers and global instructions are not there.
- The agents reach the app over direct HTTP (`127.0.0.1:<port>/mcp`) from their config, not through an installed plugin. The relay's own time is not measured. A plugin bug does not show here: the Agent Plugin cut of all tool text was invisible in the lab (I30). To check through the plugin, see "A real plugin" in `docs/learning-space/working-guide.md`.
- Claude: the desktop app asks before some actions by default; the lab never asks. Codex: `default_tools_approval_mode = "approve"` for the Learning Space server (the desktop app asks once, then remembers).
- Codex: `service_tier = "default"`. The `[features]` lines of earlier lab configs (`js_repl = false`, `multi_agent_v2 = true`) are gone: in Codex 0.164 `js_repl` is a removed feature and `multi_agent_v2` is on by default.
- The app window is covered or in the background, with the switches that keep it rendering; the screencast of a video run adds CPU load.

## Scripts

| Script | What it does |
| --- | --- |
| `tasks.mjs` | The perf tasks. `orbit`: "Draw the Sun, the Earth on a circular orbit around it, and an arrow for the Earth's direction of motion." Add a task with an id, a title and the text. |
| `run.mjs` | A model run. A fresh app (dev by default) on ports 47880 / 9480, a fresh scratch HOME and learning folder, the agent headless from inside the folder (the prompt is the task alone; the brief comes from `AGENTS.md`), the board news hook. When the agent is done and the last scene has played, the app stops (exact PIDs). |
| `replay.mjs` | A model-free run. A fresh app on ports 47881 / 9481; the recorded calls of a run (`calls.json`, same args, same order) are sent again. Scene and item ids are mapped to the new ones. Calls of `run_scene` and `scene_control` (runs before 2026-10-26) are sent as the new scene tools (see the comment at the top of `replay.mjs`). Problems (a cut arg, an unknown tool, a call that fails now) are listed in `metrics.json` → `replay.problems`. |
| `report.mjs` | A markdown table from `history.jsonl`: one row per group (median), or per run with `--runs`; the change against `--baseline <label>` in %. |
| `metrics.mjs` | Shared: paths, the code identity, the numbers from the calls. `node scripts/perf/metrics.mjs <run folder>...` computes runs again: metrics.json, its history line and timeline.md. |
| `timeline.mjs` | Where a run's time went, from the run folder only: the model turns and the agent's own calls (from the archived transcript), the MCP calls (calls.json), the app's spans and scene events (trace/). Writes `timeline.md`. |

The agent turns (`claudeTurn`, `codexTurn`, `prepareCodexHome`) and the app
start and stop are shared with `scripts/lab/council.mjs` through `scripts/lab/common.mjs`.

## Commands (from `space/`)

```sh
node scripts/perf/run.mjs --client claude --model opus --effort medium --task orbit --repeat 3 --label before
node scripts/perf/run.mjs --client codex --model gpt-6.1-sol --effort medium --task orbit --label before
node scripts/perf/run.mjs --client claude --model haiku --effort high --task orbit --label before
node scripts/perf/replay.mjs --from .lab/perf/runs/<run folder> --repeat 3 --label before   # --gaps original keeps the model's pauses
node scripts/perf/report.mjs --task orbit --baseline before            # --kind model|replay, --last N, --runs
```

`replay.mjs --learner-ink N` draws N pen strokes around the board's centre before the
first call (with `scripts/drive.mjs draw --fast`: about 7 s for 300 strokes; one ink
group per row, as at pen speed). Use it to measure playback over a board with
much learner ink. `replay.mjs --profile` records a CPU profile of the app window for the
whole replay (`renderer.cpuprofile` in the run folder; open it in Chrome DevTools) and
prints the 25 functions with the most self time. The profiler adds load: do not compare
its frame times with runs without it.

The frame meter (`FRAME_METER` in `metrics.mjs`) is a page script that runs in the app
window over the debug port. It uses `requestAnimationFrame`, so it measures only a
window that renders: the lab instances start with the switches that keep a covered
window rendering. The screencast of a video run adds frames and CPU load, so compare
frame times only between runs with the same `video` setting.

Both scripts record the board as video by default (`--no-video` turns it off). The
screencast costs some CPU, so compare only runs with the same setting (`video` in
`metrics.json`). Each image that a call returns (for example a preview's storyboard) is
in `trace/`; a replay's `calls.json` names it per call (`image_files`).

Parallel runs: give each one its own `--name <instance>` (the lab folder and state under
`/private/tmp/claude-501/ls-lab/`) and its own `--mcp-port` / `--debug-port`. Parallel runs
load the same machine, so their times are noisy: take the numbers that decide a change
from a run when nothing else runs.

Other options of `run.mjs`: `--built` (runs `out/`; run `npm run build` first), `--no-web`,
`--no-news-hook`, `--timeout-min 15`, `--mcp-port`, `--debug-port`. Codex uses its own
`CODEX_HOME` at `/private/tmp/claude-501/ls-lab/codex-home-perf` (the login is a symlink).
`--dev` (the default) measures the current source; `--built` measures whatever `out/` holds.

A run folder holds `prompt.md`, the agent output (`work-claude.jsonl` (one event per line, so a silent agent shows) or `work-codex.jsonl`),
`reply.md`, `calls.json` (with each call's app `spans`), `trace/` (the app trace, its images and the scene
events), the agent's transcript (`transcript-claude.jsonl`: the session from `~/.claude/projects/`;
`rollout-codex.jsonl`: the Codex rollout), `metrics.json`, `timeline.md`, and
(unless `--no-video`) `video-real.mp4`, `video.mp4` (the watch video) and `frames.json`.
A replay folder holds the same, without the agent output.

## The numbers (`metrics.json`, one history line)

All times are seconds from the agent's start (replay: from the first call).

| Field | Meaning |
| --- | --- |
| `kind`, `task`, `client`, `model`, `effort`, `label`, `timestamp`, `mode` | What ran: `model` or `replay`; `dev` or `built`. |
| `code` | `commit` (HEAD), `dirty`, `diff_hash`: a hash of `git diff HEAD` and the untracked files in `space/src` and `space/resources`. The same hash means the same code. |
| `time.wall` | The agent process from start to exit (replay: until the last call returned). |
| `time.first_call`, `first_scene`, `first_play` | The start of the first tool call, the first scene program (`write_scene`; `run_scene` before 2026-10-26, a preview too), the first play (`play_scene` start; `run_scene` without preview). Metrics from before 2026-10-26 call `first_scene` `first_run_scene`. |
| `time.first_visible` | The first board pixel change at or after the first scene program, from the screencast (null with `--no-video`). In a replay it is app time only. `last_visible`: the last change. |
| `time.done` | The last end of a scene that played to its end (outcome `played`), from the app's scene events (`done_source: "scene events"`). Scenes that `play_scene` stop ended do not count. Runs and replays before 2026-10-28 have no scene events: `done` is null when they are computed again (their metrics.json keeps the earlier estimate), and report.mjs shows a replay's end of playback (`total_with_playback`). |
| `app.scene_ends` | How the scenes ended, from the scene events: `played` (to their end), `stopped` (`play_scene` stop), `other` (cancelled, removed, cut, replaced, by name). timeline.md shows the same counts. |
| `time.first_stroke` | The board presented the first frame of the first scene (the app's `first_frame` scene event). `first_visible` is a pixel change in the video. |
| `time.startup_s`, `model_gen_s`, `mcp_s`, `waits_s`, `own_s`, `tail_s` | The exclusive partition of the wall time (`partition` has all buckets and `unattributed_s`). Each instant goes to one bucket, in this order: play_scene waits (`wait: "end"` and action `wait`, which play_scene had until 2026-10-28), MCP tools, the agent's own tools, model generation, startup (agent start to the first model request), tail (after the last call). |
| `milestones` | First model request, first MCP call, first write_scene, first play, first stroke, each scene's end and outcome, the last call's end, the agent's exit. |
| `model_tokens`, `turns` | Per model turn: start, end, output tokens (with reasoning), context tokens (Claude: input + cache read + cache write; Codex: input), tokens per second. Claude: a turn starts at its `api-request` entry; Codex: at the tool output before it. |
| `own_calls`, `could_not_do` | The agent's own tool calls (Claude: every non-MCP tool, server web search; Codex: shell commands, sleeps, web searches, patches) with start, duration and ok / failed / denied; `could_not_do`: every failed or denied call (own, MCP, failed Codex exec scripts) with the first 300 characters of its error. |
| `received` | What the agent got before it worked: Claude's request shapes (system prompt, tools, MCP tool schemas, in characters); Codex's base instructions, AGENTS.md and tool list. |
| `read.guide_topics`, `read.by_tool` | get_guide topics with their sizes and times; result characters and images per MCP tool. |
| `app_spans` | Per scene call, where the app spent its time (ms): write_scene `snapshot_ms`, `queue_ms`, `stage_ready_ms`, `stage_run_ms`, `body_ms`, `sampling_ms`, `encode_ms`, `board_wait_ms`, `bake_ms`, `live_check_ms`, `compile_ms`; preview_scene `rerun_ms`, `frames_ms`, `stills_ms`, `picture_ms`; play_scene start `queue_ms`, `commit_ms`, `wait_ms`, `scene`; get_screenshot `capture_ms`, `window_ms`; every call `news_ms`. Per scene: first frame, end, outcome (played, stopped, cancelled, removed) and cuts or replaces. |
| `time.tool_s`, `agent_s` | Time inside tool calls (parallel calls count once), and the rest of `wall`. |
| `time.model_s` | Model time from the client. Claude: `duration_api_ms` of the JSON output (`client_duration_s`: its `duration_ms`). Codex: the rollout's `task_started` → `task_complete` minus tool time. |
| `calls` | Total, errors, per tool; `scene_previews` (`preview_scene` calls; `run_scene` with preview), `scene_plays` (`play_scene` start; `run_scene` without preview), `scene_errors` (`write_scene` and `play_scene` start; `run_scene`), `scene_wait_end` (plays with `wait: "end"`, which play_scene had until 2026-10-28), `scene_waits` (`play_scene` / `scene_control` wait). Metrics from before 2026-10-26 have the same counts as `run_scene_*` and `scene_control_waits`. |
| `written.total` | Characters the model wrote into tool args (the JSON of the args, without the files a `write_scene` read: `snapshot`) and into files (`written.files.total`). |
| `written.files` | Characters the agent wrote into files with its own tools, in all and per path (`by_path`, from `boards/` on): Claude's Write `content`, Edit and MultiEdit `new_string` (from the session transcript); `apply_patch` added lines, `cat > file <<EOF` heredocs, and the whole text of any other command that writes into `boards/scenes/` (a python or sed edit), from Claude's Bash commands (relative paths from the shell's directory) and Codex's commands (from the rollout, including the commands inside its `exec` tool's JavaScript; without it, from `work-codex.jsonl`'s shell commands). One parser reads both clients' commands. Runs before 2026-10-28 have no field: 0. `node scripts/perf/metrics.mjs <run folder>` computes the numbers of a run again. |
| `written.scene_code`, `repeat_chars`, `repeat_share` | The program code (`write_scene`: its inline code, or for a file the text the agent wrote into `boards/scenes/` since the program before; `run_scene` before 2026-10-26, then named `run_scene_code`), the code of calls whose code is ≥ 0.9 similar to the program before it (Python `difflib` ratio, no autojunk), and its share. |
| `read` | Result text characters (full length, also when the trace cut it at 32 KB), images, their bytes and pixels. |
| `app` | Preview ms and play ms (median, max) of the calls counted in `scene_previews` and `scene_plays`; `wait_ms_total`: waits and plays with `wait: "end"` (until 2026-10-28; play_scene has no wait since T23). A play with `wait: "end"` includes its playback. |
| `usage` | Claude: `cost_usd`, `num_turns`, tokens. Codex: tokens (no cost). |
| `frames` | Replay only: the animation frames while a scene plays and is not paused. `interval_ms`: the time between two frames (what the learner sees). `work_ms`: the main thread's work for one frame, from the frame's start to the first task after its rendering. Each has `median`, `p95` and `max`. `long_50ms`: the intervals over 50 ms (stalls). `count`: the frames measured. The raw values ([interval, work] per frame) are in `frame-times.json`. |
| `learner_ink` | Replay only: the pen strokes drawn before the first call (`--learner-ink N`). |
| `per_tool` | Per tool: calls, errors, ms, written, read. |
| `replay` | Replay only: calls recorded and replayed, app ms in all and per tool against the recording, problems. |

## Limits

- Scene events and app spans exist from 2026-10-28 on; older runs show blanks there.
- Claude turns start at their `api-request` entry, so the seconds between the prompt and the first request count as startup. The `breakdown.md` of 2026-10-28 started them at the prompt: its model time is 1–2 % longer.
- `first_visible` counts any pixel change on the canvas except its top 8 % and bottom 15 % (`scripts/lab/frame-changes.py`), so a moving indicator in that area can count.
- Codex `model_s` is an estimate: the CLI start and the hook are outside the rollout span.
- The trace cuts args at 200 KB: a replay sends the cut text and says so.
- One perf run at a time per script (fixed instance names `perf` and `perf-replay`).
