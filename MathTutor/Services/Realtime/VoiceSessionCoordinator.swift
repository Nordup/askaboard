import Foundation
import os

/// The live voice engine: owns the WebRTC transport, the audio session, and every decision
/// between "the learner tapped the voice disc" and "the call ended". Implements
/// `VoiceSessionControlling` for the UI; reaches the rest of the app only through
/// `VoiceSessionHooks`.
///
/// The decisions themselves live in the pure types in `VoiceEngineLogic.swift` — this class is
/// the wiring: it feeds them events (hopped onto the main actor, because WebRTC calls back on
/// its own threads) and performs what they return.
///
/// Turn-taking is deliberately server-driven, unlike the sleep app this ports from: the session
/// config negotiates `semantic_vad` with `create_response` and `interrupt_response` both true,
/// so the server decides when the tutor answers. What stays on the phone is what only the phone
/// can do: duck the remote track the instant the learner speaks, cancel a response that has
/// made noise, run `send_to_tutor` through the normal tutor pipeline, and keep the microphone
/// honest (mute ownership, watchdog).
@MainActor
final class VoiceSessionCoordinator: VoiceSessionControlling {

    static let sendToTutorToolName = "send_to_tutor"
    /// Work mode's tool: the model has said its warm line and wants to go quiet. Answered
    /// on the device, silently — no worker turn, no server state.
    static let stepBackToolName = "step_back"

    /// Keepalive cadence, from the sleep app: after 40 s without a server event, a no-op
    /// `session.update` draws the `session.updated` that proves the far end is alive; never
    /// more often than every 20 s.
    static let keepaliveAfterSilentSeconds: TimeInterval = 40
    static let minimumKeepaliveIntervalSeconds: TimeInterval = 20

    /// How long the Ending mascot state plays before the transport is torn down.
    static let endingSeconds: TimeInterval = 0.9

    let display = VoiceDisplayProvider()
    private(set) var isActive = false

    private let configuration: BackendConfiguration
    private let audioSession: VoiceAudioSessionController
    private let log = Logger(subsystem: "com.nordup.MathTutor", category: "voice")

    private var connection: RealtimeConnection?
    private var hooks: VoiceSessionHooks?
    /// Reports each `response.done`'s token counts to the backend — the server never sees the
    /// data channel, so without this a voice call bills invisibly to the daily spend cap.
    private var usageReporter: RealtimeUsageReporter?

    // The pure logic, one instance each, reset wholesale at teardown.
    private var bargeIn = VoiceBargeIn()
    private var ledger = AssistantResponseLedger()
    private var toolGate = VoiceToolCallGate()
    private var muteGuard = MicMuteGuard()
    private var speechProxy = AssistantSpeechProxy()
    private var captureReducer = CaptureLevelReducer()

    private enum Lifecycle { case idle, connecting, live, ending }
    private var lifecycle: Lifecycle = .idle

    private var latestMicLevel: Double = 0
    private var latestMicLevelAt: TimeInterval = 0
    /// When the assistant last stopped making noise. The mic level is an RMS over a whole
    /// second, so a reading whose window overlapped playback still describes the loudspeaker
    /// after the response ends; the echo tail keeps it off the mascot.
    private var assistantActivityEndedAt: TimeInterval = 0
    /// Uplink window (1 s) plus margin.
    private static let echoTailSeconds: TimeInterval = 1.5
    private var delegatedTurnsRunning = 0
    private var lastServerEventAt: TimeInterval = 0
    private var lastKeepaliveAt: TimeInterval = 0
    /// Input-transcription deltas accumulated per item id while the learner
    /// speaks. The `completed` transcript is authoritative and replaces this
    /// wholesale; what the accumulation is *for* is the failure path — a
    /// transcription that fails after its deltas streamed still has to settle
    /// the live bubble with something honest.
    private var userTranscriptAccumulation: [String: String] = [:]

    /// Incremented at every start and teardown. A delegated turn that outlives the call it
    /// belongs to (deliberate — the worker's message must still land in the thread) compares
    /// generations before touching the connection, so its late tool output can never leak into
    /// a newer call.
    private var generation = 0

    private var displayTask: Task<Void, Never>?
    private var tickTask: Task<Void, Never>?

