import SwiftUI

/// The right-hand side of the window: a pinned header, then whichever pane is showing.
///
/// The header is drawn here rather than inside each pane so the three panes cannot disagree
/// about it — the whole point of `SettingsWindowMetrics.headerHeight` is that the rule under
/// it does not move, and three copies of the same `VStack` is exactly how that drifts.
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
        case .apiKey: APIKeyPane(width: metrics.paneContentWidth)
        case .session: SessionPane(width: metrics.paneContentWidth)
        }
    }
}

// MARK: - Tutor

/// Two rows, and the whole of what the old screen spent nine cards on.
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
                options: SettingsOption.efforts(selected: store.session.reasoningEffort),
                width: width,
                identifierPrefix: "effort-option",
                select: store.setReasoningEffort
            )
        }
    }
}

// MARK: - API key

/// The stored key, the way to swap it, and the way to be rid of it.
///
/// `Remove API key` lives here rather than in a shared "Irreversible" group because removing
/// a key is part of owning one — see `SettingsPane`. The warning the old group carried in a
/// shared caption is in this pane's lede instead, in this pane's terms.
struct APIKeyPane: View {
    @EnvironmentObject private var store: TutorStore
    let width: CGFloat

    /// Transient. The typed key lives here only until it reaches the Keychain.
    @State private var draft = ""
    /// The masked form of the stored key. Only the mask is held; the key itself is read
    /// once, converted, and dropped.
    @State private var storedMask: String?

    var body: some View {
        SettingsPaneBody(width: width) {
            KeyField(draft: $draft, storedMask: storedMask, width: width, onSave: save)

            DestructiveButton(title: SettingsCopy.removeKey, action: remove)
                .accessibilityIdentifier("remove-api-key")
        }
        .task { storedMask = currentMask() }
    }

    /// Reads the stored key once, converts it to the mask, and lets it go. Nothing else in
    /// this view ever holds the key, and it is never written anywhere but the Keychain.
    private func currentMask() -> String? {
        guard let key = store.keychain.readAPIKey()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !key.isEmpty else { return nil }
        return APIKeyMask.masked(key)
    }

    private func save() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty save is not a designed action and `saveAPIKey("")` would remove the key —
        // which is what `Remove API key` directly below is for. Decline instead.
        guard !trimmed.isEmpty else { return }
        guard store.saveAPIKey(trimmed) else { return }
        // Derived from the value already in hand rather than by reading the Keychain back.
        storedMask = APIKeyMask.masked(trimmed)
        draft = ""
    }

    private func remove() {
        guard store.removeAPIKey() else { return }
        storedMask = nil
        draft = ""
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
