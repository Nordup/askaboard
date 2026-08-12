import SwiftUI

/// The reading column — screen 07, and the one cell of the state table the design left empty.
///
/// Board 05: *"This is not a scale factor: the type scale, chip layout (1-up vs 2-up), chip
/// height (62 vs 74), icon size (22 vs 24), composer height (58/96 vs 80) and the composer's
/// contents all change. Treat the greeting/chips/composer as two variants, not one
/// responsive view."* So this is its own view rather than the panel under a `GeometryReader`,
/// and the two share only what the design says they share: `ChatScale`.
///
/// The column's origin is a screen constant *"reserve the 68pt peek, centre a 740pt column in
/// the remainder"* — which `ScreenLayout` now answers for the screen the app is actually on:
/// x 284 of 1376, and a narrower column, still centred inside the peek, on anything smaller.
/// The peek is on the trailing edge in the redesign, and the column is centred all the same —
/// it is centred in *what the peek leaves*, which is a rule about a region and not about a
/// side.
struct TutorFullScreen: View {
    @EnvironmentObject private var store: TutorStore
    @EnvironmentObject private var uiState: UIState
    /// Screen 07 is placed out of the same measurement every other lane is cut from — see
    /// `TutorColumnMetrics` for what it does with it.
    @Environment(\.screenLayout) private var layout
    @Binding var text: String
    @ObservedObject var dictation: DictationController
    /// The same draft the docked panel holds — see `TutorPanel.attachments`. Observed, not
    /// owned: a learner who attaches a photo in the panel and then expands to the reading
    /// column is looking at one message, not two.
    @ObservedObject var attachments: ComposerAttachments
    let actions: TutorActions

    /// The presentation morph's gesture, when the screen runs the tracked container morph:
    /// the peek lane's left-swipe drives the flight layer's progress from `1` downward.
    /// `nil` keeps the commit-triggered spring — previews never pass one. Held as a plain
    /// value that only ever writes; the one observer is `PresentationFlightLayer`.
    var flight: PresentationFlightHandle? = nil

    /// True while a docked ↔ full-screen flight is in progress. The shared elements are
    /// single instances that travel in the flight layer, so this surface's own copies go
    /// invisible — held at opacity 0, never unmounted, so the mount decision stays outside
    /// the animated path — for exactly the flight's duration. Grows one element per step of
    /// the rebuild; today it is the orb.
    var isInPresentationFlight = false

    /// Board 16's menu and the picker it asked for.
    @State private var isAttachMenuOpen = false
    @State private var pickerSource: AttachmentSource? = nil

    /// Whether a pan owns the touch in progress — board 18's intent lock, on this surface too.
    ///
    /// Set by `DrawerPanGesture` at the moment the touch commits to the horizontal axis, which
    /// is also the moment the recogniser cancels every press that touch had in flight — see
    /// `DrawerPanRecognizer`. The commitment is a property of the *touch*, not of the sidebar:
    /// it fires just the same when the sidebar is already open and a further left-swipe moves
    /// nothing, which was the boundary case the old `.disabled` groups still leaked presses in.
    /// What is left for this flag is the fingers that land *after* — see `inertToTouches(_:)`.
    @State private var isPanCommitted = false

    /// True from a left-swipe committing inside the board peek's lane until it is released.
    ///
    /// A second flag beside `isPanCommitted` rather than a reuse of it, because the two answer
    /// different questions: that one says a pan owns the touch — true for *any* commitment in
    /// either region, including one that routes to nothing — and this one says which route was
    /// chosen. Read once, at commitment, and never revisited; see `HorizontalSwipeRouter`.
    @State private var isReturningToBoard = false

    /// How much of the leading edge the sessions sidebar has taken — board 19's 372 while it
    /// is open, nothing while it is not.
    ///
    /// The one number the whole of this surface reads off the drawer. It is the settled state
    /// and never a live drag position, unlike the docked panel's: see `drawerPanGesture(travel:)`.
    private var sidebar: CGFloat {
        uiState.isSessionsSidebarOpen ? layout.sessionsSidebarWidth : 0
    }

    private var column: TutorColumnMetrics {
        TutorColumnMetrics(layout: layout, reserving: sidebar)
    }
    /// The composer and the band behind it, as one thing. See `ComposerSlotMetrics`.
    /// The underhang is the screen's own edge inset below the content band — the fade has to
    /// run to the surface's floor, and this surface's floor is the screen's. See
    /// `TutorColumnMetrics.underhang` for what broke without it.
    private var slot: ComposerSlotMetrics {
        .fullScreen(columnWidth: column.width, underhang: column.underhang, scale: Self.scale)
    }

    /// **The panel treatment, on the reading column — an experiment shipped for device
    /// judgment.** The `.fullScreen` variant read oversized on the device: a 40pt display
    /// title and an 80pt pill for the same conversation the docked panel tells at 17pt. So
    /// this surface currently draws every component at `ChatScale.panel` — the docked type,
    /// chips, icons and composer — in the measured reading column, capped at a readable
    /// measure (`TutorColumnMetrics.panelTreatmentColumnCap`). The scale picks the treatment
    /// and the column stays a separate parameter, which is exactly the split `ChatScale`
    /// documents; the boards — and the gallery specimens — still draw the big variant until
    /// the user confirms on device.
    ///
    /// The constant itself lives on `TutorColumnMetrics`, which is nonisolated and can
    /// therefore serve as the metrics initialiser's default; this is the same value.
    static let scale: ChatScale = TutorColumnMetrics.liveScale

