import Combine
import Foundation
import XCTest
@testable import MathTutor

/// The whiteboard camera's persistence contract: nothing on the hot path is
/// published or written, the rest-save and the flush both land on disk, and a
/// session switch can never carry one board's viewport onto another.
@MainActor
final class CameraPersistenceTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("camera-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    private var sessionFilesExist: Bool {
        let sessions = directory.appendingPathComponent("Sessions")
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: sessions.path)) ?? []
        return !contents.isEmpty
    }

    private func makeStore() -> TutorStore {
        TutorStore(
            service: DemoTutorService(),
            persistence: SessionPersistence(directoryURL: directory),
            configuration: .stub
        )
    }

    private func loadSaved() -> LearningSession? {
        SessionPersistence(directoryURL: directory).loadCurrent()
    }

    private func camera(
        x: CGFloat = 27_000,
        y: CGFloat = 33_000,
        zoom: CGFloat = 1.4
    ) -> BoardCamera {
        BoardCamera(center: CGPoint(x: x, y: y), zoomScale: zoom)
    }

    // MARK: - The hot path

    func testACameraChangeDoesNotReachTheDiskImmediately() {
        let store = makeStore()

        store.updateCamera(camera())

        XCTAssertFalse(
            sessionFilesExist,
            "A camera report must not write the session on the main thread at gesture frequency"
        )
    }

    func testACameraChangeDoesNotPublishThroughTheSession() {
        let store = makeStore()
        var publishes = 0
        let subscription = store.objectWillChange.sink { _ in publishes += 1 }
        defer { subscription.cancel() }

        for index in 0..<12 {
            store.updateCamera(camera(x: 27_000 + CGFloat(index) * 40, y: 33_000))
        }

        XCTAssertEqual(
            publishes, 0,
            "Camera reports are gesture-frequency state and must not re-render every observer of the store"
        )
    }

    // MARK: - When it reaches the disk

    func testTheCameraIsSavedOnceTheBoardRests() async throws {
        let store = makeStore()
        store.updateCamera(camera(zoom: 0.9))

        try await Task.sleep(for: TutorStore.boardCameraRestBeforeSave + .milliseconds(400))

        XCTAssertEqual(
            try XCTUnwrap(loadSaved()).boardCamera,
            camera(zoom: 0.9)
        )
    }

    func testRestingIsMeasuredFromTheLastMoveNotTheFirst() async throws {
        let store = makeStore()

        store.updateCamera(camera(x: 27_000))
        try await Task.sleep(for: .milliseconds(120))
        store.updateCamera(camera(x: 27_400))
        try await Task.sleep(for: .milliseconds(120))
        store.updateCamera(camera(x: 27_800))

        XCTAssertFalse(
            sessionFilesExist,
            "A pause between movement is not the end of a pan; the rest timer restarts"
        )

        try await Task.sleep(for: TutorStore.boardCameraRestBeforeSave + .milliseconds(400))

        XCTAssertEqual(
            try XCTUnwrap(loadSaved()).boardCamera,
            camera(x: 27_800)
        )
    }

    func testLeavingTheForegroundSavesWithoutWaiting() throws {
        let store = makeStore()
        let unchangedDate = store.session.lastSavedAt
        store.updateCamera(camera())

        store.saveBoardStateNow()

        let saved = try XCTUnwrap(loadSaved())
        XCTAssertEqual(saved.boardCamera, camera())
        XCTAssertEqual(saved.lastSavedAt, unchangedDate)
    }

    func testCameraRestSaveDoesNotChangeTheLastModifiedDate() async throws {
        let store = makeStore()
        let unchangedDate = store.session.lastSavedAt
        store.updateCamera(camera(zoom: 0.9))

        try await Task.sleep(for: TutorStore.boardCameraRestBeforeSave + .milliseconds(400))

        let saved = try XCTUnwrap(loadSaved())
        XCTAssertEqual(saved.boardCamera, camera(zoom: 0.9))
        XCTAssertEqual(saved.lastSavedAt, unchangedDate)
    }

    /// The rule that lets every other caller stay ignorant of the coalescing.
    func testAnyOtherSaveCarriesTheCameraWithIt() throws {
        let store = makeStore()
        store.updateCamera(camera())

        store.setReasoningEffort(.low)

        let saved = try XCTUnwrap(loadSaved())
        XCTAssertEqual(saved.reasoningEffort, .low)
        XCTAssertEqual(
            saved.boardCamera,
            camera(),
            "Any save must fold in the latest camera, or an unrelated write would persist a stale viewport"
        )
    }

    func testSavingNothingWritesNothing() {
        let store = makeStore()

        store.saveBoardStateNow()

        XCTAssertFalse(
            sessionFilesExist,
            "A flush with no pending board state is a no-op, so backgrounding an untouched board costs nothing"
        )
    }

    // MARK: - Session isolation

    func testASwitchSavesTheCameraIntoTheSessionItWasMovedIn() async throws {
        let store = makeStore()
        let first = store.session.id
        let unchangedDate = store.session.lastSavedAt
        store.updateCamera(camera())

        store.startNewSession()

        let savedFirst = try XCTUnwrap(SessionPersistence(directoryURL: directory).load(id: first))
        XCTAssertEqual(savedFirst.boardCamera, camera())
        XCTAssertEqual(savedFirst.lastSavedAt, unchangedDate)
        XCTAssertNil(
            try XCTUnwrap(loadSaved()).boardCamera,
            "The new session opens on a fresh board — the pending camera outlives `session` and must be cleared"
        )
    }

    func testOpeningASessionRestoresItsOwnCamera() throws {
        let store = makeStore()
        let first = store.session.id
        store.updateCamera(camera(zoom: 1.8))
        store.startNewSession()

        store.openSession(id: first)

        XCTAssertEqual(
            store.session.boardCamera,
            camera(zoom: 1.8),
            "A session is restored with the camera it was left at, not the one of the session before it"
        )
    }

    func testResettingTheSessionForgetsAPendingCamera() throws {
        let store = makeStore()
        store.updateCamera(camera())

        store.resetSession()

        XCTAssertNil(try XCTUnwrap(loadSaved()).boardCamera)
    }

    func testSavingWithoutAMoveIsNotAnEdit() throws {
        let store = makeStore()
        store.send("vectors")
        store.startNewSession()
        let id = store.session.id
        store.openSession(id: id)
        let before = try XCTUnwrap(SessionPersistence(directoryURL: directory).load(id: id)).lastSavedAt

        store.saveBoardStateNow()

        XCTAssertEqual(
            try XCTUnwrap(SessionPersistence(directoryURL: directory).load(id: id)).lastSavedAt,
            before,
            "A camera that has never moved is nil on the session, so flushing it is not an edit"
        )
    }

    func testCameraFoldedIntoARealEditStillAdvancesTheLastModifiedDate() async throws {
        let store = makeStore()
        store.setReasoningEffort(.low)
        let before = try XCTUnwrap(loadSaved()).lastSavedAt
        try await Task.sleep(for: .milliseconds(20))

        store.updateCamera(camera())
        store.setReasoningEffort(.high)

        let saved = try XCTUnwrap(loadSaved())
        XCTAssertEqual(saved.boardCamera, camera())
        XCTAssertEqual(saved.reasoningEffort, .high)
        XCTAssertGreaterThan(saved.lastSavedAt, before)
    }
}
