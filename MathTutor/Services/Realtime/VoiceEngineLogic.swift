import Foundation

// The voice engine's decisions, as value types on injected clocks: no WebRTC, no AVFoundation,
// no timers, no network. `VoiceSessionCoordinator` feeds them events and performs what they
// return; `VoiceEngineTests` drives them straight. This is the layer the sleep app proved on
// real nights (docs/research/voice-mode/sleep-app-voice-stack.md §10) — the invariants in the
// doc comments below are that history, not caution.

/// The engine's one clock. Uptime rather than wall time, so a watchdog cannot be fired or
/// starved by the user adjusting the clock mid-call.
enum VoiceClock {
    static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
}

// MARK: - Microphone level

/// One walk of the outbound half of `RTCPeerConnection.statistics`.
///
/// Every field is optional because every field is optional in reality: WebRTC builds differ
/// about which statistics they publish, and **"absent" must never be rendered as "measured
/// zero"** (sleep lesson 5) — that distinction is what separates "a quiet room" from "a dead
/// capture chain" and from "a build that measures nothing".
struct VoiceCaptureReading: Equatable, Sendable {
    var at: TimeInterval
    /// `media-source.audioLevel` (falling back to the sender's) — a momentary decayed peak,
    /// 0…1. Reads exactly 0 in roughly a third of samples on a perfectly live chain, so it is
    /// the fallback basis, never the preferred one.
    var audioLevel: Double?
    /// `media-source.totalAudioEnergy` — a monotonic accumulator, Σ amplitude²·dt.
    var totalAudioEnergy: Double?
    /// `media-source.totalSamplesDuration` — seconds of capture produced, monotonic.
    var totalSamplesDuration: Double?
}

/// Turns two monotonic accumulators into one interval's RMS amplitude. This is the microphone
/// level: the live call runs **no second audio unit** (sleep lesson 3 — an `AVAudioEngine` tap
/// beside WebRTC's device module killed the uplink three times in ten minutes), so the stats
/// report is the only acoustic instrument there is.
struct CaptureLevelReducer {
    private var last: (energy: Double, duration: Double)?

    /// The interval RMS between the previous reading and this one, or `nil` when there is no
    /// verdict: the first reading (no interval yet), absent accumulators (this build does not
    /// publish them), a counter that went backwards (the capture chain was rebuilt by a route
    /// change or media-services reset), or an interval too short to measure. Nil, never 0 — an
    /// absent statistic is not a silent room.
    mutating func intervalAmplitude(energy: Double?, duration: Double?) -> Double? {
        guard let energy, let duration else {
            // The stored pair belongs to a chain this reading says nothing about; keeping it
            // would make the next verdict span the dark interval.
            last = nil
            return nil
        }
        let previous = last
        last = (energy, duration)
        guard let previous else { return nil }

        let capturedEnergy = energy - previous.energy
        let capturedSeconds = duration - previous.duration
        // A counter that went backwards means the capture chain was rebuilt (a route change, a
        // media-services reset): nothing to conclude, and the next interval starts fresh.
        guard capturedEnergy >= 0, capturedSeconds >= 0 else { return nil }
        // Too little new capture to measure — timer jitter, not a window.
        guard capturedSeconds > 0.01 else { return nil }
        return (capturedEnergy / capturedSeconds).squareRoot()
    }
}

/// The mascot's loudness arithmetic, kept as values so it can be asserted on a machine with no
/// microphone — which is every machine this project's tests run on.
enum VoiceLevel {
    /// −48 dBFS → 0 (a quiet room), −12 dBFS → 1 (a close, raised voice). The sleep app's
    /// speech normalization, unchanged: an ordinary speaking voice lands near half scale.
    static let quietDBFS: Double = -48
    static let loudDBFS: Double = -12

