@AGENTS.md

# Claude Code specifics

## How we work (from 2026-10-23)

- **Build step by step.** Each step must run in the real app before the next step starts.
- **Short steps, minimum checks** (founder, 2026-10-31). Keep a build step to about 10 minutes. Run only the checks that can fail in that step, on 3 to 6 scenes. Run the full scene set and one outside review once, at the end of the work.
- **No tests.** See the hard rule in `AGENTS.md`. Verify end to end, not with test files. Checks also write no check-script files (founder, 2026-10-29): use the app's own MCP tools and `space/scripts/drive.mjs`.
- **Implementation goes to Opus subagents:** `model: "opus"`, `effort: "medium"`, `subagent_type: "general-purpose"`. Run one or two at a time, never two on the same files. The main session plans, writes the brief, reviews the diff, and checks the result.
- **Reading, search, research and click-through checks go to Haiku subagents** (`model: "haiku"`; `Explore` for read-only work).
- **Subagents use Haiku as much as possible.** Implementation subagents start their own Haiku subagents for reading, search, research and checks, and keep only the judgment and the code. Say so in every implementation brief.
- **The main session never runs hands-on checks** (computer use, browser click-throughs, screenshot loops). A Haiku subagent does them. If its check fails because it cannot act, fix the cause or tell the user. Never take the check over in the main session.
- **Driving the Askaboard app from subagents:** prefer `space/scripts/drive.mjs` (launch with `SPACE_REMOTE_DEBUG=<port>`; see `space/README.md` → "Dev automation"). It draws pen strokes, presses keys and takes screenshots while the window stays in the background. Background computer use cannot drag on a window that is not in front.
- **Check in dev mode too.** The founder runs `npm run dev` (React StrictMode, Fast Refresh). A built-app check once missed a dev-only bug. Run at least one check of every change against the dev renderer (`electron-vite dev` with the same env vars), not only `electron .` on `out/`.
- **Computer use from subagents (fallback):** use the background `app_*` tools (`app_screenshot`, `app_click`, `app_drag`, `app_key`, `app_menu`). The dev app's bundle id is `com.github.Electron`. Background keys cannot send ⌘-shortcuts: use `app_menu` for those. If a key has no effect, `app_click` a neutral spot (the top bar) to give the window focus, then retry. The tools are allow-listed in `.claude/settings.local.json`; without that, auto mode blocks them in subagents and the result reads "user interrupt". These `app_*` tools are macOS only. On Linux, use `mcp__computer-use-linux__*` (`get_app_state` first; `focused_window` before each key) and target the Electron window's parts by window coordinates (its accessibility tree shows only the frame); see `docs/learning-space/working-guide.md`, "On Linux".

- **UI work:** read `docs/learning-space/design-system.md` first; mock up with the inline widget tool and get approval before an implementation brief; give the implementer the mockup's exact values; compare the build's screenshot with the mockup.
- **Implementation briefs for `space/`** name: the files, the rules above, the design system (for UI), own ports / scratch `HOME` / `--user-data-dir` / scratch folders, a build in a scratch copy while the founder's app runs, "stop only exact PIDs", and the acceptance checks. `docs/learning-space/working-guide.md` has the check recipes.
- **End of a working session:** run the `session-wrap-up` skill (`.claude/skills/session-wrap-up/SKILL.md`) to update the docs and remove stale lines.

- For the paused web client, use the built-in browser (`mcp__Claude_Browser__*`) against `scripts/web-dev.py`.
- For the paused clients, the Paper MCP server is the design source; if it fails to connect, tell the user rather than editing `design/` by hand. Paper's agent interface (for reference when designing Askaboard tools) is captured in `docs/learning-space/reference/paper/` (local only).
