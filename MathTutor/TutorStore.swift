import Foundation
import OSLog
import PencilKit
import SwiftUI

@MainActor
final class TutorStore: ObservableObject {
    @Published private(set) var session: LearningSession
    /// The switcher's rows, most-recently-modified first — and nothing else.
    ///
    /// The open session gets no special place in the order. It used to be
    /// pinned to the front, which meant selecting an old chat visibly hauled it
    /// to the top of the menu even once the stored order had stopped moving.
    /// Which session you are in is said by the row's tint and its "Open" label,
    /// not by where it sits. See `refreshSessions()`.
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    /// One line above the composer: a send that never left the device.
    ///
    /// Board 15 §02's note slot, not the thread's failure state, and the
    /// difference is which of the two is true. `errorMessage` is a turn that was
    /// sent and went wrong — there is a turn in the thread for it to be about,
    /// and a retry to offer. This is the other case: nothing was sent, nothing
    /// was consumed, and the composer still holds exactly what it held a moment
    /// ago. Saying that in the thread would draw a failure against a turn that
    /// does not exist.
    @Published private(set) var composerNote: String?
    @Published private(set) var isWorkspace = false
    @Published private(set) var evaluationText: String?
    /// Identifies the tutor turn currently shown in the transient highlighted
    /// feedback card. The same turn remains in `session.messages` for history.
    @Published private(set) var evaluationMessageID: UUID? = nil
    @Published private(set) var isEvaluating = false
    @Published private(set) var usesLiveTutor = false
    /// The tutor's current stage within an in-flight turn ("thinking",
    /// "writing", …), for a status line. `nil` whenever no turn is running —
    /// set from each `.status` event and cleared the moment a turn ends,
    /// whether that is a clean `.done`, a `.failure`, or a thrown error.
    @Published private(set) var phase: TutorPhase?

    /// Where a turn gets the learner's board from, set by whichever screen owns
    /// the live canvas.
    ///
    /// A closure rather than a `CanvasCapture` reference because the store
    /// deliberately knows nothing about PencilKit or about which screen is up:
    /// the board belongs to the canvas, the canvas belongs to `BoardScreen`, and
    /// this is the one hole through which the two meet. It is also why this is
    /// not a parameter on `send` — the board has to ride along on *every* turn,
    /// including the ones no caller passes an image to (a suggestion chip, a
    /// retry, "I don't know"), and threading it through each of those is how it
    /// would come to be missing from one of them again.
    ///
    /// `nil` means no board is on screen, which is a real state: Settings is up,
    /// or nothing has mounted a canvas yet.
    var boardProvider: (@MainActor () -> Data?)?

    /// The device's account of where the ink sits, sent alongside the overview.
    var boardManifestProvider: (@MainActor () -> String?)?

    /// The device's compact board-state context (coordinate system, visible
    /// logical rect, learner ink bounds/clusters, exact tutor scene), sent on
    /// every turn under the request's `board_scene` field.
    var boardSceneProvider: (@MainActor () -> String?)?

    /// The region the learner marqueed and sent, keyed by the message that
    /// carried it.
    ///
    /// This is a different claim from the activity trail: this is what the
    /// *learner* pointed at, and it belongs on the learner's own turn. Held
    /// here rather than on `TutorMessage` because a `TutorMessage` is
    /// `Codable` and goes into the session's file on every save, and this is
    /// a PNG — every later save would rewrite it. A thread reloaded from disk
    /// shows the reply without the picture, which is the honest outcome: it
    /// was never saved.
    @Published private(set) var selectionViews: [UUID: BoardView] = [:]

    /// The learner message an armed Edit will rewrite — set by the thread's
    /// long-press menu, shown as a note above the composer, and consumed by
    /// the next send.
    ///
    /// Arming destroys nothing: the cut happens inside the send, in
    /// `consumePendingEdit()`, so backing out costs nothing. Clearing the
    /// composer is the cancel gesture — the natural way to abandon a
    /// pre-filled draft — and `BoardScreen` watches its own field for it,
    /// because the draft is the screen's state, not the store's.
    @Published private(set) var editingMessageID: UUID?

    /// What the server's transcript must become before the next turn goes
    /// out — the thread as it stands after an edit's cut, snapshotted at the
    /// moment of the cut.
    ///
    /// Held until a `replaceTranscript` call *succeeds*, not merely until one
    /// is attempted: the sync and the turn fail together (same network), and
    /// the retry chip re-runs `requestTutor`, which is where the debt is
    /// paid. Not persisted — an app killed between a failed sync and its
    /// retry leaves the stale tail on the server until the session's next
    /// successful edit, which the design doc accepts as rare.
    ///
    /// **Keyed by session.** It used to be one slot and was cleared on every
    /// switch, which was correct while only the visible session could accrue a
    /// debt. A live call writes into its own session from anywhere now, so each
    /// session's unpaid cut waits for that session's own next turn.
    private var pendingTranscriptSync: [UUID: [TutorMessage]] = [:]

    let tutorService: any TutorService
    let persistence: SessionPersistence
    /// Where a sent attachment's thumbnail goes. Injected for the reason
    /// `persistence` is: a test that sent a file used to write into the real
    /// Application Support directory, which is the user's own data.
    let attachmentStore: AttachmentStore
    /// Where a board crop the tutor looked at goes. Injected for the same
    /// reason `attachmentStore` is: a test must never write into the real
    /// Application Support directory.
    let boardCropStore: BoardCropStore
    let keychain: KeychainStore
    /// `--ui-test-reset`. The switcher lists only the session in memory, so a UI
    /// test never sees — or opens — whatever real sessions are on the machine
    /// running it. The launch already starts on an empty session; this is the
    /// same promise extended to the list beside it.
    private let startsClean: Bool
    private let logger = Logger(subsystem: "com.nordup.MathTutor", category: "TutorStore")
    /// The in-flight turn's task, kept only so tests can await exactly the
    /// turn a `send`/`evaluate`/etc. call just started rather than polling.
    private var activeRequestTask: Task<Void, Never>?

    /// - Parameter configuration: What this build can reach, resolved once at
    ///   launch because nothing in the app can change it afterwards — the
    ///   address is a constant and the token is compiled in. An explicit
    ///   parameter rather than a call to `BackendConfiguration.load()` in the
    ///   body so a test can state "this store is live" without depending on
    ///   whether the machine running it happens to have a token compiled in.
    init(
        service: any TutorService = TutorServiceRouter(),
        persistence: SessionPersistence = SessionPersistence(),
        attachmentStore: AttachmentStore = AttachmentStore(),
        boardCropStore: BoardCropStore = BoardCropStore(),
        keychain: KeychainStore = KeychainStore(),
        configuration: BackendConfiguration? = BackendConfiguration.load()
    ) {
        #if DEBUG
        // The offline tutor is available only when a test/debug launch opts into it
        // explicitly. Production/default launches must reach the real backend
        // instead of silently routing around it.
        let useDebugDemo = ProcessInfo.processInfo.arguments.contains("--demo-tutor")
            || ProcessInfo.processInfo.arguments.contains("--ui-test-demo-service")
            || ProcessInfo.processInfo.arguments.contains(E2ESeedFixture.launchArgument)
            || ProcessInfo.processInfo.arguments.contains(E2ESeedFixture.sceneLaunchArgument)
        let resolvedService: any TutorService = useDebugDemo && service is TutorServiceRouter
            ? DemoTutorService()
            : service
        self.tutorService = resolvedService
        #else
        let resolvedService: any TutorService = service
        self.tutorService = service
        #endif
        self.persistence = persistence
        self.attachmentStore = attachmentStore
        self.boardCropStore = boardCropStore
        self.keychain = keychain
        // Runs on every launch, release included. Two accounts to clear and
        // neither is ever read now: the client-side OpenAI key from before the
        // backend existed, and the device token from when it was seeded at
        // launch instead of compiled in. A credential the app has stopped
        // sending anywhere must not sit in the Keychain forever.
        keychain.migrateAwayFromStoredCredentials()
        let isUITestReset = ProcessInfo.processInfo.arguments.contains("--ui-test-reset")
        #if DEBUG
        let shouldSeedE2E = ProcessInfo.processInfo.arguments.contains(E2ESeedFixture.launchArgument)
        let shouldSeedScene = ProcessInfo.processInfo.arguments.contains(E2ESeedFixture.sceneLaunchArgument)
        let shouldSeedRecentSessions = ProcessInfo.processInfo.arguments.contains(
            E2ESeedFixture.recentSessionsLaunchArgument
        )
#else
        let shouldSeedE2E = false
        let shouldSeedScene = false
        let shouldSeedRecentSessions = false
#endif
        self.startsClean = isUITestReset
        let stored = isUITestReset ? nil : persistence.loadCurrent()
        var restored = stored ?? .empty
        #if DEBUG
        if shouldSeedE2E { E2ESeedFixture.seedSession(&restored) }
        if shouldSeedScene { E2ESeedFixture.seedScene(&restored) }
        if shouldSeedRecentSessions {
            E2ESeedFixture.seedRecentSessions(open: &restored, into: persistence)
        }
        #endif
        self.session = restored
        // The comparison baseline for whether a save represents learner work.
        // It exists even for a brand-new session that has no file yet: camera
        // movement must be able to create that file without turning the move
        // into a "last changed" event.
        self.lastModificationBaseline = restored
        // What is already on disk, so launching and quitting without touching
        // anything writes nothing and moves no clocks. `nil` whenever the
        // session in hand is *not* what the file holds — nothing stored, or a
        // seeded fixture — because then the first save has real work to do.
        self.lastWritten = (stored != nil && !shouldSeedE2E && !shouldSeedScene && !shouldSeedRecentSessions)
            ? restored
            : nil
        self.usesLiveTutor = configuration != nil
        let usingDemoService = resolvedService is DemoTutorService
        self.isWorkspace = restored.plan != nil && restored.exercise != nil && (self.usesLiveTutor || usingDemoService)
        if shouldSeedE2E || shouldSeedScene || shouldSeedRecentSessions {
            persistence.save(restored)
        }
        refreshSessions()
        if shouldSeedRecentSessions {
            // In-memory rows, straight from the fixture, so the drawer lists exactly the two
            // fixture sessions regardless of what a previous run left on disk.
            sessions = E2ESeedFixture.recentSessionSummaries(open: restored)
                .sorted { $0.lastSavedAt > $1.lastSavedAt }
        }
    }

    /// Whether this session has started — the one question that decides between
    /// the greeting and the thread, at launch (`RootView`) and on every session
    /// switch (`TutorPanel.adoptSessionUI`).
    ///
    /// **A learner turn counts if it has words *or* files.** A photographed
    /// worksheet sent with nothing typed is a complete turn, so a session can
    /// hold a real exchange and no learner text at all — and asking about text
    /// alone drew the orb, the greeting and the suggestion chips straight over
    /// that exchange the next time the app was launched.
    ///
    /// Deliberately a different question from `requestTutor`'s `goal:`, which
    /// stays text-only and correctly so: that one is *what the learner said they
    /// want*, and a photo is not an answer to it.
    var hasGoal: Bool {
        session.plan != nil || session.messages.contains { message in
            guard message.role == .learner else { return false }
            return !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !message.attachments.isEmpty
        }
    }

    /// True only for an explicitly injected/debug demo service. An unreachable
    /// backend on the production router is a failure, not an offline demo mode.
    var demoMode: Bool { tutorService is DemoTutorService }

