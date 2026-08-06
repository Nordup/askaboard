#if DEBUG
import SwiftUI

/// Every chat component, in every state the design draws, at both scales.
///
/// This exists to be diffed against the Paper boards: each specimen carries the name the
/// design gives it and the size the design measures, so a mismatch is a caption to read
/// rather than a ruler to hold up. It is deliberately not wired into the app — navigation
/// belongs to the feature layer, and a gallery that ships is a gallery that drifts.
struct ChatGallery: View {
    @State private var panelText = ""
    @State private var fullScreenText = ""
    @State private var filledText = "is my (x, y) label right?"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 44) {
                section("01 · Composer") {
                    specimen("Composer · panel, plain", "301 × 58", on: DS.Color.surfacePanel) {
                        Composer(scale: .panel, text: $panelText, onSend: {}, onVoice: {})
                    }
                    specimen("Composer · panel, no board in reach", "301 × 58", on: DS.Color.surfacePanel) {
                        Composer(scale: .panel, text: $panelText, selection: .unavailable, onSend: {})
                    }
                    specimen("Composer · panel, filled", "301 × 58", on: DS.Color.surfacePanel) {
                        Composer(scale: .panel, text: $filledText, onSend: {}, onVoice: {})
                    }
                    specimen(
                        "Composer · panel, capturing",
                        "301 × 58 — ui/level + elapsed in the text lane, ui/cross leading",
                        on: DS.Color.surfacePanel
                    ) {
                        Composer(
                            scale: .panel,
                            text: $panelText,
                            onSend: {},
                            onVoice: {},
                            // A specimen holds still: the live meter is driven by a microphone
                            // no gallery has.
                            dictation: ComposerDictation(phase: .capturing, startedAt: .now, level: { 0.6 })
                        )
                    }
                    specimen(
                        "Composer · panel, transcribing",
                        "301 × 58 — state/thinking + \"Transcribing…\"",
                        on: DS.Color.surfacePanel
                    ) {
                        Composer(
                            scale: .panel,
                            text: $panelText,
                            onSend: {},
                            onVoice: {},
                            dictation: ComposerDictation(phase: .transcribing, startedAt: .now)
                        )
                    }
                    specimen(
                        "Composer · panel, partial text arriving",
                        "301 × 58 — the words, trailed by state/streaming",
                        on: DS.Color.surfacePanel
                    ) {
                        Composer(
                            scale: .panel,
                            text: $filledText,
                            onSend: {},
                            onVoice: {},
                            dictation: ComposerDictation(phase: .transcribing, startedAt: .now)
                        )
                    }
                    specimen(
                        "Composer · panel, nothing came back",
                        "301 × 58 — one 15/18 line in the band above the pill",
                        on: DS.Color.surfacePanel
                    ) {
                        Composer(
                            scale: .panel,
                            text: $panelText,
                            onSend: {},
                            onVoice: {},
                            // The copy itself belongs to `DictationNote`, a layer up; the
                            // component only knows it draws one line.
                            note: "I didn't catch anything that time."
                        )
                    }
                    specimen("Composer · panel, with attached selection", "301 × 96", on: DS.Color.surfacePanel) {
                        Composer(
                            scale: .panel,
                            text: $panelText,
                            selection: .attached,
                            onSend: {},
                            onVoice: {},
                            onDismissSelection: {}
                        )
                    }
                    specimen("Composer · full-screen wide", "740 × 80", on: DS.Color.surface) {
                        Composer(scale: .fullScreen, text: $fullScreenText, onSend: {}, onVoice: {})
                    }
                    specimen(
                        "Composer · full-screen, attached (extrapolated)",
                        "740 × 118 — card 740 × 78, radius 40",
                        on: DS.Color.surface
                    ) {
                        Composer(
                            scale: .fullScreen,
                            text: $fullScreenText,
                            selection: .attached,
                            onSend: {},
                            onVoice: {},
                            onDismissSelection: {}
                        )
                    }
                }

                section("02 · Attached selection") {
                    specimen("Attached context — card", "301 × 67", on: DS.Color.surfacePanel) {
                        SelectionCard(
                            metrics: .composer(.panel),
                            label: SelectionCard.composerLabel,
                            onDismiss: {}
                        )
                    }
                    specimen("Selection cap — sent message", "224 × 67", on: DS.Color.surfacePanel) {
                        SelectionCard(metrics: .sentMessage, label: SelectionCard.sentLabel)
                    }
                }

                section("03 · Messages") {
                    specimen("msg/tutor · plain", "301 × 75", on: DS.Color.surfacePanel) {
                        TutorMessageText(markdown: Fixtures.tutorThreeLines)
                            .frame(width: DS.Container.panelContent)
                    }
                    specimen("msg/tutor · with emoji", "301 × 50", on: DS.Color.surfacePanel) {
                        TutorMessageText(markdown: Fixtures.tutorEmoji)
                            .frame(width: DS.Container.panelContent)
                    }
                    specimen("msg/student · short", "bubble hugs, max 224 — 49 at one line", on: DS.Color.surfacePanel) {
                        MessageRow(item: ChatThreadItem(Fixtures.learner("ok")))
                    }
                    specimen("msg/student · two lines", "224 × 74", on: DS.Color.surfacePanel) {
                        MessageRow(item: ChatThreadItem(Fixtures.learner("why does the arrow start at 0?")))
                    }
                    specimen("msg/student · with selection", "stack 224 × 96", on: DS.Color.surfacePanel) {
                        MessageRow(
                            item: ChatThreadItem(Fixtures.learner("is my (x, y) label right?"), hasSelection: true)
                        )
                    }
                }

                section("14 · Tutor states") {
                    specimen("state/thinking · bare dots", "auto × 25", on: DS.Color.surfacePanel) {
                        ThinkingIndicator()
                    }
                    specimen("state/thinking · with status line", "auto × 47", on: DS.Color.surfacePanel) {
                        ThinkingIndicator(status: "Reading your board")
                    }
                    specimen("state/streaming · caret", "2 × 22 in a 25 line box", on: DS.Color.surfacePanel) {
                        HStack(spacing: 2) {
                            Text(verbatim: "A vector in 2D has two components")
                                .textStyle(.body)
                                .foregroundStyle(DS.Color.ink)
                            StreamingCaret()
                        }
                    }
                    specimen("state/error · network", "301 × 151", on: DS.Color.surfacePanel) {
                        ChatErrorState.network(onRetry: {})
                    }
                }

                section("04 · Thread") {
                    specimen("Thread", "301 × 810 — gap 22, padding-bottom 18", on: DS.Color.surfacePanel) {
                        MessageThread(items: Fixtures.thread)
                            .frame(height: 810)
                    }
                }

                section("05 · Scroll fade") {
                    // The board's own "Fade demo": three messages behind the fade, so the
                    // ramp can be checked against the panel colour it has to match.
                    specimen("Scroll fade", "301 × 72, over the thread", on: DS.Color.surfacePanel) {
                        MessageThread(items: Array(Fixtures.thread.prefix(3)))
                            .frame(height: 200)
                    }
                }

                section("06 · Suggestion chips") {
                    specimen("chip · panel", "301 × 62", on: DS.Color.surfacePanel) {
                        SuggestionChip(suggestion: .explain, scale: .panel) {}
                    }
                    specimen("Suggestions · panel", "301 × 278 — gap 10", on: DS.Color.surfacePanel) {
                        SuggestionList(scale: .panel) { _ in }
                    }
                    specimen("chip · full-screen", "360 × 74", on: DS.Color.surface) {
                        SuggestionChip(suggestion: .explain, scale: .fullScreen) {}
                    }
                    specimen("Suggestions · full-screen", "740 × 168 — 2 × 2, gap 20", on: DS.Color.surface) {
                        SuggestionList(scale: .fullScreen) { _ in }
                    }
                }

                section("08 · Greeting blocks") {
                    specimen("Greeting · panel", "301 × 522 incl. chips + 120", on: DS.Color.surfacePanel) {
                        GreetingBlock(scale: .panel)
                    }
                    specimen("Greeting · full-screen", "740 × 268 — orb slot 150 × 142", on: DS.Color.surface) {
                        GreetingBlock(scale: .fullScreen) {
                            // The orb belongs to the shell; the slot is drawn as a slot.
                            RoundedRectangle(cornerRadius: DS.Radius.lg)
                                .strokeBorder(DS.Color.divider, lineWidth: 1)
                        }
                    }
                }
            }
            .padding(44)
        }
        .background(DS.Color.surfaceScreen)
    }

    // MARK: - Documentation chrome

    /// The 44pt plate the boards lay every specimen on. Board 03: *"The 44pt stage padding
    /// is documentation chrome — it is not part of any component."*
    private func specimen(
        _ name: String,
        _ size: String,
        on surface: Color,
        @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.s2) {
            content()
                .padding(44)
                .background(surface, in: RoundedRectangle(cornerRadius: DS.Radius.xxl, style: .circular))

            Text(verbatim: "\(name)  ·  \(size)")
                .textStyle(.label)
                .foregroundStyle(DS.Color.inkSecondary)
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.s6) {
            Text(verbatim: title)
                .textStyle(.title)
                .foregroundStyle(DS.Color.ink)
            content()
        }
    }
}