    init(configuration: BackendConfiguration,
         audioSession: VoiceAudioSessionController = VoiceAudioSessionController()) {
        self.configuration = configuration
        self.audioSession = audioSession
    }

    // MARK: - VoiceSessionControlling

    func start(sessionID: UUID, voiceModel: VoiceModelChoice, hooks: VoiceSessionHooks) async {
        guard lifecycle == .idle else { return }
        // One microphone. Dictation's AVAudioEngine and WebRTC's audio device module must
        // never run together (sleep lesson 3) — the reverse gate is the UI hiding the
        // dictation mic while `isActive`.
        guard !hooks.isDictationActive() else {
            log.info("voice start refused: dictation is capturing")
            return
        }

        self.hooks = hooks
        lifecycle = .connecting
        generation += 1
        publishDisplay()

        audioSession.onEvent = { [weak self] event in
            self?.handleAudioSessionEvent(event)
        }
        do {
            try audioSession.activate()
        } catch {
            log.error("audio session activation failed: \(error.localizedDescription)")
            teardown()
            return
        }

        let signaling = RealtimeSignalingClient(
            configuration: configuration, sessionID: sessionID, voiceModel: voiceModel
        )
        // The same model on both: the reporter prices what the call actually ran on, and a
        // reporter that disagreed with the signaling client would bill Mini minutes at Full
        // rates — which is exactly the saving the setting exists to produce.
        usageReporter = RealtimeUsageReporter(
            configuration: configuration, sessionID: sessionID, voiceModel: voiceModel
        )
        let connection = RealtimeConnection(signaling: signaling)
        self.connection = connection
        wire(connection)

        do {
            try await connection.connect()
        } catch {
            log.error("voice connect failed: \(error.localizedDescription)")
            teardown()
            return
        }
        // The user tapped X while the SDP exchange was in flight: `end()` already tore
        // everything down and `connect()` still returned. Do not resurrect the call.
        guard lifecycle == .connecting, self.connection === connection else { return }

        lifecycle = .live
        isActive = true
        lastServerEventAt = VoiceClock.now
        connection.setRemoteAudioGain(1)
        connection.setUplinkPollingEnabled(true)
        if let mode = connection.negotiatedTurnDetectionMode {
            log.info("voice call live, turn detection \(mode)")
        }
        startTimers()
        publishDisplay()
    }

    func end() async {
        switch lifecycle {
        case .idle, .ending:
            return
        case .connecting:
            // Nothing audible yet; no Ending state to play. `connect()`'s continuation sees
            // the lifecycle change and stands down.
            teardown()
            return
        case .live:
            break
        }

        lifecycle = .ending
        // The microphone goes first: a call that is ending must stop listening before it stops
        // playing.
        connection?.setMicrophoneEnabled(false)
        publishDisplay()
        try? await Task.sleep(for: .seconds(Self.endingSeconds))
        guard lifecycle == .ending else { return }
        teardown()
    }

    func setMuted(_ muted: Bool) {
        muteGuard.setUserMuted(muted)
        connection?.setMicrophoneEnabled(muteGuard.shouldTransmit)
        publishDisplay()
    }

    func sendTyped(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, lifecycle == .live else { return }
        send({ try RealtimeEventEncoder.userTextItem(text: trimmed) }, "user text item")
        send({ try RealtimeEventEncoder.responseCreate() }, "response.create (typed)")
    }

    /// The mascot's tap — the only way out of work mode.
    ///
    /// The mic is off while the tutor rests, so speech cannot end it and neither can the
    /// mute button (the bar dims it). A no-op everywhere else: a tap on a mascot that is
    /// listening or talking must change nothing.
    func wake() {
        guard lifecycle == .live, muteGuard.isResting else { return }
        muteGuard.setResting(false)
        connection?.setMicrophoneEnabled(muteGuard.shouldTransmit)
        publishDisplay()
    }

    /// Work mode, entered by the model's own judgment: the microphone goes off under a
    /// third owner (`MicMuteGuard.isResting`) and the display carries `.resting` to the
    /// mascot, the chip and the voice bar. Nothing server-side knows — the rest lives
    /// inside the call and dies with it, because teardown rebuilds the guard.
    private func enterRest() {
        muteGuard.setResting(true)
        connection?.setMicrophoneEnabled(muteGuard.shouldTransmit)
        publishDisplay()
    }

