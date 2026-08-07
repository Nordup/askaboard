import Combine
import PencilKit
import XCTest
@testable import MathTutor

/// When the board reaches the disk, and what it costs to get there.
///
/// The board reports a change at the frequency of handwriting, and the store used
/// to answer every one of them by re-serializing the whole drawing, re-encoding
/// the whole session and rewriting the file — on the main thread, inside a
/// `@Published` mutation that re-rendered the tutor panel and its whole Markdown
/// thread while the pen was still on the glass. These are the tests that keep that
/// from coming back: not "is it fast" (which is a measurement, not an assertion)
/// but "does writing a stroke touch the disk at all".
@MainActor
final class BoardInkPersistenceTests: XCTestCase {
    private var directory: URL!
    private var fileURL: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("board-ink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        fileURL = directory.appendingPathComponent("session.json")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    // MARK: - The hot path

    func testAStrokeDoesNotReachTheDisk() throws {
        let store = makeStore()

        store.updateDrawing(drawing(strokes: 3))

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: fileURL.path),
            "Writing a stroke must not write the session file: that is the per-stroke disk hit the coalescing exists to remove"
        )
    }

    func testAStrokeDoesNotPublishThroughTheSession() throws {
        let store = makeStore()
        var publishes = 0
        let subscription = store.objectWillChange.sink { _ in publishes += 1 }
        defer { subscription.cancel() }

        for count in 1...12 {
            store.updateDrawing(drawing(strokes: count))
        }

        XCTAssertEqual(
            publishes, 0,
            "Ink must not travel through `@Published session`: every one of these would re-render the panel and its Markdown thread mid-stroke"
        )
    }

    /// What a canvas restores from, and the one thing it is allowed to cost.
    ///
    /// `currentDrawingData` is read from `BoardScreen`'s body, so it must not
    /// serialize — it reports the board as of the last save, and a canvas being
    /// made has no unsaved strokes yet. Both halves are asserted here because the
    /// tempting "fix" for the first is what would undo the whole change.
    func testTheRestorePathNeverSerializesTheBoard() throws {
        let store = makeStore()
        store.updateDrawing(drawing(strokes: 4))

        XCTAssertNil(
            store.currentDrawingData,
            "An unsaved stroke must not be serialized just because a view read this"
        )
        XCTAssertNil(store.session.drawingData, "…and ink must never have gone through `session` at all")

        store.saveBoardInkNow()

        let current = try XCTUnwrap(store.currentDrawingData, "Once saved, it is what a canvas restores")
        XCTAssertEqual(try PKDrawing(data: current).strokes.count, 4)
    }

    // MARK: - When it does reach the disk

    func testTheBoardIsSavedOnceThePenRests() async throws {
        let store = makeStore()

        store.updateDrawing(drawing(strokes: 5))
        try await Task.sleep(for: TutorStore.boardInkRestBeforeSave + .milliseconds(400))

        let saved = try XCTUnwrap(loadSaved(), "The board must be written once the pen has rested")
        let data = try XCTUnwrap(saved.drawingData)
        XCTAssertEqual(try PKDrawing(data: data).strokes.count, 5)
    }

    func testRestingIsMeasuredFromTheLastStrokeNotTheFirst() async throws {
        let store = makeStore()

        // Three strokes inside one rest period is one line of working, and one save.
        store.updateDrawing(drawing(strokes: 1))
        try await Task.sleep(for: .milliseconds(120))
        store.updateDrawing(drawing(strokes: 2))
        try await Task.sleep(for: .milliseconds(120))
        store.updateDrawing(drawing(strokes: 3))

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: fileURL.path),
            "A pause between strokes is not the end of a line: the rest timer restarts"
        )

        try await Task.sleep(for: TutorStore.boardInkRestBeforeSave + .milliseconds(400))
        let saved = try XCTUnwrap(loadSaved())
        XCTAssertEqual(try PKDrawing(data: XCTUnwrap(saved.drawingData)).strokes.count, 3)
    }

    func testLeavingTheForegroundSavesWithoutWaiting() throws {
        let store = makeStore()
        store.updateDrawing(drawing(strokes: 7))

        store.saveBoardInkNow()

        let saved = try XCTUnwrap(loadSaved(), "The scene leaving the foreground must not wait out the rest period")
        XCTAssertEqual(try PKDrawing(data: XCTUnwrap(saved.drawingData)).strokes.count, 7)
    }

    /// The rule that lets every other caller stay ignorant of the coalescing.
    func testAnyOtherSaveCarriesTheBoardWithIt() throws {
        let store = makeStore()
        store.updateDrawing(drawing(strokes: 6))

        // A save that has nothing to do with the board.
        store.setReasoningEffort(.low)

        let saved = try XCTUnwrap(loadSaved())
        XCTAssertEqual(saved.reasoningEffort, .low)
        XCTAssertEqual(
            try PKDrawing(data: XCTUnwrap(saved.drawingData)).strokes.count, 6,
            "Any save must fold in the pen's latest ink, or an unrelated write would persist a stale board"
        )
    }

    func testClearingTheBoardForgetsInkThatWasStillPending() throws {
        let store = makeStore()
        store.updateDrawing(drawing(strokes: 9))

        store.clearDrawing()

        let saved = try XCTUnwrap(loadSaved())
        XCTAssertNil(saved.drawingData, "A cleared board must not be resurrected by a stroke that was still queued")
        XCTAssertNil(store.currentDrawingData)
    }

    func testResettingTheSessionForgetsInkThatWasStillPending() throws {
        let store = makeStore()
        store.updateDrawing(drawing(strokes: 9))

        store.resetSession()

        XCTAssertNil(try XCTUnwrap(loadSaved()).drawingData)
        XCTAssertNil(store.currentDrawingData)
    }

    func testSavingNothingWritesNothing() throws {
        let store = makeStore()

        store.saveBoardInkNow()

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: fileURL.path),
            "A flush with no pending ink is a no-op, so backgrounding an untouched board costs nothing"
        )
    }

    // MARK: - Helpers

    private func makeStore() -> TutorStore {
        TutorStore(service: DemoTutorService(), persistence: SessionPersistence(fileURL: fileURL))
    }

    private func loadSaved() -> LearningSession? {
        SessionPersistence(fileURL: fileURL).load()
    }

    private func drawing(strokes count: Int) -> PKDrawing {
        let ink = PKInk(.pen, color: .black)
        return PKDrawing(strokes: (0..<count).map { index in
            let points = (0..<8).map { step in
                PKStrokePoint(
                    location: CGPoint(x: 100 + Double(index) * 30, y: 100 + Double(step) * 6),
                    timeOffset: Double(step) * 0.008,
                    size: CGSize(width: 5, height: 5),
                    opacity: 1,
                    force: 1,
                    azimuth: 0,
                    altitude: .pi / 2
                )
            }
            return PKStroke(
                ink: ink,
                path: PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: 0))
            )
        })
    }
}
