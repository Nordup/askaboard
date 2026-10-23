# Learning Space

A desktop app (Electron) with no AI inside. It gives the learner a shared canvas
and a local learning folder. External agents (Codex, Claude Code) connect to it
over MCP and see the canvas. Read [`../docs/learning-space/idea.md`](../docs/learning-space/idea.md)
and [`../docs/learning-space/plan.md`](../docs/learning-space/plan.md).

Step 1: open a learning folder, keep many boards in it, and draw real ink
(pen, highlighter, stroke eraser, lasso select, undo/redo, pan and zoom).
A board is any `*.board.json` file in the folder; new boards go to `boards/`.
The app autosaves 400 ms after a change and reloads a board when another
program (Git, an agent) changes it on disk.

Step 2: the app runs an MCP server, so an agent can look at the canvas
(see "Connect an agent").

## Run

```sh
cd space
npm install      # postinstall downloads the Electron binary
npm run dev      # electron-vite dev server + app window
npm run build    # type-check main/preload and renderer, then bundle to out/
npm start        # run the built app from out/
```

## Connect an agent

The app serves MCP (Streamable HTTP) at `http://127.0.0.1:47821/mcp` while it
is open. Run one command in a terminal:

```sh
claude mcp add --transport http learning-space http://127.0.0.1:47821/mcp   # Claude Code
codex mcp add learning-space --url http://127.0.0.1:47821/mcp               # Codex
```

The agent pill in the top bar shows the agents that made a request in the
last 90 s, grouped by client name (short runs such as `claude -p` exit
without closing their session). Click it for these commands. `SPACE_MCP_PORT=<port>` changes the port. If the port is busy (for
example a second copy of the app), the app logs it and the pill shows
"Agent server off"; it does not pick another port, because the agent config
holds the port.

There is no token. The server binds to 127.0.0.1 only, refuses any request
whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding),
and refuses any request with an `Origin` header (a web page). Each agent gets
its own session (`Mcp-Session-Id`); a session with no open stream and no
request for 10 minutes is closed.

| Tool | Parameters | Result |
| --- | --- | --- |
| `get_canvas_info` | none | JSON: folder (name, absolute path), open board, all boards, viewport rect, content bounds, item count, selection (ids, bounds), tool, zoom, cursor |
| `get_screenshot` | `target`: `viewport` \| `content` \| `selection` \| `changes` \| `region`; `region` `{x,y,width,height}` (for `region`); `max_size` px (default 1600) | PNG + a note with the board rect and scale. `changes` crops to the ink that is new since the agent's last look, outlines it, and advances the cursor |
| `get_changes` | `since` (optional cursor; 0 = everything) | JSON: changed items (id, kind, tool, colour, bounds, seq), removed items (id, bounds, seq), new cursor. Advances the cursor |
| `open_board` | `path` (relative `*.board.json`) | Opens the board in the app; returns the canvas info |

Board coordinates are logical points, origin at the centre, +y down.
Screenshots render the board's items offscreen with the board's own paint
code (no grid, no UI), so they work for any region at any zoom. The cursor is
a board `seq`: every new, moved or restored item takes the next seq, and so
does every removal (removals are kept in memory as tombstones, not in the
file). A board changed on disk is diffed against the live board, so an
external edit also shows up as changes. Cursors are per session and per
board; the first tool call starts the cursor at "now". `since` is exclusive
(changes with seq > since), and a returned cursor is the highest seq seen, so
passing it back never repeats an item.

## Layout

| Path | What |
| --- | --- |
| `src/main/` | Electron main process: window, menu, dev hooks, folder access (`folder.ts`), `state.json` (`state.ts`), the MCP server (`mcp.ts`) |
| `src/preload/` | Sandboxed preload; exposes `window.space` |
| `src/shared/space-api.ts` | The `window.space` type and IPC channel names, shared by both sides |
| `src/shared/board-format.ts` | Board file parse/serialize (one item per line), seq stamping |
| `src/renderer/src/board/` | Ink board, ported from `web/src/board/`; offscreen export in `paint.ts`, removal log in `changes.ts` |
| `src/renderer/src/agent/` | Answers the MCP server's requests from the live board (`handler.ts`) |
| `src/renderer/` | React UI; tokens in `src/renderer/src/styles/tokens.css` |

The window runs with `contextIsolation: true`, `nodeIntegration: false` and
`sandbox: true`.

## Dev automation hooks

