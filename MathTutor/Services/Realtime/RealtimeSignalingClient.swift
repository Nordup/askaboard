import Foundation

enum RealtimeSignalingError: LocalizedError {
    case badResponse
    case upstream(status: Int, body: String)
    case emptyAnswer

    var errorDescription: String? {
        switch self {
        case .badResponse:
            return "The realtime call endpoint returned an unexpected response."
        case .upstream(let status, let body):
            return "Realtime call failed (\(status)): \(body.prefix(200))"
        case .emptyAnswer:
            return "The realtime call endpoint returned an empty SDP answer."
        }
    }
}

/// OpenAI's SDP answer plus the turn detection the call actually negotiated.
struct RealtimeSignalingAnswer {
    let sdp: String
    /// `semantic_vad` or `server_vad`, from the server's `X-Turn-Detection-Mode` header; `nil`
    /// when the server did not send one. The server retries a call once with the `server_vad`
    /// fallback when the model rejects semantic VAD, so this — not the app's assumption — is
    /// what the call is actually running.
    let turnDetectionMode: String?
}

/// Exchanges the local SDP offer for OpenAI's SDP answer through the backend, which holds the
/// one OpenAI key and attaches the whole session config (voice, VAD, tools, prompt)
/// server-side. Wire contract: `POST {baseURL}/v1/realtime/calls?session_id=…&model=…` under
/// `require_device_token`, `application/sdp` both ways — see `server/app/api/realtime.py`.
/// The device never sees a credential beyond its own bearer token.
///
/// The model is the one thing in that config the device names, and the server still decides
/// whether to honour it: `REALTIME_MODEL_ALLOWLIST` rejects anything else with a 422. That is
/// the same shape as `TurnRequest.model` and the same invariant — the device may pick from a
/// priced menu, and may not invent a price.
struct RealtimeSignalingClient: Sendable {

    static let turnDetectionHeader = "X-Turn-Detection-Mode"

    let configuration: BackendConfiguration
    /// The learning session this call belongs to, so the server can associate the realtime call
    /// with the session's transcript and memory.
    let sessionID: UUID
    /// The realtime model this call opens on — the learner's `Voice model` setting.
    let voiceModel: VoiceModelChoice
    private let session: URLSession

    init(configuration: BackendConfiguration, sessionID: UUID, voiceModel: VoiceModelChoice) {
        self.configuration = configuration
        self.sessionID = sessionID
        self.voiceModel = voiceModel

        // Ephemeral and non-waiting on purpose: an SDP exchange that cannot complete promptly is
        // a call that should fail promptly — the whole bring-up shares a 45 s budget and a
        // connection parked in waits-for-connectivity would spend all of it saying nothing.
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.timeoutIntervalForRequest = 30
        sessionConfiguration.waitsForConnectivity = false
        self.session = URLSession(configuration: sessionConfiguration)
    }

    func requestAnswer(offerSDP: String) async throws -> RealtimeSignalingAnswer {
        var components = URLComponents(
            url: configuration.baseURL.appendingPathComponent("v1/realtime/calls"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "session_id", value: sessionID.uuidString),
            URLQueryItem(name: "model", value: voiceModel.rawValue),
        ]
        guard let url = components?.url else { throw RealtimeSignalingError.badResponse }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.setValue("application/sdp", forHTTPHeaderField: "Accept")
        request.httpBody = Data(offerSDP.utf8)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw RealtimeSignalingError.badResponse
        }
        let body = String(decoding: data, as: UTF8.self)
        guard (200..<300).contains(http.statusCode) else {
            throw RealtimeSignalingError.upstream(status: http.statusCode, body: body)
        }
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw RealtimeSignalingError.emptyAnswer
        }
        let mode = http.value(forHTTPHeaderField: Self.turnDetectionHeader)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return RealtimeSignalingAnswer(
            sdp: body,
            turnDetectionMode: (mode?.isEmpty ?? true) ? nil : mode
        )
    }
}

/// Reports what a voice response cost, to `POST {baseURL}/v1/realtime/usage`. The server is
/// only the SDP proxy — the usage events ride the data channel it never sees — so this report
/// is the only way voice spend reaches the daily cap.
///
/// Fire-and-forget on purpose: `report(_:responseID:)` never throws and its result is ignored.
/// A lost report is a dollar the cap does not see, not a reason to disturb a live call. The
/// device-minted `report_id` makes a blind retry safe server-side.
///
/// The body carries the model, which it deliberately did not while the model was
/// server-chosen. Now that the learner picks it, the server cannot price a row from its own
/// setting without billing every Mini minute at Full rates. The device still cannot name a
/// price: `REALTIME_MODEL_ALLOWLIST` gates the field, and every model in it must carry a row
/// in `REALTIME_PRICES_PER_1M` or the server refuses to boot.
struct RealtimeUsageReporter: Sendable {

    let configuration: BackendConfiguration
    /// The learning session the call belongs to, recorded on the row for tracing a day's
    /// voice spend back to a session.
    let sessionID: UUID
    /// The model the call is running on, so the row is priced from the right sheet. Must be
    /// the same value the signaling client opened the call with.
    let voiceModel: VoiceModelChoice
    private let session: URLSession

    init(configuration: BackendConfiguration, sessionID: UUID, voiceModel: VoiceModelChoice) {
        self.configuration = configuration
        self.sessionID = sessionID
        self.voiceModel = voiceModel
        // Ephemeral and non-waiting like the signaling client: a report that cannot go now
        // should fail now — the next response's report will carry the day's tally forward.
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.timeoutIntervalForRequest = 15
        sessionConfiguration.waitsForConnectivity = false
        self.session = URLSession(configuration: sessionConfiguration)
    }

    /// The wire body, split out so a test can pin the contract without a network. Every count
    /// is an `Int` end to end — the no-re-encoded-numbers rule (sleep lesson 7) is about
    /// Foundation mangling *floats* on OpenAI-bound payloads, and this backend-bound body
    /// deliberately carries none.
    static func body(usage: RealtimeUsageCounts,
                     sessionID: UUID,
                     voiceModel: VoiceModelChoice,
                     responseID: String?,
                     reportID: UUID) -> [String: Any] {
        var body: [String: Any] = [
            "report_id": reportID.uuidString,
            "session_id": sessionID.uuidString,
            "model": voiceModel.rawValue,
            "audio_input_tokens": usage.audioInputTokens,
            "cached_audio_input_tokens": usage.cachedAudioInputTokens,
            "audio_output_tokens": usage.audioOutputTokens,
            "text_input_tokens": usage.textInputTokens,
            "cached_text_input_tokens": usage.cachedTextInputTokens,
            "text_output_tokens": usage.textOutputTokens,
        ]
        if let responseID {
            body["response_id"] = responseID
        }
        return body
    }

    func report(_ usage: RealtimeUsageCounts, responseID: String?) async {
        let url = configuration.baseURL.appendingPathComponent("v1/realtime/usage")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let data = try? JSONSerialization.data(withJSONObject: Self.body(
            usage: usage, sessionID: sessionID, voiceModel: voiceModel,
            responseID: responseID, reportID: UUID()
        )) else { return }
        request.httpBody = data
        _ = try? await session.data(for: request)
    }
}
