# Learning Space — architecture

Read this once to know how the app fits together and where to look. It
describes stable structure, not details: for exact behaviour, read the file
it points to. All paths are under `space/` unless stated otherwise.

## The big picture

```
 Agent clients                     Learning Space (Electron)                 Learning folder (disk)
 ───────────────                   ─────────────────────────                 ──────────────────────
 Codex / ChatGPT  ── HTTP ──────►  main process                              AGENTS.md, plan.md, …
 Claude Code      ── stdio relay ►   MCP server  ──IPC request──►  renderer  boards/*.board.json
 Claude Desktop   ── stdio relay ►   folder access, setup, guide    (live board,   assets/
                                     snapshot window (screenshots)  editing, UI)  .learning-space/
                                     agent home (~/.learning-space)
```

- The **renderer owns the live board**: nodes, unsaved edits, undo history,
  the change log and agent presence. Everything an agent does goes through
  it, so the learner sees agent work at once and can undo it.
- The **main process owns the outside world**: the window, the MCP server,
  disk access through one path guard, the snapshot window, and the files in
  `~/.learning-space/`.
- The **learning folder is the only persistent store** of learning content.
  App preferences (recent folders, cameras) live in Electron's `userData`.

## Processes

| Process | Code | Role |
| --- | --- | --- |
| Main | `src/main/` | App lifecycle, window, menu, IPC handlers, MCP server, folder session, snapshot window, agent home, connect actions, the session trace (`trace.ts`), the brief block in `AGENTS.md` (`brief-block.ts`). |
| Preload | `src/preload/` | Exposes one typed API, `window.space` (calls plus `on…` events). Types in `src/shared/space-api.ts`. |
| Renderer | `src/renderer/` | React app: canvas, content layer, sidebar, top bar, menus, agent request handler. |
| Snapshot window | `src/main/snapshot.ts` + `src/renderer/src/snapshot/` | A hidden offscreen window that loads the renderer with `?snapshot=1`, draws a requested region, and is captured to PNG. Closed when idle. |
| Relay | `src/relay/` (built to `out/relay/index.js`) | A separate Node process that an agent client starts through `~/.learning-space/bin/learning-space mcp`. Forwards stdio JSON-RPC to the app's HTTP endpoint; answers from a cache when the app is closed. |

Security baseline: the renderer is sandboxed, with context isolation and no
Node integration. A Content-Security-Policy in `src/renderer/index.html`
limits scripts and images.

## How an agent request flows

1. A client calls a tool on `http://127.0.0.1:47821/mcp` (or through the
   relay). The server (`src/main/mcp.ts`) checks Host and Origin, finds the
   session, validates arguments with zod against the shared limits.
2. The tool sends an IPC request (`canvasInfo`, `changes`, `screenshotPlan`,
   `openBoard`, `agentTool` or `learnerNews`) to the renderer and waits for
   the reply.
3. The renderer (`src/renderer/src/agent/handler.ts`, `edits.ts`) reads or
   changes the live board as **one undo step**, stamps `seq`, records
   removals, updates presence, and returns ids, measured bounds and overlap
   reports.
4. For screenshots, the renderer plans the region and main asks the snapshot
   window to draw it; main captures the pixels.
5. The renderer saves the board file on its own autosave schedule.

## The board document

- **File:** any `*.board.json` in the folder. Format
  `learning-space.board`, version 2: `nextSeq` plus a `nodes` list, one node
  per line. Version 1 boards (ink only) load and are saved as version 2.
  Unknown kinds and fields are kept untouched.
- **Code:** `src/shared/board-format.ts` (parse, serialize, seq stamping,
  disk reconciliation).
- **Node kinds:** `ink` (pen or highlighter stroke, points with pressure),
  `frame` (a box with children; flex or free layout), `text` (light markup:
  `**bold**`, `*italic*`, `$math$`), `svg` (sanitized markup), `image`
  (a file in the folder, usually `assets/`).
- **Common fields:** `id`, `name`, `parent`, `x`, `y` (relative to the parent),
  `z`, `author` (`learner` or `agent`), `seq`, `locked`.
- **Style:** a whitelisted CSS object (`STYLE_KEYS`): the browser lays out
  flex frames. No margin, grid, position or transform.
