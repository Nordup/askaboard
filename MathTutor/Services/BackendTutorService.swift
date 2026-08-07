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
    /// twice; the server 409s a duplicate. `session_id` is `request.sessionID`
    /// — the learner's `LearningSession.id` — sent as-is rather than
    /// generated here, so every turn in the same session lands against the
    /// same server-side conversation and the server's context assembly
    /// (`TurnRequest.session_id` in `server/app/api/turn.py`) actually has
    /// something to draw on. A fresh `LearningSession` (a new session or a
    /// reset) mints a fresh id, which is what keeps its turns from landing in
    /// a previous session's transcript.
    static func body(for request: TutorRequest) -> [String: Any] {
        var body: [String: Any] = [
            "turn_id": UUID().uuidString,
            "session_id": request.sessionID.uuidString,
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
