import Foundation

/// Mirrors the server's `StatusEvent.phase` literal in
/// `server/app/tutor/events.py`.
enum TutorPhase: String, Sendable {
    case thinking
    case looking
    case searching
    case writing
}

/// The client's streaming vocabulary for a tutor turn. This is a direct
/// mirror of the server's `ClientEvent` union in `server/app/tutor/events.py`
/// — see that file for the wire contract this decodes.
enum TutorEvent: Sendable, Equatable {
    case status(TutorPhase, detail: String?)
    case reasoningDelta(String)
    case textDelta(String)
    case workspace(SessionPlan, Exercise)
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
        let message: String?
        let retryable: Bool?
    }
}