- **Change tracking:** every created or changed node gets a new `seq`;
  removals are kept in an in-memory tombstone log
  (`src/renderer/src/board/changes.ts`). `since` is exclusive. Each MCP
  session keeps its own cursor per board.
- **Rendering:** the content layer is real DOM under one CSS camera transform
  (`src/renderer/src/board/content.tsx`); ink is drawn on a canvas above it
  with the same camera (`paint.ts`). One layout cache (`scene.ts`) gives
  every node's world bounds to hit testing, selection, placement and agents.
- **Editing:** `src/renderer/src/board/Board.tsx` (tools, camera, selection,
  history). Undo snapshots: `history.ts`.

## Agent-side helpers (renderer)

| Module | Job |
| --- | --- |
| `agent/handler.ts` | Answers requests from main: canvas info, changes, screenshot plans, tool calls, learner news. |
| `agent/edits.ts` | All agent writes: frames, HTML, styles, text, moves, duplicates, deletes, ink, focus; presence outline. |
| `board/html.ts` | HTML subset ⇄ nodes, both directions; reports what was dropped. |
| `agent/groups.ts` | Clusters learner ink into groups `g1`, `g2`, … with stable ids. |
| `agent/placement.ts` | Automatic placement, `place` (right_of, below, over, …), `find_space`, overlap reports. |
| `agent/ink.ts` | Agent ink: shapes (circle, tick, cross, underline, arrow), SVG path sampling, a hand-drawn pressure profile. |

## MCP server

- Streamable HTTP, path `/mcp`, bound to `127.0.0.1`, port 47821
  (`SPACE_MCP_PORT`). One session per client. Requests with a browser
  `Origin`, or a Host other than localhost, are refused. No token.
- **Tools** (20), in four groups:
  - *Look:* `get_canvas_info`, `get_tree`, `get_node_info`, `get_html`,
    `get_screenshot` (node, region, viewport, content, selection, changes;
    optional labels and grid), `get_changes`, `get_brief`, `get_guide`.
  - *Make and edit:* `create_frame`, `write_html`, `update_styles`,
    `set_text`, `move_nodes`, `duplicate_nodes`, `delete_nodes`, `draw_ink`.
  - *Place and view:* `find_space`, `focus`, `open_board`.
  - *Presence:* `finish_working`.
- **What agents read** (decision I3; how to write it:
  [`writing-agent-text.md`](writing-agent-text.md)):
  - the brief, `resources/brief.md`: as a managed block in the folder's
    `AGENTS.md` (`src/main/brief-block.ts` refreshes it when a folder opens,
    unless the learner edited it) and as `get_brief` for agents without it;
  - the board reference, `resources/guide.md`: `get_guide`, one topic per
    call (model, html, math, svg, images, tokens, placement, ink, view; the
    description lists them with one line each from the file's
    `<!-- summary: … -->` markers); without a topic, all of it (decision T11);
  - server instructions, `resources/instructions.md` (a short orientation
    that points to `get_brief` and `get_guide`);
  - folder overrides `.learning-space/instructions.md` (added to or
    replacing the server instructions) and `.learning-space/guide.md`
    (the reference's topic `folder`, or with `mode: replace` the whole
    reference) (`src/main/guide.ts`, read fresh per call, 64 KB cap);
  - tool and parameter descriptions in `src/main/mcp.ts` (facts only: what
    the tool does, when it fits, each parameter, what it returns; they point
    to the `get_guide` topic for details). Each stays under 4,096 characters.
- **Session trace** (`src/main/trace.ts`, always on): every MCP call, the
  screenshots agents received and the learner's edits, as JSONL in
  `~/.learning-space/traces/<date>/` (or `SPACE_TRACE_DIR`). Read with
  `scripts/trace-report.mjs`.
- **Board news** (`src/main/news.ts`, decision I4), delivered once: per
  agent app (client label as in `clientLabel()`), folder and board, the app
  keeps the board seq up to which the learner's changes were delivered and
  the seq of the app's last look, in memory and `userData/state.json`
  (`agentLooks`). The renderer's `learnerNews` request lists the learner's
  ink strokes added or erased after the delivered seq (agent edits left
  out; erasures are known for the current app run only), with their ink
  groups and the nearest material. The news is delivered when it is sent:
  as the first line of the app's next tool result (computed before the tool
  runs; `get_changes` gets none, it lists the changes itself), or through
  `GET /news?client=<label>` (same Host and Origin checks, plain text, empty
  when nothing is new). A look (`get_screenshot`, `get_changes`) also counts
  as delivered. So the prompt hook and the tool results of one turn never
  repeat a change. A new session's change cursor starts at the app's last
  look, so `get_changes` after a hook still lists what the news named.
