@AGENTS.md

# Claude Code specifics

## How we work (from 2026-10-23)

- **Build step by step.** Each step must run in the real app before the next step starts.
- **No tests.** See the hard rule in `AGENTS.md`. Verify end to end, not with test files. Checks also write no check-script files (founder, 2026-10-29): use the app's own MCP tools and `space/scripts/drive.mjs`.
- **Implementation goes to Opus subagents:** `model: "opus"`, `effort: "medium"`, `subagent_type: "general-purpose"`. Run one or two at a time, never two on the same files. The main session plans, writes the brief, reviews the diff, and checks the result.
- **Reading, search, research and click-through checks go to Haiku subagents** (`model: "haiku"`; `Explore` for read-only work).
- **Subagents use Haiku as much as possible.** Implementation subagents start their own Haiku subagents for reading, search, research and checks, and keep only the judgment and the code. Say so in every implementation brief.
- **The main session never runs hands-on checks** (computer use, browser click-throughs, screenshot loops). A Haiku subagent does them. If its check fails because it cannot act, fix the cause or tell the user. Never take the check over in the main session.
- **Driving the Learning Space app from subagents:** prefer `space/scripts/drive.mjs` (launch with `SPACE_REMOTE_DEBUG=<port>`; see `space/README.md` → "Dev automation"). It draws pen strokes, presses keys and takes screenshots while the window stays in the background. Background computer use cannot drag on a window that is not in front.
- **Check in dev mode too.** The founder runs `npm run dev` (React StrictMode, Fast Refresh). A built-app check once missed a dev-only bug. Run at least one check of every change against the dev renderer (`electron-vite dev` with the same env vars), not only `electron .` on `out/`.
- **Computer use from subagents (fallback):** use the background `app_*` tools (`app_screenshot`, `app_click`, `app_drag`, `app_key`, `app_menu`). The dev app's bundle id is `com.github.Electron`. Background keys cannot send ⌘-shortcuts: use `app_menu` for those. If a key has no effect, `app_click` a neutral spot (the top bar) to give the window focus, then retry. The tools are allow-listed in `.claude/settings.local.json`; without that, auto mode blocks them in subagents and the result reads "user interrupt".

- **UI work:** read `docs/learning-space/design-system.md` first; mock up with the inline widget tool and get approval before an implementation brief; give the implementer the mockup's exact values; compare the build's screenshot with the mockup.
- **Implementation briefs for `space/`** name: the files, the rules above, the design system (for UI), own ports / `--user-data-dir` / scratch folders, "stop only exact PIDs", and the acceptance checks. `docs/learning-space/working-guide.md` has the check recipes.
- **End of a working session:** run the `session-wrap-up` skill (`.claude/skills/session-wrap-up/SKILL.md`) to update the docs and remove stale lines.

- Drive the iOS Simulator only with `mcp__Claude_Code_iOS_Simulator__control`. Never computer-use (it leaves a screen-recording indicator on the user's screen) — say so explicitly in any subagent brief that touches the simulator.
- For the paused web client, use the built-in browser (`mcp__Claude_Browser__*`) against `scripts/web-dev.py`.
- For the paused clients, the Paper MCP server is the design source; if it fails to connect, tell the user rather than editing `design/` by hand. Paper's agent interface (for reference when designing Learning Space tools) is captured in `docs/learning-space/reference/paper/` (local only).
- Several Claude sessions can share this Mac. Before starting an `xcodebuild`, check `pgrep -f "Developer/usr/bin/xcodebuild"` and never kill someone else's build.
