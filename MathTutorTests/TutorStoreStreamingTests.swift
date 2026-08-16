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
    /// A throwaway, per-call directory so streaming tests never read another
    /// test's (or the app's real) sessions. Not a true in-memory backing store —
    /// `SessionPersistence` has no seam for one — but every test gets its own
    /// directory, which is what actually matters here.
    static var inMemory: SessionPersistence {
        SessionPersistence(directoryURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("MathTutorTests-sessions-\(UUID().uuidString)"))
    }
}

extension AttachmentStore {
    /// A throwaway, per-call directory, for exactly the reason `SessionPersistence.inMemory`
    /// is one: a store test that sends a file writes a thumbnail, and it must not write it
    /// into the user's real Application Support directory.
    static var inTemporaryDirectory: AttachmentStore {
        AttachmentStore(directoryURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("MathTutorTests-attachments-\(UUID().uuidString)"))
    }
}

extension BoardCropStore {
    /// A throwaway, per-call directory, for exactly the reason
    /// `AttachmentStore.inTemporaryDirectory` is one: `BoardCropStore()`'s
    /// default resolves to the real Application Support directory, and
    /// `SessionPersistence.inMemory` gives a test its own session directory
    /// but has no say over where crops go — the two are independent stores.
    /// A test that lets a `.boardViewed` event through without this would
    /// write a PNG into the user's own data and never clean it up.
    static var inTemporaryDirectory: BoardCropStore {
        BoardCropStore(directoryURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("MathTutorTests-boardcrops-\(UUID().uuidString)"))
    }
}

extension BackendConfiguration {
    /// "This store can reach a tutor", stated rather than arranged.
    ///
    /// It used to be arranged, by writing a token into the real Keychain. The
    /// token is compiled in now, so there is nothing to write — and a test that
    /// read the real one would pass or fail depending on whether the machine
    /// running it happens to have a `Backend.local.xcconfig`. Injecting the
    /// answer keeps the suite independent of local credentials entirely.
    static var stub: BackendConfiguration {
        BackendConfiguration(
            baseURL: URL(string: "https://backend.example.com")!,
            token: "tutor-store-streaming-tests-token"
        )!
    }
}

@MainActor
final class TutorStoreStreamingTests: XCTestCase {
    func testTextDeltasAccumulateIntoASingleTutorMessage() async {
        let store = TutorStore(service: ScriptedTutorService(events: [
            .status(.thinking, detail: nil), .textDelta("Nice "), .textDelta("work."), .done,
        ]), persistence: .inMemory, configuration: .stub)
        await store.sendAndWait("check this")
        XCTAssertEqual(store.session.messages.last?.text, "Nice work.")
        XCTAssertEqual(store.session.messages.filter { $0.role == .tutor }.count, 2)
    }

    func testPhaseClearsWhenTheTurnIsDone() async {
        let store = TutorStore(service: ScriptedTutorService(events: [
            .status(.writing, detail: nil), .textDelta("hi"), .done,
        ]), persistence: .inMemory, configuration: .stub)
        await store.sendAndWait("hello")
        XCTAssertNil(store.phase)
    }

    func testAWorkspaceEventReplacesThePairAndOpensTheBoard() async {
        let store = TutorStore(service: ScriptedTutorService(events: [
            .workspace(.radicalEquation, .radicalEquation), .textDelta("Here."), .done,
        ]), persistence: .inMemory, configuration: .stub)
        await store.sendAndWait("give me a problem")
        XCTAssertEqual(store.session.plan?.title, SessionPlan.radicalEquation.title)
        XCTAssertNotNil(store.session.exercise)
        XCTAssertTrue(store.isWorkspace)
    }

    func testAFailureEventLeavesTheWorkspaceUntouchedAndShowsTheMessage() async {
        let store = TutorStore(service: ScriptedTutorService(events: [
            .textDelta("Partial"), .failure(message: "stream died", retryable: true),
        ]), persistence: .inMemory, configuration: .stub)
        store.applyForTesting(plan: .radicalEquation, exercise: .radicalEquation)
        await store.sendAndWait("continue")
        XCTAssertEqual(store.errorMessage, TutorStore.failureMessage(retryable: true))
        XCTAssertEqual(store.session.plan?.title, SessionPlan.radicalEquation.title)
    }

