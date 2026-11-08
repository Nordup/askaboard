# Askaboard

Askaboard is a desktop app (Electron) for macOS and Linux. It gives the learner a
shared canvas and a local learning folder. The app has no AI inside: external
agents (Claude Code, Codex, Claude Desktop) connect to it over MCP and work on
the board with the learner. Its one AI part is the voice, which reads scene lines
aloud: our voice server by default (T39), the learner's own Gemini key, or a
local Kokoro model that the learner installs from Settings (T40).

**Status (2026-11-07):** the main product of this repository (since 2026-10-24). The app chrome and Settings were redesigned on 2026-11-06/07 (U9–U17; how to build UI in that style: `design-system.md`, "How to build UI here"). All words on the board are in the hand, and text items rotate and scale (B56–B61). Scenes stream to the board (T27, T32), the voice explainer is parked (I28), an unknown scene option is an error (B24), the app reads scene lines aloud (T34), and it cleans up its own storage (T35). Steps 0–5, fix 1, board news (decision I4), `get_brief` and `get_guide` (decision T11), live drawing stages 1–4 (scenes as the one way to write, the script panel), brief v18 and the agent texts in Anthropic's style (decisions I18–I22) are done. The scene tools are `write_scene`, `preview_scene` and `play_scene` (T16), with the old approved wording (I25). The board reads give summaries first (T20), and the board tools are `list_boards`, `open_board` and `move_board` (T21). Every tool refuses unknown parameters. Scenes can be files in `boards/scenes/` with imports (B16 step 1); each board keeps a scene record, so agents read items by scene and step after a restart (B16 step 2). After a restart the stage is rebuilt from that record, so earlier scenes can be replayed, previewed and replaced, and a new scene finds their objects (B16 step 3). A scene input works, draws nothing, or is an error; results carry no warnings (B18). `play_scene` does not wait (T23). Open work for contributors is in GitHub issues.

- [`../../docs/README.md`](../../docs/README.md): start here.
- [`architecture.md`](../../docs/architecture.md): processes, data flow and where the code lives.
- [`design-system.md`](../../docs/design-system.md): UI tokens and rules.
- [`working-guide.md`](../../docs/working-guide.md): how to build and check the app.

## Run

```sh
cd apps/desktop
npm install      # postinstall downloads the Electron binary
npm run dev      # build the relay, then start the dev app window
npm run build    # type-check, bundle to out/, build the relay
npm start        # run the built app from out/
```

Do not run test suites. Check a change with `npm run build`. The rules are in
[`../../AGENTS.md`](../../AGENTS.md).

### On Linux

The same commands work (checked on Manjaro, GNOME on Wayland, decision D6).
Electron runs native Wayland. Differences from macOS:

- The window has the desktop's title bar. The menu bar is hidden; Alt shows it.
  Shortcuts use Ctrl, and the UI shows them as `Ctrl+O`.
- `npm run build:mcpb` needs the Info-ZIP `zip` command (`pacman -S zip`).
- A shell that an agent app starts can have `ELECTRON_RUN_AS_NODE=1` set (T3 Code
  does this). Then `electron .` runs as Node and fails with "bad option". Start
  Electron directly with `env -u ELECTRON_RUN_AS_NODE`. `npm run dev`,
  `npm start` and the lab remove the variable themselves.
- Electron keeps its settings under `$HOME/.config`, so a scratch `HOME` also
  separates them. Pass `--user-data-dir` anyway, as on macOS.

## What the app does today

- **Learning folder and boards.** Open a folder. Any `*.board.json` file in it
  is a board. New boards go to `boards/`. The app autosaves and reloads a
  board when another program changes it on disk. If a save fails at close,
  the board goes to a recovery file and a dialog offers to try again.
- **Ink with pressure.** Pen, marker, eraser, rectangle and lasso select,
  undo and redo, pan and zoom. Tools for a mouse and a trackpad, with letter
  keys: Hand, rectangle, ellipse, arrow, line and text, a style
  pill for colour, width and text, Option-drag to duplicate, a right-click
  menu, paste of text and images from other apps. A mouse or trackpad stroke gets its width from
  its speed (B57). The board's 100% is camera zoom 0.85 (B61): Ctrl/⌘ with =,
  - and 0. View > Interface Size zooms the whole window per machine
  (`interfaceSize` in `state.json`, 80–200%): Ctrl/⌘+Alt with =, - and 0;
  Automatic is 120% when the OS scale is below 1.5, else 100% (B63).
  A Ctrl or ⌘ mouse-wheel notch zooms 15% with a short glide; a pinch
  follows the fingers (B65).
