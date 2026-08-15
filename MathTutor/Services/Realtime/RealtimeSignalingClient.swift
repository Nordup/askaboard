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
/// one OpenAI key and attaches the whole session config (model, voice, VAD, tools, prompt)
/// server-side. Wire contract: `POST {baseURL}/v1/realtime/calls?session_id=…` under
/// `require_device_token`, `application/sdp` both ways — see `server/app/api/realtime.py`.
/// The device never sees a credential beyond its own bearer token.
struct RealtimeSignalingClient: Sendable {

    static let turnDetectionHeader = "X-Turn-Detection-Mode"

    let configuration: BackendConfiguration
    /// The learning session this call belongs to, so the server can associate the realtime call
    /// with the session's transcript and memory.
    let sessionID: UUID
    private let session: URLSession

    init(configuration: BackendConfiguration, sessionID: UUID) {
        self.configuration = configuration
        self.sessionID = sessionID

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
        components?.queryItems = [URLQueryItem(name: "session_id", value: sessionID.uuidString)]
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
