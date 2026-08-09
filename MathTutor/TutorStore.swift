import Foundation
import OSLog
import PencilKit
import SwiftUI

@MainActor
final class TutorStore: ObservableObject {
    @Published private(set) var session: LearningSession
    /// The switcher's rows, most-recent-first, with the open session always at
    /// the front — see `refreshSessions()`.
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
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

    /// The regions the tutor looked at, keyed by the message they belong to.
    ///
    /// Held here rather than on `TutorMessage` because a `TutorMessage` is
    /// `Codable` and goes into `session.json` on every save: a turn that looked
    /// three times would write several hundred kilobytes of PNG into the session
    /// file, and every later save would rewrite them. These are evidence for the
    /// turn you are looking at, not session state, so they live for as long as
    /// the app does and no longer. A thread reloaded from disk shows the replies
    /// without the views, which is the honest outcome — the pictures were never
    /// saved.
    @Published private(set) var boardViews: [UUID: [BoardView]] = [:]

    /// The region the learner marqueed and sent, keyed by the message that
    /// carried it.
    ///
    /// Separate from `boardViews` because it is a different claim: these are what
    /// the *learner* pointed at, and they belong on the learner's own turn. Same
    /// storage reasoning though — a `TutorMessage` is `Codable` and would carry
    /// the PNG into `session.json` on every save.
    @Published private(set) var selectionViews: [UUID: BoardView] = [:]

    /// Views for the turn currently streaming, before it has a message to
    /// attach them to. The tutor can look before it writes a word, so the first
    /// view usually arrives with no tutor message in the session yet.
    private var pendingBoardViews: [BoardView] = []

