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
  before pushing otherwise. The `learning-space` branch and the public
  `learning-space-plugins` repo are pushed.

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
5. **Commit per step** with a clear message; push when the founder asks.
6. Resume the same implementer with `SendMessage` for follow-ups on its own
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
| Keep the founder's focus | After launching, `osascript -e 'tell application "Claude" to activate'`. |

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

## Ports and paths used so far

- `47821`: the founder's app (MCP). Checks used 47822–47999 and debug ports
  9341–9599.
- Scratch work lives in the session scratchpad, never in the founder's
  learning folder (`~/Projects/learning/learning-space`).
- The plugin repo is a sibling checkout: `../learning-space-plugins`.
  `space/scripts/build-mcpb.mjs` copies its `.mcpb` when it is present.
