# Client Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the iPad app off its direct OpenAI connection onto the backend service, streaming tutor replies token by token, with no OpenAI key anywhere in the binary.

**Architecture:** `TutorService` becomes a streaming protocol yielding `TutorEvent`s. `BackendTutorService` consumes the service's SSE vocabulary. The three direct-OpenAI services are deleted, the Keychain holds a backend token instead of an API key, and the user-facing copy changes to match what now actually happens to a student's work.

**Tech Stack:** Swift 6, SwiftUI, `URLSession.bytes(for:)` for SSE, XCTest.

## Global Constraints

- **Prerequisite:** the backend-service plan is complete and `scripts/run-server.sh` runs. It is — 139 tests pass. Two known backend gaps remain open and do **not** block this plan: a client disconnect can strand a turn at `status="running"`, and the live smoke test cannot run.
- **A concurrent agent is editing this same working tree**, currently on the resize/panel feature (`BoardScreen.swift`, `Layout.swift`, `ResizeHandle.swift`, `UIStateTests.swift`, `ResizeModelTests.swift`). It has already, once this session, absorbed another agent's staged work into its own commit. Every task must stage its own files by explicit path, never `git add -A`, and commit promptly rather than leaving work staged.
- **The Settings layer was rewritten** since this plan was authored — see the re-base note in Task 6. Read the current file before editing any Settings file; do not trust this plan's descriptions of that layer.
- Commit directly to `main`. **Do not create branches.**
- `DemoTutorService` and every test that depends on it must keep working at every commit. It is the deterministic path the whole migration is verified against.
- No OpenAI API key, endpoint, or model constant may remain in `MathTutor/` when this plan finishes. `grep -ri "api.openai.com" MathTutor/` must return nothing.
- **Task 6 (the copy) must land before or with Task 5 (dictation).** `NSMicrophoneUsageDescription` currently promises *"Math Tutor keeps no copy of the recording"*, and the service persists audio by default. Shipping Task 5 first makes the app's own privacy declaration false.
- Build and test with: `xcodebuild -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' test`
- Regenerate the project with `xcodegen generate` after any `project.yml` change.

---

### Task 1: The streaming protocol and event type

**Files:**
- Create: `MathTutor/Domain/TutorEvent.swift`
- Modify: `MathTutor/Services/TutorService.swift`
- Test: `MathTutorTests/TutorEventTests.swift`

**Interfaces:**
- Produces: `enum TutorEvent: Sendable, Equatable` with cases `status(TutorPhase, detail: String?)`, `reasoningDelta(String)`, `textDelta(String)`, `workspace(SessionPlan, Exercise)`, `done`, `failure(message: String, retryable: Bool)`; `enum TutorPhase: String, Sendable { case thinking, looking, searching, writing }`.
- `protocol TutorService: Sendable { func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> }`.
- `TutorEvent.decode(from line: String) -> TutorEvent?` parses one `data: {...}` SSE line, returning `nil` for keep-alives, comments, and unrecognised event types.

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import MathTutor

