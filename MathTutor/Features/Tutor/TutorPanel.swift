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

        return TutorPanelSurface(size: size) {
            // The gesture, the travel and the veils all live in the layer, and so does the
            // only state a finger writes. Nothing here is a function of how far the drawer is
            // open — that is the rule the layer's own doc sets out, and it is what keeps a
            // swipe from rebuilding the whole thread sixty times a second on an A10.
            DrawerRevealLayer(
                travel: layout.sessionsDrawerWidth,
                size: size,
                isOpen: uiState.isSessionsDrawerOpen,
                onSettle: { opens in
                    if opens { uiState.openSessionsDrawer() } else { uiState.closeSessionsDrawer() }
                }
            ) {
                drawer(width: layout.sessionsDrawerWidth, height: size.height)
            } chat: {
                chatPane(in: size)
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

    // MARK: - The two panes

    /// Board 17's drawer, under the chat. The layer places it, veils it and moves it.
    private func drawer(width: CGFloat, height: CGFloat) -> some View {
        SessionsDrawer(
            sessions: store.sessions,
            currentID: store.session.id,
            width: width,
            inset: SessionsDrawerMetrics.insetInline,
            height: height,
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
            onDelete: { id in
                store.deleteSession(id: id)
                adoptSessionUI()
            },
            // **The drawer stays open.** Settings is a window drawn over the whole screen and
            // it is reached *from here*; closing the thing you opened it from means coming back
            // to a panel that has forgotten where you were. Every other action in this drawer
            // replaces what the chat is showing, which is why they all close it and this one
            // does not.
            onSettings: actions.openSettings
        )
        // One modifier, whole subtree, and safe to disable outright: there is no text field in
        // the drawer, so the keyboard exception does not reach here. See
        // `View.inertDuringDrawerPan()`.
        .inertDuringDrawerPan()
    }

    /// Screens 05 and 08 — the pane the layer slides. It draws no surface and no radius of its
    /// own; both belong to the layer, which is the only thing that knows how far it has moved.
    private func chatPane(in size: CGSize) -> some View {
        // **The composer is a sibling of both disabled groups, never a descendant.** That is
        // the whole of the keyboard exception, and stating it as structure rather than as a
        // list is the point: `inertDuringDrawerPan` disables what it is attached to, and
        // disabling a focused `TextField` resigns first responder — so a swipe mid-sentence
        // would drop the keyboard. Everything a swipe can press is in one of the two groups;
        // the pill is between them, in paint order, and stays live.
        ZStack(alignment: .top) {
            fillBand(in: size)
                .inertDuringDrawerPan()

            // Fade and pill together, bottom-anchored: the slot owns the 18pt inset under
            // the composer, so screen 08's pill bottom lands on the panel floor less that
            // inset and screen 05's card grows upward from the same line.
            ComposerSlot(metrics: slot) { composer }
                .frame(maxHeight: .infinity, alignment: .bottom)

            Group {
                ScrollFade(width: size.width, metrics: .top(for: .panel))

                // Board 17's header, after: the session title and the gear are gone and only
                // the layout pair is left, at the trailing end where it already sat. The
                // drawer owns both of the controls that left — see `note/17 — header after`.
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
            .inertDuringDrawerPan()
        }
    }

    /// Put the drawer away. The layer clears its own drag on release, so there is nothing
    /// here to forget.
    private func closeDrawer() {
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
    ///
    /// Nothing here knows about the drawer's gesture; the pane it sits in disables this whole
    /// band while a pan owns the touch — see `chatPane(in:)`.
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
