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

    /// **A deleted session takes its sidecar with it.** The thumbnails of everything the
    /// learner attached are the one part of a session that is not in its file, and nothing
    /// else ever removes them — so a session deleted without them leaves a photo of a
    /// child's homework on disk forever.
    ///
    /// Untestable until `delete(id:)` stopped building an `AttachmentStore()` of its own:
    /// that default resolves to the real Application Support directory whatever this
    /// persistence was pointed at, so this test would have deleted from — and written
    /// `bySession.json` into — the user's own data while asserting nothing.
    func testDeletingASessionTakesItsAttachmentThumbnailsWithIt() {
        let persistence = SessionPersistence(directoryURL: directory)
        let doomed = LearningSession.empty
        let survivor = LearningSession.empty
        persistence.save(doomed)
        persistence.save(survivor)
        let dropped = UUID()
        let kept = UUID()
        persistence.attachmentStore.save(Data("worksheet".utf8), for: dropped, in: doomed.id)
        persistence.attachmentStore.save(Data("still here".utf8), for: kept, in: survivor.id)

        persistence.delete(id: doomed.id)

        XCTAssertNil(persistence.attachmentStore.thumbnail(for: dropped))
        XCTAssertEqual(
            persistence.attachmentStore.thumbnail(for: kept),
            Data("still here".utf8),
            "Deleting one session must not touch another's files"
        )
    }

    /// And the sidecar lands *inside* the directory this store was given, which is the
    /// property that makes the test above mean anything: a store pointed at a temporary
    /// directory must not reach into Application Support to find its thumbnails.
    func testTheAttachmentSidecarSitsUnderThePersistencesOwnDirectory() {
        let scoped = SessionPersistence(directoryURL: directory)

        XCTAssertTrue(
            scoped.attachmentStore.directoryURL.path.hasPrefix(directory.path),
            "Expected the sidecar under \(directory.path), got \(scoped.attachmentStore.directoryURL.path)"
        )
        XCTAssertNotEqual(
            scoped.attachmentStore.directoryURL,
            AttachmentStore().directoryURL,
            "A store pointed at a temporary directory must not reach into Application Support"
        )
        // And the app's own store is exactly where it always was: deriving the sidecar
        // from `directoryURL` has to be a seam, not a move of the user's files.
        XCTAssertEqual(
            SessionPersistence().attachmentStore.directoryURL,
            AttachmentStore().directoryURL
        )
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

    func testANewSessionIsListedAndIsTheMostRecent() {
        let store = makeStore()
        store.send("vectors")
        store.startNewSession()

        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertEqual(
            store.sessions.first?.id,
            store.session.id,
            "A session made a moment ago is the most recent one — by date, not because it is open"
        )
    }

    func testOpeningAnOlderSessionLeavesItWhereItsDatePutsIt() async {
        let store = makeStore()
        await store.sendAndWait("older")
        let older = store.session.id
        store.startNewSession()
        await store.sendAndWait("newer")
        let newer = store.session.id

        store.openSession(id: older)

        XCTAssertEqual(
            store.sessions.map(\.id),
            [newer, older],
            "Selecting a chat must not haul it to the top of the switcher — the tint says which one is open"
        )
        XCTAssertEqual(store.session.id, older)
    }

    func testTheOpenRowIsRenamedBySendingWithoutWaitingForASave() {
        let store = makeStore()
        let openRow = { store.sessions.first { $0.id == store.session.id } }
        XCTAssertEqual(openRow()?.title, "New session")

        store.send("circle theorems")

        XCTAssertEqual(openRow()?.title, "circle theorems")
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

    // MARK: - "Last modified" means modified

    func testJustOpeningASessionDoesNotAgeIt() async throws {
        let persistence = SessionPersistence(directoryURL: directory)
        let store = makeStore()
        await store.sendAndWait("vectors")
        let looked = store.session.id
        store.startNewSession()
        let savedAt = try XCTUnwrap(persistence.load(id: looked)).lastSavedAt

        store.openSession(id: looked)
        store.startNewSession()

        XCTAssertEqual(
            try XCTUnwrap(persistence.load(id: looked)).lastSavedAt,
            savedAt,
            "Reading a session is not editing it — switching away must not restamp the clock"
        )
    }

    func testJustOpeningASessionDoesNotFloatItUpTheList() async {
        let persistence = SessionPersistence(directoryURL: directory)
        let store = makeStore()
        await store.sendAndWait("older")
        let older = store.session.id
        store.startNewSession()
        await store.sendAndWait("newer")
        let newer = store.session.id
        XCTAssertEqual(persistence.loadIndex().sessions.map(\.id), [newer, older])

        // Glance at the old one and go back — switching away with
        // `startNewSession` would mint a third session and prove nothing.
        store.openSession(id: older)
        store.openSession(id: newer)

        XCTAssertEqual(
            persistence.loadIndex().sessions.map(\.id),
            [newer, older],
            "The list is ordered by when a session was worked on, not when it was last glanced at"
        )
    }

    func testActuallyEditingASessionAgesIt() async throws {
        let persistence = SessionPersistence(directoryURL: directory)
        let store = makeStore()
        await store.sendAndWait("vectors")
        let edited = store.session.id
        store.startNewSession()
        let before = try XCTUnwrap(persistence.load(id: edited)).lastSavedAt

        store.openSession(id: edited)
        await store.sendAndWait("one more question")
        store.startNewSession()

        XCTAssertGreaterThan(
            try XCTUnwrap(persistence.load(id: edited)).lastSavedAt,
            before
        )
    }

    func testInkDrawnAfterOpeningAgesTheSession() async throws {
        let persistence = SessionPersistence(directoryURL: directory)
        let store = makeStore()
        await store.sendAndWait("vectors")
        let edited = store.session.id
        store.startNewSession()
        let before = try XCTUnwrap(persistence.load(id: edited)).lastSavedAt

        store.openSession(id: edited)
        store.updateDrawing(inkedDrawing())
        store.startNewSession()

        let after = try XCTUnwrap(persistence.load(id: edited))
        XCTAssertGreaterThan(after.lastSavedAt, before)
        XCTAssertNotNil(after.drawingData, "and the ink is the thing that aged it")
    }

    func testAWorkspaceToggleIsNotAnEdit() async throws {
        let persistence = SessionPersistence(directoryURL: directory)
        let store = makeStore()
        await store.sendAndWait("vectors")
        store.applyForTesting(plan: plan(titled: "Vectors in 2D"), exercise: .radicalEquation)
        let id = store.session.id
        store.startNewSession()
        store.openSession(id: id)
        let before = try XCTUnwrap(persistence.load(id: id)).lastSavedAt

        store.startWorking()
        store.returnToChat()

        XCTAssertEqual(
            try XCTUnwrap(persistence.load(id: id)).lastSavedAt,
            before,
            "isWorkspace is not on LearningSession, so nothing a reload would restore has changed"
        )
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
            SessionsDrawer.relativeAge(of: now.addingTimeInterval(-seconds), now: now)
        }

        XCTAssertEqual(age(5), "Now")
        XCTAssertEqual(age(60 * 20), "20m ago")
        XCTAssertEqual(age(60 * 59), "59m ago")
        XCTAssertEqual(
            SessionsDrawer.relativeAge(of: now.addingTimeInterval(30), now: now),
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
