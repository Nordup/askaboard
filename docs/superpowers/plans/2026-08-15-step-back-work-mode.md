# Step-Back Work Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The voice model decides, by judgment, when the learner wants to work alone; it says one warm line, calls a `step_back` tool, the mic goes off, the mascot rests, and a tap wakes it.

**Architecture:** A second realtime tool (`step_back`) beside `send_to_tutor`, server-owned like everything in the session config. The device answers the tool silently (a `function_call_output` with NO `response.create`), mutes the mic through a new `MicMuteGuard` owner, and shows a Resting mascot + chip. A tap on the mascot releases the mute and returns to Listening. No server state; work mode lives on the device, inside the call.

**Tech Stack:** FastAPI server (session config, prompt), Swift/SwiftUI device (VoiceSessionCoordinator, VoiceEngineLogic, mascot), OpenAI Realtime API over WebRTC.

**Design source (Paper, extracted 2026-08-15):** file `01KZAH9BZ4FRZXKG2309B7SSRG`, Page 1.
- `note/27 — Voice · mascot states` → tile `state/resting`: halo = 116×116 ring (tile version 76×76), `border: 1.5px solid rgba(96,81,220,0.30)`, `border-radius: full`, no fill; eyes become slits — docked orb eyes 9×9 → 10×4, tile eyes 6×6 → 7×3; face/orb body unchanged.
- `31 — Voice · work mode · docked`: thread shows learner "Wait — I want to try the next one myself." → tutor "Good idea — take your time. I'll be right here." → chip `chip/resting` (moon icon 14×14, stroke `--color-brand` 1.4, label "Resting — tap to wake", 14px semibold `--color-brand`, same pill as the board-activity chip) → resting orb (ring 116×116 centered on the 301×120 orb slot, single halo, inner halo removed); `btn/mic-mute` at `opacity: 0.45`.
- Moon SVG path: `M11.5 8.8a5 5 0 0 1-6.3-6.3 5 5 0 1 0 6.3 6.3z` in a 14×14 viewBox.

## Global Constraints

- Work on `main`, in place. No branches, no worktrees (user rule, overrides skill defaults).
- The working tree is shared with a concurrent session (cost recording). **Re-read every file immediately before editing it.** Never `git checkout` a dirty file.
- Never run `xcodebuild test` (user runs device/sim tests). Server pytest is allowed, but only DB-free tests (shared Neon branch).
- New Swift files require `xcodegen generate`; no duplicate basenames in the target.
- The voice model is always the full realtime model, never mini (founder decision).
- Voice prompt register: the learner speaking to the tutor ("I", "me"). Match it in any prompt addition.
- Commit only files this plan touches, and only if the concurrent session's in-flight edits are not swept into the same file's diff; otherwise leave uncommitted and say so.

---

### Task 1: Server — `step_back` tool + prompt section

**Files:**
- Modify: `server/app/tutor/voice_prompt.py`
- Test: `server/tests/test_prompt.py` (append; re-read first — concurrently edited)

**Interfaces:**
- Produces: `STEP_BACK_TOOL` (dict) and a `## STEPPING BACK` section inside `VOICE_SECTION`. Task 2 imports `STEP_BACK_TOOL`.

- [ ] **Step 1: Write the failing tests** (append to `server/tests/test_prompt.py`)

```python
def test_step_back_tool_shape():
    from app.tutor.voice_prompt import STEP_BACK_TOOL
    assert STEP_BACK_TOOL["name"] == "step_back"
    assert STEP_BACK_TOOL["type"] == "function"
    assert STEP_BACK_TOOL["parameters"] == {"type": "object", "properties": {}}
    # The description is the propensity lever: it must drill the two rules.
    desc = STEP_BACK_TOOL["description"]
    assert "one short" in desc  # say a line first
    assert "tap" in desc        # waking is a tap, mic is off


def test_voice_prompt_has_stepping_back_section():
    from app.tutor.voice_prompt import VOICE_SYSTEM_PROMPT
    assert "## STEPPING BACK" in VOICE_SYSTEM_PROMPT
    assert "step_back" in VOICE_SYSTEM_PROMPT
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && .venv/bin/pytest tests/test_prompt.py -k step_back -x -q`
Expected: FAIL with `ImportError: cannot import name 'STEP_BACK_TOOL'`

- [ ] **Step 3: Implement** (in `voice_prompt.py`, after `SEND_TO_TUTOR_TOOL`)

