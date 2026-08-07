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

/// The 337pt tutor panel — screens 05 and 08.
///
/// Board 09 is why this is one view with two fills rather than two screens: the panel's
/// frame, its controls and its composer are identical in both, and only the middle region
/// changes.
///
/// There was a third fill — board 11's no-key first run — and there is no longer any state it
/// could describe. The app holds no credential a student can supply, so "not set up yet" is
/// not a thing the panel can be in: it either reaches its backend or it fails a turn, and a
/// failed turn is board 14's thread failure, not a screen. See `BackendConfiguration`.
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

    /// The composer and the band behind it, as one thing. See `ComposerSlotMetrics`.
    private var slot: ComposerSlotMetrics { .panel(surfaceWidth: layout.panelWidth) }

    /// The panel, as the boards lay it out: bands stacked on one surface, in paint order.
    ///
    /// It was a `VStack` for as long as the thread stopped below the controls row. It cannot be
    /// one now — board 03 runs the thread the panel's full height and passes it *behind* both
    /// the controls and the composer, and the two fades that make that legible span the panel's
    /// full width rather than its 301 column. Order here is the design's own, bottom of the
    /// stack first: *"Thread · fade bottom · Composer · fade top · Panel controls"*.
    var body: some View {
        let size = CGSize(width: layout.panelWidth, height: layout.contentHeight)

        return TutorPanelSurface(size: size) {
            ZStack(alignment: .top) {
                fillBand(in: size)

                // Fade and pill together, bottom-anchored: the slot owns the 18pt inset under
                // the composer, so screen 08's pill bottom lands on the panel floor less that
                // inset and screen 05's card grows upward from the same line.
                ComposerSlot(metrics: slot) { composer }
                    .frame(maxHeight: .infinity, alignment: .bottom)

                ScrollFade(width: size.width, metrics: .top(for: .panel))

                TutorControlsRow(
                    width: contentWidth,
                    onDock: uiState.collapseTutor,
                    onFullScreen: uiState.expandTutorToFullScreen,
                    onSettings: actions.openSettings
                )
                .padding(.top, TutorPanelMetrics.inset)
            }
        }
        // `DictationController` is constructed with no store in reach (see its own doc
        // comment on `sessionID`), so this is where the session a recording attaches to is
        // kept current — on first appearance and on every reset, which mints a fresh
        // `LearningSession.id`.
        .task(id: store.session.id) { dictation.sessionID = store.session.id }
    }

    /// Where the panel's middle region sits.
    ///
    /// The thread starts at the panel's own top edge — behind the controls, which is what the
    /// top fade is for. The start state still begins below them: screen 05's orb hangs 120
    /// under the controls row, a chain the design measures from the row rather than from the
    /// panel's edge. Only the thread scrolls, so only the thread has anything to pass behind.
    @ViewBuilder
    private func fillBand(in size: CGSize) -> some View {
        if case .active = uiState.conversation {
            TutorThreadView(
                scale: .panel,
                width: contentWidth,
                clearing: slot.band,
                actions: actions
            )
            .frame(width: contentWidth, height: size.height)
        } else {
            fill
                .frame(width: contentWidth, height: max(0, size.height - Self.chromeTop), alignment: .top)
                .padding(.top, Self.chromeTop)
        }
    }

    /// `18 + 32` — the panel's inset and its controls row. Where everything that is not the
    /// thread begins.
    private static var chromeTop: CGFloat {
        TutorPanelMetrics.inset + TutorPanelMetrics.controlsHeight
    }

    /// The panel's fill that is *not* the thread: screen 05's start state. A fixed chain
    /// measured from the controls row, which does not scroll unless the band is too short to
    /// hold it.
    ///
    /// The thread is not here. It is the one fill that takes the panel's whole height rather
    /// than the band below the chrome, and the one that must not be wrapped in a second scroll
    /// view — see `fillBand(in:)`.
    private var fill: some View {
        fitted { startFill }
    }

    /// The panel's fill, scrolled only where the band cannot hold it.
    ///
    /// Screen 05's start state is a 772pt chain — `120 + 90 + 40 + 522`. It fits the 810pt
    /// column the design's 936pt panel leaves and does not fit the 604 a 768pt iPad does,
    /// where the composer would be drawn over. Scrolling is the answer the rail already
    /// establishes for a fixed chain in a band that is too short: every designed value stays,
    /// every control stays reachable, and nothing new is drawn.
    ///
    /// `ViewThatFits` rather than a `ScrollView` around everything: the unscrolled candidate
    /// is the design, unchanged, wherever it fits — which is every screen the boards were
    /// drawn for.
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
    /// launch that cannot reach dictation gets the composer without it rather than a control
    /// that does nothing.
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

/// `Panel controls` in the expanded variant board 12 introduces: the same two layout
/// buttons, plus `btn/settings` pushed to the far edge.
///
/// It is *"a new configuration, not a new component"* — the row's `justify-content` changes
/// from `flex-start` to `space-between` — so this composes `PanelControls` rather than
/// restating it.
///
/// **The docked panel only.** Board 13 used to draw the same row at 740 and no longer does:
/// its two layout buttons are gone — the board peek is already the way back, and
/// `btn/full-screen` was a control for the state you were already in — and its settings
/// button moved out of the reading column to the screen's own corner. The panel is the one
/// place this row still exists; the width stays a parameter because it is the panel's
/// derived content column, never a stored 301.
struct TutorControlsRow: View {
    let width: CGFloat
    let onDock: () -> Void
    let onFullScreen: () -> Void
    let onSettings: () -> Void

    var body: some View {
        PanelControls(onDock: onDock, onFullScreen: onFullScreen)
            .frame(width: width, height: TutorPanelMetrics.controlsHeight, alignment: .leading)
            .overlay(alignment: .trailing) { SettingsButton(action: onSettings) }
    }
}

/// `btn/settings` — the gear, on its own.
///
/// Its own type because the two surfaces that draw it no longer share a container: the panel
/// puts it at the trailing edge of the controls row, and the full-screen column pins it to
/// the screen's corner with no row at all. Both draw the same 32pt button and the same
/// expanded hit area, which is exactly what would drift if each rebuilt it.
struct SettingsButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
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
    /// The band at the bottom of the thread's frame that the composer is painted over. The
    /// thread runs behind it on both surfaces, so this is the clearance the newest message
    /// keeps from the pill.
    var clearing: CGFloat = 0
    let actions: TutorActions

    private var column: CGFloat { width ?? scale.contentWidth }

    var body: some View {
        MessageThread(items: items, scale: scale, width: column, clearing: clearing) { accessory }
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
        }

        // Screen 08's tenth thread child — **unconditional**, and that is a decision the
        // boards left open. `05-screens.md` labels it "thinking indicator" and
        // `03-chat-components.md` contradicts it in the same breath: *"it is documented as a
        // *button* (`btn/orb`), not a state indicator, with no animation, variant, or spec
        // table here"*, and board 08 draws it at the tail of a thread whose last message has
        // already been delivered. Gating it on `isLoading` resolved that the other way and
        // made the tutor's face blink out of the panel the moment it finished answering.
        //
        // So: the orb is presence, not progress. It is the hero in the greeting, the panel
        // orb above the start state, the dock's button when collapsed, and this 46pt mark at
        // the tail once there is a conversation — never absent. A working state, if one is
        // ever designed, is `state/thinking`'s dots (board 14), which is a different mark.
        Orb(.thread)
    }
}