These environment variables let an agent check the UI without computer use.
They work with `npm run dev` and `npm start`.

| Variable | Effect |
| --- | --- |
| `SPACE_CAPTURE=/abs/path.png` | After the renderer loads, wait 1 s, capture the window, write the PNG, log `captured <path>`. |
| `SPACE_CAPTURE_QUIT=1` | With `SPACE_CAPTURE`: quit the app after the capture. |
| `SPACE_CAPTURE_DELAY=ms` | Wait this long after load before the capture (default 1000). |
| `SPACE_FOLDER=/abs/dir` | Open this learning folder at launch (overrides the last folder). |
| `SPACE_OPEN=rel/path` | With a folder open: show this file in the preview panel at launch. |
| `SPACE_MCP_PORT=port` | Serve MCP on this port instead of 47821. |
| `SPACE_REMOTE_DEBUG=port` | Dev builds only: Chromium remote debugging on 127.0.0.1:`port`, the page hook `window.__spaceDev`, and no background throttling, so `scripts/drive.mjs` can drive a covered window. |

Example:

```sh
SPACE_FOLDER=~/learn/orbits SPACE_OPEN=notes/kepler.md \
  SPACE_CAPTURE=/tmp/space.png SPACE_CAPTURE_QUIT=1 npm run dev
```

### Drive the canvas: `scripts/drive.mjs`

A check agent must not use computer use for input: macOS refuses drags into a
background window, and the learner keeps working in front. Start the app with
`SPACE_REMOTE_DEBUG=<port>`, then drive it over the DevTools protocol. Input
reaches the page while the window is behind other windows.

| Command | Effect |
| --- | --- |
| `draw <file.json \| -> [--tool pen\|highlighter] [--no-pan]` | Draws strokes given in board coordinates, `[[[x, y, pressure], ...], ...]`, as pen input with pressure. It pans the board first so every point is on screen. |
| `draw --strokes '<json>'` | The same, with the strokes inline. |
| `key <combo>` | Sends a key to the page: `v`, `Delete`, `Escape`, `Meta+z`, `Shift+Meta+z`. |
| `click <x> <y> [--shift]` | Clicks at window CSS pixels. With the pen tool, a click on the canvas draws a dot. |
| `dblclick <x> <y>` | Double-clicks (drills into a frame; edits a text node). |
| `drag <x1> <y1> <x2> <y2> [--shift] [--steps N]` | A mouse drag: move, resize (start on a handle), lasso (a straight drag has no area: use several points for a lasso). |
| `type "<text>"` | Inserts text into the focused field (the text editor). |
| `node-rect <id>` | A node's window rect `{x, y, width, height, cx, cy}`, from the layout cache. |
| `screenshot <out.png>` | Captures the whole window (for UI checks). |
| `eval-state` | Prints the board path, node count, zoom, camera centre, tool, selection ids, whether a text editor is open, and every node (id, kind, parent, text, colour, world bounds) as JSON. |

The port comes from `--port`, else `$SPACE_REMOTE_DEBUG`, else 9339. The exit
code is 0 on success and 1 on error (for example, no app on the port).
A demo learning folder for checks: `node scripts/boards/make-demo-folder.mjs <folder>`
writes `boards/demo-v2.board.json` (a v2 board: a flex card with text, math, an SVG
and ink inside it, a free-layout frame, an image, loose ink), `assets/earth.png`
and `boards/old-v1.board.json` (a step 1 ink-only board). Open it with
`SPACE_FOLDER=<folder>`. To use the demo board in another folder, copy
`scripts/boards/demo-v2.board.json` into it and put any PNG at `assets/earth.png`.
Reusable strokes are in `scripts/strokes/`: `two-plus-two.json` and
`equals-four.json` (handwriting about 100 pt tall, left of the board centre).

```sh
# 1. Start the app, then draw "2 + 2" as pen strokes
SPACE_REMOTE_DEBUG=9339 SPACE_FOLDER=~/learn/demo npm run dev
node scripts/drive.mjs draw scripts/strokes/two-plus-two.json

# 2. Undo the last stroke
node scripts/drive.mjs key Meta+z

# 3. Capture the window
node scripts/drive.mjs screenshot /tmp/space-window.png
```

App state (last folder, recent folders, the camera per board) lives in
`~/Library/Application Support/Learning Space/state.json`, not in the board
files, so panning never changes a file that Git tracks.

The capture has the window's real size. On a small screen macOS shrinks the
1440×900 default to fit.
