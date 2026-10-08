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

## Swift port integration QA — 2026-10-08

This pass used a separate Playwright CLI browser against `http://127.0.0.1:5173/`.
The upload and tutor-turn responses were fixtures, and `/v1/sessions/*/close` was
mocked to return 204 for the synthetic sessions. The fake transcript never reached
the provider. Shell reference-size evidence at 1376 × 1032 is also recorded in
`SHELL_PARITY.md`; the measurements below were repeated independently.

### Browser verified

- At 1280 × 720, full-screen with the sidebar open measured a 275px reserved sidebar,
  tutor surface x=275/w=1005, and composer x=477.5/y=642/w=600/h=50. Resizing from
  390px with the sidebar open retained the open state and restored this reserved lane.
- At 390 × 844, the sidebar switches to a 244px overlay and leaves the tutor/composer
  at 244px wide (composer x=73). Escape dismisses it; the visible sidebar control
  reopens it. Evidence: `output/playwright/parity-390-fullscreen-sidebar.png` and
  `output/playwright/parity-1280-fullscreen-sidebar.png`.
- Docked resizing at 1280px reached the 260px minimum and the derived 904px maximum,
  leaving the board at its 200px minimum. Double-click restored the 337px default.
  At 700px the lane clamped to the 324px maximum; returning to 1280px restored 337px.
- The mocked attachment uploader returned an attachment chip. Draft text and that
  chip stayed with session A while switching to session B; B kept its own draft and
  no attachment. This verifies session-switch isolation, not unsent-draft survival
  across a full browser reload. The fixture did not include thumbnail bytes, so no
  thumbnail rendering claim is made.
- A mocked SSE turn rendered its learner message and tutor answer. Canceling edit
  restored the original exchange; an accepted edited resend replaced the prior
  learner prompt; a mocked 503 rejection retained the original exchange and kept the
  attempted edit available. The rejection message and single 503 network error were
  expected fixture behavior. Post-acceptance cancellation during a partially
  delivered stream was not exercised in this browser pass.
- Board interaction checks recorded with the board work: lasso remained separate
  from tutor crop selection; lasso Cut/Copy/Paste/Duplicate/Delete and one-step
  undo/redo worked; Cmd/Ctrl+Z did not mutate ink while a session menu owned focus
  or while the board was hidden under full-screen tutor. The fixture crop and source
  disclosure paths were covered by component tests, not a real-provider turn.
- After reload, the browser reported zero console errors and warnings. Network calls
  used by this pass returned the expected local or fixture responses.

### Source and fixture coverage, not browser-proven

The 74 frontend tests cover board geometry/history/clipboard and media/workspace
persistence, five-line session drafts, message activity/refinement and voice event
state. They do not establish a human microphone path or spoken quality. The separate
silent-track Live smoke is documented in `TUTOR_PARITY.md`; it verified the current
web GPT Live transport lifecycle only. Swift's `/v1/realtime/*` signaling contract
and model selection differ from this web client's `/v1/live/*` contract, so realtime
protocol parity is not claimed. No physical tablet pressure, Apple Pencil prediction,
headset routing, echo behavior, or spoken interruption/correction was tested.

The Swift app persists learner ink as opaque serialized `PKDrawing` data. The web
board stores editable vector strokes and scene elements, and no importer or verified
conversion path for existing PencilKit archives was found. Existing Swift learner
ink therefore remains a migration gap. Media IndexedDB persistence and crop-ID
reload isolation are covered by source/tests but were not exercised end-to-end with
thumbnail-bearing uploads in this pass. A browser reload also resets the tool to Pen;
tool-selection persistence was not claimed.

### Final frontend validation

- `npm test`: **15 files / 74 tests passed**.
- `npm run build`: passed (`tsc -b` and Vite production build). Vite retains the
  existing warning that the main JavaScript chunk exceeds 500 kB.