    static func normalizedSpeechLevel(linearAmplitude: Double) -> Double {
        let amplitude = abs(linearAmplitude)
        guard amplitude.isFinite, amplitude > 0 else { return 0 }
        let dbfs = 20 * log10(amplitude)
        let normalized = (dbfs - quietDBFS) / (loudDBFS - quietDBFS)
        return min(max(normalized, 0), 1)
    }
}

// MARK: - Assistant level proxy

/// A 0…1 speech-energy proxy for the tutor's voice, driven by output-transcript-delta cadence
/// plus the `output_audio_buffer` events when they arrive.
///
/// A proxy because the honest signal does not exist: `output_audio_buffer.started` may never
/// arrive on this transport (sleep lesson 10), and the transcript stream runs ahead of the
/// loudspeaker. The mascot's Talking bob only has to *feel* attached to the voice; the mascot's
/// own attack/release envelope smooths whatever cadence this produces.
struct AssistantSpeechProxy: Equatable {
    /// How fast the proxy drains once deltas stop: level × e^(−Δt/τ). Roughly the mascot's
    /// release; a syllable's worth of silence dims, a sentence boundary goes near dark.
    static let decaySeconds: Double = 0.4
    /// What one delta is worth per character, and the most one delta may add. Deltas arrive a
    /// few words at a time, so an ordinary delta lands mid-scale and a burst saturates.
    static let bumpPerCharacter: Double = 1.0 / 24.0
    static let maximumBump: Double = 0.5
    /// While `output_audio_buffer` says audio is actually leaving the speaker, the proxy never
    /// reads fully dark even if deltas pause — the voice is audibly there.
    static let audibleFloor: Double = 0.25

    private var energy: Double = 0
    private var energyAt: TimeInterval = 0
    /// Between `output_audio_buffer.started` and `.stopped`/`.cleared`, when the transport
    /// sends them at all.
    private(set) var outputBufferActive = false

    mutating func noteTranscriptDelta(characters: Int, at now: TimeInterval) {
        let bump = min(Self.maximumBump, Double(max(characters, 1)) * Self.bumpPerCharacter)
        energy = min(1, decayed(at: now) + bump)
        energyAt = now
    }

    mutating func noteOutputAudioStarted() {
        outputBufferActive = true
    }

    /// The loudspeaker actually went quiet — a finished reply or a barge-in clear. The proxy
    /// drops to dark immediately; a voice that has stopped must not keep bobbing the mascot.
    mutating func noteOutputAudioStopped() {
        outputBufferActive = false
        energy = 0
    }

    func level(at now: TimeInterval) -> Double {
        let value = decayed(at: now)
        return outputBufferActive ? max(Self.audibleFloor, value) : value
    }

    private func decayed(at now: TimeInterval) -> Double {
        guard energy > 0, now > energyAt else { return energy }
        return energy * exp(-(now - energyAt) / Self.decaySeconds)
    }
}

// MARK: - Barge-in

/// The two halves of a barge-in, decided from response lifecycle events alone.
///
/// Ducking is unconditional and always first: `response.cancel` only stops the model
/// *generating* — it does nothing about audio already on the wire — while the volume of the
/// remote track is ours with no permission needed. Cancelling is conditional on the response
/// having **made noise** (sleep lesson: 26 replies in one night were cancelled before producing
/// a single sample — answers owed and never heard). The first output transcript delta is the
/// noise proxy, because `output_audio_buffer.started` may never arrive; it runs ahead of the
/// loudspeaker, which errs toward treating a barge-in as real — the safe direction.
///
/// The session runs semantic VAD with `interrupt_response: true`, so the server also cancels on
/// its own judgement; this client-side cancel is the half that still works when that judgement
/// is late or the event is lost.
struct VoiceBargeIn: Equatable {
    enum SpeechAction: Equatable {
        /// Duck the remote audio to a tenth — never mute; a voice that vanishes mid-word
        /// startles — and nothing else: the open response has not made a sound yet.
        case duck
        /// Duck, and also `response.cancel`: the learner is talking over audio they can hear.
        case duckAndCancel
    }

