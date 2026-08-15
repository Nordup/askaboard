import SwiftUI

// The app-side glue of the live-voice UI. The voice bar itself is not a view
// of its own: board 28's bar is the composer pill with a different trailing
// pair, so it lives inside `Composer` as the `ComposerVoiceCall` mode — one
// pill, one metrics system, and the attachment cards, notes and menu anchor
// all keep working for free. What this file holds is everything around it:
// the engine's owner, the thread-side value, and the mascot's stage.

/// The screen's handle on the voice engine.
///
/// `BoardScreen` owns one of these for the life of the screen, which is what
/// keeps a call alive across every presentation switch. It publishes only the
/// rare facts — live, muted — so the screen re-renders on a tap and never on a
/// level: the 10 Hz display stream stays on the engine's own
/// `VoiceDisplayProvider`, observed by nothing above the mascot itself.
@MainActor
final class VoiceSessionHost: ObservableObject {
    /// True from the voice disc's tap until the call ends — the one fact the
    /// composer, the thread and the screen branch on. Held here rather than
    /// read off the engine because the protocol's `isActive` is not
    /// observable, and observing the display provider from screen level is
    /// exactly what its 10 Hz publisher exists to prevent.
    @Published private(set) var isLive = false
    /// Mirrors the engine's mute so the bar's toggle re-renders on the tap.
    /// The engine's watchdog re-asserts mute rather than clearing it (the
    /// UplinkGuard pattern), so the mirror cannot drift the dangerous way.
    @Published private(set) var isMuted = false

    /// `nil` on a build with no backend configuration — the same builds that
    /// have no live tutor. The voice disc never appears then; the composer is
    /// exactly what it was before voice existed.
    private let engine: (any VoiceSessionControlling)?
    /// What `display` hands out when there is no engine: a provider forever at
    /// `.idle`, so no caller has to branch on availability to draw.
    private let idleDisplay = VoiceDisplayProvider()

    /// **The real engine's one construction site.** Previews and UI tests
    /// pass `ScriptedVoiceEngine()` instead — the simulator cannot run
    /// WebRTC, and the scripted engine plays the phases without it.
    init(engine: (any VoiceSessionControlling)? = nil) {
        if let engine {
            self.engine = engine
        } else if let configuration = BackendConfiguration.load() {
            self.engine = VoiceSessionCoordinator(configuration: configuration)
        } else {
            self.engine = nil
        }
    }

    /// Whether this build can hold a call at all — what gates the voice disc.
    var isAvailable: Bool { engine != nil }

    var display: VoiceDisplayProvider { engine?.display ?? idleDisplay }

    func begin(sessionID: UUID, hooks: VoiceSessionHooks) {
        guard let engine, !isLive else { return }
        isLive = true
        isMuted = false
        Task { [weak self] in
            await engine.start(sessionID: sessionID, hooks: hooks)
            // A start that could not bring the call up leaves the engine
            // inactive; fold the bar away rather than stranding a dead call's
            // chrome over a working composer.
            guard let self else { return }
            if !engine.isActive {
                self.isLive = false
            }
        }
    }

    /// End the call. The engine plays its own ending state (~1 s) and closes
    /// the connection inside `end()`; the bar folds when it returns, which is
    /// the spec's order — the mascot exhales, then the composer comes back.
    func finish() async {
        guard let engine, isLive else { return }
        await engine.end()
        isLive = false
        isMuted = false
    }

    func toggleMuted() {
        guard let engine else { return }
        isMuted.toggle()
        engine.setMuted(isMuted)
    }

    func sendTyped(_ text: String) {
        engine?.sendTyped(text)
    }
}

/// The live call as the thread draws it: which display to animate from, which
/// mascot variant the surface takes, and the stage band the boards give it.
struct VoiceThreadState {
    let display: VoiceDisplayProvider
    let variant: MascotVariant
    /// The band the mascot occupies in the thread's flow — it is a thread
    /// child, so the flow reserves its height and the halo overflows freely.
    let stageHeight: CGFloat

    /// Board 28: the 72pt face on a 120pt stage in the panel's thread.
    static func panel(display: VoiceDisplayProvider) -> Self {
        Self(display: display, variant: .panel, stageHeight: 120)
    }

    /// Board 29: the 120pt face on a 200pt stage in the reading column.
    static func fullScreen(display: VoiceDisplayProvider) -> Self {
        Self(display: display, variant: .fullScreen, stageHeight: 200)
    }
}

/// The mascot on its stage, centred in the thread's column — board 28's tail
/// child, in the thread orb's place. `VoiceMascotView` (the mascot package)
/// observes the 10 Hz display itself, so the thread never re-renders per
/// frame; this stage only reserves the flow band the boards draw. The halo
/// deliberately overflows it — the thread's bleed clip is what keeps overflow
/// legal there, exactly as it does for the orb's own glow.
struct VoiceMascotStage: View {
    let state: VoiceThreadState
    let width: CGFloat

    var body: some View {
        VoiceMascotView(display: state.display, variant: state.variant)
            .frame(width: width, height: state.stageHeight)
    }
}

// MARK: - Previews (scripted engine only — WebRTC cannot run here)

#if DEBUG
#Preview("Voice call · panel") {
    let engine = ScriptedVoiceEngine()
    return VStack(spacing: DS.Space.s6) {
        VoiceMascotStage(state: .panel(display: engine.display), width: 301)
        // The bar live, then muted, then the resting composer with the voice
        // disc in the send slot (board 27).
        Composer(
            scale: .panel,
            text: .constant(""),
            onSend: {},
            voice: ComposerVoiceCall(
                isMuted: false, onToggleMute: {}, onEnd: {}, onSendTyped: { _ in }
            )
        )
        Composer(
            scale: .panel,
            text: .constant(""),
            onSend: {},
            voice: ComposerVoiceCall(
                isMuted: true, onToggleMute: {}, onEnd: {}, onSendTyped: { _ in }
            )
        )
        Composer(scale: .panel, text: .constant(""), onSend: {}, onVoiceChat: {})
    }
    .padding(DS.Space.s6)
    .background(DS.Color.surfacePanel)
}
#endif
