import Foundation
import WebRTC

enum RealtimeConnectionState: Equatable {
    case idle
    case connecting
    /// ICE is up. **Not** the same thing as usable: events travel over SCTP, and an ICE-up /
    /// SCTP-down connection would otherwise be reported live while every event sent into it is
    /// dropped. Only `.connected` (the data channel actually opening) means the session works.
    case iceConnected
    case connected
    case closed
    case failed(String)
}

/// The bring-up stages `connect()` walks through, in order. Each one is bounded; the name is
/// what the failure says when one of them runs out of time.
enum RealtimeBringUpStage: String {
    case offer = "offer"
    case localDescription = "local description"
    case iceGathering = "ice gathering"
    case signaling = "signaling"
    case remoteDescription = "remote description"
    /// ICE, DTLS and SCTP together — everything between "the answer is applied" and "the data
    /// channel is open". The stage that hangs when a network quietly blocks UDP.
    case dataChannel = "ice/dtls"
}

enum RealtimeConnectionError: LocalizedError {
    case peerConnectionUnavailable
    case dataChannelUnavailable
    case offerFailed(String)
    case localDescriptionMissing
    case remoteDescriptionFailed(String)
    case notConnected
    /// A bring-up stage that never called back. `detail` carries whatever was known at the
    /// time — the ICE candidate breakdown, which is the difference between "the network blocked
    /// UDP" and "the far end went away".
    case stageTimeout(stage: RealtimeBringUpStage, seconds: Double, detail: String?)
    /// The transport gave up while `connect()` was still waiting on it — ICE failed outright,
    /// or something closed underneath.
    case bringUpFailed(String)

    var errorDescription: String? {
        switch self {
        case .peerConnectionUnavailable: return "Could not create the WebRTC peer connection."
        case .dataChannelUnavailable: return "Could not open the oai-events data channel."
        case .offerFailed(let reason): return "Could not create an SDP offer: \(reason)"
        case .localDescriptionMissing: return "The local SDP offer was empty."
        case .remoteDescriptionFailed(let reason): return "Could not apply the SDP answer: \(reason)"
        case .notConnected: return "The Realtime data channel is not open."
        case .bringUpFailed(let reason): return reason
        case .stageTimeout(let stage, let seconds, let detail):
            let elapsed = "\(stage.rawValue) timed out after \(Int(seconds.rounded()))s"
            return detail.map { "\(elapsed) — \($0)" } ?? elapsed
        }
    }
}

/// WebRTC transport to OpenAI Realtime, ported from the sleep app's `RealtimeConnection`
/// (docs/research/voice-mode/sleep-app-voice-stack.md §1). Audio flows over the peer
/// connection; Realtime events flow over the `oai-events` data channel, which is created
/// **before** the offer so it is negotiated in the one SDP exchange this transport gets.
///
/// Callbacks are invoked on WebRTC's signaling/stats threads; callers are expected to hop to
/// the main actor themselves.
final class RealtimeConnection: NSObject, @unchecked Sendable {

    static let dataChannelLabel = "oai-events"

    var onEvent: ((RealtimeServerEvent) -> Void)?
    var onStateChange: ((RealtimeConnectionState) -> Void)?
    /// One reading of the local capture chain per uplink poll — the live call's only acoustic
    /// source, because nothing runs a second audio unit beside WebRTC (sleep lesson 3). Invoked
    /// on WebRTC's stats thread like every other callback here.
    var onCaptureReading: ((VoiceCaptureReading) -> Void)?

    private let signaling: RealtimeSignalingClient
    private let stateQueue = DispatchQueue(label: "com.nordup.mathtutor.realtime")

    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var localAudioTrack: RTCAudioTrack?
    private var remoteAudioTracks: [RTCAudioTrack] = []
    private var iceGatheringComplete = false
    private var gatheringContinuation: CheckedContinuation<Bool, Never>?
    private var isClosed = false

