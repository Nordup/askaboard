import SwiftUI

/// What the tutor can be asked to do, from either surface.
///
/// Screens 05, 07 and 08 offer the same actions at two scales, so the shell builds the
/// wiring once and hands it to whichever surface is on screen. It is closures rather than
/// the store itself because half of these are not the store's to make: the board snapshot
/// belongs to the canvas and the presentation change belongs to `UIState`.
@MainActor
struct TutorActions {
    let send: () -> Void
    let selectSuggestion: (Suggestion) -> Void
    let dismissSelection: () -> Void
    let startPlan: () -> Void
    let retry: () -> Void
    let openSettings: () -> Void
}

/// The vertical chain of the docked panel, exactly as the boards state it. The panel's own
/// 18pt top inset and 301pt content column come from `TutorPanelMetrics`; these are the
/// margins the *screens* add between its children.
private enum PanelStack {
    /// Screen 05: `Orb` carries `margin-top: 120`, putting it at panel-local y 170.
    static let orbTopMargin: CGFloat = 120
    /// Screen 05: `Start state` carries `margin-top: var(--spacing-10)`, so it starts at 300.
    static let startTopMargin = DS.Space.s10
}

/// The 337pt tutor panel — screens 05 and 08, and board 11's no-key first run.
///
/// Board 09 is why this is one view with three fills rather than three screens: the panel's
/// frame, its controls and its composer are identical in every one of them, and only the
/// middle region changes.
struct TutorPanel: View {
    @EnvironmentObject private var store: TutorStore
    @EnvironmentObject private var uiState: UIState
    /// The panel's own size is a lane of the screen, so it comes from the same measurement
    /// every other lane does. Its **width** never moves — board 02 calls the panel *"the only
    /// fixed-width surface in the product"* — but its height is the content band, which was
    /// only ever 936 on a 1032pt screen.
    @Environment(\.screenLayout) private var layout
    @Binding var text: String
    @ObservedObject var dictation: DictationController
    let actions: TutorActions

    /// `337 − 2 × 18` at the design's panel width, derived rather than read off the 301 token
    /// because board 02 says hard-coding it *"is a bug waiting for the first panel-width
    /// change"*. Every child of the panel is laid out in this column.
    private var contentWidth: CGFloat { TutorPanelMetrics.contentWidth(for: layout.panelWidth) }

    var body: some View {
        TutorPanelShell(size: CGSize(width: layout.panelWidth, height: layout.contentHeight)) {
            VStack(spacing: 0) {
                TutorControlsRow(
                    width: contentWidth,
                    onDock: uiState.collapseTutor,
                    onFullScreen: uiState.expandTutorToFullScreen,
                    onSettings: actions.openSettings
                )

                fill.frame(maxHeight: .infinity, alignment: .top)

                // Board 11 gives the no-key panel a primary button in the composer's slot
                // instead of a composer — *"58 is the panel composer's height, so the button
                // occupies the composer's slot exactly"* — so the composer is absent, not
                // disabled, and `NoAPIKeyState` brings its own occupant for that slot.
                if !store.requiresAPIKey {
                    // The design's 18pt bottom slack, as the rule rather than the literal:
                    // the composer is bottom-anchored with a panel inset under it. That puts
                    // screen 08's pill bottom on 918 and, when a selection is attached, grows
                    // screen 05's card upward from the same line instead of pushing past it.
                    composer.padding(.bottom, TutorPanelMetrics.inset)
                }
            }
        }
    }

    @ViewBuilder
    private var fill: some View {
        if store.requiresAPIKey {
            // Board 11's fill owns everything below the controls — its own orb, the block,
            // and the primary button in the panel's bottom slot — so the panel hands it the
            // whole column and adds nothing.
            fitted { NoAPIKeyState(onOpenSettings: actions.openSettings) }
        } else {
            switch uiState.conversation {
            case .start: fitted { startFill }
            // The thread is already a scroll view and is built to fill whatever band it is
            // given, so it is the one fill that must not be wrapped in a second one.
            case .active: TutorThreadView(scale: .panel, width: contentWidth, actions: actions)
            }
        }
    }

    /// The panel's fill, scrolled only where the band cannot hold it.
    ///
    /// Screen 05's start state is a 772pt chain — `120 + 90 + 40 + 522` — and board 11's is
    /// 610 with the action slot. Both fit the 810pt column the design's 936pt panel leaves and
    /// neither fits the 604 a 768pt iPad does, where the composer would be drawn over and the
    /// primary button off the panel's floor. Scrolling is the answer the rail already
    /// establishes for a fixed chain in a band that is too short: every designed value stays,
    /// every control stays reachable, and nothing new is drawn.
    ///
    /// `ViewThatFits` rather than a `ScrollView` around everything, because the difference is
    /// load-bearing: board 11's button is bottom-anchored with a `Spacer`, and a spacer inside
    /// a scroll view has no height to give. The unscrolled candidate is the design, unchanged,
    /// wherever it fits — which is every screen the boards were drawn for.
    private func fitted(@ViewBuilder _ content: () -> some View) -> some View {
        let fill = content()
        return ViewThatFits(in: .vertical) {
            fill
            ScrollView(.vertical) { fill }
                .scrollBounceBehavior(.basedOnSize)
        }
    }

