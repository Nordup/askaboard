import SwiftUI

/// The floating mark that a voice call is still running in another session.
///
/// Board 32 "Voice · call pill · away from session", verbatim: a capsule on
/// `--color-surface` with a soft float, a mini mascot at its head, and the call
/// session's name beside it. It exists for one situation — the learner started
/// a call, then wandered off to look something up — and it answers the two
/// questions that situation raises: *is the call still there* (the mascot is
/// live, so a resting call shows the thin ring from across the room) and *how
/// do I get back* (tap it).
///
/// The mascot is the real `VoiceMascotView` at the dock's registration, scaled
/// to the board's 30×24 face rather than drawn as a bespoke mini. Every phase —
/// listening, thinking, talking, the resting ring — then works here for free and
/// cannot drift from the mascot the thread draws.
struct CallPill: View {
    /// The live display the mascot animates from — the engine's own provider,
    /// observed by the mascot and by nothing above it.
    let display: VoiceDisplayProvider
    /// The call session's name, as the switcher's row says it.
    let sessionTitle: String
    let onReturn: () -> Void

    /// Board 32's 40×32 slot with the 44×34 dock face scaled into it. The
    /// board's face is 30×24, and 30/44 is the scale that lands the eye row,
    /// the halo and every state accent there together.
    private static let faceWidth: CGFloat = 30
    private static let slot = CGSize(width: 40, height: 32)
    private var mascotScale: CGFloat { Self.faceWidth / MascotVariant.dock.metrics.face.width }

    var body: some View {
        Button(action: onReturn) {
            HStack(spacing: 10) {
                VoiceMascotView(display: display, variant: .dock)
                    .scaleEffect(mascotScale)
                    .frame(width: Self.slot.width, height: Self.slot.height)

                // `--text-label` 15 / 18 · 600 is board 32's own size, and the
                // one the resting chip takes for the same reason.
                Text(verbatim: label)
                    .textStyle(.label)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)
            }
            .padding(.leading, 12)
            .padding(.trailing, 18)
            .padding(.vertical, DS.Space.s2)
            .background(DS.Color.surface, in: Capsule())
            // Board 32's own float: `0 2 12 · 0.12`, with a hairline ring
            // standing in for the CSS `0 0 0 1px · 0.04` spread layer. Neither
            // is a level of the elevation scale — this is a control floating on
            // the canvas rather than a surface sitting on the screen, and the
            // board authored it — so the numbers are the board's, painted the
            // scale's way: one hue, `--color-shadow`, no x offset, blur halved
            // for SwiftUI's radius.
            .shadow(color: DS.Color.shadow.opacity(0.12), radius: 6, x: 0, y: 2)
            .overlay {
                Capsule().strokeBorder(DS.Color.shadow.opacity(0.04), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }

    /// **When the pill is on screen**, as a value: a call is live *and* it
    /// belongs to a session other than the one being looked at. Never with no
    /// call, and never in the call's own session — there the whole voice bar is
    /// on screen and a pill pointing at where you already are is noise.
    ///
    /// Stated here rather than inline in the screen so the rule can be read and
    /// tested on its own; `BoardScreen` mounts the pill on exactly this answer.
    static func isVisible(isLive: Bool, callSessionID: UUID?, visibleSessionID: UUID) -> Bool {
        guard isLive, let callSessionID else { return false }
        return callSessionID != visibleSessionID
    }

    /// Board 32's copy: the word, a middot, the session's name.
    var label: String { "Voice · " + displayTitle }

    var accessibilityLabel: String { "Return to voice call in " + displayTitle }

    /// An unnamed session — a call started before the first turn named it —
    /// still needs something to say.
    private var displayTitle: String {
        let trimmed = sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "this chat" : trimmed
    }
}

#if DEBUG
#Preview("Call pill · away from the session") {
    let engine = ScriptedVoiceEngine()
    let resting = VoiceDisplayProvider()
    resting.state = VoiceDisplayState(phase: .resting)
    return VStack(spacing: DS.Space.s6) {
        CallPill(display: engine.display, sessionTitle: "Fractions on a number line", onReturn: {})
        CallPill(display: resting, sessionTitle: "Long division", onReturn: {})
    }
    .padding(DS.Space.s10)
    .background(DS.Color.surfaceCanvas)
}
#endif