    private(set) var responseInFlight = false
    private(set) var responseHasSpoken = false

    mutating func responseCreated() {
        responseInFlight = true
        responseHasSpoken = false
    }

    /// The open response produced its first output transcript delta — from here on it can be
    /// cancelled without destroying an unheard answer.
    mutating func responseProducedAudio() {
        responseHasSpoken = true
    }

    mutating func responseEnded() {
        responseInFlight = false
        responseHasSpoken = false
    }

    mutating func userSpeechStarted() -> SpeechAction {
        (responseInFlight && responseHasSpoken) ? .duckAndCancel : .duck
    }
}

// MARK: - Assistant transcript ledger

/// Accumulates the tutor's spoken transcript per conversation item and remembers which
/// responses delegated to the worker, so the coordinator can apply the spec's dedup rule: a
/// delegated response's spoken transcript is a rephrase of the worker's canonical message and
/// must be dropped from the thread when it finishes.
///
/// Two kinds of response count as delegated:
/// 1. the response that *called* `send_to_tutor` (its speech is the action line), and
/// 2. the response created by our own `response.create` after a successful `tutor_reply`
///    (its speech is the rephrase itself) — marked ahead of time via
///    `markNextCreatedResponseDelegated()`, since nothing in that response's own events says
///    where it came from.
struct AssistantResponseLedger: Equatable {
    struct FinishedItem: Equatable {
        let itemID: String
        let delegated: Bool
    }

    private struct ResponseRecord: Equatable {
        var itemOrder: [String] = []
        var delegated = false
        var hasSpoken = false
    }

    private var responses: [String: ResponseRecord] = [:]
    private var textByItem: [String: String] = [:]
    private var pendingDelegatedRelays = 0

    /// The next `response.created` is the voice model relaying a `tutor_reply`; its spoken
    /// transcript is the rephrase the dedup rule exists for.
    mutating func markNextCreatedResponseDelegated() {
        pendingDelegatedRelays += 1
    }

    mutating func responseCreated(responseID: String) {
        var record = ResponseRecord()
        if pendingDelegatedRelays > 0 {
            pendingDelegatedRelays -= 1
            record.delegated = true
        }
        responses[responseID] = record
    }

    /// Accumulates one output transcript delta under its item. Returns `true` when this is the
    /// response's first delta — the "it has made noise" moment barge-in cares about.
    @discardableResult
    mutating func noteDelta(responseID: String, itemID: String, delta: String) -> Bool {
        var record = responses[responseID] ?? ResponseRecord()
        let isFirst = !record.hasSpoken
        record.hasSpoken = true
        if !record.itemOrder.contains(itemID) {
            record.itemOrder.append(itemID)
        }
        responses[responseID] = record
        textByItem[itemID, default: ""] += delta
        return isFirst
    }

    /// The final transcript replaces the accumulated deltas wholesale — the API's `done` text
    /// is authoritative.
    mutating func noteDone(responseID: String, itemID: String, transcript: String) {
        var record = responses[responseID] ?? ResponseRecord()
        if !record.itemOrder.contains(itemID) {
            record.itemOrder.append(itemID)
        }
        responses[responseID] = record
        textByItem[itemID] = transcript
    }

    /// This response called `send_to_tutor`.
    mutating func noteDelegated(responseID: String) {
        var record = responses[responseID] ?? ResponseRecord()
        record.delegated = true
        responses[responseID] = record
    }

    func accumulatedText(itemID: String) -> String? {
        textByItem[itemID]
    }

    func hasSpoken(responseID: String) -> Bool {
        responses[responseID]?.hasSpoken ?? false
    }

    /// `response.done`: closes the response and returns its transcript items in order, each
    /// carrying the delegated verdict the hooks need. The items leave the ledger with it.
    mutating func finish(responseID: String) -> [FinishedItem] {
        guard let record = responses.removeValue(forKey: responseID) else { return [] }
        return record.itemOrder.map { itemID in
            textByItem.removeValue(forKey: itemID)
            return FinishedItem(itemID: itemID, delegated: record.delegated)
        }
    }
}

