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

    let tutorService: any TutorService
    let persistence: SessionPersistence
    let keychain: KeychainStore
    private let logger = Logger(subsystem: "com.nordup.MathTutor", category: "TutorStore")

    init(
        service: any TutorService = TutorServiceRouter(),
        persistence: SessionPersistence = SessionPersistence(),
        keychain: KeychainStore = KeychainStore()
    ) {
        #if DEBUG
        // The offline tutor is available only when a test/debug launch opts into it
        // explicitly. Production/default launches must surface the missing-key state
        // instead of silently routing around the live provider.
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
        let isUITestReset = ProcessInfo.processInfo.arguments.contains("--ui-test-reset")
        #if DEBUG
        // UI tests must never inherit a developer credential from the simulator.
        // This is intentionally compiled only into DEBUG; production launches keep
        // their existing Keychain-backed live behavior unchanged.
        if isUITestReset { keychain.removeAPIKey() }
        // Local dev loop: seed the Keychain from the launch environment so a
        // simulator run never has to retype the key in Settings. Skipped for UI
        // test resets by the same rule above.
        if !isUITestReset, let injectedKey = DebugAPIKeyInjection.injectedKey() {
            keychain.saveAPIKey(injectedKey)
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
        self.usesLiveTutor = keychain.readAPIKey()?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        let usingDemoService = resolvedService is DemoTutorService
        self.isWorkspace = restored.plan != nil && restored.exercise != nil && (self.usesLiveTutor || usingDemoService)
        if shouldSeedE2E { persistence.save(restored) }
    }

    var hasGoal: Bool {
        session.plan != nil || session.messages.contains { $0.role == .learner && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// True only for an explicitly injected/debug demo service. A missing API key
    /// on the production router is setup-required, not an offline demo mode.
    var demoMode: Bool { tutorService is DemoTutorService }

    var requiresAPIKey: Bool { !demoMode && !usesLiveTutor }

    var needsAPIKey: Bool { requiresAPIKey }

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

    func startWorking() {
        guard !requiresAPIKey, session.plan != nil, session.exercise != nil else {
            if requiresAPIKey { errorMessage = TutorServiceError.missingAPIKey.errorDescription }
            else { errorMessage = "The tutor has not prepared a session exercise yet. Ask for a problem or a focused next step first." }
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

    func updateDrawing(_ drawing: PKDrawing) {
        session.drawingData = drawing.dataRepresentation()
        session.lastSavedAt = .now
        persist()
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
        requestTutor(signal: .evaluate, imageData: imageData, regionDescription: regionDescription) { [weak self] reply in
            self?.evaluationText = reply.text
            self?.isEvaluating = false
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
        session.drawingData = nil
        persist()
    }

    func resetSession() {
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

    @discardableResult
    func saveAPIKey(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let saved = trimmed.isEmpty ? keychain.removeAPIKey() : keychain.saveAPIKey(trimmed)
        if saved { usesLiveTutor = !trimmed.isEmpty }
        return saved
    }

    @discardableResult
    func removeAPIKey() -> Bool {
        let removed = keychain.removeAPIKey()
        if removed {
            usesLiveTutor = false
            if !demoMode { isWorkspace = false }
        }
        return removed
    }

    func retryLastRequest() {
        guard !isLoading, ensureTutorAvailable() else { return }
        requestTutor(signal: nil)
    }

    private func requestTutor(
        signal: LearningSignal?,
        imageData: Data? = nil,
        regionDescription: String? = nil,
        onReply: ((TutorReply) -> Void)? = nil
    ) {
        guard ensureTutorAvailable() else {
            isLoading = false
            isEvaluating = false
            return
        }
        isLoading = true
        errorMessage = nil
        let request = TutorRequest(
            messages: session.messages,
            goal: session.messages.first(where: { $0.role == .learner })?.text,
            exercise: session.exercise,
            plan: session.plan,
            imageData: imageData,
            imageRegionDescription: regionDescription,
            signal: signal,
            model: session.selectedModel,
            reasoningEffort: session.reasoningEffort
        )
        let service = tutorService
        Task { [weak self] in
            do {
                let reply = try await service.respond(to: request)
                guard let self else { return }
                self.apply(reply: reply, signal: signal, onReply: onReply)
            } catch {
                guard let self else { return }
                self.isLoading = false
                self.isEvaluating = false
                self.errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                self.logger.error("Tutor request failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func apply(reply: TutorReply, signal: LearningSignal?, onReply: ((TutorReply) -> Void)?) {
        isLoading = false
        let pair = TutorReply.coherentPair(reply.plan, reply.exercise)
        if let plan = pair.plan, let exercise = pair.exercise {
            session.plan = plan
            session.exercise = exercise
        }
        let tutorMessage = TutorMessage(role: .tutor, text: reply.text)
        session.messages.append(tutorMessage)
        if signal == .evaluate { evaluationMessageID = tutorMessage.id }
        session.lastSavedAt = .now
        persist()
        onReply?(reply)
    }

    private func persist() {
        persistence.save(session)
    }

    @discardableResult
    private func ensureTutorAvailable() -> Bool {
        guard canRequestTutor else {
            errorMessage = TutorServiceError.missingAPIKey.errorDescription
            return false
        }
        return true
    }
}
