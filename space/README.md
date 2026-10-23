# Learning Space

A desktop app (Electron) with no AI inside. It gives the learner a shared canvas
and a local learning folder. External agents (Codex, Claude Code) connect to it
over MCP in a later step. Read [`../docs/learning-space/idea.md`](../docs/learning-space/idea.md)
and [`../docs/learning-space/plan.md`](../docs/learning-space/plan.md).

Step 0 is the dark shell only: sidebar, top bar, dotted canvas, tool palette,
welcome card. Nothing draws yet.

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
| `src/main/` | Electron main process: window, dev hooks |
| `src/preload/` | Sandboxed preload; exposes `window.space` |
| `src/shared/space-api.ts` | The `window.space` type and IPC channel names, shared by both sides |
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
| `SPACE_FOLDER=/abs/dir` | Step 1: open this learning folder at launch. Step 0 only logs the value. |

Example:

```sh
SPACE_CAPTURE=/tmp/space.png SPACE_CAPTURE_QUIT=1 npm run dev
```

The capture has the window's real size. On a small screen macOS shrinks the
1440×900 default to fit.
