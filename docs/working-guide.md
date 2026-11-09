# Askaboard — how to work on it

Practical knowledge for agents that build and check Askaboard. The
binding rules are in [`../AGENTS.md`](../AGENTS.md) and
[`../CLAUDE.md`](../CLAUDE.md); this file explains how to follow them
and what went wrong before.

## The founder

- Speaks to agents by voice; messages come through speech-to-text. Read
  intent, not spelling: "iPod" means iPad, "codecs" means Codex, "Cloud" or
  "Clod" means Claude, "paper desktop" means the Paper design app.
- Wants to stay in control of product decisions. Research the options, explain
  them with concrete learning examples, recommend one, and let the founder
  choose. Ask with buttons, not long prose.
- Design taste: dark, calm, compact, IDE-like (as the Codex app and Claude Desktop).
  Rejects anything with too much text, too many buttons, or a look that does
  not match the rest of the app. **Show a mockup first** (the inline widget
  tool works well), build only after approval, and match the mockup exactly,
  including spacing.
- Prefers small, finished steps that work in the real app over large plans.
- Says "commit and push" explicitly when wanted; `AGENTS.md` says to ask
  before pushing otherwise. Work happens on `main`; the public
  `learning-space-plugins` repo is a separate checkout.

- Wants to talk through **how** a fix will be built before it is built:
  propose the design, listen, and let the founder's picture decide.
- For text that agents read, follow [`writing-agent-text.md`](writing-agent-text.md).
- Agent text changes start as a draft in the private notes repo
  (`../askaboard-notes/history/drafts/`), sent
  to the founder, applied only after "approved", then measured in the lab.
  When asked to fix one passage, change only that passage, in the voice of
  the whole brief, and read the whole brief first.
- When the founder says work could go to "a second session", they start and
  steer that session themselves. Never start one for them unasked (2026-10-29).
- Explains architecture without file names: what lives where, what happens
  when, at an architect's level. Wants to understand before deciding.
- Reviews UI by using it: short notes ("unsmooth", "nothing happens") point
  at a real problem. Find the cause (for example a jump at a paragraph gap),
  show it in a new mockup, then build.
- Judges lab runs by watching the videos; when away from the computer, wants
  them sent to the phone.
- Judges a library by how its best work looks: "if what they do is not really
  good, doesn't look good, then we're not gonna use it at all". Show pictures
  first, not catalogs. Objects with no frame, on the board's own dark
  background, are the look that impressed the founder (2026-10-31).
- "Stop", "think" or "just update the docs" means start nothing: no agents, no
  designs, no tests. A choice of direction is a talk first.
- A job named for a whole set means the whole set: "I need it for existing
  scene in attention board" meant all seven scenes. Do not stop after the
  first item to ask (2026-11-02). The order that the founder gives stays: on
  the voice, the fix came first and the generation for all scenes came after.
- The MacBook has little free storage. A new kind of file that the app writes
  needs an owner for its clean-up from the first commit (T35).
- UI taste (2026-11-06/07): soft, wide shadows with no dark band; corners a little round;
  no outline on status items or buttons (a soft fill instead); no empty
  strips or gaps that look unused; controls of one family look alike (a
  button looks like the dropdown next to it). When the founder sends a
  screenshot for a feel, take the feel, not the pixels, and show a mockup first.

## The workflow that worked

1. **Plan the step** with the founder; record decisions in
   [`decisions.md`](decisions.md) and status in the private launch plan
   (`../askaboard-notes/launch-plan.md`).
2. **Research with Haiku agents** in parallel (one narrow question each,
   sources required, "NOT FOUND" instead of guesses).
3. **Implement with one Opus agent** (medium effort) per area; two at once
   only when their files do not overlap. The brief names the files, the
   rules, the exact acceptance checks, and the ports/folders to use.
4. **Check with a Haiku agent** against the real app, ideally with a real
   agent client (see below). The main session reads at most one or two
   screenshots for design judgment.
5. **Measure behaviour changes:** for anything that changes how agents act
   (the brief, tool descriptions, perception), run the bench twice before and
   after (see `apps/desktop/scripts/perf/README.md`), and let the founder try a real
   session.
