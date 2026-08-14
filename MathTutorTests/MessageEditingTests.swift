import XCTest
import os
@testable import MathTutor

/// Records every `replaceTranscript` the store sends, and answers each with a
/// scripted verdict.
///
/// A spy rather than a network stub for `ClosingSpyService`'s reason: the
/// thing worth pinning down is *what prefix leaves the device and when* —
/// `BackendTutorService` owns the URL and is tested against it separately.
final class TranscriptSpyService: TutorService, Sendable {
    struct TranscriptCall: Sendable {
        let sessionID: UUID
        let messages: [TutorMessage]
    }

    private let calls = OSAllocatedUnfairLock<[TranscriptCall]>(initialState: [])
    private let acceptsSync: OSAllocatedUnfairLock<Bool>

    init(acceptsSync: Bool = true) {
        self.acceptsSync = OSAllocatedUnfairLock(initialState: acceptsSync)
    }

    var transcriptCalls: [TranscriptCall] { calls.withLock { $0 } }

    /// Flips the verdict mid-test — the failed-sync test heals the network
    /// this way before retrying.
    func setAcceptsSync(_ accepted: Bool) {
        acceptsSync.withLock { $0 = accepted }
    }

    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.textDelta("A reply."))
            continuation.yield(.done)
            continuation.finish()
        }
    }

    func replaceTranscript(sessionID: UUID, messages: [TutorMessage]) async -> Bool {
        calls.withLock { $0.append(TranscriptCall(sessionID: sessionID, messages: messages)) }
        return acceptsSync.withLock { $0 }
    }
}

/// The edit-and-resend flow: a long press's Edit arms a rewrite, the next
/// send cuts the thread at the edited message, and the server's transcript is
/// made to match before the turn goes out.
///
/// See `docs/superpowers/specs/2026-08-14-message-edit-resend-design.md` for
/// why the sync is a whole-prefix replace and why it gates the turn.
@MainActor
final class MessageEditingTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("MathTutorTests-editing-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testEditingAndResendingCutsTheThreadAndSyncsTheServer() async throws {
        let service = TranscriptSpyService()
        let store = makeStore(service)
        await store.sendAndWait("first question")
        await store.sendAndWait("second question")
        XCTAssertEqual(store.session.messages.count, 4)
        let keptPrefix = Array(store.session.messages.prefix(2))
        let edited = store.session.messages[2]

        store.beginEditingMessage(id: edited.id)
        XCTAssertEqual(store.editingMessageID, edited.id)
        XCTAssertNotNil(store.editingNote, "The armed state must say so above the composer")

        await store.sendAndWait("second question, edited")

        XCTAssertNil(store.editingMessageID, "The send consumes the armed edit")
        XCTAssertEqual(
            store.session.messages.map(\.text),
            ["first question", "A reply.", "second question, edited", "A reply."],
            "The thread restarts at the edited message"
        )
        XCTAssertFalse(
            store.session.messages.map(\.id).contains(edited.id),
            "The edited message is replaced, not kept"
        )

        let sync = try XCTUnwrap(service.transcriptCalls.first)
        XCTAssertEqual(service.transcriptCalls.count, 1)
        XCTAssertEqual(sync.sessionID, store.session.id)
        XCTAssertEqual(
            sync.messages.map(\.id), keptPrefix.map(\.id),
            "The server gets exactly the surviving prefix"
        )
    }

    func testEditingTheFirstMessageSendsAnEmptyPrefix() async throws {
        let service = TranscriptSpyService()
        let store = makeStore(service)
        await store.sendAndWait("start over from here")
        let first = store.session.messages[0]

        store.beginEditingMessage(id: first.id)
        await store.sendAndWait("a different opening")

        XCTAssertEqual(store.session.messages.map(\.text), ["a different opening", "A reply."])
        let sync = try XCTUnwrap(service.transcriptCalls.first)
        XCTAssertTrue(sync.messages.isEmpty, "Everything was cut, so the prefix is empty")
    }

    func testCancellingAnArmedEditCutsNothing() async {
        let service = TranscriptSpyService()
        let store = makeStore(service)
        await store.sendAndWait("keep this")
        store.beginEditingMessage(id: store.session.messages[0].id)

        store.cancelEditing()
        await store.sendAndWait("and this")

        XCTAssertNil(store.editingMessageID)
        XCTAssertEqual(store.session.messages.count, 4, "Nothing was removed")
        XCTAssertTrue(service.transcriptCalls.isEmpty, "No cut, no sync")
    }

    func testOnlyTheLearnersOwnTurnsCanBeEdited() async throws {
        let service = TranscriptSpyService()
        let store = makeStore(service)
        await store.sendAndWait("a question")
        let reply = try XCTUnwrap(store.session.messages.first { $0.role == .tutor })

        store.beginEditingMessage(id: reply.id)

        XCTAssertNil(store.editingMessageID, "A tutor row must not arm an edit")
    }

    func testAFailedSyncFailsTheTurnAndTheRetryPaysTheDebt() async throws {
        let service = TranscriptSpyService(acceptsSync: false)
        let store = makeStore(service)
        await store.sendAndWait("first question")
        await store.sendAndWait("second question")
        store.beginEditingMessage(id: store.session.messages[2].id)

        await store.sendAndWait("second question, edited")

        XCTAssertEqual(service.transcriptCalls.count, 1)
        XCTAssertNotNil(store.errorMessage, "A turn must not stream over an unsynced transcript")
        XCTAssertEqual(
            store.session.messages.map(\.text),
            ["first question", "A reply.", "second question, edited"],
            "The cut and the resent turn stand; only the reply is missing"
        )

        service.setAcceptsSync(true)
        store.retryLastRequest()
        await store.awaitActiveRequestForTesting()

        XCTAssertEqual(service.transcriptCalls.count, 2, "The retry re-sends the same cut")
        XCTAssertNil(store.errorMessage)
        XCTAssertEqual(store.session.messages.last?.text, "A reply.")
    }

    func testSwitchingSessionsDisarmsTheEditAndDropsTheDebt() async {
        let service = TranscriptSpyService()
        let store = makeStore(service)
        await store.sendAndWait("in the first session")
        store.beginEditingMessage(id: store.session.messages[0].id)

        store.startNewSession()

        XCTAssertNil(store.editingMessageID, "An armed edit must not follow into another session")
        await store.sendAndWait("in the second session")
        XCTAssertTrue(
            service.transcriptCalls.isEmpty,
            "The put-away session's cut must not land on the new one"
        )
    }

    private func makeStore(_ service: TranscriptSpyService) -> TutorStore {
        TutorStore(
            service: service,
            persistence: SessionPersistence(directoryURL: directory),
            configuration: .stub
        )
    }
}
