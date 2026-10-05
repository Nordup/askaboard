# Desktop web client: implementation plan

Status: initial web client implemented on `codex/web-client`. This document records the architecture and remaining acceptance checks; [web/README.md](../../../web/README.md) describes delivered behavior and [web/QA.md](../../../web/QA.md) records verification and limits.

Implementation authorized 2026-10-05. Design requirement: all UI agents must directly read and copy the existing Paper Desktop design through the Paper MCP, using JSX/computed styles/tokens for exact values. Do not invent a new design, components, palette, typography, or layout direction. Only necessary desktop interaction and responsive layout adaptations are allowed; record their rationale. Live Paper file: `AI Whiteboard Tutor — Design System, Components & Page`, file `01KZAH9BZ4FRZXKG2309B7SSRG`, product page `1-0`. Existing exports are supplemental, not a substitute for reading Paper. Read Paper's guide before its other tools. Do not edit the source design file unless requested.

Branch: `codex/web-client`. Date: 2026-10-05.

## Intent and boundaries

Build a web-first personal learning workspace for the founder's upcoming study and job preparation. Preserve the shared board, conversational tutor, memory, visual explanations, and live voice experience. Start from the iPad's visual identity and functionality, adapting navigation and interaction to a desktop with a drawing tablet. Mouse drawing is a usable fallback.

Pause iPad development. Do not modify Swift sources, Apple project files, or PencilKit archives. Backend evolution is allowed; retain existing routes where inexpensive, without requiring simultaneous iPad feature parity. A later iPad port can adopt the improved backend and portable workspace schema.

Use GPT-6 Luna for bounded implementation and testing tasks. The primary agent owns contracts, architecture, integration, and review. Keep the implementation local/private. Never use ChatGPT/OpenAI Sites tools or the existing marketing site's Sites configuration. Public sharing, multi-user accounts, and commercial rollout are subsequent work.

## Existing building blocks

- `server/app/api/turn.py`: `POST /v1/turn` streams application-level SSE; browser implements streaming `fetch`, because this is a POST with request data.
- `server/app/tutor/events.py`: status, reasoning/text deltas, workspace, board updates/requests, research sources, activity steps, done/error.
- `server/app/api/sessions.py` and `store/recorder.py`: persisted transcript, turn metadata, attachments and traces. These do not constitute a complete editable whiteboard save.
- `server/app/tutor/board_scene.py` and `MathTutor/Domain/BoardScene.swift`: reusable tutor scene schema and ordered element updates. Support every existing kind, including SVG, images, math, ink text, shapes and annotations.
- `server/app/tutor/rendezvous.py`: client-rendered `view_board` callbacks. Keep a single backend worker initially; the rendezvous is process-local.
- `server/app/tutor/loop.py`: preserve delivered inspection before drawing, inspection between edits, overlap checks and mandatory review after edits.
- `server/app/api/realtime.py`: existing Realtime signaling and usage, not the new GPT-Live protocol. Add a distinct Live integration rather than changing its model string.
- `design/tokens.json`, `design/icons.json`, and `docs/design-system/`: visual foundation. Existing fixed iPad geometry becomes responsive desktop layout.
- `docs/langsmith-langgraph-migration.md`: LangSmith instrumentation/evaluations exist; LangGraph migration remains planned. Keep the current tutor loop for the first web release.

`landing-page/` is a marketing site, not the tutor product. Create a separate `web/` application.

## Proposed frontend architecture

Use React + TypeScript + Vite for a browser workspace with fast local iteration. This is a recommendation for the new client, not a claim that the existing marketing framework is inadequate. Match dependency versions to the installed runtime at implementation time. Avoid adding a second backend orchestration stack to the frontend.

Proposed module ownership:

| Module | Responsibility |
| --- | --- |
| `web/src/api/` | Typed API calls, streaming decoder, auth/session lifecycle, attachments and blobs |
| `web/src/workspace/` | Workspace types/store, save journal, server sync and session transitions |
| `web/src/board/` | Scene renderer, portable ink, camera, tools, capture and board-request replies |
| `web/src/tutor/` | Chat, composer, workspace plan/exercise, activity, sources and settings |
| `web/src/voice/` | WebRTC lifecycle, captions, call UI and Live event adaptation |
| `web/src/design/` | CSS tokens, icons, typography and desktop shell primitives |

