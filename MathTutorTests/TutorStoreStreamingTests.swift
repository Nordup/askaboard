import XCTest
import os
@testable import MathTutor

/// Yields a fixed, caller-supplied event array — the streaming-protocol
/// analogue of a canned `TutorReply` fixture. `onRequest` is optional and
/// exists only so a test can inspect the `TutorRequest` a turn actually
/// built (its `sessionID` in particular) without duplicating a network stub.
struct ScriptedTutorService: TutorService, Sendable {
    let events: [TutorEvent]
    let onRequest: (@Sendable (TutorRequest) -> Void)?

    init(events: [TutorEvent], onRequest: (@Sendable (TutorRequest) -> Void)? = nil) {
        self.events = events
        self.onRequest = onRequest
    }

    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        onRequest?(request)
        return AsyncThrowingStream { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
    }
}

/// Yields a different fixed event sequence on each successive `stream(_:)`
/// call, queue-style — for scripting a multi-turn conversation where
/// `ScriptedTutorService`'s one fixed sequence per store isn't enough. Once
/// the queue is empty, further turns just get `.done`.
final class SequencedTutorService: TutorService, Sendable {
    private let sequences: OSAllocatedUnfairLock<[[TutorEvent]]>

    init(sequences: [[TutorEvent]]) {
        self.sequences = OSAllocatedUnfairLock(initialState: sequences)
    }

    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        let events = sequences.withLock { queue -> [TutorEvent] in
            guard !queue.isEmpty else { return [.done] }
            return queue.removeFirst()
        }
        return AsyncThrowingStream { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
    }
}

extension SessionPersistence {
    /// A throwaway, per-call file so streaming tests never read another
    /// test's (or the app's real) `session.json`. Not a true in-memory
    /// backing store — `SessionPersistence` has no seam for one — but every
    /// test gets its own file, which is what actually matters here.
    static var inMemory: SessionPersistence {
        SessionPersistence(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("MathTutorTests-session-\(UUID().uuidString).json"))
    }
}

extension KeychainStore {
    /// A real Keychain-backed store pre-seeded with a key, for tests that
    /// need `usesLiveTutor` true without exercising key management itself.
    /// Every `KeychainStore` shares the same system entry (there is no
    /// per-instance scoping), matching the pattern the rest of the suite
    /// already relies on for keychain-backed tests.
    static var stub: KeychainStore {
        let store = KeychainStore()
        store.saveAPIKey("tutor-store-streaming-tests-key")
        return store
    }
}

@MainActor
final class TutorStoreStreamingTests: XCTestCase {
    func testTextDeltasAccumulateIntoASingleTutorMessage() async {
        let store = TutorStore(service: ScriptedTutorService(events: [
            .status(.thinking, detail: nil), .textDelta("Nice "), .textDelta("work."), .done,
        ]), persistence: .inMemory, keychain: .stub)
        await store.sendAndWait("check this")
        XCTAssertEqual(store.session.messages.last?.text, "Nice work.")
        XCTAssertEqual(store.session.messages.filter { $0.role == .tutor }.count, 2)
    }

    func testPhaseClearsWhenTheTurnIsDone() async {
        let store = TutorStore(service: ScriptedTutorService(events: [
            .status(.writing, detail: nil), .textDelta("hi"), .done,
        ]), persistence: .inMemory, keychain: .stub)
        await store.sendAndWait("hello")
        XCTAssertNil(store.phase)
    }

    func testAWorkspaceEventReplacesThePairAndOpensTheBoard() async {
        let store = TutorStore(service: ScriptedTutorService(events: [
            .workspace(.radicalEquation, .radicalEquation), .textDelta("Here."), .done,
        ]), persistence: .inMemory, keychain: .stub)
        await store.sendAndWait("give me a problem")
        XCTAssertEqual(store.session.plan?.title, SessionPlan.radicalEquation.title)
        XCTAssertNotNil(store.session.exercise)
        XCTAssertTrue(store.isWorkspace)
    }

