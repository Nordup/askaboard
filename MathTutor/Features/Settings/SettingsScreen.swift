import SwiftUI

/// Board 10's region map, as arithmetic rather than as nine absolute numbers.
///
/// Every `y` below is a running sum of the block above it plus a stated gap, so a section
/// that grows moves the ones under it the way the board's own layout does. The absolute
/// values the board measures (124 / 220 / 392 / 670 / 850) fall out of the chain and are
/// asserted in `SettingsAndPlanTests`.
struct SettingsScreenMetrics: Equatable, Sendable {
    /// **`#FFFFFF` literal, not `--color-surface-screen`.** The same exception board 07
    /// takes: the full-screen tutor states drop the screen grey because there is no panel
    /// left to lift off it.
    static let ground = DS.Color.surface

    /// Board 10 *"is the full-screen tutor layout (board 07's shell) with its reading content
    /// replaced"*, so its column is screen 07's column — the same `ScreenLayout` lanes, read
    /// off the screen the app is on rather than off the one the board was drawn on.
    let columnX: CGFloat
    let columnWidth: CGFloat
    let contentTop: CGFloat
    /// The band the board peek spans — board 10 reuses screen 07's `68 × 936` peek verbatim.
    /// It is a height now rather than a constant inside the component, because the peek's
    /// silhouette is re-authored at whatever band it is drawn in.
    let contentHeight: CGFloat
    /// Where the safe band ends, which is what `unusedSlack` is measured back from.
    let bandBottom: CGFloat

    init(layout: ScreenLayout) {
        columnX = layout.columnX
        columnWidth = layout.columnWidth
        contentTop = layout.contentTop
        contentHeight = layout.contentHeight
        bandBottom = layout.contentBottom
    }

    /// The board's own screen, which is what every published number below was measured on.
    static let reference = SettingsScreenMetrics(layout: .reference)

    /// The reduced panel-controls row: `btn/dock` alone, the only exit. Height and button
    /// size are the panel's own — only the row's membership changes.
    static let controlsHeight = TutorPanelMetrics.controlsHeight
    static let controlButton = TutorPanelMetrics.controlButton
    static let controlTapTarget = TutorPanelMetrics.controlTapTarget

    static let titleTopMargin = DS.Space.gap
    static let titleStyle: DS.TextStyle = .display
    static let titleHeight = DS.Leading.display

    /// Shared by all four sections.
    static let headingStyle: DS.TextStyle = .label
    static let headingHeight = DS.Leading.label
    /// 15 / 18 at weight 400 — the label size and line box, but running copy, so regular.
    static let captionStyle = TextStyle(size: DS.Size.label, leading: DS.Leading.label, weight: .regular)
    static let captionTopMargin = DS.Space.s1
    /// Heading (or caption) → the section's controls.
    static let bodyTopMargin = DS.Space.s4

    static let sectionGap = DS.Space.s12
    /// **The board measures 44 here, not 48**, and every other gap on the screen is 48.
    /// `06 §Open questions 8` calls it *"an off-by-4 rather than a decision"* and recommends
    /// 48 throughout, but it is recorded as measured rather than silently corrected — the
    /// same discipline the rail's 627.5 and the icon anomalies get. Content stops at 962
    /// with 42pt of safe band spare, so nothing is forcing the tighter gap.
    static let lastSectionGap: CGFloat = 44

    // MARK: - Section heights

    /// `18 + 16 + 90 = 124`.
    static var modelSectionHeight: CGFloat {
        headingHeight + bodyTopMargin + SelectOptionMetrics.size.height
    }

    /// `18 + 16 + 196 = 230`.
    static var effortSectionHeight: CGFloat {
        headingHeight + bodyTopMargin + SelectOptionMetrics.gridHeight(rows: 2)
    }

    /// `18 + 4 + 18 + 16 + 80 = 136`.
    static var keySectionHeight: CGFloat {
        headingHeight + captionTopMargin + captionStyle.leading + bodyTopMargin + KeyFieldMetrics.height
    }

    /// `18 + 4 + 18 + 16 + 56 = 112`.
    static var irreversibleSectionHeight: CGFloat {
        headingHeight + captionTopMargin + captionStyle.leading + bodyTopMargin
            + DestructiveButtonMetrics.height
    }