    /// **The server's sentence is never the learner's.** The `error` event
    /// carries a message and this app does not print it: for one real turn it
    /// carried the provider's own rate-limit error — the model's name, the
    /// organization id, and the account's tokens-per-minute ceiling — and a
    /// child read it off an iPad. The server sanitises its half now; this is
    /// the half that does not have to trust that it did.
    func testTheServersOwnWordsNeverBecomeTheLearnersMessage() async {
        let raw = """
            APIError: Rate limit reached for gpt-5.6-luna in organization \
            org-EXAMPLE0000 on tokens per min (TPM): Limit 200000, Used 164798.
            """
        let store = TutorStore(service: ScriptedTutorService(events: [
            .failure(message: raw, retryable: true),
        ]), persistence: .inMemory, configuration: .stub)

        await store.sendAndWait("find me a fish")

        XCTAssertEqual(store.errorMessage, TutorStore.failureMessage(retryable: true))
        XCTAssertFalse(store.errorMessage?.contains("org-") == true)
        XCTAssertFalse(store.errorMessage?.contains("gpt-5.6-luna") == true)
    }

    /// The retryable flag used to be discarded at the point of use, so the one
    /// structured fact a failure carried changed nothing the learner saw.
    func testTheFailureCopyFollowsWhetherAnotherTryIsWorthIt() async {
        func message(retryable: Bool) async -> String? {
            let store = TutorStore(service: ScriptedTutorService(events: [
                .failure(message: "provider text", retryable: retryable),
            ]), persistence: .inMemory, configuration: .stub)
            await store.sendAndWait("go")
            return store.errorMessage
        }

        let retryable = await message(retryable: true)
        let final = await message(retryable: false)
        XCTAssertNotEqual(retryable, final)
        XCTAssertEqual(final, ChatErrorState.networkMessage)
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
        let store = TutorStore(service: service, persistence: .inMemory, configuration: .stub)

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
            configuration: .stub
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

    // MARK: - The composer's attachments

    /// The `+`, from the store's side: the files land on the learner's own message,
    /// their thumbnails go to disk under the session that sent them, and the turn
    /// names them by id rather than carrying any bytes.
    func testASendWithAttachmentsCarriesThemOnTheMessageAndByIDOnTheTurn() async {
        let recorded = OSAllocatedUnfairLock<[TutorRequest]>(initialState: [])
        let thumbnails = AttachmentStore.inTemporaryDirectory
        let store = TutorStore(
            service: ScriptedTutorService(
                events: [.textDelta("ok"), .done],
                onRequest: { request in recorded.withLock { $0.append(request) } }
            ),
            persistence: .inMemory,
            attachmentStore: thumbnails,
            configuration: .stub
        )
        let uploaded = UploadedAttachment(
            attachment: MessageAttachment(
                id: UUID(), filename: "worksheet.pdf", kind: "pdf", pageCount: 3
            ),
            thumbnail: Data([0xFF, 0xD8, 0xFF])
        )

        await store.sendAndWait("is question 4 right?", attachments: [uploaded])

        XCTAssertEqual(
            store.session.messages.last(where: { $0.role == .learner })?.attachments,
            [uploaded.attachment],
            "The chips a reopened thread draws come off the message, so the message has to carry them"
        )
        XCTAssertEqual(
            recorded.withLock { $0 }.first?.attachmentIDs,
            [uploaded.attachment.id],
            "The turn names the file the server already holds — ids, never bytes"
        )
        // The send is what writes the thumbnail. This does not prove *when* relative to the
        // upload — nothing here uploads — only that the store writes it and that a later
        // read finds the same bytes, which is what a reopened thread's chips depend on.
        XCTAssertEqual(thumbnails.thumbnail(for: uploaded.attachment.id), uploaded.thumbnail)
    }

    /// A photographed worksheet is a complete request, the same way a lassoed region
    /// already was — so the emptiness guard asks about the draft, not about the text.
    func testFilesWithNoWordsAreStillATurnAndAnEmptyDraftIsStillNothing() async {
        let recorded = OSAllocatedUnfairLock<[TutorRequest]>(initialState: [])
        let store = TutorStore(
            service: ScriptedTutorService(
                events: [.textDelta("Let me look."), .done],
                onRequest: { request in recorded.withLock { $0.append(request) } }
            ),
            persistence: .inMemory,
            attachmentStore: .inTemporaryDirectory,
            configuration: .stub
        )
        let uploaded = UploadedAttachment(
            attachment: MessageAttachment(
                id: UUID(), filename: "photo.heic", kind: "image", pageCount: 1
            ),
            thumbnail: Data([0x01])
        )

        // Awaited outside the assertion — `XCTAssertTrue`'s autoclosure is synchronous, so an
        // `await` inside it does not compile.
        let filesOnlyTurnWasSent = await store.sendAndWait("   ", attachments: [uploaded])
        XCTAssertTrue(filesOnlyTurnWasSent)
        XCTAssertEqual(recorded.withLock { $0 }.count, 1)
        XCTAssertEqual(store.session.messages.last(where: { $0.role == .learner })?.text, "")

        // And nothing at all is still nothing: no words, no files, no turn.
        let emptyDraftWasSent = await store.sendAndWait("   ")
        XCTAssertFalse(emptyDraftWasSent)
        XCTAssertEqual(recorded.withLock { $0 }.count, 1)
    }

    /// **The one that cost a learner their photo.** A send that arrives while the tutor is
    /// still writing is declined, and it used to be declined silently: `BoardScreen` read
    /// the `Void` return as acceptance and cleared the draft, so the upload was cancelled
    /// and discarded for a turn that never existed. The `Bool` is what the caller keys the
    /// whole of that on, and the note is what the learner is told.
    func testASendDeclinedMidTurnReportsItAndSaysSo() async {
        let store = TutorStore(
            // No `.done`: the turn never finishes, so the store stays loading.
            service: ScriptedTutorService(events: [.textDelta("Let me think")]),
            persistence: .inMemory,
            attachmentStore: .inTemporaryDirectory,
            configuration: .stub
        )
        await store.sendAndWait("first")
        XCTAssertTrue(store.isLoading, "the fixture has to leave a turn in flight for this test to mean anything")

        let uploaded = UploadedAttachment(
            attachment: MessageAttachment(
                id: UUID(), filename: "photo.heic", kind: "image", pageCount: 1
            ),
            thumbnail: Data([0x01])
        )
        let before = store.session.messages.count

        XCTAssertFalse(
            store.send("second", attachments: [uploaded]),
            "A declined send must say so, or the caller destroys a draft that was never sent"
        )
        XCTAssertEqual(store.session.messages.count, before, "nothing was appended")
        XCTAssertEqual(
            store.composerNote,
            TutorStore.tutorIsStillAnswering,
            "The tap has to leave a mark: the composer note is the slot for a send that never left the device"
        )
    }

    /// The same hole in the other send. `evaluate` guards on `isEvaluating` and carries the
    /// same attachments, so a silent decline there loses the same uploads.
    func testAnEvaluateDeclinedMidEvaluationReportsItAndSaysSo() {
        let store = TutorStore(
            service: ScriptedTutorService(events: [.textDelta("Looking")]),
            persistence: .inMemory,
            attachmentStore: .inTemporaryDirectory,
            configuration: .stub
        )
        // `evaluate` sets `isEvaluating` before it starts the turn, so the second call is
        // declined without anything having to be awaited between the two.
        XCTAssertTrue(store.evaluate(imageData: Data([1]), regionDescription: "the whole board"))
        XCTAssertFalse(store.evaluate(imageData: Data([2]), regionDescription: "the whole board"))
        XCTAssertEqual(store.composerNote, TutorStore.tutorIsStillAnswering)
    }

    /// **The greeting drawn over a real conversation.** A wordless photo turn is a complete
    /// turn, so `hasGoal` — the one question deciding between the orb-and-chips start state
    /// and the thread — must count a learner message with files on it. It asked about text
    /// alone, so photographing a worksheet, sending it with nothing typed, and relaunching
    /// put the greeting on top of the exchange.
    func testAWordlessAttachmentTurnCountsAsAStartedSession() async {
        let store = TutorStore(
            service: ScriptedTutorService(events: [.textDelta("Let me look."), .done]),
            persistence: .inMemory,
            attachmentStore: .inTemporaryDirectory,
            configuration: .stub
        )
        XCTAssertFalse(store.hasGoal, "a session with only the tutor's greeting has not started")

        await store.sendAndWait("", attachments: [UploadedAttachment(
            attachment: MessageAttachment(
                id: UUID(), filename: "worksheet.heic", kind: "image", pageCount: 1
            ),
            thumbnail: Data([0x01])
        )])

        XCTAssertTrue(
            store.hasGoal,
            "A turn the tutor already answered is a conversation, whether or not anyone typed a word"
        )
    }

    /// **A retry re-sends the turn, not a stripped-down version of it.** The failed turn
    /// named a file the server holds; the retry named nothing, so the tutor answered a
    /// photo it had never been shown with the learner's chips still on screen above it.
    func testARetryCarriesTheAttachmentsAndImageTheFailedTurnCarried() async {
        let recorded = OSAllocatedUnfairLock<[TutorRequest]>(initialState: [])
        let store = TutorStore(
            service: ScriptedTutorService(
                events: [.failure(message: "stream died", retryable: true)],
                onRequest: { request in recorded.withLock { $0.append(request) } }
            ),
            persistence: .inMemory,
            attachmentStore: .inTemporaryDirectory,
            configuration: .stub
        )
        let uploaded = UploadedAttachment(
            attachment: MessageAttachment(
                id: UUID(), filename: "worksheet.pdf", kind: "pdf", pageCount: 3
            ),
            thumbnail: Data([0xFF])
        )

        await store.sendAndWait("is question 4 right?", attachments: [uploaded])
        XCTAssertNotNil(store.errorMessage, "the fixture has to fail for a retry to be reachable")

        store.retryLastRequest()
        await store.awaitActiveRequestForTesting()

        let requests = recorded.withLock { $0 }
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(
            requests[1].attachmentIDs,
            [uploaded.attachment.id],
            "The retry has to name the same file, or the tutor answers a worksheet it was never shown"
        )
    }

    /// The same hole on the other payload, and it predates attachments: an evaluate that
    /// failed was retried without the region the learner had marqueed.
    func testARetryCarriesTheBoardRegionTheFailedTurnCarried() async {
        let recorded = OSAllocatedUnfairLock<[TutorRequest]>(initialState: [])
        let store = TutorStore(
            service: ScriptedTutorService(
                events: [.failure(message: "stream died", retryable: true)],
                onRequest: { request in recorded.withLock { $0.append(request) } }
            ),
            persistence: .inMemory,
            attachmentStore: .inTemporaryDirectory,
            configuration: .stub
        )

        XCTAssertTrue(store.evaluate(
            imageData: Data([0xAB]), regionDescription: "the area selected on the board"
        ))
        await store.awaitActiveRequestForTesting()

        store.retryLastRequest()
        await store.awaitActiveRequestForTesting()

        let requests = recorded.withLock { $0 }
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[1].imageData, Data([0xAB]))
        XCTAssertEqual(requests[1].imageRegionDescription, "the area selected on the board")
    }