    func testAFailureEventLeavesTheWorkspaceUntouchedAndShowsTheMessage() async {
        let store = TutorStore(service: ScriptedTutorService(events: [
            .textDelta("Partial"), .failure(message: "stream died", retryable: true),
        ]), persistence: .inMemory, keychain: .stub)
        store.applyForTesting(plan: .radicalEquation, exercise: .radicalEquation)
        await store.sendAndWait("continue")
        XCTAssertEqual(store.errorMessage, "stream died")
        XCTAssertEqual(store.session.plan?.title, SessionPlan.radicalEquation.title)
    }

    /// Replaces the old `TutorReply.coherentPair`-era coverage of this same
    /// shape (deleted along with `OpenAITutorService`, which is what produced
    /// its canned payloads). The streaming vocabulary expresses "ordinary
    /// chat, keep the current board" structurally — a turn simply sends no
    /// `.workspace` event — rather than the old null/null pair convention, so
    /// this exercises exactly that: a second pair replacing the first, then a
    /// third turn with no `.workspace` event at all leaving it untouched.
    func testWorkspaceReplacesAcrossTurnsAndIsUntouchedByATurnWithNoWorkspaceEvent() async {
        let replacementPlan = SessionPlan(
            title: "Coordinate confidence",
            goal: "Understand a coordinate transformation",
            outcomes: ["Track each point through the rule"],
            steps: ["Name the input point", "Apply the rule", "Check the output"],
            currentStep: 0
        )
        let replacementExercise = Exercise(
            title: "Try a transformation",
            prompt: "Reflect (2, -1) across the y-axis.",
            hint: "What changes sign when you reflect across the y-axis?",
            context: "A coordinate geometry exercise"
        )
        let service = SequencedTutorService(sequences: [
            [.workspace(.radicalEquation, .radicalEquation), .textDelta("A starter exercise is ready."), .done],
            [.workspace(replacementPlan, replacementExercise), .textDelta("Here is a new board exercise."), .done],
            [.textDelta("We can discuss that without changing your board."), .done],
        ])
        let store = TutorStore(service: service, persistence: .inMemory, keychain: .stub)

        await store.sendAndWait("Give me a starter algebra problem")
        XCTAssertEqual(store.session.plan?.title, SessionPlan.radicalEquation.title)
        XCTAssertEqual(store.session.exercise, .radicalEquation)

        await store.sendAndWait("Give me another exercise on coordinate geometry")
        XCTAssertEqual(store.session.plan, replacementPlan)
        XCTAssertEqual(store.session.exercise, replacementExercise)

        await store.sendAndWait("Explain why the reflection changes the x-coordinate")
        XCTAssertEqual(store.session.plan, replacementPlan, "A turn with no .workspace event must leave the current workspace untouched")
        XCTAssertEqual(store.session.exercise, replacementExercise, "A turn with no .workspace event must leave the current workspace untouched")
    }

    func testTwoTurnsOnOneStoreSendTheSameSessionIDAndAResetChangesIt() async {
        let recorded = OSAllocatedUnfairLock<[TutorRequest]>(initialState: [])
        let store = TutorStore(
            service: ScriptedTutorService(
                events: [.textDelta("ok"), .done],
                onRequest: { request in recorded.withLock { $0.append(request) } }
            ),
            persistence: .inMemory,
            keychain: .stub
        )

        await store.sendAndWait("first turn")
        await store.sendAndWait("second turn")
        let beforeReset = recorded.withLock { $0 }
        XCTAssertEqual(beforeReset.count, 2)
        XCTAssertEqual(
            beforeReset[0].sessionID, beforeReset[1].sessionID,
            "Two turns in the same session must carry the same session_id, or the backend can never accumulate context"
        )

        store.resetSession()
        await store.sendAndWait("after reset")
        let afterReset = recorded.withLock { $0 }
        XCTAssertEqual(afterReset.count, 3)
        XCTAssertNotEqual(
            afterReset[2].sessionID, beforeReset[0].sessionID,
            "A reset session must mint a fresh session_id, or its turns would leak into the old session's transcript"
        )
    }
}