```python
# Same discipline as SEND_TO_TUTOR_TOOL: the description is the propensity
# lever. It names the trigger signals, the say-a-line-first rule, and the fact
# that waking is a tap — the model must not promise "call me when ready".
STEP_BACK_TOOL = {
    "type": "function",
    "name": "step_back",
    "description": (
        "Go quiet so the learner can work alone. Call it when they say they "
        "will try it themselves, when they ask for quiet, or when they take "
        "an exercise and stop talking to you. Say one short warm line FIRST "
        "— like 'Take your time — tap me when you're ready' — then call. "
        "While you rest your microphone is off and you hear nothing; the "
        "learner taps you to wake you, so never say you will listen for "
        "them. Do not call it mid-explanation or while send_to_tutor runs."
    ),
    "parameters": {"type": "object", "properties": {}},
}
```

And inside `VOICE_SECTION`, after the `## RELAYING tutor_reply` block, in the same learner-to-tutor register:

```python
## STEPPING BACK

When I want to work alone — I say I'll try it, I ask for quiet, or I take an exercise and stop talking to you — say one short warm line ("Take your time — tap me when you're ready") and call step_back. Don't ask my permission and don't keep narrating. While you rest you can't hear me at all: never promise to listen, never say "call me" — I will tap you when I want you back.
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && .venv/bin/pytest tests/test_prompt.py -x -q`
Expected: PASS (all, including pre-existing prompt tests)

### Task 2: Server — the session config carries the tool

**Files:**
- Modify: `server/app/api/realtime.py` (re-read first — concurrently edited)
- Test: the server test file that exercises `build_realtime_session` (find with `grep -rln build_realtime_session server/tests/`; append there, or create `server/tests/test_realtime_session.py` if none)

**Interfaces:**
- Consumes: `STEP_BACK_TOOL` from Task 1.
- Produces: `build_realtime_session()["tools"] == [SEND_TO_TUTOR_TOOL, STEP_BACK_TOOL]`.

- [ ] **Step 1: Failing test**

```python
def test_session_config_lists_both_tools():
    from app.api.realtime import build_realtime_session
    from app.tutor.voice_prompt import SEND_TO_TUTOR_TOOL, STEP_BACK_TOOL
    tools = build_realtime_session()["tools"]
    assert tools == [SEND_TO_TUTOR_TOOL, STEP_BACK_TOOL]
```

Run: `cd server && .venv/bin/pytest <that file> -k both_tools -x -q` → FAIL (one tool)

- [ ] **Step 2: Implement** — in `build_realtime_session`, change the import line to `from app.tutor.voice_prompt import SEND_TO_TUTOR_TOOL, STEP_BACK_TOOL, VOICE_SYSTEM_PROMPT` and the config line to `"tools": [SEND_TO_TUTOR_TOOL, STEP_BACK_TOOL],`

- [ ] **Step 3: Run to verify pass** — same command, plus `pytest` on the whole file (DB-free).

### Task 3: Device — `MicMuteGuard` learns a resting owner

**Files:**
- Modify: `MathTutor/Services/Realtime/VoiceEngineLogic.swift` (re-read first)
- Test: `MathTutorTests/VoiceEngineTests.swift` (re-read first; append)

**Interfaces:**
- Produces: `MicMuteGuard.setResting(_ resting: Bool)` and `isResting`; `shouldTransmit` is false while resting. The resting mute is owned by work mode: no watchdog, released only by `setResting(false)` (tap) or a fresh call.

- [ ] **Step 1: Failing tests** (mirror the existing MicMuteGuard test style — injected clocks, pure struct)

```swift
func testRestingMutesTransmission() {
    var guard_ = MicMuteGuard()
    guard_.setResting(true)
    XCTAssertFalse(guard_.shouldTransmit)
    guard_.setResting(false)
    XCTAssertTrue(guard_.shouldTransmit)
}

func testRestingSurvivesWatchdogAndRouteChanges() {
    // The resting mute has an owner (work mode) — nothing but setResting
    // or a new call may release it. Sweep every release trigger.
    var guard_ = MicMuteGuard()
    guard_.setResting(true)
    _ = guard_.routeChanged(at: 100)
    _ = guard_.appBecameActive(at: 200)
    _ = guard_.tick(at: 10_000)  // far past any watchdog window
    XCTAssertFalse(guard_.shouldTransmit)
}

func testRestingAndUserMuteAreIndependent() {
    var guard_ = MicMuteGuard()
    guard_.setResting(true)
    guard_.setUserMuted(true)
    guard_.setResting(false)
    XCTAssertFalse(guard_.shouldTransmit)  // user mute still holds
    guard_.setUserMuted(false)
    XCTAssertTrue(guard_.shouldTransmit)
}
```

