import Foundation

// The seam between the voice engine (Services/Realtime), the UI (composer,
// thread, mascot), and the store. Implementation packages conform to these
// types; only the realtime-engine package may amend this file, and the spec at
// docs/superpowers/specs/2026-08-15-voice-mode-design.md is its source of truth.

/// What the mascot and the voice bar render. Published at ~10 Hz through
/// `VoiceDisplayProvider`, never through the store's session publisher.
enum VoicePhase: Equatable {
    case idle
    case connecting
    /// Live and waiting on or hearing the learner.
    case listening
    /// A delegated tutor turn is running (worker model at work).
    case thinking
    /// Assistant audio is playing.
    case talking
    case ending
}

struct VoiceDisplayState: Equatable {
    var phase: VoicePhase = .idle
    /// 0…1 learner mic level. Reads 0 while the assistant speaks
    /// (echo cancellation makes the true level meaningless then).
    var userLevel: Double = 0
    /// 0…1 assistant speech-energy proxy.
    var assistantLevel: Double = 0
    var isMuted: Bool = false
}

/// Dedicated publisher so per-frame levels never re-render the thread.
@MainActor
final class VoiceDisplayProvider: ObservableObject {
    @Published var state = VoiceDisplayState()
}

/// How the engine reaches the rest of the app. Installed by BoardScreen.
struct VoiceSessionHooks {
    /// Run a delegated tutor turn through the normal pipeline and return the
    /// tutor's final message text. Side effects (thread streaming, board
    /// updates, step chips, recording) happen inside the normal pipeline.
    var runTutorTurn: (_ request: String) async -> Result<String, Error>
    /// A completed learner utterance transcript arrived.
    var appendUserUtterance: (_ text: String) -> Void
    /// Assistant spoken-transcript delta for the item with this id.
    var streamAssistantText: (_ itemID: String, _ delta: String) -> Void
    /// The assistant response for `itemID` finished. `delegated` is true when
    /// it called send_to_tutor — then its spoken transcript must be dropped
    /// from the thread (the worker's message is the canonical content). The
    /// engine also marks the response that *relays* a successful tutor_reply
    /// as delegated: both the action line and the rephrase are voice glue
    /// around the worker's canonical message.
    var assistantResponseFinished: (_ itemID: String, _ delegated: Bool) -> Void
    /// Whether composer dictation is capturing right now. [Package K
    /// amendment] The engine refuses to start while it is — dictation's
    /// AVAudioEngine and WebRTC's audio device module must never share the
    /// microphone. The reverse gate is the UI's: hide/stop dictation while
    /// `VoiceSessionControlling.isActive` (or
    /// `VoiceAudioSessionController.isVoiceSessionActive`). Defaulted so
    /// existing hook sites keep compiling; wire it to the dictation
    /// controller's live state.
    var isDictationActive: () -> Bool = { false }
}

/// The engine as the UI sees it.
@MainActor
protocol VoiceSessionControlling: AnyObject {
    var display: VoiceDisplayProvider { get }
    var isActive: Bool { get }
    func start(sessionID: UUID, hooks: VoiceSessionHooks) async
    func end() async
    func setMuted(_ muted: Bool)
    /// Typed text during a live call: becomes a user text item in the realtime
    /// conversation plus a response.create.
    func sendTyped(_ text: String)
}
