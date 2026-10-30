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
| Dev-mode check | Run `electron-vite dev` with the same env vars. React StrictMode only exists there. |
| Drive input | `node scripts/drive.mjs --port <debug port> …` draws pen strokes with pressure, presses keys, clicks, drags, wheels, takes screenshots, prints state. Works while the window is behind other windows. |
| A real agent client | `claude -p "<prompt>" --model haiku --mcp-config <json> --strict-mcp-config --allowedTools "mcp__learning-space__*"`. Put the prompt **before** `--allowedTools` (the flag swallows following words). |
| A multi-turn session | First run `claude -p …`, then `claude -p --continue …` from the same folder. Separate `-p` runs are separate conversations. |
| A learning folder | Run `claude` from inside the folder so `AGENTS.md` loads. It loads into context, so it never shows up as a file read in a tool trace. |
| CLI installs (plugins, `mcp add`) | Redirect `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to scratch folders. Compare hashes of the founder's real configs before and after. |
| The relay | Set `HOME` to a scratch folder for the app and pass `LEARNING_SPACE_PORT` in the client's MCP config env. |
| Cleanup | Record the PIDs you start and stop only those. Never `pkill -f` a pattern: it once killed another check's instance. |
| Measure agent behaviour | `node scripts/bench/run.mjs --scenarios S1,S2,S3,S4 --model opus --out <dir>` (after `npm run build`; ports 47870/9470; `--dev` for the dev renderer). One trace: `node scripts/trace-report.mjs <file or folder>`. The set-up writes with scenes (one scene per seeded item, shown at once); check a set-up change without an agent by importing `scripts/bench/busy.mjs` and `scenarios.mjs` (never `run.mjs`) and seeding a lab app. |
| Measure one change (perf) | `node scripts/perf/run.mjs --client claude --model haiku --effort high --task orbit --label <state>` (fresh app on 47880/9480; `--video` for the first visible change), `node scripts/perf/replay.mjs --from <run folder>` (no model; 47881/9481), `node scripts/perf/report.mjs --baseline <state>`. Behaviour changes: opus / gpt-6.1-sol at effort medium; behind-the-scenes changes: replay, or haiku / gpt-6-luna at effort high. See `scripts/perf/README.md`. |
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
| Program items, 3D, interaction | `em-wave` (and `heart`) |
| The brief or other agent text | `seasons` and `fusion`, with `--brief-only` |
| Reading the learner's work | `fusion` |
| Pages, frames, images, HTML in scenes | `fractions`, `rome` |
| Style, painting, colour | `sunset` |
| Charts and data; the habit of titles, labels and formulas | `stddev` |

Use `--brief-only` to measure what a real session sees (the brief through
`AGENTS.md`, no council purpose text); without it the prompt starts with
`council/purpose.md`, which says the purpose out loud. Compare with the
earlier runs of the same task in `live-drawing-log.md`.

Use `--no-code` (also on `lab.mjs start`) to measure a run without code
items: the app starts with `LS_LAB_NO_CODE=1`, scenes have no `shader()`,
`canvas()` or `program()`, and the brief, the guide and the tool
descriptions leave out the spans marked `<!-- code-items -->` /
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
  `say()` without `await` lets the next line start at once. A check scene
  with these mistakes put three steps at time 0, and the check meant nothing.
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

## Ports and paths used so far

- `47821`: the founder's app (MCP). Checks used 47822–47999 and debug ports
  9341–9599.
- Scratch work lives in the session scratchpad, never in the founder's
  learning folder (`~/Projects/learning/learning-space`).
- The plugin repo is a sibling checkout: `../learning-space-plugins`.
  `space/scripts/build-mcpb.mjs` copies its `.mcpb` when it is present.