    var body: some View {
        ZStack(alignment: .topLeading) {
            chatSurface
            sessionsSidebar

            // No pan-time `.disabled` on any of this any more: a swipe that commits cancels
            // its own in-flight presses at the UIKit level (`DrawerPanRecognizer`), composer
            // and all, and `inertToTouches` below covers any finger that lands afterwards.
            switch uiState.conversation {
            case .start: startColumn
            case .active: threadColumn
            }

            // Outside the switch, for the same reason the composer is: the slot belongs to the
            // input field, not to the conversation. The fade used to live inside `threadColumn`
            // and that was the bug — the greeting state has a composer floating over content
            // that scrolls whenever the chip grid wraps, and it was the one surface in the
            // product drawing that composer with nothing behind it.
            //
            // Bottom-anchored inside the slot, so nothing here has to know whether a selection
            // is attached: the card grows upward out of the band and the pill stays on 1004.
            // The slot's band now runs pill-top to screen floor — the underhang keeps the
            // pill itself on the content band's bottom, exactly as the panel's inset does.
            // Offset left by the thread's bleed: the slot's band is that much wider than the
            // column on each side (see `ComposerSlotMetrics.fullScreen`), and the pill
            // centres in it, so this is what keeps the pill itself on `column.x`.
            ComposerSlot(metrics: slot, surfaceColor: DS.Color.surface) { composer }
                .offset(x: column.x - ThreadMetrics.bleed, y: column.floor - slot.band)

            sidebarToggle

            if isAttachMenuOpen {
                attachMenu
            }
        }
        // Later touches — a second finger, mid-pan — find nothing to press. The same one
        // modifier the docked panel carries, for the same reason: the committing touch is
        // already handled natively, and this covers the touches that have not landed yet.
        .inertToTouches(isPanCommitted)
        // **The pan surface is the whole screen, stated rather than inferred.**
        //
        // Every child here is placed by `.offset`, and an offset moves a view without telling
        // its parent — so this `ZStack` was only ever as wide as its widest *laid-out* child.
        // With the sidebar open that is the chat pane at `screenWidth − sidebar`, and the
        // points it is offset by fall off the end: the stack stopped short of the trailing
        // edge, the `contentShape` below it stopped there too, and a swipe that started right
        // of that reached nothing at all. In the greeting state the widest child is the 740pt
        // reading column, so the dead band was wider still — which is what was reported as the
        // swipe only working on the left of the screen.
        //
        // Framing to the screen fixes it without moving anything, because absolute offsets do
        // not care how large the box they sit in is.
        .frame(width: layout.screenWidth, height: layout.screenHeight, alignment: .topLeading)
        // The same right-swipe the docked panel takes — board 19: *"The same right-swipe still
        // opens the sidebar, and a left-swipe closes it."* The recogniser's region is the whole
        // container, so the sidebar is swiped *from* as well as onto — a left-swipe that starts
        // on a session row closes it — and its empty space is grabbable without a
        // `contentShape`, because the region is the background view's frame and not a hit test.
        //
        // Less the board peek's lane: the peek is a sibling painted *after* the tutor in
        // `BoardScreen`, and its tap used to win by paint order — a UIKit recogniser cannot see
        // SwiftUI paint order, so the reservation is stated as geometry instead, and this
        // surface still never takes a touch that lands on the peek.
        .background {
            drawerPanGesture(travel: layout.sessionsSidebarWidth)
                .padding(.trailing, max(0, layout.screenWidth - layout.peekX))
        }
        // The lane the modifier above cuts out, given its own meaning. Two regions rather than
        // one with a branch, because the recogniser's geometry gate *is* the region: a single
        // anchor spanning the screen could not tell the router which side the touch began on
        // without re-deriving the hit test the gate already performs.
        .background(alignment: .topLeading) { peekEdgeZone }
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
        // kept current — on first appearance and on every reset, which mints a fresh
        // `LearningSession.id`. `TutorPanel` carries the identical modifier for the docked
        // surface; whichever one is on screen is the one whose `.task` actually runs.
        .task(id: store.session.id) { dictation.sessionID = store.session.id }
    }

    // MARK: - The two panes (board 19)

    /// The chat as a *surface*, which is what the sidebar makes it.
    ///
    /// Board 19 puts the full-screen ground on `--color-surface-screen` and the chat on white
    /// with 28pt rounded leading corners, *"and that edge carries the boundary, so there is no
    /// divider rule."* With the sidebar shut the pane runs the whole screen with no radius,
    /// which is screen 07 exactly as it shipped — a full-bleed white ground — so the closed
    /// state is unchanged rather than re-derived.
    ///
    /// It is a fill and not a card: no shadow, no veil, and it is not clipped to. Board 19
    /// leaves both panes fully active at the same time, so nothing here dims or blocks
    /// anything, and the column that draws over it is a sibling rather than a child.
    private var chatSurface: some View {
        UnevenRoundedRectangle(
            topLeadingRadius: sidebar > 0 ? SessionsDrawerMetrics.chatCornerRadius : 0,
            bottomLeadingRadius: sidebar > 0 ? SessionsDrawerMetrics.chatCornerRadius : 0
        )
        .fill(DS.Color.surface)
        .frame(width: max(0, layout.screenWidth - sidebar), height: layout.screenHeight)
        .offset(x: sidebar)
        .accessibilityHidden(true)
    }

