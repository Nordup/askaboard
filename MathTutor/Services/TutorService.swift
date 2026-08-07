import Foundation

/// `stream(_:)` is the one way a conformer talks to `TutorStore` now. The
/// migration's bridge — a default `stream(_:)` that adapted an old
/// `respond(to:)` conformer onto this API for free — is gone, and so is the
/// direct-OpenAI `respond(to:)` path itself (`OpenAITutorService`, deleted
/// alongside it): `TutorStore` only ever calls `stream(_:)`, so every real
/// conformer has to genuinely stream. `respond(to:)` is no longer part of
/// this contract; `DemoTutorService` below keeps a plain method of that name
/// only because its own `stream(_:)` is built on top of it, not because
/// anything outside this file calls it.
protocol TutorService: Sendable {
    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error>
}

struct TutorServiceRouter: TutorService, Sendable {
    private let configurationReader: @Sendable () -> BackendConfiguration?

    init(configurationReader: (@Sendable () -> BackendConfiguration?)? = nil) {
        self.configurationReader = configurationReader ?? { BackendConfiguration.load() }
    }

    /// The real streaming path: a build with no usable token has no
    /// `BackendConfiguration` at all, so the app never thinks it can reach a
    /// live tutor when a request would actually 401.
    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        guard let configuration = configurationReader() else {
            return AsyncThrowingStream { continuation in
                continuation.finish(throwing: TutorServiceError.notConfigured)
            }
        }
        return BackendTutorService(configuration: configuration).stream(request)
    }
}

struct DemoTutorService: TutorService, Sendable {
    func respond(to request: TutorRequest) async throws -> TutorReply {
        try await Task.sleep(for: .milliseconds(360))
        // A plan and board exercise are one workspace contract: reflecting
        // only one half back would let stale state pair with a new value, so
        // an incomplete pair collapses to nothing rather than half-updating.
        let pair: (plan: SessionPlan?, exercise: Exercise?) = if let plan = request.plan, let exercise = request.exercise {
            (plan, exercise)
        } else {
            (nil, nil)
        }

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

    /// The reply text arrives as several `.textDelta`s so the demo path
    /// exercises the same incremental rendering the live backend will, since
    /// this deterministic path is what the rest of the migration is verified
    /// against. Every branch below is the same branch `respond(to:)` takes,
    /// producing byte-for-byte the same reply text.
    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    continuation.yield(.status(.thinking, detail: nil))
                    let reply = try await respond(to: request)

                    for chunk in Self.sentenceChunks(in: reply.text) {
                        continuation.yield(.textDelta(chunk))
                        try await Task.sleep(for: .milliseconds(40))
                    }
                    if let plan = reply.plan, let exercise = reply.exercise {
                        continuation.yield(.workspace(plan, exercise))
                    }
                    continuation.yield(.done)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Splits `text` on sentence-ending punctuation (`.`, `!`, `?`) followed
    /// by whitespace, keeping that whitespace attached to the preceding
    /// chunk so concatenating every chunk reconstructs `text` exactly.
    static func sentenceChunks(in text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var chunks: [String] = []
        var start = text.startIndex
        var index = text.startIndex
        while index < text.endIndex {
            let character = text[index]
            index = text.index(after: index)
            guard character == "." || character == "!" || character == "?" else { continue }
            var end = index
            while end < text.endIndex, text[end] == " " {
                end = text.index(after: end)
            }
            chunks.append(String(text[start..<end]))
            start = end
            index = end
        }
        if start < text.endIndex {
            chunks.append(String(text[start...]))
        }
        return chunks
    }
}