    // MARK: - Transport wiring

    private func wire(_ connection: RealtimeConnection) {
        // WebRTC calls back on its signaling/stats threads; everything this class knows hops
        // through these three closures onto the main actor.
        connection.onEvent = { [weak self] event in
            Task { @MainActor in self?.handle(event: event) }
        }
        connection.onStateChange = { [weak self] state in
            Task { @MainActor in self?.handle(connectionState: state) }
        }
        connection.onCaptureReading = { [weak self] reading in
            Task { @MainActor in self?.ingest(reading) }
        }
    }

    private func handle(connectionState state: RealtimeConnectionState) {
        switch state {
        case .idle, .connecting, .iceConnected, .connected:
            break
        case .closed:
            // Expected during teardown; anything else is the transport going away under a live
            // call.
            guard lifecycle == .live else { return }
            log.error("transport closed under a live call")
            teardown()
        case .failed(let reason):
            guard lifecycle == .live || lifecycle == .connecting else { return }
            log.error("transport failed: \(reason)")
            teardown()
        }
    }

    // MARK: - Server events

    private func handle(event: RealtimeServerEvent) {
        guard lifecycle == .live || lifecycle == .connecting else { return }
        let now = VoiceClock.now
        lastServerEventAt = now

        switch event {
        case .sessionCreated(let sessionId, let model):
            log.info("session.created \(sessionId ?? "-", privacy: .public) model=\(model ?? "-", privacy: .public)")

        case .sessionUpdated:
            break

        case .speechStarted:
            // Duck first, unconditionally, and before anything that can decide not to act:
            // a false duck is the tutor briefly quieter, a missed one is the tutor talking
            // over the learner. Cancel only a response that has made noise.
            connection?.setRemoteAudioDucked(true)
            if bargeIn.userSpeechStarted() == .duckAndCancel {
                send({ try RealtimeEventEncoder.responseCancel() }, "response.cancel (barge-in)")
            }

        case .speechStopped:
            connection?.setRemoteAudioDucked(false)

        case .bufferCommitted:
            // The repair path for a dropped `speech_stopped`: a commit proves the speech span
            // closed, so the tutor cannot be left permanently at a tenth volume.
            connection?.setRemoteAudioDucked(false)

        case .inputTranscriptionDelta(let itemId, let delta):
            guard !delta.isEmpty else { return }
            userTranscriptAccumulation[itemId, default: ""] += delta
            hooks?.streamUserTranscript?(itemId, delta)

        case .inputTranscriptionCompleted(let itemId, let transcript, let presence):
            // Words settle the live bubble as a normal learner message; anything
            // else — a cough or the room closing a turn with an empty transcript —
            // finalizes with nil, which removes the bubble rather than putting
            // silence in the thread.
            finalizeUserUtterance(itemID: itemId, with: presence == .words ? transcript : nil)

        case .inputTranscriptionFailed(let itemId, let message):
            log.error("input transcription failed: \(message, privacy: .public)")
            // At a wired site deltas may already be on screen, so a failed
            // transcription must still settle the live bubble: keep what
            // streamed (it is the transcriber's own words, and the learner
            // watched them arrive), or remove a bubble that never got any. At
            // an unwired site nothing streamed and nothing appends — the
            // legacy behavior, log only.
            if let itemId, hooks?.finalizeUserUtterance != nil {
                let streamed = userTranscriptAccumulation[itemId] ?? ""
                let hasWords = !streamed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                finalizeUserUtterance(itemID: itemId, with: hasWords ? streamed : nil)
            } else if let itemId {
                userTranscriptAccumulation[itemId] = nil
            }

        case .responseCreated(let responseId):
            bargeIn.responseCreated()
            ledger.responseCreated(responseID: responseId)

        case .outputTranscriptDelta(let responseId, let itemId, let delta):
            let responseID = responseId ?? "current"
            let itemID = itemId ?? responseID
            // The earliest proof this response is producing audio, and therefore the moment it
            // becomes cancellable. It runs ahead of the loudspeaker, which errs toward
            // treating a barge-in as real: the safe direction.
            bargeIn.responseProducedAudio()
            ledger.noteDelta(responseID: responseID, itemID: itemID, delta: delta)
            speechProxy.noteTranscriptDelta(characters: delta.count, at: now)
            hooks?.streamAssistantText(itemID, delta)

        case .outputTranscriptDone(let responseId, let itemId, let transcript):
            let responseID = responseId ?? "current"
            ledger.noteDone(responseID: responseID, itemID: itemId ?? responseID, transcript: transcript)

        case .functionCallArgumentsDone(let call, let responseId):
            handleToolCall(call, responseID: responseId)

        case .responseDone(let responseId, _, let failure, let calls, let usage):
            let responseID = responseId ?? "current"
            // Swept calls first: a call that only ever appears in `response.done` must mark
            // this response delegated *before* the ledger closes it.
            for call in calls {
                handleToolCall(call, responseID: responseID)
            }
            if bargeIn.responseHasSpoken {
                assistantActivityEndedAt = now
            }
            bargeIn.responseEnded()
            if let failure {
                log.error("response failed: \(failure, privacy: .public)")
            }
            for item in ledger.finish(responseID: responseID) {
                hooks?.assistantResponseFinished(item.itemID, item.delegated)
            }
            if let usage, let reporter = usageReporter {
                // Fire and forget, captured by value on purpose: the final response's report
                // races `end()`'s teardown, and money already spent must still land server-side.
                Task { await reporter.report(usage, responseID: responseId) }
            }

        case .outputAudioStarted:
            speechProxy.noteOutputAudioStarted()

        case .outputAudioStopped:
            speechProxy.noteOutputAudioStopped()
            assistantActivityEndedAt = now

        case .error(let payload):
            log.error("realtime error \(payload.code ?? payload.type, privacy: .public): \(payload.message, privacy: .public)")

        case .unhandled:
            break
        }
    }