(Adapt the exact release-trigger method names to what `MicMuteGuard` actually exposes at edit time — the file is concurrently edited. The invariant is the point: only `setResting(false)` releases the resting mute.)

- [ ] **Step 2: Implement** — in `MicMuteGuard`:

```swift
private(set) var isResting = false

var shouldTransmit: Bool { !isUserMuted && !isResting && interruptionMutedSince == nil }

mutating func setResting(_ resting: Bool) {
    isResting = resting
}
```

The existing watchdog/release paths (`routeChanged`, `appBecameActive`, the 1 Hz tick) touch only `interruptionMutedSince` — verify they do not clear `isResting` (they should not, by construction).

- [ ] **Step 3: Do NOT run xcodebuild test.** Leave the tests for the user's run.

### Task 4: Device — the coordinator answers `step_back` silently

**Files:**
- Modify: `MathTutor/Services/Realtime/VoiceSessionCoordinator.swift` (re-read first — concurrently edited)
- Modify: `MathTutor/Services/Realtime/RealtimeEvents.swift` only if `functionCallOutput` needs no change (it does not — the change is on the coordinator's `sendToolResult`)
- Test: `MathTutorTests/VoiceEngineTests.swift` (append, if the tool-gate logic is testable there) — otherwise the pure parsing already covers it

**Interfaces:**
- Consumes: `MicMuteGuard.setResting` (Task 3) via whatever owner routes mute state (follow the user-mute path).
- Produces: `Self.stepBackToolName == "step_back"`; a `sendToolResult(callID:output:createResponse:)` with `createResponse` defaulting `true`; a `hooks.enterRest()` callback the UI layer implements in Task 5/6.

- [ ] **Step 1: Add the hook** — in the hooks type (where `runTutorTurn`/`appendUserUtterance` live), add `var enterRest: () -> Void`.

- [ ] **Step 2: Extend `sendToolResult`**

```swift
private func sendToolResult(callID: String, output: [String: String], createResponse: Bool = true) {
    send({ try RealtimeEventEncoder.functionCallOutput(callId: callID, output: output) },
         "function_call_output")
    if createResponse {
        send({ try RealtimeEventEncoder.responseCreate() }, "response.create (tool result)")
    }
}
```

No `response.create` after `step_back`: the model already spoke its warm line in the response that carried the call; provoking another response would bill the whole context to say a second goodbye.

- [ ] **Step 3: Handle the call** — in `handleToolCall`, after the `.run` decision and BEFORE the send_to_tutor guard:

```swift
if call.name == Self.stepBackToolName {
    toolGate.finished(callID: call.callId)
    sendToolResult(callID: call.callId, output: ["ok": "resting"], createResponse: false)
    hooks?.enterRest()
    publishDisplay()
    return
}
```

`static let stepBackToolName = "step_back"` beside `sendToTutorToolName`. The tool gate's duplicate/busy rules apply unchanged; a `step_back` that arrives while a worker turn streams gets the normal `busy` answer, which matches the prompt's "not while send_to_tutor runs".

- [ ] **Step 4: Tests** — if `handleToolCall` routing is reachable from the existing test seams, assert: a `step_back` call produces exactly one outbound `function_call_output` and zero `response.create`, and fires `enterRest`. If the seam does not exist, the `VoiceEngineLogic` state tests in Task 5 carry the behavior.

### Task 5: Device — `VoicePhase.resting`, mascot rendering, scripted engine

**Files:**
- Modify: `MathTutor/Features/Voice/VoiceContracts.swift` (add the phase; re-read first)
- Modify: `MathTutor/Features/Voice/Mascot/VoiceMascotView.swift` (Resting visuals)
- Modify: `MathTutor/Features/Voice/Mascot/ScriptedVoiceEngine.swift` (a scripted resting step so previews/UI tests cover it — voice never runs in the simulator)
- Test: `MathTutorTests/VoiceEngineTests.swift` (phase-transition assertions if the engine logic is pure)

**Interfaces:**
- Consumes: `hooks.enterRest()` (Task 4) → engine sets phase `.resting` and calls `micMuteGuard.setResting(true)`.
- Produces: `VoicePhase.resting`; `wake()` on the engine: `setResting(false)`, phase → `.listening`.

- [ ] **Step 1: Phase + transitions.** Add `case resting` to `VoicePhase`. Engine: `enterRest()` → guard current phase is a live-call phase, set `.resting`, resting-mute on. `wake()` → only from `.resting`, resting-mute off, phase `.listening`. Ending the call from `.resting` follows the normal end path (mute state dies with the call).

- [ ] **Step 2: Mascot Resting state** (values from Paper `state/resting` / board 31):
  - Halo: one thin ring, diameter 1.6× the face width (docked: ring 116pt on the 72pt orb), stroke 1.5pt, color brand at 30% opacity, no fill, no glow. The ring breathes very slowly (a ±2% scale sine, ~6 s period) so it reads alive, not dead — same integrator, advance by dt.
  - Eyes: animate from open (9×9 docked) to slits (10×4) over ~250 ms on entry; reverse on wake.
  - Existing halos/ripples: none while resting.

- [ ] **Step 3: ScriptedVoiceEngine.** Add a scripted beat: talking → resting (after a scripted "Take your time" line) → wake on tap. This is the only simulator coverage voice gets — it must exist before UI review.

- [ ] **Step 4: Transition tests** (pure logic): resting only enters from live phases; wake only exits resting; end-call from resting resets mute. Prefix-sweep every phase through `enterRest()`/`wake()` and assert the invariant: `phase == .resting` ⇔ resting-mute is on.

### Task 6: Device — resting chip, tap-to-wake, typing while resting

**Files:**
- Modify: the panel view that owns the step chip (`grep -rn "Drawing on the board\|StepChip\|chip" MathTutor/Features/Voice MathTutor/DesignSystem` at edit time) — add the resting variant
- Modify: `MathTutor/Features/Voice/Mascot/VoiceMascotView.swift` (tap target)
- Modify: `MathTutor/DesignSystem/Components/Chat/Composer.swift` only if typed-send routing needs the phase check (re-read first)

**Interfaces:**
- Consumes: `VoicePhase.resting` (Task 5), `wake()` (Task 5).
- Produces: chip variant `resting` (moon 14×14 stroke `--color-brand` width 1.4, path `M11.5 8.8a5 5 0 0 1-6.3-6.3 5 5 0 1 0 6.3 6.3z`, label "Resting — tap to wake", 14pt semibold brand on the existing chip pill); mascot tap = wake.

- [ ] **Step 1: Chip.** When phase is `.resting`, the step-chip slot shows the resting chip (it replaces board-activity chips — nothing else runs while resting). Copy: `Resting — tap to wake`.

- [ ] **Step 2: Tap-to-wake.** Tap on the mascot (docked and full screen) while `.resting` → `wake()`. The mascot is the tap target — its full slot (301×120 docked), not just the 72pt face. If taps get eaten by the drawer pan recognizer, extend `DrawerPanRecognizer`'s regions — do NOT add SwiftUI hit-testing guards (established rule from the press-cancel work).

- [ ] **Step 3: Typing while resting.** Typed text during `.resting` runs as a NORMAL typed turn (the existing non-voice pipeline) and does not wake the voice or enter the realtime conversation. Rationale: the learner chose quiet; a typed question deserves a typed answer, and injecting it into the realtime session would bill the voice context and make the mascot speak. The voice model learns what happened anyway on the next wake, through the worker's `assemble_context`.

- [ ] **Step 4: Mic button.** While `.resting`, the composer mic-mute button renders at 45% opacity and taps on it do nothing (the mute is not the user's to release — the mascot is the wake affordance). On wake it returns to normal.

### Task 7: Wire-up verification

- [ ] **Step 1:** `xcodegen generate` ONLY if any new file was created (none planned — all edits land in existing files).
- [ ] **Step 2:** Check no `xcodebuild` is running (`pgrep -fl xcodebuild`), then build the app target once (build, NOT test) to catch type errors. If the user is building, wait.
- [ ] **Step 3:** Server: `cd server && .venv/bin/pytest tests/test_prompt.py <realtime session test file> -q` (DB-free only).
- [ ] **Step 4:** Leave `xcodebuild test` and device verification to the user: the step_back propensity (does the model call it at the right moments) is only observable on the physical iPad.

## Self-Review

- Spec coverage: tool + prompt (T1), session config (T2), mute ownership (T3), silent tool answer (T4), phase/mascot/scripted (T5), chip/tap/typing/mic-button (T6), builds+tests (T7). The Paper boards carry the visuals; extracted values are in the header.
- No placeholders: every step has code or an exact command; the two "adapt at edit time" notes exist because the files are concurrently edited by another session — the invariants to preserve are stated.
- Type consistency: `stepBackToolName`/`step_back`, `enterRest()`/`wake()`, `setResting(_:)`/`isResting`, `sendToolResult(callID:output:createResponse:)` are used with the same names in Tasks 3–6.