    // MARK: - The activity trail

    /// The message can no longer wait for the first `.textDelta` — the trail
    /// has to start before any prose exists, or a turn that reasons for a
    /// long time before writing a word would show nothing at all.
    func testAReasoningDeltaCreatesTheMessageBeforeAnyText() async {
        let store = TutorStore(
            service: ScriptedTutorService(events: [
                .reasoningDelta("Checking the domain"),
                .done,
            ]),
            persistence: .inMemory,
            configuration: .stub
        )
        await store.sendAndWait("Solve it")

        let tutor = store.session.messages.last { $0.role == .tutor }
        XCTAssertEqual(tutor?.text, "")
        XCTAssertEqual(tutor?.activity?.items.count, 1)
    }

    /// Every step arrives twice — a general label, then a specific one, under
    /// the same server `call_id` — and the second must replace the first
    /// rather than add a second row, or the trail would grow a duplicate for
    /// every tool call a turn makes.
    func testAStepArrivingTwiceLeavesOneRow() async {
        let store = TutorStore(
            service: ScriptedTutorService(events: [
                .step(id: "call_a", tool: "view_board", label: "Looking at the board"),
                .step(id: "call_a", tool: "view_board", label: "Looked at the top left of the board"),
                .textDelta("Try squaring."),
                .done,
            ]),
            persistence: .inMemory,
            configuration: .stub
        )
        await store.sendAndWait("Check this")

        let trail = store.session.messages.last { $0.role == .tutor }?.activity
        XCTAssertEqual(trail?.items.count, 1)
    }

