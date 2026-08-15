import SwiftUI

/// *"Send is the only filled brand-colour object in the chat surface, which is what lets it
/// hold its own inside a white pill without a border."*
struct ComposerSendButton: View {
    let metrics: ComposerMetrics
    let action: () -> Void

    var body: some View {
        Button(action: action) { disc }
            .buttonStyle(.plain)
            .accessibilityLabel("Send message")
    }

    @ViewBuilder
    private var disc: some View {
        let shape = IconView(.composerSend, size: metrics.sendGlyphSize)
            .frame(width: metrics.sendButtonSize, height: metrics.sendButtonSize)
            .background(DS.Color.brand, in: Circle())

        // The 56pt button's `#1414320F 0 2 6, #1414320A 0 1 2` is 03 Control's geometry at
        // two alphas Foundations does not define — a fourth shadow, flagged by the board as
        // unresolved. It is drawn as 03 Control rather than added to the scale: same
        // offsets and blurs, and the alphas differ by 0.008 and 0.009 over a near-white
        // surface. The 42pt button carries no shadow at all, which is a stated difference
        // rather than an omission.
        if metrics.sendIsRaised {
            shape.elevation(.control)
        } else {
            shape
        }
    }
}

/// A bare hit area around a glyph — no fill and no radius, exactly as drawn. Board 03 §11.3
/// asks whether it should get a shape; until it does, it does not have one.
///
/// **The glyph never changes.** Board 15 puts every dictation state in the composer's *text
/// lane* — the meter while capturing, the dots and the word while transcribing — and leaves the
/// mic's geometry and its mark alone in all of them. An earlier build put the state in this
/// button's slot on the grounds that the composer had no level meter; it has one now, and that
/// justification is void.
struct ComposerVoiceButton: View {
    let metrics: ComposerMetrics
    /// The phase of the session this button is the stop control for, or `nil` when idle. It
    /// changes what the button *says*, never what it draws.
    var dictation: DictationPhase?
    let action: () -> Void

    /// Apple's model: the label is the control's identity and does not move, the value is its
    /// state. A label that flips between "Dictate" and "Stop" renames the control mid-gesture,
    /// which is the documented anti-pattern.
    static let label = "Dictate"

    var body: some View {
        Button(action: action) {
            IconView(.composerVoice, size: metrics.voiceGlyphSize)
                .frame(width: metrics.voiceButtonSize, height: metrics.voiceButtonSize)
                // The panel's mic is drawn at 38, which is under Apple's stated 44 default.
                // The drawn box is the design's and does not move; the target overhangs it,
                // the same way the rail's controls already do.
                .expandedTapTarget(max(ComposerMetrics.minimumTapTarget, metrics.voiceButtonSize), over: metrics.voiceButtonSize)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Self.label)
        .accessibilityValue(Self.value(for: dictation))
        // `.isToggle` says one control with two states, which is what this is.
        // `.startsMediaSession` is not a nicety: without it VoiceOver speaks its own
        // announcement into the microphone this button just opened. Apple's documentation
        // example for the trait is literally this case.
        .accessibilityAddTraits(dictation == nil ? [.isToggle, .startsMediaSession] : [.isToggle])
        // Two-finger double tap already means "start or stop a recording" to every VoiceOver
        // user. Unwired, UIKit falls through to Music play/pause.
        .accessibilityAction(.magicTap, action)
    }

    static func value(for dictation: DictationPhase?) -> String {
        switch dictation {
        case nil: ""
        case .capturing: "Recording"
        case .transcribing: "Transcribing"
        }
    }
}

/// The cancel that dictation needs and the composer's resting state does not.
///
/// Board 15 puts it in the leading slot — the marquee's slot, which is meaningless while the
/// microphone is open — so **nothing on screen moves when a session starts**. Its meaning
/// follows the phase: during capture it discards the recording, during transcription it drops
/// the request and the audio. Typed text survives either way.
///
/// No slide-to-cancel: a path gesture fails WCAG 2.5.1, and dragging fails 2.5.7. No
/// confirmation either — Apple's own rule is *"don't warn people when data loss is the expected
/// result of their action"*, and the consequential act here is send, not discard.
struct ComposerCancelButton: View {
    let metrics: ComposerMetrics
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            IconView(.uiCross, size: metrics.cancelGlyphSize)
                // The hit area overhangs the visual slot rather than widening it: 44 is
                // Apple's stated default target and the row's arithmetic must not change.
                .frame(width: ComposerMetrics.minimumTapTarget, height: ComposerMetrics.minimumTapTarget)
                .contentShape(Rectangle())
                // Height as well as width. The overhang is in both directions, and the pill
                // measures its own row now — an unbounded 44 here would make the composer 6
                // points taller for as long as the microphone is open, which is exactly the
                // "nothing on screen moves when a session starts" this slot exists to keep.
                .frame(width: metrics.marqueeSize, height: metrics.marqueeSize, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Cancel dictation")
    }
}

