import Foundation

// Event names and shapes follow the OpenAI Realtime GA interface, as vendored from the sleep
// app's `Realtime/RealtimeEvents.swift` (see docs/research/voice-mode/sleep-app-voice-stack.md
// §9). GA renamed the preview `response.audio_transcript.*` family to
// `response.output_audio_transcript.*` and moved audio settings under `session.audio`.
//
// One rule governs the encoder half, and it is sleep lesson 7: **no OpenAI-bound number is ever
// re-encoded on this device.** Foundation writes a parsed `0.9` back as `0.90000000000000002`
// and the API atomically rejects the whole event. Every payload built here therefore carries
// strings and nothing else; session numbers (voice, rates, VAD) live in the server's session
// config and never transit this file.

// MARK: - Server events

struct RealtimeFunctionCall: Equatable, Sendable {
    let callId: String
    let name: String
    let argumentsJSON: String
}

struct RealtimeErrorPayload: Equatable, Sendable {
    let type: String
    let code: String?
    let message: String
    let param: String?
}

/// The token bill of one completed response, as `response.done`'s `usage` block reports it.
/// Split by modality because audio and text bill an order of magnitude apart; each cached count
/// is a subset of its input total. These numbers are what the coordinator reports to the
/// backend (`POST /v1/realtime/usage`) — the server is only the SDP proxy and never sees the
/// data channel, so a count that is not read here is a dollar the daily spend cap never sees.
struct RealtimeUsageCounts: Equatable, Sendable {
    let audioInputTokens: Int
    let cachedAudioInputTokens: Int
    let audioOutputTokens: Int
    let textInputTokens: Int
    let cachedTextInputTokens: Int
    let textOutputTokens: Int
}

/// Whether a completed transcription actually carried words, and if not, *how* it did not.
///
/// "The model listened and heard nothing" and "the transcription request came back malformed"
/// are different faults with different fixes; collapsing them into `""` is what made the sleep
/// app's empty-transcript nights undiagnosable.
enum RealtimeTranscriptPresence: Equatable, Sendable {
    /// A non-empty string. The ordinary case.
    case words
    /// The key was there and the string was empty — the transcriber ran and produced nothing.
    case emptyString
    /// The key was missing, null, or not a string — the transcriber did not answer with a transcript.
    case absent
}

enum RealtimeServerEvent: Equatable, Sendable {
    case sessionCreated(sessionId: String?, model: String?)
    case sessionUpdated
    case speechStarted
    case speechStopped
    /// `input_audio_buffer.committed` — the far end closed a turn. With semantic VAD creating
    /// responses server-side this needs no reply decision here, but it is still the repair path
    /// for a dropped `speech_stopped`: a commit proves the speech span ended.
    case bufferCommitted
    case inputTranscriptionDelta(itemId: String, delta: String)
    case inputTranscriptionCompleted(itemId: String,
                                     transcript: String,
                                     presence: RealtimeTranscriptPresence)
    case inputTranscriptionFailed(itemId: String?, message: String)
    case responseCreated(responseId: String)
    case outputTranscriptDelta(responseId: String?, itemId: String?, delta: String)
    case outputTranscriptDone(responseId: String?, itemId: String?, transcript: String)
    /// Carries the response id too, unlike the sleep original: delegation marking needs to know
    /// *which* response called `send_to_tutor`, so its spoken transcript can be dropped from the
    /// thread (the dedup rule in the voice-mode spec).
    case functionCallArgumentsDone(RealtimeFunctionCall, responseId: String?)
    /// `failure` carries `response.status_details.error` — the only account the API gives of a
    /// response that failed. `functionCalls` are the calls swept out of `response.output`,
    /// because `response.function_call_arguments.done` is not guaranteed to have arrived.
    /// `usage` is the response's token bill, nil when the event carried none.
    case responseDone(responseId: String?,
                      status: String?,
                      failure: String?,
                      functionCalls: [RealtimeFunctionCall],
                      usage: RealtimeUsageCounts?)
    /// The assistant's audio actually started leaving the loudspeaker buffer. May never arrive
    /// on this transport (sleep lesson 10) — nothing load-bearing may depend on it alone.
    case outputAudioStarted
    /// …and stopped. `cleared` is a barge-in wiping what had not played yet; `stopped` is a
    /// reply finishing.
    case outputAudioStopped(cleared: Bool)
    case error(RealtimeErrorPayload)
    case unhandled(type: String)
}

