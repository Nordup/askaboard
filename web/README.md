# Desktop learning workspace

React/TypeScript/Vite web client for the existing FastAPI Math Tutor. The UI
copies the live Paper Desktop product page: `AI Whiteboard Tutor — Design
System, Components & Page`, file `01KZAH9BZ4FRZXKG2309B7SSRG`, page `1-0`.
The Swift client and its data are preserved.

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

- Pen and highlighter accept Pointer Events and tablet pressure; mouse uses
  constant pressure. Choose color and width in the Paper tool rail.
- Eraser removes learner strokes. Lasso selects ink and attaches its region to
  a question. Drag inside the selection to move it; Delete/Backspace removes
  selected ink when the board has focus, and Escape clears the selection.
  Undo/Redo restores selection moves and deletions.
- Space+drag or middle-button drag pans. Wheel/trackpad scroll pans; Ctrl/Cmd+
  wheel zooms around the pointer. The rail's center button fits the content.
- Undo/Redo affect learner ink in the open board. Clear removes ink and tutor
  scene after confirmation. Check work sends a combined board capture.
- The tutor can render and inspect the same board through the existing scene
  tools, including math, SVG, images and geometry. A small overview accompanies
  turns; requested percentage crops use its logical bounds.
- Header controls dock, collapse or expand the tutor. Drag the panel divider
  to resize. Sessions supports new, rename, delete and reopen; Settings chooses
  the backend's supported model and reasoning effort.
- Send text, attach supported files/images, or dictate into the composer.
  Assistant replies render Markdown/math; learner text stays literal. Edit a
  learner message to replace the following conversation. Sources, activity,
  plans, exercises and memory use the existing tutor backend.
- Voice uses GPT-Live 1 over WebRTC. Captions, mute, rest/wake and ending a call
  are available. Calls remain bound to their originating session when browsing
  another board. Rest closes the provider connection; wake opens a fresh one
  with saved conversation context. End a bound call before sending typed work
  in its conversation.

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
`POST /v1/turn` tool loop with this session's board and returns short verified
commentary to Live. It is browser-owned: keeping the page open is required for
tutor work and board inspection. One backend process is required by the existing
in-process board rendezvous. Durable background/deep-research jobs and a
server-side Live worker are follow-up architecture work.

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

To serve a built client on the API origin, run `npm run build`, set the server's
`WEB_DIST_DIR` to the absolute `web/dist` directory, configure its browser auth
and allowed host, and start FastAPI. Remote hosting requires HTTPS for audio and
`WEB_SESSION_SECURE=true`. No deployment or production migration is included in
this branch. ChatGPT/OpenAI Sites is prohibited for this repository.