6. **Commit per step** with a clear message; push when the founder asks.
7. Resume the same implementer with `SendMessage` for follow-ups on its own
   code; start a fresh agent when its context has grown very large.

## Checking the app without touching the founder's setup

| Need | How |
| --- | --- |
| Own app instance | Start the Electron binary directly: `HOME=<scratch home> SPACE_FOLDER=<scratch folder> SPACE_MCP_PORT=<47822…> SPACE_REMOTE_DEBUG=<93xx> ./node_modules/.bin/electron --user-data-dir=<scratch> .` (from `apps/desktop/`). The founder's app uses port 47821. Without a scratch `HOME`, the instance writes its port into the founder's `~/.askaboard/relay.json` (and `tools.json`, `bin/`), and the founder's agents then connect to it (happened twice on 2026-10-29). On Linux, in a shell that an agent app started, put `env -u ELECTRON_RUN_AS_NODE` first (see the pitfall below). |
| Dev-mode check | Run `electron-vite dev` with the same env vars and a `--user-data-dir` too. React StrictMode only exists there. On macOS a scratch `HOME` does not move Electron's user data: without `--user-data-dir` the run writes into the founder's `~/Library/Application Support/Askaboard/state.json` (happened 2026-11-03). |
| Drive input | `node scripts/drive.mjs --port <debug port> …` draws pen strokes with pressure, presses keys, clicks, drags, wheels, takes screenshots, prints state. Works while the window is behind other windows. |
| A real agent client | `claude -p "<prompt>" --model haiku --mcp-config <json> --strict-mcp-config --allowedTools "mcp__askaboard__*"`. Put the prompt **before** `--allowedTools` (the flag swallows following words). |
| A multi-turn session | First run `claude -p …`, then `claude -p --continue …` from the same folder. Separate `-p` runs are separate conversations. |
| A learning folder | Run `claude` from inside the folder so `AGENTS.md` loads. It loads into context, so it never shows up as a file read in a tool trace. |
| CLI installs (plugins, `mcp add`) | Redirect `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to scratch folders. Compare hashes of the founder's real configs before and after. |
| The relay | Set `HOME` to a scratch folder for the app and pass `ASKABOARD_PORT` in the client's MCP config env. |
| Cleanup | Record the PIDs you start and stop only those. Never `pkill -f` a pattern: it once killed another check's instance. |
| Measure agent behaviour | `node scripts/bench/run.mjs --scenarios S1,S2,S3,S4 --model opus --out <dir>` (after `npm run build`; ports 47870/9470; `--dev` for the dev renderer). One trace: `node scripts/trace-report.mjs <file or folder>`. The set-up writes with scenes (one scene per seeded item, shown at once); check a set-up change without an agent by importing `scripts/bench/busy.mjs` and `scenarios.mjs` (never `run.mjs`) and seeding a lab app. |
| Measure one change (perf) | `node scripts/perf/run.mjs --client claude --model haiku --effort high --task orbit --label <state>` (fresh app on 47880/9480; `--video` for the first visible change), `node scripts/perf/replay.mjs --from <run folder>` (no model; 47881/9481), `node scripts/perf/report.mjs --baseline <state>`. Behaviour changes: opus / gpt-6.1-sol at effort medium; behind-the-scenes changes: replay, or haiku / gpt-6-luna at effort high. See `scripts/perf/README.md`. |
| Measure rendering | `node scripts/perf/render.mjs --scenes toon,many --label <state>` (after `npm run build`; ports 47882/9482; `--dev` for the dev renderer, `--tune '<json>'` for one switch). The window opens at its normal place with no focus, so the founder keeps the keyboard and can bring it forward. Run it in the standard condition (P20), and do not ask for a quiet machine. See `scripts/perf/README.md`. |
| Compare two builds of rendering | Measure both on the same day, in turns (old, new, new, old). A history line of an earlier day is not fair: on 2026-11-01 the same code gave 10 to 15 percent less after the machine load changed. For the old build: `git worktree add --detach <scratch>/old <commit>`, link `apps/desktop/node_modules`, `npm run build` there, and `git worktree remove --force` after it. Read `--capped` for what a person sees. Uncapped `fps` counts page frames, so it can fall when the app does less: the board pan gave 92 fps against 115 with a quarter of the CPU. For a board change, read renderer CPU, paint time, GPU util and the worst frame. |
| A real plugin (Codex) | The lab connects from config, so it misses plugin bugs (I30). Copy `../learning-space-plugins` without `.git` to a scratch folder and set the lab port in `plugins/askaboard/mcp*.json`. In a scratch `CODEX_HOME` add `[marketplaces.learning-space]` with `source_type = "local"` and that folder, and `[plugins."learning-space@learning-space"]` with `enabled = true`, then run `codex plugin add learning-space@learning-space`. Put a `codex` wrapper first on `PATH`: it swaps the `[mcp_servers.learning-space]` block that `council.mjs` writes for those lines and runs the app's Codex with `-c features.code_mode_host=true` (macOS: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`; Linux: the `codex` command, `~/.local/bin/codex` on the founder's Linux machine; the plugin path is not checked there). Run `council.mjs --codex-home <home>`. The rollout in `<home>/sessions/` shows what the model received. Keep the scratch files out of the repo. |
| Measure perception | `node scripts/bench/run.mjs --scenarios P1,P2,P3 --model opus --out <dir>`: a busy board, a prior look, then new learner work and a new connection (about 5 minutes per run). |
| Board news hook in the bench | On by default: the agent gets the plugins' `UserPromptSubmit` hook against the run's own app (Claude: `--settings`; Codex: `-c hooks.UserPromptSubmit=…` with `--dangerously-bypass-hook-trust`). `--no-news-hook` measures without it. `metrics.json` → `news_in_prompt` (Codex) holds the line that reached the prompt. Board news is delivered once per agent app and board: after the hook sent it, the tool results of that turn do not repeat it. |
| Read a real session of the founder | Askaboard trace: `~/.askaboard/traces/<date>/` (`node scripts/trace-report.mjs <file>`). ChatGPT voice sessions run as Codex threads: `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`, names in `~/.codex/session_index.jsonl`; each voice request arrives as a user message from the voice model. The files hold base64 images: parse line by line, never print them. Read only. |
| Keep the founder's focus | Launch with `SPACE_NO_FOCUS=1`. On macOS, after launching, also `osascript -e 'tell application "Claude" to activate'`. |
| Settings and the voice (2026-11-06) | Launch with `SPACE_FOLDER` (the welcome screen has no Settings route), then `node scripts/drive.mjs --port <debug port> menu settings`. A Kokoro install check needs a scratch `HOME` (it writes about 370 MB to `~/.askaboard/models/kokoro/`): delete that folder after the check. A check agent cannot hear: confirm playback from the renderer (an audio element's `currentTime` moves after `play()`). |
| UI checks (2026-11-07) | `drive.mjs`: `hover x y` (tooltips), `menu <id>` / `menu-state <id>` (CDP keys never reach a menu accelerator such as ⌘K or ⌘[, so drive the menu item), `select <css> [label]` (the app's dropdown), `element-rect <css>` for measured gaps. Full screen without moving the window to a new desktop Space: `SPACE_FAKE_FULL_SCREEN=1` with `SPACE_REMOTE_DEBUG`. Never put a check window into real full screen. |
| Usage data from a check | A run of the built app (`electron .` on `out/`) sends events by default, tagged `dev`; a dev renderer run sends nothing unless `ASKABOARD_TELEMETRY_ENABLED=true`. Set `ASKABOARD_TELEMETRY_ENABLED=false` in checks that do not test usage data, or filter `dev` in PostHog. |

## Choosing lab tests (live drawing)

**The only way to see real agent behaviour or to make an example** (founder,
2026-11-07; the website's use cases too, D16): a council run with `--brief-only` and the user's exact sentence
as the task, for example
`node scripts/lab/council.mjs --client claude --model opus --effort medium --brief-only --task "How does my phone know where I am?"`.
The agent then gets what it gets in the app: the brief, the guide and the
MCP tools, and nothing from us. The founder:

> this is the only way to test how the agents behave like in the app and
> when you're trying to emulate something or trying to create examples and
> stuff, this is the only way

The founder's own setting is Opus at medium effort; pass `--effort medium`
(without it, `claude -p` uses its default effort).

**The learner's work before the agent** (D17). When the request needs the
learner's own work on the board (an exercise they tried, a drawing), write it
as a scene program in `apps/desktop/scripts/lab/council/learners/` with `write()` and
`stroke()` and pass `--learner-board <program.js>`. `learner-board.mjs` runs it
through the app's own scene library and hand and writes the strokes into the
board file as the learner's ink, so the app opens with it. Do not draw your own
strokes or send pen input. Give the pen colours as CSS values (`#5fd38d`
green, `#6e8bff` blue; `apps/desktop/src/renderer/src/tools.ts` `INK_COLORS`): what
someone gave the learner (the exercise) in one colour, the learner's own work
in another. Place it in the learner's view (about -607..607 × -427..427 board
points in the lab window) so the agent's work can balance it, and leave room
between lines. A learner's file (a spreadsheet) goes in with `--file <path>`
(`council/files/`). Check the board once before the run:
`node scripts/lab/learner-board.mjs <program.js> <out.json>` writes the board file.

**A video of a lab run with the voice** is the council run's own `video.mp4`
(cut, with the voice) or `video-real.mp4` (real time, with the voice) in the
run folder. Do not use `record.mjs` for this. `record.mjs` renders an existing
scene again frame by frame on several app copies, and it opens several windows
on the screen. Use it only for a fixed-clock launch video of an existing scene.

**Website use cases** (D16, D17). The site plays the agent's own scene in the
browser with JavaScript; no video is recorded. After the run, export the scene
with `node scripts/lab/export-scene.mjs <record.jsonl> <scene.js> <out.json>`
(the record is `<lab folder>/.askaboard/scenes/<board>.jsonl`, the program
is the agent's file in `boards/scenes/`, unchanged), convert the voice clip
(`.askaboard/voice/<hash>.wav`) to `.m4a` with ffmpeg, and add a module in
`apps/website/components/usecases/` that calls `agentScene()`.

Lab and perf runs give agents what the real apps give them (decision W10):
Claude with every tool and `--permission-mode bypassPermissions`, Codex with
`danger-full-access` and the network, web on unless `--no-web`. Each perf run
writes `timeline.md` (where the time goes) and keeps the agent's transcript.
Videos stay out of git (`*.mp4` and similar are ignored). So do images:
`.gitignore` ignores every image outside the asset folders. Save check
screenshots anywhere (for example a draft's folder); they stay local.


The council tasks are in `apps/desktop/scripts/lab/council/tasks.json`; each has a
`covers` list. The founder's rule (2026-10-25): **keep the same tests so runs
can be compared, and run only the tests that show what changed** — not the
whole set every time, and one run per model is usually enough.

| What changed | Run |
| --- | --- |
| Drawing engine, timeline, values, labels | `sphere` (and `em-wave` for motion) |
| Worlds, 3D, interaction | `em-wave` (and `heart`) |
| The brief or other agent text | `seasons` and `fusion`, with `--brief-only` |
| Reading the learner's work | `fusion` |
| Pages, frames, images, HTML in scenes | `fractions`, `rome` |
| Style, painting, colour | `sunset` |
| Charts and data; the habit of titles, labels and formulas | `stddev` |

Use `--brief-only` to measure what a real session sees (the brief through
`AGENTS.md`, no council purpose text); without it the prompt starts with
`council/purpose.md`, which says the purpose out loud. Compare with the
earlier runs of the same task in the private notes
(`../askaboard-notes/history/live-drawing-log.md`).

Use `--no-code` (also on `lab.mjs start`) to measure a run without worlds:
the app starts with `LS_LAB_NO_CODE=1`, scenes have no `world()`, and the
brief, the guide and the tool descriptions leave out the spans marked `<!-- code-items -->` /
`codeItems()` (`src/main/lab-switch.ts`). `meta.json` records `no_code`.
`--no-html` does the same for HTML material (`LS_LAB_NO_HTML=1`: no
`html()`, no `get_item` form "html", no html/svg topics; markers `<!-- html -->`,
`htmlMaterial()`), and `--brief <file>` (`LS_LAB_BRIEF`) serves a draft
brief instead of `resources/brief.md`, with the markers applied. They
combine; `meta.json` records `no_html` and `brief`.

## Pitfalls we hit

- **Playback changes need a check over time, not stills** (2026-10-27): an ink speedup passed still-picture checks while a pendulum's string came off its bob in motion. Measure an invariant over many playback times with `__spaceDev.scene.snap()`, then compare video frames. Known failure classes and where they live: [`playback-pitfalls.md`](playback-pitfalls.md).

- **A dev app with an empty `SPACE_FOLDER` cannot run scenes** ("No board is
  open"). Fill the scratch folder with `scripts/boards/make-demo-folder.mjs`
  before launch.
- **GPT stopped previewing** while Claude kept doing it, so GPT's mistakes
  (a 3D curve that folds back, labels on lines) reached the person first.
  Fixed by saying when to preview (I22). Count previews per model in
  `calls.json` when a model's drawings look careless.
- **StrictMode double mount:** a cleanup cancelled animation frames without
  clearing their slots, so the board stopped following the camera in dev
  mode only. Every check passed on the built app. Now: check dev mode too.
- **Computer use from subagents:** auto permission mode blocked the actions
  and reported them as "user interrupt" until the background `app_*` tools
  were allow-listed in `.claude/settings.local.json`. Even then, background
  drags fail on a window that is not in front. Use `drive.mjs` instead.
- **Haiku checkers misread results** at times (for example "AGENTS.md was
  not read"). Judge the evidence yourself before acting on a checker's
  conclusion.
- **The founder's app runs in dev mode** while agents edit code: Vite reloads
  half-finished edits. Tell the founder to restart after a change lands.
- **One instance overwrites `~/.askaboard/relay.json`.** A dev instance
  started with the real `HOME` points the relay at itself.
- **Hand-made MCP entries plus the plugin** double every tool. The Connect
  popover detects and fixes this.
- **Codex `config.toml` model setting** (`gpt-6-luna`) was rejected by the
  founder's account during one check; that is the founder's config, not ours.

- **Never `import` or `node -e` the bench runner** (`scripts/bench/run.mjs`): importing it runs `main()` and starts a real Claude bench (it happened once and used the founder's limits).
- **A test app instance must get a scratch `HOME`.** One launch without it overwrote the founder's `~/.askaboard/relay.json` (port), `tools.json` and the relay command; the founder's app rewrites them on its next start.
- **Codex in the lab, perf and bench runs** needs the Askaboard tools approved (`default_tools_approval_mode = "approve"`): with `approval_policy = "never"`, Codex declines MCP write tools that are not approved. All three use the shared `prepareCodexHome` in `scripts/lab/common.mjs`.
- **Codex ignores plugin hooks until the user trusts them** (`/hooks`). The bench passes `--dangerously-bypass-hook-trust` for its scratch home only.
- **Review before push:** the founder reviews each fix (the problem, the measurement, the change, the result) before its commits are pushed.

- **Write check scenes the way the guide says** (2026-10-29): `step()` is a
  global; `write()` alone takes no time, so wrap it in `await draw(...)`;
  `say()` without `await` lets the next drawing start at once (a voiced line
  still waits for the voiced line before it). A check scene with these
  mistakes put three steps at time 0, and the check meant nothing.
- **A background window throttles animation frames.** Stills taken right
  after a seek or `finish` can show the teleprompter still easing. Take
  several screenshots 0.5 s apart and keep the last one.
- **A second `play_scene start` of the same draft** says "No draft named …".
  That is correct: the first start used the draft. Haiku reports put these
  calls in the wrong order once; read the trace.
- **zsh does not split an unquoted variable** in `for c in $LIST`. A loop
  over commit ids ran once with the whole list. Write the ids out, or use
  `${=LIST}`.
- **A `.gitignore` exception can bring back an ignored folder.** `!Vendor/**`
  re-included `Vendor/.build` and a local `.xcconfig`. Exceptions name file
  types only (`!assets/**/*.png`).
- **Take files out of unpushed commits without touching the disk:** `git
  reset --mixed origin/main`, then for each old commit `git read-tree <c>`,
  `git rm -r --cached <paths>`, `git commit -C <c>`. Never `checkout`,
  `restore` or `stash` (the founder's edits).
- **A failed agent attempt is not a failed library.** On 2026-10-31 one agent
  tried many engines in one 40-minute run and reported runtime errors in our
  worker as engine failures. Report "our attempt failed" with the error, and
  check the claim before it reaches the founder. Test a recipe once before
  agents depend on it.
- **esm.sh can fail.** During those runs it answered "no space left on device"
  for several packages. jsDelivr `+esm` worked for some. Real use needs local
  bundles. Package notes from those runs: use `babylonjs`, not
  `@babylonjs/core` (a shader module failed to load); PixiJS needs its
  `dist/webworker.mjs` build.
- **`drive.mjs scene` can go stale after `open_board`.** Reload the renderer
  after each `open_board`.
- **Screenshots of web demos with the real GPU:** Chrome headless with
  `--headless=new --use-angle=metal --enable-gpu --ignore-gpu-blocklist
  --virtual-time-budget=9000 --screenshot=<file>` and a new
  `--user-data-dir`. Tested on the founder's Mac on 2026-10-31. Metal is
  macOS only; the Linux flags are not checked.

- **A check launch needs a scratch `HOME` and its own `--user-data-dir`.** Every launch rewrites `~/.askaboard/relay.json`, `tools.json` and the shim. Without a scratch `HOME`, the founder's agents point at the test app. Electron ignores `HOME` for its settings on macOS: without `--user-data-dir`, a test folder lands in the founder's `state.json` (both happened on 2026-11-02). On Linux, Electron keeps its settings under `$HOME/.config`, so a scratch `HOME` also moves them; pass `--user-data-dir` anyway. `npx electron . --user-data-dir=…` takes the switch; `electron-vite dev` needs it passed through. Copy only the key line to the scratch `.askaboard/.env`.
- **An `<audio>` element needs `content-length` and byte ranges from a custom protocol.** Without them `duration` is Infinity, `seekable` becomes [0,0], and every seek goes to 0.
- **`npm run build` in the repo can stop a running dev app** (2026-11-02). It rewrites `out/` under it. While the founder's app runs, type-check with `npx tsc --noEmit -p tsconfig.node.json`, and build and run in a scratch copy with `node_modules` as a symlink.
- **A real 429 costs up to a minute.** Flash-Lite TTS allows 10 requests per minute on Tier 1, and the same scene text is a cache hit. The app obeys `retry-after` when the wait leaves 10 s of the 45 s. Keep the checks of parallel agents to a few new texts.
- **Generate speech for many scenes only after the sound is right** (2026-11-02). Each change of text or join makes new clips and uses up the rate limit. Fix one scene, let the founder hear it, then generate the rest in one run.
- **Speech tags can sound like a break.** `<long pause>` gave gaps of up to 4.1 s and a reading tone at each end. Waveforms showed no fault in the file: the founder's ear found the problem first, so take a sound report as true and measure after it.
- **A clean-up reads before it deletes.** A read failure stops the step, and a board id list that is not complete counts as no list (`boardIds()` returns null). Keep this rule for any new clean-up: an unknown state must keep the file.
- **`codex exec` in a background shell hangs on stdin.** It reads stdin as well as its prompt. Add `</dev/null`, or it waits forever on "Reading additional input from stdin..." and never calls the model (2026-10-30: 70 minutes lost).
- **A failure list is not "expected" until someone looks at it.** Of 20 scenes that failed in the full set, only 6 were built to fail. 7 were the founder's multi-file scenes that the check ran wrongly (their code joined inline, not from files), so they had no coverage. Name why each one fails, and run multi-file scenes from files.
- **A council run clears the shared council scene folder.** Copy each run's scene files before you start the next run, or you must rebuild them from `work-claude.jsonl` (2026-11-03).
- **A font change moves sizes on old boards.** Raise `BOARD_LAYOUT` (`src/shared/board-format.ts`) and check an old board after a restart: its group frames, its replayed scenes and a new scene that measures the same text (B60).
- **Check the load before you read a timing.** `uptime` first. A lab that shares the machine with a scene set shows `commit_ms` of 2.4 s where a quiet run shows 0.3-0.4 s.
- **Replay speed is measured on a dropped scene.** Launch a fresh scratch copy of the folder: after a launch every scene is restored, so each replay rebuilds (log line `stage: ran N of M programs again`). The scene pill menu lists scenes newest first (item 1 is the last scene). Use a new folder copy for each run: two replays of one scene on one folder can leave doubled items, which look like a fault of the change.
- **A comparison needs a before state.** `git archive <commit> space` into scratch, link `node_modules`, build, and `git init` there: `replay.mjs` needs a git folder. Replays against the old build gave the only exact preview numbers.
- **Give a check agent plain shell commands** (2026-11-02). Claude Code's safety check refused a block with no `rm` in it, because it could not parse zsh-only expansions (`${=spec}`, `${(s:,:)x}`) and a command name in a variable. Use literal paths and a few calls per block. A rewrite in another language to pass a refusal is a workaround: stop and report the text.
- **A check click can land on the app's own parts** (2026-11-02). A click on a world's bar at y=709 hit the tool palette (y 703 to 749), and the check read as an input fault. Frame the item clear of the palette first.
- **A check agent must stop its own apps before it reports** (2026-11-02). Apps started as background shells outlived a finished agent and kept running. Name this in the brief, by exact PID.
- **Name the exact drive command in a check brief** (2026-11-06). A Haiku check agent read `drive.mjs` and reported that it had no menu command, so Settings was out of reach. It has one (`menu <id>`). Give the command, the menu id and `SPACE_FOLDER` in the brief.
- **Work on main, not in a worktree** (founder, 2026-11-07). Worktree
  builds made every merge back wait until other sessions committed their
  open files in main. Edit main, `git add` only your own paths, and never
  stash or restore another session's edits. Check a change in a scratch dev
  instance: `npx electron-vite dev -- --user-data-dir=<scratch>` (the flag
  goes after `--`; `ELECTRON_CLI_ARGS` does not work), its own
  `SPACE_REMOTE_DEBUG` and MCP port, a scratch `HOME` and folder, and
  `SPACE_NO_FOCUS=1`. Start electron-vite directly: `npm run dev` rebuilds
  the relay that the founder's running app uses. A first launch without the
  flag in the right place used the founder's own settings folder.
- **A push of main carries other sessions' commits** (2026-11-06). List
  `git log origin/main..HEAD` and name the other sessions' commits to the
  founder before a push; push only what the founder approved.
- **A CSS custom property leaks into nested parts** (2026-11-07). A
  dropdown list inside the Settings pane took the pane's
  `--scroll-pad-end` (28 px), so its rows had an empty strip on the right.
  A per-part property is registered as not inherited (`@property … inherits:
  false`) or set on the part itself.
- **The Codex review agent returns before Codex ends** (2026-11-06). `codex:codex-rescue` starts the Codex run in the background and hands back at once. Its stdout goes to a file in the session's `tasks/` folder; wait for that file (a background `until grep` loop), then read the findings.

### On Linux (decision D6, checked 2026-11-02 on Manjaro, GNOME on Wayland, AMD GPU)

- **`ELECTRON_RUN_AS_NODE=1` in an agent's shell.** T3 Code sets it for the shells of its agents. Then `./node_modules/.bin/electron .` runs as Node and stops with "bad option: --user-data-dir". Put `env -u ELECTRON_RUN_AS_NODE` first. electron-vite (`npm run dev`, `npm start`), the lab and the relay shim remove it themselves.
- **A covered Wayland window gets no display frames.** GNOME sends a covered window no frame callbacks, so `requestAnimationFrame` stops once it draws (measured 0 per 2 s), and the dev-hook switches cannot change that. Scene events run on a timer since B62, but a recording (`play.mjs`) still gets no frames. So the lab, the bench and the perf run start their instances under XWayland (`--ozone-platform=x11`, `displaySwitches()` in `scripts/lab/common.mjs`); `LS_NATIVE_WAYLAND=1` keeps native Wayland for a run that tests Wayland itself. A hand launch is native Wayland: keep its window on top, or add the switch. Under XWayland a covered window that draws still gets only about one frame per second (2026-11-03: `sphere.js` recorded 31 frames over 31.8 s while covered, 2728 on top), so a lab video of a covered window is choppy; scenes still end on time. For smooth videos keep the lab window uncovered. A headless compositor (Xvfb, weston) would remove this; none is installed.
- **CDP keys do not reach the menu.** `drive.mjs key Control+n` does not run the New Board menu item; a real key press does. Check a menu shortcut with computer use or through the menu.
- **Click a menu item without the desktop** (2026-11-03): start Electron with `--inspect=<port>` and run `Menu.getApplicationMenu()` … `.click()` through the main process's `Runtime.evaluate` with `includeCommandLineAPI: true`. Real key presses (`ydotool`) go to whatever window has focus, the founder's too: use them only when the founder agrees.
- **Interface Size changes the pixel ratio** (B63). At 120% on a 1x screen `devicePixelRatio` is 1.2. CDP mouse coordinates and `drive.mjs` stay in CSS pixels. Agent screenshots (the snapshot window, zoom 100%) do not change; a `drive.mjs screenshot` of the window does. A real mouse wheel cannot be checked from here: CDP wheel events carry the deltas you give them. A check instance gets Automatic (120%) here; set `interfaceSize` in its scratch `state.json` for another size.
- **Computer use on Linux** is `mcp__computer-use-linux__*` (start with `get_app_state`; check `focused_window` before each key). The accessibility tree of the Electron window shows only its frame, so target the app's parts by window coordinates. Background `app_*` tools are macOS only.
- **Scratch root.** The lab, the bench and the perf run use `/tmp/claude-<uid>` (macOS: `/private/tmp/claude-501`, as before); `LS_SCRATCH_ROOT` sets another root.
- **Codex warns about a `CODEX_HOME` under `/tmp`:** "Refusing to create helper binaries under temporary dir". The run goes on, and scene files were still written. Pass `--codex-home` outside `/tmp` when a run measures how Codex writes files.
- **Perf on Linux** reads CPU from `/proc` and GPU load from the AMD `gpu_busy_percent` of the app's card. It has no footprint, no `sample` stacks and no window share (`seen`); those values are empty.
- **The stage's out-of-memory end** comes as "crashed" with exit code 133 on Linux (5 on macOS). Both mean V8's heap-limit trap.
- **Two harmless Chromium lines** at start: "Server does not support parametric color descriptions" (Wayland) and "Invalid mime.cache file" (the system's MIME cache).

## Ports and paths used so far

- `47821`: the founder's app (MCP). Checks used 47822–47999 and debug ports
  9341–9599.
- Scratch work lives in the session scratchpad, never in the founder's
  learning folder (`~/Projects/learning/learning-space`).
- The plugin repo is a sibling checkout: `../learning-space-plugins`.
  `apps/desktop/scripts/build-mcpb.mjs` copies its `.mcpb` when it is present.

## Package a macOS release

The full build and publishing checklist is in [`release-guide.md`](release-guide.md).

On a Mac with the Developer ID Application identity and the
`learning-space-notary` keychain profile, run `cd apps/desktop && npm run dist:mac`.
It builds a universal Apple Silicon and Intel DMG in `apps/desktop/release/` with
stable analytics, signs and notarizes the app and the DMG, staples the DMG,
and checks Gatekeeper. It stops when credentials or a check fail. To build
one architecture instead, pass `-- --arm64` or `-- --x64`. Set
`APPLE_KEYCHAIN_PROFILE` only to use a different notarytool profile.

This creates local artifacts only: it does not publish a release or configure
updates. Check the new name, bundle ID and icon before the first public build,
then install the DMG and plugin on a clean Mac. Back up the Developer ID
identity as an encrypted `.p12`; keep its password separate. To restore it on
another Mac, import it into Keychain Access and create a notarytool profile.
The certificate expires on 2027-12-07.