    /// Board 19's persistent sidebar, against the leading screen edge.
    ///
    /// **Persistent, not modal.** The chat neither moves nor dims for it — the column
    /// re-centres in what is left, which is `TutorColumnMetrics(layout:reserving:)` — so both
    /// panes are live at once and neither carries a veil. That is the whole difference from
    /// the docked drawer, where the two share 337 points and one has to give way.
    ///
    /// It slides in from behind the leading edge on a spring rather than tracking the finger.
    /// The docked drawer tracks because the pane over it tracks with it and the pair reads as
    /// one sheet under a hand; here the chat is stationary and the reading column re-centres,
    /// so a finger-tracked sidebar would drag 740 points of text sideways one frame at a time.
    /// The settle is the same spring either way — see `DrawerReveal.settle(velocity:travel:)`.
    @ViewBuilder
    private var sessionsSidebar: some View {
        if uiState.isSessionsSidebarOpen {
            SessionsDrawer(
                sessions: store.sessions,
                currentID: store.session.id,
                width: layout.sessionsSidebarWidth,
                inset: SessionsDrawerMetrics.sidebarInset,
                height: layout.screenHeight,
                // **Nothing in here closes the sidebar**, and that is the whole difference
                // between this surface and the docked one.
                //
                // The docked drawer covers 78% of the panel to show you the list, so choosing
                // from it is finishing with it: it closes, and the chat you chose comes back.
                // Board 19's sidebar covers nothing — it is a lane of the screen with both
                // panes live at once — so choosing from it is not finishing with it, it is
                // using it. Closing on a pick would make the learner re-open the sidebar to
                // make a second comparison, which is exactly the case a persistent sidebar
                // exists for.
                //
                // That applies to `New chat` for the same reason it applies to a row: both
                // pick the session the chat pane shows, and the sidebar is not a menu that a
                // pick dismisses. Settings never closed it either.
                onNewChat: {
                    store.startNewSession()
                    adoptSessionUI()
                },
                onOpen: { id in
                    store.openSession(id: id)
                    adoptSessionUI()
                },
                onDelete: { id in
                    store.deleteSession(id: id)
                    adoptSessionUI()
                },
                // The row's menu lifecycle, straight from its `UIContextMenuInteraction` —
                // see `SessionRowMenu` and `TutorPanel`'s identical wiring.
                onMenuActivity: { uiState.setContextMenuActive($0) },
                onSettings: actions.openSettings
            )
            .offset(x: layout.sessionsSidebarX)
            .transition(.move(edge: .leading))
        }
    }

    /// The screen's own axes, re-derived for the session that just opened — the same three
    /// `TutorPanel.adoptSessionUI` re-derives, for the same reasons. Both surfaces can open a
    /// session now, so both have to.
    private func adoptSessionUI() {
        uiState.clearBoardSelection()
        attachments.clear()
        uiState.showConversation(store.hasGoal ? .active : .start)
    }

    /// Board 19's `btn/sidebar-toggle`, on the chat pane's own top-left corner.
    ///
    /// **It never fades here, and that is the one place this surface parts company with the
    /// docked panel.** In the panel the toggle is on a pane that slides out from under the
    /// drawer, so it has to leave before the two collide — 263 points of travel inside a 337pt
    /// surface leaves no room for both. Board 19's sidebar covers nothing: the chat pane keeps
    /// its whole header, moves right by the sidebar's width and stays fully live. A control that
    /// dimmed on a pane that is not dimming would be the only faded thing on the screen.
    ///
    /// So it is a **true toggle** rather than an opener. Both panes are usable at once here,
    /// which makes closing the sidebar an ordinary thing to want next — and the swipe that
    /// closes it is the one gesture on this surface a learner is least likely to find. Every
    /// other way out of the sidebar was deliberately removed: nothing inside it closes it (see
    /// `sessionsSidebar`), so without this the only exit is a left-swipe.
    ///
    /// Placed at `contentLeft + sidebar`, which is board 19's `x: 28` inside a pane that starts
    /// at the sidebar's trailing edge — the same `--space-edge` from the nearest obstruction
    /// that `contentTop` is from the top, so it holds on a screen with a safe-area inset too.
    /// The offset is the whole of the movement: the pane and the button read the same one
    /// number, so they arrive together on the spring that carries the sidebar in.
    private var sidebarToggle: some View {
        SidebarToggleButton(
            label: uiState.isSessionsSidebarOpen ? "Hide sessions" : "Show sessions"
        ) {
            isAttachMenuOpen = false
            withAnimation(
                DrawerReveal.settle(velocity: 0, travel: layout.sessionsSidebarWidth)
            ) {
                if uiState.isSessionsSidebarOpen {
                    uiState.closeSessionsSidebar()
                } else {
                    uiState.openSessionsSidebar()
                }
            }
        }
        .frame(
            width: TutorPanelMetrics.controlButton,
            height: TutorPanelMetrics.controlsHeight,
            alignment: .leading
        )
        .offset(x: layout.contentLeft + sidebar, y: layout.contentTop)
    }

