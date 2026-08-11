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
    /// Whether the board has any ink to select — handed through to the composer's
    /// `btn/select`, the same flag `BoardScreen` already hands the collapsed dock.
    var canSelect = true
    let actions: TutorActions

    /// Board 16's menu, and which of the three pickers it asked for. Both are the *panel's*
    /// rather than the draft's: a menu open when the learner collapses the tutor is a card
    /// hanging over nothing, and the draft it would have added to is still there.
    @State private var isAttachMenuOpen = false
    @State private var pickerSource: AttachmentSource? = nil

    /// The reveal gesture in progress, or `nil` between gestures — board 18.
    ///
    /// `@State` on the panel rather than on `UIState` for the reason
    /// `BoardScreen.previewPanelWidth` is: this is written on every touch event, and
    /// publishing an environment object at that rate invalidates every consumer of it and
    /// makes the pane visibly stutter. `UIState` learns the answer once, on release.
    ///
    /// It is also what carries the intent lock: the axis is decided on the first frame and
    /// stored here for the rest of the touch, so a drag that starts sideways and curls
    /// downward keeps panning, and one that starts downward never pans at all.
    @State private var drawerDrag: DrawerDrag?

    /// One touch's committed answer. See `DrawerReveal.Axis`.
    private struct DrawerDrag {
        let axis: DrawerReveal.Axis
        /// Where the drawer was when this touch landed — 0 or 1. Every frame resolves from
        /// this plus the gesture's *total* translation, never from the previous frame, which
        /// is the anchor rule `ResizeModel` is built on for the same reason: a per-frame sum
        /// accumulates rounding and drifts away from the finger over a long drag.
        let anchor: CGFloat
        var progress: CGFloat
    }

    /// `337 − 2 × 18` at the design's panel width, derived rather than read off the 301 token
    /// because board 02 says hard-coding it *"is a bug waiting for the first panel-width
    /// change"*. Every child of the panel is laid out in this column.
    private var contentWidth: CGFloat { TutorPanelMetrics.contentWidth(for: layout.panelWidth) }

    /// The composer and the band behind it, as one thing. See `ComposerSlotMetrics`.
    private var slot: ComposerSlotMetrics { .panel(surfaceWidth: layout.panelWidth) }

    /// The panel: the sessions drawer, and the chat that slides off it — boards 05, 08 and 17.
    ///
    /// The drawer is **revealed, not pushed in**. It sits still under the chat at the panel's
    /// own leading edge and the chat travels; board 18 gives it 12 points of parallax and
    /// nothing more, which is what makes it read as a layer underneath rather than as a second
    /// pane arriving. Both are inside `TutorPanelSurface`, so the panel's radius clips the pair
    /// and its elevation is cast once, by the panel — board 17 draws **no shadow at the seam**,
    /// because there is no gap there for a shadow to fall into.
    var body: some View {
        // The one band in the app that gives way to the keyboard, and the reason
        // `ScreenLayout` keeps two: the composer is bottom-anchored in this
        // surface, so shortening it is what lifts the pill clear of the keys.
        // The board behind it keeps its own height — see `keyboardInset`.
        let size = CGSize(width: layout.panelWidth, height: layout.contentHeightAboveKeyboard)
        let travel = layout.sessionsDrawerWidth
        let progress = drawerProgress

        return TutorPanelSurface(size: size) {
            ZStack(alignment: .topLeading) {
                drawer(travel: travel, height: size.height, progress: progress)
                chatPane(in: size, travel: travel, progress: progress)
            }
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            // **The whole panel is the grab region, both panes.** Board 18 states the opening
            // half — *"A right-swipe anywhere in the chat area drags the drawer"* — and the
            // closing half has to hold on the other pane or the gesture is one-way: a
            // left-swipe that starts on a session row closes the drawer exactly as one that
            // starts on the 74pt chat strip does. So the gesture is on the container rather
            // than on either child, and `contentShape` makes the gaps between them grabbable
            // too.
            //
            // Simultaneous rather than exclusive so a vertical drag still scrolls whichever
            // list is under the finger. The exclusivity the note asks for is the intent lock
            // instead, and it now suppresses *both* scrollers — see `isListScrollLocked`.
            .contentShape(.rect)
            .simultaneousGesture(drawerPan(travel: travel))
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

    // MARK: - The two panes

    /// Board 17's drawer, under the chat.
    ///
    /// It carries the white veil while it is the pane being covered, and loses it across the
    /// crossfade band — see `DrawerReveal.drawerVeil(at:)`. The veil is an overlay rather than
    /// an opacity on the drawer itself because it is a wash and not a fade: the surface colour
    /// stays exactly what the panel's is, which is the whole reason the seam between the two
    /// panes can be a rounded corner and nothing else.
    private func drawer(travel: CGFloat, height: CGFloat, progress: CGFloat) -> some View {
        SessionsDrawer(
            sessions: store.sessions,
            currentID: store.session.id,
            width: travel,
            inset: SessionsDrawerMetrics.insetInline,
            height: height,
            // The drawer is swiped from as well as onto, so its list takes the same lock the
            // thread does — see `isListScrollLocked`.
            scrollDisabled: isListScrollLocked,
            onNewChat: {
                closeDrawer()
                store.startNewSession()
                adoptSessionUI()
            },
            onOpen: { id in
                closeDrawer()
                store.openSession(id: id)
                adoptSessionUI()
            },
            onSettings: {
                closeDrawer()
                actions.openSettings()
            }
        )
        .overlay(veil(DrawerReveal.drawerVeil(at: progress)))
        .offset(x: DrawerReveal.drawerOffset(at: progress))
        // Unreachable while it is fully covered, so a stray touch on the strip's own edge
        // cannot land on a session row behind the chat.
        .allowsHitTesting(progress > 0)
        .accessibilityHidden(progress == 0)
    }

    /// Screens 05 and 08, as one opaque pane that travels.
    ///
    /// Opaque is load-bearing: it is the panel's own `--color-surface-panel`, and without it
    /// the drawer would read straight through the thread. Board 17 gives the two the same
    /// fill deliberately, so the boundary is carried by the pane's leading radius alone.
    ///
    /// The radius is 0 while the drawer is shut, which makes the closed state the panel
    /// exactly as it shipped: the pane fills the surface and the surface's own 28 is the only
    /// corner on screen.
    private func chatPane(in size: CGSize, travel: CGFloat, progress: CGFloat) -> some View {
        ZStack(alignment: .top) {
            fillBand(in: size)

            // Fade and pill together, bottom-anchored: the slot owns the 18pt inset under
            // the composer, so screen 08's pill bottom lands on the panel floor less that
            // inset and screen 05's card grows upward from the same line.
            ComposerSlot(metrics: slot) { composer }
                .frame(maxHeight: .infinity, alignment: .bottom)

            ScrollFade(width: size.width, metrics: .top(for: .panel))

            // Board 17's header, after: the session title and the gear are gone and only the
            // layout pair is left, at the trailing end where it already sat. The drawer owns
            // both of the controls that left — see `note/17 — header after`.
            PanelControls(
                onDock: { closeMenus(); uiState.collapseTutor() },
                onFullScreen: { closeMenus(); uiState.expandTutorToFullScreen() },
                alignment: .trailing
            )
            .frame(width: contentWidth, height: TutorPanelMetrics.controlsHeight, alignment: .trailing)
            .padding(.top, TutorPanelMetrics.inset)

            if isAttachMenuOpen {
                attachMenu(in: size)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .background(DS.Color.surfacePanel)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: progress > 0 ? SessionsDrawerMetrics.stripCornerRadius : 0,
                bottomLeadingRadius: progress > 0 ? SessionsDrawerMetrics.stripCornerRadius : 0
            )
        )
        .overlay(veil(DrawerReveal.chatVeil(at: progress)))
        // Board 18: *"A tap on the chat strip, or a left-swipe from it, closes the drawer."*
        // The layer is mounted only while the drawer is showing, for the reason the switcher's
        // dismiss layer was: a view that swallows every touch on the chat is not something to
        // leave lying on it the rest of the time.
        .overlay {
            if progress > 0 {
                Color.clear
                    .contentShape(.rect)
                    .onTapGesture { withAnimation(DrawerReveal.settle(velocity: 0, travel: travel)) { closeDrawer() } }
                    .accessibilityLabel("Close sessions")
                    .accessibilityAddTraits(.isButton)
            }
        }
        .offset(x: progress * travel)
    }

    /// The wash. White at an alpha, over content, with the surface colour untouched.
    @ViewBuilder
    private func veil(_ alpha: Double) -> some View {
        if alpha > 0 {
            DS.Color.surface.opacity(alpha)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    // MARK: - The reveal gesture

    /// Where the drawer is right now: the live drag if one has committed to the horizontal
    /// axis, and the settled state otherwise.
    private var drawerProgress: CGFloat {
        if let drag = drawerDrag, drag.axis == .horizontal { return drag.progress }
        return uiState.isSessionsDrawerOpen ? 1 : 0
    }

    /// Whether the scrollers must hold still for this touch.
    ///
    /// This is the other half of the intent lock, and the half that makes it exclusive rather
    /// than merely simultaneous. `DragGesture(minimumDistance:)` and a `ScrollView` both
    /// recognise, so without this a diagonal drag pans the drawer *and* scrolls whatever is
    /// under the finger. The note: *"once the horizontal pan commits, vertical scroll is
    /// suppressed until the finger lifts."*
    ///
    /// **Both lists, not just the thread.** The gesture starts on either pane, so either pane's
    /// scroller can be the one competing with it: the conversation on the way open, the session
    /// rows on the way closed.
    ///
    /// The mirror case needs no code: a touch locked to `.vertical` never writes `progress`,
    /// so the drawer takes nothing from it.
    private var isListScrollLocked: Bool { drawerDrag?.axis == .horizontal }

    /// Board 18's pan.
    ///
    /// `minimumDistance` is the intent threshold itself, so the first frame this ever sees is
    /// already far enough to have an axis and no travel is spent undecided. It is also what
    /// keeps every button on the panel working: a tap does not move 12 points.
    private func drawerPan(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: DrawerReveal.intentThreshold, coordinateSpace: .local)
            .onChanged { value in
                let axis = drawerDrag?.axis ?? DrawerReveal.axis(for: value.translation)
                let anchor = drawerDrag?.anchor ?? (uiState.isSessionsDrawerOpen ? 1 : 0)
                guard axis == .horizontal else {
                    drawerDrag = DrawerDrag(axis: axis, anchor: anchor, progress: anchor)
                    return
                }
                // A drag that reaches for the drawer puts the attach menu away: the card
                // hangs over the chat and the chat is about to leave.
                if isAttachMenuOpen { isAttachMenuOpen = false }
                drawerDrag = DrawerDrag(
                    axis: .horizontal,
                    anchor: anchor,
                    progress: DrawerReveal.progress(
                        from: anchor,
                        translation: value.translation.width,
                        travel: travel
                    )
                )
            }
            .onEnded { value in
                guard let drag = drawerDrag else { return }
                guard drag.axis == .horizontal else {
                    drawerDrag = nil
                    return
                }
                let opens = DrawerReveal.settlesOpen(
                    progress: drag.progress,
                    velocity: value.velocity.width
                )
                // Both writes inside the one transaction. Clearing the drag outside it would
                // hand `drawerProgress` straight back to the settled value and the pane would
                // jump to its destination instead of springing to it.
                withAnimation(DrawerReveal.settle(velocity: value.velocity.width, travel: travel)) {
                    drawerDrag = nil
                    if opens { uiState.openSessionsDrawer() } else { uiState.closeSessionsDrawer() }
                }
            }
    }

    /// Put the drawer away, and forget any drag that is still notionally in flight.
    private func closeDrawer() {
        drawerDrag = nil
        uiState.closeSessionsDrawer()
    }

    /// Board 16's three-row card, hanging **above** the composer.
    ///
    /// Above rather than below because the composer sits on the panel's floor and a menu
    /// dropping from it would leave the surface. Its construction is board 15a's, which is
    /// what board 16 asks for — *"construction is inherited from `menu/sessions` exactly"* —
    /// and it is the last thing in the product still built that way now that the switcher
    /// itself is gone: a transparent dismiss layer mounted only while the menu is open, a
    /// card capped at 301 in the 337 surface, drawn inside `TutorPanelSurface` so the panel's
    /// radius clips it. See `MenuCardMetrics`.
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
        // Pinned to the panel's own 18pt inset rather than left to the `ZStack`'s centring:
        // the card is capped at 301 and stops being the content column the moment the student
        // widens the panel — at which point a centred card would drift off board 16's
        // `left: 18`.
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

    /// Everything the panel has open, put away. Anything that takes the learner elsewhere —
    /// a dock, a full-screen column, a settings window — calls this first.
    private func closeMenus() {
        closeDrawer()
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
                // The other half of board 18's intent lock — see `isListScrollLocked`.
                scrollDisabled: isListScrollLocked,
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
                closeDrawer()
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
            // `toggleBoardSelection` guards on the board holding ink and silently
            // returns, so without this the tap on an empty board's `btn/select`
            // changes nothing on screen. See `Composer.canSelect`.
            canSelect: canSelect,
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
    /// Board 18's intent lock, from the surface that owns the drawer pan: while a touch has
    /// committed to dragging the drawer, the conversation behind it must hold still. Defaulted
    /// off, so the full-screen column and every gallery specimen need not pass it.
    var scrollDisabled = false
    let actions: TutorActions

    private var column: CGFloat { width ?? scale.contentWidth }

    var body: some View {
        MessageThread(
            items: items,
            scale: scale,
            width: column,
            clearing: clearing,
            scrollDisabled: scrollDisabled,
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
