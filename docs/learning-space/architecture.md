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
  and the change log. Everything an agent does goes through
  it, so the learner sees agent work at once and can undo it.
- The **main process owns the outside world**: the window, the MCP server,
  disk access through one path guard, the snapshot window, the files in
  `~/.learning-space/`, and the speech API (`src/main/voice.ts`, T34).
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
limits scripts, images and media.

## How an agent request flows

1. A client calls a tool on `http://127.0.0.1:47821/mcp` (or through the
   relay). The server (`src/main/mcp.ts`) checks Host and Origin, finds the
   session, validates arguments with zod against the shared limits.
2. The tool sends an IPC request (such as `agentTool`, `sceneControl`,
   `sceneDraft` or `sceneFrames`) to the renderer and waits for
   the reply.
3. The renderer (`src/renderer/src/agent/handler.ts`, `edits.ts`) reads or
   changes the live board as **one undo step**, stamps `seq`, records
   removals, and returns ids and measured bounds.
4. For screenshots, the renderer plans the region and main asks the snapshot
   window to draw it; main captures the pixels.
5. The renderer saves the board file on its own autosave schedule (see "Saving").

## The board document

- **File:** any `*.board.json` in the folder. Format
  `learning-space.board`, version 2: `nextSeq` plus a `nodes` list, one node
  per line. Version 1 boards (ink only) load and are saved as version 2.
  Unknown kinds and fields are kept untouched.
- **Code:** `src/shared/board-format.ts` (parse, serialize, seq stamping,
  disk reconciliation).
- **Node kinds:** `ink` (pen or highlighter stroke, points with pressure;
  a mouse stroke gets its pressure from speed at capture, in
  `board/mouse-ink.ts`), `frame` (a box with children; flex or free layout;
  a group's frame has `hug` and fits its items again after each scene and
  each board measure, in `board/hug.ts`), `text` (light markup:
  `**bold**`, `*italic*`, `$math$`; an optional `rotation` in degrees, with
  its geometry in `board/rotation.ts`), `svg` (sanitized markup), `image`
  (a file in the folder, usually `assets/`).
- **Fonts and sizes:** all board words use the hand webfont `--ls-hand`
  (`styles/hand.woff2`, made by `scripts/lab/make-hand-webfont.mjs` from
  `src/shared/hand-font.ts`); KaTeX keeps its fonts. `BOARD_LAYOUT` in
  `board-format.ts` is the layout version: raise it when a board font or its
  metrics change, so recorded text measures are measured again. Camera zoom
  is screen points per board point; 100% is `HOME_ZOOM` (0.85, in
  `board/geometry.ts`).
- **Common fields:** `id`, `name`, `parent`, `x`, `y` (relative to the parent),
  `z`, `author` (`learner` or `agent`), `seq`, `locked`.
- **Style:** a whitelisted CSS object (`STYLE_KEYS`): the browser lays out
  flex frames. No margin, grid, position or transform.
- **Change tracking:** every created or changed node gets a new `seq`;
  removals are kept in an in-memory tombstone log
  (`src/renderer/src/board/changes.ts`), which holds a bounded number of
  revisions. `since` is exclusive. Each MCP
  session keeps its own cursor per board.
- **Rendering:** the content layer is real DOM under one CSS camera transform
  (`src/renderer/src/board/content.tsx`); ink is drawn on a canvas above it
  with the same camera (`paint.ts`; static ink comes from cached tiles,
  `ink-tiles.ts`, decisions B28 and B40; stroke geometry has its own budget, decision B48). One layout cache (`board/scene.ts`, the node-tree cache; not related to live scenes) gives
  every node's world bounds to hit testing, selection, placement and agents.