- **One hand for all words.** Typed text and agent text are in the
  'Learning Hand' font, made from the strokes of `write()`
  (`scripts/lab/make-hand-webfont.mjs`). Text items rotate and scale. Below
  1.5 device pixels per CSS pixel (Interface Size counts) the board uses a
  heavier cut with the same metrics (B64).
- **Editable document.** A board holds ink, frames, text with math, SVG and
  images. The learner can select, move and edit all of them.
- **Agents see and edit the board over MCP.** Every agent write is one undo
  step for the learner.
- **Ink groups and placement.** The app clusters learner ink into groups
  (`g1`, `g2`, …). Agents place material beside the learner's work, not over it.
- **Folder setup and an editable folder guide.** The sidebar offers to set up
  a folder for learning. A folder can add a topic to the board reference that
  `get_guide` returns, or replace the reference, in `.askaboard/guide.md`.
- **Connect popover and plugin.** The agent pill in the top bar installs the
  plugin for each agent.
- **Live scenes.** An agent writes a JavaScript program (`write_scene`) that
  draws ink, handwriting, shapes, handwritten text, typeset maths and worlds and says how
  they unfold in time; the board plays it, and the result stays as ordinary
  items. Programs on a board share one sandbox (the stage), queue back to
  back, can pause at steps, and pause when the learner starts drawing. A
  scene's text lines (`say`) appear in a floating reading
  panel for one scene (the previous line, the current line, a step bar); it
  fades after the scene and hides into the scene pill in the top bar, which
  lists the board's scenes and shows the scene and step of a selected item.
- **Voice.** The app reads `say` lines aloud, and each line lasts as long as
  its audio. With no key, the audio comes from our voice server
  (`ASKABOARD_VOICE_HOST`, decision T39), with a daily cap per user; an own
  Gemini key (`GEMINI_API_KEY`, or a line in `~/.askaboard/.env`) goes to
  Gemini directly. Settings > Voice (⌘,) holds Read Lines Aloud (on by default), the
  voice, the pace, the Gemini key and the local voice: Install downloads
  Kokoro (about 370 MB, `~/.askaboard/models/kokoro/`, T40). When the
  voice fails, or with Read Lines Aloud off, the lines run at a reading pace,
  silent. The voice and the pace (also View > Voice and View > Pace) apply to new scenes. The play button's sample of the cloud voice ships with the app (`resources/voice-samples/`), so it plays at once; Kokoro makes its sample on the Mac. Clips stay in the folder's `.askaboard/voice/`.
  The default voice is Charon. A replay makes no API call. A scene written
  before the voice stays silent until one new `write_scene`.
- **Worlds.** A scene can place a world on the board: plain three.js with no
  frame, and any library from the internet. A world keeps running, follows the
  scene's clock and values, links to labels and arrows, and writes its own
  interaction. It runs in a sandboxed origin. Toon is the only look.
- **Cleanup** (`src/main/storage.ts`). Unused voice clips and code copies go
  after a day, traces after 14 days, and records of gone boards to the Trash
  after 7 days. A board moved to the Trash takes its data with it. The Chromium
  caches are capped at 100 MB. Board files and `assets/` are never touched
  (T35).

## Connect agents

The agent pill in the top bar opens a popover with two views:

1. **Agents.** One row per agent that is installed or that connected. A green
   dot shows an agent that was active in the last 90 s.
2. **Connect an agent.** Rows for Claude Code, Claude Desktop, and ChatGPT and
   Codex. Each row has an **Install** button. **Manual setup and other agents**
   opens the plugin repo.

