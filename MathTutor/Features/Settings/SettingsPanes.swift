import SwiftUI

/// The right-hand side of the window: a pinned header, then whichever pane is showing.
///
/// The header is drawn here rather than inside each pane so the panes cannot disagree about
/// it — the whole point of `SettingsWindowMetrics.headerHeight` is that the rule under it
/// does not move, and a copy of the same `VStack` per pane is exactly how that drifts.
struct SettingsPaneContent: View {
    let pane: SettingsPane
    let metrics: SettingsWindowMetrics

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            paneBody(for: pane)
            Spacer(minLength: 0)
        }
        .padding(SettingsWindowMetrics.panePadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // `.contain` rather than a bare identifier: without it the identifier propagates to
        // every child, and the tree ends up with the heading, the lede and both rows all
        // answering to `settings-pane-tutor` — which makes any query for it ambiguous.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(pane.accessibilityIdentifier)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: pane.title)
                .textStyle(SettingsWindowMetrics.paneTitleStyle)
                .foregroundStyle(DS.Color.ink)
                .lineLimit(1)

            Text(verbatim: pane.lede)
                .textStyle(SettingsWindowMetrics.paneLedeStyle)
                .foregroundStyle(DS.Color.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, SettingsWindowMetrics.paneTitleGap)

            Spacer(minLength: 0)
        }
        .frame(
            width: metrics.paneContentWidth,
            height: SettingsWindowMetrics.headerHeight,
            alignment: .topLeading
        )
    }

    @ViewBuilder
    private func paneBody(for pane: SettingsPane) -> some View {
        switch pane {
        case .tutor: TutorPane(width: metrics.paneContentWidth)
        case .session: SessionPane(width: metrics.paneContentWidth)
        }
    }
}

// MARK: - Tutor

/// Three rows, and the whole of what the old screen spent nine cards on.
struct TutorPane: View {
    @EnvironmentObject private var store: TutorStore
    let width: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingPickerRow(
                label: SettingsCopy.modelLabel,
                caption: SettingsCopy.modelCaption,
                options: SettingsOption.models(selected: store.session.selectedModel),
                width: width,
                identifierPrefix: "model-option",
                select: store.setModel
            )

            SettingPickerRow(
                label: SettingsCopy.effortLabel,
                caption: SettingsCopy.effortCaption,
                options: SettingsOption.efforts(
                    for: store.session.selectedModel,
                    selected: store.session.reasoningEffort
                ),
                width: width,
                identifierPrefix: "effort-option",
                select: store.setReasoningEffort
            )

            // Last of the three, so the two rows that decide how the tutor
            // *thinks* stay adjacent and the one that decides how it *speaks*
            // sits under them — the order the pane's lede reads in.
            SettingPickerRow(
                label: SettingsCopy.voiceModelLabel,
                caption: SettingsCopy.voiceModelCaption,
                options: SettingsOption.voiceModels(selected: store.session.selectedVoiceModel),
                width: width,
                identifierPrefix: "voice-model-option",
                select: store.setVoiceModel
            )
        }
    }
}

// MARK: - Session

/// One action, and the sentence that says what it will and will not touch.
struct SessionPane: View {
    @EnvironmentObject private var store: TutorStore
    let width: CGFloat

    var body: some View {
        SettingsPaneBody(width: width) {
            DestructiveButton(title: SettingsCopy.resetSession, action: store.resetSession)
                .accessibilityIdentifier("reset-session")
        }
    }
}

// MARK: - Shared

/// The rule-and-stack a pane made of controls sits in.
///
/// `TutorPane` does not use it: its rows draw their own top rule, so wrapping them in another
/// one would double the hairline under the header. That asymmetry is the design's — a row
/// carries its rule because rows repeat, and a stack of controls carries one because it does
/// not repeat.
struct SettingsPaneBody<Content: View>: View {
    let width: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: SettingsWindowMetrics.paneBodyGap) {
            content()
        }
        .padding(.top, SettingsWindowMetrics.paneBodyGap)
        .frame(width: width, alignment: .topLeading)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(SettingRowMetrics.rule)
                .frame(height: SettingRowMetrics.ruleWidth)
        }
    }
}