- **Editing:** `src/renderer/src/board/Board.tsx` (tools, camera, selection,
  history; the stroke in progress: `paint.ts ActiveInk`, decision B29). Each kind of drag ends in one table, `dragEnds`, for a pointer up and for `settle` alike (decision B45). Undo: `history.ts`, a full snapshot on top of sparse changes between snapshots (decision B43). An agent edit is a change from the
  nodes it was computed from, and it applies to the current document by item
  id (`scene.ts applyChanges`; a change of parent takes the place as one value, `mergePlace`, decision B40). A drag shows on top of the document; a commit
  under it goes to the document (`commitOver`, decision B26).

## Saving

The renderer holds one pending version per board, by folder and path
(`App.tsx`). A version stays there until its own write succeeds, also during
that write. Each board read and write names its folder (`root`), and main
sends it to that folder's `FolderSession`, also when another folder is open by
then. A folder switch and a board change run in the save chain: they save
first, and a failed save stops them. Failed saves stay pending and try again.
Each way that takes the Board away commits what the learner has open in the
same task as the unmount (`leaveBoard`), so a stroke that started during an
await stays. At close, the renderer writes until a write fails or nothing is
pending. Main hears the newest text of each pending board: it goes to
`userData/recovery/` (`main/recovery.ts`), one native dialog offers "Try again"
and "Close anyway", and the board's next open brings the text back. A renderer
that does not answer in 2 s cannot hold the window. Decisions B26, B27 and B42.

## Agent-side helpers (renderer)

| Module | Job |
| --- | --- |
| `agent/handler.ts` | Answers requests from main: the reads, changes, screenshot plans, board changes, learner news. |
| `agent/reads.ts` | The board reads of `list_items`, `get_item`, `get_changes` and the `part` of `get_screenshot`: what needs the live layout (units, ink groups, summaries by area, the "Deeper:" lines; decisions T20, T21). The board model that needs no layout (what counts as an item, item texts and the one search, clustering by place, place, count and time words) is `shared/board-digest.ts`, which `list_boards` and board news in main use too. |
| `agent/edits.ts` | Item details for `get_item`, scene requests. |
| `board/html.ts` | HTML subset ⇄ nodes, both directions; reports what was dropped. |
| `agent/groups.ts` | Clusters learner ink into groups `g1`, `g2`, … with stable ids. |
| `agent/placement.ts` | The board as a scene sees it, obstacles, an empty place near an anchor (`space()`, html() without a place). |
| `agent/ink.ts` | The hand-drawn pressure profile (taper, wobble) for scene ink, seeded per stroke. The ink points of pen shapes come from the stage (`shared/ink-points.ts`, `shared/path-geometry.ts`, decision B14). |

## MCP server

- Streamable HTTP, path `/mcp`, bound to `127.0.0.1`, port 47821
  (`SPACE_MCP_PORT`). One session per client. Requests with a browser
  `Origin`, or a Host other than localhost, are refused. No token.
- **Tools** (12), in four groups (decision P13: scenes are the one way to
  write; decisions T20, T21 for the reads and the boards). Every tool
  refuses unknown parameters.
  - *Look at the open board:* `list_items`, `get_item`, `get_screenshot`,
    `get_changes`. One address word, `part`; summaries first, with
    "Deeper:" lines; no caps.
  - *Boards of the folder:* `list_boards` (read-only), `open_board`,
    `move_board` (also to and from the Trash; nothing is deleted). Their cache is `main/boards.ts`. Create,
    rename and trash, from the sidebar and from agents, go through one
    board-change operation (`App.tsx` `changeBoard`).
  - *Reference:* `get_brief`, `get_guide`.
  - *Live scenes (all writes):* `write_scene` (a draft), `preview_scene`
    (an image of a draft or a played scene), `play_scene` (start and
    playback; decision T16; see "Live scenes" below).
- **No presence on the board** (U3): the scene pill and the agent pill in
  the top bar show that an agent is working; board items get no outline or
  name tag.
