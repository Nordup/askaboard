@AGENTS.md

# Claude Code specifics

## How we work (from 2026-10-23)

- **Build step by step.** Each step must run in the real app before the next step starts.
- **No tests.** See the hard rule in `AGENTS.md`. Verify end to end, not with test files.
- **Implementation goes to Opus subagents:** `model: "opus"`, `effort: "medium"`, `subagent_type: "general-purpose"`. Run one or two at a time, never two on the same files. The main session plans, writes the brief, reviews the diff, and checks the result.
- **Reading, search, research and click-through checks go to Haiku subagents** (`model: "haiku"`; `Explore` for read-only work).
- **Subagents may start their own Haiku subagents** for bulk reading or search. Say so in every implementation brief.

- Drive the iOS Simulator only with `mcp__Claude_Code_iOS_Simulator__control`. Never computer-use (it leaves a screen-recording indicator on the user's screen) — say so explicitly in any subagent brief that touches the simulator.
- For the web client, use the built-in browser (`mcp__Claude_Browser__*`) against `scripts/web-dev.py`.
- The Paper MCP server is the design source; if it fails to connect, tell the user rather than editing `design/` by hand.
- Several Claude sessions can share this Mac. Before starting an `xcodebuild`, check `pgrep -f "Developer/usr/bin/xcodebuild"` and never kill someone else's build.