    // MARK: - Learner transcript

    /// Closes a learner item: hands the thread the authoritative transcript,
    /// nil meaning silence — remove the live bubble. A site that has not
    /// wired the streaming pair gets the legacy behavior instead: words
    /// append on completion through `appendUserUtterance`, silence appends
    /// nothing.
    private func finalizeUserUtterance(itemID: String, with text: String?) {
        userTranscriptAccumulation[itemID] = nil
        if let finalize = hooks?.finalizeUserUtterance {
            finalize(itemID, text)
        } else if let text {
            hooks?.appendUserUtterance(text)
        }
    }

    // MARK: - send_to_tutor

    /// One tool, executed through the normal tutor pipeline. The voice model keeps talking
    /// while the worker runs (realtime function calls are async); the result goes back as
    /// `function_call_output` and a `response.create` so the voice model can relay it.
    private func handleToolCall(_ call: RealtimeFunctionCall, responseID: String?) {
        let decision = toolGate.decide(callID: call.callId)

        // The calling response's speech is the action line ("Let me work through that on the
        // board") — voice glue around the worker's canonical message, dropped by the dedup
        // rule when the response finishes. Marked before the duplicate early-return, because
        // the same call arrives twice and the response id may only be present on the swept
        // delivery; `didRun` keeps busy-answered calls from suppressing anything.
        if call.name == Self.sendToTutorToolName, let responseID, toolGate.didRun(call.callId) {
            ledger.noteDelegated(responseID: responseID)
        }

        switch decision {
        case .duplicate:
            // Arrived via `function_call_arguments.done` *and* swept from `response.done` —
            // already executing or answered.
            return
        case .busy:
            // A second call while a worker turn is streaming. Two concurrent turns on one
            // session would interleave in the thread, so the model is told to wait instead.
            sendToolResult(callID: call.callId, output: ["error": "busy"])
            return
        case .run:
            break
        }

        // Work mode. Answered here and nowhere else: no worker turn, no thread entry, and
        // deliberately NOT marked delegated in the ledger — the warm line this response
        // spoke ("Take your time — tap me when you're ready") is voice-only content and
        // belongs in the thread, which is where board 31 draws it.
        if call.name == Self.stepBackToolName {
            toolGate.finished(callID: call.callId)
            sendToolResult(callID: call.callId, output: ["ok": "resting"], createResponse: false)
            enterRest()
            publishDisplay()
            return
        }

        guard call.name == Self.sendToTutorToolName else {
            toolGate.finished(callID: call.callId)
            sendToolResult(callID: call.callId, output: ["error": "unknown tool \(call.name)"])
            return
        }

        guard let request = Self.request(fromArguments: call.argumentsJSON) else {
            toolGate.finished(callID: call.callId)
            sendToolResult(callID: call.callId, output: ["error": "malformed arguments"])
            return
        }
        guard let hooks else {
            toolGate.finished(callID: call.callId)
            sendToolResult(callID: call.callId, output: ["error": "no session"])
            return
        }

        delegatedTurnsRunning += 1
        let callGeneration = generation
        Task { @MainActor [weak self] in
            // Deliberately not cancelled by `end()`: the worker's turn streams the canonical
            // message into the thread, and ending the voice call must not kill it.
            let result = await hooks.runTutorTurn(request)
            guard let self, self.generation == callGeneration else { return }
            self.delegatedTurnsRunning = max(0, self.delegatedTurnsRunning - 1)
            self.toolGate.finished(callID: call.callId)
            switch result {
            case .success(let reply):
                // The response our `response.create` provokes is the voice model rephrasing
                // `tutor_reply` — the other half of the dedup rule.
                self.ledger.markNextCreatedResponseDelegated()
                self.sendToolResult(callID: call.callId, output: ["tutor_reply": reply])
            case .failure(let error):
                // Not marked as a relay: an apology for a failed turn is voice-only content
                // and belongs in the thread.
                self.sendToolResult(callID: call.callId, output: ["error": error.localizedDescription])
            }
            self.publishDisplay()
        }
        publishDisplay()
    }

