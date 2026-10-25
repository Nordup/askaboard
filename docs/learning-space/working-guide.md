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
| Own app instance | Start the Electron binary directly: `SPACE_FOLDER=<scratch folder> SPACE_MCP_PORT=<47822…> SPACE_REMOTE_DEBUG=<93xx> ./node_modules/.bin/electron --user-data-dir=<scratch> .` (from `space/`). The founder's app uses port 47821. |
| Dev-mode check | Run `electron-vite dev` with the same env vars. React StrictMode only exists there. |
| Drive input | `node scripts/drive.mjs --port <debug port> …` draws pen strokes with pressure, presses keys, clicks, drags, wheels, takes screenshots, prints state. Works while the window is behind other windows. |
| A real agent client | `claude -p "<prompt>" --model haiku --mcp-config <json> --strict-mcp-config --allowedTools "mcp__learning-space__*"`. Put the prompt **before** `--allowedTools` (the flag swallows following words). |
| A multi-turn session | First run `claude -p …`, then `claude -p --continue …` from the same folder. Separate `-p` runs are separate conversations. |
| A learning folder | Run `claude` from inside the folder so `AGENTS.md` loads. It loads into context, so it never shows up as a file read in a tool trace. |
| CLI installs (plugins, `mcp add`) | Redirect `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to scratch folders. Compare hashes of the founder's real configs before and after. |
| The relay | Set `HOME` to a scratch folder for the app and pass `LEARNING_SPACE_PORT` in the client's MCP config env. |
| Cleanup | Record the PIDs you start and stop only those. Never `pkill -f` a pattern: it once killed another check's instance. |
| Measure agent behaviour | `node scripts/bench/run.mjs --scenarios S1,S2,S3,S4 --model opus --out <dir>` (after `npm run build`; ports 47870/9470; `--dev` for the dev renderer). One trace: `node scripts/trace-report.mjs <file or folder>`. |
| Measure perception | `node scripts/bench/run.mjs --scenarios P1,P2,P3 --model opus --out <dir>`: a busy board, a prior look, then new learner work and a new connection (about 5 minutes per run). |
| Board news hook in the bench | On by default: the agent gets the plugins' `UserPromptSubmit` hook against the run's own app (Claude: `--settings`; Codex: `-c hooks.UserPromptSubmit=…` with `--dangerously-bypass-hook-trust`). `--no-news-hook` measures without it. `metrics.json` → `news_in_prompt` (Codex) holds the line that reached the prompt. Board news is delivered once per agent app and board: after the hook sent it, the tool results of that turn do not repeat it. |
| Read a real session of the founder | Learning Space trace: `~/.learning-space/traces/<date>/` (`node scripts/trace-report.mjs <file>`). ChatGPT voice sessions run as Codex threads: `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`, names in `~/.codex/session_index.jsonl`; voice requests arrive as `<realtime_delegation>` user messages. The files hold base64 images: parse line by line, never print them. Read only. |
| Keep the founder's focus | After launching, `osascript -e 'tell application "Claude" to activate'`. |

## Choosing lab tests (live drawing)

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
| Charts and data | `stddev` |

Use `--brief-only` to measure what a real session sees (the brief through
`AGENTS.md`, no council purpose text); without it the prompt starts with
`council/purpose.md`, which says the purpose out loud. Compare with the
earlier runs of the same task in `live-drawing-log.md`.

## Pitfalls we hit

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
- **Codex in the bench** needs the Learning Space tools approved (`default_tools_approval_mode = "approve"`), because a read-only sandbox with `approval_policy = "never"` blocks writes before they reach the app. The founder's full-access sandbox does not have this problem.
- **Codex ignores plugin hooks until the user trusts them** (`/hooks`). The bench passes `--dangerously-bypass-hook-trust` for its scratch home only.
- **Review before push:** the founder reviews each fix (the problem, the measurement, the change, the result) before its commits are pushed.

## Ports and paths used so far

- `47821`: the founder's app (MCP). Checks used 47822–47999 and debug ports
  9341–9599.
- Scratch work lives in the session scratchpad, never in the founder's
  learning folder (`~/Projects/learning/learning-space`).
- The plugin repo is a sibling checkout: `../learning-space-plugins`.
  `space/scripts/build-mcpb.mjs` copies its `.mcpb` when it is present.
