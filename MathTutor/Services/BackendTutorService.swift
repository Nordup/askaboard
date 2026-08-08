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
                    // Minted here rather than inside `body(for:)` because the
                    // render POST has to name the turn parked waiting for it,
                    // and that URL is built from this same id.
                    let turnID = UUID().uuidString
                    let urlRequest = try Self.urlRequest(
                        for: request, turnID: turnID, configuration: configuration
                    )
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
                        guard let event = TutorEvent.decode(from: line) else { continue }
                        // The one event this layer answers rather than forwards.
                        // The turn on the server is blocked on the render, so it
                        // is dispatched immediately and detached: awaiting it
                        // here would stop reading the very stream the rest of
                        // the turn arrives on.
                        if case let .boardRequest(callID, region, detail) = event {
                            let configuration = configuration
                            let session = session
                            Task {
                                if let image = await Self.answerBoardRequest(
                                    callID: callID, region: region, turnID: turnID,
                                    configuration: configuration, session: session
                                ) {
                                    continuation.yield(.boardViewed(imageData: image, detail: detail))
                                }
                            }
                            continue
                        }
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// How this service answers a `board_request`.
    ///
    /// Injected rather than reached for, because the board belongs to the
    /// canvas and this type is a network client. Returning `nil` means the
    /// board could not be rendered — no canvas mounted, nothing drawn — and the
    /// service answers the server with that rather than silently hanging the
    /// turn until it times out.
    ///
    /// Main-actor isolated because rendering a `PKDrawing` touches the live
    /// canvas, and because Swift 6 will not have mutable global state any other
    /// way. `BoardScreen` sets it; the detached task below reads it back on the
    /// main actor before rendering.
    @MainActor static var boardRenderer: ((CGRect) -> Data?)?

    /// Renders the region the tutor asked for and POSTs it back to the turn
    /// that is parked waiting for it.
    ///
    /// Failures are swallowed on purpose. The server already has a timeout and
    /// an answer for a device that never replies — it tells the model it could
    /// not see the board — so a render or upload that fails here degrades to
    /// exactly that, one round trip later. Throwing would abort the SSE stream
    /// and take the whole turn down with it, which is strictly worse than a
    /// tutor that says it could not look.
    private static func answerBoardRequest(
        callID: String,
        region: CGRect,
        turnID: String,
        configuration: BackendConfiguration,
        session: URLSession
    ) async -> Data? {
        // One hop, doing both: reading the renderer and running it are equally
        // main-actor work, and splitting them would leave a window where the
        // screen tore down between the two.
        guard let image = await MainActor.run(body: { boardRenderer?(region) }) else { return nil }

        let url = configuration.baseURL.appendingPathComponent("v1/turn/\(turnID)/board")
        var upload = URLRequest(url: url)
        upload.httpMethod = "POST"
        upload.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        upload.setValue("application/json", forHTTPHeaderField: "Content-Type")
        upload.httpBody = try? JSONSerialization.data(withJSONObject: [
            "call_id": callID,
            "image_base64": image.base64EncodedString(),
        ])
        _ = try? await session.data(for: upload)
        return image
    }

    static func urlRequest(
        for request: TutorRequest,
        turnID: String = UUID().uuidString,
        configuration: BackendConfiguration
    ) throws -> URLRequest {
        let url = configuration.baseURL.appendingPathComponent("v1/turn")
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body(for: request, turnID: turnID))
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
    static func body(for request: TutorRequest, turnID: String = UUID().uuidString) -> [String: Any] {
        var body: [String: Any] = [
            "turn_id": turnID,
            "session_id": request.sessionID.uuidString,
            "text": request.messages.last?.text ?? "",
            "model": request.model.rawValue,
            "reasoning_effort": request.reasoningEffort.rawValue
        ]
        if let signal = request.signal { body["signal"] = signal.rawValue }
        if let goal = request.goal { body["goal"] = goal }
        if let imageData = request.imageData { body["image_base64"] = imageData.base64EncodedString() }
        if let region = request.imageRegionDescription { body["image_region"] = region }
        // A thumbnail of the whole board, on every turn that has ink, plus the
        // device's own account of where the writing sits. Neither is meant to
        // be read: they are what the tutor *aims* with, and anything it wants
        // to read it asks for by region — see `TutorEvent.boardRequest`.
        if let overview = request.boardOverview {
            body["board_overview_base64"] = overview.base64EncodedString()
        }
        if let manifest = request.boardManifest { body["board_manifest"] = manifest }
        if let scene = request.boardScene { body["board_scene"] = scene }
        return body
    }
}