- **What agents read** (decision I3; how to write it:
  [`writing-agent-text.md`](writing-agent-text.md)):
  - the brief, `resources/brief.md`: as a managed block in the folder's
    `AGENTS.md` (`src/main/brief-block.ts` refreshes it when a folder opens,
    unless the learner edited it) and as `get_brief` for agents without it;
  - the board reference, `resources/guide.md`: `get_guide`, one topic per
    call (scene, scene-files, scene-world, scene-interact, model, html, math,
    svg, images, tokens, placement, ink, view; the
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
  when nothing is new). A look (`list_items` of the view or the board,
  `get_screenshot`, `get_changes`, `open_board`) also counts as delivered. So the prompt hook and the tool results of one turn never
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

## Live scenes (live drawing)

How an agent's scene program becomes drawing on the board (decisions P11,
P19, T12, T34; [`live-drawing-plan.md`](live-drawing-plan.md)):

- **Scene files.** A program is inline code or a file in `boards/scenes/`
  of the learning folder, with `import` and `export` between files
  (decisions B16, B17). `write_scene` reads the file and its imports once
  (`src/main/scene-files.ts`: an acorn transform that keeps line numbers,
  a content cache by hash); the stage runs the modules with a small module
  registry. A later edit of a file changes nothing until the next
  `write_scene`.
- **Scene record.** Each board keeps an append-only history,
  `.learning-space/scenes/<board id>.jsonl` (`src/main/scene-store.ts`,
  the only writer; decisions B16, B20). One `scene` line per played version
  (source: module hashes, seed, cut, board context, host answers; story:
  steps, lines, items per step; revert), plus `drop` and `reset` lines.
  Module texts are kept once in `code/<sha>.js`. The board file holds the
  board's `id`. Main reads the file as a stream when a board opens and
  sends the stories to the renderer; `src/shared/scene-story.ts` holds the
  one rule for which line belongs to which step. A scene line also keeps
  each node's signature after the commit and the board's measures
  (`settle`: centred text, fitted frames, glide starts).
- **The stage is rebuilt from the record** (spec step 3). The stage log
  and the player's history are caches of the record. One rule: each board
  mount (an open, a reload from disk, a window that loaded again, another
  folder) starts a new stage from the record, whatever the stage held
  (`mcp.ts restoreStage`; it runs before every program run and soon after
  the mount). The new stage gets the current segment's scenes that were
  not dropped, each the version the board shows, in order, with its saved
  source (from `code/<sha>.js`), seed, cut, context and answers, and the
  programs run again at once, so a new scene sees the earlier scenes'
  objects. Work for another folder, board or mount is dropped after every
  await, and a mount ends the stage work no call owns. A saved context is
  rebound to the current stage when it runs again (epoch, board path:
  `live-scene.ts savedContext`). The renderer gets the
  new epoch, the stage's identities and each scene's story, revert and
  measures (`run.ts sceneRestore`), so a replace takes the old items off
  and a new scene finds them.
- **One failure state.** A program whose code is missing or that fails, a
  record of the older key scheme or with a malformed line (checked at the
  record boundary: `scene-store.ts restoreProblem`), a re-run that does
  not match its record, and a program a cancel stops while it runs in a
  rebuild are marked (`StageEntry.failed`, the only owner): it keeps its
  place and its items, no rebuild runs it, and a restage neither reverts
  nor runs it (later scenes see its objects as gone). The renderer's
  mirror (`rebuild.ts`) comes before any play data it holds.
- **Stage ids never shift.** Each program keeps the stage ids it took,
  `[first, end)` (`StageEntry.range`, `source.range` in the record). A
  run starts at its own first id. The ids of a program before it that
  does not run (marked or dropped) stay empty (the prelude fills them
  with gone objects), so a saved context's ids name the same objects in
  every rebuild. A re-run that takes other ids is marked. A record line
  from before 2026-10-30 has no range: it runs after the ranges before
  it, and it is marked when a marked program before it has no range
  either. The renderer gets each object's owner once per restore. Then
  it gets only the failures (`mcp.ts publishFailures`).