    // MARK: - The reveal gesture

    /// Board 19's swipe, arbitrated exactly as the panel's is — the same `DrawerPanRecognizer`,
    /// the same 12pt / 38° lock, so a vertical drag scrolls the thread and a horizontal one
    /// reaches for the sidebar. The difference is that this one commits on release rather than
    /// tracking, so the change callback drives nothing: the sidebar re-centres a 740pt reading
    /// column, and a finger-tracked one would drag all of it sideways a frame at a time.
    ///
    /// The 50%-of-travel rule has nothing to measure against here, so the direction decides:
    /// a committed rightward pan opens and a leftward one closes, and either way a fling in
    /// the opposite direction reverses it, which is `settlesOpen` with the progress pinned to
    /// where the drawer already was. A pan that asks for the state the sidebar is already in —
    /// a further left-swipe on a closed edge — settles as a no-op, but it *committed*, so the
    /// presses it crossed were still cancelled: that boundary case is exactly why commitment,
    /// not motion, is the trigger.
    private func drawerPanGesture(travel: CGFloat) -> DrawerPanGesture {
        DrawerPanGesture(
            onCommit: { _ in isPanCommitted = true },
            onChange: { _ in },
            onEnd: { translation, velocity in
                isPanCommitted = false
                let opens = DrawerReveal.settlesOpen(
                    progress: translation > 0 ? 1 : 0,
                    velocity: velocity
                )
                guard opens != uiState.isSessionsSidebarOpen else { return }
                withAnimation(DrawerReveal.settle(velocity: velocity, travel: travel)) {
                    if opens { uiState.openSessionsSidebar() } else { uiState.closeSessionsSidebar() }
                }
            }
        )
    }

    /// The way back to the board, as a push rather than as a tap: a left-swipe that starts in
    /// the board peek's own lane.
    ///
    /// **The peek keeps its tap, and the two do not compete.** A tap never travels
    /// `DrawerReveal.intentThreshold`, so the recogniser never commits and never cancels it; a
    /// swipe that does commit cancels the peek's tap recogniser natively, which is the one
    /// arbitration `DrawerPanRecognizer` exists to perform. Paint order does not enter into it —
    /// the peek is a sibling drawn later by `BoardScreen`, and a UIKit recogniser cannot see
    /// SwiftUI's paint order, which is exactly why the lane is stated as geometry here.
    ///
    /// **Commit-triggered, not tracked**, and settled by `TutorActions.returnToBoard` on the
    /// dock's shared spring. Board 05 states the panel and the column as two variants rather
    /// than one responsive view, so there is no position between them for a finger to hold; see
    /// `BoardScreen.returnToBoardFromPeek(velocity:)` for the whole argument and for what the
    /// spring is still worth. (The tracked container morph — `PresentationMorph` — is wired
    /// off for now: it froze the app on the iPadOS 17 device and the hang could not be
    /// reproduced or sampled from here, so the commit-time spring ships while that is run
    /// down. The arithmetic and its tests stay compiled.)
    ///
    /// It refuses Apple Pencil touches at touch-down, exactly as the leading zone does: a
    /// pencil in this app is always drawing and never navigating.
    private var peekEdgeZone: some View {
        DrawerPanGesture(
            ignoresPencil: true,
            onCommit: { translation in
                isPanCommitted = true
                isReturningToBoard = route(translation) == .enterDocked
                // The tracked morph, where the screen runs one: anchor at full screen and
                // let the flight layer render every frame from here to the release. A plain
                // write from a UIKit callback — no transaction — so the flight mounts
                // un-animated at its anchor.
                if isReturningToBoard, let flight {
                    flight.drag.begin(atFullScreen: true)
                    flight.onBegin()
                }
            },
            onChange: { translation in
                guard isReturningToBoard else { return }
                flight?.track(anchor: 1, translation: translation)
            },
            onEnd: { _, velocity in
                isPanCommitted = false
                guard isReturningToBoard else { return }
                isReturningToBoard = false
                // Tracked: the release rule needs the real position, and the settle is the
                // shell's — it owns the mounts the spring has to hold open.
                if let flight {
                    flight.onRelease(velocity)
                    return
                }
                // A release that flings back the way it came takes it back — the same rule the
                // sidebar's own commit-triggered swipe follows, with the progress pinned at the
                // destination and the sign mirrored: this axis is travelled leftward, so a
                // leftward velocity is a fling *toward* the board.
                guard DrawerReveal.settlesOpen(progress: 1, velocity: -velocity) else { return }
                actions.returnToBoard(velocity)
            }
        )
        .frame(
            width: HorizontalSwipeRouter.trailingEdgeZoneWidth,
            height: layout.contentHeight
        )
        .offset(x: layout.peekX, y: layout.contentTop)
    }

    private func route(_ translation: CGFloat) -> HorizontalSwipeRouter.Transition {
        guard let direction = HorizontalSwipeRouter.Direction.of(translation) else { return .none }
        return HorizontalSwipeRouter.transition(
            presentation: .fullScreen,
            isDrawerOpen: false,
            isSidebarOpen: uiState.isSessionsSidebarOpen,
            direction: direction,
            origin: .trailingEdge
        )
    }