    private var canRequestTutor: Bool { demoMode || usesLiveTutor }

    /// One learner turn, with whatever the composer's `+` put on it.
    ///
    /// **A turn may now be files and no words at all** — a photographed
    /// worksheet is a complete request, the same way a lassoed region already
    /// was — so the emptiness guard asks about the draft rather than about the
    /// text.
    ///
    /// **Returns whether the turn was accepted**, and this is load-bearing: the
    /// caller clears the composer's draft — the words *and* the uploaded files —
    /// on a `true` and on nothing else. It used to return `Void` and decline
    /// silently, so a learner who tapped send while the tutor was still writing
    /// had their photo cancelled and discarded for a turn that was never sent.
    /// Reading `isLoading` at the call site instead would be the same decision
    /// made twice; this is the method that owns it.
    ///
    /// The two refusals differ in who says so. A turn already in flight is the
    /// composer's note — nothing was sent, nothing was consumed, and there is no
    /// turn in the thread for a failure to be about. An unreachable tutor is
    /// `ensureTutorAvailable`'s `errorMessage`, which the thread already draws.
    @discardableResult
    func send(_ text: String, attachments: [UploadedAttachment] = []) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return false }
        // `isBusy`, not `isLoading`: a call in another session can have a
        // delegated turn running that this thread cannot see. One turn at a
        // time is a property of the pipeline, not of what is on screen.
        guard !isBusy else {
            composerNote = Self.tutorIsStillAnswering
            return false
        }
        guard ensureTutorAvailable() else { return false }
        consumePendingEdit()
        session.messages.append(
            TutorMessage(role: .learner, text: trimmed, attachments: attachments.map(\.attachment))
        )
        saveThumbnails(for: attachments)
        session.lastSavedAt = .now
        persist()
        requestTutor(signal: nil, attachmentIDs: attachments.map(\.attachment.id))
        return true
    }

    /// Board 15's register for a declined send: what happened, and what to do
    /// about it. No apology and no error code — the draft is still in the
    /// composer, so trying again is one tap once the reply lands.
    static let tutorIsStillAnswering = "The tutor is still answering. Send this when it's finished."

    /// Keeps the chips a reopened session draws.
    ///
    /// Written **now rather than at upload time**: an attachment the learner
    /// removed before sending should leave nothing behind on disk. Unlike
    /// `selectionViews`, these cannot be re-derived from anything the device
    /// still holds — a photo of homework is not a crop of the board — which is
    /// why they go to a file at all.
    private func saveThumbnails(for attachments: [UploadedAttachment]) {
        guard !attachments.isEmpty else { return }
        for uploaded in attachments {
            attachmentStore.save(uploaded.thumbnail, for: uploaded.attachment.id, in: session.id)
        }
    }

    func sendQuickPrompt(_ text: String) {
        send(text)
    }

    #if DEBUG
    /// Test-only: sends and then awaits the exact turn `send` just started,
    /// rather than a fixed-length poll — so a test fails on genuine hangs
    /// instead of racing an arbitrary timeout.
    @discardableResult
    func sendAndWait(_ text: String, attachments: [UploadedAttachment] = []) async -> Bool {
        let accepted = send(text, attachments: attachments)
        await activeRequestTask?.value
        return accepted
    }

    /// Test-only: awaits the turn currently in flight, for the callers that
    /// start one without going through `send` — `evaluate`, and a retry. Same
    /// reasoning as `sendAndWait`: await the exact turn rather than sleep for a
    /// length of time that is either wrong or flaky.
    func awaitActiveRequestForTesting() async {
        await activeRequestTask?.value
    }

    /// Test-only: seeds the workspace directly, bypassing a network turn —
    /// for tests that need an existing plan/exercise on the session before
    /// exercising a code path that must leave it untouched.
    func applyForTesting(plan: SessionPlan, exercise: Exercise) {
        session.plan = plan
        session.exercise = exercise
    }
    #endif

    func startWorking() {
        // A plan and an exercise only exist because a turn produced them, which
        // already required a reachable backend — so there is nothing to check
        // here beyond the pair itself.
        guard session.plan != nil, session.exercise != nil else {
            errorMessage = "The tutor has not prepared a session exercise yet. Ask for a problem or a focused next step first."
            return
        }
        isWorkspace = true
        session.lastSavedAt = .now
        persist()
    }

    func returnToChat() {
        isWorkspace = false
        persist()
    }

    // MARK: - The board's ink

    /// How long the pen has to rest before the board is written to disk.
    ///
    /// Short enough that no realistic way of putting the iPad down loses a
    /// stroke — the scene going inactive flushes as well, and that is the case
    /// this delay actually has to survive — and long enough that a pause between
    /// two lines of working does not turn into a save. Handwriting produces gaps
    /// of well under 600ms between strokes, so a line of maths is one write.
    static let boardInkRestBeforeSave: Duration = .milliseconds(600)

    /// How long the board has to rest between the camera stopping and its next
    /// write.
    ///
    /// Pan and pinch report continuously while a finger is down, exactly like
    /// the pen's stroke reports, and the saved camera only needs to be the one
    /// the learner left; a gesture that continues past the deadline re-arms it.
    /// Short enough that a fast pan followed by an app background flushes the
    /// latest position rather than a rest-saved midpoint.
    static let boardCameraRestBeforeSave: Duration = .milliseconds(600)

    /// The board as the pen last left it, held **outside** `session` on purpose.
    ///
    /// `session` is `@Published`, and the board reports a change at the frequency
    /// of handwriting rather than of user actions. Writing a stroke into it
    /// re-rendered every view observing this store — the panel, its whole
    /// MarkdownUI thread, the rail, and the board card itself — while the pen was
    /// still on the glass, and re-serialized the entire drawing and re-encoded and
    /// rewrote the whole session JSON on the main thread with it. So the ink is
    /// the one piece of session state kept out of the published struct, and it is
    /// folded back in only at the moment something is actually saved.
    private var pendingBoardInk: PKDrawing?
    /// The last serialized form of the board — what `persist()` writes, and what
    /// a remounted canvas restores from. `nil` means nothing has been drawn since
    /// launch and `session.drawingData` is still the truth.
    private var boardInkData: Data?
    private var boardInkSaveTask: Task<Void, Never>?
    /// The camera as the learner last left it, held outside `session` for the
    /// same reason `pendingBoardInk` is: pan and pinch report at gesture
    /// frequency, and folding each report into the `@Published` struct would
    /// re-render every observer of the store while the viewport is moving.
    private var pendingBoardCamera: BoardCamera?
    private var boardCameraSaveTask: Task<Void, Never>?

    /// What a canvas restores from, which is the board **as of the last save**.
    ///
    /// Deliberately not "as of the last stroke": this is read from `BoardScreen`'s
    /// body, and the body runs on anything that publishes — the dictation meter
    /// alone runs it 20 times a second while the microphone is open. Serializing
    /// the drawing here to keep it current would put the per-stroke cost back, in
    /// a place even harder to see. It is only ever *used* by `makeUIView`, and a
    /// canvas being made has no unsaved strokes yet, so the two facts agree
    /// exactly where it matters. `session.drawingData` is the fallback for the
    /// launch case, before anything has been drawn at all.
    var currentDrawingData: Data? { boardInkData ?? session.drawingData }

    /// When the pen will have rested long enough to save. Pushed forward by each
    /// change; the waiting task reads it rather than being replaced.
    private var boardInkSaveDeadline: ContinuousClock.Instant?
    private var boardCameraSaveDeadline: ContinuousClock.Instant?

    /// The board reporting that its ink changed.
    ///
    /// This is the hot path. PencilKit reports through here while the pencil is
    /// still down, so it does the least it can: retain the drawing (a struct, so
    /// this is a retain rather than a copy) and move a deadline.
    ///
    /// **One task per burst of writing, not one per report.** Cancelling and
    /// replacing a `Task` on every change means an allocation, a cancellation
    /// throw and an actor hop at the frequency of the pencil, all of it on the
    /// main actor and all of it competing with the thing it is supposed to be
    /// staying out of the way of. The task that is already waiting re-reads the
    /// deadline instead.
    func updateDrawing(_ drawing: PKDrawing) {
        pendingBoardInk = drawing
        boardInkSaveDeadline = .now + Self.boardInkRestBeforeSave
        guard boardInkSaveTask == nil else { return }
        boardInkSaveTask = Task { [weak self] in
            while let deadline = self?.boardInkSaveDeadline, .now < deadline {
                try? await Task.sleep(until: deadline, clock: .continuous)
                if Task.isCancelled { return }
            }
            self?.boardInkSaveTask = nil
            self?.saveBoardInkNow()
        }
    }

    /// Writes the board without waiting out the rest of the pen's rest. The scene
    /// leaving the foreground is the case this exists for.
    func saveBoardInkNow() {
        guard pendingBoardInk != nil else { return }
        boardInkSaveTask?.cancel()
        boardInkSaveTask = nil
        boardInkSaveDeadline = nil
        persist()
    }

    /// Writes the board without waiting out the camera's rest. The scene
    /// leaving the foreground and a session switch are the cases this exists
    /// for; a camera-only movement must reach the disk here exactly like ink.
    func saveBoardStateNow() {
        guard pendingBoardInk != nil || pendingBoardCamera != nil else { return }
        boardInkSaveTask?.cancel()
        boardInkSaveTask = nil
        boardInkSaveDeadline = nil
        boardCameraSaveTask?.cancel()
        boardCameraSaveTask = nil
        boardCameraSaveDeadline = nil
        persist()
    }

    /// The camera reporting that the viewport moved.
    ///
    /// Same contract as `updateDrawing`: retain the value, re-arm the deadline,
    /// and let the one waiting task read the deadline itself rather than being
    /// replaced per report. The programmatic first-layout restore is filtered
    /// by `PencilCanvasView` and never reaches here.
    func updateCamera(_ camera: BoardCamera) {
        pendingBoardCamera = camera
        boardCameraSaveDeadline = .now + Self.boardCameraRestBeforeSave
        guard boardCameraSaveTask == nil else { return }
        boardCameraSaveTask = Task { [weak self] in
            while let deadline = self?.boardCameraSaveDeadline, .now < deadline {
                try? await Task.sleep(until: deadline, clock: .continuous)
                if Task.isCancelled { return }
            }
            self?.boardCameraSaveTask = nil
            self?.saveBoardStateNow()
        }
    }

    /// Brings `boardInkData` up to date with the pen. Serializing here rather than
    /// in `updateDrawing` is the whole point: `dataRepresentation()` walks every
    /// stroke on the board, so it runs once per save instead of once per stroke.
    private func foldPendingBoardInk() {
        guard let pendingBoardInk else { return }
        self.pendingBoardInk = nil
        boardInkData = pendingBoardInk.dataRepresentation()
    }

    /// Brings `pendingBoardCamera` into the next save. Kept separate from the
    /// ink fold because a camera movement after a stroke must not re-serialize
    /// the drawing.
    private func foldPendingBoardCamera() {
        guard let pendingBoardCamera else { return }
        self.pendingBoardCamera = nil
        session.boardCamera = pendingBoardCamera
    }

    /// Forgets the board, in memory and on the next save. Both halves are needed:
    /// a cleared board with a pending stroke still queued would save the stroke.
    private func discardBoardInk() {
        boardInkSaveTask?.cancel()
        boardInkSaveTask = nil
        boardInkSaveDeadline = nil
        pendingBoardInk = nil
        boardInkData = nil
    }

    /// Forgets the camera in flight, both halves of what `discardBoardInk` does
    /// for ink: a session switch or reset must not save the previous board's
    /// camera into the next session.
    private func discardBoardCamera() {
        boardCameraSaveTask?.cancel()
        boardCameraSaveTask = nil
        boardCameraSaveDeadline = nil
        pendingBoardCamera = nil
    }

    /// One board evaluation.
    ///
    /// `question` is what the student actually typed into the composer alongside the
    /// selection, when they typed anything. It used to have nowhere to go — the composer
    /// held onto the text and sent a canned line in its place, so a student who
    /// wrote "check my work" had the one message they wrote dropped and a generic request
    /// delivered instead. The learner turn is now exactly what they typed — no generated
    /// area description appended — while `regionDescription` still reaches the service on
    /// its own so the model can be told which part of the board the image is of.
    ///
    /// **With nothing typed, the turn carries no words at all.** The canned "Please
    /// evaluate my work on the area selected on the board." was the device writing a
    /// sentence in the learner's voice that the learner had not said, and then showing it
    /// back to them in their own bubble. Pointing at a piece of working is already a
    /// complete request; `regionDescription` tells the model what it is looking at, in the
    /// third person, where a policy line belongs. So the message is empty, and the thread
    /// draws the picture on its own — see `MessageRow`.
    ///
    /// **`attachments` rides along rather than being a second turn.** The
    /// composer draws the selection as one chip among the files (see
    /// `AttachmentChipRow`), which is what lets a learner say *"here is the
    /// worksheet, here is what I tried"* in a single send — so a send that
    /// carries both has to arrive as one message. Routing only the picture here
    /// and dropping the files is the "silently dropped" failure this whole path
    /// is built to avoid.
    ///
    /// **Returns whether the turn was accepted**, exactly as `send` does and for
    /// exactly the same reason — see that method. A silent decline here would
    /// cancel and discard the same uploads.
    @discardableResult
    func evaluate(
        imageData: Data,
        regionDescription: String?,
        question: String? = nil,
        attachments: [UploadedAttachment] = []
    ) -> Bool {
        guard !isEvaluating, !awayTurnIsRunning else {
            composerNote = Self.tutorIsStillAnswering
            return false
        }
        guard ensureTutorAvailable() else { return false }
        isEvaluating = true
        evaluationText = nil
        evaluationMessageID = nil
        errorMessage = nil
        composerNote = nil
        consumePendingEdit()
        let asked = question?.trimmingCharacters(in: .whitespacesAndNewlines)
        let learnerTurn = TutorMessage(
            role: .learner,
            text: asked ?? "",
            signal: .evaluate,
            attachments: attachments.map(\.attachment)
        )
        session.messages.append(learnerTurn)
        saveThumbnails(for: attachments)
        // The picture they sent, kept so the thread can show it. Without this the
        // turn reads as though the tutor ignored the selection: the thread showed
        // the region the tutor fetched for itself and not the one the learner
        // chose, which is exactly the misreading these thumbnails exist to catch.
        selectionViews[learnerTurn.id] = BoardView(
            imageData: imageData,
            detail: regionDescription.map { "Showing " + $0 + "." } ?? "The region you selected."
        )
        session.lastSavedAt = .now
        persist()
        requestTutor(
            signal: .evaluate,
            imageData: imageData,
            regionDescription: regionDescription,
            attachmentIDs: attachments.map(\.attachment.id),
            onDone: { [weak self] text in
                self?.evaluationText = text
            }
        )
        return true
    }

    /// A send that could not read the board, said above the composer.
    ///
    /// Reachable now only with no canvas mounted at all — a region is stored in
    /// the drawing's own coordinates, so neither a scroll nor a resize can put it
    /// out of reach any more. It stays because the alternative to saying so is
    /// what this replaced: sending the question without the picture and letting
    /// the learner work out from the reply that the tutor never looked.
    func reportBoardCaptureFailure() {
        composerNote = Self.boardCaptureFailed
    }

    func clearComposerNote() {
        composerNote = nil
    }

    /// Board 15's register for a note: what happened, and what to do about it.
    /// No apology and no error code — the selection is still attached, so trying
    /// again is one tap.
    static let boardCaptureFailed = "I couldn't capture that part of the board. Try sending it again."

    func sayIDontKnow() {
        guard !isBusy, ensureTutorAvailable() else { return }
        consumePendingEdit()
        session.messages.append(TutorMessage(role: .learner, text: "I don’t know yet.", signal: .dontKnow))
        persist()
        requestTutor(signal: .dontKnow)
    }

    func clearEvaluation() {
        evaluationText = nil
        evaluationMessageID = nil
    }

    // MARK: - Voice mode

    /// The learner utterance the live voice call is streaming right now — the
    /// bubble board 28 tints and marks with the small waveform. Set by the
    /// first delta of `streamVoiceUserTranscript` and cleared when
    /// `finalizeVoiceUserUtterance` settles the utterance, so the bubble is
    /// live exactly while the learner speaks and detaches as a plain message
    /// the moment the utterance ends. The legacy completed-only path
    /// (`appendVoiceUtterance`) still sets it and clears it at
    /// `finishVoiceAssistantResponse`, its original lifetime. Cleared too when
    /// the call ends and on every session switch. `nil` the whole rest of the
    /// time, which is every bubble drawn plain.
    @Published private(set) var liveVoiceUtteranceID: UUID?

    /// Voice-marked tutor messages keyed by realtime item id, so a transcript
    /// delta always finds the message it belongs to and a delegated response
    /// can take its spoken rephrase back out of the thread. Not persisted:
    /// item ids are a property of the live call, and a relaunch has no call.
    private var voiceMessageIDsByItem: [String: UUID] = [:]

    /// The learner-side twin: in-progress learner utterances keyed by realtime
    /// item id, held only from first delta to finalization. Keyed by item id
    /// rather than a single "current utterance" slot because transcription
    /// runs behind the microphone — a barge-in can start item B's deltas
    /// before item A's completed transcript lands.
    private var voiceLearnerMessageIDsByItem: [String: UUID] = [:]

    /// True between `voiceCallBegan()` and `voiceCallEnded()`. The transcript
    /// hooks guard on it so a delta from an engine already told to close
    /// cannot append a ghost message to a thread the call has left. A
    /// delegated turn already in flight is deliberately *not* guarded — the
    /// worker's message is canonical and finishes on the normal pipeline.
    private var isVoiceCallActive = false

    /// The session the live call belongs to, for as long as it runs.
    ///
    /// A call binds to the session it was started in and keeps it whichever
    /// session the learner then looks at: the transcripts, the delegated turns
    /// and the board updates all name this id, never `session.id`. `nil`
    /// whenever no call is live.
    private(set) var callSessionID: UUID?

    /// The server close a switch away from the call session could not send —
    /// see `DeferredSessionClose`.
    private var deferredClose = DeferredSessionClose()

    /// The screen is starting a call. Called before the engine's `start`, so
    /// no hook can arrive first.
    /// - Parameter sessionID: The session the call is being started in. Passed
    ///   explicitly because the screen reads it at the tap and the call can
    ///   only begin once dictation has unwound — by which time `session` is
    ///   whatever the learner has since opened. Defaults to the open session
    ///   for callers with nothing in between.
    func voiceCallBegan(sessionID: UUID? = nil) {
        isVoiceCallActive = true
        callSessionID = sessionID ?? session.id
    }

    /// What the live-transcript bubble is currently saying — resolved by text
    /// because `MessageBubble` only ever sees the words. See
    /// `EnvironmentValues.liveVoiceTranscript`.
    var liveVoiceUtteranceText: String? {
        guard let id = liveVoiceUtteranceID else { return nil }
        return session.messages.first(where: { $0.id == id })?.text
    }

    /// A completed learner utterance from the live call — hooks'
    /// `appendUserUtterance`, the *legacy* path: sites that wire the
    /// streaming pair (`streamUserTranscript` / `finalizeUserUtterance`)
    /// never reach it, and the scripted engine still does.
    ///
    /// The worker reads the server's own rows, so the utterance reaches them
    /// the way an edit's cut does: the `replaceTranscript` debt, paid at the
    /// head of the next turn — which for a delegated utterance is the very
    /// turn it prompted.
    func appendVoiceUtterance(_ text: String) {
        guard isVoiceCallActive else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let target = voiceSessionID
        let message = TutorMessage(role: .learner, text: trimmed, isVoice: true)
        guard mutateSession(target, { stored in
            stored.messages.append(message)
            stored.lastSavedAt = .now
        }) else { return }
        liveVoiceUtteranceID = message.id
        persistSession(target)
        pendingTranscriptSync[target] = finalizedThreadSnapshot(of: target)
    }

    /// A learner input-transcription delta from the live call — hooks'
    /// `streamUserTranscript`. The live bubble is created by the item's first
    /// delta — voice-marked, taking board 28's live treatment through
    /// `liveVoiceUtteranceID` — and grows in place while the learner speaks,
    /// the same lazily-created streaming pattern as
    /// `streamVoiceAssistantText`. No `persist()` per delta, for
    /// `requestTutor`'s reason; the words are not final until
    /// `finalizeVoiceUserUtterance` says so.
    func streamVoiceUserTranscript(itemID: String, delta: String) {
        guard isVoiceCallActive else { return }
        let target = voiceSessionID
        if let id = voiceLearnerMessageIDsByItem[itemID],
           sessionValue(target)?.messages.contains(where: { $0.id == id }) == true {
            mutateSession(target) { stored in
                guard let index = stored.messages.firstIndex(where: { $0.id == id }) else { return }
                stored.messages[index].text += delta
            }
            liveVoiceUtteranceID = id
            return
        }
        // A bubble must open with words: a leading-whitespace delta is held
        // back until one arrives, or the thread grows an empty tinted pill.
        let opening = String(delta.drop(while: \.isWhitespace))
        guard !opening.isEmpty else { return }
        let message = TutorMessage(role: .learner, text: opening, isVoice: true)
        guard mutateSession(target, { $0.messages.append(message) }) else { return }
        voiceLearnerMessageIDsByItem[itemID] = message.id
        liveVoiceUtteranceID = message.id
    }

    /// The learner's utterance for `itemID` ended — hooks'
    /// `finalizeUserUtterance`.
    ///
    /// Words replace whatever streamed — the completed transcript is
    /// authoritative and can differ from its own deltas — the live tint
    /// clears, and the settled message joins the transcript debt, which is
    /// the first moment the server may see it: in-progress text never syncs.
    /// nil or blank is silence — a cough, the room — and removes the live
    /// bubble; silence is not something to put in the thread.
    func finalizeVoiceUserUtterance(itemID: String, text: String?) {
        let liveID = voiceLearnerMessageIDsByItem.removeValue(forKey: itemID)
        if let liveID, liveVoiceUtteranceID == liveID {
            liveVoiceUtteranceID = nil
        }
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        let target = voiceSessionID
        guard !trimmed.isEmpty else {
            guard let liveID else { return }
            mutateSession(target) { $0.messages.removeAll { $0.id == liveID } }
            persistSession(target)
            return
        }
        let held = liveID.map { id in
            sessionValue(target)?.messages.contains { $0.id == id } == true
        } ?? false
        if held, let liveID {
            mutateSession(target) { stored in
                guard let index = stored.messages.firstIndex(where: { $0.id == liveID }) else { return }
                stored.messages[index].text = trimmed
            }
        } else if isVoiceCallActive {
            // Completed without any delta first — a transcriber quick enough
            // to skip streaming, or deltas lost on the wire. Same outcome as
            // the legacy append; the guard keeps a stray finalize from an
            // engine already told to close out of a thread the call has left.
            mutateSession(target) {
                $0.messages.append(TutorMessage(role: .learner, text: trimmed, isVoice: true))
            }
        } else {
            return
        }
        mutateSession(target) { $0.lastSavedAt = .now }
        persistSession(target)
        pendingTranscriptSync[target] = finalizedThreadSnapshot(of: target)
    }

    /// An assistant spoken-transcript delta — hooks' `streamAssistantText`.
    /// The message is created lazily by the first delta of its item, exactly
    /// as `messageIndex()` creates the streaming turn's message, and grows in
    /// place. No `persist()` per delta, for `requestTutor`'s reason.
    func streamVoiceAssistantText(itemID: String, delta: String) {
        guard isVoiceCallActive else { return }
        let target = voiceSessionID
        guard let id = voiceMessageID(for: itemID, in: target) else { return }
        mutateSession(target) { stored in
            guard let index = stored.messages.firstIndex(where: { $0.id == id }) else { return }
            stored.messages[index].text += delta
        }
    }

    /// The voice-marked tutor message for `itemID`, created on the item's first
    /// delta. `nil` only when the call session has gone away entirely (deleted).
    private func voiceMessageID(for itemID: String, in target: UUID) -> UUID? {
        if let id = voiceMessageIDsByItem[itemID],
           sessionValue(target)?.messages.contains(where: { $0.id == id }) == true {
            return id
        }
        let message = TutorMessage(role: .tutor, text: "", isVoice: true)
        guard mutateSession(target, { $0.messages.append(message) }) else { return nil }
        voiceMessageIDsByItem[itemID] = message.id
        return message.id
    }

    /// The assistant response for `itemID` finished — hooks'
    /// `assistantResponseFinished`.
    ///
    /// The dedup rule: a response that called `send_to_tutor` spoke a rephrase
    /// of the worker's answer, and the worker's own streamed message is the
    /// canonical thread content — so the spoken transcript is removed. Voice
    /// small talk (no delegation) stays, and joins the transcript debt so the
    /// worker sees it on the next turn.
    func finishVoiceAssistantResponse(itemID: String, delegated: Bool) {
        // The legacy live tint ends with the exchange — but never a learner
        // bubble that is still streaming: a barge-in finishes the interrupted
        // response exactly while the learner's next utterance is mid-flight.
        if let id = liveVoiceUtteranceID, !voiceLearnerMessageIDsByItem.values.contains(id) {
            liveVoiceUtteranceID = nil
        }
        guard let id = voiceMessageIDsByItem.removeValue(forKey: itemID) else { return }
        let target = voiceSessionID
        if delegated {
            mutateSession(target) { $0.messages.removeAll { $0.id == id } }
        } else {
            mutateSession(target) { $0.lastSavedAt = .now }
            pendingTranscriptSync[target] = finalizedThreadSnapshot(of: target)
        }
        persistSession(target)
    }

    /// The thread with every in-progress voice message left out — the only
    /// thing `pendingTranscriptSync` may carry. The server's transcript, and
    /// through it the worker's context, holds finalized utterances only: a
    /// partial the learner is still speaking, or a spoken rephrase the dedup
    /// rule may yet remove, is not conversation history.
    private func finalizedThreadSnapshot(of target: UUID) -> [TutorMessage] {
        guard let messages = sessionValue(target)?.messages else { return [] }
        let liveIDs = Set(voiceLearnerMessageIDsByItem.values)
            .union(voiceMessageIDsByItem.values)
        guard !liveIDs.isEmpty else { return Array(messages) }
        return messages.filter { !liveIDs.contains($0.id) }
    }

    /// The call ended. Nothing is live any more, and a stray item stream from
    /// a closed engine must not write into the thread — the guard above and
    /// the emptied maps are the halves of that promise. An utterance caught
    /// mid-stream settles with the words it got — they are real speech the
    /// learner watched arrive — and one still empty vanishes.
    ///
    /// And, if the learner walked out of the call session
    /// while it was still running, this is the moment its server close was
    /// waiting for. See `DeferredSessionClose`: closing on the switch would
    /// have frozen the episode mid-conversation, and closing now closes it
    /// whole. A call that ended with the learner back inside its own session
    /// sends nothing at all; the next switch away does that, normally.
    /// - Parameter sessionID: The session the call that ended belonged to. An
    ///   ending reported for a call the host has already replaced — the voice
    ///   disc tapped in another session — names a session this store has moved
    ///   on from, and settling against it would tear down the *new* call.
    func voiceCallEnded(sessionID: UUID) {
        guard sessionID == callSessionID else { return }
        let target = sessionID
        isVoiceCallActive = false
        liveVoiceUtteranceID = nil
        voiceMessageIDsByItem = [:]
        settleInFlightLearnerUtterances(in: target)
        callSessionID = nil
        if let id = deferredClose.callEnded(inSession: target, visibleSessionID: session.id) {
            endSessionOnServer(id: id, turnWasInFlight: turnSessionID == id)
        }
        // Nothing writes into the away copy any more; a later switch back
        // reads the session from disk, where every voice write already went.
        if target != session.id, turnSessionID != target { awaySessions[target] = nil }
    }

    private func settleInFlightLearnerUtterances(in target: UUID) {
        guard !voiceLearnerMessageIDsByItem.isEmpty else { return }
        let liveIDs = Set(voiceLearnerMessageIDsByItem.values)
        voiceLearnerMessageIDsByItem = [:]
        var kept = false
        mutateSession(target) { stored in
            stored.messages.removeAll { message in
                guard liveIDs.contains(message.id) else { return false }
                return message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            for index in stored.messages.indices where liveIDs.contains(stored.messages[index].id) {
                stored.messages[index].text = stored.messages[index].text
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                kept = true
            }
            if kept { stored.lastSavedAt = .now }
        }
        if kept {
            pendingTranscriptSync[target] = finalizedThreadSnapshot(of: target)
        }
        persistSession(target)
    }

    /// A delegated voice turn the store declined to start.
    enum VoiceTurnRefusal: LocalizedError {
        /// A turn is already streaming. The voice model hears `{"error": …}`
        /// and can say so; the single-flight rule proper lives in the engine.
        case busy

        var errorDescription: String? {
            switch self {
            case .busy: "The tutor is still answering the previous request."
            }
        }
    }

    /// One delegated voice turn — hooks' `runTutorTurn`: the whole normal
    /// pipeline (board snapshot, step chips, board updates, memory,
    /// recording) with the voice model's `request` as the turn text and
    /// **no learner message appended** — the learner's own spoken words are
    /// already in the thread, and the request is a paraphrase they did not
    /// say. Resolves with the worker's final text for the voice model to
    /// rephrase aloud.
    func runVoiceTurn(request: String) async -> Result<String, Error> {
        guard !isBusy else { return .failure(VoiceTurnRefusal.busy) }
        guard ensureTutorAvailable() else { return .failure(TutorServiceError.notConfigured) }
        return await withCheckedContinuation { continuation in
            requestTutor(signal: .voice, voiceRequest: request, onFinish: { result in
                continuation.resume(returning: result)
            })
        }
    }

    // MARK: - Editing a sent message

    /// The thread's long-press Edit: arm a rewrite of one of the learner's
    /// own turns. The caller (`BoardScreen.editMessage`) puts the words back
    /// in the composer; this records which message the next send replaces.
    ///
    /// Learner messages only — the menu offers Edit on nothing else, and the
    /// guard keeps a stray id from arming a cut at a tutor row.
    func beginEditingMessage(id: UUID) {
        guard session.messages.contains(where: { $0.id == id && $0.role == .learner }) else {
            return
        }
        editingMessageID = id
    }

    /// Disarm without cutting anything. The composer emptied to nothing is
    /// the gesture that reaches here; a session switch disarms in `adopt`.
    func cancelEditing() {
        editingMessageID = nil
    }

    /// Board 15's register for the armed state: what is happening, and both
    /// ways out of it.
    static let editingAnEarlierMessage =
        "You’re editing an earlier message. Sending replaces everything after it; clear the text to cancel."

    /// The armed state as the composer's note slot reads it — `nil` the rest
    /// of the time, so it sits on the chain's lowest rung and every event
    /// note outranks it.
    var editingNote: String? {
        editingMessageID != nil ? Self.editingAnEarlierMessage : nil
    }

    /// The cut itself, run by whichever send consumes the armed edit.
    ///
    /// Everything from the edited message on is removed — the resent words
    /// arrive as the appending caller's own new turn — and what each removed
    /// row anchored goes with it: its `selectionViews` thumbnail, and the
    /// evaluation card if the turn it pointed at is now gone. The surviving
    /// prefix is snapshotted for the server, whose transcript must stop where
    /// the learner's now does; `requestTutor` sends it before the turn
    /// streams. No `persist()` here — every caller appends and persists as
    /// its next act, and a cut without its resend is not a state to save.
    private func consumePendingEdit() {
        guard let id = editingMessageID else { return }
        editingMessageID = nil
        guard let index = session.messages.firstIndex(where: { $0.id == id }) else { return }
        let removed = session.messages[index...]
        for message in removed {
            selectionViews[message.id] = nil
        }
        if let evaluationMessageID, removed.contains(where: { $0.id == evaluationMessageID }) {
            clearEvaluation()
        }
        session.messages.removeSubrange(index...)
        pendingTranscriptSync[session.id] = finalizedThreadSnapshot(of: session.id)
    }

    func clearDrawing() {
        discardBoardInk()
        session.drawingData = nil
        persist()
    }

    // MARK: - Sessions

    /// Puts the open session away and opens a new empty one.
    ///
    /// The one it leaves is saved, not discarded: `startNewSession` is the
    /// switcher's "New session" row, and nothing about tapping it says the work
    /// on screen should stop existing. `resetSession` is the destructive one.
    func startNewSession() {
        closeCurrentSession(saving: true)
        adopt(freshSession(), isStored: false)
        persist()
    }

    /// Opens a stored session, saving the one on screen first.
    ///
    /// A row naming a session that will not load is not an error to show the
    /// learner — it is an index that has drifted from the directory, so the
    /// index is rebuilt and the list redrawn without it. Tapping the session
    /// already open does nothing rather than re-reading it from disk, which
    /// would throw away anything typed since the last save.
    func openSession(id: UUID) {
        guard id != session.id else { return }
        guard let target = persistence.load(id: id) else {
            persistence.rebuildIndex()
            refreshSessions()
            return
        }
        closeCurrentSession(saving: true)
        persistence.markOpened(target.id)
        adopt(target, isStored: true)
    }

    /// Settings' destructive action: this session is deleted and a new empty one
    /// takes its place. Every other session is untouched.
    ///
    /// It used to be the only session there was, so "reset" and "delete
    /// everything" were the same act. They are not any more, and this is the
    /// narrower of the two — see `docs/TODO.md` on splitting the control.
    func resetSession() {
        closeCurrentSession(saving: false, notifyingServer: false)
        discardSessionOnServer(id: session.id)
        persistence.delete(id: session.id)
        adopt(freshSession(), isStored: false)
        persist()
    }

    /// A long press on a session row, and its destructive action.
    ///
    /// **Two cases, and only one of them is interesting.** Deleting a session the
    /// learner is not in is a file and an index entry, and nothing on screen
    /// changes except the row leaving. Deleting the one they *are* in has to
    /// answer "and then what", because the app has no state in which no session
    /// is open.
    ///
    /// It falls back to the most recently saved session that is left, which is
    /// the row that was directly under the deleted one — deleting from a list
    /// should leave you looking at that list's next item, not somewhere new.
    /// With nothing left it opens a fresh empty session, the same one a first
    /// launch gets, so the app is never in a state the rest of it has to guard
    /// against.
    ///
    /// The open session is **not** saved on its way out, unlike every other
    /// switch: `closeCurrentSession(saving: true)` would write the file this
    /// call is about to delete, and on a slow device the write can land after
    /// the delete and resurrect it. `resetSession` passes `false` for the same
    /// reason.
    ///
    /// Deleting a session that is not there is not an error to report — the
    /// index has drifted from the directory, so it is rebuilt and the list
    /// redrawn, exactly as `openSession(id:)` handles the same drift.
    ///
    /// The server is told to forget, never to remember. A delete used to leave
    /// the backend alone (or worse, close the open session on the way out),
    /// so the server froze the transcript into an episode and the deleted
    /// session kept showing up in the tutor's RECENT SESSIONS context. Now
    /// both paths send `deleteSession(id:)`, and the open-session path
    /// suppresses the close that `closeCurrentSession` would otherwise send —
    /// a close racing a delete is a coin flip over whether the session is
    /// remembered.
    func deleteSession(id: UUID) {
        discardSessionOnServer(id: id)
        guard id == session.id else {
            persistence.delete(id: id)
            refreshSessions()
            return
        }

        closeCurrentSession(saving: false, notifyingServer: false)
        persistence.delete(id: id)

        // Read *after* the delete, so the session being deleted cannot be the
        // one picked as its own replacement.
        refreshSessions()
        guard let next = sessions.first(where: { $0.id != id }),
              let restored = persistence.load(id: next.id)
        else {
            adopt(freshSession(), isStored: false)
            persist()
            return
        }
        persistence.markOpened(restored.id)
        adopt(restored, isStored: true)
    }

    /// A new empty session. The thread stays empty until the learner's first
    /// turn — there is no seeded tutor opening line.
    private func freshSession() -> LearningSession {
        LearningSession.empty
    }

    /// Stops everything the open session has in flight, and optionally writes it.
    ///
    /// **The turn is cancelled, not abandoned.** A streaming reply mutates
    /// `session.messages` on every delta, so a turn left running would keep
    /// writing into a session the learner is no longer looking at — and
    /// `persist()` on its `.done` would then save that half-finished text over
    /// whatever the switch had already written. Cancelling loses the rest of a
    /// reply; not cancelling corrupts two sessions. See `docs/TODO.md` — letting
    /// the turn finish into its own session is the better answer and a larger
    /// change than this one.
    /// `notifyingServer` exists for the two destructive callers: a delete or a
    /// reset is about to ask the server to *forget* this session, and the
    /// close this function would otherwise send asks it to *remember* — the
    /// two requests race, detached, and either could land last. Every other
    /// caller leaves it `true`.
    private func closeCurrentSession(saving: Bool, notifyingServer: Bool = true) {
        // Read before the lines below clear them, and read from these two
        // rather than from `activeRequestTask`: that handle is only cleared
        // when a turn fails to start, so it stays non-nil holding a finished
        // task for the whole life of any session that has ever run one. These
        // two are set as a turn begins and cleared on every way it can end,
        // which is the actual question `endSessionOnServer` is asking.
        let outgoing = session.id
        let turnWasInFlight = isBusy
        // **The one turn the switch may not cancel.** A delegated turn for a
        // live call belongs to the call, not to what is on screen: the learner
        // asked for it out loud and is still in the call while they browse. It
        // keeps running, into the away copy of its own session — see
        // `mutateSession`. Every other in-flight turn is cancelled exactly as
        // before.
        let turnSurvives = turnSessionID != nil && turnSessionID == callSessionID
        if turnSurvives {
            // The away copy starts from what is on screen right now, so the
            // turn does not have to reach disk for the thread it is writing.
            awaySessions[outgoing] = snapshotWithBoardInk()
            // The visible thread must not carry the away turn's chrome, so the
            // published flags go quiet; `awayTurnIsRunning` keeps the pipeline's
            // one-turn-at-a-time rule (see `isBusy`).
            awayTurnIsRunning = true
        } else {
            activeRequestTask?.cancel()
            activeRequestTask = nil
        }
        isLoading = false
        isEvaluating = false
        phase = nil
        if saving {
            // Folds any ink the pen's rest timer has not written yet, so a
            // stroke made a moment before the switch lands in the session it was
            // drawn on rather than the one being opened.
            persist()
        }
        boardInkSaveTask?.cancel()
        boardInkSaveTask = nil
        boardInkSaveDeadline = nil
        boardCameraSaveTask?.cancel()
        boardCameraSaveTask = nil
        boardCameraSaveDeadline = nil
        if notifyingServer {
            // A live call in the outgoing session defers the close until the
            // call ends; every other switch sends it here, as before.
            if deferredClose.switchingAway(from: outgoing, callSessionID: callSessionID) {
                endSessionOnServer(id: outgoing, turnWasInFlight: turnWasInFlight)
            }
        }
    }

    /// The open session with the pen's unsaved ink folded in — what `persist()`
    /// writes, as a value.
    private func snapshotWithBoardInk() -> LearningSession {
        foldPendingBoardInk()
        foldPendingBoardCamera()
        var snapshot = session
        if let boardInkData { snapshot.drawingData = boardInkData }
        return snapshot
    }

    /// Tells the backend the learner has left this session, so it can freeze
    /// the transcript and remember what came out of it.
    ///
    /// This is the only place that sends it, and the three callers above are
    /// the only three moments that qualify: the switcher's "New session", the
    /// switcher opening another one, and Settings' reset. **Backgrounding must
    /// never reach here.** An iPad backgrounds constantly and says nothing
    /// about whether the learner is done; the one scene-phase hook this app has
    /// (`MathTutorApp`) saves ink and nothing else, and it must stay that way.
    ///
    /// Two conditions suppress the call.
    ///
    /// **A turn that was in flight.** The switch has just cancelled the
    /// client's end of it, but the server's end is another process and may
    /// still be writing the reply. `_record_episode` reads the transcript the
    /// moment a close lands, with no guard against that, and
    /// `uq_episodes_session` makes what it reads the only episode the session
    /// will ever have — so closing now would freeze a torn transcript
    /// permanently. `sweep_abandoned_sessions` closes it later and whole, which
    /// is worth more than closing it now and wrong. The real fix belongs on the
    /// server, which is the side that knows when a turn has finished; see
    /// `docs/TODO.md`.
    ///
    /// **A session the backend has never heard of.** The endpoint answers 404
    /// for an unknown id deliberately, so that a device sending the wrong one
    /// finds out; filling its log with 404s for sessions that were never sent
    /// anywhere would spend that signal for nothing.
    ///
    /// Reset and delete do not reach here at all any more: they pass
    /// `notifyingServer: false` and send `discardSessionOnServer(id:)`
    /// instead, because a destroyed session must be forgotten, not filed.
    /// **A deferred close.** A call that outlived the switch defers this call
    /// rather than dropping it (`DeferredSessionClose`), and the deferred one
    /// lands from `voiceCallEnded()` with the session named explicitly — which
    /// is why the id is a parameter now instead of being read off `session`.
    /// That composes with the in-flight rule above rather than fighting it: a
    /// close that arrives after the call has finished speaking is exactly the
    /// "later and whole" the sweep would otherwise have had to provide.
    private func endSessionOnServer(id: UUID, turnWasInFlight: Bool) {
        guard !turnWasInFlight, usesLiveTutor, hasReachedTheBackend(id) else { return }
        let service = tutorService
        // Detached, and its handle deliberately dropped: it has to outlive the
        // switch that triggered it, and nothing on screen is waiting for it.
        Task.detached { await service.closeSession(id: id) }
    }

    /// Tells the backend to forget a session the learner has destroyed — the
    /// transcript, the frozen episode, its place in RECENT SESSIONS. The
    /// learner's extracted memory survives; the server documents that split.
    ///
    /// Gated on `usesLiveTutor` alone, not `hasReachedTheBackend`: that guard
    /// can only speak for the *open* session, and most deletes are of stored
    /// rows whose history it knows nothing about. A delete for a session the
    /// backend never saw answers 404, which the service ignores — cheaper
    /// than being clever and wrong about which sessions have server rows.
    ///
    /// Fire-and-forget like `endSessionOnServer`, but note the asymmetry: a
    /// close that never lands is repaired by the server's sweep, a delete
    /// that never lands just leaves the session remembered.
    private func discardSessionOnServer(id: UUID) {
        // A destroyed session is told to be forgotten, never to be closed, so
        // any close waiting on a call in it is dropped — and a call bound to it
        // has nothing left to write into. The screen ends that call itself; the
        // store simply stops routing to a session that is gone.
        deferredClose.forget(id)
        if callSessionID == id { callSessionID = nil }
        awaySessions[id] = nil
        pendingTranscriptSync[id] = nil
        guard usesLiveTutor else { return }
        let service = tutorService
        Task.detached { await service.deleteSession(id: id) }
    }

    /// Whether a turn has ever gone out for the session with this id.
    ///
    /// Every path that starts one appends a learner message first — `send`,
    /// `sayIDontKnow` and `evaluate` — and a turn is the only thing that
    /// creates the session server-side, so this is the same question as "does
    /// the backend have a row for this id", short of a turn that never reached
    /// the network at all. A live call's own spoken utterances count too: they
    /// are learner messages, and the delegated turn they prompted created the
    /// server's row.
    private func hasReachedTheBackend(_ id: UUID) -> Bool {
        guard let messages = sessionValue(id)?.messages else { return false }
        return messages.contains {
            $0.role == .learner
                && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// Makes `next` the open session, and clears everything that described the
    /// last one.
    ///
    /// `discardBoardInk()` is the load-bearing line: `boardInkData` outlives
    /// `session` by design (see `updateDrawing`), so without it the new session's
    /// first save would write the previous board's ink into it. `selectionViews`
    /// goes too — it is evidence for turns in a thread that is no longer on
    /// screen, and it is keyed by message id, so keeping it would only grow.
    /// - Parameter isStored: Whether `next` is byte-for-byte what is on disk. A
    ///   session just read from a file is; a freshly minted one has never been
    ///   written, and saying so is what lets the very next `persist()` create it
    ///   instead of deciding nothing has changed.
    private func adopt(_ next: LearningSession, isStored: Bool) {
        var next = next
        var isStored = isStored
        // Coming back to a session a call has been writing into: the away copy
        // is newer than the file whenever a delta has not reached disk yet, so
        // it is what the learner returns to. It stops being an away copy at the
        // same moment — from here the call writes into `session` again, because
        // `mutateSession` routes by id and this id is now the visible one.
        if let live = awaySessions.removeValue(forKey: next.id) {
            next = live
            isStored = false
        }
        discardBoardInk()
        discardBoardCamera()
        lastWritten = isStored ? next : nil
        lastModificationBaseline = next
        session = next
        isWorkspace = next.plan != nil && next.exercise != nil && canRequestTutor
        evaluationText = nil
        evaluationMessageID = nil
        errorMessage = nil
        // Attachment ids are scoped to the session they were uploaded against,
        // so the previous session's payload is not a thing this one may re-send.
        retryPayload = RetryPayload()
        selectionViews = [:]
        // An armed edit names a message in the thread being put away; against
        // `next` it would cut the wrong conversation. The transcript debt is
        // *not* cleared with it any more: it is keyed by session now, so each
        // session's unpaid cut waits for that session's own next turn — which
        // is what lets a call keep syncing its own thread from another session.
        editingMessageID = nil
        // A call that is still running keeps every one of its maps: they name
        // messages in the call session, which the switch does not leave. Only
        // a switch with no call live clears them.
        if callSessionID == nil {
            isVoiceCallActive = false
            liveVoiceUtteranceID = nil
            voiceMessageIDsByItem = [:]
            voiceLearnerMessageIDsByItem = [:]
        } else if callSessionID != next.id {
            // Away from the call: the live tint belongs to the call session's
            // thread, which is not the one on screen.
            liveVoiceUtteranceID = nil
        }
        refreshSessions()
    }

    // MARK: - The session a call keeps writing into

    /// Sessions that are not on screen but are still being written to — today
    /// exactly one: the session a live call is bound to while the learner
    /// browses elsewhere.
    ///
    /// Held as whole values rather than as a second store: every write goes
    /// through `mutateSession`, which routes by id, so one code path serves the
    /// visible session and the away one and no caller has to know which it has.
    /// An entry is seeded at the switch (from what was on screen), read back on
    /// return in `adopt`, and dropped when the call ends.
    private var awaySessions: [UUID: LearningSession] = [:]

    /// The session a running turn belongs to. `nil` between turns.
    private var turnSessionID: UUID?

    /// True while a turn is running into a session that is not on screen. The
    /// published `isLoading` cannot say this — it draws the *visible* thread's
    /// thinking indicator — so the pipeline's one-turn-at-a-time rule reads
    /// `isBusy` instead.
    private var awayTurnIsRunning = false

    /// Whether the pipeline already has a turn, wherever it is landing.
    var isBusy: Bool { isLoading || isEvaluating || awayTurnIsRunning }

    /// The session every voice hook writes into: the call's own, for the whole
    /// life of the call, whichever session is on screen.
    private var voiceSessionID: UUID { callSessionID ?? session.id }

    /// One session's board, as the two things a render needs.
    struct StoredBoard {
        var drawing: PKDrawing
        var scene: BoardScene
    }

    /// The board of any session, on screen or not — what `view_board` answers
    /// from when the live canvas cannot serve the render.
    ///
    /// This replaced a gate. `view_board` used to be refused outright unless
    /// the running turn belonged to the session on screen, because the only
    /// board the device could draw was the one under the pen and showing the
    /// tutor the *wrong* board is worse than showing it none. The refusal
    /// reached the model as "I could not see the board" — for a board that was
    /// sitting there, saved and complete. Answering from the turn's own
    /// session keeps the promise the gate was making (never the wrong board)
    /// without the lie (there is a board, and this is it).
    ///
    /// The visible session reads its ink through `currentDrawingData`, not off
    /// `session.drawingData`: strokes are saved on a rest timer, so the stored
    /// copy can be a few seconds behind the pen and the tutor would be shown a
    /// board the learner has already written past.
    ///
    /// `nil` for a session this device does not have — a call session deleted
    /// out from under its own turn. There is nothing to render and nothing to
    /// invent.
    func storedBoard(for id: UUID) -> StoredBoard? {
        guard let stored = sessionValue(id) else { return nil }
        let ink = id == session.id ? currentDrawingData : stored.drawingData
        // A drawing that will not decode still leaves the tutor's own scene,
        // which is the half this render can always draw.
        let drawing = ink.flatMap { try? PKDrawing(data: $0) } ?? PKDrawing()
        return StoredBoard(drawing: drawing, scene: stored.boardScene)
    }

    /// A read of the session with `id`, wherever it lives. Loads it from disk
    /// once if it is neither on screen nor already held away.
    private func sessionValue(_ id: UUID) -> LearningSession? {
        if session.id == id { return session }
        if let away = awaySessions[id] { return away }
        guard let stored = persistence.load(id: id) else { return nil }
        awaySessions[id] = stored
        return stored
    }

    /// Applies `change` to the session with `id` — the visible one, or the away
    /// copy. Returns whether the session could be found at all: a session
    /// deleted out from under a call cannot be written to, and a write that
    /// silently landed in the visible session instead is exactly the corruption
    /// this routing exists to prevent.
    @discardableResult
    private func mutateSession(_ id: UUID, _ change: (inout LearningSession) -> Void) -> Bool {
        if session.id == id {
            change(&session)
            return true
        }
        guard var away = sessionValue(id) else { return false }
        change(&away)
        awaySessions[id] = away
        return true
    }

    /// Writes the session with `id` to disk — `persist()` for the visible one,
    /// a direct save for an away copy (there is no ink to fold: nothing is
    /// drawing on a board that is not on screen).
    private func persistSession(_ id: UUID) {
        if session.id == id {
            persist()
            return
        }
        guard var away = awaySessions[id] else { return }
        away.lastSavedAt = .now
        awaySessions[id] = away
        persistence.save(away)
        refreshSessions()
    }

    /// Rebuilds the switcher's rows from the index, ordered by when each session
    /// was last modified and by nothing else.
    ///
    /// The open session's row is refreshed from the live session rather than
    /// taken whole from the index, because it is the one row that must be right
    /// the instant something changes: a session gets its name from its plan and
    /// its first learner turn, so the row is expected to stop saying "New
    /// session" the moment the learner sends one — and the index only catches up
    /// on the next save. Its *date* still comes from the index, because that is
    /// the last time it was actually written and the whole order is built on it.
    private func refreshSessions() {
        var summaries = startsClean ? [] : persistence.loadIndex().sessions
        if let row = summaries.firstIndex(where: { $0.id == session.id }) {
            // Keep the stored date — that is the fact the order is built on —
            // and take only what can move before the next save.
            summaries[row] = SessionSummary(
                id: session.id,
                title: session.title,
                lastSavedAt: summaries[row].lastSavedAt,
                messageCount: session.messages.count
            )
        } else {
            // Never written: a session created and not yet touched. It still
            // belongs in the list, dated from when it was made.
            summaries.append(SessionSummary(session))
        }
        sessions = summaries.sorted { $0.lastSavedAt > $1.lastSavedAt }
    }

    /// Moves the model, and the effort with it when the new model is shallower.
    ///
    /// Without the clamp a session sitting on Max would keep sending it after a
    /// switch to Gemini, and every turn would 422 at `TurnRequest`. The picker
    /// would also be showing a level that is not in the new model's row.
    func setModel(_ model: ModelChoice) {
        session.selectedModel = model
        session.reasoningEffort = model.clamp(session.reasoningEffort)
        persist()
    }

    func setReasoningEffort(_ reasoningEffort: ReasoningEffort) {
        session.reasoningEffort = reasoningEffort
        persist()
    }

    /// Takes effect on the next call, never the live one: the realtime model is
    /// locked once the session has produced audio, the same way the voice is.
    func setVoiceModel(_ voiceModel: VoiceModelChoice) {
        session.selectedVoiceModel = voiceModel
        persist()
    }

    /// What the last turn carried besides its transcript, so a retry can carry
    /// it again.
    ///
    /// A turn is not only the messages: it names the files the learner attached
    /// and it may hold a region of the board they pointed at. `retryLastRequest`
    /// re-ran `requestTutor` on the defaults, so the retry of a photo turn was
    /// sent with no attachment ids and no image — the tutor answered a worksheet
    /// it had never been shown, with the learner's chips still on screen above
    /// the reply.
    ///
    /// `signal` stays out on purpose. It is the only one of the five that is not
    /// a thing the learner *attached*: `.evaluate` drives `isEvaluating` and an
    /// `onDone` the retry path has no continuation for, and `.dontKnow` is an
    /// admission, not a payload. A retry has always been a plain turn and stays
    /// one.
    private struct RetryPayload {
        var imageData: Data?
        var regionDescription: String?
        var attachmentIDs: [UUID] = []
    }

    private var retryPayload = RetryPayload()

    func retryLastRequest() {
        guard !isBusy, ensureTutorAvailable() else { return }
        requestTutor(
            signal: nil,
            imageData: retryPayload.imageData,
            regionDescription: retryPayload.regionDescription,
            attachmentIDs: retryPayload.attachmentIDs
        )
    }

    /// Starts one tutor turn and consumes it as a stream rather than waiting
    /// for a single reply.
    ///
    /// The first of `.reasoningDelta`, `.step` or `.textDelta` appends an
    /// empty tutor `TutorMessage` with an empty `ActivityTrail`; every event
    /// after that mutates that same message in place — reasoning and steps
    /// build the trail, text grows the reply — so the bubble and its trail
    /// fill in as the turn runs instead of appearing all at once. A turn
    /// that never reaches any of the three (an immediate `.failure`, say)
    /// never creates a message at all, which is deliberate: an empty bubble
    /// for a turn that never said anything would be a bubble about nothing.
    /// `.workspace` arrives as a whole, already-paired plan and exercise —
    /// the streaming protocol makes a mismatched half-pair structurally
    /// impossible, so unlike the old `TutorReply` path there is nothing to
    /// defensively guard here. `.failure` surfaces its message and leaves
    /// the current workspace exactly as it was; whatever partial text had
    /// already streamed into the tutor message stays visible.
    ///
    /// `persist()` runs once, on `.done` — not per delta, or every token
    /// would thrash the disk with a session-file write.
    private func requestTutor(
        signal: LearningSignal?,
        imageData: Data? = nil,
        regionDescription: String? = nil,
        attachmentIDs: [UUID] = [],
        voiceRequest: String? = nil,
        onDone: ((String) -> Void)? = nil,
        onFinish: ((Result<String, Error>) -> Void)? = nil
    ) {
        // A delegated voice turn: the failure register is the call, not the
        // thread. The voice model receives the error as `function_call_output`
        // and apologises aloud; a retry chip beside that apology would offer
        // to resend a paraphrase the learner never typed.
        let isVoiceTurn = voiceRequest != nil
        guard ensureTutorAvailable() else {
            isLoading = false
            isEvaluating = false
            activeRequestTask = nil
            onFinish?(.failure(TutorServiceError.notConfigured))
            return
        }
        // **The session this turn belongs to, decided once, here.** A delegated
        // voice turn belongs to the call's session however the learner then
        // wanders; every other turn belongs to what is on screen. Everything
        // below reads and writes through this id rather than through `session`,
        // which is what keeps a voice turn out of the thread the learner is
        // browsing — see `mutateSession`.
        let turnSession = (isVoiceTurn ? callSessionID : nil) ?? session.id
        guard let base = sessionValue(turnSession) else {
            onFinish?(.failure(TutorServiceError.notConfigured))
            return
        }
        let isVisibleTurn = turnSession == session.id
        turnSessionID = turnSession
        awayTurnIsRunning = !isVisibleTurn
        isLoading = isVisibleTurn
        errorMessage = nil
        phase = nil
        // Recorded before the turn goes out, so a retry re-sends what this one
        // sent rather than a stripped-down version of it. See `RetryPayload`.
        retryPayload = RetryPayload(
            imageData: imageData,
            regionDescription: regionDescription,
            attachmentIDs: attachmentIDs
        )
        // A delegated voice turn rides the wire as its own learner line — the
        // body's `text` is the last message's — without ever entering the
        // thread: the learner's spoken words are already there, and the voice
        // model's paraphrase is not something they said.
        var turnMessages = base.messages
        if let voiceRequest {
            turnMessages.append(TutorMessage(role: .learner, text: voiceRequest, signal: .voice))
        }
        let request = TutorRequest(
            messages: turnMessages,
            // The first thing they *said*. A selection sent on its own carries no
            // words at all now, so "first learner turn" and "first learner turn
            // with something in it" have stopped being the same message — and a
            // session that opened with a picture would otherwise report its goal
            // as the empty string.
            goal: base.messages.first { $0.role == .learner && !$0.text.isEmpty }?.text,
            exercise: base.exercise,
            plan: base.plan,
            imageData: imageData,
            imageRegionDescription: regionDescription,
            // Every turn, not just the ones that attach a selection — see
            // `boardProvider`. Rendering is not free (a 3,000px PNG of the
            // student's work), but it happens once per send, on the same tap
            // that is about to open a network connection anyway.
            //
            // **The three providers read the live canvas, so they answer for
            // the visible board and only for it.** A turn pinned to a session
            // the learner has walked out of must never be handed the board they
            // are looking at now: nothing is drawing on the call session's
            // board while they are away, so the tutor works from its stored
            // scene instead — the exact scene it drew there, carried on
            // `boardSceneStored` — and no picture at all. `view_board` is not
            // limited the same way: it renders the turn's own board on demand,
            // wherever the learner is standing. See `storedBoard(for:)`.
            boardOverview: isVisibleTurn ? boardProvider?() : nil,
            boardManifest: isVisibleTurn ? boardManifestProvider?() : nil,
            boardScene: isVisibleTurn
                ? boardSceneProvider?()
                : storedBoard(for: turnSession).flatMap {
                    Self.storedSceneContext($0)
                },
            // The ids the composer's uploads came back with. Nothing here has
            // bytes: the server already holds the file and this turn only names
            // it — see `TutorRequest.attachmentIDs`.
            attachmentIDs: attachmentIDs,
            signal: signal,
            sessionID: turnSession,
            model: base.selectedModel,
            reasoningEffort: base.reasoningEffort
        )
        let service = tutorService
        activeRequestTask = Task { [weak self] in
            guard let self else { return }
            // An edit's cut is owed to the server before this turn may go
            // out: context is assembled from the server's own rows, so a turn
            // sent first would be answered from the tail the learner just
            // removed. On a refusal the turn fails the thread's normal way —
            // loudly, with the retry chip — and the debt is kept, so the
            // retry pays it before trying again.
            /// The turn's one completion for `onFinish`, on whichever path
            /// ends it — `.done`, `.failure`, a thrown error, or a stream
            /// that simply stopped. Idempotent so no path has to prove it is
            /// the only one that ran; a voice turn's continuation must resume
            /// exactly once or the engine's single-flight jams forever.
            var pendingFinish = onFinish
            func finish(_ result: Result<String, Error>) {
                pendingFinish?(result)
                pendingFinish = nil
            }

            /// Everything a finished turn puts back, wherever the turn landed.
            /// `phase` and `isLoading` describe the *visible* thread, so an
            /// away turn clears only the pipeline's own busy flag.
            /// Once per turn: the next turn may already have started by the
            /// time this turn's stream actually closes, and clearing its flags
            /// would leave the pipeline claiming to be idle mid-reply.
            var didSettle = false
            @MainActor
            func settleTurnFlags() {
                guard !didSettle else { return }
                didSettle = true
                self.phase = nil
                self.isLoading = false
                self.isEvaluating = false
                self.awayTurnIsRunning = false
                if self.turnSessionID == turnSession { self.turnSessionID = nil }
            }

            if let prefix = self.pendingTranscriptSync[turnSession] {
                guard await service.replaceTranscript(
                    sessionID: request.sessionID, messages: prefix
                ) else {
                    settleTurnFlags()
                    if !isVoiceTurn {
                        self.errorMessage = "I couldn’t update the conversation on the tutor service just now."
                    }
                    self.logger.error("""
                        Transcript sync failed ahead of a turn; the turn was not sent.
                        """)
                    finish(.failure(TutorServiceError.network(
                        "The conversation could not be updated on the tutor service."
                    )))
                    return
                }
                self.pendingTranscriptSync[turnSession] = nil
            }
            var accumulatedText = ""
            var tutorMessageID: UUID?
            // Measured on the device, not sent by the server: `ActivityTrail.duration`
            // claims to be the wait as the learner experienced it, and that includes
            // the network. Started here rather than at `requestTutor`'s first line so
            // it does not also count the time this closure spent waiting to be
            // scheduled.
            let startedAt = Date.now

            /// The tutor's message for this turn, created on first use.
            ///
            /// Lazily rather than at the head of the turn: the trail now starts
            /// before any prose exists, so the message can no longer wait for the
            /// first `.textDelta` the way it used to — but a turn that dies before
            /// the provider answers still must not leave an empty bubble in the
            /// thread. So the message is created by whichever of reasoning, a step,
            /// or text happens to arrive first, and by nothing else.
            ///
            /// `@MainActor` because a nested function does not inherit the actor
            /// isolation of the closure holding it, the way the closure itself
            /// inherits it from `TutorStore`. Without it this reads and mutates
            /// `session` from a nonisolated context, which Swift 6 rejects.
            ///
            /// Remembered by **id, not index**: a delegated voice response can
            /// remove its spoken transcript from the thread while this turn is
            /// still open (`finishVoiceAssistantResponse`), and a cached index
            /// into a list something else may shorten is a write into the
            /// wrong message.
            ///
            /// Addressed by **session id as well as message id** now: a
            /// delegated voice turn writes into the call's session, which may
            /// not be the one on screen — see `mutateSession`.
            @MainActor
            func withMessage(_ change: (inout TutorMessage) -> Void) {
                if tutorMessageID == nil {
                    var message = TutorMessage(role: .tutor, text: "")
                    message.activity = ActivityTrail()
                    guard self.mutateSession(turnSession, { $0.messages.append(message) })
                    else { return }
                    tutorMessageID = message.id
                }
                guard let id = tutorMessageID else { return }
                self.mutateSession(turnSession) { stored in
                    guard let index = stored.messages.firstIndex(where: { $0.id == id }) else {
                        return
                    }
                    change(&stored.messages[index])
                }
            }

            /// Reads the turn's trail out of the message, lets `change` mutate it,
            /// and writes the result back.
            ///
            /// `ActivityTrail` is a value type sitting inside `session.messages`,
            /// an `@Published` array — there is no way to mutate one of its rows in
            /// place, only to replace it, so every trail edit is a read-modify-write
            /// through here rather than through the array's subscript directly.
            ///
            /// `@MainActor` for the reason `messageIndex` above carries it.
            @MainActor
            func withTrail(_ change: (inout ActivityTrail) -> Void) {
                withMessage { message in
                    var trail = message.activity ?? ActivityTrail()
                    change(&trail)
                    message.activity = trail
                }
            }

            do {
                for try await event in service.stream(request) {
                    switch event {
                    case .status(let newPhase, _):
                        // The status line belongs to the thread on screen. An
                        // away turn's stages would be drawn against a
                        // conversation they have nothing to do with.
                        if self.session.id == turnSession { self.phase = newPhase }
                    case .reasoningDelta(let chunk):
                        withTrail { $0.appendReasoning(chunk) }
                    case .step(let id, let tool, let label):
                        withTrail { $0.upsert(TrailStep(id: id, tool: tool, label: label)) }
                    case .textDelta(let chunk):
                        accumulatedText += chunk
                        withMessage { $0.text = accumulatedText }
                    case .boardViewed(let callID, let imageData, _):
                        // Written to `boardCropStore`, not into the message: a
                        // `TutorMessage` is `Codable` and goes into the session
                        // file on every save, so a PNG carried on it would be
                        // rewritten on every later save for the rest of the
                        // session. The trail holds only the id `crop(for:)` reads
                        // back by.
                        let imageID = UUID()
                        self.boardCropStore.save(imageData, for: imageID, in: turnSession)
                        withTrail { $0.setImage(imageID, forStep: callID) }
                    case .boardRequest:
                        // Answered inside the service, which owns the network and
                        // the renderer. It reaches here only as `.boardViewed`.
                        break
                    case .searchSources(let searchID, let query, let incoming):
                        // Sources are evidence, not token deltas: they arrive as
                        // discrete batches and must be visible even when the turn
                        // only updates the board and writes little or no prose.
                        // `search_id`/`query` ride along for context, and the
                        // rows themselves dedupe on `id`/`url` across batches.
                        withMessage { message in
                            message.sources = Self.mergedSources(
                                existing: message.sources, incoming: incoming
                            )
                            var trail = message.activity ?? ActivityTrail()
                            trail.upsertSearch(id: searchID, query: query, sources: incoming)
                            message.activity = trail
                        }
                    case .workspace(let plan, let exercise):
                        self.mutateSession(turnSession) {
                            $0.plan = plan
                            $0.exercise = exercise
                        }
                        // The axis is the screen's, so it only moves for the
                        // session on screen; the pair itself is stored either
                        // way, and `adopt` reads it back on return.
                        if self.session.id == turnSession { self.isWorkspace = true }
                    case .boardUpdate(let update):
                        // A board update is a coarse, user-visible mutation,
                        // not a token delta. Apply and persist it immediately:
                        // if the prose stream fails afterward, the diagram the
                        // learner can already see must still survive a relaunch.
                        // It lands on the *turn's* board — the call session's
                        // scene while the learner is elsewhere, which the
                        // canvas picks up when they come back (the canvas is
                        // keyed on the session id and remounts on the switch).
                        self.mutateSession(turnSession) {
                            $0.boardScene = $0.boardScene.applying(update)
                        }
                        self.persistSession(turnSession)
                    case .done:
                        if tutorMessageID != nil {
                            withMessage {
                                $0.activity?.duration = Date.now.timeIntervalSince(startedAt)
                            }
                        }
                        settleTurnFlags()
                        if signal == .evaluate, let tutorMessageID,
                           self.session.id == turnSession {
                            self.evaluationMessageID = tutorMessageID
                        }
                        self.mutateSession(turnSession) { $0.lastSavedAt = .now }
                        self.persistSession(turnSession)
                        onDone?(accumulatedText)
                        finish(.success(accumulatedText))
                    case .failure(let message, let retryable):
                        // `activity?.duration` is deliberately left untouched here
                        // — it stays `nil` unless a message was never even
                        // created. A trail that never finished must not claim a
                        // time.
                        settleTurnFlags()
                        // The server's text is logged and goes no further. It
                        // used to be assigned straight to `errorMessage` and
                        // handed to the voice model, and what arrived in it once
                        // was the provider's own rate-limit error — the model
                        // name, the organization id and the account's per-minute
                        // ceiling, on a child's iPad and read aloud in a call.
                        // What the learner is told is this app's own sentence,
                        // chosen from the one structured fact the event carries.
                        let copy = Self.failureMessage(retryable: retryable)
                        if !isVoiceTurn {
                            self.errorMessage = copy
                        }
                        self.logger.error("""
                            Tutor turn failed: retryable=\(retryable, privacy: .public) \
                            \(message, privacy: .private)
                            """)
                        finish(.failure(TutorServiceError.network(copy)))
                    }
                }
                // A stream that stopped without `.done` or `.failure` still
                // has to resolve the turn's completion — a voice continuation
                // left hanging jams the engine's single-flight forever, and a
                // busy flag left standing jams the pipeline the same way.
                settleTurnFlags()
                finish(.failure(TutorServiceError.invalidResponse))
            } catch {
                settleTurnFlags()
                if !isVoiceTurn {
                    // Board 14's line, not the error's own. This is the turn
                    // that never reached the service — a timeout, a dropped
                    // connection, no route to the Mac — and "The request timed
                    // out." is `URLError`'s wording for a developer, not
                    // something to put in a thread. The exact cause is on the
                    // log line below, which is where `describe` exists to be
                    // read.
                    self.errorMessage = ChatErrorState.networkMessage
                }
                finish(.failure(error))
                // `localizedDescription` alone is what made a real failure
                // undiagnosable: "The request timed out." and "I couldn't reach
                // the tutor service just now." are the same sentence to anyone
                // reading afterwards, and the thread deliberately shows the
                // second no matter which happened. The domain and code are the
                // part that names it — `NSURLErrorDomain` −1001 is a timeout,
                // −1009 is no network, −1005 is the connection dropped — and
                // they are what a `log show` from the device can be grepped for.
                self.logger.error("""
                    Tutor turn failed: \(Self.describe(error), privacy: .public)
                    """)
            }
        }
    }

    /// Merges a `search_sources` batch into a message's existing sources.
    ///
    /// A repeated event with the same rows must not duplicate them. Within a
    /// batch, the same `id` or `url` is one source even if the backend repeats
    /// it across events. A later row with a known `id` replaces the earlier one
    /// so a refined batch upgrades a result instead of stacking a second copy;
    /// a row whose `url` is already present under another id is skipped.
    static func mergedSources(existing: [TutorSource], incoming: [TutorSource]) -> [TutorSource] {
        var merged = existing
        var urls = Set(merged.map { $0.url })
        for source in incoming {
            if let index = merged.firstIndex(where: { $0.id == source.id }) {
                let previousURL = merged[index].url
                merged[index] = source
                urls.remove(previousURL)
                urls.insert(source.url)
            } else if !urls.contains(source.url) {
                merged.append(source)
                urls.insert(source.url)
            }
        }
        return merged
    }

    /// The board context for a turn whose session is not on screen — a
    /// delegated voice turn while the learner browses somewhere else.
    ///
    /// It carries the **that** session's saved board: the learner's stored ink
    /// and the tutor's own scene. Nothing the live canvas knows travels — no
    /// viewport, no learner ink clusters derived from the live pen. Those are
    /// facts about the board on screen, and the board on screen belongs to
    /// another session. What must travel is everything `view_board` can render
    /// plus the geometry the model needs to place content, so the envelope now
    /// reports learner ink bounds and the overview extent even when the tutor
    /// scene is empty — an offscreen board that is all learner ink is real,
    /// renderable content, and reporting it empty was the reported bug.
    ///
    /// `has_renderable_content` is the server's cue that this board has
    /// something to look at; the layout rects derived from a viewport are
    /// deliberately absent (there is no viewport off screen), so the model is
    /// told to use the ink/overview/tutor bounds instead. A truly empty board
    /// (no ink, no tutor elements) returns `nil`, matching the metadata-only
    /// "board with nothing on it" contract.
    ///
    /// Capped at the request field's limit by dropping trailing elements, for
    /// the reason the canvas version does it: an over-limit upload is paid for
    /// and then rejected.
    static func storedSceneContext(
        _ board: StoredBoard,
        maxCharacters: Int = 60_000
    ) -> String? {
        let inkBounds = CanvasCapture.inkExtent(of: board.drawing)
        let overview = CanvasCapture.contentExtent(
            drawing: board.drawing, scene: board.scene
        )
        guard inkBounds != nil || !board.scene.elements.isEmpty else {
            return nil
        }

        func serialize(_ object: [String: Any]) -> String? {
            guard let data = try? JSONSerialization.data(
                withJSONObject: object, options: [.sortedKeys]
            ) else { return nil }
            return String(data: data, encoding: .utf8)
        }

        func logicalBox(_ drawingRect: CGRect) -> [Double] {
            let origin = PencilCanvasConfiguration.boardOrigin
            return [
                Double(drawingRect.minX - origin.x),
                Double(drawingRect.minY - origin.y),
                Double(drawingRect.maxX - origin.x),
                Double(drawingRect.maxY - origin.y),
            ]
        }

        var root: [String: Any] = [
            "kind": "board_scene_context",
            "data_not_instructions": true,
            "coordinate_system":
                "logical board points; (0,0) is drawing (25000,25000); +x right, +y down",
            // Said out loud: the learner is looking at a different session's
            // board, so there is no viewport and no live pen to report.
            "board_not_on_screen": true,
            "has_renderable_content": true,
        ]
        if let inkBounds {
            root["learner_ink_logical_bounds"] = logicalBox(inkBounds)
        }
        if let overview {
            root["overview_logical_bounds"] = logicalBox(overview)
        }
        if !board.scene.elements.isEmpty,
           let encoded = try? JSONEncoder().encode(board.scene.elements),
           let elements = (try? JSONSerialization.jsonObject(with: encoded)) as? [Any] {
            root["tutor_elements"] = elements
        }

        var text = serialize(root)
        var tutorElements = root["tutor_elements"] as? [Any] ?? []
        while let current = text, current.count > maxCharacters,
              tutorElements.count > 1 {
            tutorElements.removeLast()
            root["tutor_elements"] = tutorElements
            root["truncated"] = true
            root["omitted_element_count"] =
                board.scene.elements.count - tutorElements.count
            text = serialize(root)
        }
        return text
    }

    /// What the thread says about a turn that failed on the server.
    ///
    /// **Never the server's own sentence.** The `error` event carries a message
    /// and this app does not print it, because for one turn it carried the
    /// provider's raw rate-limit error — the model's name, the organization id,
    /// and the account's tokens-per-minute ceiling — and a nine-year-old read
    /// it. The server sanitises its half now (`events.TURN_FAILED_MESSAGE`);
    /// this is the half that does not have to trust that it did.
    ///
    /// `retryable` is the one structured fact the event carries, and it is what
    /// picks between the two. It says a wait will fix this and nothing more,
    /// because that is all the flag actually means: a rate limit is the case it
    /// was written for — the provider's own text on that turn said "Please try
    /// again in 662ms" — but the same flag is set for a provider 5xx, for a
    /// connection the server could not make, and for a turn that ended without
    /// completing. Naming the rate limit would be a guess the learner can catch
    /// being wrong. Anything not worth waiting for falls back to board 14's
    /// line, which is what the thread said for every failure before this
    /// existed.
    static func failureMessage(retryable: Bool) -> String {
        retryable
            ? "The tutor is busy right now — try again in a moment."
            : ChatErrorState.networkMessage
    }

    /// A failure named precisely enough to act on — for the log, never a screen.
    ///
    /// The thread shows one of this app's own short sentences whatever went
    /// wrong — see `failureMessage` — so this is the only place the actual cause
    /// is ever stated, and it is free to be exact and unfriendly. A `URLError`'s
    /// numeric code is the part that distinguishes the cases that look
    /// identical to a learner: −1001 timed out
    /// (the stream went quiet for longer than `BackendTutorService.streamTimeout`),
    /// −1005 the connection dropped, −1009 the iPad had no route to the Mac.
    static func describe(_ error: Error) -> String {
        if let urlError = error as? URLError {
            let url = urlError.failingURL?.absoluteString ?? "-"
            return "URLError \(urlError.code.rawValue) \(urlError.localizedDescription) url=\(url)"
        }
        if let serviceError = error as? TutorServiceError {
            return "TutorServiceError.\(serviceError)"
        }
        return "\(type(of: error)) \(error.localizedDescription)"
    }

    /// Every save goes through here, so every save carries the board's current
    /// ink and camera whether or not their rest timers have come up yet. That is
    /// what lets `updateDrawing` and `updateCamera` stay off `session` without
    /// any caller having to know.
    private func persist() {
        foldPendingBoardInk()
        foldPendingBoardCamera()
        var snapshot = session
        if let boardInkData { snapshot.drawingData = boardInkData }
        guard changedSinceLastWrite(snapshot) else { return }
        if changesLastModifiedDate(snapshot) {
            snapshot.lastSavedAt = .now
        } else if let baseline = lastModificationBaseline {
            // Camera position is persisted state, but navigating the board is
            // not editing the learning session. Keep the exact prior clock so
            // SessionPersistence's index upsert cannot reorder the drawer.
            snapshot.lastSavedAt = baseline.lastSavedAt
        }
        lastWritten = snapshot
        lastModificationBaseline = snapshot
        persistence.save(snapshot)
        // The switcher's other rows come from the index, and this is the write
        // that just changed it — a session saved is a session moved to the top
        // of the list.
        refreshSessions()
    }

    /// The session exactly as it was last written to disk, or `nil` when what is
    /// in hand has never been written.
    ///
    /// This is what makes "last modified" mean modified. Without it every
    /// `persist()` stamped `lastSavedAt = .now`, so simply opening a session and
    /// moving on re-saved it unchanged — the switcher then showed it as the most
    /// recent thing you did and floated it to the top of the list, when all you
    /// had done was look at it.
    private var lastWritten: LearningSession?

    /// The last state against which "did the learner change this session?" is
    /// judged. Unlike `lastWritten`, this exists for a fresh session before its
    /// first file is created. Camera and clock are normalized out of the
    /// comparison; everything else remains an edit and advances the date.
    private var lastModificationBaseline: LearningSession?

    private func changesLastModifiedDate(_ snapshot: LearningSession) -> Bool {
        guard var previous = lastModificationBaseline else { return true }
        let current = snapshot
        previous.lastSavedAt = current.lastSavedAt
        previous.boardCamera = current.boardCamera
        return previous != current
    }

    /// Whether `snapshot` differs from the last thing written in any way that is
    /// not the clock itself.
    ///
    /// `lastSavedAt` is normalised out before comparing because it is the field
    /// being decided: several callers set it before calling `persist`, and
    /// comparing it would make every save look like a change and defeat the
    /// whole check. Everything else on `LearningSession` is content — messages,
    /// ink, the tutor's scene, the plan, the model — and any of it moving is a
    /// real edit.
    ///
    /// Note what is deliberately *not* here: `isWorkspace`, the presentation
    /// axes, and which session is open. None of them lives on
    /// `LearningSession`, so `startWorking()` and `returnToChat()` no longer
    /// touch the clock — correctly, because neither changes anything a reload
    /// would bring back.
    private func changedSinceLastWrite(_ snapshot: LearningSession) -> Bool {
        guard var previous = lastWritten else { return true }
        previous.lastSavedAt = snapshot.lastSavedAt
        return previous != snapshot
    }

    @discardableResult
    private func ensureTutorAvailable() -> Bool {
        guard canRequestTutor else {
            errorMessage = TutorServiceError.notConfigured.errorDescription
            return false
        }
        return true
    }
}
