import XCTest
import os
@testable import MathTutor

/// Records the ids the store asks the backend to close.
///
/// A spy rather than a network stub because the thing worth pinning down is
/// which sessions leave the device and when — `BackendTutorService` owns the
/// URL and is tested against it separately.
final class ClosingSpyService: TutorService, Sendable {
    private let closedIDs = OSAllocatedUnfairLock<[UUID]>(initialState: [])
    private let holdsTurnOpen: Bool
    private let onClose: (@Sendable () -> Void)?

    /// - Parameter holdsTurnOpen: When true, `stream(_:)` never finishes, so a
    ///   turn started against this service is still in flight when the test
    ///   switches away from it.
    init(holdsTurnOpen: Bool = false, onClose: (@Sendable () -> Void)? = nil) {
        self.holdsTurnOpen = holdsTurnOpen
        self.onClose = onClose
    }

    var closed: [UUID] { closedIDs.withLock { $0 } }

    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        AsyncThrowingStream { continuation in
            guard !holdsTurnOpen else { return }
            continuation.yield(.done)
            continuation.finish()
        }
    }

    func closeSession(id: UUID) async {
        closedIDs.withLock { $0.append(id) }
        onClose?()
    }
}

/// What the device tells the backend when the learner leaves a session.
///
/// Every assertion here is about a permanent consequence: a close freezes the
/// server's transcript into the one `Episode` that session will ever have
/// (`uq_episodes_session`), so a close sent at the wrong moment cannot be
/// taken back, and one never sent costs the learner their memory of that
/// session until the server's next sweep.
@MainActor
final class SessionCloseTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("MathTutorTests-close-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testStartingANewSessionTellsTheBackendTheOldOneIsOver() async {
        let sent = expectation(description: "close sent")
        let service = ClosingSpyService(onClose: { sent.fulfill() })
        let store = makeStore(service)
        await store.sendAndWait("what is 2/3 + 1/4")
        let left = store.session.id

        store.startNewSession()

        await fulfillment(of: [sent], timeout: 2)
        XCTAssertEqual(service.closed, [left])
        XCTAssertNotEqual(store.session.id, left, "The new session must not be closed too")
    }

    func testOpeningAnotherSessionClosesTheOneItLeaves() async {
        let sent = expectation(description: "both closes sent")
        // Two sessions are left over the course of this test: the first when
        // `startNewSession` moves off it, the second when `openSession` moves
        // back. Waiting on only one of them would leave the other's `fulfill`
        // to fire after this test had finished, where XCTest reports it as an
        // API violation against whichever test is unlucky enough to be running.
        sent.expectedFulfillmentCount = 2
        let service = ClosingSpyService(onClose: { sent.fulfill() })
        let store = makeStore(service)
        await store.sendAndWait("fractions please")
        let first = store.session.id
        store.startNewSession()
        await store.sendAndWait("actually, geometry")
        let second = store.session.id

        store.openSession(id: first)

        await fulfillment(of: [sent], timeout: 2)
        XCTAssertEqual(
            service.closed, [first, second],
            "Each switch ends the session being left, and neither the one arrived at"
        )
    }

    func testResettingClosesTheSessionItDeletes() async {
        let sent = expectation(description: "close sent")
        let service = ClosingSpyService(onClose: { sent.fulfill() })
        let store = makeStore(service)
        await store.sendAndWait("check my working")
        let deleted = store.session.id

        store.resetSession()

        await fulfillment(of: [sent], timeout: 2)
        XCTAssertEqual(
            service.closed, [deleted],
            """
            The server keeps its own transcript and the abandoned-session sweep \
            would reach it within the day regardless, so not closing would only \
            make a deleted session remembered later, never unremembered
            """
        )
    }

    func testASessionNobodySpokeInIsNotClosed() async {
        let service = ClosingSpyService()
        let store = makeStore(service)

        store.startNewSession()

        await settle()
        XCTAssertEqual(
            service.closed, [],
            """
            A turn is the only thing that creates the session server-side, so \
            closing one that never had a turn earns a 404 that is supposed to \
            mean the device sent the wrong id
            """
        )
    }

    func testOpeningTheSessionAlreadyOpenClosesNothing() async {
        let service = ClosingSpyService()
        let store = makeStore(service)
        await store.sendAndWait("hello")

        store.openSession(id: store.session.id)

        await settle()
        XCTAssertEqual(service.closed, [], "Nobody left a session, so none ended")
    }

    func testASessionIsNotClosedWhileItsTurnIsStillRunning() async {
        let service = ClosingSpyService(holdsTurnOpen: true)
        let store = makeStore(service)
        store.send("this reply never arrives")
        XCTAssertTrue(store.isLoading, "The turn has to be genuinely in flight")

        store.startNewSession()

        await settle()
        XCTAssertEqual(
            service.closed, [],
            """
            The server may still be writing the reply, and `_record_episode` \
            snapshots whatever it finds — permanently. Late and whole beats \
            now and torn
            """
        )
    }

    func testASessionIsClosedOnceItsTurnHasFinished() async {
        let sent = expectation(description: "close sent")
        let service = ClosingSpyService(onClose: { sent.fulfill() })
        let store = makeStore(service)
        await store.sendAndWait("a turn that completes")
        XCTAssertFalse(store.isLoading, "The turn is done")

        store.startNewSession()

        await fulfillment(of: [sent], timeout: 2)
        XCTAssertEqual(
            service.closed.count, 1,
            """
            `activeRequestTask` survives a completed turn, so a guard reading \
            it instead of `isLoading` would suppress every close a real \
            session ever earns
            """
        )
    }

    func testABuildWithNoBackendClosesNothing() async {
        let service = ClosingSpyService()
        let store = TutorStore(
            service: service,
            persistence: SessionPersistence(directoryURL: directory),
            configuration: nil
        )
        store.send("into the void")

        store.startNewSession()

        await settle()
        XCTAssertEqual(service.closed, [], "There is no backend holding a transcript to close")
    }

    // MARK: - Helpers

    private func makeStore(_ service: ClosingSpyService) -> TutorStore {
        TutorStore(
            service: service,
            persistence: SessionPersistence(directoryURL: directory),
            configuration: .stub
        )
    }

    /// Gives the detached close task room to run before asserting it did not.
    ///
    /// A negative assertion made in the same tick would pass whether the guard
    /// works or not, which is the one way these tests could be worthless.
    private func settle() async {
        try? await Task.sleep(for: .milliseconds(250))
    }
}
