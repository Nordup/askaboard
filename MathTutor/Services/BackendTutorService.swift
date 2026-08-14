import Foundation

/// Talks to the migration's backend service (`server/`) instead of OpenAI
/// directly. The wire contract below mirrors that service exactly — see
/// `server/app/api/turn.py` (`TurnRequest`, field names and optionality),
/// `server/app/tutor/events.py` (the event vocabulary `TutorEvent.decode`
/// parses) and `server/app/sse.py` (`data: {...}\n\n` framing,
/// `X-Accel-Buffering: no`) for the source of truth. Do not change field
/// names here without re-reading those files first.
struct BackendTutorService: TutorService, Sendable {
    /// How long a turn may go without a single byte arriving before URLSession
    /// gives up on it.
    ///
    /// `URLSession.shared` carries `URLSessionConfiguration.default`'s 60
    /// seconds, and that is an *inactivity* timeout, not a duration cap — the
    /// wrong default for a connection that is deliberately long-lived. It cost
    /// real turns: while the tutor streamed one `update_board` call's
    /// arguments the service had nothing to translate and put nothing on the
    /// wire, so a diagram that took longer than a minute to write timed the
    /// request out with the model's work already generated and already billed.
    ///
    /// The server heartbeating every `HEARTBEAT_SECONDS`
    /// (`server/app/tutor/events.py`) is the actual fix. This is the second
    /// line of defence, and it is deliberately still finite: a connection that
    /// has been silent for two minutes despite a five-second heartbeat is dead,
    /// and failing then beats hanging forever.
    static let streamTimeout: TimeInterval = 120