    /// Screen 07: greeting at y 150, suggestion grid at y 592, composer bottom on 1004 —
    /// **as a flow, not as three constants.**
    ///
    /// The grid is what forced this. It wraps to one chip a row in any column narrower than
    /// 740 and becomes 356 tall instead of 168, so a grid pinned at 592 would have run 188
    /// points into the composer. Here the greeting and the grid are one stack with the board's
    /// own 174 between them, bottom-anchored the designed 164 above the composer, and all the
    /// slack lands on top: at the reference that slack reproduces 150 and 592 to the point,
    /// and where the grid grows the block rides up instead of down.
    ///
    /// **On a screen shorter than the board's, the gaps give before the block scrolls.** The
    /// greeting, the grid and the pill are rigid, so the 174 and the 164 compress in
    /// proportion until the whole hi state fits between the content top and the composer —
    /// see `TutorColumnMetrics.startGap(_:)`. An 820pt iPad was cropping its own orb off the
    /// top for the sake of air the design measured on a 1032pt screen. Scrolling remains,
    /// floored gaps and all, for the bands that are genuinely too short — Split View.
    ///
    /// **The block runs in the thread's own container, in the thread's own lane** — the same
    /// `ChatScrollColumn`, framed the same screen-top-to-content-floor band `threadColumn` is.
    /// It used to be its own pair of branches with its own scroll view, clipped to the start
    /// region, and that was the bug: the region's top edge was a hard line partway down the
    /// screen, so a column short enough to scroll cut the greeting off at it — where the
    /// thread beside it scrolls its history clean off the screen's own edge. Now the two
    /// fills share one answer. The composer's clearance travels as padding
    /// (`TutorColumnMetrics.startClearing`, the analogue of `threadClearing`), the container's
    /// bleed keeps the hero halo and the chips' `shadow/card` off the clip, and a band that
    /// holds the block does not scroll at all — `ChatScrollColumn` bounces only past its size,
    /// so the fitting case is pixel-identical to the boards.
    ///
    /// The block no longer moves for `btn/settings` at any width: board 19 takes the gear off
    /// this screen and gives it to the sessions drawer, so nothing is pinned in the corner for
    /// the column to give way to.
    ///
    /// Board 19 draws no other chrome either — the board peek is still the way back and the
    /// sidebar is a lane rather than a header — so this stays a bare column.
    ///
    /// The top padding is `column.top`: on a screen the band cannot hold at design gaps, the
    /// gaps compress until the block fits exactly between the content top and the composer —
    /// see `TutorColumnMetrics.startGap(_:)` — and this padding is what puts the orb *on*
    /// the content top rather than on the screen's raw edge. Where the block scrolls after
    /// all, it also keeps the greeting 28 clear of the edge at full scroll.
    private var startColumn: some View {
        ChatScrollColumn(width: column.width, anchor: .top) {
            startBlock
                .padding(.top, column.top)
                .padding(.bottom, column.startClearing)
        }
        .frame(width: column.width, height: column.threadHeight)
        .offset(x: column.x, y: column.threadTop)
    }

    /// The panel's own start fill — `TutorPanel.startFill`'s chain, in the reading column:
    /// the panel orb 120 below where the panel's chrome band would end, the greeting block
    /// `--spacing-10` under it, chips inside the block. Top-anchored as the panel's is —
    /// screen 05 measures the chain down from the top, so the slack lands below — which is
    /// why `startColumn` anchors `.top` and the fullScreen bottom-anchored gap compression
    /// is not consulted while this treatment stands. See `Self.scale`.
    private var startBlock: some View {
        VStack(spacing: 0) {
            Orb(.panel)
                // The flight layer's copy is the one on screen mid-morph; this one holds
                // its slot at opacity 0 so nothing reflows and nothing is unmounted.
                .opacity(isInPresentationFlight ? 0 : 1)
                // The panel's own `18 + 32 + 120` below its surface top. The block's own
                // `column.top` padding puts its head on the content line the panel's surface
                // sits on, so the orb lands on the same screen line it holds in the docked
                // panel — the morph's two endpoints agree about where the tutor's face is.
                .padding(
                    .top,
                    TutorPanelMetrics.inset + TutorPanelMetrics.controlsHeight + PanelStack.orbTopMargin
                )
            GreetingBlock(
                scale: Self.scale,
                width: column.width,
                onSelectSuggestion: actions.selectSuggestion
            )
            .padding(.top, DS.Space.s10)
        }
        .frame(width: column.width, alignment: .top)
    }

    /// The undesigned cell, built from the one board that measures a 740pt thread.
    ///
    /// `UIState.isUndesignedFullScreenThread` names this state and says what to do with it:
    /// *"the minimal obvious thing, the 740pt column with the thread where the greeting was,
    /// and not a layout that was never drawn."* Board 13 is that layout, measured: controls
    /// 68 → 100, thread 100 → 900, a 24pt gap, composer 924 → 1004. It reaches the same
    /// composer line screen 07 does, so only the region above it changes.
    private var threadColumn: some View {
        // No top fade: boards 07 and 13 no longer draw one over the head of the thread. The
        // bottom fade is untouched — it hangs off the composer in `body`, so the greeting state
        // gets the identical one.
        TutorThreadView(
            scale: Self.scale,
            width: column.width,
            clearing: column.threadClearing,
            actions: actions
        )
        .frame(width: column.width, height: column.threadHeight)
        .offset(x: column.x, y: column.threadTop)
    }