    // MARK: - Absolute positions

    /// The chain is unchanged and still adds up the same way; only its first term is now the
    /// content top of the screen the app is on. On the board's own screen that is 68 and every
    /// number below is the one board 10 measures.

    /// `68 + 32 + 24 = 124`.
    var titleY: CGFloat { contentTop + Self.controlsHeight + Self.titleTopMargin }
    /// `124 + 48 + 48 = 220`.
    var modelSectionY: CGFloat { titleY + Self.titleHeight + Self.sectionGap }
    /// `220 + 124 + 48 = 392`.
    var effortSectionY: CGFloat { modelSectionY + Self.modelSectionHeight + Self.sectionGap }
    /// `392 + 230 + 48 = 670`.
    var keySectionY: CGFloat { effortSectionY + Self.effortSectionHeight + Self.sectionGap }
    /// `670 + 136 + 44 = 850`.
    var irreversibleSectionY: CGFloat {
        keySectionY + Self.keySectionHeight + Self.lastSectionGap
    }
    /// `850 + 112 = 962`.
    var contentBottom: CGFloat { irreversibleSectionY + Self.irreversibleSectionHeight }
    /// `1004 − 962 = 42`. *"This screen is top-aligned, not stretched."*
    ///
    /// It is the one number here that a smaller screen can spend: the column is top-aligned
    /// and its content is a fixed 838pt chain, so a short band eats the slack and then runs
    /// past the bottom — see `SettingsScreen`, which scrolls at exactly that point.
    var unusedSlack: CGFloat { bandBottom - contentBottom }

    /// The chain's own height, independent of where the band starts: `962 − 68 = 894`.
    var columnHeight: CGFloat { contentBottom - contentTop }
}

/// Board 10's literal copy.
enum SettingsCopy {
    static let title = "Settings"
    static let modelHeading = "Tutor model"
    static let effortHeading = "Reasoning effort"
    static let keyHeading = "OpenAI API key"
    /// The accurate one of the two storage promises in the file — see `NoAPIKeyCopy`.
    static let keyCaption = "Kept in this device's Keychain. It is sent to OpenAI and nowhere else."
    static let irreversibleHeading = "Irreversible"
    static let irreversibleCaption =
        "Both take effect immediately and cannot be undone. Neither one touches your board or its ink."
    static let removeKey = "Remove API key"
    static let resetSession = "Reset this session"
}

/// Settings, as a screen rather than a sheet.
///
/// Board 10: *"It is **not a modal and not a sheet** — it is the full-screen tutor layout
/// (board 07's shell) with its reading content replaced."* A sheet would introduce the one
/// container type this system does not own: everything else separates by elevation, and
/// a sheet is a card with an edge. So the ground is white, the board peek stays pinned
/// flush left as the way back, and the panel-controls row collapses to a single `btn/dock`.
///
/// The screen owns its own back affordance, which is why it takes no parameters. `onClose`
/// is defaulted rather than required so `SettingsScreen()` is the whole call site; when it
/// is not supplied the environment's `dismiss` runs, which covers a `fullScreenCover` or a
/// navigation push without this view having to know which one it got.
struct SettingsScreen: View {
    @EnvironmentObject private var store: TutorStore
    @Environment(\.dismiss) private var dismiss
    /// Every region on this screen comes out of the same measurement the board's do — this is
    /// board 07's shell with its reading content replaced, so it has board 07's column and
    /// board 07's band. A `fullScreenCover` inherits the environment of the view that
    /// presented it, which is `BoardScreen`, which is where the layout was published.
    @Environment(\.screenLayout) private var layout

    private var metrics: SettingsScreenMetrics { SettingsScreenMetrics(layout: layout) }

    private let onClose: (() -> Void)?

    /// Transient. The typed key lives here only until it reaches the Keychain.
    @State private var keyDraft = ""
    /// The masked form of the stored key. Only the mask is held; the key itself is read
    /// once, converted, and dropped.
    @State private var storedMask: String?

