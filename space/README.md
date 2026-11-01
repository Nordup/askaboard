# Learning Space

Learning Space is a desktop app (Electron) for macOS. It gives the learner a
shared canvas and a local learning folder. The app has no AI inside: external
agents (Claude Code, Codex, Claude Desktop) connect to it over MCP and work on
the board with the learner.

**Status (2026-10-31):** the main product of this repository (since 2026-10-24). Scenes stream to the board (`docs/learning-space/streaming-scenes-plan.md`), the voice explainer is parked (I28), and an unknown scene option is an error (B24). Steps 0–5, fix 1, board news (decision I4), `get_brief` and `get_guide` (decision T11), live drawing stages 1–4 (scenes as the one way to write, the script panel), brief v18 and the agent texts in Anthropic's style (decisions I18–I22) are done. The scene tools are `write_scene`, `preview_scene` and `play_scene` (T16), with the old approved wording (I25). The board reads give summaries first (T20), and the board tools are `list_boards`, `open_board` and `move_board` (T21). Every tool refuses unknown parameters. Scenes can be files in `boards/scenes/` with imports (B16 step 1); each board keeps a scene record, so agents read items by scene and step after a restart (B16 step 2). After a restart the stage is rebuilt from that record, so earlier scenes can be replayed, previewed and replaced, and a new scene finds their objects (B16 step 3). A scene input works, draws nothing, or is an error; results carry no warnings (B18). `play_scene` does not wait (T23). Open work: [`work-map.md`](../docs/learning-space/work-map.md).

- [`../docs/learning-space/README.md`](../docs/learning-space/README.md): start here.
- [`architecture.md`](../docs/learning-space/architecture.md): processes, data flow and where the code lives.
- [`design-system.md`](../docs/learning-space/design-system.md): UI tokens and rules.
- [`working-guide.md`](../docs/learning-space/working-guide.md): how to build and check the app.

## Run

```sh
cd space
npm install      # postinstall downloads the Electron binary
npm run dev      # build the relay, then start the dev app window
npm run build    # type-check, bundle to out/, build the relay
npm start        # run the built app from out/
```

Do not run test suites. Check a change with `npm run build`. The rules are in
[`../AGENTS.md`](../AGENTS.md).

## What the app does today

- **Learning folder and boards.** Open a folder. Any `*.board.json` file in it
  is a board. New boards go to `boards/`. The app autosaves and reloads a
  board when another program changes it on disk.
- **Ink with pressure.** Pen, highlighter, stroke eraser, lasso select,
  undo and redo, pan and zoom.
- **Editable document.** A board holds ink, frames, text with math, SVG and
  images. The learner can select, move and edit all of them.
- **Agents see and edit the board over MCP.** Every agent write is one undo
  step for the learner.
- **Ink groups and placement.** The app clusters learner ink into groups
  (`g1`, `g2`, …). Agents place material beside the learner's work, not over it.
- **Folder setup and an editable folder guide.** The sidebar offers to set up
  a folder for learning. A folder can add a topic to the board reference that
  `get_guide` returns, or replace the reference, in `.learning-space/guide.md`.
- **Connect popover and plugin.** The agent pill in the top bar installs the
  plugin for each agent.
- **Live scenes.** An agent writes a JavaScript program (`write_scene`) that
  draws ink, handwriting, shapes, typeset text and worlds and says how
  they unfold in time; the board plays it, and the result stays as ordinary
  items. Programs on a board share one sandbox (the stage), queue back to
  back, can pause at steps, and pause when the learner starts drawing. A
  scene's text lines (`say`) appear at a reading pace in a floating reading
  panel for one scene (the previous line, the current line, a step bar); it
  fades after the scene and hides into the scene pill in the top bar, which
  lists the board's scenes and shows the scene and step of a selected item. The app does not
  speak.
- **Worlds.** A scene can place a world on the board: plain three.js with no
  frame, and any library from the internet. A world keeps running, follows the
  scene's clock and values, links to labels and arrows, and writes its own
  interaction. It runs in a sandboxed origin.

## Connect agents

The agent pill in the top bar opens a popover with two views:

1. **Agents.** One row per agent that is installed or that connected. A green
   dot shows an agent that was active in the last 90 s.
2. **Connect an agent.** Rows for Claude Code, Claude Desktop, and ChatGPT and
   Codex. Each row has an **Install** button. **Manual setup and other agents**
   opens the plugin repo.

The plugin is in [`github.com/Nordup/learning-space-plugins`](https://github.com/Nordup/learning-space-plugins)
(marketplace `learning-space`, plugin `learning-space`). The README there has
the manual steps for each agent.

- **Relay command (stdio):** `~/.learning-space/bin/learning-space mcp`. The app
  writes this command on every launch. The relay lists the tools also when the
  app is closed.
- **Claude Desktop extension:** `resources/learning-space.mcpb`. **Install**
  opens it in Claude Desktop. `npm run build:mcpb` copies the plugin repo's
  `.mcpb` when the sibling repo is present. Otherwise it builds a minimal one.

Use the plugin or a manual MCP entry, not both. With both, the agent sees
every tool twice. The popover shows this problem and offers **Fix**.

## MCP

- **Endpoint:** `http://127.0.0.1:47821/mcp` (Streamable HTTP), while the app is open.
- **Port:** `SPACE_MCP_PORT` changes it. The relay reads `LEARNING_SPACE_PORT`.
- **Agent text:** `resources/brief.md` (the brief: the managed block in a
  folder's `AGENTS.md`, and `get_brief` for agents without it),
  `resources/guide.md` (the board reference in topics, `get_guide`; decision
  T11), `resources/instructions.md` (server instructions) and the tool and
  parameter descriptions in `src/main/mcp.ts`. Before you change any of them, read
  [`writing-agent-text.md`](../docs/learning-space/writing-agent-text.md).

| Tool | Main parameters | What it does |
| --- | --- | --- |
| `list_items` | `part`, `query`, `depth` | The items on the open board, one line each, grouped by the learner's work, scenes and material, with a state header; a summary by area on a big board; `query` searches the text on the board |
| `get_item` | `id` (one or a list), `as` | Every stored detail of items or ink groups: info, html, svg, strokes, points or source |
| `get_screenshot` | `part`, `scale`, `max_size`, `labels`, `grid` | PNG of a part of the board: the view, the whole board, the selection, a region, items, a scene or an interval of changes |
| `get_changes` | `since`, `changes`, `detail` | What changed since the agent's last look, in sentences, with an interval handle; moves the last look |
| `list_boards` | `query`, `board` | The boards of the learning folder, or a search of their text (read-only) |
| `open_board` | `board`, `create` | Opens a board by path or unique name, or makes a new one |
| `move_board` | `path`, `to` | Renames a board, or moves it to the system Trash (`to: "trash"`) |
| `get_brief` | none | The brief, for agents without the folder's `AGENTS.md` |
| `get_guide` | `topic` | One topic of the board reference (scene, scene-files, scene-world, scene-interact, model, html, math, svg, images, tokens, placement, ink, view, and `folder` when the folder has `.learning-space/guide.md`); without a topic, all of it |
| `write_scene` | `name`, `code` or `file` | Runs a scene program (inline, or a file in `boards/scenes/`) and keeps the result as a draft by name; the learner sees nothing. Returns steps and items, or the program error with its line. |
| `preview_scene` | `name`, `at`, `part`, `version` | Read-only: one image of a draft or of a scene on the board, at chosen moments (end, a step, a time, a list, every step), framed on the scene, the view, a region or items. |
| `play_scene` | `action` (start, status, pause, resume, next, stop, clear_queue, cancel, replay, cut, reset), `name`, `when`, `from_step`, `after_step` | Starts a draft on the board (replacing a scene of the same name in place; returns at once) and controls playback and the stage. |

## Learning folder

A folder is set up for learning when `AGENTS.md` exists at its root. Setup
copies the templates in `resources/learning-folder/` and never overwrites a
file. Edit the templates to change what new folders get. The brief block in
`AGENTS.md` is the one exception: the app refreshes it when the folder opens,
unless the learner edited it.

## Dev automation

These environment variables work with `npm run dev`:

| Variable | Effect |
| --- | --- |
| `SPACE_FOLDER=/abs/dir` | Open this learning folder at launch. |
| `SPACE_OPEN=rel/path` | Show this file in the preview panel at launch. |
| `SPACE_CAPTURE=/abs/path.png` | Capture the window to a PNG after load. `SPACE_CAPTURE_QUIT=1` quits after it; `SPACE_CAPTURE_DELAY=ms` sets the wait (default 1000). |
| `SPACE_MCP_PORT=port` | Serve MCP on this port instead of 47821. |
| `SPACE_REMOTE_DEBUG=port` | Dev builds only: Chromium debug port for `scripts/drive.mjs`. |
| `SPACE_CONNECT_DRY_RUN=1` | **Install** for Claude Desktop logs the `.mcpb` path and does not open it. |
| `SPACE_TRACE_DIR=/abs/dir` | Write session traces here instead of `~/.learning-space/traces/`. |
| `SPACE_NO_FOCUS=1` | Show the window without activating the app: it never takes focus or switches the macOS desktop. The lab sets it. |

The live drawing lab (`scripts/lab/`, its own README) starts its own app instance, plays scene programs and records them (MP4 and filmstrip), sends beats, runs model councils, and builds a gallery at `space/.lab/index.html`.

To check the Connect buttons without your real agent config, set `HOME`,
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` to scratch folders.

`scripts/drive.mjs` drives a running dev app over the debug port. The input
reaches the window also when it is behind other windows. Do not use computer
use for input. It attaches to the board window by its URL
(`scripts/app-page.mjs`), never to the stage or snapshot page, and waits up
to 20 s for that window and its dev hook to load.

| Command | Effect |
| --- | --- |
| `draw <file.json \| -> [--tool pen\|highlighter\|eraser] [--no-pan]`, `draw --strokes '<json>'` | Draws strokes with pressure, in board coordinates. It pans the board first so that every point is on screen; `--no-pan` keeps the view. `--tool eraser` drags the eraser along the strokes |
| `key <combo>` | Sends a key, for example `Meta+z` |
| `click`, `dblclick`, `drag`, `wheel` | Mouse input at window CSS pixels |
| `type "<text>"` | Types into the focused field |
| `node-rect <id>` | A node's window rect, from the layout cache and the DOM |
| `element-rect <css selector>` | The window rects (and visibility, opacity) of the elements that match |
| `window-size <w> <h>` | Resizes the window |
| `screenshot <out.png>` | Captures the window |
| `eval-state` | Board, zoom, tool, selection and nodes as JSON |
| `recent <folder>`, `draw … --then-recent <folder>` | The sidebar's recent-folder item; with `draw`, right after the last pen-up |
| `close`, `close-answer try\|close` | Closes the window, as the red button does; answers the sheet "Couldn't save your board" |

The port comes from `--port`, else `$SPACE_REMOTE_DEBUG`, else 9339.

- `node scripts/boards/make-demo-folder.mjs <folder>` makes a demo learning
  folder with a v2 board (frames, text, math, SVG, an image, ink) and an old v1 board.
- `scripts/strokes/` holds sample handwriting: `two-plus-two.json` and `equals-four.json`.
- `node scripts/trace-report.mjs <file|dir>` summarises session traces.
- `node scripts/bench/run.mjs --scenarios S1,S2,S3,S4 --model opus` runs the
  fixed agent scenarios on its own instance (port 47870). Scenarios: S1–S4,
  P1–P3 (a busy board) and V1 ("drew while talking"). `--client codex` runs
  GPT through Codex instead of Claude; `--no-news-hook` turns off the board
  news hook; `--dev` uses the dev renderer. See
  [`baseline.md`](../docs/learning-space/baseline.md).

```sh
SPACE_REMOTE_DEBUG=9339 SPACE_FOLDER=~/learn/demo npm run dev
node scripts/drive.mjs draw scripts/strokes/two-plus-two.json
node scripts/drive.mjs screenshot /tmp/space-window.png
```
