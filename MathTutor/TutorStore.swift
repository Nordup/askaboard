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
        #else
        let shouldSeedE2E = false
        let shouldSeedScene = false
        #endif
        self.startsClean = isUITestReset
        let stored = isUITestReset ? nil : persistence.loadCurrent()
        var restored = stored ?? .empty
        #if DEBUG
        if shouldSeedE2E { E2ESeedFixture.seedSession(&restored) }
        if shouldSeedScene { E2ESeedFixture.seedScene(&restored) }
        #endif
        self.session = restored
        // What is already on disk, so launching and quitting without touching
        // anything writes nothing and moves no clocks. `nil` whenever the
        // session in hand is *not* what the file holds — nothing stored, or a
        // seeded fixture — because then the first save has real work to do.
        self.lastWritten = (stored != nil && !shouldSeedE2E && !shouldSeedScene)
            ? restored
            : nil
        self.usesLiveTutor = configuration != nil
        let usingDemoService = resolvedService is DemoTutorService
        self.isWorkspace = restored.plan != nil && restored.exercise != nil && (self.usesLiveTutor || usingDemoService)
        if shouldSeedE2E || shouldSeedScene { persistence.save(restored) }
        refreshSessions()
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
        guard !isLoading else {
            composerNote = Self.tutorIsStillAnswering
            return false
        }
        guard ensureTutorAvailable() else { return false }
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

    /// Brings `boardInkData` up to date with the pen. Serializing here rather than
    /// in `updateDrawing` is the whole point: `dataRepresentation()` walks every
    /// stroke on the board, so it runs once per save instead of once per stroke.
    private func foldPendingBoardInk() {
        guard let pendingBoardInk else { return }
        self.pendingBoardInk = nil
        boardInkData = pendingBoardInk.dataRepresentation()
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
        guard !isEvaluating else {
            composerNote = Self.tutorIsStillAnswering
            return false
        }
        guard ensureTutorAvailable() else { return false }
        isEvaluating = true
        evaluationText = nil
        evaluationMessageID = nil
        errorMessage = nil
        composerNote = nil
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
            attachmentIDs: attachments.map(\.attachment.id)
        ) { [weak self] text in
            self?.evaluationText = text
        }
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
        guard !isLoading, ensureTutorAvailable() else { return }
        session.messages.append(TutorMessage(role: .learner, text: "I don’t know yet.", signal: .dontKnow))
        persist()
        requestTutor(signal: .dontKnow)
    }

    func clearEvaluation() {
        evaluationText = nil
        evaluationMessageID = nil
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
        let turnWasInFlight = isLoading || isEvaluating
        activeRequestTask?.cancel()
        activeRequestTask = nil
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
        if notifyingServer {
            endSessionOnServer(turnWasInFlight: turnWasInFlight)
        }
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
    private func endSessionOnServer(turnWasInFlight: Bool) {
        guard !turnWasInFlight, usesLiveTutor, hasReachedTheBackend else { return }
        let service = tutorService
        let id = session.id
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
        guard usesLiveTutor else { return }
        let service = tutorService
        Task.detached { await service.deleteSession(id: id) }
    }

    /// Whether a turn has ever gone out for the open session.
    ///
    /// Every path that starts one appends a learner message first — `send`,
    /// `sayIDontKnow` and `evaluate` — and a turn is the only thing that
    /// creates the session server-side, so this is the same question as "does
    /// the backend have a row for this id", short of a turn that never reached
    /// the network at all.
    private var hasReachedTheBackend: Bool {
        session.messages.contains {
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
        discardBoardInk()
        lastWritten = isStored ? next : nil
        session = next
        isWorkspace = next.plan != nil && next.exercise != nil && canRequestTutor
        evaluationText = nil
        evaluationMessageID = nil
        errorMessage = nil
        // Attachment ids are scoped to the session they were uploaded against,
        // so the previous session's payload is not a thing this one may re-send.
        retryPayload = RetryPayload()
        selectionViews = [:]
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

    func setModel(_ model: ModelChoice) {
        session.selectedModel = model
        persist()
    }

    func setReasoningEffort(_ reasoningEffort: ReasoningEffort) {
        session.reasoningEffort = reasoningEffort
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
        guard !isLoading, ensureTutorAvailable() else { return }
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
        onDone: ((String) -> Void)? = nil
    ) {
        guard ensureTutorAvailable() else {
            isLoading = false
            isEvaluating = false
            activeRequestTask = nil
            return
        }
        isLoading = true
        errorMessage = nil
        phase = nil
        // Recorded before the turn goes out, so a retry re-sends what this one
        // sent rather than a stripped-down version of it. See `RetryPayload`.
        retryPayload = RetryPayload(
            imageData: imageData,
            regionDescription: regionDescription,
            attachmentIDs: attachmentIDs
        )
        let request = TutorRequest(
            messages: session.messages,
            // The first thing they *said*. A selection sent on its own carries no
            // words at all now, so "first learner turn" and "first learner turn
            // with something in it" have stopped being the same message — and a
            // session that opened with a picture would otherwise report its goal
            // as the empty string.
            goal: session.messages.first { $0.role == .learner && !$0.text.isEmpty }?.text,
            exercise: session.exercise,
            plan: session.plan,
            imageData: imageData,
            imageRegionDescription: regionDescription,
            // Every turn, not just the ones that attach a selection — see
            // `boardProvider`. Rendering is not free (a 3,000px PNG of the
            // student's work), but it happens once per send, on the same tap
            // that is about to open a network connection anyway.
            boardOverview: boardProvider?(),
            boardManifest: boardManifestProvider?(),
            boardScene: boardSceneProvider?(),
            // The ids the composer's uploads came back with. Nothing here has
            // bytes: the server already holds the file and this turn only names
            // it — see `TutorRequest.attachmentIDs`.
            attachmentIDs: attachmentIDs,
            signal: signal,
            sessionID: session.id,
            model: session.selectedModel,
            reasoningEffort: session.reasoningEffort
        )
        let service = tutorService
        activeRequestTask = Task { [weak self] in
            guard let self else { return }
            var accumulatedText = ""
            var tutorMessageIndex: Int?
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
            @MainActor
            func messageIndex() -> Int {
                if let tutorMessageIndex { return tutorMessageIndex }
                self.session.messages.append(TutorMessage(role: .tutor, text: ""))
                let index = self.session.messages.count - 1
                self.session.messages[index].activity = ActivityTrail()
                tutorMessageIndex = index
                return index
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
                let index = messageIndex()
                var trail = self.session.messages[index].activity ?? ActivityTrail()
                change(&trail)
                self.session.messages[index].activity = trail
            }

            do {
                for try await event in service.stream(request) {
                    switch event {
                    case .status(let newPhase, _):
                        self.phase = newPhase
                    case .reasoningDelta(let chunk):
                        withTrail { $0.appendReasoning(chunk) }
                    case .step(let id, let tool, let label):
                        withTrail { $0.upsert(TrailStep(id: id, tool: tool, label: label)) }
                    case .textDelta(let chunk):
                        accumulatedText += chunk
                        let index = messageIndex()
                        self.session.messages[index].text = accumulatedText
                    case .boardViewed(let callID, let imageData, _):
                        // Written to `boardCropStore`, not into the message: a
                        // `TutorMessage` is `Codable` and goes into the session
                        // file on every save, so a PNG carried on it would be
                        // rewritten on every later save for the rest of the
                        // session. The trail holds only the id `crop(for:)` reads
                        // back by.
                        let imageID = UUID()
                        self.boardCropStore.save(imageData, for: imageID, in: self.session.id)
                        withTrail { $0.setImage(imageID, forStep: callID) }
                    case .boardRequest:
                        // Answered inside the service, which owns the network and
                        // the renderer. It reaches here only as `.boardViewed`.
                        break
                    case .workspace(let plan, let exercise):
                        self.session.plan = plan
                        self.session.exercise = exercise
                        self.isWorkspace = true
                    case .boardUpdate(let update):
                        // A board update is a coarse, user-visible mutation,
                        // not a token delta. Apply and persist it immediately:
                        // if the prose stream fails afterward, the diagram the
                        // learner can already see must still survive a relaunch.
                        self.session.boardScene = self.session.boardScene.applying(update)
                        self.persist()
                    case .done:
                        if let tutorMessageIndex {
                            self.session.messages[tutorMessageIndex].activity?.duration =
                                Date.now.timeIntervalSince(startedAt)
                        }
                        self.phase = nil
                        self.isLoading = false
                        self.isEvaluating = false
                        if signal == .evaluate, let tutorMessageIndex {
                            self.evaluationMessageID = self.session.messages[tutorMessageIndex].id
                        }
                        self.session.lastSavedAt = .now
                        self.persist()
                        onDone?(accumulatedText)
                    case .failure(let message, _):
                        // `activity?.duration` is deliberately left untouched here
                        // — it stays `nil` unless a message was never even
                        // created. A trail that never finished must not claim a
                        // time.
                        self.phase = nil
                        self.isLoading = false
                        self.isEvaluating = false
                        self.errorMessage = message
                    }
                }
            } catch {
                self.phase = nil
                self.isLoading = false
                self.isEvaluating = false
                self.errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
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

    /// A failure named precisely enough to act on — for the log, never a screen.
    ///
    /// The thread deliberately shows board 14's fixed copy whatever went wrong,
    /// so this is the only place the actual cause is ever stated, and it is free
    /// to be exact and unfriendly. A `URLError`'s numeric code is the part that
    /// distinguishes the cases that look identical to a learner: −1001 timed out
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
    /// ink whether or not its own rest timer has come up yet. That is what lets
    /// `updateDrawing` stay off `session` without any caller having to know.
    private func persist() {
        foldPendingBoardInk()
        var snapshot = session
        if let boardInkData { snapshot.drawingData = boardInkData }
        guard changedSinceLastWrite(snapshot) else { return }
        snapshot.lastSavedAt = .now
        lastWritten = snapshot
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
