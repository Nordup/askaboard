# Learning Space

Learning Space is a desktop app (Electron) for macOS. It gives the learner a
shared canvas and a local learning folder. The app has no AI inside: external
agents (Claude Code, Codex, Claude Desktop) connect to it over MCP and work on
the board with the learner.

**Status:** an experiment on the branch `learning-space`. Steps 0–5 are done.

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
  step for the learner. An outline with the agent name marks its work.
- **Ink groups and placement.** The app clusters learner ink into groups
  (`g1`, `g2`, …). Agents place material beside the learner's work, not over it.
- **Folder setup and an editable board guide.** The sidebar offers to set up
  a folder for learning. A folder can extend or replace the board guide in
  `.learning-space/guide.md`.
- **Connect popover and plugin.** The agent pill in the top bar installs the
  plugin for each agent.

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
- **Agent text:** `resources/instructions.md` (server instructions) and
  `resources/guide.md` (what `get_guide` returns).

| Tool | Main parameters | What it does |
| --- | --- | --- |
| `get_canvas_info` | none | Folder, boards, viewport, selection, top-level nodes and ink groups |
| `get_screenshot` | `node_id` \| `region` \| `target`, `scale`, `max_size`, `labels`, `grid` | PNG of a node, a region, the view, all content, the selection or the changes |
| `get_changes` | `since` | Changed and removed nodes since the agent's cursor; advances the cursor |
| `open_board` | `path` | Opens a board in the app |
| `get_guide` | `topic` | The board guide: HTML subset, math, SVG, tokens, placement |
| `get_tree` | `node_id`, `depth` | Indented outline of nodes with ids and bounds |
| `get_node_info` | `node_id` | One node: bounds, parent, children, style, text, author |
| `get_html` | `node_id`, `include_ids` | A subtree as the `write_html` subset |
| `create_frame` | `name`, `style`, `x`, `y`, `near`, `place` | A top-level frame, placed in empty space when `x` and `y` are omitted |
| `write_html` | `html`, `target_id`, `mode`, `near`, `place` | Writes HTML into a frame or onto the board |
| `update_styles` | `updates: [{node_ids, styles}]` | Changes styles of nodes |
| `set_text` | `updates: [{node_id, text}]` | Replaces the text of text nodes |
| `move_nodes` | `moves: [{node_id, x,y \| dx,dy \| parent_id, index \| before \| after \| place}]` | Moves or reparents nodes |
| `duplicate_nodes` | `node_ids`, `place` | Copies nodes with their children |
| `delete_nodes` | `node_ids` | Deletes nodes or ink groups |
| `draw_ink` | `shape`, `target`, `strokes` \| `svg_path`, `place`, `color`, `tool` | Draws ink: circle, underline, tick, cross, arrow, or free strokes |
| `find_space` | `width`, `height`, `near`, `inside_view` | An empty rect for new material |
| `focus` | `node_id` \| `region`, `padding`, `zoom` | Moves the learner's view to a target |
| `finish_working` | `node_ids` | Clears the agent's "working" outline |

## Learning folder

A folder is set up for learning when `AGENTS.md` exists at its root. Setup
copies the templates in `resources/learning-folder/` and never overwrites a
file. Edit the templates to change what new folders get.

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

To check the Connect buttons without your real agent config, set `HOME`,
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` to scratch folders.

`scripts/drive.mjs` drives a running dev app over the debug port. The input
reaches the window also when it is behind other windows. Do not use computer
use for input.

| Command | Effect |
| --- | --- |
| `draw <file.json \| -> [--tool pen\|highlighter]`, `draw --strokes '<json>'` | Draws pen strokes with pressure, in board coordinates |
| `key <combo>` | Sends a key, for example `Meta+z` |
| `click`, `dblclick`, `drag`, `wheel` | Mouse input at window CSS pixels |
| `type "<text>"` | Types into the focused field |
| `node-rect <id>` | A node's window rect, from the layout cache and the DOM |
| `screenshot <out.png>` | Captures the window |
| `eval-state` | Board, zoom, tool, selection and nodes as JSON |

The port comes from `--port`, else `$SPACE_REMOTE_DEBUG`, else 9339.

- `node scripts/boards/make-demo-folder.mjs <folder>` makes a demo learning
  folder with a v2 board (frames, text, math, SVG, an image, ink) and an old v1 board.
- `scripts/strokes/` holds sample handwriting: `two-plus-two.json` and `equals-four.json`.

```sh
SPACE_REMOTE_DEBUG=9339 SPACE_FOLDER=~/learn/demo npm run dev
node scripts/drive.mjs draw scripts/strokes/two-plus-two.json
node scripts/drive.mjs screenshot /tmp/space-window.png
```