    /// Screen 05. The orb is the panel's, not the greeting's — `GreetingMetrics.panel`
    /// carries no orb precisely because this one is a sibling 120pt above the block.
    private var startFill: some View {
        VStack(spacing: 0) {
            Orb(.panel)
                .padding(.top, PanelStack.orbTopMargin)
            GreetingBlock(
                scale: .panel,
                width: contentWidth,
                onSelectSuggestion: actions.selectSuggestion
            )
            .padding(.top, PanelStack.startTopMargin)
        }
    }

    /// The marquee glyph stays in the input with nothing attached: screen 08 calls it *"a
    /// persistent affordance, not a state indicator"*.
    ///
    /// The mic is drawn at 38 here and 52 full-screen, which is board 03's instruction rather
    /// than its drawing: *"do not copy the current asymmetry into code as if it were
    /// intentional."* `Composer` still decides the button's presence by availability, so a
    /// first run with no API key gets the composer without it rather than a control that does
    /// nothing.
    private var composer: some View {
        Composer(
            scale: .panel,
            width: contentWidth,
            text: $text,
            selection: uiState.isSelectionAttached ? .attached : .idle,
            onSend: actions.send,
            onVoice: dictation.voiceHandler(text: $text),
            dictation: dictation.composerDictation,
            note: dictation.noteText,
            onDismissSelection: actions.dismissSelection
        )
    }
}

/// `Panel controls` in the expanded variant boards 11–13 introduce: the same two layout
/// buttons, plus `btn/settings` pushed to the far edge.
///
/// Board 11 calls it *"a new configuration, not a new component"* — the row's
/// `justify-content` changes from `flex-start` to `space-between` — so this composes
/// `PanelControls` rather than restating it. The width is a parameter because the same row
/// is 301 wide in the panel and 740 wide on board 13.
struct TutorControlsRow: View {
    let width: CGFloat
    let onDock: () -> Void
    let onFullScreen: () -> Void
    let onSettings: () -> Void

    var body: some View {
        PanelControls(onDock: onDock, onFullScreen: onFullScreen)
            .frame(width: width, height: TutorPanelMetrics.controlsHeight, alignment: .leading)
            .overlay(alignment: .trailing) { settingsButton }
    }

    private var settingsButton: some View {
        Button(action: onSettings) {
            IconView(.controlSettings)
                .frame(width: TutorPanelMetrics.controlButton, height: TutorPanelMetrics.controlButton)
                .expandedTapTarget(TutorPanelMetrics.controlTapTarget, over: TutorPanelMetrics.controlButton)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Tutor settings")
    }
}

/// The message thread and its one trailing accessory, at either scale.
///
/// Board 02 on why the plan, the failure and the thinking orb are children of the thread
/// rather than chrome around it: `btn/orb` *"is a normal flow child at the end of the
/// message list, so it rides up and down with the conversation rather than being pinned to
/// the panel"*, and board 12 places the session plan the same way — *"not a card, not a
/// modal, and not a panel takeover"*.
struct TutorThreadView: View {
    @EnvironmentObject private var store: TutorStore
    let scale: ChatScale
    /// The column the thread and every child of it is laid out in — the panel's derived 301,
    /// or the reading column, which is 740 only where there is room for it. `nil` takes the
    /// one the design drew, which is what the gallery specimens want.
    var width: CGFloat?
    let actions: TutorActions

    private var column: CGFloat { width ?? scale.contentWidth }

    var body: some View {
        MessageThread(items: items, scale: scale, width: column) { accessory }
    }

    private var items: [ChatThreadItem] {
        #if DEBUG
        if let fixture = LaunchOptions.current.fixtureThread { return fixture }
        #endif
        // A turn carrying `signal: .evaluate` is a send that took the board with it, which
        // is exactly what screen 08's `msg/student · with selection` draws. The domain
        // already records it, so nothing here has to remember which send had an attachment.
        return store.session.messages.map { message in
            ChatThreadItem(message, hasSelection: message.signal == .evaluate)
        }
    }

    @ViewBuilder
    private var accessory: some View {
        if let plan = store.session.plan, store.session.exercise != nil, !store.isWorkspace {
            // Told in the thread's own column, for the reason the failure below it is: board
            // 13's plan was measured at 740 and is 740 only where the thread is.
            SessionPlanView(plan: plan, scale: scale, width: column, onStart: actions.startPlan)
        }

        if store.errorMessage != nil {
            // Board 14: *"A failure is a tutor message, not a system alert: same 17/25 text,
            // same left edge, no box, no colour."* The store's own error string is not shown
            // in its place — the board writes this copy deliberately, and the recovery chip
            // is the retry.
            //
            // Told in the thread's own column, because the failure is one of its children:
            // board 14's stack was measured at 301 and is 301 only where the thread is.
            ChatErrorState.network(onRetry: actions.retry, metrics: .for(scale, width: column))
        } else if isTutorResponding {
            // Screen 08's tenth thread child. `OrbSize.thread` is the design system's own
            // name for it: *"Screen 08's thinking indicator at the tail of the thread."*
            Orb(.thread)
        }
    }

    private var isTutorResponding: Bool {
        #if DEBUG
        if LaunchOptions.current.showsThinkingOrb { return true }
        #endif
        return store.isLoading || store.isEvaluating
    }
}