// MARK: - Tool-call gate

/// De-duplication and single-flight for `send_to_tutor`.
///
/// Duplicates are real: a call arrives via `response.function_call_arguments.done` *and* swept
/// out of `response.done`, and must execute once. Overlap is real too: the voice model can call
/// again while a worker turn is still streaming, and two concurrent turns on one session would
/// interleave in the thread — so the second call is answered `{"error":"busy"}` instead of run.
struct VoiceToolCallGate: Equatable {
    enum Decision: Equatable {
        /// Execute. The gate now considers this call running until `finished(callID:)`.
        case run
        /// Already handled (or already answered busy). Do nothing at all.
        case duplicate
        /// Another call is mid-flight. Answer `{"error":"busy"}` and do not run.
        case busy
    }

    private var handledCallIDs: Set<String> = []
    private var ranCallIDs: Set<String> = []
    private(set) var runningCallID: String?

    mutating func decide(callID: String) -> Decision {
        guard !handledCallIDs.contains(callID) else { return .duplicate }
        handledCallIDs.insert(callID)
        guard runningCallID == nil else { return .busy }
        runningCallID = callID
        ranCallIDs.insert(callID)
        return .run
    }

    /// Whether this call id was (or is being) executed, as opposed to answered busy. The
    /// delegation mark needs it: the same call arrives twice, and the `response_id` may only be
    /// present on the duplicate delivery.
    func didRun(_ callID: String) -> Bool {
        ranCallIDs.contains(callID)
    }

    mutating func finished(callID: String) {
        guard runningCallID == callID else { return }
        runningCallID = nil
    }
}

// MARK: - Usage-report gate

/// De-duplication for usage reports, mirroring `VoiceToolCallGate` for the same underlying
/// fault: one `response.done` can be delivered through more than one event path, and each
/// delivery would mint a fresh `report_id` — so the server's retry idempotency never sees a
/// duplicate. On 2026-08-16 that billed one response twice. The gate remembers which response
/// ids have already been reported and lets each through once.
///
/// It also drops reports whose counts are all zero: a response cancelled before it produced a
/// single token carries no money and no information, and was writing empty rows.
struct VoiceUsageReportGate: Equatable {
    private var reportedResponseIDs: Set<String> = []

    /// Whether this `response.done`'s usage should go to the backend. Mutating: a `true`
    /// answer marks the response id as reported.
    ///
    /// A nil response id with non-zero counts still reports — there is nothing to dedupe on,
    /// and dropping it would lose real money. The server's `(session_id, response_id)` unique
    /// index is the backstop for anything this gate cannot see.
    mutating func shouldReport(responseID: String?, usage: RealtimeUsageCounts) -> Bool {
        guard !usage.isAllZero else { return false }
        guard let responseID else { return true }
        return reportedResponseIDs.insert(responseID).inserted
    }
}

// MARK: - Mute guard

/// Every mute has an owner, and any mute whose owner is gone gets a watchdog (sleep lesson 4).
///
/// A disabled `RTCAudioTrack` transmits silence while everything else looks perfectly healthy —
/// the connection stays up, the tutor keeps talking, and the learner speaks into a track
/// carrying nothing. The sleep app lost a whole session to an interruption whose `.ended`
/// notification never arrived (AVFoundation does not guarantee one), so:
///
/// - **The user's mute** is owned by the user. It never expires and nothing un-mutes it but
///   the mute button.
/// - **An interruption's mute** is owned by this guard. The interruption ending, a route
///   change, the app returning to the foreground, or the watchdog running out — whichever comes
///   first — asks for the microphone back.
/// - **The resting mute** is owned by work mode. No watchdog: the state is user-visible (the
///   mascot rests, the chip says so), and only the mascot tap — or the call ending, which
///   discards this guard with the rest of the call — releases it.
struct MicMuteGuard: Equatable {
    /// How long an interruption's mute may stand with no `.ended` before the guard takes the
    /// microphone back on its own.
    static let interruptionWatchdogSeconds: Double = 4

