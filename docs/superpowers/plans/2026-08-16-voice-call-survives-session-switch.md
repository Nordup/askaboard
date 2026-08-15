# Voice Call Survives Session Switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live voice call keeps running while the learner browses other sessions; a floating pill marks it and taps back to it; starting voice elsewhere ends the old call first; the call session's server close is deferred until the call ends.

**Architecture:** The call binds to its session ("the call session") for its whole life. `VoiceSessionHost` already survives session switches (one `BoardScreen`, `@StateObject` for the screen's life) — the work is to stop the switch path from ending the call and closing the call session, to keep delegated turns landing in the call session while another session is visible, and to add the pill overlay.

**Why (measured, 2026-08-16):** an accidental session switch tonight killed a resting call and closed the session mid-call — consolidation froze the window mid-conversation and the restart billed a cold cache prefix. The learner's stated pattern: start voice, then wander between sessions to look things up.

**Decided by the founder (2026-08-16):** mic STAYS LIVE while wandering — it behaves like a phone call. step_back and mute cover quiet. One call at a time, app-wide.

**Design source (Paper, extracted 2026-08-16):** file `01KZAH9BZ4FRZXKG2309B7SSRG`, board `32 — Voice · call pill · away from session`:
- Pill: capsule, `background: --color-surface`, `border-radius: full`, `box-shadow: 0 2px 12px rgba(20,20,50,0.12), 0 0 0 1px rgba(20,20,50,0.04)`, padding `8 18 8 12`, gap `10`, floating top-center of the canvas area at y=36.
- Mini mascot slot 40×32: face 30×24 (gradient `#1A1E33 → #0C0E17`, full radius), eyes 4×4 white, gap 7, soft violet halo (`rgba(150,130,245,0.55) → transparent`). Prefer rendering the existing `VoiceMascotView` at a small scale over a bespoke mini — the phases (listening/talking/resting ring) then work for free; the board's mini is the target look at rest.
- Label: `Voice · <call session title>`, 15/18 semibold, `--color-ink`.

## Global Constraints

- Work on `main`, in place. No branches, no worktrees.
- Shared tree with concurrent sessions (cost recording; transcript-404 fix). **Re-read every file immediately before editing.** Never `git checkout`/restore anything. Never commit or push.
- Never run `xcodebuild test`; build (and `build-for-testing`) only, after `pgrep -fl xcodebuild` shows no user build. Never launch the simulator or use computer-use tools.
- New Swift files require `xcodegen generate`; no duplicate basenames.
- Server: no changes. The 30-minute quiet sweep already backstops a close that never arrives.
- Voice prompt/register/tools: unchanged.

---

### Task 1: The call remembers its session; the switch stops killing it

**Files:**
- Modify: `MathTutor/Features/Voice/VoiceBar.swift` (`VoiceSessionHost`)
- Modify: `MathTutor/Features/Board/BoardScreen.swift` (the session-switch path — find where a switch currently reaches `voice.finish()` or reinstalls hooks)
- Modify: `MathTutor/TutorStore.swift` (the three `endSessionOnServer` callers, around line 1038)

**Interfaces:**
- Produces: `VoiceSessionHost.callSessionID: UUID?` (`@Published`, nil when no call) and `VoiceSessionHost.callSessionTitle: String` for the pill. `TutorStore` (or the host) gains the deferred-close bookkeeping below.

**Behavior contract (test each row where a pure seam exists):**

| Event | Call | Server close of outgoing session |
|---|---|---|
| Switch away from call session, call live | keeps running | DEFERRED (remember the id) |
| Switch away, no call live | — | sent, as today |
| Call ends while its session is not visible | — | send the deferred close now |
| Call ends while its session is visible again | — | no close (the learner is in it) |
| Learner returns to the call session, later switches away again without call | — | normal close on that later switch |
| App killed mid-call | dies with app | server sweep closes it whole |

- [ ] **Step 1:** `VoiceSessionHost.begin` records `callSessionID`/`callSessionTitle`; `finish()` and the failed-start fold clear them, and on clearing, fire a `onCallEnded(sessionID:)` callback the store uses for the deferred close.
- [ ] **Step 2:** In the switch path, replace the unconditional call teardown with: if a call is live and belongs to the outgoing session, keep it; suppress `endSessionOnServer` for that session and remember it as deferred. The suppression composes with the existing `turnWasInFlight` guard (a deferred close that lands later is exactly the "later and whole" the comment there wants).
- [ ] **Step 3:** Deferred-close tests as a pure decision table if the logic can live in a small struct (`DeferredSessionClose`): feed it the six rows above.

### Task 2: Delegated turns keep landing in the call session while another is visible

**Files:**
- Modify: `MathTutor/Features/Board/BoardScreen.swift` (where `VoiceSessionHooks` is built)
- Modify: `MathTutor/TutorStore.swift` (the turn pipeline the hooks call)

This is the hard task. Today `runTutorTurn` runs "the store's current session" turn; after a switch that would drop a voice turn into the WRONG session. Requirements:

- A delegated turn always runs against the **call session**: its thread, its recording, its memory, its transcript sync.
- **Board snapshot discipline:** the board a delegated turn sees must be the CALL session's board, never the visible one. While the learner is away, use the call session's last-known/persisted board state; the learner is not drawing on it while away, so staleness is not a problem. Trace how the hooks capture the snapshot today and pin the source to the call session.
- Board mutations from the worker (`update_board`, `set_workspace`) apply to the call session's stored board. If they currently write "the visible board", route them by session id. When the learner returns, the call session's screen shows the updated board (the normal load path may already give this — verify rather than assume).
- Thread updates for a non-visible session must not corrupt the visible thread. If the streaming path writes into a shared "current thread" model, scope it by session id; it is acceptable for the away-thread to update only in the stored/thread-cache layer and appear complete when the learner returns.
- The in-flight-turn cancellation that the switch performs today must NOT cancel a voice-delegated turn for the call session.

Pick the smallest mechanism that satisfies these — pinning session id through the existing pipeline is preferred over building a parallel store. Add tests where the routing decision is pure; document what only the device can verify.

### Task 3: The call pill

**Files:**
- Create (or extend an existing overlay site in `MathTutor/App/RootView.swift` / the screen chrome): `MathTutor/Features/Voice/CallPill.swift` — then `xcodegen generate`
- Modify: `MathTutor/Features/Board/BoardScreen.swift` (overlay + visibility)

**Behavior:**
- Visible exactly when a call is live AND the visible session ≠ `callSessionID`. Never during dictation overlays or when no call.
- Content per the design source above; the mascot inside mirrors the live `VoiceDisplayProvider` phases (a resting call shows the thin ring — the pill is where the learner sees "still resting" from far away).
- Tap → switch to the call session through the same path the sessions drawer uses (so all existing switch bookkeeping runs); the pill disappears because the visibility condition flips.
- Position: floating top-center over the canvas area, y=36, above board chrome; it must not intercept touches outside its capsule.
- VoiceOver: a button, label "Return to voice call in <session title>".
- Add a preview driven by `ScriptedVoiceEngine`.

### Task 4: Starting voice in another session ends the old call first

**Files:**
- Modify: `MathTutor/Features/Voice/VoiceBar.swift` / the voice-disc tap site

- [ ] The voice disc's tap, when a call is live in ANOTHER session: `await finish()` (normal teardown — usage reported, transcripts settled, deferred close of the old call session fires per Task 1), then `begin` for the new session. No confirmation dialog. Same-session tap keeps today's behavior.

### Task 5: Verification

- [ ] Server tests untouched (no server changes). Device-pure tests from Tasks 1–3 in a new test file if `VoiceEngineTests.swift` is still concurrently edited (check `git status` at edit time).
- [ ] `pgrep -fl xcodebuild` first; then build and `build-for-testing`. Fix compile errors. NEVER `xcodebuild test`.
- [ ] Device-only items to hand back: call surviving a real session switch; pill tap-back mid-call; board updates landing in the away session; audio continuity through the switch (`RTCAudioSession` must not be touched by the switch path — if it is, that is a finding to report, not to fix blind).

## Self-Review

- Coverage: survive-switch + deferred close (T1), turn routing + board discipline (T2), pill (T3), one-call-at-a-time (T4), verification (T5). Mic-stays-live needs no change — nothing in the switch path touches the mute guard.
- The two discovery-heavy areas (switch path teardown, turn pipeline session pinning) state contracts and invariants instead of fabricated code — the files are concurrently edited and their exact shape must be read at edit time.
- Names used consistently: `callSessionID`, `callSessionTitle`, `onCallEnded(sessionID:)`, `DeferredSessionClose`, `CallPill`.