    /// Resumed by `dataChannelDidChangeState(.open)`. Bring-up waits on this with a deadline —
    /// without one, a connection that negotiates cleanly and then never establishes would sit
    /// in `connecting` until somebody force-quits.
    private var dataChannelWaiter: ((Result<Void, Error>) -> Void)?
    private var isBringingUp = false
    /// Escalates a `disconnected` ICE state that does not come back.
    private var iceDisconnectTimer: DispatchSourceTimer?

    /// Gain applied to the tutor's audio track, 0–10. The Realtime API has no output-volume
    /// control, so this is the only knob. Remembered rather than passed through, because remote
    /// tracks are adopted after the caller sets it.
    private var remoteGain: Double = 1

    /// What the tutor's voice drops to while the learner is speaking. A tenth is quiet enough
    /// to talk over comfortably and still audible enough that the voice reads as *lowered*
    /// rather than as cut off; zero would be a mute, and a voice that vanishes mid-word
    /// startles.
    private static let duckedGainFraction: Double = 0.1

    /// Kept apart from `remoteGain` so ducking never overwrites the configured gain —
    /// restoring has to put back the configured level, not 1.0.
    private var isDucked = false

    private let levelLock = NSLock()
    private var uplinkTimer: DispatchSourceTimer?
    private var negotiatedTurnDetectionValue: String?

    /// One second: matches the coordinator's own tick, costs one stats walk per second, and is
    /// the resolution of everything the app can say about what the microphone is hearing.
    static let uplinkPollInterval: TimeInterval = 1

    // MARK: Bring-up budget
    //
    // Every wait between "start connecting" and "the data channel is open" is bounded, and the
    // stages share one budget so a slow signaling POST cannot be followed by a full-length
    // data-channel wait. Numbers are the sleep app's, generous against a bring-up that
    // completes in about two seconds when it works.

    /// Local SDP work (offer, setLocal, setRemote). These are local computations; five seconds
    /// is already pathological.
    private static let sdpStageTimeout: TimeInterval = 5
    /// The SDP is exchanged once over HTTP, so gathering has to finish before the offer ships.
    /// Expiring here is the *normal* path on many networks; the offer ships with whatever
    /// candidates exist.
    private static let iceGatheringTimeout: TimeInterval = 4
    /// ICE + DTLS + SCTP after the answer is applied. About one second when it works.
    private static let dataChannelTimeout: TimeInterval = 15
    /// Whole-of-bring-up cap.
    private static let bringUpBudget: TimeInterval = 45
    /// How long ICE may sit in `disconnected` before the call is a technical failure. Short
    /// outages recover on their own; ten seconds of nothing is a dead pipe.
    private static let iceDisconnectedGrace: TimeInterval = 10

    private static let sslBootstrap: Void = {
        RTCInitializeSSL()
    }()

    /// One factory per process. WebRTC owns the audio device module; the app never builds a
    /// second audio graph beside it.
    nonisolated(unsafe) private static let sharedFactory: RTCPeerConnectionFactory = {
        _ = sslBootstrap
        return RTCPeerConnectionFactory()
    }()

    init(signaling: RealtimeSignalingClient) {
        self.signaling = signaling
        super.init()
    }

    // MARK: - Lifecycle

    /// Brings the transport all the way up: peer connection, microphone, data channel, SDP
    /// exchange — and the wait for the channel to actually open. Returns only when events can
    /// be sent. Every stage is bounded and every failure throws.
    func connect() async throws {
        onStateChange?(.connecting)
        stateQueue.sync { isBringingUp = true }
        let deadline = Date().addingTimeInterval(Self.bringUpBudget)

        do {
            try await bringUp(deadline: deadline)
        } catch {
            stateQueue.sync { isBringingUp = false }
            // A half-built peer connection left running would keep the microphone hot behind a
            // call the app has already given up on.
            close()
            throw error
        }
        stateQueue.sync { isBringingUp = false }
    }