    enum Action: Equatable {
        case none
        /// Re-assert the audio session and set the track to `shouldTransmit`.
        case reenableMicrophone(reason: String)
    }

    private(set) var isUserMuted = false
    private(set) var isResting = false
    private var interruptionMutedSince: TimeInterval?
    private var interruptionReason: String?

    /// Whether the microphone track should be transmitting right now. The coordinator applies
    /// this after every event the guard answers, so the track can never disagree with the guard.
    var shouldTransmit: Bool { !isUserMuted && !isResting && interruptionMutedSince == nil }

    mutating func setUserMuted(_ muted: Bool) {
        isUserMuted = muted
    }

    mutating func setResting(_ resting: Bool) {
        isResting = resting
    }

    mutating func interruptionBegan(reason: String, at now: TimeInterval) {
        interruptionMutedSince = now
        interruptionReason = reason
    }

    mutating func interruptionEnded(at now: TimeInterval) -> Action {
        release(trigger: "interruption ended", at: now)
    }

    /// Route changes keep arriving while a session is interrupted; each one is a chance to
    /// notice the microphone is still muted with nothing coming to un-mute it.
    mutating func routeChanged(at now: TimeInterval) -> Action {
        release(trigger: "route changed while muted", at: now)
    }

    mutating func applicationBecameActive(at now: TimeInterval) -> Action {
        release(trigger: "app became active while muted", at: now)
    }

    /// The 1 Hz decision: an interruption mute older than the watchdog is a mute whose owner is
    /// never coming back.
    mutating func tick(at now: TimeInterval) -> Action {
        guard let since = interruptionMutedSince,
              now - since >= Self.interruptionWatchdogSeconds else { return .none }
        let reason = "\(interruptionReason ?? "interruption") never ended — "
            + "microphone muted for \(Int((now - since).rounded()))s"
        return release(trigger: reason, at: now)
    }

    private mutating func release(trigger: String, at now: TimeInterval) -> Action {
        guard interruptionMutedSince != nil else { return .none }
        interruptionMutedSince = nil
        interruptionReason = nil
        // The action fires even while the user is also muted: the audio session still needs
        // re-asserting, and `shouldTransmit` is what the coordinator applies to the track — a
        // user mute stays a user mute.
        return .reenableMicrophone(reason: trigger)
    }
}

// MARK: - Recap primer

/// The text of the one item the device seeds a call with: what has been said in this session
/// before the learner tapped the voice disc.
///
/// The worker model behind `send_to_tutor` always has the full conversation — the backend
/// rebuilds it from the session id. The realtime shell had none of it, and that is what the
/// founder met on device: a voice that could not say what they had been working on, could not
/// repeat a line from two minutes earlier, and asked the worker for "help with the problem".
///
/// Deliberately a *tail*, not a summary: a summary needs a model call on the critical path of
/// answering a tap, and the last thousand characters of the thread are what the next sentence
/// of a call is actually about.
enum VoiceRecapPrimer {

    /// What the model is told the text is for. Every clause earns its place: the model must not
    /// read it out (it is not a message), must not mention it (it is not something the learner
    /// said), and must use it when asked to repeat (which is the whole reason it is here).
    static let header = """
        WHERE WE ARE — this session's conversation so far, for your context only. Never read it \
        aloud, never mention this note. If I ask to repeat something from before this call, use it.
        """

    /// How much of the thread's tail rides along, in characters.
    ///
    /// The primer lands at the very start of the conversation and never changes, so from the
    /// second turn onward it is inside the cached prefix: it is paid for once, at text rates,
    /// for about a third of a cent per call. That is what makes a generous budget the cheap
    /// choice — trimming it would save nothing that matters and lose the context that does.
    static let transcriptBudget = 6_000