- **Restage.** A replace or cut reverts the affected scenes (one loop,
  newest first, from `sceneReverts`, the one owner of reverts) and runs
  the new program and the later ones. Its record lines are written only
  when it succeeds. A cancel or a failure rolls back as before step 3:
  the old programs run again with their saved inputs, and each node gets
  back its id and z, so the record still describes the board and no line
  is written. A replaced scene that is marked gets its items back as the
  revert took them (`putBack`). Learner work done meanwhile stays. A
  board change during a restage stops it, and the old board's record gets
  what that board got.
- **Replay after a restart re-runs the scene.** No play data is saved.
  A replay, a play from a step or a preview of a restored scene asks main
  to run the log again and sample that scene (`live-scene.ts resample`).
  The renderer compiles the run on the board as it was before the scene,
  from the recorded before-state (`run.ts sceneMemory`, `sceneAt` exact).
  Each node takes the board's id through the record: the object's key
  (`n:<name>[#k]` or `o:<n>`, given by the stage when the program makes
  the object) gives its nodes in `story.items`; an object brought back
  goes by its owner (`of`); nodes of no object go by their order of
  creation. The measures are applied, and nodes that differ from the
  record's signatures show as ghosts. A re-run that does not match the
  record marks the scene; the panel says "could not be rebuilt". The
  rebuilt play data stays in the player's history like the play data of
  a scene committed in this session. The frames of drafts and of that
  history share one budget (`run.ts trimScenes`, decision B30): an older
  finished scene gives up its play data and rebuilds at its next replay.
  What a replay or a preview needs stays until it is done, also over the
  budget (`scenePlayer.keepPlay`, `mcp.ts withPlayable`, decision B41), and
  the budget is checked again as soon as that ends (`onFree`, decision B47).
- **Errors.** A scene input works, draws nothing, or is an error with its
  line, also from parallel async functions and functions of moving objects;
  results carry no warnings (decision B18). An error at a moment that
  write_scene did not evaluate comes in the next tool result (T31).
- **Streaming** ([`streaming-scenes-plan.md`](streaming-scenes-plan.md),
  T27-T32). A draft's order: the program body, `end()`, seeds, the description,
  the reply, then the sweep. Seeds are a few moments of each dynamic object, and
  the end seed is the final state. The sweep is one forward pass, moment by
  moment, in 8 ms batches between the worker's messages, and in short batches
  with gaps while the pen is down or a scene waits in a pause (decision B32). Frame chunks
  (`shared/frames.ts`) add samples to objects in any order, and carry `through`
  and `end`. One `Producer` record in `SceneStage` lives from the reply to the
  sweep's terminal event, and the idle rebuild (T26) starts from that event.
  Work that needs the realm goes through `onRealm`, so no sweep wait stays in
  the stage lock. On the board, a job keeps `readyThrough`, and the scene clock
  (`timeOf`) never passes it (T28). A preview past it asks for its moments on
  the frames port, and the worker answers between two batches (T32). What the
  sweep finds later waits in `lateNotes` for the next tool result (T31). A
  scene with a world, and every run that is not a draft, drains before its
  reply, on the same code.