- **Limits** for every agent-controlled size: `src/shared/limits.ts`.

## Folder access (main)

- `src/main/folder.ts`: `FolderSession` with **one path guard**
  (`resolvePath`: relative paths only, no escape through `..` or symlinks).
  Every file operation uses it. Board writes are atomic; own writes are not
  echoed back by the watcher.
- Images reach the renderer through the `space-asset://` protocol, which
  also goes through the path guard.
- Agent image downloads: `src/main/asset-fetch.ts` (https only, public
  addresses only, pinned IP, size and type checks).
- Folder setup: `src/main/setup.ts` copies `resources/learning-folder/`
  (`AGENTS.md` with the brief block filled in, `plan.md`, `learner.md`,
  folders, guide stub) and never overwrites a file. Afterwards only the brief
  block in `AGENTS.md` is refreshed by the app.

## Agent home and connecting clients

- `src/main/agent-home.ts` writes `~/.learning-space/bin/learning-space` (the
  relay shim), `relay.json` (port) and `tools.json` (tool catalogue for the
  offline relay) on every launch. `learning-space news --client <label>`
  prints the board news line (from `GET /news`; nothing when nothing is new,
  the app is closed or anything fails; exit 0; about 0.1 s). The plugins run
  it as a `UserPromptSubmit` hook: `hooks/claude.json` (Claude Code) and
  `hooks/codex.json` (Codex), named in each client's manifest.
- `src/main/connect.ts` detects and installs: the plugin for Claude Code and
  for ChatGPT and Codex (through their CLIs), the `.mcpb` for Claude Desktop.
  It detects hand-made entries and duplicates.
- The plugin itself lives in the sibling repo
  `github.com/Nordup/learning-space-plugins`
  (`../learning-space-plugins`): per-client manifests, a small skill, the
  `.mcpb`, validators, CI, one version source.

## UI

- Components live in `src/renderer/src/components/` (the snapshot view in
  `src/renderer/src/snapshot/`).
- Shell: `App.tsx` (state and wiring), `TopBar.tsx`, `Sidebar.tsx`
  (`FileTree.tsx`), `ToolPalette.tsx`, `PreviewPanel.tsx`, `WelcomeCard.tsx`,
  `CanvasNotice.tsx`, `Toast.tsx`.
- Menus and popovers: `Menu.tsx`, `AgentPill.tsx`, `SetupMenu.tsx`,
  `GuideOverrideNote.tsx` — all built on the shared menu system.
- Styles: `styles/tokens.css` (all design tokens), `styles/app.css` (all app
  UI, including the menu system), `board/board.css`, `board/content.css`.
- Rules: [`design-system.md`](design-system.md).

## Development and automation

- `npm run dev` (relay build + `electron-vite dev`), `npm run build`
  (type-check, bundle, relay), `npm run build:mcpb`, `npm start`.
- Environment switches (dev): `SPACE_FOLDER` (open a folder),
  `SPACE_MCP_PORT`, `SPACE_REMOTE_DEBUG` (Chromium debug port + dev hooks),
  `SPACE_OPEN` (preview a file), `SPACE_CAPTURE*` (window PNG on load),
  `SPACE_CONNECT_DRY_RUN`, `SPACE_TRACE_DIR` (where traces go). The relay
  reads `LEARNING_SPACE_PORT`.
- `scripts/drive.mjs` drives a running dev app over the debug port: draw
  pen strokes, keys, clicks, drags, wheel, node rects, screenshots, state.
- `scripts/trace-report.mjs` summarises traces; `scripts/bench/run.mjs` runs
  the fixed agent scenarios (see [`baseline.md`](baseline.md)).
- `scripts/boards/make-demo-folder.mjs` makes a demo learning folder;
  `scripts/strokes/*.json` hold sample handwriting.
- Packaging (later) must ship `resources/` as extra resources and unpack
  `out/relay/` from the asar archive.