    /// A turn can ask to view the board more than once, and the renders can
    /// come back in a different order than they were requested — `callID` is
    /// what lets each crop find its way back to the step that asked for it
    /// rather than to whichever `view_board` step happens to be unfinished.
    func testACropIsFiledOnTheStepThatAskedForIt() async {
        let store = TutorStore(
            service: ScriptedTutorService(events: [
                .step(id: "call_a", tool: "view_board", label: "Looking at the board"),
                .step(id: "call_b", tool: "view_board", label: "Looking at the board"),
                // Out of order on purpose: the second render returns first.
                .boardViewed(callID: "call_b", imageData: Data("b".utf8), detail: "b"),
                .boardViewed(callID: "call_a", imageData: Data("a".utf8), detail: "a"),
                .done,
            ]),
            persistence: .inMemory,
            boardCropStore: .inTemporaryDirectory,
            configuration: .stub
        )
        await store.sendAndWait("Check both")

        let trail = store.session.messages.last { $0.role == .tutor }?.activity
        let steps = trail?.items.compactMap { item -> TrailStep? in
            if case let .step(step) = item { return step }
            return nil
        }
        XCTAssertEqual(steps?.count, 2)
        XCTAssertNotNil(steps?.first { $0.id == "call_a" }?.imageID)
        XCTAssertNotNil(steps?.first { $0.id == "call_b" }?.imageID)
        XCTAssertNotEqual(steps?[0].imageID, steps?[1].imageID)
    }