    private func bringUp(deadline: Date) async throws {
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.bundlePolicy = .maxBundle
        configuration.rtcpMuxPolicy = .require
        configuration.continualGatheringPolicy = .gatherOnce
        configuration.iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = Self.sharedFactory.peerConnection(
            with: configuration,
            constraints: constraints,
            delegate: self
        ) else {
            throw RealtimeConnectionError.peerConnectionUnavailable
        }
        peerConnection = peer

        attachMicrophone(to: peer)

        // Created before the offer, so `oai-events` is negotiated inside it — there is no
        // renegotiation on this transport.
        let channelConfig = RTCDataChannelConfiguration()
        channelConfig.isOrdered = true
        guard let channel = peer.dataChannel(forLabel: Self.dataChannelLabel, configuration: channelConfig) else {
            peer.close()
            peerConnection = nil
            throw RealtimeConnectionError.dataChannelUnavailable
        }
        channel.delegate = self
        dataChannel = channel

        let offerSDP = try await makeOffer(on: peer,
                                           constraints: constraints,
                                           timeout: try budget(Self.sdpStageTimeout, for: .offer, deadline: deadline))
        // Rebuilt from the SDP string rather than handing the callback's object across the
        // continuation: the string is `Sendable`, the object is not, and WebRTC parses the
        // description again either way.
        try await setLocalDescription(RTCSessionDescription(type: .offer, sdp: offerSDP),
                                      on: peer,
                                      timeout: try budget(Self.sdpStageTimeout, for: .localDescription, deadline: deadline))

        // The SDP is exchanged once over HTTP, so candidates must be in the offer already:
        // there is no trickle ICE to add one later.
        _ = await waitForIceGathering(
            timeout: try budget(Self.iceGatheringTimeout, for: .iceGathering, deadline: deadline)
        )

        guard let localSDP = peer.localDescription?.sdp, !localSDP.isEmpty else {
            throw RealtimeConnectionError.localDescriptionMissing
        }

        // "Timed out with 4 host and 0 srflx" says the network blocked STUN; "complete with
        // srflx" says it did not. The one line worth having when a connect fails.
        let summary = Self.candidateSummary(sdp: localSDP)

        let signalingAnswer = try await signaling.requestAnswer(offerSDP: localSDP)
        setNegotiatedTurnDetectionMode(signalingAnswer.turnDetectionMode)

        let answer = RTCSessionDescription(type: .answer, sdp: signalingAnswer.sdp)
        try await setRemoteDescription(answer,
                                       on: peer,
                                       timeout: try budget(Self.sdpStageTimeout, for: .remoteDescription, deadline: deadline))

        // Everything above only proves the *offer* was accepted; nothing before this waited for
        // a byte to survive the round trip. Only the channel opening means the session works.
        try await waitForDataChannelOpen(
            timeout: try budget(Self.dataChannelTimeout, for: .dataChannel, deadline: deadline),
            detail: summary
        )
    }

    /// How long a stage may take: its own cap, or whatever is left of the whole bring-up
    /// budget. Throws rather than returning zero, so an exhausted budget names the stage it
    /// died on.
    private func budget(_ cap: TimeInterval,
                        for stage: RealtimeBringUpStage,
                        deadline: Date) throws -> TimeInterval {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else {
            throw RealtimeConnectionError.stageTimeout(stage: stage,
                                                       seconds: Self.bringUpBudget,
                                                       detail: "overall connect budget exhausted")
        }
        return min(cap, remaining)
    }