final class TutorEventTests: XCTestCase {
    func testDecodesATextDelta() {
        let event = TutorEvent.decode(from: #"data: {"type":"text_delta","text":"Nice"}"#)
        XCTAssertEqual(event, .textDelta("Nice"))
    }

    func testDecodesAStatusWithDetail() {
        let event = TutorEvent.decode(from: #"data: {"type":"status","phase":"looking","detail":"the board"}"#)
        XCTAssertEqual(event, .status(.looking, detail: "the board"))
    }

    func testDecodesAWorkspacePair() {
        let json = #"data: {"type":"workspace","plan":{"title":"T","goal":"G","outcomes":["o"],"steps":["s"],"currentStep":0},"exercise":{"title":"E","prompt":"P","hint":"H","context":"C"}}"#
        guard case .workspace(let plan, let exercise)? = TutorEvent.decode(from: json) else {
            return XCTFail("Expected a workspace event")
        }
        XCTAssertEqual(plan.title, "T")
        XCTAssertEqual(exercise.prompt, "P")
    }

    func testIgnoresKeepAlivesAndComments() {
        XCTAssertNil(TutorEvent.decode(from: ""))
        XCTAssertNil(TutorEvent.decode(from: ": keep-alive"))
    }

    func testIgnoresAnUnknownEventTypeRatherThanThrowing() {
        XCTAssertNil(TutorEvent.decode(from: #"data: {"type":"future_event","x":1}"#))
    }

    func testDecodesARetryableFailure() {
        let event = TutorEvent.decode(from: #"data: {"type":"error","message":"rate limited","retryable":true}"#)
        XCTAssertEqual(event, .failure(message: "rate limited", retryable: true))
    }
}
```

- [ ] **Step 2: Run and confirm failure**

Run the test command above, filtered to `TutorEventTests`.
Expected: compile failure — `cannot find 'TutorEvent' in scope`.

- [ ] **Step 3: Implement `TutorEvent`**

Write `MathTutor/Domain/TutorEvent.swift` with the enum above plus a private `Codable` envelope keyed on `type`. Decoding an unknown `type` returns `nil` rather than throwing — the service may add event types before the app knows them, and a forward-compatible client ignores what it does not recognise instead of failing the turn.

- [ ] **Step 4: Change the protocol**

In `MathTutor/Services/TutorService.swift`, replace `func respond(to:) async throws -> TutorReply` with `func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error>`. Leave `TutorServiceRouter` and `DemoTutorService` broken for now; Task 2 fixes them. `TutorServiceError` is unchanged except that `.missingAPIKey`'s message becomes *"Add your backend address and token in Settings to use live tutoring."*

- [ ] **Step 5: Run and confirm the six event tests pass**

Expected: `TutorEventTests` passes; the rest of the target does not yet compile.

- [ ] **Step 6: Commit**

```bash
git add MathTutor/Domain/TutorEvent.swift MathTutor/Services/TutorService.swift MathTutorTests/TutorEventTests.swift
git commit -m "Make the tutor protocol streaming"
```

---

### Task 2: Restore the demo path on the streaming protocol

**Files:**
- Modify: `MathTutor/Services/TutorService.swift` (`DemoTutorService`)
- Test: `MathTutorTests/DemoTutorServiceTests.swift`

**Interfaces:**
- `DemoTutorService.stream(_:)` yields `.status(.thinking, detail: nil)`, then the same text it returned before split into several `.textDelta`s, then `.workspace` when the old implementation returned a non-nil pair, then `.done`.
- Every existing branch is preserved exactly: the `dontKnow` reply, the image reply keyed on `imageRegionDescription`, the no-plan onboarding reply, the hint/stuck branch, and the default reply.

- [ ] **Step 1: Write the failing tests**

```swift
func testDemoStreamEndsWithDone() async throws {
    var events: [TutorEvent] = []
    for try await event in DemoTutorService().stream(.fixture()) { events.append(event) }
    XCTAssertEqual(events.last, .done)
}

func testDemoStreamEmitsThinkingFirst() async throws {
    var events: [TutorEvent] = []
    for try await event in DemoTutorService().stream(.fixture()) { events.append(event) }
    XCTAssertEqual(events.first, .status(.thinking, detail: nil))
}

func testDontKnowSignalStillProducesItsReassurance() async throws {
    var text = ""
    for try await event in DemoTutorService().stream(.fixture(signal: .dontKnow)) {
        if case .textDelta(let chunk) = event { text += chunk }
    }
    XCTAssertTrue(text.contains("useful signal, not a dead end"))
}

func testAnExistingPairIsReemittedAsAWorkspaceEvent() async throws {
    let request = TutorRequest.fixture(plan: .radicalEquation, exercise: .radicalEquation)
    var sawWorkspace = false
    for try await event in DemoTutorService().stream(request) {
        if case .workspace = event { sawWorkspace = true }
    }
    XCTAssertTrue(sawWorkspace)
}
```

Add a `TutorRequest.fixture(...)` helper in the test target with defaults for every field.

- [ ] **Step 2: Run and confirm failure**

Expected: compile failure — `DemoTutorService` has no member `stream`.

- [ ] **Step 3: Implement `DemoTutorService.stream`**

Keep the existing branch logic verbatim, returning `AsyncThrowingStream { continuation in Task { ... } }`. Split the reply text on sentence boundaries into `.textDelta`s with a 40 ms sleep between them, so the demo path exercises the same incremental rendering the live path will.

- [ ] **Step 4: Run and confirm the four tests pass**

- [ ] **Step 5: Commit**

```bash
git add MathTutor/Services/TutorService.swift MathTutorTests/DemoTutorServiceTests.swift
git commit -m "Stream the demo tutor so the offline path matches the live one"
```

---

### Task 3: `BackendTutorService`

**Files:**
- Create: `MathTutor/Services/BackendTutorService.swift`, `MathTutor/Services/BackendConfiguration.swift`
- Modify: `MathTutor/Services/TutorService.swift` (`TutorServiceRouter`)
- Test: `MathTutorTests/BackendTutorServiceTests.swift`

**Interfaces:**
- `struct BackendConfiguration: Sendable { var baseURL: URL; var token: String }`, loaded from `UserDefaults` (`mathTutor.backendBaseURL`) and `KeychainStore` (the token).
- `struct BackendTutorService: TutorService` with `init(configuration:session: URLSession = .shared)`.
- `TutorServiceRouter.stream(_:)` throws `TutorServiceError.missingAPIKey` when the configuration is incomplete, otherwise delegates.
- Tests use a `URLProtocol` stub returning canned SSE bytes — no network.

- [ ] **Step 1: Write the failing tests**

```swift
func testStreamsEachEventInOrder() async throws {
    StubURLProtocol.body = """
    data: {"type":"status","phase":"thinking","detail":null}

    data: {"type":"text_delta","text":"Nice "}

    data: {"type":"text_delta","text":"work."}

    data: {"type":"done","turn_id":"\(UUID().uuidString)"}


    """
    var events: [TutorEvent] = []
    for try await event in makeService().stream(.fixture()) { events.append(event) }
    XCTAssertEqual(events, [
        .status(.thinking, detail: nil), .textDelta("Nice "), .textDelta("work."), .done,
    ])
}

func testSendsTheBearerTokenAndAClientTurnID() async throws {
    StubURLProtocol.body = "data: {\"type\":\"done\",\"turn_id\":\"\(UUID().uuidString)\"}\n\n"
    for try await _ in makeService().stream(.fixture()) {}
    let request = try XCTUnwrap(StubURLProtocol.lastRequest)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
    let body = try XCTUnwrap(StubURLProtocol.lastBody)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertNotNil(UUID(uuidString: json["turn_id"] as? String ?? ""))
}

func testAnHTTPErrorSurfacesAsAFailure() async throws {
    StubURLProtocol.status = 401
    StubURLProtocol.body = ""
    do {
        for try await _ in makeService().stream(.fixture()) {}
        XCTFail("Expected a thrown error")
    } catch {
        XCTAssertTrue(error is TutorServiceError)
    }
}

func testAPartialLineIsBufferedUntilItCompletes() async throws {
    // The bytes API delivers lines, but a server flush can split a JSON payload.
    StubURLProtocol.body = "data: {\"type\":\"text_delta\",\"text\":\"whole\"}\n\ndata: {\"type\":\"done\",\"turn_id\":\"\(UUID().uuidString)\"}\n\n"
    var text = ""
    for try await event in makeService().stream(.fixture()) {
        if case .textDelta(let chunk) = event { text += chunk }
    }
    XCTAssertEqual(text, "whole")
}
```

- [ ] **Step 2: Run and confirm failure**

Expected: compile failure — `cannot find 'BackendTutorService' in scope`.

- [ ] **Step 3: Implement**

`BackendTutorService.stream(_:)` builds a `POST` to `baseURL/v1/turn` with `Authorization: Bearer <token>`, a freshly generated `turn_id`, the session id, message text, signal, goal, base64 board PNG and region, model and effort. It consumes the response with `for try await line in bytes.lines`, passing each line to `TutorEvent.decode(from:)` and yielding non-nil results. A non-2xx status throws `TutorServiceError.network` carrying the body text. A `.failure` event is yielded, not thrown — the learner has already seen partial text, and the UI decides how to present a retry.

- [ ] **Step 4: Run and confirm the four tests pass**

- [ ] **Step 5: Commit**

```bash
git add MathTutor/Services/BackendTutorService.swift MathTutor/Services/BackendConfiguration.swift MathTutor/Services/TutorService.swift MathTutorTests/BackendTutorServiceTests.swift
git commit -m "Talk to the backend service instead of OpenAI"
```

---

### Task 4: Consume the stream in `TutorStore`

**Files:**
- Modify: `MathTutor/TutorStore.swift`, `MathTutor/Domain/Models.swift`, `MathTutor/Services/BackendTutorService.swift`
- Test: `MathTutorTests/TutorStoreStreamingTests.swift`

**A gap this plan missed, found during Task 3.** The server rebuilds conversation context from the messages stored against a `session_id`, but `LearningSession` has no id and `TutorRequest` never carried one — so `BackendTutorService` currently mints a fresh UUID per turn as a stopgap. That means every turn opens a *new* server-side session, the transcript never accumulates, and the tutor replies the backend now persists are written where nothing will ever read them. Turns would appear to work while memory silently never did.

Fix it here:
- Add `id: UUID` to `LearningSession`, defaulted on creation. Give it the same tolerant-decoding treatment `reasoningEffort` already has, so a `session.json` written before this change still loads and simply gets a fresh id rather than failing to decode.
- Carry it on `TutorRequest` and have `BackendTutorService` send it instead of generating one.
- `LearningSession.empty` and any reset path must mint a **new** id — starting a fresh session must start a fresh server-side session, or the old transcript leaks into the new one.
- Test: two turns on one store send the **same** `session_id`; a reset changes it.

**Interfaces:**
- `requestTutor(signal:)` becomes a stream consumer. On the first `.textDelta` it appends an empty tutor `TutorMessage` and then mutates its `text` in place per delta, so the bubble grows as the reply is written.
- New `@Published private(set) var phase: TutorPhase?` drives the status line; it clears on `.done`.
- `.workspace` applies the pair and sets `isWorkspace`. Because the pair now arrives whole or not at all, **`TutorReply.coherentPair` is deleted** along with its call sites.
- `persist()` is called once on `.done`, not per delta — writing `session.json` on every token would thrash the disk.

- [ ] **Step 1: Write the failing tests**

```swift
@MainActor
func testTextDeltasAccumulateIntoASingleTutorMessage() async {
    let store = TutorStore(service: ScriptedTutorService(events: [
        .status(.thinking, detail: nil), .textDelta("Nice "), .textDelta("work."), .done,
    ]), persistence: .inMemory, keychain: .stub)
    await store.sendAndWait("check this")
    XCTAssertEqual(store.session.messages.last?.text, "Nice work.")
    XCTAssertEqual(store.session.messages.filter { $0.role == .tutor }.count, 2)
}

@MainActor
func testPhaseClearsWhenTheTurnIsDone() async {
    let store = TutorStore(service: ScriptedTutorService(events: [
        .status(.writing, detail: nil), .textDelta("hi"), .done,
    ]), persistence: .inMemory, keychain: .stub)
    await store.sendAndWait("hello")
    XCTAssertNil(store.phase)
}

@MainActor
func testAWorkspaceEventReplacesThePairAndOpensTheBoard() async {
    let store = TutorStore(service: ScriptedTutorService(events: [
        .workspace(.radicalEquation, .radicalEquation), .textDelta("Here."), .done,
    ]), persistence: .inMemory, keychain: .stub)
    await store.sendAndWait("give me a problem")
    XCTAssertEqual(store.session.plan?.title, SessionPlan.radicalEquation.title)
    XCTAssertNotNil(store.session.exercise)
}

@MainActor
func testAFailureEventLeavesTheWorkspaceUntouchedAndShowsTheMessage() async {
    let store = TutorStore(service: ScriptedTutorService(events: [
        .textDelta("Partial"), .failure(message: "stream died", retryable: true),
    ]), persistence: .inMemory, keychain: .stub)
    store.applyForTesting(plan: .radicalEquation, exercise: .radicalEquation)
    await store.sendAndWait("continue")
    XCTAssertEqual(store.errorMessage, "stream died")
    XCTAssertEqual(store.session.plan?.title, SessionPlan.radicalEquation.title)
}
```

Add `ScriptedTutorService` (yields a fixed event array) and `SessionPersistence.inMemory` to the test target.

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement**

Rewrite `requestTutor(signal:)` as a stream consumer per the interfaces above. Delete `TutorReply.coherentPair` from `MathTutor/Domain/Models.swift` and every call site. `TutorReply` itself can go — nothing produces it once the demo service streams.

- [ ] **Step 4: Run the whole test target**

Expected: all tests pass, including the existing evaluation and E2E fixture tests.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/TutorStore.swift MathTutor/Domain/Models.swift MathTutorTests/TutorStoreStreamingTests.swift
git commit -m "Render the tutor reply as it is written"
```

---

### Task 5: Dictation through the backend, and the copy that has to change with it

**Files:**
- Create: `MathTutor/Services/BackendDictationService.swift`
- Delete: `MathTutor/Services/OpenAIDictationService.swift`, `MathTutor/Services/OpenAITranscription.swift`
- Modify: `project.yml` (`NSMicrophoneUsageDescription`), `README.md`, `docs/design-system/07-dictation.md`
- Test: `MathTutorTests/BackendDictationServiceTests.swift`

**Interfaces:**
- `BackendDictationService: DictationService` posts the recorded WAV as `multipart/form-data` to `baseURL/v1/dictation` and consumes the same SSE `text_delta`/`done` vocabulary.
- The recording, level metering, 60-second cap, two-phase UI, and cancel behaviour are **unchanged** — only the destination of the bytes changes.
- Keyword steering, sanitisation, and boilerplate-silence filtering now live on the server. `DictationVocabulary` is deleted from the client.

**This task carries the privacy copy.** The service persists audio indefinitely, and `NSMicrophoneUsageDescription` currently ends *"Math Tutor keeps no copy of the recording."* That sentence becomes false the moment this task ships, so it changes here, in the same commit.

- [ ] **Step 1: Rewrite the purpose string**

In `project.yml`, replace the final sentence of `NSMicrophoneUsageDescription`. The rest of the string is accurate and stays. The replacement must say plainly that the recording is sent to and kept by your server — a parent reading this is the only person who gets told:

```
Math Tutor records your voice only while you have tapped the microphone in the
tutor's message box. When you tap it again the recording is sent to Math Tutor's
server, which passes it to OpenAI to turn into text you can read and edit before
sending. OpenAI does not use it to train its models, but can keep it for up to 30
days to check for misuse before deleting it. Math Tutor's server keeps the
recording so a parent or teacher can review the session later.
```

Run `xcodegen generate` afterwards.

- [ ] **Step 2: Correct README line 54**

The sentence *"Nothing logs or persists the audio or the transcript"* is no longer true. Replace it with a statement of what now happens, and update the API-setup section so it describes the backend and its token rather than an OpenAI key in the Keychain. Add the same correction to `docs/design-system/07-dictation.md` wherever it asserts non-persistence.

- [ ] **Step 3: Write the failing test**

```swift
func testPostsTheRecordingAsMultipartWithTheBearerToken() async throws {
    StubURLProtocol.body = "data: {\"type\":\"text_delta\",\"text\":\"solve x\"}\n\ndata: {\"type\":\"done\"}\n\n"
    let service = BackendDictationService(configuration: .stub, session: .stubbed)
    var transcript = ""
    for try await chunk in service.transcribe(wav: Data("RIFF".utf8)) { transcript += chunk }
    XCTAssertEqual(transcript, "solve x")
    let request = try XCTUnwrap(StubURLProtocol.lastRequest)
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
    XCTAssertTrue(
        request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data") == true
    )
}
```

- [ ] **Step 4: Run and confirm failure, then implement and delete**

Implement `BackendDictationService`, then delete `OpenAIDictationService.swift`, `OpenAITranscription.swift`, and `DictationVocabulary`. Update `DictationController` to construct the new service.

- [ ] **Step 5: Run the whole test target**

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Send dictation through the backend and say plainly that the audio is kept"
```

---

### Task 6: Delete the direct OpenAI path and re-point Settings

**Files:**
- Delete: `MathTutor/Services/OpenAITutorService.swift`, `MathTutor/DebugAPIKeyInjection.swift`
- Modify: `MathTutor/Services/KeychainStore.swift`, `MathTutor/Features/Settings/KeyField.swift`, `MathTutor/Features/Settings/SettingsPanes.swift`, `MathTutor/Features/Plan/NoAPIKeyState.swift`, `scripts/run-sim.sh`, `README.md`

**Re-based 2026-08-08.** This plan was written against a Settings layer that no longer exists. A concurrent agent replaced `SettingsScreen.swift` with a pane-based structure: `SettingsWindow.swift`, `SettingsSidebar.swift`, `SettingsPane.swift`, `SettingsPanes.swift`, `SettingsPresentation.swift`, `SettingRow.swift`. The API-key UI now lives in `APIKeyPane` inside `SettingsPanes.swift`, which composes the existing `KeyField`. Read those two files before editing; the structure below describes intent, not current line numbers.
- Test: `MathTutorTests/SettingsBackendTests.swift`

**Interfaces:**
- `KeychainStore.readAPIKey()/saveAPIKey()/removeAPIKey()` become `readBackendToken()/saveBackendToken()/removeBackendToken()` against a new Keychain account. The old account is deleted on first launch so a real OpenAI key does not sit in the Keychain forever after it stops being used.
- Settings gains a base-URL field alongside the token field. Both are required before `usesLiveTutor` is true.
- `scripts/run-sim.sh` passes `MATHTUTOR_BACKEND_URL` and `MATHTUTOR_BACKEND_TOKEN` instead of `MATHTUTOR_OPENAI_API_KEY`, keeping the DEBUG-only local dev loop working.

- [ ] **Step 1: Write the failing tests**

```swift
func testMigrationRemovesAnyStoredOpenAIKey() {
    let keychain = KeychainStore()
    keychain.saveLegacyAPIKeyForTesting("sk-should-not-survive")
    keychain.migrateAwayFromAPIKey()
    XCTAssertNil(keychain.readLegacyAPIKeyForTesting())
}

func testLiveTutoringRequiresBothTheURLAndTheToken() {
    XCTAssertNil(BackendConfiguration(baseURL: nil, token: "t"))
    XCTAssertNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: ""))
    XCTAssertNotNil(BackendConfiguration(baseURL: URL(string: "http://x"), token: "t"))
}
```

- [ ] **Step 2: Run and confirm failure, then implement**

Rename the Keychain accessors, add `migrateAwayFromAPIKey()` and call it from `TutorStore.init`, add the base-URL field to Settings, and rewrite the `NoAPIKeyState` copy to ask for a backend address and token. Delete `OpenAITutorService.swift` and `DebugAPIKeyInjection.swift`.

- [ ] **Step 3: Rewrite the README's API-setup section**

The current text is carefully honest that the key leaves the device. The replacement has to be equally honest about what replaced it: the student's handwriting, board snapshots and voice go to your server, which keeps them indefinitely, and forwards them to OpenAI. Remove the `.env.local` / `MATHTUTOR_OPENAI_API_KEY` instructions and document the new environment variables.

- [ ] **Step 4: Verify no OpenAI reference survives**

```bash
grep -ri "api.openai.com\|OPENAI_API_KEY\|sk-" MathTutor/ scripts/run-sim.sh
```

Expected: no output.

- [ ] **Step 5: Run the whole test target and a simulator launch**

Run the test command, then `scripts/run-server.sh` in one terminal and `scripts/run-sim.sh` in another. Send a message and confirm the reply streams in word by word.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Remove the client's OpenAI key entirely"
```

---

## Self-Review

**Spec coverage.** Spec §9 client changes → Tasks 1–6 in full: streaming protocol (1), demo parity (2), `BackendTutorService` (3), store consumption and `coherentPair` deletion (4), dictation (5), key removal and copy (6). Spec §5's claim that the schema change "deletes `coherentPair`" is discharged in Task 4.

**Ordering constraint verified.** Task 5 carries the purpose-string rewrite in its own first step, before the dictation service is implemented in step 4 — so there is no commit in which the app sends audio to a server that keeps it while still claiming it keeps no copy.

**Type consistency.** `TutorEvent` and `TutorPhase` (Task 1) are produced by `DemoTutorService` (2) and `BackendTutorService` (3) and consumed by `TutorStore` (4). `BackendConfiguration` (Task 3) is read by `BackendDictationService` (5) and constructed from the Settings fields (6). `TutorRequest` is unchanged throughout; `TutorReply` is deleted in Task 4.

**Known risk.** Task 4 is the largest single change and touches the file with the most existing test coverage. If it proves too large in execution, split it: accumulate deltas into a message first, then add `phase`, then move workspace application off `coherentPair`.