    /// The duration the trail's header reports is measured on the device —
    /// the wait as the learner actually experienced it, network included —
    /// not a figure the server sends.
    func testDoneRecordsHowLongTheLearnerWaited() async {
        let store = TutorStore(
            service: ScriptedTutorService(events: [.textDelta("Hi"), .done]),
            persistence: .inMemory,
            configuration: .stub
        )
        await store.sendAndWait("Hello")

        let duration = store.session.messages.last { $0.role == .tutor }?.activity?.duration
        XCTAssertNotNil(duration)
        XCTAssertGreaterThanOrEqual(duration ?? -1, 0)
    }

    /// **The empty bubble a lazily-created message exists to prevent.** A
    /// turn that fails before the provider sends any reasoning, step, or
    /// text has nothing worth showing — the message must never have been
    /// created at all, not created and then left blank.
    func testATurnThatFailsImmediatelyLeavesNoEmptyBubble() async {
        let store = TutorStore(
            service: ScriptedTutorService(events: [
                .failure(message: "The tutor is unavailable.", retryable: true),
            ]),
            persistence: .inMemory,
            configuration: .stub
        )
        await store.sendAndWait("Hello")

        XCTAssertNil(store.session.messages.last { $0.role == .tutor })
        XCTAssertEqual(store.errorMessage, TutorStore.failureMessage(retryable: true))
    }
}
