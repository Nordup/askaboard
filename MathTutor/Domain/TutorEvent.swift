import CoreGraphics
import Foundation

/// Mirrors the server's `StatusEvent.phase` literal in
/// `server/app/tutor/events.py`.
enum TutorPhase: String, Sendable {
    case thinking
    case looking
    case searching
    case writing
    /// The tutor is writing a diagram, not prose — an `update_board` call whose
    /// arguments are still streaming. The longest phase of a drawing turn by
    /// far, and until it existed it was indistinguishable from `thinking`.
    case drawing
    /// A machine somewhere else is running a script the tutor wrote — the
    /// hosted code interpreter. The same argument `drawing` makes: it is one of
    /// the longest stretches of a turn, and without a name of its own it looks
    /// exactly like `thinking`, which is to say like nothing happening at all.
    ///
    /// A phase this build did not know is dropped by `TutorPhase(rawValue:)`
    /// below and the device keeps its previous phase, so the server adding one
    /// is additive on the wire — which is why this case can arrive late.
    case computing
}

/// The client's streaming vocabulary for a tutor turn. This is a direct
/// mirror of the server's `ClientEvent` union in `server/app/tutor/events.py`
/// — see that file for the wire contract this decodes.
enum TutorEvent: Sendable, Equatable {
    case status(TutorPhase, detail: String?)
    case reasoningDelta(String)
    case textDelta(String)
    case workspace(SessionPlan, Exercise)
    /// A validated batch of tutor-authored scene changes from `update_board`.
    case boardUpdate(BoardSceneUpdate)
    /// The tutor asking this device to render a region of its own board.
    ///
    /// The one event that expects an answer. `BackendTutorService` renders the
    /// region and POSTs it back; the turn on the server is parked waiting for
    /// exactly that. Nothing above the service layer has to know — the store
    /// sees `.boardViewed` once the picture exists.
    case boardRequest(callID: String, region: CGRect, detail: String)
    /// One row of the activity trail — a tool call, named.
    ///
    /// Arrives twice per call under the same `id`, which is the server's
    /// `call_id`: once when the call starts, once when its arguments are
    /// complete and a specific label exists. The store replaces the row rather
    /// than appending, so `id` is the whole contract — see
    /// `StepEvent` in `server/app/tutor/events.py` for why it is not the
    /// provider's output index.
    case step(id: String, tool: String, label: String)
    /// A region this device rendered for the tutor, on its way into the thread.
    ///
    /// Produced locally rather than received: the device drew it, so it already
    /// holds the bytes and they never make a second round trip. This is what
    /// lets the thread show the learner what the tutor actually looked at.
    ///
    /// `callID` is the `board_request` this answers, and it is the same id the
    /// matching `step` carries. Without it the store would have to file the
    /// crop on "the most recent `view_board` step with no image", which is the
    /// wrong step as soon as one turn asks for two regions and the second
    /// render returns first.
    case boardViewed(callID: String, imageData: Data, detail: String)
    case done
    case failure(message: String, retryable: Bool)

    /// Parses one SSE `data: {...}` line into a `TutorEvent`.
    ///
    /// Returns `nil` for blank lines, `:`-prefixed comments/keep-alives, and
    /// event types this client does not recognise. The server may ship new
    /// event types before the app knows about them; a forward-compatible
    /// client ignores what it does not understand rather than failing the
    /// whole turn over one unrecognised event.
    static func decode(from line: String) -> TutorEvent? {
        guard let payload = payload(from: line), !payload.isEmpty else { return nil }
        guard let data = payload.data(using: .utf8) else { return nil }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return nil }

        switch envelope.type {
        case "status":
            guard let phase = envelope.phase.flatMap(TutorPhase.init(rawValue:)) else { return nil }
            return .status(phase, detail: envelope.detail)
        case "reasoning_delta":
            guard let text = envelope.text else { return nil }
            return .reasoningDelta(text)
        case "text_delta":
            guard let text = envelope.text else { return nil }
            return .textDelta(text)
        case "workspace":
            guard let plan = envelope.plan, let exercise = envelope.exercise else { return nil }
            return .workspace(plan, exercise)
        case "board_update":
            guard let payload = envelope.payload else { return nil }
            return .boardUpdate(payload)
        case "board_request":
            guard let callID = envelope.call_id,
                  let x = envelope.x, let y = envelope.y,
                  let width = envelope.width, let height = envelope.height
            else { return nil }
            return .boardRequest(
                callID: callID,
                region: CGRect(x: x, y: y, width: width, height: height),
                detail: envelope.detail ?? ""
            )
        case "step":
            guard let id = envelope.id, let tool = envelope.tool,
                  let label = envelope.label
            else { return nil }
            return .step(id: id, tool: tool, label: label)
        case "done":
            return .done
        case "error":
            guard let message = envelope.message, let retryable = envelope.retryable else { return nil }
            return .failure(message: message, retryable: retryable)
        default:
            // Unrecognised event type: ignore rather than fail the turn.
            return nil
        }
    }

    /// Strips the SSE `data: ` prefix, treats `:`-prefixed lines as comments
    /// (SSE keep-alives), and treats blank lines as empty.
    private static func payload(from line: String) -> String? {
        if line.isEmpty { return nil }
        if line.hasPrefix(":") { return nil }
        guard line.hasPrefix("data:") else { return nil }
        let rest = line.dropFirst("data:".count)
        return rest.trimmingCharacters(in: .whitespaces)
    }

    /// A permissive envelope covering the union of every event's fields.
    /// Field names are snake_case on the wire; `plan`/`exercise` keep their
    /// Swift field names (including `currentStep` in camelCase) because the
    /// server encodes those two nested objects with `SessionPlan`/`Exercise`'s
    /// own field names, not a wire-cased alias.
    private struct Envelope: Decodable {
        let type: String
        let phase: String?
        let detail: String?
        let text: String?
        let plan: SessionPlan?
        let exercise: Exercise?
        let payload: BoardSceneUpdate?
        let message: String?
        let retryable: Bool?
        // `board_request`. Snake_case on the wire, and named to match rather
        // than aliased, because this envelope decodes the union directly.
        let call_id: String?
        let x: CGFloat?
        let y: CGFloat?
        let width: CGFloat?
        let height: CGFloat?
        // `step`.
        let id: String?
        let tool: String?
        let label: String?
    }
}
