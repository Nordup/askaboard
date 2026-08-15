import Foundation

/// A fake voice engine that plays a scripted timeline of phases, levels and utterances.
///
/// The simulator cannot run WebRTC (the voice-processing audio unit hangs), so previews and
/// UI tests drive the composer, thread and mascot through this instead of the real
/// coordinator. It honours the contract's shape: `display` publishes at ~10 Hz, utterance
/// callbacks arrive through `VoiceSessionHooks`, `end()` plays the ~1 s ending state before
/// going idle, and typed text produces a delegated reply — so the UI cannot tell it from
/// the real engine short of hearing audio.
///
/// Levels are synthesised speech: two incommensurate sines around a mid level, clamped to
/// 0…1, so the mascot breathes and bobs the way a voice makes it rather than pulsing.
@MainActor
final class ScriptedVoiceEngine: VoiceSessionControlling {

    /// One beat of the timeline.
    enum Cue: Sendable {
        /// Hold a phase, mute the synthesised levels.
        case hold(VoicePhase, seconds: TimeInterval)
        /// The learner speaks: `.listening` with a live `userLevel`, then the finished
        /// transcript lands through `appendUserUtterance`.
        case userSpeaks(String, seconds: TimeInterval)
        /// A delegated turn runs: `.thinking`, levels silent.
        case thinking(seconds: TimeInterval)
        /// The assistant speaks: `.talking` with a live `assistantLevel`, the transcript
        /// streamed word by word through `streamAssistantText`, then
        /// `assistantResponseFinished(itemID, delegated)`.
        case assistantSpeaks(String, itemID: String, seconds: TimeInterval, delegated: Bool)
    }

    let display = VoiceDisplayProvider()
    private(set) var isActive = false

    private let script: [Cue]
    private let loops: Bool
    private var hooks: VoiceSessionHooks?
    private var runner: Task<Void, Never>?
    /// Cues injected mid-run (typed text); drained before the next scripted cue.
    private var pending: [Cue] = []
    private var isMuted = false
    private var typedCount = 0

    /// The display tick — the contract's "~10 Hz".
    private static let tickSeconds: TimeInterval = 0.1
    private static let connectSeconds: TimeInterval = 0.7
    private static let endingSeconds: TimeInterval = 1.0

    init(script: [Cue] = ScriptedVoiceEngine.demoScript, loops: Bool = true) {
        self.script = script
        self.loops = loops
    }

    /// A call worth watching: listen → learner asks → delegated think → spoken answer →
    /// listen again.
    static let demoScript: [Cue] = [
        .hold(.listening, seconds: 1.2),
        .userSpeaks("How do I find the hypotenuse here?", seconds: 2.2),
        .thinking(seconds: 2.6),
        .assistantSpeaks(
            "Square root of x squared plus y squared — let me sketch it on the board.",
            itemID: "scripted-item-1",
            seconds: 3.4,
            delegated: true
        ),
        .hold(.listening, seconds: 2.0),
    ]

    /// Hooks that swallow everything — for previews that only watch the mascot.
    static func noopHooks() -> VoiceSessionHooks {
        VoiceSessionHooks(
            runTutorTurn: { _ in .success("") },
            appendUserUtterance: { _ in },
            streamAssistantText: { _, _ in },
            assistantResponseFinished: { _, _ in }
        )
    }

    // MARK: - VoiceSessionControlling

    func start(sessionID: UUID, hooks: VoiceSessionHooks) async {
        guard !isActive else { return }
        isActive = true
        self.hooks = hooks
        runner = Task { [weak self] in
            await self?.run()
        }
    }

    func end() async {
        runner?.cancel()
        runner = nil
        setDisplay(phase: .ending, userLevel: 0, assistantLevel: 0)
        try? await Task.sleep(nanoseconds: UInt64(Self.endingSeconds * 1_000_000_000))
        setDisplay(phase: .idle, userLevel: 0, assistantLevel: 0)
        isActive = false
        pending = []
    }

    func setMuted(_ muted: Bool) {
        isMuted = muted
        var state = display.state
        state.isMuted = muted
        if muted { state.userLevel = 0 }
        display.state = state
    }