    /// Board 07 draws no marquee and no attachment card in the wide composer, so the resting
    /// state has neither. An attachment made on the board still shows, because
    /// `AttachmentStackMetrics.composer(.fullScreen)` is the extrapolation board 03 states
    /// for it — and a selection that was invisible here would be consumed by the next send
    /// without the student ever seeing it.
    ///
    /// The attach button is drawn at both scales and is independent of the marquee: this
    /// composer passes `selection: .unavailable` when nothing is attachable — board 07 draws
    /// no marquee in the wide pill — and the `+` is beside it either way. There is one
    /// attach control in the product and it is not a panel-scale affordance.
    /// Typed as `Composer` rather than `some View` so `attachMenu` can read `card` off it —
    /// see `TutorPanel.composer`.
    private var composer: Composer {
        Composer(
            scale: Self.scale,
            width: column.width,
            text: $text,
            selection: uiState.isSelectionAttached ? .attached : .unavailable,
            onSend: actions.send,
            onAttach: { isAttachMenuOpen = true },
            // See `TutorPanel.composer` — the refusal is silent without it.
            canAttach: !attachments.isFull && !attachments.isSending,
            onVoice: dictation.voiceHandler(text: $text),
            dictation: dictation.composerDictation,
            // Same slot and the same fixed priority as the panel's — see `TutorPanel`.
            note: attachments.failureNote ?? store.composerNote ?? dictation.noteText,
            onDismissSelection: actions.dismissSelection,
            attachments: attachments.pending,
            onRemoveAttachment: { attachments.remove($0) }
        )
    }

    /// Board 16's card, anchored the way the panel anchors it: bottom edge `gapAbovePill`
    /// clear of the pill's top, on the composer's own leading edge.
    ///
    /// The same anchor the panel uses — `ComposerSlotMetrics.attachMenuTop(in:over:)` — with
    /// the screen's floor as the surface: the slot's underhang is measured from it, exactly
    /// as the panel's is from the panel floor. Measured over the composer **with the
    /// card it is drawing**, or the menu lands on top of the chips.
    ///
    /// There is no surface radius to clip it here and no session menu to be an alternative
    /// to; the dismiss layer is the whole window rather than the panel, because that is
    /// what this surface covers.
    ///
    /// **The card is 301 here too, not the 740 column** — a menu's width follows its three
    /// short labels rather than the surface it is on. `x: column.x` puts its leading edge on
    /// the column's, which is the composer's own leading edge: left-aligned above the pill,
    /// not centred in the reading lane.
    @ViewBuilder
    private var attachMenu: some View {
        Color.clear
            .contentShape(.rect)
            .frame(width: layout.size.width, height: layout.size.height)
            .onTapGesture { isAttachMenuOpen = false }

        AttachMenu(width: AttachMenu.width(in: column.width)) { choice in
            isAttachMenuOpen = false
            pickerSource = AttachmentSource(choice)
        }
        .offset(
            x: column.x,
            y: slot.attachMenuTop(
                in: column.floor,
                over: ComposerMetrics.for(Self.scale, width: column.width)
                    .height(showing: composer.card)
            )
        )
    }
}

/// The reading column's lanes, on the screen the app is actually running on.
///
/// Screen 07's vertical rhythm, as the board writes it:
///
/// ```
/// 150  greeting top          → 68 + 82 slack
/// 418  greeting bottom       (150 + 268)
/// 174  gap
/// 592  suggestion grid top
/// 760  suggestion grid bottom (592 + 168)
/// 164  gap
/// 924  composer top
/// 1004 composer bottom        (the content band's own bottom)
/// ```
///
/// Two of those five numbers are the design's and hold: the **174** between the greeting and
/// its own chips, and the **164** between the chips and the composer. The other three —
/// the greeting's 268, the grid's 168 and the 82 above the greeting — are results. The first
/// two belong to the components and move with the column (a wrapped grid is 356); the 82 is
/// what is left over, and reading it as leftover rather than as a constant is the whole of
/// this type. `82 + 268 + 174 + 168 + 164 = 856 = 1004 − 68`, exactly, which is the check
/// that the two kept numbers are the right two.
struct TutorColumnMetrics: Equatable, Sendable {
    /// Screen 07's `418 → 592`. Inside the start block: the chips are the greeting's own
    /// openers, so this is a margin between two children and not air the layout may spend.
    /// The **designed** gap — what the block actually draws is `startGapAboveSuggestions`,
    /// which is this wherever the band can hold it.
    static let greetingToSuggestions: CGFloat = 174
    /// Screen 07's `760 → 924`. The block is anchored on this, the way the thread is anchored
    /// on `--space-gap`: *"the newest message is always the same distance from the input,
    /// which is where the eye already is."* Designed value; the drawn one is
    /// `startGapBelowSuggestions`.
    static let suggestionsToComposer: CGFloat = 164
    /// The air the boards' own screen leaves **above** the greeting: `162 − 28`, the slack
    /// screen 07's band has over its block. Not a margin anything draws — bottom-anchoring
    /// produces it as leftover — but it is part of the composition all the same: the hero
    /// hangs a third of the way down the band, not against its top edge. So it takes a
    /// weight in the compression alongside the two gaps, or a short screen spent all of it
    /// first and pressed the orb into the screen's corner. See `startGap(_:)`.
    static let greetingTopAir: CGFloat = 134
    /// The least either gap compresses to before the column gives up and scrolls —
    /// `--space-gap`, the smallest designed breathing room in the product.
    static let startGapFloor: CGFloat = DS.Space.gap

