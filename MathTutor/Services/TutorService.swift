import Foundation

protocol TutorService: Sendable {
    func respond(to request: TutorRequest) async throws -> TutorReply
}

struct TutorServiceRouter: TutorService, Sendable {
    let keychain: KeychainStore
    private let apiKeyReader: @Sendable () -> String?

    init(keychain: KeychainStore = KeychainStore(), apiKeyReader: (@Sendable () -> String?)? = nil) {
        self.keychain = keychain
        self.apiKeyReader = apiKeyReader ?? { keychain.readAPIKey() }
    }

    func respond(to request: TutorRequest) async throws -> TutorReply {
        guard let key = apiKeyReader(), !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw TutorServiceError.missingAPIKey
        }
        return try await OpenAITutorService(apiKey: key).respond(to: request)
    }
}

struct DemoTutorService: TutorService, Sendable {
    func respond(to request: TutorRequest) async throws -> TutorReply {
        try await Task.sleep(for: .milliseconds(360))
        let pair = TutorReply.coherentPair(request.plan, request.exercise)

        if request.signal == .dontKnow {
            return TutorReply(
                text: "That is a useful signal, not a dead end. Name the smallest part you do understand, or copy the exact line that feels unclear. We can take one reversible step from there.",
                plan: pair.plan,
                exercise: pair.exercise
            )
        }

        if request.imageData != nil {
            let region = request.imageRegionDescription ?? "the page"
            return TutorReply(
                text: "I’m looking at \(region). I can coach from the marks I can read, but I won’t jump to the answer. Point to the last line you completed: what changed from the line above it, and does that change preserve the original problem? If a mark is ambiguous, rewrite just that line a little larger.",
                plan: pair.plan,
                exercise: pair.exercise
            )
        }

        if request.plan == nil {
            return TutorReply(
                text: "That sounds like a good place to start. Tell me the exact problem or idea you want to work on, and I’ll help you choose one small first step. You’ll do the reasoning; I’ll keep the next question focused.",
                plan: nil,
                exercise: nil
            )
        }

        let latest = request.messages.last?.text.lowercased() ?? ""
        if latest.contains("hint") || latest.contains("stuck") {
            return TutorReply(
                text: "Small hint: write down what the next operation is supposed to preserve. Then carry out only that operation and send me the new line so we can check it together.",
                plan: pair.plan,
                exercise: pair.exercise
            )
        }

        return TutorReply(
            text: "Keep your method visible. What is the next reversible step you can make without changing the original problem’s meaning? Send me that line, and I’ll check the reasoning rather than doing it for you.",
            plan: pair.plan,
            exercise: pair.exercise
        )
    }
}
