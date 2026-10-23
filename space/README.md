# Learning Space

A desktop app (Electron) with no AI inside. It gives the learner a shared canvas
and a local learning folder. External agents (Codex, Claude Code) connect to it
over MCP in a later step. Read [`../docs/learning-space/idea.md`](../docs/learning-space/idea.md)
and [`../docs/learning-space/plan.md`](../docs/learning-space/plan.md).

Step 1: open a learning folder, keep many boards in it, and draw real ink
(pen, highlighter, stroke eraser, lasso select, undo/redo, pan and zoom).
A board is any `*.board.json` file in the folder; new boards go to `boards/`.
The app autosaves 400 ms after a change and reloads a board when another
program (Git, an agent) changes it on disk.

## Run

```sh
cd space
npm install      # postinstall downloads the Electron binary
npm run dev      # electron-vite dev server + app window
npm run build    # type-check main/preload and renderer, then bundle to out/
npm start        # run the built app from out/
```

## Layout

| Path | What |
| --- | --- |
| `src/main/` | Electron main process: window, menu, dev hooks, folder access (`folder.ts`), `state.json` (`state.ts`) |
| `src/preload/` | Sandboxed preload; exposes `window.space` |
| `src/shared/space-api.ts` | The `window.space` type and IPC channel names, shared by both sides |
| `src/shared/board-format.ts` | Board file parse/serialize (one item per line), seq stamping |
| `src/renderer/src/board/` | Ink board, ported from `web/src/board/` |
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

Example:

```sh
SPACE_FOLDER=~/learn/orbits SPACE_OPEN=notes/kepler.md \
  SPACE_CAPTURE=/tmp/space.png SPACE_CAPTURE_QUIT=1 npm run dev
```

App state (last folder, recent folders, the camera per board) lives in
`~/Library/Application Support/Learning Space/state.json`, not in the board
files, so panning never changes a file that Git tracks.

The capture has the window's real size. On a small screen macOS shrinks the
1440×900 default to fit.