- **Main process.** `write_scene` and `play_scene` (`src/main/mcp.ts`) send
  the program to the board's stage (`live-scene.ts`, decision T18): one
  long-lived V8 realm in a Web Worker of the stage process, a hidden,
  sandboxed Chromium renderer with no window (`stage-process.ts`; the page
  `src/stage/page.ts`, the worker `src/stage/worker.ts`). The main process
  owns the drafts (one key for each draft version) and the stage epoch; the
  renderer only caches compiled drafts by key (decision B12). The stage process
  has its own in-memory session that serves only its page and scripts, with
  no network, no permissions, no navigation and cross-origin isolation; one
  MessagePort joins it to the main process, and both sides check every
  message (`src/shared/stage-protocol.ts`). The worker removes every global
  that is not ECMAScript before the sandbox API runs. The sandbox API is
  `src/stage/live-prelude.js` (creators, actions, values, `say`, `stage`,
  …); `Date` reads the scene clock and `Math.random` is seeded. Its
  `OPTION_NAMES` table lists the options of each scene global: a new option
  goes there. Only the program that `write_scene` drafts is checked (B24);
  a replay or a rebuild is not. The
  program returns a description (objects and a timeline,
  `src/shared/live-scene.ts`); it cannot reach the app, files or network.
  After the prelude has run, the stage is locked (decision T14): every
  object reachable from a global is frozen (the scene API, `JSON`, `Math`,
  the prototypes), every global is locked, only `stage` stays writable, and
  the prelude keeps its own references to the built-ins and gives its host
  functions to the worker directly (they are not globals). The worker's
  scheduler runs every pending job, then ends the earliest pending action,
  one task per action. Cancel ends the worker; a crash of the stage process
  starts a new one, and the stage is rebuilt from its log. A draft replies
  after its seeds, and its sweep then streams samples in batches to the board
  ([`streaming-scenes-plan.md`](streaming-scenes-plan.md)). Changing objects
  are sampled only where what their recipes read changes (values, object
  tracks, the camera); a recipe that reads the time, takes random numbers
  or changes the scene while it is sampled is sampled at every time.
  A program asks the board questions synchronously (the worker blocks with
  Atomics.wait while the stage page writes the answer into a shared
  buffer): text sizes, and through `sceneHost` html
  layout (`html()`, `image()`, copies of board material), empty space
  (`space()`) and an item's content (`copy()`), answered by
  `src/renderer/src/live/host.ts` (the HTML converter, image import into
  `assets/`, a hidden copy of the content layer for layout). Each program's
  answers are recorded in its stage log entry, so a rebuild of the stage,
  a cut or a replay gets the same answers.
  `storyboard.ts` builds preview images. `live-item-protocol.ts` serves the
  `live-item://` origin for worlds, with bundled libraries listed in
  `src/shared/live-libs.ts` (three.js, `ls/interact`).
- **Storage.** `src/main/storage.ts` cleans clips, code copies, records of gone boards, traces and caches, at folder open and at launch (T35).
- **Voice.** When the voice is on, `write_scene` first runs a lines pass that
  only collects the `say()` texts. Then, outside the stage lock,
  `src/main/voice.ts` makes one speech request for the scene, or finds the clip
  in `.learning-space/voice/`. In the draft run each `say()` asks main for its
  line (host request `voiceLine`, answered by main, not by `host.ts`), and the
  audio length becomes the line length. The answers stay in the record, so a
  replay makes no call. `src/renderer/src/live/voice.ts` sets one audio element
  from the player clock on each frame (T34, `voice-lines-plan.md`).
- **Renderer.** `src/renderer/src/live/` turns the description into board
  items and plays it: `run.ts` (requests from main), `compile.ts` (objects
  to nodes), `timeline.ts`, `player.ts` (the clock, the queue, pauses,
  replay), `measure.ts` (exact text bounds for the sandbox), `colors.ts`,
  `state.ts` (the store for the scene pill and the reading panel),
  `reading.ts` (what the panel and the pill show: the playing scene, the
  last scene, a selected item's scene and step; B19), `stories.ts` (the
  board's scene stories from the record and the map from each item to its
  scene and step),
  `host.ts` (the board's answers to the sandbox). Object kinds beyond
  drawing: `html` (material from html(): a root node and its subtree; drawn
  root first, then its parts one after another), `part` (one child of an
  html root, an object of its own), and the description's `edits` (text and
  style changes at a time; style values glide, `board/style-edits.ts`) and
  `reparents` (move into a frame; the item glides from its old place).
  `html()` with mode "replace": the replaced item stays as a ghost until
  the new material first shows (`ScenePlay.vanish`), and ink inside it moves
  onto the new material (a frame), or into the item's parent.
  `board/playback.ts` holds per-node playback looks (reveal, transform,
  params) that the board applies while a scene plays; the board file always
  holds the final state.
