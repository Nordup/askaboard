import SwiftUI

/// The live-voice mascot: the app's orb come alive for the duration of a call.
///
/// A single `Canvas` under a `TimelineView` at 30 fps — the sleep orb's architecture. The
/// layout slot is exactly the face box (72×56 docked, 120×94 full screen, 44×34 in the
/// collapsed dock's orb slot); the Canvas is a
/// larger square drawn as a `background`, because the halo and the talking ripples overflow
/// the slot on every side and a Canvas clips to its own bounds. Whoever places this against
/// a clipping edge needs the same care `Orb` asks for: the face box is the layout slot, the
/// glow is the visible bounds.
///
/// Inputs come only from `VoiceDisplayState`, read once per body evaluation — the provider
/// publishes at ~10 Hz and the Canvas interpolates between publishes through the motion's
/// envelopes. Inject one `MascotMotion` through `\.mascotMotion` at `BoardScreen` level so
/// the docked ↔ full-screen swap carries the envelopes across; without an injection the
/// view runs its own (previews).
struct VoiceMascotView: View {
    @ObservedObject var display: VoiceDisplayProvider
    let variant: MascotVariant

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.mascotMotion) private var sharedMotion
    @State private var ownMotion = MascotMotion()

    private var motion: MascotMotion { sharedMotion ?? ownMotion }

    var body: some View {
        let metrics = variant.metrics
        let state = display.state
        let reduce = reduceMotion
        return Color.clear
            .frame(width: metrics.face.width, height: metrics.face.height)
            .background {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                    Canvas(opaque: false, rendersAsynchronously: false) { context, size in
                        let frame = motion.frame(
                            at: timeline.date,
                            inputs: MascotMotion.Inputs(state: state, reduceMotion: reduce)
                        )
                        MascotPainter.draw(frame, metrics: metrics, in: &context, canvasSize: size)
                    }
                }
                .frame(width: metrics.canvasSide, height: metrics.canvasSide)
                .allowsHitTesting(false)
            }
            // Decorative, like `Orb`: it is the tutor's face, not a control. The voice
            // bar's buttons carry the labels.
            .accessibilityHidden(true)
    }
}

// MARK: - Shared motion injection

private struct MascotMotionKey: EnvironmentKey {
    static let defaultValue: MascotMotion? = nil
}

extension EnvironmentValues {
    /// The one `MascotMotion` a screen's mascots share, so envelopes and half-finished
    /// crossfades survive the panel ↔ full-screen swap. `nil` (previews) gives each view
    /// its own.
    var mascotMotion: MascotMotion? {
        get { self[MascotMotionKey.self] }
        set { self[MascotMotionKey.self] = newValue }
    }
}

// MARK: - Previews

#if DEBUG
/// A provider pinned to one state. The dynamics still run — a pinned listening level
/// breathes — which is exactly what a state preview should show.
@MainActor
private func pinnedDisplay(
    _ phase: VoicePhase,
    userLevel: Double = 0,
    assistantLevel: Double = 0
) -> VoiceDisplayProvider {
    let provider = VoiceDisplayProvider()
    provider.state = VoiceDisplayState(
        phase: phase,
        userLevel: userLevel,
        assistantLevel: assistantLevel
    )
    return provider
}

private struct MascotStateRow: View {
    let variant: MascotVariant

    var body: some View {
        let spacing: CGFloat = switch variant {
        case .dock: 110
        case .panel: 120
        case .fullScreen: 200
        }
        HStack(spacing: spacing) {
            VoiceMascotView(display: pinnedDisplay(.idle), variant: variant)
            VoiceMascotView(display: pinnedDisplay(.listening, userLevel: 0.55), variant: variant)
            VoiceMascotView(display: pinnedDisplay(.thinking), variant: variant)
            VoiceMascotView(display: pinnedDisplay(.talking, assistantLevel: 0.65), variant: variant)
            VoiceMascotView(display: pinnedDisplay(.ending), variant: variant)
        }
        .padding(spacing)
        .background(DS.Color.surfacePanel)
    }
}

#Preview("Panel 72 — five states") {
    MascotStateRow(variant: .panel)
}

#Preview("Full screen 120 — five states") {
    MascotStateRow(variant: .fullScreen)
}

#Preview("Dock 44 — five states") {
    MascotStateRow(variant: .dock)
}

#Preview("Panel 72 — connecting") {
    VoiceMascotView(display: pinnedDisplay(.connecting), variant: .panel)
        .padding(160)
        .background(DS.Color.surfacePanel)
}

/// The whole call, animated: connect → listen → think → talk → listen, on a loop.
///
/// The engine is created inside `.task` rather than in a property initializer because
/// `ScriptedVoiceEngine` is `@MainActor` and a `View`'s stored-property defaults are not.
private struct ScriptedMascotPreview: View {
    let variant: MascotVariant
    @State private var engine: ScriptedVoiceEngine?

    var body: some View {
        Group {
            if let engine {
                VoiceMascotView(display: engine.display, variant: variant)
            } else {
                Color.clear.frame(width: 1, height: 1)
            }
        }
        .padding(variant == .panel ? 160 : 280)
        .background(DS.Color.surfacePanel)
        .task {
            guard engine == nil else { return }
            let started = ScriptedVoiceEngine()
            engine = started
            await started.start(sessionID: UUID(), hooks: ScriptedVoiceEngine.noopHooks())
        }
    }
}

#Preview("Panel 72 — scripted call") {
    ScriptedMascotPreview(variant: .panel)
}

#Preview("Full screen 120 — scripted call") {
    ScriptedMascotPreview(variant: .fullScreen)
}
#endif