    init(onClose: (() -> Void)? = nil) {
        self.onClose = onClose
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            SettingsScreenMetrics.ground.ignoresSafeArea()

            // Flush left, no 28 inset — *"the way back"*, and the only board affordance here.
            BoardPeek(height: metrics.contentHeight, onTap: close)
                .offset(x: layout.peekX, y: metrics.contentTop)

            // Board 10 is *"top-aligned, not stretched"*, and on the design's screen the chain
            // stops 42 points short of the band. On a shorter one — a 768pt iPad leaves 692
            // against an 894pt chain — the last section would be below the glass with no way to
            // reach it, so the band scrolls, exactly as the tool rail does when its own fixed
            // chain outgrows it.
            //
            // Only then, though. A scroll view clips to its bounds, and the option row is
            // exactly its column wide with `shadow/card` bleeding past both ends of it, so a
            // screen that fits keeps its shadows by not being inside one.
            if metrics.unusedSlack < 0 {
                ScrollView(.vertical) {
                    column.frame(height: metrics.columnHeight, alignment: .topLeading)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(width: metrics.columnWidth, height: metrics.contentHeight)
                .offset(x: metrics.columnX, y: metrics.contentTop)
            } else {
                column.offset(x: metrics.columnX, y: metrics.contentTop)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .ignoresSafeArea()
        // Board 10 reuses screen 05's band verbatim, and this screen used to draw it
        // unconditionally. It does not ship: iPadOS draws the real one now, and this is the
        // fixture-only path `StatusBar` documents itself as being. A `fullScreenCover` covers
        // the root's own overlay, so the decision has to be taken again here — the alternative
        // is a fixture screenshot of Settings with no band on it at all.
        .fixtureStatusBar(isEnabled: Self.drawsFixtureStatusBar, width: layout.screenWidth)
        // A full-screen presentation owns the status bar for as long as it is up, so the root's
        // answer does not carry into it. `false` everywhere else is the shipping answer stated
        // out loud rather than left to a default — and in a release build it is the only value
        // this expression can take, so nothing can hide the real bar.
        .statusBarHidden(Self.drawsFixtureStatusBar)
        .task { storedMask = currentMask() }
    }

    /// True only under `--ui-fixture`, and only in a build that has the flag at all.
    private static var drawsFixtureStatusBar: Bool {
        #if DEBUG
        LaunchOptions.current.usesFixtureCopy
        #else
        false
        #endif
    }

    // MARK: - The column

    private var column: some View {
        VStack(alignment: .leading, spacing: 0) {
            controls

            Text(verbatim: SettingsCopy.title)
                .textStyle(SettingsScreenMetrics.titleStyle)
                .foregroundStyle(DS.Color.ink)
                .frame(
                    width: metrics.columnWidth,
                    height: SettingsScreenMetrics.titleHeight,
                    alignment: .leading
                )
                .padding(.top, SettingsScreenMetrics.titleTopMargin)

            modelSection.padding(.top, SettingsScreenMetrics.sectionGap)
            effortSection.padding(.top, SettingsScreenMetrics.sectionGap)
            keySection.padding(.top, SettingsScreenMetrics.sectionGap)
            irreversibleSection.padding(.top, SettingsScreenMetrics.lastSectionGap)
        }
        .frame(width: metrics.columnWidth, alignment: .topLeading)
    }

    /// `Panel controls`, reduced variant: `btn/dock` only, `justify-content: flex-start`.
    /// `btn/full-screen` and `btn/settings` are absent — there is nowhere else to go from
    /// here, and the settings button would point at the screen you are on.
    private var controls: some View {
        Button(action: close) {
            IconView(.controlDock)
                .frame(
                    width: SettingsScreenMetrics.controlButton,
                    height: SettingsScreenMetrics.controlButton
                )
                .expandedTapTarget(
                    SettingsScreenMetrics.controlTapTarget,
                    over: SettingsScreenMetrics.controlButton
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close settings")
        .accessibilityIdentifier("close-settings")
        .frame(
            width: metrics.columnWidth,
            height: SettingsScreenMetrics.controlsHeight,
            alignment: .leading
        )
    }

    // MARK: - Sections

    private var modelSection: some View {
        section(heading: SettingsCopy.modelHeading) {
            HStack(spacing: SelectOptionMetrics.gap) {
                ForEach(SettingsOption.models(selected: store.session.selectedModel)) { option in
                    SelectOption(
                        title: option.title,
                        caption: option.caption,
                        isSelected: option.isSelected,
                        width: optionWidth
                    ) {
                        store.setModel(option.value)
                    }
                    .accessibilityIdentifier("model-option-\(option.value.rawValue)")
                }
            }
        }
    }

    private var effortSection: some View {
        section(heading: SettingsCopy.effortHeading) {
            let options = SettingsOption.efforts(selected: store.session.reasoningEffort)
            VStack(alignment: .leading, spacing: SelectOptionMetrics.gap) {
                ForEach(
                    Array(SettingsOption.rows(options, across: SelectOptionMetrics.columns).enumerated()),
                    id: \.offset
                ) { _, row in
                    HStack(spacing: SelectOptionMetrics.gap) {
                        ForEach(row) { option in
                            SelectOption(
                                title: option.title,
                                caption: option.caption,
                                isSelected: option.isSelected,
                                width: optionWidth
                            ) {
                                store.setReasoningEffort(option.value)
                            }
                            .accessibilityIdentifier("effort-option-\(option.value.rawValue)")
                        }
                    }
                }
            }
        }
    }

    private var keySection: some View {
        section(heading: SettingsCopy.keyHeading, caption: SettingsCopy.keyCaption) {
            KeyField(draft: $keyDraft, storedMask: storedMask, width: metrics.columnWidth, onSave: saveKey)
        }
    }

    /// `(column − 16 × 2) ÷ 3` — board 10's own derivation of its 236, run on the column the
    /// screen actually has. Three across is the design's grid at both sections; what a
    /// narrower column changes is the option, not the number of them.
    private var optionWidth: CGFloat {
        SelectOptionMetrics.width(inColumn: metrics.columnWidth)
    }

    private var irreversibleSection: some View {
        section(heading: SettingsCopy.irreversibleHeading, caption: SettingsCopy.irreversibleCaption) {
            HStack(spacing: DestructiveButtonMetrics.rowGap) {
                DestructiveButton(title: SettingsCopy.removeKey, action: removeKey)
                    .accessibilityIdentifier("remove-api-key")
                DestructiveButton(title: SettingsCopy.resetSession, action: store.resetSession)
                    .accessibilityIdentifier("reset-session")
            }
        }
    }

    /// Heading, optional caption, then the controls — the shape all four sections share.
    private func section(
        heading: String,
        caption: String? = nil,
        @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: heading)
                .textStyle(SettingsScreenMetrics.headingStyle)
                .foregroundStyle(DS.Color.ink)
                .frame(height: SettingsScreenMetrics.headingHeight, alignment: .leading)

            if let caption {
                Text(verbatim: caption)
                    .textStyle(SettingsScreenMetrics.captionStyle)
                    .foregroundStyle(DS.Color.inkSecondary)
                    .padding(.top, SettingsScreenMetrics.captionTopMargin)
            }

            content().padding(.top, SettingsScreenMetrics.bodyTopMargin)
        }
        .frame(width: metrics.columnWidth, alignment: .topLeading)
    }

    // MARK: - Behaviour

    private func close() {
        if let onClose { onClose() } else { dismiss() }
    }

    /// Reads the stored key once, converts it to the mask, and lets it go. Nothing else in
    /// this view ever holds the key, and it is never written anywhere but the Keychain.
    private func currentMask() -> String? {
        guard let key = store.keychain.readAPIKey()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !key.isEmpty else { return nil }
        return APIKeyMask.masked(key)
    }

    private func saveKey() {
        let trimmed = keyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty save is not a designed action and `saveAPIKey("")` would remove the key —
        // which is what the Irreversible section is for. Decline instead.
        guard !trimmed.isEmpty else { return }
        guard store.saveAPIKey(trimmed) else { return }
        // Derived from the value already in hand rather than by reading the Keychain back.
        storedMask = APIKeyMask.masked(trimmed)
        keyDraft = ""
    }

    private func removeKey() {
        guard store.removeAPIKey() else { return }
        storedMask = nil
        keyDraft = ""
    }
}

#if DEBUG
#Preview("Settings") {
    SettingsScreen()
        .environmentObject(TutorStore())
}
#endif