- **Worlds** (`live` nodes, mode `world`; decision P19): three.js 0.187.0 on
  `WebGLRenderer` (A9). One sandboxed iframe
  of the `live-item://` origin holds one worker with one WebGL renderer, and
  that worker draws all worlds of a board. The pictures show between the page
  content and the ink. The code is in `src/renderer/src/live-pixels/`
  (`registry.ts`, `LiveView.tsx`, `stills.ts`, `world/`). Network is open for
  worlds, and input reaches a world only in the mode it declares. An older
  item with another mode keeps its data and shows a note. Details:
  [`one-world-architecture.md`](one-world-architecture.md).
- **Requests** between main and renderer: `sceneContext`, `runScene`,
  `sceneDraft`, `sceneFrames`, `sceneControl`, `sceneRestore`,
  `sceneMemory` (`src/shared/space-api.ts`); the board window asks main
  to rebuild restored scenes with `rebuildScenes`.

## UI

- Components live in `src/renderer/src/components/` (the snapshot view in
  `src/renderer/src/snapshot/`).
- Shell: `src/renderer/src/App.tsx` (state and wiring), `TopBar.tsx`, `Sidebar.tsx`
  (`FileTree.tsx`), `ToolPalette.tsx`, `PreviewPanel.tsx`, `WelcomeCard.tsx`,
  `CanvasNotice.tsx`, `Toast.tsx`.
- Scenes: `ScenePill.tsx` (in `TopBar.tsx`; its menu lists the board's scenes) and `ScriptPanel.tsx` (the floating reading panel for one scene).
- Menus and popovers: `Menu.tsx`, `AgentPill.tsx`, `SetupMenu.tsx`,
  `GuideOverrideNote.tsx` — all built on the shared menu system.
- Styles: `styles/tokens.css` (all design tokens), `styles/app.css` (all app
  UI, including the menu system), `board/board.css`, `board/content.css`.
- Rules: [`design-system.md`](design-system.md).

## Development and automation

- `npm run dev` (relay build + `electron-vite dev`), `npm run build`
  (type-check, bundle, relay), `npm run build:mcpb`, `npm start`.
- `GEMINI_API_KEY` (any build, also read from `~/.learning-space/.env`) turns
  the voice on. Environment switches (dev): `SPACE_FOLDER` (open a folder),
  `SPACE_MCP_PORT`, `SPACE_REMOTE_DEBUG` (Chromium debug port + dev hooks),
  `SPACE_OPEN` (preview a file), `SPACE_CAPTURE*` (window PNG on load),
  `SPACE_CONNECT_DRY_RUN`, `SPACE_TRACE_DIR` (where traces go). The relay
  reads `LEARNING_SPACE_PORT`. Lab switches (lab runs only,
  `src/main/lab-switch.ts`): `LS_LAB_NO_CODE`, `LS_LAB_NO_HTML` (hide
  worlds or HTML from the agent), `LS_LAB_BRIEF` (serve a draft brief).
- `scripts/drive.mjs` drives a running dev app over the debug port: draw
  pen strokes, keys, clicks, drags, wheel, node rects, screenshots, state.
- `scripts/trace-report.mjs` summarises traces; `scripts/bench/run.mjs` runs
  the fixed agent scenarios (see [`baseline.md`](baseline.md)).
- `scripts/boards/make-demo-folder.mjs` makes a demo learning folder;
  `scripts/strokes/*.json` hold sample handwriting.
- Packaging (later) must ship `resources/` as extra resources and unpack
  `out/relay/` from the asar archive.