    /// The session every live turn streams on.
    ///
    /// Not `.shared`, because its timeout cannot be changed without changing it
    /// for every other request this process makes, and this is the only one
    /// that wants a different answer.
    ///
    /// `timeoutIntervalForResource` is deliberately left alone: it caps the
    /// whole task rather than the gaps in it, and a legitimate turn can run for
    /// several minutes across `MAX_TOOL_ROUNDS` rounds of drawing. Silence is
    /// the thing worth bounding here, not length.
    static let streamingSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = BackendTutorService.streamTimeout
        return URLSession(configuration: configuration)
    }()

    let configuration: BackendConfiguration
    let session: URLSession

    init(
        configuration: BackendConfiguration,
        session: URLSession = BackendTutorService.streamingSession
    ) {
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

                    // Each `.boardRequest` is answered by a child task added to
                    // this group, rather than awaited inline — awaiting it here
                    // would stop reading the very stream the rest of the turn
                    // arrives on, exactly as the loop below still does not.
                    //
                    // It is a *group* child rather than a bare, unstructured
                    // `Task { }` for one reason: `continuation.yield(_:)` after
                    // `continuation.finish()` is documented to have no effect —
                    // the value is silently dropped, not buffered. A render has
                    // two suspension points ahead of it (the `MainActor` hop to
                    // draw, then the upload) while the loop below usually only
                    // has to read one more already-buffered line before it falls
                    // off the end and this function calls `finish()`. Left as a
                    // bare `Task { }`, a render still in flight at that moment
                    // would lose its `.boardViewed` for good — invisibly, since
                    // nothing throws and nothing logs. Grouping fixes both
                    // halves of that at once: falling off the end of
                    // `withThrowingTaskGroup`'s closure implicitly awaits every
                    // outstanding child before this scope continues, so
                    // `continuation.finish()` below is unconditionally the last
                    // thing said on this stream — and a child task is a
                    // structured child of `task`, so `continuation.onTermination`
                    // cancelling `task` below cancels every render still running
                    // rather than leaving it to outlive the stream it was
                    // answering.
                    try await withThrowingTaskGroup(of: Void.self) { group in
                        // `bytes.lines` reassembles complete lines even when the
                        // server flushes a payload across more than one TCP
                        // write — a partial JSON line is buffered internally
                        // until its terminating newline arrives, so every line
                        // handed to `TutorEvent.decode` here is always whole.
                        for try await line in bytes.lines {
                            guard let event = TutorEvent.decode(from: line) else { continue }
                            // The one event this layer answers rather than
                            // forwards. See the group's doc comment above for why
                            // this is tracked rather than fire-and-forget.
                            if case let .boardRequest(callID, region, detail) = event {
                                let configuration = configuration
                                let session = session
                                group.addTask {
                                    if let image = await Self.answerBoardRequest(
                                        callID: callID, region: region, turnID: turnID,
                                        configuration: configuration, session: session
                                    ) {
                                        continuation.yield(.boardViewed(
                                            callID: callID, imageData: image, detail: detail
                                        ))
                                    }
                                }
                                continue
                            }
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
    /// way. `BoardScreen` sets it; the render task in `stream(_:)`'s task group
    /// reads it back on the main actor before rendering.
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

    /// How long a close may take before it is abandoned to the server's sweep.
    ///
    /// Nothing waits on this call, so the only thing a long timeout buys is a
    /// request outliving the reason it was sent. Fifteen seconds is generous
    /// for a request whose whole body is a URL and whose answer is 204.
    static let closeTimeout: TimeInterval = 15

    /// `POST {baseURL}/v1/sessions/{id}/close` — the device saying the learner
    /// has left this session for good.
    ///
    /// Nothing is thrown and nothing is returned, and both are deliberate. The
    /// server answers 204 *before* it starts the work — extraction is several
    /// provider calls, minutes away — so there is no outcome here to report.
    /// And a close that never arrives is not a failure the learner can act on:
    /// `jobs.sweep_abandoned_sessions` picks up any session nobody closed on
    /// the next server start. There is deliberately no retry for the same
    /// reason — it would duplicate that sweep with weaker guarantees, from an
    /// app that is frequently about to be put down.
    ///
    /// See `server/app/api/sessions.py:close_session` for what sending this at
    /// the wrong moment costs: a close freezes the transcript into the one
    /// `Episode` the session will ever have.
    func closeSession(id: UUID) async {
        let url = configuration.baseURL
            .appendingPathComponent("v1/sessions/\(id.uuidString)/close")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = Self.closeTimeout
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: request)
    }

    /// `DELETE {baseURL}/v1/sessions/{id}` — the device saying this session
    /// should be forgotten, not remembered.
    ///
    /// Fire-and-forget for the same reasons as `closeSession(id:)`, with one
    /// asymmetry worth naming: there is no sweep behind this one. A close that
    /// never arrives is repaired by `jobs.sweep_abandoned_sessions`; a delete
    /// that never arrives simply leaves the session remembered, which is the
    /// state the learner was already in before they deleted it. A 404 is the
    /// common case for a session that never reached the backend at all, and is
    /// deliberately ignored.
    ///
    /// See `server/app/api/sessions.py:delete_session` for exactly what is
    /// removed (the episode and the session's rows) and what is kept (the
    /// learner's extracted memory).
    func deleteSession(id: UUID) async {
        let url = configuration.baseURL
            .appendingPathComponent("v1/sessions/\(id.uuidString)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.timeoutInterval = Self.closeTimeout
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        _ = try? await session.data(for: request)
    }

    /// `PUT {baseURL}/v1/sessions/{id}/transcript` — the conversation is now
    /// exactly `messages`. Sent ahead of an edit-and-resend's turn; see the
    /// protocol's own doc for why the turn is gated on the answer.
    ///
    /// **Not** fire-and-forget, unlike its two neighbours: a close or a
    /// delete that never lands degrades gracefully, but a turn sent over an
    /// unsynced transcript is answered from history the learner just cut. A
    /// 404 counts as success — the backend never saw this session, so there
    /// is nothing to cut and the turn about to go out will create it.
    func replaceTranscript(sessionID: UUID, messages: [TutorMessage]) async -> Bool {
        let url = configuration.baseURL
            .appendingPathComponent("v1/sessions/\(sessionID.uuidString)/transcript")
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.timeoutInterval = Self.closeTimeout
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let rows: [[String: Any]] = messages.map { message in
            var row: [String: Any] = ["role": message.role.rawValue, "text": message.text]
            if let signal = message.signal { row["signal"] = signal.rawValue }
            return row
        }
        guard let body = try? JSONSerialization.data(withJSONObject: ["messages": rows]) else {
            return false
        }
        request.httpBody = body
        guard let (_, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse
        else { return false }
        return (200..<300).contains(http.statusCode) || http.statusCode == 404
    }

    static func urlRequest(
        for request: TutorRequest,
        turnID: String = UUID().uuidString,
        configuration: BackendConfiguration
    ) throws -> URLRequest {
        let url = configuration.baseURL.appendingPathComponent("v1/turn")
        var urlRequest = URLRequest(url: url)
        // Set on the request as well as on `streamingSession`, because
        // `URLRequest` carries its own 60-second default and which of the two
        // wins is a detail of URLSession this code should not have to be right
        // about. Stated in both places, they agree either way.
        urlRequest.timeoutInterval = streamTimeout
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
        // Only when there are any, so every turn that carries no file is
        // byte-identical to what it was before the composer grew a `+`.
        if !request.attachmentIDs.isEmpty {
            body["attachment_ids"] = request.attachmentIDs.map(\.uuidString)
        }
        return body
    }
}
