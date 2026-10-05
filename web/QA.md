# Initial web verification — 2026-10-05

Branch: `codex/web-client`. Tests used an isolated localhost Postgres database;
no production migration or deployment was performed.

- Full backend suite: **1,210 passed, 1 skipped** (27 existing dependency/schema
  warnings). Focused web auth/session/workspace/Live coverage passed.
- Frontend: TypeScript/Vite production build passed; **30 tests passed** across
  six files. `npm audit` reported zero vulnerabilities. Vite reports a large
  JavaScript chunk; bundle splitting remains a performance follow-up.
- Chrome interaction: one mouse stroke with 16 samples saved to IndexedDB and
  server revision 2; reopening restored editable data and visible ink.
- Lasso browser check selected two learner strokes while excluding a third,
  moved both by +40/+30 logical coordinates, undid the move as one operation,
  and deleted the selected ink while preserving the outside stroke. Geometry
  tests cover intersecting strokes and immutable movement snapshots. Pointer
  cancellation restores the original ink rather than saving a partial move.
- Streamed fixture turn: tutor board updates, inspection callback, plan,
  exercise, sources, activity and Markdown/math rendered. Learner punctuation
  and line breaks stayed literal. An 80% region inspection produced a 16,040
  character base64 PNG without a capture error.
- Actual Board ref fixture: all 16 scene kinds plus learner pen/highlighter;
  full PNG decoded at 999×176, 40%-by-50% crop at 400×88. Context and percentage
  crop used the same logical bounds. Authenticated blob loading was stubbed in
  this fixture. Native wheel handling prevented the default browser action.
- KaTeX exports were also compared visually with live browser math for square
  roots, underbraces/subscripts and over-arrows. Inline SVG glyphs and rules
  are preserved in the export. Ten wheel events produce one persisted camera
  update after scrolling stops.
- Real configured OpenAI text endpoint: a short greeting streamed successfully
  through `/v1/turn`, with a completed recorded turn and clean workspace save.
- Real GPT-Live endpoint: WebRTC signaling returned provider HTTP 201; the
  actual client class transitioned `connecting → live → closing → idle` with
  no errors, and the final usage POST returned 204. Input was a synthetic silent
  WebAudio track; no human microphone was recorded. This verifies connection
  lifecycle, not spoken tutoring quality or overlapping conversational speech.
- Paper-derived shell reviewed in Chrome at 1280×720 and 1376×1032, including
  sessions, settings and tutor presentation controls.

Required hands-on checks remain: the user's drawing-tablet pressure/inverted
eraser, handwriting latency, microphone/headset permissions and echo behavior,
spoken Live delegation and interruption/correction during board work. Deep background
research, public sharing/accounts, and importing PencilKit handwriting remain
follow-up scope.