Keep pointer samples and camera motion outside React's whole-workspace update path. Render at animation-frame cadence. Commit semantic changes to the store at stroke/operation boundaries; debounce workspace saves. Share one camera transform and one rendering contract between visible content and exported captures.

For the initial board, use a vector tutor scene layer (SVG and carefully bounded HTML/math content) with a Canvas learner ink layer and separate selection overlay. Preserve vector stroke data; rasterize only for display/capture, never as the editable source. Cache rendered completed ink and redraw changed areas; do not replay the entire board on every pointer sample. Validate this choice against the dense-board fixture before adding WebGL, workers, or another renderer.

Use Markdown and a math renderer that passes `docs/math-rendering-coverage.md` fixtures; KaTeX is a candidate, not an assumed full replacement for every Swift math extension. Preserve code fences and learner literal text. Sanitize tutor-provided SVG/HTML, disallow active content and external resource loading, and resolve images through authenticated backend blobs. Snapshot export must capture the same layout and layers the learner sees, including fonts, math and images.

## Workspace state and persistence

Introduce versioned portable learner ink: stroke IDs, tool, color, board-space width, points with pressure/time and optional tilt. Store width in logical board coordinates; mouse uses constant pressure. Keep ink distinct from tutor-authored scene objects and use operation history for undo/redo and selection edits.

Add backend workspace create/read/save support, preferably under `/v1/sessions/{id}/workspace`, with explicit session creation for an empty board. Save ink, scene, camera, plan/exercise and client settings. Separate editable workspace state from transcript/turn recording. Include a revision and conditional updates to prevent a stale autosave or second browser tab from overwriting newer content. Keep camera-only saves from changing substantive session ordering.

IndexedDB supplies a local save journal and immediate reopen while the server is unavailable. Surface pending/failed sync and preserve unsent edits. Flush saves on session switch and persist locally on page lifecycle changes; do not depend on a network request during tab close. Server save acknowledgments must not replace newer local state.

Existing iPad `drawingData` is a PKDrawing archive, not browser-readable ink. New web sessions must be fully editable and durable. Preserve old data. Import existing transcripts/scenes where available, but do not promise editable old handwriting without an Apple-side exporter. Decide later whether old boards need a snapshot import or dedicated conversion; no Swift changes are required for the first delivery.

## Desktop interaction and parity

Retain board plus resizable tutor panel, collapsed voice dock, chat-focused mode, sessions, settings and the established restrained palette/type/icon treatment. Add explicit controls and shortcuts for transitions currently driven by swipes. Keep animations short, interruptible and compatible with reduced motion.

Drawing uses Pointer Events, pointer capture and coalesced samples where available. Pen pressure/eraser detection depends on the tablet driver and browser; provide stable fallbacks. Default navigation: hand tool or Space+drag to pan, wheel/trackpad pan, cursor-centered modified-wheel zoom, fit-to-work button. Bind shortcuts only when a text field is not editing; avoid overriding normal browser shortcuts unnecessarily.

Parity checklist: pen/highlighter/eraser/lasso, palette/widths, undo/redo/clear, region capture and full-board evaluation, image/SVG/math scene content, new/rename/delete/reopen sessions, text streaming and visible errors, edit/resend, file/image attachments, dictation, plan/exercise, research sources/activity, personal memory, tutor model/reasoning settings, voice captions/mute/rest/wake, and a call bound to its originating session while browsing other sessions. Audit the existing UI and routes while implementing each item; never count a nonfunctional control as parity.

## Browser connectivity and GPT-Live 1

Use same-origin browser APIs: Vite proxies to the development FastAPI server; the local/production server serves the built web app and `/v1` together. This avoids requiring cross-origin access for the default path. If a separate origin is later needed, add a strict configurable CORS allowlist.

Replace compiled-device credential handling with a browser session cookie: bootstrap local access with a configurable private access code supplied outside the JS bundle, then issue an HttpOnly/SameSite session with expiry. Validate Origin/CSRF for mutations. Keep the existing bearer path for the frozen iPad client. OpenAI keys and long-lived device credentials remain server-side. Local backend development is the default; do not change production during implementation without a concrete rollout decision.

Add `/v1/live/...` application endpoints and a server-side Live adapter. Browser audio uses WebRTC; FastAPI exchanges SDP using `POST /v1/live/sessions` upstream with `model: gpt-live-1` and client delegation. Wait for `session.started`. Keep the old Realtime integration available as a distinct path.

