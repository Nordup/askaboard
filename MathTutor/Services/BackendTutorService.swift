import Foundation

/// Talks to the migration's backend service (`server/`) instead of OpenAI
/// directly. The wire contract below mirrors that service exactly — see
/// `server/app/api/turn.py` (`TurnRequest`, field names and optionality),
/// `server/app/tutor/events.py` (the event vocabulary `TutorEvent.decode`
/// parses) and `server/app/sse.py` (`data: {...}\n\n` framing,
/// `X-Accel-Buffering: no`) for the source of truth. Do not change field
/// names here without re-reading those files first.
struct BackendTutorService: TutorService, Sendable {
    let configuration: BackendConfiguration
    let session: URLSession

    init(configuration: BackendConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    /// Nothing calls this directly — `stream(_:)` below is a genuine
    /// streaming implementation, not the protocol-extension bridge that
    /// turns `respond(to:)` into a stream. This exists only because
    /// `respond(to:)` has no default and every conformer must supply one;
    /// it collects `stream(_:)`'s events into a single reply rather than
    /// duplicating the request-building and network logic.
    func respond(to request: TutorRequest) async throws -> TutorReply {
        var text = ""
        var plan: SessionPlan?
        var exercise: Exercise?
        for try await event in stream(request) {
            switch event {
            case .textDelta(let chunk):
                text += chunk
            case .workspace(let sessionPlan, let sessionExercise):
                plan = sessionPlan
                exercise = sessionExercise
            case .failure(let message, _):
                throw TutorServiceError.network(message)
            case .status, .reasoningDelta, .done:
                break
            }
        }
        return TutorReply(text: text, plan: plan, exercise: exercise)
    }

    /// Streams one tutor turn as `POST {baseURL}/v1/turn`.
    ///
    /// A non-2xx status throws `TutorServiceError.network` carrying the
    /// response body text — a transport-level failure, thrown rather than
    /// yielded, because no event has been produced at all yet. Once the
    /// stream is open, a `.failure` event from the server (a turn that
    /// failed after starting) is *yielded*, not thrown: the learner may
    /// already have seen partial text, and it is the UI's call how to offer
    /// a retry, not this layer's.
    func stream(_ request: TutorRequest) -> AsyncThrowingStream<TutorEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let urlRequest = try Self.urlRequest(for: request, configuration: configuration)
                    let (bytes, response) = try await session.bytes(for: urlRequest)
                    guard let http = response as? HTTPURLResponse else {
                        throw TutorServiceError.invalidResponse
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        var body = ""
                        for try await line in bytes.lines { body += line }
                        let message = body.isEmpty
                            ? "The tutor request failed (HTTP \(http.statusCode))."
                            : body
                        throw TutorServiceError.network(message)
                    }

                    // `bytes.lines` reassembles complete lines even when the
                    // server flushes a payload across more than one TCP
                    // write — a partial JSON line is buffered internally
                    // until its terminating newline arrives, so every line
                    // handed to `TutorEvent.decode` here is always whole.
                    for try await line in bytes.lines {
                        if let event = TutorEvent.decode(from: line) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func urlRequest(for request: TutorRequest, configuration: BackendConfiguration) throws -> URLRequest {
        let url = configuration.baseURL.appendingPathComponent("v1/turn")
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body(for: request))
        return urlRequest
    }

    /// Builds the exact `TurnRequest` body `server/app/api/turn.py` expects.
    /// Field names are snake_case on the wire; `model` and `signal` send the
    /// client enum's raw value, which already matches the server's
    /// `MODEL_ALLOWLIST` strings (`gpt-5.6-sol`/`terra`/`luna`).
    ///
    /// `turn_id` is generated fresh per call — it is what makes a turn
    /// idempotent, so a retry after a dropped connection is never charged
    /// twice; the server 409s a duplicate. `session_id` should identify the
    /// learner's ongoing conversation so the server can rebuild context for
    /// this turn from its own stored history (`TurnRequest.session_id` in
    /// `server/app/api/turn.py`) — but `TutorRequest`/`LearningSession`
    /// carry no session identifier today, so a fresh UUID is generated here
    /// too. That is a known gap, not a considered design: every turn looks
    /// like the start of a brand-new server-side session, so the server's
    /// own conversation-history assembly never has anything to draw on
    /// (the client already resends the full local transcript itself, so nothing
    /// is lost to the user in this pass — but the server-side context this
    /// was meant to enable does not yet work). Flagged for the client owner;
    /// resolving it needs a stable session identifier threaded from
    /// `LearningSession` through `TutorRequest` into this call.
    static func body(for request: TutorRequest) -> [String: Any] {
        var body: [String: Any] = [
            "turn_id": UUID().uuidString,
            "session_id": UUID().uuidString,
            "text": request.messages.last?.text ?? "",
            "model": request.model.rawValue,
            "reasoning_effort": request.reasoningEffort.rawValue
        ]
        if let signal = request.signal { body["signal"] = signal.rawValue }
        if let goal = request.goal { body["goal"] = goal }
        if let imageData = request.imageData { body["image_base64"] = imageData.base64EncodedString() }
        if let region = request.imageRegionDescription { body["image_region"] = region }
        return body
    }
}
