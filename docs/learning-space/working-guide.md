# Learning Space — how to work on it

Practical knowledge for agents that build and check Learning Space. The
binding rules are in [`../../AGENTS.md`](../../AGENTS.md) and
[`../../CLAUDE.md`](../../CLAUDE.md); this file explains how to follow them
and what went wrong before.

## The founder

- Speaks to agents by voice; messages come through speech-to-text. Read
  intent, not spelling: "iPod" means iPad, "codecs" means Codex, "Cloud" or
  "Clod" means Claude, "paper desktop" means the Paper design app.
- Wants to stay in control of product decisions. Research the options, explain
  them with concrete learning examples, recommend one, and let the founder
  choose. Ask with buttons, not long prose.
- Design taste: dark, calm, compact, IDE-like (Codex, Claude Desktop, Paper).
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
- Agent text changes start as a draft in `docs/learning-space/drafts/`, sent
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

## The workflow that worked

1. **Plan the step** with the founder; record decisions in
   [`decisions.md`](decisions.md) and status in [`plan.md`](plan.md).
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
   after (see [`baseline.md`](baseline.md)), and let the founder try a real
   session.
6. **Commit per step** with a clear message; push when the founder asks.
7. Resume the same implementer with `SendMessage` for follow-ups on its own
   code; start a fresh agent when its context has grown very large.

## Checking the app without touching the founder's setup