The first implementation handles Live delegation in the browser and routes it through the existing HTTP `/v1/turn` service, preserving recording, memory, tool policy and board callbacks. This keeps one working orchestration path and requires the browser to remain open. A server sideband/shared turn service remains follow-up work for durable background execution; it is not part of the delivered client.

Important protocol differences: `session.delegation.created` provides an ID and timestamp, not utterance text. Maintain accumulated input/output transcripts and current session/board context. Send board images to the vision-capable backend; the Live voice frontend does not accept images. Return verified short results using `session.commentary.append` and quiet context with `session.thinking.append`. Retain the delegation ID and task revision, deduplicate events, serialize conflicting mutations, and ignore superseded results. Speech interruption must not silently cancel or duplicate backend work.

Preserve rest/wake as an application lifecycle policy rather than assuming the old `step_back` tool or Realtime VAD events carry over. Close idle calls explicitly and finalize usage. Live is billed by duration, per second, rather than the old token-based Realtime usage assumptions; active quiet/rest periods need explicit cost handling. Add duration metering and adapt spend limits. Subscription limits for development agents and app API usage are separate concerns.

## Delivery sequence and agent coordination

1. **Contracts and feasibility:** freeze workspace/ink/event types and fixtures; connect browser text turn; prove tablet samples, combined board capture, and one real Live session/delegation. These are the highest-risk seams.
2. **Usable learning loop:** new session, pen writing, pan/zoom, chat, tutor-rendered board, inspection callbacks, autosave and reopen. Attachments, memory and model settings reuse existing backend behavior.
3. **Voice and complete parity:** integrate Live into the same session, transcript and board flows; complete selection/eraser/history, dictation, edit/resend, sources/activity, plans, session actions, rest/wake and call/session switching.
4. **Personal-use verification and UI iteration:** dense visual fixtures, real drawing tablet/headset session, refresh/disconnect recovery, then adjust layout and interactions based on actual study use.
5. **Heavier workflows:** durable cancellable research jobs, reconnectable progress/events and larger visual outputs. Introduce a shared render broker or server renderer before multi-worker/background board work; migrate orchestration only against behavior/evaluation parity. Public sharing/accounts follow a separate scope decision.

With four total agent slots, run up to three GPT-6 Luna workers: board; shell/chat/API UI; backend/persistence/Live. Freeze shared interfaces first, give each explicit file ownership, and avoid simultaneous edits to shared store/types. Assign a separate QA pass by reusing a freed worker. Workers receive short task briefs and fixtures, not the entire conversation; request concise outcomes. The primary agent integrates each working slice and resolves contract changes before widening scope.

## Acceptance and verification

Use meaningful geometry/serialization and event tests; backend endpoint/auth/persistence tests; browser interaction tests; visual inspection against design references. Keep API-backed smoke tests small and record their outcomes separately from mocked tests.

Release gate: write an exercise using the real tablet, discuss it through Live while still writing, receive tutor edits, verify inspect-before/after behavior, interrupt/correct a request, switch sessions without misrouting the call, refresh and restore the exact editable board/transcript/camera. Verify all scene kinds, authenticated images, and selected-region/overview captures after pan/zoom. Test network loss, stale save rejection, canceled pointers, permission denial and incomplete voice finalization. Check a dense board while streaming voice/chat for input responsiveness.

Synthetic pointer tests cannot certify real driver pressure or subjective pen latency. Live success means both backend state and audible result were verified. A one-day goal is a useful integrated first version; full parity, hardware feel and durable deep research must be tracked separately rather than promised before verification.

## Sources and open details

Primary repository sources are linked above. Official references checked on 2026-10-05:

- [GPT-Live overview](https://developers.openai.com/api/docs/guides/live)
- [Client delegation and visual context](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client)
- [Live browser WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)
- [Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)
- [Vite](https://vite.dev/guide/)
- [KaTeX coverage](https://katex.org/docs/supported.html)

Optional founder details requested: primary computer/browser, drawing tablet model and headset usage. Default to desktop Chromium for the initial feasibility pass until specified. API project access and actual pen input require local verification during implementation. Old iPad handwriting migration and public sharing are not prerequisites for new web study sessions.