    /// Counts `a=candidate:` lines in the local offer by type. Zero `srflx` on a Wi-Fi network
    /// is the signature of blocked UDP or an unreachable STUN server — the leading explanation
    /// for a connection that negotiates cleanly and then never establishes.
    static func candidateSummary(sdp: String) -> String {
        var byType: [String: Int] = [:]
        var total = 0
        for rawLine in sdp.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("a=candidate:") else { continue }
            total += 1
            let fields = line.split(separator: " ")
            if let index = fields.firstIndex(of: "typ"), index + 1 < fields.count {
                byType[String(fields[index + 1]), default: 0] += 1
            }
        }
        guard total > 0 else { return "0 candidates" }
        let breakdown = byType.keys.sorted().map { "\($0) \(byType[$0] ?? 0)" }.joined(separator: ", ")
        return breakdown.isEmpty ? "\(total) candidates" : "\(total) candidates (\(breakdown))"
    }

    /// Closes the transport. Idempotent: a close during bring-up resolves the pending
    /// data-channel waiter so `connect()` is never left awaiting a channel that will not open,
    /// and a second close is a no-op.
    func close() {
        var alreadyClosed = false
        stateQueue.sync {
            alreadyClosed = isClosed
            guard !isClosed else { return }
            isClosed = true
            isBringingUp = false
            iceDisconnectTimer?.cancel()
            iceDisconnectTimer = nil
        }
        guard !alreadyClosed else { return }

        resolveDataChannelWaiter(.failure(RealtimeConnectionError.notConnected))
        stopUplinkPolling()

        localAudioTrack?.isEnabled = false
        for track in remoteAudioTracks {
            track.isEnabled = false
        }
        remoteAudioTracks.removeAll()

        dataChannel?.delegate = nil
        dataChannel?.close()
        dataChannel = nil

        peerConnection?.delegate = nil
        peerConnection?.close()
        peerConnection = nil
        localAudioTrack = nil

        resumeGatheringWaiter()
        onStateChange?(.closed)
    }

    var isDataChannelOpen: Bool {
        dataChannel?.readyState == .open
    }

    /// The turn detection this call actually negotiated (`semantic_vad` or `server_vad`), as
    /// the server reported it with the SDP answer. `nil` until `connect()` has the answer.
    var negotiatedTurnDetectionMode: String? {
        levelLock.lock()
        defer { levelLock.unlock() }
        return negotiatedTurnDetectionValue
    }

    /// A synchronous shim: `NSLock` may not be taken from an async context, and `bringUp` is
    /// one.
    private func setNegotiatedTurnDetectionMode(_ mode: String?) {
        levelLock.lock()
        negotiatedTurnDetectionValue = mode
        levelLock.unlock()
    }

    /// Mutes the microphone track without tearing the connection down.
    ///
    /// A disabled `RTCAudioTrack` **transmits silence** — the connection stays perfectly
    /// healthy and the far end simply hears an empty room. Every caller of this owes the call
    /// an owner that will turn it back on (`MicMuteGuard`).
    func setMicrophoneEnabled(_ enabled: Bool) {
        localAudioTrack?.isEnabled = enabled
    }

    /// Whether the microphone track is currently transmitting. `false` means silence is going
    /// up the wire no matter what the room sounds like.
    var isMicrophoneEnabled: Bool {
        localAudioTrack?.isEnabled ?? false
    }

    /// Sets the playback gain of the tutor's voice (0–10, 1 = unchanged).
    func setRemoteAudioGain(_ gain: Double) {
        let clamped = min(max(gain, 0), 10)
        remoteGain = clamped
        applyRemoteGain()
    }

    /// Drops the tutor's voice to a tenth of its configured gain while the learner is talking,
    /// and restores it when they stop. **Not `response.cancel` and not a substitute for it —
    /// the half that always works.** Cancelling stops the model *generating*; it does nothing
    /// about audio already on the wire, and nothing at all once the response is done. The
    /// voice arrives on a WebRTC track this object holds, and its volume is ours — no event,
    /// no permission, no knowledge of where playback has got to.
    func setRemoteAudioDucked(_ ducked: Bool) {
        guard isDucked != ducked else { return }
        isDucked = ducked
        applyRemoteGain()
    }

    private func applyRemoteGain() {
        let level = isDucked ? remoteGain * Self.duckedGainFraction : remoteGain
        for track in remoteAudioTracks {
            track.source.volume = level
        }
    }

    func setUplinkPollingEnabled(_ enabled: Bool) {
        if enabled {
            startUplinkPolling()
        } else {
            stopUplinkPolling()
        }
    }

    // MARK: - Sending

    @discardableResult
    func send(_ payload: Data) throws -> Bool {
        guard let channel = dataChannel, channel.readyState == .open else {
            throw RealtimeConnectionError.notConnected
        }
        return channel.sendData(RTCDataBuffer(data: payload, isBinary: false))
    }

    // MARK: - Private

    private func attachMicrophone(to peer: RTCPeerConnection) {
        // Empty constraints on purpose: echo cancellation, noise suppression and AGC come from
        // the voice-processing I/O unit the audio session mode selects, not from WebRTC
        // constraints.
        let audioConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let source = Self.sharedFactory.audioSource(with: audioConstraints)
        let track = Self.sharedFactory.audioTrack(with: source, trackId: "math-tutor-mic")
        peer.add(track, streamIds: ["math-tutor"])
        localAudioTrack = track
    }

    /// Bridges one callback-style bring-up stage with a hard deadline. A stage that never calls
    /// back becomes a `stageTimeout` naming itself, instead of an await that outlives the call.
    private func awaitStage<T: Sendable>(_ stage: RealtimeBringUpStage,
                                         timeout: TimeInterval,
                                         detail: @escaping @Sendable () -> String? = { nil },
                                         _ body: (@escaping @Sendable (Result<T, Error>) -> Void) -> Void) async throws -> T {
        try await CallbackDeadline.run(
            label: stage.rawValue,
            seconds: timeout,
            queue: stateQueue,
            timeoutError: { _, seconds in
                RealtimeConnectionError.stageTimeout(stage: stage, seconds: seconds, detail: detail())
            },
            body: body
        )
    }

    private func makeOffer(on peer: RTCPeerConnection,
                           constraints: RTCMediaConstraints,
                           timeout: TimeInterval) async throws -> String {
        try await awaitStage(.offer, timeout: timeout) { done in
            peer.offer(for: constraints) { description, error in
                if let error {
                    done(.failure(RealtimeConnectionError.offerFailed(error.localizedDescription)))
                } else if let description {
                    done(.success(description.sdp))
                } else {
                    done(.failure(RealtimeConnectionError.offerFailed("no description")))
                }
            }
        }
    }

    private func setLocalDescription(_ description: RTCSessionDescription,
                                     on peer: RTCPeerConnection,
                                     timeout: TimeInterval) async throws {
        try await awaitStage(.localDescription, timeout: timeout) { (done: @escaping @Sendable (Result<Void, Error>) -> Void) in
            peer.setLocalDescription(description) { error in
                if let error {
                    done(.failure(RealtimeConnectionError.offerFailed(error.localizedDescription)))
                } else {
                    done(.success(()))
                }
            }
        }
    }

    private func setRemoteDescription(_ description: RTCSessionDescription,
                                      on peer: RTCPeerConnection,
                                      timeout: TimeInterval) async throws {
        try await awaitStage(.remoteDescription, timeout: timeout) { (done: @escaping @Sendable (Result<Void, Error>) -> Void) in
            peer.setRemoteDescription(description) { error in
                if let error {
                    done(.failure(RealtimeConnectionError.remoteDescriptionFailed(error.localizedDescription)))
                } else {
                    done(.success(()))
                }
            }
        }
    }

    /// Between the SDP answer and the first usable byte sit ICE, DTLS and SCTP, none of which
    /// report through the signaling state — so an answer applied cleanly proves nothing.
    /// Resolves when the `oai-events` channel opens, fails when it does not.
    private func waitForDataChannelOpen(timeout: TimeInterval, detail: String?) async throws {
        try await awaitStage(.dataChannel,
                             timeout: timeout,
                             detail: { detail }) { (done: @escaping @Sendable (Result<Void, Error>) -> Void) in
            stateQueue.async {
                if self.dataChannel?.readyState == .open {
                    done(.success(()))
                } else if self.isClosed {
                    done(.failure(RealtimeConnectionError.notConnected))
                } else {
                    self.dataChannelWaiter = done
                }
            }
        }
    }

    /// Resumes whoever is waiting for the channel. Safe to call more than once: the deadline
    /// gate ignores everything after the first resume.
    private func resolveDataChannelWaiter(_ result: Result<Void, Error>) {
        stateQueue.async {
            guard let waiter = self.dataChannelWaiter else { return }
            self.dataChannelWaiter = nil
            waiter(result)
        }
    }

    /// - Returns: `true` when gathering completed, `false` when the deadline expired first.
    ///   The caller ships whatever candidates exist either way.
    private func waitForIceGathering(timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            stateQueue.async {
                if self.iceGatheringComplete || self.isClosed {
                    continuation.resume(returning: self.iceGatheringComplete)
                    return
                }
                self.gatheringContinuation = continuation
            }
            stateQueue.asyncAfter(deadline: .now() + timeout) {
                guard let pending = self.gatheringContinuation else { return }
                self.gatheringContinuation = nil
                pending.resume(returning: false)
            }
        }
    }

    private func resumeGatheringWaiter() {
        stateQueue.async {
            guard let pending = self.gatheringContinuation else { return }
            self.gatheringContinuation = nil
            pending.resume(returning: false)
        }
    }

    // MARK: - Uplink statistics

    /// Walks `RTCPeerConnection.statistics` once per second for the outbound audio path: the
    /// capture level and the two monotonic accumulators the level reducer turns into an
    /// interval RMS. This is the microphone level the mascot breathes with — there is no other
    /// instrument, deliberately (sleep lesson 3: a second audio unit fights WebRTC for the
    /// microphone and loses the uplink).
    private func startUplinkPolling() {
        stateQueue.async {
            guard self.uplinkTimer == nil, !self.isClosed else { return }
            let timer = DispatchSource.makeTimerSource(queue: self.stateQueue)
            timer.schedule(deadline: .now() + Self.uplinkPollInterval, repeating: Self.uplinkPollInterval)
            timer.setEventHandler { [weak self] in self?.sampleUplink() }
            self.uplinkTimer = timer
            timer.resume()
        }
    }

    private func stopUplinkPolling() {
        stateQueue.sync {
            uplinkTimer?.cancel()
            uplinkTimer = nil
        }
    }

    private func sampleUplink() {
        guard let peer = peerConnection, !isClosed else { return }
        let capturedAt = VoiceClock.now
        peer.statistics { [weak self] report in
            guard let self else { return }
            var captureLevel: Double?
            var captureEnergy: Double?
            var captureSamplesDuration: Double?

            for statistics in report.statistics.values {
                let values = statistics.values
                let isAudio = values["kind"] as? String == "audio"
                    || values["mediaType"] as? String == "audio"
                guard isAudio else { continue }

                switch statistics.type {
                case "media-source":
                    if let value = values["audioLevel"] as? NSNumber {
                        captureLevel = max(captureLevel ?? 0, value.doubleValue)
                    }
                    if let value = values["totalAudioEnergy"] as? NSNumber {
                        captureEnergy = (captureEnergy ?? 0) + value.doubleValue
                    }
                    if let value = values["totalSamplesDuration"] as? NSNumber {
                        captureSamplesDuration = max(captureSamplesDuration ?? 0, value.doubleValue)
                    }
                case "outbound-rtp":
                    // Some builds publish the level on the sender rather than on the source.
                    // Either one answers the question; neither being present is `nil`, never 0.
                    if let value = values["audioLevel"] as? NSNumber {
                        captureLevel = max(captureLevel ?? 0, value.doubleValue)
                    }
                    if let value = values["totalAudioEnergy"] as? NSNumber, captureEnergy == nil {
                        captureEnergy = value.doubleValue
                    }
                default:
                    continue
                }
            }

            self.onCaptureReading?(VoiceCaptureReading(
                at: capturedAt,
                audioLevel: captureLevel,
                totalAudioEnergy: captureEnergy,
                totalSamplesDuration: captureSamplesDuration
            ))
        }
    }
}