enum RealtimeEventDecoder {

    /// Decodes one data-channel message. Unknown event types decode to `.unhandled` so a log can
    /// still show them; a malformed payload returns nil.
    static func decode(_ data: Data) -> RealtimeServerEvent? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = object["type"] as? String else {
            return nil
        }

        switch type {
        case "session.created":
            let session = object["session"] as? [String: Any]
            return .sessionCreated(
                sessionId: session?["id"] as? String,
                model: session?["model"] as? String
            )

        case "session.updated":
            return .sessionUpdated

        case "input_audio_buffer.speech_started":
            return .speechStarted

        case "input_audio_buffer.speech_stopped":
            return .speechStopped

        case "input_audio_buffer.committed":
            return .bufferCommitted

        case "conversation.item.input_audio_transcription.delta":
            return .inputTranscriptionDelta(
                itemId: object["item_id"] as? String ?? "",
                delta: object["delta"] as? String ?? ""
            )

        case "conversation.item.input_audio_transcription.completed":
            let raw = object["transcript"] as? String
            let presence: RealtimeTranscriptPresence
            switch raw {
            case .some(let text) where !text.isEmpty: presence = .words
            case .some: presence = .emptyString
            case .none: presence = .absent
            }
            return .inputTranscriptionCompleted(itemId: object["item_id"] as? String ?? "",
                                                transcript: raw ?? "",
                                                presence: presence)

        case "conversation.item.input_audio_transcription.failed":
            let error = object["error"] as? [String: Any]
            return .inputTranscriptionFailed(
                itemId: object["item_id"] as? String,
                message: error?["message"] as? String ?? "transcription failed"
            )

        case "response.created":
            let response = object["response"] as? [String: Any]
            return .responseCreated(responseId: response?["id"] as? String ?? "")

        case "response.output_audio_transcript.delta":
            return .outputTranscriptDelta(
                responseId: object["response_id"] as? String,
                itemId: object["item_id"] as? String,
                delta: object["delta"] as? String ?? ""
            )

        case "response.output_audio_transcript.done":
            return .outputTranscriptDone(
                responseId: object["response_id"] as? String,
                itemId: object["item_id"] as? String,
                transcript: object["transcript"] as? String ?? ""
            )

        case "response.function_call_arguments.done":
            guard let callId = object["call_id"] as? String else {
                return .unhandled(type: type)
            }
            return .functionCallArgumentsDone(
                RealtimeFunctionCall(callId: callId,
                                     name: object["name"] as? String ?? "",
                                     argumentsJSON: object["arguments"] as? String ?? "{}"),
                responseId: object["response_id"] as? String
            )

        case "response.done":
            let response = object["response"] as? [String: Any]
            let output = response?["output"] as? [[String: Any]] ?? []
            let calls: [RealtimeFunctionCall] = output.compactMap { item in
                guard item["type"] as? String == "function_call",
                      let callId = item["call_id"] as? String else { return nil }
                return RealtimeFunctionCall(
                    callId: callId,
                    name: item["name"] as? String ?? "",
                    argumentsJSON: item["arguments"] as? String ?? "{}"
                )
            }
            // `status_details` carries the reason a response failed or was cancelled. Read as
            // loosely as everything else here: any of the three shapes the API has used.
            let details = response?["status_details"] as? [String: Any]
            let error = details?["error"] as? [String: Any]
            let failure = [
                error?["code"] as? String,
                error?["message"] as? String,
                error == nil ? details?["reason"] as? String : nil
            ]
                .compactMap { $0 }
                .joined(separator: ": ")
            return .responseDone(
                responseId: response?["id"] as? String,
                status: response?["status"] as? String,
                failure: failure.isEmpty ? nil : failure,
                functionCalls: calls,
                usage: usageCounts(from: response?["usage"] as? [String: Any])
            )

        case "output_audio_buffer.started":
            return .outputAudioStarted

        case "output_audio_buffer.stopped":
            return .outputAudioStopped(cleared: false)

        case "output_audio_buffer.cleared":
            return .outputAudioStopped(cleared: true)

        case "error":
            let error = object["error"] as? [String: Any]
            return .error(RealtimeErrorPayload(
                type: error?["type"] as? String ?? "error",
                code: error?["code"] as? String,
                message: error?["message"] as? String ?? "unknown Realtime error",
                param: error?["param"] as? String
            ))

        default:
            return .unhandled(type: type)
        }
    }

    /// Reads the usage block as loosely as everything else here: missing counts are zero, an
    /// absent block is nil. When `cached_tokens_details` is missing but a total `cached_tokens`
    /// is present, the whole cached count is attributed to *text* on purpose: both modalities
    /// share the same cached rate, so the cached side prices identically either way, and
    /// misattributing cached audio to text makes the uncached audio share — the expensive one —
    /// read high. The error lands on the side that cannot under-bill the daily cap.
    private static func usageCounts(from usage: [String: Any]?) -> RealtimeUsageCounts? {
        guard let usage else { return nil }
        let input = usage["input_token_details"] as? [String: Any] ?? [:]
        let output = usage["output_token_details"] as? [String: Any] ?? [:]
        let cachedDetails = input["cached_tokens_details"] as? [String: Any]

        let cachedAudio = cachedDetails?["audio_tokens"] as? Int ?? 0
        let cachedText: Int
        if let text = cachedDetails?["text_tokens"] as? Int {
            cachedText = text
        } else if let cached = input["cached_tokens"] as? Int {
            cachedText = max(0, cached - cachedAudio)
        } else {
            cachedText = 0
        }

        return RealtimeUsageCounts(
            audioInputTokens: input["audio_tokens"] as? Int ?? 0,
            cachedAudioInputTokens: cachedAudio,
            audioOutputTokens: output["audio_tokens"] as? Int ?? 0,
            textInputTokens: input["text_tokens"] as? Int ?? 0,
            cachedTextInputTokens: cachedText,
            textOutputTokens: output["text_tokens"] as? Int ?? 0
        )
    }
}