The plugin is in [`github.com/Nordup/askaboard-plugins`](https://github.com/Nordup/askaboard-plugins)
(marketplace `askaboard`, plugin `askaboard`). The README there has
the manual steps for each agent.

- **Relay command (stdio):** `~/.askaboard/bin/askaboard mcp`. The app
  writes this command on every launch. The relay lists the tools also when the
  app is closed.
- **Claude Desktop extension:** `resources/askaboard.mcpb`. **Install**
  opens it in Claude Desktop. On Linux the app finds Claude Desktop as a
  `claude-desktop` command or a `.desktop` file, and starts it with the file
  path. `npm run build:mcpb` copies the plugin repo's
  `.mcpb` when the sibling repo is present. Otherwise it builds a minimal one.

Use the plugin or a manual MCP entry, not both. With both, the agent sees
every tool twice. The popover shows this problem and offers **Fix**.

## MCP

- **Endpoint:** `http://127.0.0.1:47821/mcp` (Streamable HTTP), while the app is open.
- **Port:** `ASKABOARD_PORT` changes it, for the app and the relay (`SPACE_MCP_PORT`, the older name, works too).
- **Agent text:** `resources/brief.md` (the brief: the managed block in a
  folder's `AGENTS.md`, and `get_brief` for agents without it),
  `resources/guide.md` (the board reference in topics, `get_guide`; decision
  T11), `resources/instructions.md` (server instructions) and the tool and
  parameter descriptions in `src/main/mcp.ts`. Before you change any of them, read
  [`writing-agent-text.md`](../../docs/writing-agent-text.md).

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
| `get_guide` | `topic` | One topic of the board reference (scene, scene-files, scene-world, scene-interact, model, html, math, svg, images, tokens, placement, ink, view, and `folder` when the folder has `.askaboard/guide.md`); without a topic, all of it |
| `write_scene` | `name`, `code` or `file` | Runs a scene program (inline, or a file in `boards/scenes/`) and keeps the result as a draft by name; the learner sees nothing. Returns steps and items, or the program error with its line. |
| `preview_scene` | `name`, `at`, `part`, `version` | Read-only: one image of a draft or of a scene on the board, at chosen moments (end, a step, a time, a list, every step), framed on the scene, the view, a region or items. |
| `play_scene` | `action` (start, status, pause, resume, next, stop, clear_queue, cancel, replay, cut, reset), `name`, `when`, `from_step`, `after_step` | Starts a draft on the board (replacing a scene of the same name in place; returns at once) and controls playback and the stage. |

## Learning folder

A folder is set up for learning when `AGENTS.md` exists at its root. Setup
copies the templates in `resources/learning-folder/` and never overwrites a
file. Edit the templates to change what new folders get. The brief block in
`AGENTS.md` is the one exception: the app refreshes it when the folder opens,
unless the learner edited it.

## Usage data

The app sends product usage events to our own server at
`api.askaboard.com`. The server keeps a copy of each event and forwards
it to PostHog (US). The code is `src/main/analytics.ts`.

The events:

| Event | Properties |
| --- | --- |
| `app.boot.heartbeat` (each start) | the number of recent folders, whether Read Lines Aloud is on, the voice source |
| `folder.opened` | how it opened (launch, dialog, recent, menu), whether it was set up |
| `board.opened` | whether it is new, whether you or the agent opened it |
| `agent.connected` | the agent app (Claude Code, Codex, Cursor, Claude Desktop or other) and its version |
| `mcp.tool.invoked` | the tool name, success, the duration, the agent app |
| `scene.played` | how the playback ended, its length in seconds, whether it had a voice |
| `voice.requested` | the source (our server, your key, the local voice or the cache), the result, the audio length, the request time |
| `install.owner_observed` | a hashed account id (see below) |

Each event also has the app version, the release channel, the platform, the
CPU architecture and the OS version.

The events never include board content, scene text, spoken lines, file names,
folder paths, tool arguments or error messages.

Each event has a hashed identifier. It is the SHA-256 hash of your Codex
account id, or of your Claude Code user id, or of a random id for this
install. The random id is in `~/.askaboard/anonymous-id`. To count the
installs of one person, the app also sends the SHA-256 hash of your OpenAI
account id and of your Claude account id when you are signed in. The app
never sends a raw id.

Your IP address is used only to find your country and city. Our server does
not store it with the events, and PostHog discards it after the lookup. For
the daily limit of the free voice, the server keeps your IP address for 7
days, then deletes it.

To turn usage data off, set `ASKABOARD_TELEMETRY_ENABLED=false` in the
environment of the app. A dev run (`npm run dev`) sends nothing unless you set
`ASKABOARD_TELEMETRY_ENABLED=true`; a run of a local build sends, tagged
with its channel. The voice server gets the same hashed identifier with each
speech request, also with usage data off (T39): it counts the daily cap. `ASKABOARD_TELEMETRY_HOST`
changes the server. A build sets the channel from
`ASKABOARD_TELEMETRY_CHANNEL` (stable, nightly, preview or dev; the
default is dev).

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
| `SPACE_TRACE_DIR=/abs/dir` | Write session traces here instead of `~/.askaboard/traces/`. |
| `SPACE_NO_FOCUS=1` | Show the window without activating the app: it never takes focus or switches the desktop (a macOS Space). The lab, the benchmarks and the render run set it. |
| `SPACE_FAKE_FULL_SCREEN=1` | With `SPACE_REMOTE_DEBUG`: the renderer lays out as in full screen (no window buttons; the title row starts at 12 px), with no real full screen, so a check never moves the window to a new macOS desktop Space. |
| `SPACE_REMOTE_DEBUG` and the splash | Dev builds: over the debug port, `window.__splash.show({ seed, t, fps, pointer })` restarts the splash artwork with that seed, held at time `t` (seconds), or running from 0 with `t: null`; `fps` sets the calm frame cap and `pointer: false` ignores the pointer (for a measurement); `window.__splashFrameMs` holds the last frames' cost in ms and `window.__splashGlContexts` counts live WebGL contexts. |

The live drawing lab (`scripts/lab/`, its own README) starts its own app instance, plays scene programs and records them (MP4 and filmstrip), sends beats, runs model councils, and builds a gallery at `apps/desktop/.lab/index.html`.

To check the Connect buttons without your real agent config, set `HOME`,
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` to scratch folders.

`scripts/drive.mjs` drives a running dev app over the debug port. The input
reaches the window also when it is behind other windows. Do not use computer
use for input. It attaches to the board window by its URL
(`scripts/app-page.mjs`), never to the stage or snapshot page, and waits up
to 20 s for that window and its dev hook to load.

| Command | Effect |
| --- | --- |
| `draw <file.json \| -> [--tool pen\|marker\|eraser\|current] [--no-pan] [--mouse]`, `draw --strokes '<json>'` | Draws strokes with pressure, in board coordinates. It pans the board first so that every point is on screen; `--no-pan` keeps the view. `--tool eraser` drags the eraser along the strokes. `--mouse` sends a mouse pointer in place of a pen |
| `key <combo>` | Sends a key, for example `Meta+z` or `Shift+?`. `Meta+c`, `x`, `v`, `a` and `z` also run their edit command, as macOS does, so `Meta+v` raises the page's paste event with the system clipboard |
| `click`, `dblclick`, `drag`, `wheel` | Mouse input at window CSS pixels. `click --right` presses the right button (the board menu); `drag --alt` holds Option / Alt (duplicate and move); `--shift` adds Shift |
| `hover <x> <y>` | Moves the pointer there with no press and leaves it there (a tooltip check) |
| `type "<text>"` | Types into the focused field |
| `node-rect <id>` | A node's window rect, from the layout cache and the DOM |
| `element-rect <css selector>` | The window rects (and visibility, opacity) of the elements that match |
| `window-size <w> <h>` | Resizes the window |
| `screenshot <out.png>` | Captures the window |
| `eval-state` | Board, zoom, tool, selection and nodes as JSON |
| `recent <folder>`, `draw … --then-recent <folder>` | The sidebar's recent-folder item; with `draw`, right after the last pen-up |
| `close`, `close-answer try\|close` | Closes the window, as the red button does; answers the sheet "Couldn't save your board" |
| `select <css selector> [label]` | Prints an app dropdown's value and options (the `.menu__select` trigger, `Select.tsx`); with a label, opens it and clicks that option as the learner does |
| `menu <id>`, `menu-state <id>` | Chooses an app menu item by id, as its accelerator does (`settings`, `search-boards`, `show-performance`, `interface-size-120`, `pace:<id>`); prints a menu item as it shows (label, checked, enabled, visible) |
| `frames <ms>` | Counts the window's display frames for that long (run it beside a `drag`): fps and the longest frame. A window in the background may get fewer frames |

The port comes from `--port`, else `$SPACE_REMOTE_DEBUG`, else 9339.

- `node scripts/boards/make-demo-folder.mjs <folder>` makes a demo learning
  folder with a v2 board (frames, text, math, SVG, an image, ink) and an old v1 board.
- `node --no-warnings scripts/voice/make-samples.mjs [voice…]` makes the cloud
  voice's Settings samples that ship with the app (decision U14): one AAC clip
  of the sample sentence per voice and pace, from our voice server, into
  `resources/voice-samples/` (about 410 KB for 18 clips; macOS, `afconvert`).
  It is an asset build tool: run it again when the voices, the paces or the
  sample text in `src/main/voice-choices.ts` change, and commit the clips.
- `scripts/strokes/` holds sample handwriting: `two-plus-two.json` and `equals-four.json`.
- `node scripts/trace-report.mjs <file|dir>` summarises session traces.
- `node scripts/perf/render.mjs` measures what the worlds and the board cost on
  this machine, with history in `.lab/perf/render-history.jsonl`.
  `SPACE_WORLD_TUNE` changes one render setting for a run. See
  [`scripts/perf/README.md`](scripts/perf/README.md). In the app,
  View > Show performance shows the same numbers in a small pill.
- `node scripts/bench/run.mjs --scenarios S1,S2,S3,S4 --model opus` runs the
  fixed agent scenarios on its own instance (port 47870). Scenarios: S1–S4,
  P1–P3 (a busy board) and V1 ("drew while talking"). `--client codex` runs
  GPT through Codex instead of Claude; `--no-news-hook` turns off the board
  news hook; `--dev` uses the dev renderer. How to read the results:
  [`scripts/perf/README.md`](scripts/perf/README.md).

```sh
SPACE_REMOTE_DEBUG=9339 SPACE_FOLDER=~/learn/demo npm run dev
node scripts/drive.mjs draw scripts/strokes/two-plus-two.json
node scripts/drive.mjs screenshot /tmp/space-window.png
```