    let tutorService: any TutorService
    let persistence: SessionPersistence
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
        var restored = isUITestReset ? .empty : (persistence.loadCurrent() ?? .empty)
        #if DEBUG
        if shouldSeedE2E { E2ESeedFixture.seedSession(&restored) }
        if shouldSeedScene { E2ESeedFixture.seedScene(&restored) }
        #endif
        if restored.messages.isEmpty {
            restored.messages = [TutorMessage(role: .tutor, text: Self.greeting)]
        }
        self.session = restored
        self.usesLiveTutor = configuration != nil
        let usingDemoService = resolvedService is DemoTutorService
        self.isWorkspace = restored.plan != nil && restored.exercise != nil && (self.usesLiveTutor || usingDemoService)
        if shouldSeedE2E || shouldSeedScene { persistence.save(restored) }
        refreshSessions()
    }

    /// The tutor's opening line in a session nobody has said anything in yet.
    ///
    /// One constant because three call sites now mint an empty session — launch
    /// with nothing stored, `startNewSession`, and `resetSession` — and a
    /// greeting that differs between them is a difference no one would ever
    /// look for.
    static let greeting = "Hi, I’m your math tutor. What would you like to understand today? You can type a goal in your own words—fractions, algebra, a homework question, anything."

    var hasGoal: Bool {
        session.plan != nil || session.messages.contains { $0.role == .learner && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// True only for an explicitly injected/debug demo service. An unreachable
    /// backend on the production router is a failure, not an offline demo mode.
    var demoMode: Bool { tutorService is DemoTutorService }

    private var canRequestTutor: Bool { demoMode || usesLiveTutor }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isLoading, ensureTutorAvailable() else { return }
        session.messages.append(TutorMessage(role: .learner, text: trimmed))
        session.lastSavedAt = .now
        persist()
        requestTutor(signal: nil)
    }

    func sendQuickPrompt(_ text: String) {
        send(text)
    }

    #if DEBUG
    /// Test-only: sends and then awaits the exact turn `send` just started,
    /// rather than a fixed-length poll — so a test fails on genuine hangs
    /// instead of racing an arbitrary timeout.
    func sendAndWait(_ text: String) async {
        send(text)
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
    /// held onto the text and sent the canned line below in its place, so a student who
    /// wrote "check my work" had the one message they wrote dropped and a generic request
    /// delivered instead. The learner turn is now exactly what they typed — no generated
    /// area description appended — while `regionDescription` still reaches the service on
    /// its own so the model can be told which part of the board the image is of. With no
    /// typed question, retain the existing canned request so an evaluate turn still has
    /// visible copy.
    func evaluate(imageData: Data, regionDescription: String?, question: String? = nil) {
        guard !isEvaluating, ensureTutorAvailable() else { return }
        isEvaluating = true
        evaluationText = nil
        evaluationMessageID = nil
        errorMessage = nil
        let region = regionDescription?.trimmingCharacters(in: .whitespacesAndNewlines)
        let regionLabel = region?.isEmpty == false ? region! : "the whiteboard"
        let asked = question?.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = asked?.isEmpty == false
            ? asked!
            : "Please evaluate my work on " + regionLabel + "."
        let learnerTurn = TutorMessage(role: .learner, text: text, signal: .evaluate)
        session.messages.append(learnerTurn)
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
        requestTutor(signal: .evaluate, imageData: imageData, regionDescription: regionDescription) { [weak self] text in
            self?.evaluationText = text
        }
    }

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
        adopt(freshSession())
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
        adopt(target)
    }

    /// Settings' destructive action: this session is deleted and a new empty one
    /// takes its place. Every other session is untouched.
    ///
    /// It used to be the only session there was, so "reset" and "delete
    /// everything" were the same act. They are not any more, and this is the
    /// narrower of the two — see `docs/TODO.md` on splitting the control.
    func resetSession() {
        closeCurrentSession(saving: false)
        persistence.delete(id: session.id)
        adopt(freshSession())
        persist()
    }

    /// A new session with the tutor's opening line already in it.
    private func freshSession() -> LearningSession {
        var fresh = LearningSession.empty
        fresh.messages = [TutorMessage(role: .tutor, text: Self.greeting)]
        return fresh
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
    private func closeCurrentSession(saving: Bool) {
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
        pendingBoardViews = []
        if saving {
            // Folds any ink the pen's rest timer has not written yet, so a
            // stroke made a moment before the switch lands in the session it was
            // drawn on rather than the one being opened.
            persist()
        }
        boardInkSaveTask?.cancel()
        boardInkSaveTask = nil
        boardInkSaveDeadline = nil
        endSessionOnServer(turnWasInFlight: turnWasInFlight)
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
    /// Reset closes too, though it deletes the session locally a moment later.
    /// The server keeps its own transcript either way and the sweep would
    /// extract it within the day regardless, so skipping the close would not
    /// make a deleted session unremembered — it would only make it remembered
    /// later. Genuinely forgetting one needs an endpoint that discards rather
    /// than closes, and there isn't one.
    private func endSessionOnServer(turnWasInFlight: Bool) {
        guard !turnWasInFlight, usesLiveTutor, hasReachedTheBackend else { return }
        let service = tutorService
        let id = session.id
        // Detached, and its handle deliberately dropped: it has to outlive the
        // switch that triggered it, and nothing on screen is waiting for it.
        Task.detached { await service.closeSession(id: id) }
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
    /// first save would write the previous board's ink into it. The board views
    /// go too — they are evidence for turns in a thread that is no longer on
    /// screen, and they are keyed by message id, so keeping them would only
    /// grow.
    private func adopt(_ next: LearningSession) {
        discardBoardInk()
        session = next
        isWorkspace = next.plan != nil && next.exercise != nil && canRequestTutor
        evaluationText = nil
        evaluationMessageID = nil
        errorMessage = nil
        boardViews = [:]
        selectionViews = [:]
        refreshSessions()
    }

    /// Rebuilds the switcher's rows from the index, with the open session forced
    /// to the front.
    ///
    /// The open session is inserted rather than read from the index because it
    /// is the one row that must be right the instant something changes: a
    /// session gets its name from its plan and its first learner turn, so the
    /// row is expected to stop saying "New session" the moment the learner
    /// sends one — and the index only catches up on the next save.
    private func refreshSessions() {
        var summaries = startsClean ? [] : persistence.loadIndex().sessions
        summaries.removeAll { $0.id == session.id }
        summaries.insert(SessionSummary(session), at: 0)
        sessions = summaries
    }

    func setModel(_ model: ModelChoice) {
        session.selectedModel = model
        persist()
    }

    func setReasoningEffort(_ reasoningEffort: ReasoningEffort) {
        session.reasoningEffort = reasoningEffort
        persist()
    }

    func retryLastRequest() {
        guard !isLoading, ensureTutorAvailable() else { return }
        requestTutor(signal: nil)
    }

    /// Starts one tutor turn and consumes it as a stream rather than waiting
    /// for a single reply.
    ///
    /// The first `.textDelta` appends an empty tutor `TutorMessage`; every
    /// delta after that mutates that same message's `text` in place, so the
    /// bubble grows as the reply is written instead of appearing all at
    /// once. `.workspace` arrives as a whole, already-paired plan and
    /// exercise — the streaming protocol makes a mismatched half-pair
    /// structurally impossible, so unlike the old `TutorReply` path there is
    /// nothing to defensively guard here. `.failure` surfaces its message and
    /// leaves the current workspace exactly as it was; whatever partial text
    /// had already streamed into the tutor message stays visible.
    ///
    /// `persist()` runs once, on `.done` — not per delta, or every token
    /// would thrash the disk with a `session.json` write.
    private func requestTutor(
        signal: LearningSignal?,
        imageData: Data? = nil,
        regionDescription: String? = nil,
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
        pendingBoardViews = []
        let request = TutorRequest(
            messages: session.messages,
            goal: session.messages.first(where: { $0.role == .learner })?.text,
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
            do {
                for try await event in service.stream(request) {
                    switch event {
                    case .status(let newPhase, _):
                        self.phase = newPhase
                    case .reasoningDelta:
                        break
                    case .textDelta(let chunk):
                        accumulatedText += chunk
                        if tutorMessageIndex == nil {
                            self.session.messages.append(TutorMessage(role: .tutor, text: ""))
                            tutorMessageIndex = self.session.messages.count - 1
                        }
                        if let index = tutorMessageIndex {
                            self.session.messages[index].text = accumulatedText
                        }
                    case .boardViewed(let imageData, let detail):
                        let view = BoardView(imageData: imageData, detail: detail)
                        if let index = tutorMessageIndex {
                            self.attach(view, to: self.session.messages[index].id)
                        } else {
                            // The tutor usually looks before it writes, so there
                            // is no message to hang this on yet. `.done` flushes
                            // whatever queued up here.
                            self.pendingBoardViews.append(view)
                        }
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
                        self.flushPendingBoardViews(to: tutorMessageIndex)
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
                self.logger.error("Tutor request failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func attach(_ view: BoardView, to messageID: UUID) {
        boardViews[messageID, default: []].append(view)
    }

    /// Hands the turn's queued views to the message it ended up writing.
    ///
    /// A turn that looked and then said nothing has nowhere to put them, and
    /// they are dropped rather than shown against someone else's message — a
    /// board view under the wrong reply is worse than no board view at all.
    private func flushPendingBoardViews(to tutorMessageIndex: Int?) {
        defer { pendingBoardViews = [] }
        guard let tutorMessageIndex, session.messages.indices.contains(tutorMessageIndex) else { return }
        let id = session.messages[tutorMessageIndex].id
        boardViews[id, default: []].insert(contentsOf: pendingBoardViews, at: 0)
    }

    /// Every save goes through here, so every save carries the board's current
    /// ink whether or not its own rest timer has come up yet. That is what lets
    /// `updateDrawing` stay off `session` without any caller having to know.
    private func persist() {
        foldPendingBoardInk()
        var snapshot = session
        if let boardInkData { snapshot.drawingData = boardInkData }
        snapshot.lastSavedAt = .now
        persistence.save(snapshot)
        // The switcher's other rows come from the index, and this is the write
        // that just changed it — a session saved is a session moved to the top
        // of the list.
        refreshSessions()
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
