@AGENTS.md

# Claude Code specifics

- Drive the iOS Simulator only with `mcp__Claude_Code_iOS_Simulator__control`. Never computer-use (it leaves a screen-recording indicator on the user's screen) — say so explicitly in any subagent brief that touches the simulator.
- For the web client, use the built-in browser (`mcp__Claude_Browser__*`) against `scripts/web-dev.py`.
- The Paper MCP server is the design source; if it fails to connect, tell the user rather than editing `design/` by hand.
- Several Claude sessions can share this Mac. Before starting an `xcodebuild`, check `pgrep -f "Developer/usr/bin/xcodebuild"` and never kill someone else's build.