// MARK: - Client events

/// The complete set of events this device may put on the wire. Deliberately small: the session's
/// instructions, tools, voice and turn detection are all server-owned (they ride in the SDP
/// call's session config), so the client's `session.update` vocabulary is the keepalive and
/// nothing else.
enum RealtimeEventEncoder {

    /// `conversation.item.create` with a `function_call_output` item. `output` is serialized to
    /// a JSON string, which is what the API expects in that field.
    static func functionCallOutput(callId: String, output: [String: String]) throws -> Data {
        let outputData = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        let payload: [String: Any] = [
            "type": "conversation.item.create",
            "item": [
                "type": "function_call_output",
                "call_id": callId,
                "output": String(decoding: outputData, as: UTF8.self)
            ]
        ]
        return try JSONSerialization.data(withJSONObject: payload, options: [])
    }

    /// Typed text during a live call: a user message item the voice model treats like speech.
    /// The caller follows it with `responseCreate()`.
    static func userTextItem(text: String) throws -> Data {
        let payload: [String: Any] = [
            "type": "conversation.item.create",
            "item": [
                "type": "message",
                "role": "user",
                "content": [["type": "input_text", "text": text]]
            ]
        ]
        return try JSONSerialization.data(withJSONObject: payload, options: [])
    }

    static func responseCreate() throws -> Data {
        try JSONSerialization.data(withJSONObject: ["type": "response.create"], options: [])
    }

    /// Cuts off a reply the learner has started talking over. Sent only for a response that has
    /// already made noise — cancelling one that has not is how the sleep app once destroyed 26
    /// replies in a night before anyone heard them.
    static func responseCancel() throws -> Data {
        try JSONSerialization.data(withJSONObject: ["type": "response.cancel"], options: [])
    }

    /// A no-op `session.update` used purely as a keepalive: it merges nothing, carries no
    /// number, and still draws the `session.updated` that proves the far end is alive. A
    /// keepalive that can be rejected is a keepalive that spams the error channel, so this one
    /// changes nothing and can therefore be rejected for nothing.
    static func keepalive() throws -> Data {
        try JSONSerialization.data(
            withJSONObject: ["type": "session.update", "session": ["type": "realtime"]],
            options: []
        )
    }
}