// MARK: - RTCPeerConnectionDelegate

extension RealtimeConnection: RTCPeerConnectionDelegate {

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        for track in stream.audioTracks {
            adopt(remote: track)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        let removed = Set(stream.audioTracks.map { $0.trackId })
        remoteAudioTracks.removeAll { removed.contains($0.trackId) }
    }

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        switch newState {
        case .connected, .completed:
            cancelIceDisconnectEscalation()
            // ICE up is *not* the session being live: events travel over the data channel, and
            // only its `.open` may say so.
            onStateChange?(.iceConnected)
        case .failed:
            cancelIceDisconnectEscalation()
            resolveDataChannelWaiter(.failure(RealtimeConnectionError.bringUpFailed("ICE connection failed")))
            onStateChange?(.failed("ICE connection failed"))
        case .closed:
            cancelIceDisconnectEscalation()
            resolveDataChannelWaiter(.failure(RealtimeConnectionError.bringUpFailed("the transport closed while connecting")))
            onStateChange?(.closed)
        case .disconnected:
            // A pipe that never comes back must not be read as the learner going quiet: give it
            // a grace period, then call it what it is.
            armIceDisconnectEscalation()
        default:
            break
        }
    }

    private func armIceDisconnectEscalation() {
        stateQueue.async {
            guard !self.isClosed, self.iceDisconnectTimer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: self.stateQueue)
            timer.schedule(deadline: .now() + Self.iceDisconnectedGrace)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                self.iceDisconnectTimer?.cancel()
                self.iceDisconnectTimer = nil
                guard !self.isClosed else { return }
                let reason = "ICE stayed disconnected for \(Int(Self.iceDisconnectedGrace))s"
                self.resolveDataChannelWaiter(.failure(RealtimeConnectionError.bringUpFailed(reason)))
                self.onStateChange?(.failed(reason))
            }
            self.iceDisconnectTimer = timer
            timer.resume()
        }
    }

    private func cancelIceDisconnectEscalation() {
        stateQueue.async {
            self.iceDisconnectTimer?.cancel()
            self.iceDisconnectTimer = nil
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        guard newState == .complete else { return }
        stateQueue.async {
            self.iceGatheringComplete = true
            guard let pending = self.gatheringContinuation else { return }
            self.gatheringContinuation = nil
            pending.resume(returning: true)
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        guard dataChannel.label == Self.dataChannelLabel else { return }
        dataChannel.delegate = self
        self.dataChannel = dataChannel
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams: [RTCMediaStream]) {
        guard let track = rtpReceiver.track as? RTCAudioTrack else { return }
        adopt(remote: track)
    }

    /// The tutor's voice arrives at the app's chosen gain, not at whatever the previous track
    /// left behind — and adopts the duck too: a track that arrives mid-barge-in must not come
    /// in at full volume.
    private func adopt(remote track: RTCAudioTrack) {
        track.isEnabled = true
        track.source.volume = isDucked ? remoteGain * Self.duckedGainFraction : remoteGain
        remoteAudioTracks.append(track)
    }
}

// MARK: - RTCDataChannelDelegate

extension RealtimeConnection: RTCDataChannelDelegate {

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        switch dataChannel.readyState {
        case .open:
            // The only event allowed to mean "the session works". Bring-up ends here.
            stateQueue.sync { isBringingUp = false }
            resolveDataChannelWaiter(.success(()))
            onStateChange?(.connected)
        case .closed:
            resolveDataChannelWaiter(.failure(RealtimeConnectionError.bringUpFailed("the data channel closed while connecting")))
            onStateChange?(.closed)
        default:
            break
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary else { return }
        if let event = RealtimeEventDecoder.decode(buffer.data) {
            onEvent?(event)
        }
    }
}
