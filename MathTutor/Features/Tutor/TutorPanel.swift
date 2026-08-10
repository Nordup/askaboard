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
    /// `btn/select` in the composer — arm the board's marquee, or disarm it. Same action the
    /// collapsed dock's button has, because it is the same control at the other presentation.
    let toggleSelection: () -> Void
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
    /// The files on the draft. Observed rather than owned for exactly the reason the
    /// dictation controller is: the draft outlives every presentation change the tutor
    /// makes, and a `@StateObject` here would be destroyed — taking a half-uploaded photo
    /// with it — the moment the panel docks, collapses or goes full-screen.
    @ObservedObject var attachments: ComposerAttachments
    let actions: TutorActions

    /// Board 16's menu, and which of the three pickers it asked for. Both are the *panel's*
    /// rather than the draft's: a menu open when the learner collapses the tutor is a card
    /// hanging over nothing, and the draft it would have added to is still there.
    @State private var isAttachMenuOpen = false
    @State private var pickerSource: AttachmentSource? = nil

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
        // The one band in the app that gives way to the keyboard, and the reason
        // `ScreenLayout` keeps two: the composer is bottom-anchored in this
        // surface, so shortening it is what lifts the pill clear of the keys.
        // The board behind it keeps its own height — see `keyboardInset`.
        let size = CGSize(width: layout.panelWidth, height: layout.contentHeightAboveKeyboard)

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
                    // Every one of these takes the learner somewhere the menu
                    // cannot follow — a dock, a full-screen column, a settings
                    // window — so each puts it away first.
                    onDock: { closeMenus(); uiState.collapseTutor() },
                    onFullScreen: { closeMenus(); uiState.expandTutorToFullScreen() },
                    onSettings: { closeMenus(); actions.openSettings() },
                    sessionTitle: store.session.title,
                    isSessionMenuOpen: uiState.isSessionMenuOpen,
                    // The two menus are alternatives, not layers: one opening puts the
                    // other away, the same way every control in this row already puts the
                    // session menu away before it moves the learner somewhere.
                    onToggleSessionMenu: {
                        isAttachMenuOpen = false
                        uiState.toggleSessionMenu()
                    }
                )
                .padding(.top, TutorPanelMetrics.inset)

                if uiState.isSessionMenuOpen {
                    sessionMenu(in: size)
                }

                if isAttachMenuOpen {
                    attachMenu(in: size)
                }
            }
        }
        // Mounted on the panel rather than on the composer: a sheet presented from a view
        // inside a `ComposerSlot` is presented from a view the slot may stop drawing.
        .attachmentPickers(
            source: $pickerSource,
            onPicked: { data, filename, contentType in
                attachments.add(
                    data: data,
                    filename: filename,
                    contentType: contentType,
                    sessionID: store.session.id
                )
            },
            onRefused: { filename, sentence in
                attachments.refuse(filename: filename, sentence: sentence)
            }
        )
        // `DictationController` is constructed with no store in reach (see its own doc
        // comment on `sessionID`), so this is where the session a recording attaches to is
        // kept current — on first appearance, and on every change of session id: a reset,
        // a new session, or a switch to a stored one.
        .task(id: store.session.id) { dictation.sessionID = store.session.id }
    }

    /// Board 15a's switcher, hanging off the controls row.
    ///
    /// Drawn inside the panel rather than as a popover: the panel clips to its
    /// own radius, the menu is 301 wide in a 337 surface, and the design draws it
    /// as part of the panel rather than as system chrome floating over the app.
    ///
    /// The transparent layer under it is what makes a tap anywhere else close the
    /// menu, and it is mounted **only while the menu is open**. A view that
    /// swallows every touch on the panel is not something to leave lying on it
    /// the rest of the time — the same reasoning `BoardSelectionMarquee` is
    /// mounted under.
    @ViewBuilder
    private func sessionMenu(in size: CGSize) -> some View {
        Color.clear
            .contentShape(.rect)
            .frame(width: size.width, height: size.height)
            .onTapGesture { uiState.closeSessionMenu() }

        SessionMenu(
            sessions: store.sessions,
            currentID: store.session.id,
            width: contentWidth,
            onNew: {
                uiState.closeSessionMenu()
                store.startNewSession()
                adoptSessionUI()
            },
            onOpen: { id in
                uiState.closeSessionMenu()
                store.openSession(id: id)
                adoptSessionUI()
            }
        )
        .padding(.top, Self.chromeTop + SessionSwitcherMetrics.menuTopGap)
    }

    /// Board 16's three-row card, hanging **above** the composer.
    ///
    /// Above rather than below because the composer sits on the panel's floor and a menu
    /// dropping from it would leave the surface. Everything else is `sessionMenu`'s
    /// construction verbatim, which is what board 16 asks for — *"construction is inherited
    /// from `menu/sessions` exactly"*: the same transparent dismiss layer mounted only while
    /// the menu is open, the same 301pt card centred in the 337pt surface (which is what
    /// puts its left edge on the panel's own 18pt inset), and drawn inside
    /// `TutorPanelSurface` so the panel's radius clips it.
    ///
    /// The top padding is the anchor, and it is `ComposerSlotMetrics.attachMenuTop(in:over:)`
    /// rather than arithmetic spelled out here — because it is the same arithmetic the
    /// reading column needs, and because inline it was untestable and got the composer's
    /// height wrong. It is measured over the composer **with the card it is drawing**: a
    /// menu anchored on the resting pill covers the chips the learner just made.
    @ViewBuilder
    private func attachMenu(in size: CGSize) -> some View {
        Color.clear
            .contentShape(.rect)
            .frame(width: size.width, height: size.height)
            .onTapGesture { isAttachMenuOpen = false }

        AttachMenu(width: AttachMenu.width(in: contentWidth)) { choice in
            isAttachMenuOpen = false
            pickerSource = AttachmentSource(choice)
        }
        // Pinned to the panel's own 18pt inset rather than left to the `ZStack`'s centring.
        // `SessionMenu` can rely on centring because it is exactly `contentWidth` wide, so
        // the two margins are equal by construction; this card is capped at 301 and stops
        // being the content column the moment the student widens the panel — at which point
        // a centred card would drift off board 16's `left: 18`.
        .padding(.leading, TutorPanelMetrics.inset)
        .frame(width: size.width, alignment: .leading)
        .padding(.top, slot.attachMenuTop(in: size.height, over: composerHeight))
    }

    /// The composer's height right now, card and all — `Composer.card` is the one place that
    /// decides which card is drawn, so this asks the composer rather than re-deriving it
    /// from `attachments` and `composerSelection` a second time.
    private var composerHeight: CGFloat {
        ComposerMetrics.for(.panel, width: contentWidth).height(showing: composer.card)
    }

    /// Both of the panel's own menus, put away. Anything that takes the learner elsewhere —
    /// a dock, a full-screen column, a settings window — calls this first.
    private func closeMenus() {
        uiState.closeSessionMenu()
        isAttachMenuOpen = false
    }

    /// The screen's own axes, re-derived for the session that just opened.
    ///
    /// None of these survives a switch. An attached marquee names a rectangle
    /// on the board that was just swapped out, so it would send the wrong region
    /// on the next turn; and the conversation axis is the difference between a
    /// greeting and a thread, which is a property of the session rather than of
    /// the learner's last tap.
    ///
    /// The draft's files go for the same reason and one more: they were uploaded
    /// *against a session id* (`POST /v1/attachments` takes one), so a chip
    /// carried into the session next door names a file the new session's turn
    /// has no claim on. `clear()` also cancels anything still in flight, which
    /// is an upload for a draft that no longer exists.
    private func adoptSessionUI() {
        uiState.clearBoardSelection()
        attachments.clear()
        uiState.showConversation(store.hasGoal ? .active : .start)
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
    /// Typed as `Composer` rather than `some View` so `attachMenu(in:)` can read `card` off
    /// it. Which card is drawn is one decision and this is where it is made.
    private var composer: Composer {
        Composer(
            scale: .panel,
            width: contentWidth,
            text: $text,
            selection: composerSelection,
            onSend: actions.send,
            onAttach: {
                uiState.closeSessionMenu()
                isAttachMenuOpen = true
            },
            // `ComposerAttachments.add(...)` returns `Void` and does nothing at
            // all once the draft holds five files or while a send is in flight,
            // so without this the learner picking a sixth gets no chip, no
            // sentence and no clue. See `Composer.canAttach`.
            canAttach: !attachments.isFull && !attachments.isSending,
            onVoice: dictation.voiceHandler(text: $text),
            dictation: dictation.composerDictation,
            // One slot, three writers, **fixed priority — not recency.** A failed
            // attachment is first because it is the only one of the three that
            // names something still sitting in the composer and still fixable:
            // the chip is on screen, and removing or replacing that file is the
            // learner's next move. The other two describe something that has
            // already happened and cannot be acted on from here. The cost is
            // real and accepted — a board-capture failure a moment ago is held
            // behind a refusal from a minute ago — and the chip beside the note
            // is what says which file it is about.
            //
            // The server writes those refusals for a learner ("That file is too
            // large, try a photo of one page at a time"), and this is the lane
            // they are written for: the chip's own label is 84 points wide and
            // would show three words of it.
            note: attachments.failureNote ?? store.composerNote ?? dictation.noteText,
            onDismissSelection: actions.dismissSelection,
            onToggleSelection: actions.toggleSelection,
            attachments: attachments.pending,
            // An explicit closure rather than the bound method: a
            // `@MainActor`-isolated method reference passed straight into a
            // one-argument closure parameter crashes swift-frontend during
            // IRGen on this toolchain — see `BoardScreen.board`.
            onRemoveAttachment: { attachments.remove($0) }
        )
    }

    /// Axis C as the composer draws it. The glyph lights the moment `btn/select` is
    /// tapped — that is the only feedback the tap has — but the `Selection attached` card
    /// waits for a region to actually exist, because until the drag finishes nothing is.
    private var composerSelection: ComposerSelection {
        switch uiState.selection {
        case .none: .idle
        case .arming: .arming
        case .attached: .attached
        }
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
    /// The switcher's title, and its control. Board 15a puts them in the lane the
    /// row already had between its two icon groups — the row's
    /// `justify-content: space-between` was drawn with that lane empty, and a
    /// third child is what it was always going to hold.
    let sessionTitle: String
    let isSessionMenuOpen: Bool
    let onToggleSessionMenu: () -> Void

    var body: some View {
        PanelControls(onDock: onDock, onFullScreen: onFullScreen)
            .frame(width: width, height: TutorPanelMetrics.controlsHeight, alignment: .leading)
            // Placed from the leading edge, not centred — see
            // `SessionSwitcherMetrics.titleLaneLeading`. The row's flanks are 78
            // and 32, so centring would put the title's tap target back over
            // `btn/dock`.
            .overlay(alignment: .leading) {
                SessionTitleButton(
                    title: sessionTitle,
                    isOpen: isSessionMenuOpen,
                    maxWidth: SessionSwitcherMetrics.titleMaxWidth(for: width),
                    action: onToggleSessionMenu
                )
                .padding(.leading, SessionSwitcherMetrics.titleLaneLeading)
            }
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
        MessageThread(
            items: items,
            scale: scale,
            width: column,
            clearing: clearing,
            // Read straight off `BoardCropStore` rather than through a bound method
            // reference, which crashes swift-frontend during IRGen on this toolchain when
            // handed straight to a one-argument closure parameter — see `Composer`'s own
            // `onRemoveAttachment` for the precedent this follows.
            crop: { id in store.boardCropStore.crop(for: id) }
        ) { accessory }
    }

    private var items: [ChatThreadItem] {
        #if DEBUG
        if let fixture = LaunchOptions.current.fixtureThread { return fixture }
        #endif
        // A turn carrying `signal: .evaluate` is a send that took the board with it, which
        // is exactly what screen 08's `msg/student · with selection` draws. The domain
        // already records it, so nothing here has to remember which send had an attachment.
        //
        // Nothing here builds an activity trail — `MessageRow` (`MessageThread.swift`) reads
        // `message.activity` itself now, and draws it inline above the reply for every tutor
        // message that has one, not only the most recent. That is what makes a trail three
        // turns back still open on a session reopened after a relaunch: it is a property of
        // the message being rendered, not of a second path that only ever sees the last one.
        return store.session.messages.map { message in
            ChatThreadItem(
                message,
                hasSelection: message.signal == .evaluate,
                // Carried on the message, unlike the one below: a file the learner
                // attached is part of what they said, and it survives a relaunch
                // because `AttachmentStore` kept its thumbnail.
                attachments: message.attachments,
                selectionView: store.selectionViews[message.id]
            )
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

        if store.isLoading, store.phase != .writing {
            // The working state board 14 designed and the panel never wired up — the orb
            // immediately below is presence, and presence is not progress. Without this the
            // thread said nothing at all for the length of a turn, which on a turn that
            // spends two minutes drawing a diagram is the whole turn.
            //
            // Variant B, the dots *with* a status line: the dots alone say "something is
            // happening" and the complaint this answers is that something is happening and
            // you cannot tell what.
            //
            // Hidden during `.writing` rather than shown throughout, because at that point
            // the reply itself is streaming into the thread above and is a better progress
            // indicator than any mark next to it. `nil` reads as `.thinking` and covers the
            // gap between the send and the first `status` event, which is a real few seconds
            // — the connection, the board upload and the prompt all happen in it.
            ThinkingIndicator(status: (store.phase ?? .thinking).statusLine, scale: scale)
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

private extension TutorPhase {
    /// What the thread says the tutor is doing, in the tutor's own register.
    ///
    /// Board 14 writes this line's one worked example as *"Reading your board"* — a
    /// sentence about the learner's work, not a machine reporting its state — so the rest
    /// follow it rather than the phase names on the wire. Nothing here is a gerund-shaped
    /// label for a subsystem: `.searching` is not "Searching the corpus", and `.drawing` is
    /// not "Rendering SVG".
    var statusLine: String {
        switch self {
        case .thinking: "Thinking"
        case .looking: "Reading your board"
        case .searching: "Looking something up"
        case .drawing: "Drawing on the board"
        // Never shown today — the thread hides the indicator once the reply is streaming —
        // but a phase with no copy would be a trap for whoever changes that.
        case .writing: "Writing"
        }
    }
}