// MARK: - Voice chat (boards 27 and 28)

/// Board 27's four-bar waveform, drawn in `composer/send`'s own 24-unit space:
/// bars at x 5.2 / 9.7 / 14.3 / 18.8 spanning 10–14, 7.4–16.6, 5.6–18.4 and
/// 9.2–14.8, stroke 2.4 with round caps — white on the brand disc, exactly as
/// the send arrow is. The stroke scales with the render size the way the icon
/// set's do: design width × (render ÷ viewBox).
struct VoiceWaveformGlyph: View {
    let size: CGFloat

    private static let bars: [(x: CGFloat, top: CGFloat, bottom: CGFloat)] = [
        (5.2, 10.0, 14.0), (9.7, 7.4, 16.6), (14.3, 5.6, 18.4), (18.8, 9.2, 14.8)
    ]

    var body: some View {
        let scale = size / 24
        Path { path in
            for bar in Self.bars {
                path.move(to: CGPoint(x: bar.x * scale, y: bar.top * scale))
                path.addLine(to: CGPoint(x: bar.x * scale, y: bar.bottom * scale))
            }
        }
        .stroke(DS.Color.surface, style: StrokeStyle(lineWidth: 2.4 * scale, lineCap: .round))
        .frame(width: size, height: size)
    }
}

/// Board 27: the voice-chat disc in the send slot — the same brand disc at the
/// same metrics, carrying the white waveform instead of the arrow. It appears
/// only while there is nothing to send (`Composer.showsVoiceChatDisc`), so the
/// slot is one disc with two meanings and the row's arithmetic never moves.
struct ComposerVoiceChatButton: View {
    let metrics: ComposerMetrics
    let action: () -> Void

    var body: some View {
        Button(action: action) { disc }
            .buttonStyle(.plain)
            .accessibilityLabel("Voice chat")
            // The dictation mic's reasoning, verbatim: without the trait
            // VoiceOver speaks its own announcement into the call this button
            // just opened.
            .accessibilityAddTraits(.startsMediaSession)
    }

    @ViewBuilder
    private var disc: some View {
        let shape = VoiceWaveformGlyph(size: metrics.sendGlyphSize)
            .frame(width: metrics.sendButtonSize, height: metrics.sendButtonSize)
            .background(DS.Color.brand, in: Circle())

        // The raised full-screen disc is the send button's own rule; this disc
        // occupies the same slot, so it casts the same shadow there and none
        // in the panel.
        if metrics.sendIsRaised {
            shape.elevation(.control)
        } else {
            shape
        }
    }
}

/// The voice bar's mic — board 28's control in the dictation mic's box, with a
/// different job: it mutes the call's uplink rather than opening a recorder.
/// Same glyph, same geometry, so nothing on the pill moves when a call starts.
///
/// The muted state is undrawn on the boards, so it borrows the composer's one
/// state vocabulary — violet means lit — and a muted mic reads the way an
/// armed marquee does. Label and value follow Apple's model exactly as the
/// dictation mic's do: the label is the control's identity, the value its
/// state.
struct ComposerVoiceMuteButton: View {
    let metrics: ComposerMetrics
    let isMuted: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            IconView(
                .composerVoice,
                size: metrics.voiceGlyphSize,
                tint: isMuted ? DS.Color.brand : DS.Color.icon
            )
            .frame(width: metrics.voiceButtonSize, height: metrics.voiceButtonSize)
            .expandedTapTarget(
                max(ComposerMetrics.minimumTapTarget, metrics.voiceButtonSize),
                over: metrics.voiceButtonSize
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Microphone")
        .accessibilityValue(isMuted ? "Muted" : "On")
        .accessibilityAddTraits(.isToggle)
    }
}

/// Board 28's end disc: the send disc's geometry filled `--color-ink`, with
/// the white cross at the cancel glyph's own size. Dark ink rather than a red
/// hang-up, because ending is ordinary here — the session stays open and
/// voice is a mode within it, not a session of its own.
struct ComposerVoiceEndButton: View {
    let metrics: ComposerMetrics
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            IconView(.uiCross, size: metrics.sendGlyphSize, tint: DS.Color.surface)
                .frame(width: metrics.sendButtonSize, height: metrics.sendButtonSize)
                .background(DS.Color.ink, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("End voice chat")
    }
}