    /// `ScreenLayout.columnX(reserving:)` — centred in what is left of the screen once the
    /// 68pt peek and the sessions sidebar have their places.
    let x: CGFloat
    /// `min(740, region − 2 × edge)`.
    let width: CGFloat
    /// The content band's top and bottom, the same two lines every other screen is cut from.
    let top: CGFloat
    let bottom: CGFloat
    /// The screen's own floor. The full-screen chat surface is the screen, so this is the
    /// line its fills run to — the panel's floor is the panel's, and this is the analogue.
    let floor: CGFloat
    /// `GreetingMetrics.fullScreen` in this column — 268 at every width, since none of its
    /// parts is a function of the column.
    let greetingHeight: CGFloat
    /// 168 in the row the design drew, 356 where it wrapped.
    let suggestionsHeight: CGFloat
    /// The composer this column draws, kept whole rather than reduced to two heights.
    ///
    /// It used to be `composerHeight` and one `attachedComposerHeight`, and the second was
    /// wrong the moment the composer learned to hold files: it measured board 03's label
    /// card (120) while a composer showing chips is board 16's (132). *Which* card is drawn
    /// is a runtime fact, so the question has to be asked with the card named — see
    /// `ComposerCard` and `composerTop(showing:)`.
    private let composer: ComposerMetrics

    /// The resting pill — 68 in this column, at every width the scale is drawn at.
    var composerHeight: CGFloat { composer.height }

    /// The widest column the panel treatment is drawn in — see `TutorFullScreen.scale`.
    ///
    /// The panel's 17pt body was measured against a 301pt column; at the reading lane's full
    /// 740 the same type runs past ninety characters a line, which is not a measure anyone
    /// set. 600 keeps the line in the readable band while still being visibly the wide
    /// surface. It is a cap, not a size: a column the screen has already squeezed below it —
    /// portrait, Split View, the sidebar open — keeps the measured width, exactly as before.
    static let panelTreatmentColumnCap: CGFloat = 600

    /// The treatment the live reading column is drawn at — the experiment
    /// `TutorFullScreen.scale` documents. Here because this type is nonisolated, so the
    /// initialiser below can name it as a default; flip it back to `.fullScreen` to restore
    /// the boards' big variant everywhere at once.
    static let liveScale: ChatScale = .panel

    /// - Parameters:
    ///   - reserving: How much of the leading edge the sessions sidebar has taken —
    ///     board 19's 372 while it is open, and 0 otherwise, which is screen 07 unchanged.
    ///   - scale: The treatment the column is measured for. Defaults to what the live
    ///     surface draws (`TutorFullScreen.scale`); the tests that pin the boards' own
    ///     screen-07 arithmetic pass `.fullScreen` explicitly, because the design still
    ///     states the big variant — see `TutorFullScreen.scale` for the experiment.
    init(
        layout: ScreenLayout,
        reserving sidebar: CGFloat = 0,
        scale: ChatScale = TutorColumnMetrics.liveScale
    ) {
        let measured = layout.columnWidth(reserving: sidebar)
        // The cap binds only under the panel treatment; the `.fullScreen` scale keeps the
        // design's own `min(740, region − 2 × (peek + edge))` untouched.
        width = scale == .panel ? min(Self.panelTreatmentColumnCap, measured) : measured
        // The same centring rule `ScreenLayout.columnX(reserving:)` is, re-run with the
        // capped width so the narrower column stays on the region's own centre.
        x = layout.columnRegionX(reserving: sidebar)
            + (layout.columnRegionWidth(reserving: sidebar) - width) / 2
        top = layout.contentTop
        // The composer is anchored to this line, so it is the keyboard-aware one:
        // the column is the other surface that has to stay typed into. Identical
        // to `contentBottom` whenever no keyboard is up, which is every screen the
        // boards were drawn for.
        bottom = layout.contentBottomAboveKeyboard
        floor = layout.screenHeight
        greetingHeight = GreetingMetrics.for(scale, width: width).totalHeight
        suggestionsHeight = SuggestionChipMetrics.for(scale, width: width).containerHeight
        composer = ComposerMetrics.for(scale, width: width)
    }

    /// What sits under the pill inside the surface — the screen's edge inset below the
    /// content band, 28 on every screen with no keyboard up. The full-screen counterpart of
    /// the panel's 18pt underhang, and for the same reason: the composer's fade has to run
    /// to the surface's floor, and this surface's floor is the screen's. Without it the
    /// thread hard-clipped at the content band's bottom, a line 28 points above the screen
    /// edge, and the strip below it stayed blank white where the panel grades its text out.
    var underhang: CGFloat { max(0, floor - bottom) }

    /// Bottom-anchored on the content band, as both boards draw it. With something attached
    /// the block grows upward by that card's visible band, so the pill stays put — and the
    /// two cards are not the same band, which is why this takes the card rather than a bool.
    func composerTop(showing card: ComposerCard) -> CGFloat {
        bottom - composer.height(showing: card)
    }