/// Screen 08's thread, verbatim. Using anything else makes a visual diff meaningless: a
/// different line break moves every element below it.
private enum Fixtures {
    static let tutorEmoji = "Great start! 🎉 A vector in 2D has two components — x and y."
    static let tutorThreeLines = """
        It doesn't have to. Starting at the origin is just standard position — slide it \
        anywhere and it's the same vector.
        """

    static func learner(_ text: String) -> TutorMessage {
        TutorMessage(role: .learner, text: text)
    }

    static func tutor(_ text: String) -> TutorMessage {
        TutorMessage(role: .tutor, text: text)
    }

    static let thread: [ChatThreadItem] = [
        ChatThreadItem(tutor("Welcome back — let's pick up where we left off with vectors.")),
        ChatThreadItem(learner("ok")),
        ChatThreadItem(tutor("Draw a pair of axes and one arrow from the origin, then I'll take a look.")),
        ChatThreadItem(learner("done")),
        ChatThreadItem(tutor(tutorEmoji)),
        ChatThreadItem(learner("why does the arrow start at 0?")),
        ChatThreadItem(tutor(tutorThreeLines)),
        ChatThreadItem(learner("is my (x, y) label right?"), hasSelection: true),
        ChatThreadItem(tutor("Yes — that point is the head of the vector, so (x, y) are exactly its components.")),
    ]
}

#Preview("Chat gallery") {
    ChatGallery()
}
#endif