    static func request(fromArguments argumentsJSON: String) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(argumentsJSON.utf8)) as? [String: Any],
              let request = object["request"] as? String,
              !request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return request
    }

    /// `createResponse: false` answers a tool without asking the model to speak again.
    ///
    /// `step_back` is the one caller that wants it: the model already said its warm line in
    /// the response that carried the call, and a second `response.create` would bill the
    /// whole context to produce a second goodbye — on a mascot that is at that moment going
    /// quiet.
    private func sendToolResult(callID: String, output: [String: String], createResponse: Bool = true) {
        send({ try RealtimeEventEncoder.functionCallOutput(callId: callID, output: output) },
             "function_call_output")
        if createResponse {
            send({ try RealtimeEventEncoder.responseCreate() }, "response.create (tool result)")
        }
    }

    /// The one funnel every outbound event passes through. Drops silently when the channel is
    /// not open: outbound events race the teardown, and a keepalive or late tool output lost to
    /// a closing channel is not a failure worth surfacing.
    private func send(_ payload: () throws -> Data, _ description: String) {
        guard let connection, connection.isDataChannelOpen else { return }
        do {
            try connection.send(payload())
        } catch {
            log.error("send \(description, privacy: .public) failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Audio session events

    private func handleAudioSessionEvent(_ event: VoiceAudioSessionEvent) {
        guard lifecycle == .live || lifecycle == .connecting else { return }
        let now = VoiceClock.now
        switch event {
        case .interruptionBegan(let detail):
            log.info("audio interruption began: \(detail, privacy: .public)")
            muteGuard.interruptionBegan(reason: "interruption", at: now)
            connection?.setMicrophoneEnabled(false)

        case .interruptionEnded(_, let detail):
            log.info("audio interruption ended: \(detail, privacy: .public)")
            apply(muteGuard.interruptionEnded(at: now))

        case .routeChanged(let reason, let output):
            log.info("audio route: \(reason, privacy: .public) → \(output, privacy: .public)")
            apply(muteGuard.routeChanged(at: now))

        case .mediaServicesReset:
            // The controller already rebuilt the session (lesson 11); what is left is making
            // sure the track transmits again.
            log.error("media services reset during a live call")
            connection?.setMicrophoneEnabled(muteGuard.shouldTransmit)

        case .configurationFailed(let message):
            log.error("audio session: \(message, privacy: .public)")
        }
    }

    private func apply(_ action: MicMuteGuard.Action) {
        switch action {
        case .none:
            break
        case .reenableMicrophone(let reason):
            log.info("microphone recovery: \(reason, privacy: .public)")
            audioSession.reactivate()
            // `shouldTransmit`, not `true`: a user mute survives every recovery.
            connection?.setMicrophoneEnabled(muteGuard.shouldTransmit)
        }
    }

    // MARK: - Microphone level

    private func ingest(_ reading: VoiceCaptureReading) {
        // The interval RMS from the energy accumulators is the honest basis; the decayed peak
        // is the fallback on builds that do not publish them. Both absent is `nil` all the way
        // down — an unmeasured microphone shows a still mascot, not a silent room verdict.
        let amplitude = captureReducer.intervalAmplitude(
            energy: reading.totalAudioEnergy,
            duration: reading.totalSamplesDuration
        ) ?? reading.audioLevel
        guard let amplitude else { return }
        latestMicLevel = VoiceLevel.normalizedSpeechLevel(linearAmplitude: amplitude)
        latestMicLevelAt = reading.at
    }

    // MARK: - Timers

    private func startTimers() {
        // 10 Hz into the dedicated display provider, never into the store: per-frame levels
        // must not re-render the thread.
        displayTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.publishDisplay()
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        // The 1 Hz tick: mute watchdog and keepalive.
        tickTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.tick()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func tick() {
        guard lifecycle == .live else { return }
        let now = VoiceClock.now
        apply(muteGuard.tick(at: now))

        if now - lastServerEventAt >= Self.keepaliveAfterSilentSeconds,
           now - lastKeepaliveAt >= Self.minimumKeepaliveIntervalSeconds {
            lastKeepaliveAt = now
            send({ try RealtimeEventEncoder.keepalive() }, "keepalive")
        }
    }

    // MARK: - Display

    private func publishDisplay() {
        let now = VoiceClock.now
        // "The assistant is audible" for the mascot: it has actually made noise. The broader
        // "a response is open at all" gates the microphone, because echo cancellation produces
        // a true zero the whole time the loudspeaker might play (sleep lesson 6) and the
        // transcript stream runs ahead of it.
        let assistantAudible = (bargeIn.responseInFlight && bargeIn.responseHasSpoken)
            || speechProxy.outputBufferActive
        let micIsMeaningless = bargeIn.responseInFlight
            || speechProxy.outputBufferActive
            || now - assistantActivityEndedAt < Self.echoTailSeconds
        let micIsStale = now - latestMicLevelAt > RealtimeConnection.uplinkPollInterval * 1.5

        var state = VoiceDisplayState()
        state.phase = phase(assistantAudible: assistantAudible)
        state.isMuted = muteGuard.isUserMuted
        if lifecycle == .live {
            state.userLevel = (micIsMeaningless || muteGuard.isUserMuted || micIsStale)
                ? 0 : latestMicLevel
            state.assistantLevel = speechProxy.level(at: now)
        }
        if display.state != state {
            display.state = state
        }
    }

    private func phase(assistantAudible: Bool) -> VoicePhase {
        switch lifecycle {
        case .idle: return .idle
        case .connecting: return .connecting
        case .ending: return .ending
        case .live:
            // `talking` stays first: the goodbye line is still playing when `step_back`'s
            // arguments arrive, and the mascot must finish saying it before it rests.
            if assistantAudible { return .talking }
            if muteGuard.isResting { return .resting }
            if delegatedTurnsRunning > 0 { return .thinking }
            return .listening
        }
    }

    // MARK: - Teardown

    /// Everything a call allocates, released in the reverse of the order it was taken. Safe to
    /// run twice; `RealtimeConnection.close()` is idempotent underneath it.
    private func teardown() {
        generation += 1
        displayTask?.cancel()
        displayTask = nil
        tickTask?.cancel()
        tickTask = nil

        connection?.close()
        connection = nil
        audioSession.onEvent = nil
        audioSession.deactivate()

        usageReporter = nil
        hooks = nil
        isActive = false
        bargeIn = VoiceBargeIn()
        ledger = AssistantResponseLedger()
        toolGate = VoiceToolCallGate()
        muteGuard = MicMuteGuard()
        speechProxy = AssistantSpeechProxy()
        captureReducer = CaptureLevelReducer()
        userTranscriptAccumulation = [:]
        delegatedTurnsRunning = 0
        latestMicLevel = 0
        latestMicLevelAt = 0
        assistantActivityEndedAt = 0
        lastKeepaliveAt = 0

        lifecycle = .idle
        publishDisplay()
    }
}
