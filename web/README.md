# Desktop learning workspace

React/TypeScript/Vite web client for the existing FastAPI Math Tutor. The UI
ports the current SwiftUI behavior; its visual reference is the Paper Desktop
product page `AI Whiteboard Tutor — Design System, Components & Page`, file
`01KZAH9BZ4FRZXKG2309B7SSRG`, page `1-0`. Swift feature and state code is the
behavioral source of truth. The Swift client and its data are preserved.

## Start locally

Requirements: Node 22.12+ (22), 24+, or 26+, Python 3.12+, the existing server `.venv`
(`cd server && uv sync`), and running Docker Desktop or Colima. Configure the
existing provider keys and `DEVICE_TOKEN` in `server/.env`.

From the repository root:

```sh
python3 scripts/web-dev.py
```

Open `http://127.0.0.1:5173` and enter the access code printed by the launcher.
The launcher creates ignored `.env.web` with a local access code and signing
secret. These persist between launches. It overrides the configured database
with local Postgres on port **55432**, database `mathtutor_web`, Docker volume
`math-tutor-web-data`; migrations run only against this local database. Provider
keys are read from `server/.env`, and normal tutor/voice use incurs API usage.
Ctrl-C stops the two servers; the database volume stays available for reopening
your work. `python3 scripts/web-dev.py --qa` substitutes dummy provider keys for
checks that should never call paid services.

For separate terminals, set the server's `WEB_BOOTSTRAP_CODE`,
`WEB_SESSION_SECRET`, `DATABASE_URL` and local allowed hosts, run its migrations
and launch FastAPI on 8080; run `npm ci && npm run dev` here. Vite proxies `/v1`
with the original host so browser cookies and mutation origin checks work.

## Work with the board

- Pen, highlighter, eraser and lasso are the learner-ink tools. Pen and
  highlighter accept tablet pressure; a mouse uses constant pressure. Color is
  selectable from the rail. Its thickness mark is a passive indicator; the
  current client uses a 5 px pen width and a 20 px highlighter width.
- Lasso selects learner ink only. Drag within a selected bound to move it; use
  Delete/Backspace to remove, or right-click the selection (Shift+F10 also
  opens the menu) for Cut, Copy, Paste, Duplicate and Delete. The board's
  internal clipboard preserves stroke points, pressure, timing, color and
  width for use in this open page. Cmd/Ctrl+Z undoes and Shift+Cmd/Ctrl+Z or
  Ctrl+Y redoes board edits. These shortcuts apply only while the board itself
  has focus; they leave the tutor composer and session menus alone. Escape
  clears an active lasso or board-region selection.
- Tutor capture uses a separate rectangular selection control beside the
  composer (or the collapsed board dock). Drag a rectangle over tutor content
  or learner ink, then send it with a prompt. This attaches a cropped board
  image; lasso never attaches a capture. The crop is recomputed after viewport
  resize and includes the selected scene and ink.
- Space+drag, middle-button drag or touch drag pans. Wheel/trackpad scroll pans;
  Ctrl/Cmd+wheel zooms around the pointer. The rail's center button fits the
  content. Moving or zooming changes the camera without moving the session to
  the top of the session list.
- The board renders the typed tutor scene, including math, SVG, images and
  geometry. Tutor turns receive an overview image, and requested percentage
  crops use the board's logical content bounds. A board-region capture and an
  overview include both the tutor scene and learner ink.
- The tutor can be docked beside the board, collapsed to the floating dock, or
  expanded full-screen. Full-screen keeps the same board mounted behind the
  return-to-board peek; the peek is a navigation control, not an interactive
  board surface. Sessions are available in the docked drawer or full-screen
  sidebar. New session preserves existing sessions; Reset in Settings removes
  the active session and starts a fresh one. The app restores the last-opened
  session after reopening. Settings chooses a backend-supported model and
  reasoning effort.
- There is no board-overlay Clear or Check Work button. Delete/Cut act on the
  selected learner ink; Reset removes the whole active session. Sending a
  selected board capture uses the tutor's evaluation path. The tutor's exercise
  and “I don't understand this” suggestions remain in the conversation flow.
- Send text, attach supported files/images, or dictate into the composer.
  Assistant replies render Markdown/math; learner text stays literal. Edit a
  learner message to replace the following conversation. Sources, activity,
  plans, exercises and memory use the existing tutor backend.
- Voice uses GPT-Live 1 over WebRTC. Captions, mute, rest/wake and ending a call
  are available. Calls remain bound to their originating session when browsing
  another board. Rest closes the provider connection; wake opens a fresh one
  with saved conversation context. While a call is awake, typed text still goes
  through the ordinary tutor turn and its reply is saved in the transcript;
  the text is mirrored to Live as quiet context and the reply as bounded
  commentary. Live speech playback of that reply has not been verified. Files
  and board captures stay in the draft during this typed path and can be sent
  with a later ordinary tutor turn.

## Persistence and architecture

`src/main.tsx` integrates API events, session state and board callbacks.
`board/` renders portable ink over the tutor scene; `workspace/` keeps an
IndexedDB save journal and revision-checked server snapshots. New edits survive
offline periods; acknowledgments never replace newer edits. Keep the same
browser origin to retain local work. Server snapshots make web sessions
available in another authenticated browser. This is a single-learner private
workspace; public sharing and multi-user accounts are separate work.

`voice/` owns WebRTC and the Live event protocol. FastAPI exchanges the SDP
without exposing the provider key. Client delegation runs the existing
`POST /v1/turn` tool loop with the call's originating session and board, then
sends the tutor reply to Live as a bounded commentary event. Typed composer
turns use the same tutor endpoint, mirror typed text as quiet Live context, and
mirror the saved reply as commentary. The browser smoke verified transport
setup and teardown, not audible playback. This is browser-owned: keeping the
page open is required for tutor work and board inspection. One backend process
is required by the existing in-process board rendezvous. Durable
background/deep-research jobs and a server-side Live worker are follow-up
architecture work.

Old iPad handwriting is a PencilKit archive and is not editable browser ink.
Existing server transcripts can be reopened, but importing old local iPad
boards requires a later exporter. Actual tablet pressure/eraser behavior and
pen latency require verification with the user's tablet/driver.

## Checks and preview

```sh
npm run build
npm test
npm audit
```

The focused board, capture, and workspace persistence checks can also be run
with `npx vitest run src/board src/workspace/store.test.ts --reporter=dot` from
this directory.

To serve a built client on the API origin, run `npm run build`, set the server's
`WEB_DIST_DIR` to the absolute `web/dist` directory, configure its browser auth
and allowed host, and start FastAPI. Remote hosting requires HTTPS for audio and
`WEB_SESSION_SECURE=true`. No deployment or production migration is included in
this branch. ChatGPT/OpenAI Sites is prohibited for this repository.
