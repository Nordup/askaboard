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

/// The stored token, the server it is sent to, the way to swap either, and the way to be rid
/// of the token.
///
/// `Remove API key` lives here rather than in a shared "Irreversible" group because removing
/// a key is part of owning one — see `SettingsPane`. The warning the old group carried in a
/// shared caption is in this pane's lede instead, in this pane's terms.
///
/// The base-URL field is new with client-migration Task 6 and has no board of its own —
/// `BaseURLField`'s own doc comment says why it borrows `KeyField`'s box rather than
/// inventing a second visual language for one more field.
struct APIKeyPane: View {
    @EnvironmentObject private var store: TutorStore
    let width: CGFloat

    /// Transient. The typed token lives here only until it reaches the Keychain.
    @State private var tokenDraft = ""
    /// The masked form of the stored token. Only the mask is held; the token itself is read
    /// once, converted, and dropped.
    @State private var storedTokenMask: String?

    /// Transient, and — unlike the token — prefilled with the stored value directly. A base
    /// URL is not a secret, so there is nothing here that needs the mask-then-drop treatment
    /// `storedTokenMask` exists for.
    @State private var baseURLDraft = ""

    var body: some View {
        SettingsPaneBody(width: width) {
            BaseURLField(draft: $baseURLDraft, width: width, onSave: saveBaseURL)

            KeyField(draft: $tokenDraft, storedMask: storedTokenMask, width: width, onSave: saveToken)

            DestructiveButton(title: SettingsCopy.removeKey, action: removeToken)
                .accessibilityIdentifier("remove-api-key")
        }
        .task {
            storedTokenMask = currentMask()
            baseURLDraft = store.defaults.string(forKey: BackendConfiguration.baseURLDefaultsKey) ?? ""
        }
    }

    /// Reads the stored token once, converts it to the mask, and lets it go. Nothing else in
    /// this view ever holds the token, and it is never written anywhere but the Keychain.
    private func currentMask() -> String? {
        guard let token = store.keychain.readBackendToken()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty else { return nil }
        return APIKeyMask.masked(token)
    }

    private func saveToken() {
        let trimmed = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty save is not a designed action and `saveBackendToken("")` would remove the
        // token — which is what `Remove API key` directly below is for. Decline instead.
        guard !trimmed.isEmpty else { return }
        guard store.saveBackendToken(trimmed) else { return }
        // Derived from the value already in hand rather than by reading the Keychain back.
        storedTokenMask = APIKeyMask.masked(trimmed)
        tokenDraft = ""
    }

    private func removeToken() {
        guard store.removeBackendToken() else { return }
        storedTokenMask = nil
        tokenDraft = ""
    }

    private func saveBaseURL() {
        let trimmed = baseURLDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard store.saveBaseURL(trimmed) else { return }
        // Normalized to what actually got stored, the same way `saveToken` derives its mask
        // from the value already in hand rather than reading the store back.
        baseURLDraft = trimmed
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