    func sendTyped(_ text: String) {
        guard isActive else { return }
        typedCount += 1
        // The real engine turns typed text into a user item + response.create; the voice
        // model usually delegates. The fake does the same dance so the UI states match.
        pending.append(contentsOf: [
            .thinking(seconds: 1.2),
            .assistantSpeaks(
                "Here is what I found for “\(text)” — it is on the board.",
                itemID: "scripted-typed-\(typedCount)",
                seconds: 2.4,
                delegated: true
            ),
        ])
    }

    // MARK: - The run loop

    private func run() async {
        setDisplay(phase: .connecting, userLevel: 0, assistantLevel: 0)
        guard await holdPhase(.connecting, seconds: Self.connectSeconds) else { return }

        repeat {
            var index = 0
            while index < script.count {
                if Task.isCancelled { return }
                if !pending.isEmpty {
                    let cue = pending.removeFirst()
                    guard await play(cue) else { return }
                    continue
                }
                let cue = script[index]
                index += 1
                guard await play(cue) else { return }
            }
        } while loops && !Task.isCancelled
        setDisplay(phase: .listening, userLevel: 0, assistantLevel: 0)
    }

    /// Returns false once cancelled, so the loop unwinds without another state write —
    /// `end()` owns the display from that moment.
    private func play(_ cue: Cue) async -> Bool {
        switch cue {
        case .hold(let phase, let seconds):
            return await holdPhase(phase, seconds: seconds)

        case .userSpeaks(let text, let seconds):
            let finished = await tick(seconds: seconds) { t in
                self.setDisplay(
                    phase: .listening,
                    userLevel: self.isMuted ? 0 : Self.speechLevel(at: t),
                    assistantLevel: 0
                )
            }
            guard finished else { return false }
            hooks?.appendUserUtterance(text)
            return true

        case .thinking(let seconds):
            return await holdPhase(.thinking, seconds: seconds)

        case .assistantSpeaks(let text, let itemID, let seconds, let delegated):
            let words = text.split(separator: " ", omittingEmptySubsequences: false)
            var streamed = 0
            let finished = await tick(seconds: seconds) { t in
                self.setDisplay(
                    phase: .talking,
                    userLevel: 0,
                    assistantLevel: Self.speechLevel(at: t + 17)
                )
                // Stream the transcript evenly across the utterance.
                let due = Int(Double(words.count) * min(t / seconds, 1))
                while streamed < due {
                    let chunk = (streamed == 0 ? "" : " ") + String(words[streamed])
                    self.hooks?.streamAssistantText(itemID, chunk)
                    streamed += 1
                }
            }
            guard finished else { return false }
            while streamed < words.count {
                let chunk = (streamed == 0 ? "" : " ") + String(words[streamed])
                hooks?.streamAssistantText(itemID, chunk)
                streamed += 1
            }
            hooks?.assistantResponseFinished(itemID, delegated)
            return true
        }
    }

    private func holdPhase(_ phase: VoicePhase, seconds: TimeInterval) async -> Bool {
        await tick(seconds: seconds) { _ in
            self.setDisplay(phase: phase, userLevel: 0, assistantLevel: 0)
        }
    }

    /// Runs `body` every ~100 ms for `seconds`. Returns false if cancelled mid-way.
    private func tick(seconds: TimeInterval, body: @MainActor (TimeInterval) -> Void) async -> Bool {
        var elapsed: TimeInterval = 0
        while elapsed < seconds {
            if Task.isCancelled { return false }
            body(elapsed)
            do {
                try await Task.sleep(nanoseconds: UInt64(Self.tickSeconds * 1_000_000_000))
            } catch {
                return false
            }
            elapsed += Self.tickSeconds
        }
        return !Task.isCancelled
    }

    private func setDisplay(phase: VoicePhase, userLevel: Double, assistantLevel: Double) {
        display.state = VoiceDisplayState(
            phase: phase,
            userLevel: userLevel,
            assistantLevel: assistantLevel,
            isMuted: isMuted
        )
    }

    /// Synthesised speech: a mid level with syllable-rate and phrase-rate wobble.
    private static func speechLevel(at t: TimeInterval) -> Double {
        let level = 0.42
            + 0.26 * sin(2 * .pi * 2.3 * t)
            + 0.14 * sin(2 * .pi * 0.7 * t + 1.3)
        return min(max(level, 0), 1)
    }
}
