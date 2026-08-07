import Foundation

/// The migration to a streaming backend is incremental: `stream(_:)` is the
/// target API, but `respond(to:)` stays on the protocol so every existing
/// conformer and caller keeps compiling. The default `stream(_:)` below
/// bridges old conformers onto the new API for free; a conformer overrides
/// it once it can genuinely stream (see `DemoTutorService`). A later task
/// switches `TutorStore` onto `stream` and removes `respond(to:)` for good.
protocol TutorService: Sendable {
    func respond(to request: TutorRequest) async throws -> TutorReply
    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error>
}

extension TutorService {
    /// Adapts a single `respond(to:)` reply into the streaming vocabulary:
    /// an initial "thinking" status, the reply text as one `.textDelta`,
    /// a `.workspace` event when the reply carries a coherent plan/exercise
    /// pair, then `.done`. Any error from `respond(to:)` finishes the stream
    /// with that error rather than yielding a `.failure` event, since the
    /// caller already handles thrown `TutorServiceError`s from the old path.
    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    continuation.yield(.status(.thinking, detail: nil))
                    let reply = try await respond(to: request)
                    continuation.yield(.textDelta(reply.text))
                    let pair = TutorReply.coherentPair(reply.plan, reply.exercise)
                    if let plan = pair.plan, let exercise = pair.exercise {
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
}

struct TutorServiceRouter: TutorService, Sendable {
    let keychain: KeychainStore
    private let apiKeyReader: @Sendable () -> String?
    private let configurationReader: @Sendable () -> BackendConfiguration?

    init(
        keychain: KeychainStore = KeychainStore(),
        apiKeyReader: (@Sendable () -> String?)? = nil,
        configurationReader: (@Sendable () -> BackendConfiguration?)? = nil
    ) {
        self.keychain = keychain
        self.apiKeyReader = apiKeyReader ?? { keychain.readAPIKey() }
        self.configurationReader = configurationReader ?? { BackendConfiguration.load(keychain: keychain) }
    }

    /// Unchanged for now: still the direct-OpenAI path, kept alive only so
    /// every existing `respond(to:)` caller keeps compiling during the
    /// migration. A later task (client-migration Task 6) deletes this
    /// alongside `OpenAITutorService` once every caller is on `stream(_:)`.
    func respond(to request: TutorRequest) async throws -> TutorReply {
        guard let key = apiKeyReader(), !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw TutorServiceError.missingAPIKey
        }
        return try await OpenAITutorService(apiKey: key).respond(to: request)
    }

    /// The real streaming path: a `BackendConfiguration` that is half set
    /// (a base URL with no token, or vice versa) is treated exactly like no
    /// configuration at all, so the app never thinks it can reach a live
    /// tutor when a request would actually 401 or have nowhere to go.
    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        guard let configuration = configurationReader() else {
            return AsyncThrowingStream { continuation in
                continuation.finish(throwing: TutorServiceError.missingAPIKey)
            }
        }
        return BackendTutorService(configuration: configuration).stream(request)
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

    /// Genuinely streams rather than falling back to the protocol's bridge:
    /// the reply text arrives as several `.textDelta`s so the demo path
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
