import Foundation
import OSLog
import PencilKit
import SwiftUI

@MainActor
final class TutorStore: ObservableObject {
    @Published private(set) var session: LearningSession
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

    let tutorService: any TutorService
    let persistence: SessionPersistence
    let keychain: KeychainStore
    private let logger = Logger(subsystem: "com.nordup.MathTutor", category: "TutorStore")
    /// The in-flight turn's task, kept only so tests can await exactly the
    /// turn a `send`/`evaluate`/etc. call just started rather than polling.
    private var activeRequestTask: Task<Void, Never>?

    init(
        service: any TutorService = TutorServiceRouter(),
        persistence: SessionPersistence = SessionPersistence(),
        keychain: KeychainStore = KeychainStore()
    ) {
        #if DEBUG
        // The offline tutor is available only when a test/debug launch opts into it
        // explicitly. Production/default launches must reach the real backend
        // instead of silently routing around it.
        let useDebugDemo = ProcessInfo.processInfo.arguments.contains("--demo-tutor")
            || ProcessInfo.processInfo.arguments.contains("--ui-test-demo-service")
            || ProcessInfo.processInfo.arguments.contains(E2ESeedFixture.launchArgument)
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
        // Runs on every launch, release included: a real OpenAI key left over from
        // before this migration must not sit in the Keychain forever just because
        // the app stopped sending it anywhere.
        keychain.migrateAwayFromAPIKey()
        let isUITestReset = ProcessInfo.processInfo.arguments.contains("--ui-test-reset")
        #if DEBUG
        // UI tests must never inherit a developer credential from the simulator.
        // This is intentionally compiled only into DEBUG; production launches keep
        // their existing Keychain-backed live behavior unchanged.
        if isUITestReset {
            keychain.removeBackendToken()
        }
        // Local dev loop: seed the Keychain from the launch environment so a
        // simulator run arrives with a token already in place. There is nowhere
        // in the app to type one — see `BackendConfiguration`. Skipped for UI
        // test resets by the same rule above.
        if !isUITestReset, let token = DebugBackendInjection.injectedToken() {
            keychain.saveBackendToken(token)
        }
        let shouldSeedE2E = ProcessInfo.processInfo.arguments.contains(E2ESeedFixture.launchArgument)
        #else
        let shouldSeedE2E = false
        #endif
        var restored = isUITestReset ? .empty : (persistence.load() ?? .empty)
        #if DEBUG
        if shouldSeedE2E { E2ESeedFixture.seedSession(&restored) }
        #endif
        if restored.messages.isEmpty {
            restored.messages = [TutorMessage(role: .tutor, text: "Hi, I’m your math tutor. What would you like to understand today? You can type a goal in your own words—fractions, algebra, a homework question, anything.")]
        }
        self.session = restored
        self.usesLiveTutor = BackendConfiguration.load(keychain: keychain) != nil
        let usingDemoService = resolvedService is DemoTutorService
        self.isWorkspace = restored.plan != nil && restored.exercise != nil && (self.usesLiveTutor || usingDemoService)
        if shouldSeedE2E { persistence.save(restored) }
    }

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

    /// The board reporting that its ink changed.
    ///
    /// This is the hot path — it can fire many times per second while erasing —
    /// so it does exactly two cheap things: keep the drawing (a struct, so this is
    /// a retain, not a copy) and push the save out to the far side of the pen's
    /// next rest.
    func updateDrawing(_ drawing: PKDrawing) {
        pendingBoardInk = drawing
        boardInkSaveTask?.cancel()
        boardInkSaveTask = Task { [weak self] in
            try? await Task.sleep(for: Self.boardInkRestBeforeSave)
            guard !Task.isCancelled else { return }
            self?.saveBoardInkNow()
        }
    }

    /// Writes the board without waiting out the rest of the pen's rest. The scene
    /// leaving the foreground is the case this exists for.
    func saveBoardInkNow() {
        guard pendingBoardInk != nil else { return }
        boardInkSaveTask?.cancel()
        boardInkSaveTask = nil
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
        pendingBoardInk = nil
        boardInkData = nil
    }

    func evaluate(imageData: Data, regionDescription: String?) {
        guard !isEvaluating, ensureTutorAvailable() else { return }
        isEvaluating = true
        evaluationText = nil
        evaluationMessageID = nil
        errorMessage = nil
        let region = regionDescription?.trimmingCharacters(in: .whitespacesAndNewlines)
        let regionLabel = region?.isEmpty == false ? region! : "the whiteboard"
        session.messages.append(
            TutorMessage(
                role: .learner,
                text: "Please evaluate my work on " + regionLabel + ".",
                signal: .evaluate
            )
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

    func resetSession() {
        discardBoardInk()
        session = .empty
        session.messages = [TutorMessage(role: .tutor, text: "Hi, I’m your math tutor. What would you like to understand today? You can type a goal in your own words—fractions, algebra, a homework question, anything.")]
        isWorkspace = false
        evaluationText = nil
        evaluationMessageID = nil
        errorMessage = nil
        persist()
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
        let request = TutorRequest(
            messages: session.messages,
            goal: session.messages.first(where: { $0.role == .learner })?.text,
            exercise: session.exercise,
            plan: session.plan,
            imageData: imageData,
            imageRegionDescription: regionDescription,
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
                    case .workspace(let plan, let exercise):
                        self.session.plan = plan
                        self.session.exercise = exercise
                        self.isWorkspace = true
                    case .done:
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

    /// Every save goes through here, so every save carries the board's current
    /// ink whether or not its own rest timer has come up yet. That is what lets
    /// `updateDrawing` stay off `session` without any caller having to know.
    private func persist() {
        foldPendingBoardInk()
        var snapshot = session
        if let boardInkData { snapshot.drawingData = boardInkData }
        snapshot.lastSavedAt = .now
        persistence.save(snapshot)
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
