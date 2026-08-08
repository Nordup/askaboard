import PencilKit
import XCTest
@testable import MathTutor

/// Board 15a's switcher, and the multi-session store underneath it.
///
/// The store's tests are about the two things a switch can silently corrupt: ink
/// carried from one board onto another, and a turn left streaming into a session
/// nobody is looking at. Neither is visible in the UI until after it has happened.
@MainActor
final class SessionSwitcherTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("sessions-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    // MARK: - What a session is called

    func testASessionWithNothingInItIsCalledNewSession() {
        XCTAssertEqual(LearningSession.empty.title, "New session")
    }

    func testTheTutorsGreetingAloneDoesNotNameASession() {
        var session = LearningSession.empty
        session.messages = [TutorMessage(role: .tutor, text: TutorStore.greeting)]

        XCTAssertEqual(
            session.title,
            "New session",
            "Only the learner's own words name a session — otherwise every session is called the same thing"
        )
    }

    func testAPlanTitleIsCutAtItsFirstBreakInSense() {
        var session = LearningSession.empty
        session.plan = plan(titled: "Radical equations, one careful step at a time")

        XCTAssertEqual(session.title, "Radical equations")
    }

    func testAPlanTitleWithNoBreakIsUsedWhole() {
        var session = LearningSession.empty
        session.plan = plan(titled: "Vectors in 2D")

        XCTAssertEqual(session.title, "Vectors in 2D")
    }

    func testAShortLeadingFragmentDoesNotBecomeTheWholeName() {
        var session = LearningSession.empty
        session.plan = plan(titled: "No, we square both sides first")

        XCTAssertEqual(
            session.title,
            "No, we square both sides first",
            "A two-letter head is not a title; the four-character floor is what stops 'No'"
        )
    }

    func testTheLearnersFirstWordsNameASessionWithNoPlanYet() {
        var session = LearningSession.empty
        session.messages = [
            TutorMessage(role: .tutor, text: TutorStore.greeting),
            TutorMessage(role: .learner, text: "  help me with the quadratic formula  ")
        ]

        XCTAssertEqual(session.title, "help me with the quadratic formula")
    }

    func testAPlanOutranksTheLearnersOpeningLine() {
        var session = LearningSession.empty
        session.messages = [TutorMessage(role: .learner, text: "i dunno, something with roots")]
        session.plan = plan(titled: "Radical equations, one careful step at a time")

        XCTAssertEqual(session.title, "Radical equations")
    }

    func testAPastedHomeworkQuestionIsCutToOneShortLine() {
        var session = LearningSession.empty
        session.messages = [TutorMessage(
            role: .learner,
            text: "Solve the following equation for x and check every candidate\nshow all working"
        )]

        let title = session.title
        XCTAssertTrue(title.hasSuffix("…"), "A long opening line is truncated, not stored whole")
        XCTAssertLessThanOrEqual(title.count, 49, "48 characters plus the ellipsis")
        XCTAssertFalse(title.contains("\n"), "The index must never carry a paragraph")
        XCTAssertTrue(title.hasPrefix("Solve the following equation for x and"))
    }

    func testABlankPlanTitleFallsThroughRatherThanNamingASessionNothing() {
        var session = LearningSession.empty
        session.plan = plan(titled: "   ")
        session.messages = [TutorMessage(role: .learner, text: "circle theorems")]

        XCTAssertEqual(session.title, "circle theorems")
    }

    // MARK: - The store on disk

    func testASavedSessionComesBack() {
        let persistence = SessionPersistence(directoryURL: directory)
        var session = LearningSession.empty
        session.messages = [TutorMessage(role: .learner, text: "vectors")]

        persistence.save(session)

        XCTAssertEqual(persistence.loadCurrent()?.id, session.id)
        XCTAssertEqual(persistence.loadCurrent()?.messages.map(\.text), ["vectors"])
    }

    func testTheIndexListsSessionsMostRecentFirst() {
        let persistence = SessionPersistence(directoryURL: directory)
        let first = LearningSession.empty
        let second = LearningSession.empty
        persistence.save(first)
        persistence.save(second)

        XCTAssertEqual(persistence.loadIndex().sessions.map(\.id), [second.id, first.id])
        XCTAssertEqual(persistence.loadIndex().lastOpened, second.id)
    }

    func testSavingASessionAgainMovesItToTheFrontWithoutDuplicatingIt() {
        let persistence = SessionPersistence(directoryURL: directory)
        let first = LearningSession.empty
        let second = LearningSession.empty
        persistence.save(first)
        persistence.save(second)
        persistence.save(first)

        XCTAssertEqual(persistence.loadIndex().sessions.map(\.id), [first.id, second.id])
    }

    func testLoadCurrentPrefersTheSessionThatWasOpenLast() {
        let persistence = SessionPersistence(directoryURL: directory)
        let first = LearningSession.empty
        let second = LearningSession.empty
        persistence.save(first)
        persistence.save(second)
        persistence.markOpened(first.id)

        XCTAssertEqual(persistence.loadCurrent()?.id, first.id)
    }

    func testLoadCurrentFallsThroughWhenTheLastOpenedSessionIsGone() {
        let persistence = SessionPersistence(directoryURL: directory)
        let kept = LearningSession.empty
        let removed = LearningSession.empty
        persistence.save(kept)
        persistence.save(removed)
        try? FileManager.default.removeItem(
            at: directory.appendingPathComponent("Sessions/\(removed.id.uuidString).json")
        )

        XCTAssertEqual(
            persistence.loadCurrent()?.id,
            kept.id,
            "A missing file must not leave the app with no session when others are right there"
        )
    }

    func testDeletingASessionRemovesItsFileAndItsRow() {
        let persistence = SessionPersistence(directoryURL: directory)
        let kept = LearningSession.empty
        let deleted = LearningSession.empty
        persistence.save(kept)
        persistence.save(deleted)

        persistence.delete(id: deleted.id)

        XCTAssertNil(persistence.load(id: deleted.id))
        XCTAssertEqual(persistence.loadIndex().sessions.map(\.id), [kept.id])
        XCTAssertNil(persistence.loadIndex().lastOpened)
    }

    func testADeletedIndexIsRebuiltFromTheSessionsThemselves() throws {
        let persistence = SessionPersistence(directoryURL: directory)
        let older = LearningSession.empty
        var newer = LearningSession.empty
        newer.lastSavedAt = older.lastSavedAt.addingTimeInterval(60)
        persistence.save(older)
        persistence.save(newer)
        try FileManager.default.removeItem(at: directory.appendingPathComponent("index.json"))

        XCTAssertTrue(persistence.indexNeedsRebuild())
        let rebuilt = persistence.rebuildIndex()

        XCTAssertEqual(
            rebuilt.sessions.map(\.id),
            [newer.id, older.id],
            "The index is a cache; the session files are the record"
        )
        XCTAssertEqual(rebuilt.lastOpened, newer.id)
    }

    // MARK: - The single-session file this replaced

    func testTheOldSessionFileIsMovedIntoTheNewLayout() throws {
        var legacy = LearningSession.empty
        legacy.messages = [TutorMessage(role: .learner, text: "my only session")]
        let legacyURL = directory.appendingPathComponent("session.json")
        try JSONEncoder().encode(legacy).write(to: legacyURL)
        let persistence = SessionPersistence(directoryURL: directory)

        let restored = persistence.loadCurrent()

        XCTAssertEqual(restored?.id, legacy.id)
        XCTAssertEqual(restored?.messages.map(\.text), ["my only session"])
        XCTAssertEqual(persistence.loadIndex().sessions.map(\.id), [legacy.id])
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: legacyURL.path),
            "The legacy file is removed only after the new one is written"
        )
    }

    func testAnUnreadableOldSessionFileIsSetAsideRatherThanRetriedForever() throws {
        let legacyURL = directory.appendingPathComponent("session.json")
        try Data("not json".utf8).write(to: legacyURL)
        let persistence = SessionPersistence(directoryURL: directory)

        XCTAssertNil(persistence.loadCurrent())
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: legacyURL.appendingPathExtension("unreadable").path),
            "Kept, not deleted — a person might still want to recover it by hand"
        )
    }

    // MARK: - Switching

    func testStartingANewSessionKeepsTheOneItLeaves() {
        let store = makeStore()
        store.send("vectors")
        let first = store.session.id

        store.startNewSession()

        XCTAssertNotEqual(store.session.id, first)
        XCTAssertEqual(store.session.title, "New session")
        XCTAssertNotNil(
            SessionPersistence(directoryURL: directory).load(id: first),
            "'New session' is not a destructive action"
        )
    }

    func testOpeningASessionRestoresItsThread() {
        let store = makeStore()
        store.send("vectors")
        let first = store.session.id
        store.startNewSession()
        store.send("quadratics")

        store.openSession(id: first)

        XCTAssertEqual(store.session.id, first)
        XCTAssertTrue(store.session.messages.contains { $0.text == "vectors" })
        XCTAssertFalse(store.session.messages.contains { $0.text == "quadratics" })
    }

    func testOpeningTheSessionAlreadyOpenChangesNothing() {
        let store = makeStore()
        store.send("vectors")
        let id = store.session.id
        let messages = store.session.messages.map(\.text)

        store.openSession(id: id)

        XCTAssertEqual(store.session.id, id)
        XCTAssertEqual(store.session.messages.map(\.text), messages)
    }

    func testASwitchDoesNotCarryTheBoardOntoTheNextSession() throws {
        let store = makeStore()
        store.updateDrawing(inkedDrawing())
        let first = store.session.id

        store.startNewSession()
        store.send("a fresh board")

        let persistence = SessionPersistence(directoryURL: directory)
        XCTAssertNotNil(
            try XCTUnwrap(persistence.load(id: first)).drawingData,
            "The ink drawn before the switch belongs to the session it was drawn on"
        )
        XCTAssertNil(
            try XCTUnwrap(persistence.load(id: store.session.id)).drawingData,
            "A new session opens on an empty board — boardInkData outlives `session` and must be cleared"
        )
    }

    func testTheOpenSessionIsAlwaysTheFirstRowOfTheSwitcher() {
        let store = makeStore()
        store.send("vectors")
        store.startNewSession()

        XCTAssertEqual(store.sessions.first?.id, store.session.id)
        XCTAssertEqual(store.sessions.count, 2)
    }

    func testTheOpenRowIsRenamedBySendingWithoutWaitingForASave() {
        let store = makeStore()
        XCTAssertEqual(store.sessions.first?.title, "New session")

        store.send("circle theorems")

        XCTAssertEqual(store.sessions.first?.title, "circle theorems")
    }

    func testAStaleRowRebuildsTheIndexRatherThanFailing() throws {
        let store = makeStore()
        store.send("vectors")
        let first = store.session.id
        store.startNewSession()
        let current = store.session.id
        try FileManager.default.removeItem(
            at: directory.appendingPathComponent("Sessions/\(first.uuidString).json")
        )

        store.openSession(id: first)

        XCTAssertEqual(store.session.id, current, "The open session is left alone")
        XCTAssertFalse(store.sessions.contains { $0.id == first }, "The row that named nothing is gone")
    }

    // MARK: - Reset

    func testResettingDeletesThisSessionAndLeavesTheOthers() {
        let store = makeStore()
        store.send("vectors")
        let kept = store.session.id
        store.startNewSession()
        store.send("quadratics")
        let discarded = store.session.id

        store.resetSession()

        let persistence = SessionPersistence(directoryURL: directory)
        XCTAssertNil(persistence.load(id: discarded), "Reset is the destructive one")
        XCTAssertNotNil(persistence.load(id: kept), "It is not 'delete everything'")
        XCTAssertNotEqual(store.session.id, discarded)
        XCTAssertEqual(store.session.title, "New session")
    }

    // MARK: - How old a session reads

    func testRelativeAgeSpeaksInTheRowsOwnWords() {
        let now = Date(timeIntervalSince1970: 1_770_000_000)
        let age = { (seconds: TimeInterval) in
            SessionMenu.relativeAge(of: now.addingTimeInterval(-seconds), now: now)
        }

        XCTAssertEqual(age(5), "Now")
        XCTAssertEqual(age(60 * 20), "20m ago")
        XCTAssertEqual(age(60 * 59), "59m ago")
        XCTAssertEqual(
            SessionMenu.relativeAge(of: now.addingTimeInterval(30), now: now),
            "Now",
            "A clock that moved backwards must not produce a negative age"
        )
    }

    // MARK: - Helpers

    private func makeStore() -> TutorStore {
        TutorStore(
            service: DemoTutorService(),
            persistence: SessionPersistence(directoryURL: directory),
            configuration: .stub
        )
    }

    private func plan(titled title: String) -> SessionPlan {
        SessionPlan(title: title, goal: "goal", outcomes: [], steps: ["one"], currentStep: 0)
    }

    private func inkedDrawing() -> PKDrawing {
        let ink = PKInk(.pen, color: .black)
        let points = (0..<8).map { step in
            PKStrokePoint(
                location: CGPoint(x: 100, y: 100 + Double(step) * 6),
                timeOffset: Double(step) * 0.01,
                size: CGSize(width: 3, height: 3),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        return PKDrawing(strokes: [PKStroke(ink: ink, path: PKStrokePath(controlPoints: points, creationDate: Date()))])
    }
}