    /// What the band offers the block's air once everything rigid has its height —
    /// greeting, grid and composer taken out of the contentTop→composer band. Exactly 472 on
    /// the reference screen, which is the design's three airs to the point: 134 above the
    /// greeting, 174 inside the block, 164 under the chips. On a shorter screen it is less,
    /// and all three give together: see `startGap(_:)`.
    private var startGapBudget: CGFloat {
        bottom - top - greetingHeight - suggestionsHeight - composerHeight
    }

    /// `134 + 174 + 164` — the whole of the vertical air screen 07 composes with.
    private static var designedStartAir: CGFloat {
        greetingTopAir + greetingToSuggestions + suggestionsToComposer
    }

    /// Screen 07's 174, on the screens that can afford it — and the block's compressed share
    /// of a shorter band everywhere else, so the whole hi state fits one screen instead of
    /// cropping its own orb. See `startGap(_:)`.
    var startGapAboveSuggestions: CGFloat { startGap(Self.greetingToSuggestions) }

    /// Screen 07's 164, compressed the same way and in the same proportion.
    var startGapBelowSuggestions: CGFloat { startGap(Self.suggestionsToComposer) }

    /// The designed gap, or its share of a band too short for the composition.
    ///
    /// The greeting, the grid and the composer are rigid — type leadings, chip heights, a
    /// pill — so on a screen shorter than the board's 1032 the only thing the block *can*
    /// give is its air, and it gives proportionally **in all three bands at once**: the two
    /// drawn gaps shrink by the budget's share of the designed 472, and what the gaps do not
    /// take is what bottom-anchoring leaves above the greeting — the top air's own share,
    /// shrunk by the same factor. Compressing only the gaps was tried first and read wrong:
    /// the slack above went to zero before either gap gave a point, and the hero sat pressed
    /// against the top of the screen while the block below it kept its full design air.
    ///
    /// Floored at `--space-gap` each; a band that cannot afford even that is genuinely too
    /// short for the block, and the column scrolls it exactly as the thread scrolls its
    /// history.
    private func startGap(_ designed: CGFloat) -> CGFloat {
        guard startGapBudget < Self.designedStartAir else { return designed }
        return max(Self.startGapFloor, startGapBudget * designed / Self.designedStartAir)
    }

    /// Greeting, the drawn gap, grid. The one rigid run in the column.
    var startContentHeight: CGFloat {
        greetingHeight + startGapAboveSuggestions + suggestionsHeight
    }

    /// What the start block clears at the bottom of the thread's band: the composer, the
    /// screen's underhang below it, and screen 07's 164 above it. The analogue of
    /// `threadClearing`, with the designed gap in place of `--space-gap` — and travelling as
    /// the block's own bottom padding, which is what bottom-anchors the chips 164 above the
    /// pill at every width. `260` on the reference screen, so the block's bottom lands on
    /// 772 and its slack reproduces the board's 150/592 above it.
    ///
    /// Measured against the **resting** composer, not the attached one. Board 07 draws no card
    /// in the wide composer at all; where the app shows one anyway — a selection made on the
    /// board has to be visible before it is sent — the card grows into its own 38pt band and
    /// the column above it does not move. A greeting that jumped 38 points the moment a
    /// selection was attached would be the composer redrawing the screen behind it.
    var startClearing: CGFloat { composerHeight + underhang + startGapBelowSuggestions }

    /// **The screen's own top, not the content band's.** The one lane in the product that does
    /// not start at `contentTop`, and it is the scroll view that makes it different.
    ///
    /// A `ScrollView` clips to its frame, so a thread starting at `contentTop` cuts its own text
    /// off at a hard edge — 48 points down a home-button iPad, 52 on one with a camera housing —
    /// with nothing but white above the cut. That reads as a frame hiding the conversation,
    /// because that is what it is. The docked panel never shows it: the text dissolves into the
    /// panel's top fade before it reaches the edge. This surface has no fade to dissolve into,
    /// so it gets the other half of the same answer — nothing above the thread at all, and the
    /// text scrolls freely off the top of the screen.
    ///
    /// `--space-edge` is not lost, it is just no longer a clip: the newest message still rests
    /// where the board draws it, and the band above only ever holds text on its way out.
    var threadTop: CGFloat { 0 }

    /// Screen top to the **screen's** floor, not the content band's. The surface's fills run
    /// edge to edge for the same reason the panel's run to the panel floor: a scroll view
    /// clips to its frame, and a frame stopping at the content band cut the text off at an
    /// invisible line 28 points above the screen edge, with blank white below it. The
    /// composer's fade covers the whole band from pill top to this floor — see `underhang` —
    /// so what passes under the pill grades out and ends on the screen's own edge.
    var threadHeight: CGFloat { max(0, floor - threadTop) }

    /// What the thread has to clear at the bottom: the composer, the underhang below it, and
    /// board 13's `--space-gap` above it.
    ///
    /// Against the **resting** composer, for the same reason `startClearing` is: a
    /// selection card grows the composer upward, and a thread that reflowed the moment a
    /// selection was attached would be the composer redrawing the conversation behind it.
    var threadClearing: CGFloat { composerHeight + underhang + DS.Space.gap }

}