| Need | How |
| --- | --- |
| Own app instance | Start the Electron binary directly: `HOME=<scratch home> SPACE_FOLDER=<scratch folder> SPACE_MCP_PORT=<47822…> SPACE_REMOTE_DEBUG=<93xx> ./node_modules/.bin/electron --user-data-dir=<scratch> .` (from `space/`). The founder's app uses port 47821. Without a scratch `HOME`, the instance writes its port into the founder's `~/.learning-space/relay.json` (and `tools.json`, `bin/`), and the founder's agents then connect to it (happened twice on 2026-10-29). |
| Dev-mode check | Run `electron-vite dev` with the same env vars and a `--user-data-dir` too. React StrictMode only exists there. On macOS a scratch `HOME` does not move Electron's user data: without `--user-data-dir` the run writes into the founder's `~/Library/Application Support/Learning Space/state.json` (happened 2026-11-03). |
| Drive input | `node scripts/drive.mjs --port <debug port> …` draws pen strokes with pressure, presses keys, clicks, drags, wheels, takes screenshots, prints state. Works while the window is behind other windows. |
| A real agent client | `claude -p "<prompt>" --model haiku --mcp-config <json> --strict-mcp-config --allowedTools "mcp__learning-space__*"`. Put the prompt **before** `--allowedTools` (the flag swallows following words). |
| A multi-turn session | First run `claude -p …`, then `claude -p --continue …` from the same folder. Separate `-p` runs are separate conversations. |
| A learning folder | Run `claude` from inside the folder so `AGENTS.md` loads. It loads into context, so it never shows up as a file read in a tool trace. |
| CLI installs (plugins, `mcp add`) | Redirect `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to scratch folders. Compare hashes of the founder's real configs before and after. |
| The relay | Set `HOME` to a scratch folder for the app and pass `LEARNING_SPACE_PORT` in the client's MCP config env. |
| Cleanup | Record the PIDs you start and stop only those. Never `pkill -f` a pattern: it once killed another check's instance. |
| Measure agent behaviour | `node scripts/bench/run.mjs --scenarios S1,S2,S3,S4 --model opus --out <dir>` (after `npm run build`; ports 47870/9470; `--dev` for the dev renderer). One trace: `node scripts/trace-report.mjs <file or folder>`. The set-up writes with scenes (one scene per seeded item, shown at once); check a set-up change without an agent by importing `scripts/bench/busy.mjs` and `scenarios.mjs` (never `run.mjs`) and seeding a lab app. |
| Measure one change (perf) | `node scripts/perf/run.mjs --client claude --model haiku --effort high --task orbit --label <state>` (fresh app on 47880/9480; `--video` for the first visible change), `node scripts/perf/replay.mjs --from <run folder>` (no model; 47881/9481), `node scripts/perf/report.mjs --baseline <state>`. Behaviour changes: opus / gpt-6.1-sol at effort medium; behind-the-scenes changes: replay, or haiku / gpt-6-luna at effort high. See `scripts/perf/README.md`. |
| Measure rendering | `node scripts/perf/render.mjs --scenes toon,many --label <state>` (after `npm run build`; ports 47882/9482; `--dev` for the dev renderer, `--tune '<json>'` for one switch). The window opens at its normal place with no focus, so the founder keeps the keyboard and can bring it forward. Run it in the standard condition (P20), and do not ask for a quiet machine. See `scripts/perf/README.md`. |
| Compare two builds of rendering | Measure both on the same day, in turns (old, new, new, old). A history line of an earlier day is not fair: on 2026-11-01 the same code gave 10 to 15 percent less after the machine load changed. For the old build: `git worktree add --detach <scratch>/old <commit>`, link `space/node_modules`, `npm run build` there, and `git worktree remove --force` after it. Read `--capped` for what a person sees. Uncapped `fps` counts page frames, so it can fall when the app does less: the board pan gave 92 fps against 115 with a quarter of the CPU. For a board change, read renderer CPU, paint time, GPU util and the worst frame. |
| A real plugin (Codex) | The lab connects from config, so it misses plugin bugs (I30). Copy `../learning-space-plugins` without `.git` to a scratch folder and set the lab port in `plugins/learning-space/mcp*.json`. In a scratch `CODEX_HOME` add `[marketplaces.learning-space]` with `source_type = "local"` and that folder, and `[plugins."learning-space@learning-space"]` with `enabled = true`, then run `codex plugin add learning-space@learning-space`. Put a `codex` wrapper first on `PATH`: it swaps the `[mcp_servers.learning-space]` block that `council.mjs` writes for those lines and runs `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true`. Run `council.mjs --codex-home <home>`. The rollout in `<home>/sessions/` shows what the model received. Keep the scratch files out of the repo. |
| Measure perception | `node scripts/bench/run.mjs --scenarios P1,P2,P3 --model opus --out <dir>`: a busy board, a prior look, then new learner work and a new connection (about 5 minutes per run). |
| Board news hook in the bench | On by default: the agent gets the plugins' `UserPromptSubmit` hook against the run's own app (Claude: `--settings`; Codex: `-c hooks.UserPromptSubmit=…` with `--dangerously-bypass-hook-trust`). `--no-news-hook` measures without it. `metrics.json` → `news_in_prompt` (Codex) holds the line that reached the prompt. Board news is delivered once per agent app and board: after the hook sent it, the tool results of that turn do not repeat it. |
| Read a real session of the founder | Learning Space trace: `~/.learning-space/traces/<date>/` (`node scripts/trace-report.mjs <file>`). ChatGPT voice sessions run as Codex threads: `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`, names in `~/.codex/session_index.jsonl`; voice requests arrive as `<realtime_delegation>` user messages. The files hold base64 images: parse line by line, never print them. Read only. |
| Keep the founder's focus | After launching, `osascript -e 'tell application "Claude" to activate'`. |

## Choosing lab tests (live drawing)

Lab and perf runs give agents what the real apps give them (decision W10):
Claude with every tool and `--permission-mode bypassPermissions`, Codex with
`danger-full-access` and the network, web on unless `--no-web`. Each perf run
writes `timeline.md` (where the time goes) and keeps the agent's transcript.
Videos stay out of git (`*.mp4` and similar are ignored). So do images:
`.gitignore` ignores every image outside the asset folders. Save check
screenshots anywhere (for example a draft's folder); they stay local.


The council tasks are in `space/scripts/lab/council/tasks.json`; each has a
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
earlier runs of the same task in `live-drawing-log.md`.

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
- **One instance overwrites `~/.learning-space/relay.json`.** A dev instance
  started with the real `HOME` points the relay at itself.
- **Hand-made MCP entries plus the plugin** double every tool. The Connect
  popover detects and fixes this.
- **Codex `config.toml` model setting** (`gpt-6-luna`) was rejected by the
  founder's account during one check; that is the founder's config, not ours.

- **Never `import` or `node -e` the bench runner** (`scripts/bench/run.mjs`): importing it runs `main()` and starts a real Claude bench (it happened once and used the founder's limits).
- **A test app instance must get a scratch `HOME`.** One launch without it overwrote the founder's `~/.learning-space/relay.json` (port), `tools.json` and the relay command; the founder's app rewrites them on its next start.
- **Codex in the lab, perf and bench runs** needs the Learning Space tools approved (`default_tools_approval_mode = "approve"`): with `approval_policy = "never"`, Codex declines MCP write tools that are not approved. All three use the shared `prepareCodexHome` in `scripts/lab/common.mjs`.
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
  `--user-data-dir`. Tested on the founder's Mac on 2026-10-31.

- **A check launch needs a scratch `HOME` and its own `--user-data-dir`.** Every launch rewrites `~/.learning-space/relay.json`, `tools.json` and the shim. Without a scratch `HOME`, the founder's agents point at the test app. Electron ignores `HOME` for its settings on macOS: without `--user-data-dir`, a test folder lands in the founder's `state.json` (both happened on 2026-11-02). `npx electron . --user-data-dir=…` takes the switch; `electron-vite dev` needs it passed through. Copy only the key line to the scratch `.learning-space/.env`.
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

## Ports and paths used so far

- `47821`: the founder's app (MCP). Checks used 47822–47999 and debug ports
  9341–9599.
- Scratch work lives in the session scratchpad, never in the founder's
  learning folder (`~/Projects/learning/learning-space`).
- The plugin repo is a sibling checkout: `../learning-space-plugins`.
  `space/scripts/build-mcpb.mjs` copies its `.mcpb` when it is present.