    /// The most one message may spend of the budget. One long tutor explanation must not eat
    /// the window that was meant to hold a conversation — unclamped, a single board-check
    /// reply left the 2026-08-16 test call knowing nothing about the sketches it was asked
    /// about. Clamped, the budget holds the last ~20 exchanges instead of the last two.
    /// Older messages keep their head (the head names the topic); the newest keeps its tail
    /// (the tail is where the call resumes).
    static let messageClamp = 300

    /// The whole primer, or nil when there is nothing to prime with. An empty thread — the
    /// ordinary "tapped the disc on a fresh session" case — sends no item at all rather than a
    /// note announcing that nothing has happened.
    static func text(for messages: [TutorMessage], budget: Int = transcriptBudget) -> String? {
        guard let transcript = transcript(for: messages, budget: budget) else { return nil }
        return header + "\n\n" + transcript
    }

    /// The tail of the thread, one message per line, oldest of the kept ones first.
    ///
    /// Cuts fall between whole messages, never inside one: half a sentence attributed to the
    /// learner is worse context than no sentence at all. The single exception is a lone message
    /// bigger than the whole budget, where the choice is its tail or nothing — and its tail is
    /// the half that the next thing said in the call will be about.
    static func transcript(for messages: [TutorMessage], budget: Int = transcriptBudget) -> String? {
        let raw = messages.compactMap(line(for:))
        guard !raw.isEmpty, budget > 0 else { return nil }
        let lines = raw.enumerated().map { index, line in
            clamp(line, keepingTail: index == raw.count - 1)
        }

        var kept: [String] = []
        var total = 0
        for line in lines.reversed() {
            // The newline that would join this line to the ones already kept counts too.
            let cost = line.count + (kept.isEmpty ? 0 : 1)
            guard total + cost <= budget else { break }
            kept.append(line)
            total += cost
        }
        if kept.isEmpty, let newest = lines.last {
            kept = [tail(of: newest, budget: budget)]
        }
        return kept.reversed().joined(separator: "\n")
    }

    /// One message as one line, or nil for anything that is not conversation: an empty or
    /// whitespace-only text (a turn still streaming, a bubble that never filled) and the
    /// `system` role, which is bookkeeping the model has no use for.
    private static func line(for message: TutorMessage) -> String? {
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let label: String
        switch message.role {
        case .learner: label = "Learner: "
        case .tutor: label = "Tutor: "
        case .system: return nil
        }
        // Newlines inside one message would read as extra speakers once the lines are joined.
        return label + text.replacingOccurrences(of: "\n", with: " ")
    }

    /// One line cut to `messageClamp` characters of text, label preserved, "…" marking the
    /// cut. No-op for anything short enough, which is most conversation.
    private static func clamp(_ line: String, keepingTail: Bool) -> String {
        guard let separator = line.range(of: ": "), separator.upperBound < line.endIndex else {
            return line
        }
        let label = String(line[line.startIndex..<separator.upperBound])
        let text = String(line[separator.upperBound...])
        guard text.count > messageClamp else { return line }
        return keepingTail
            ? label + "…" + text.suffix(messageClamp)
            : label + text.prefix(messageClamp) + "…"
    }

    /// The last `budget` characters of one over-long line, with its speaker label kept: a tail
    /// that has lost its "Learner:" is a tail the model may attribute to itself.
    private static func tail(of line: String, budget: Int) -> String {
        guard line.count > budget else { return line }
        guard let separator = line.range(of: ": "), separator.upperBound < line.endIndex else {
            return String(line.suffix(budget))
        }
        let label = String(line[line.startIndex..<separator.upperBound])
        guard label.count < budget else { return String(line.suffix(budget)) }
        return label + String(line[separator.upperBound...].suffix(budget - label.count))
    }
}
