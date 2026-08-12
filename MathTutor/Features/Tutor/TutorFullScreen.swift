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
        .fullScreen(columnWidth: column.width, underhang: column.underhang)
    }

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
            ComposerSlot(metrics: slot, surfaceColor: DS.Color.surface) { composer }
                .offset(x: column.x, y: column.floor - slot.band)

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
            onCommit: { isPanCommitted = true },
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

    /// The screen's own axes, re-derived for the session that just opened — the same three
    /// `TutorPanel.adoptSessionUI` re-derives, for the same reasons. Both surfaces can open a
    /// session now, so both have to.
    private func adoptSessionUI() {
        uiState.clearBoardSelection()
        attachments.clear()
        uiState.showConversation(store.hasGoal ? .active : .start)
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
        ChatScrollColumn(width: column.width) {
            startBlock
                .padding(.top, column.top)
                .padding(.bottom, column.startClearing)
        }
        .frame(width: column.width, height: column.threadHeight)
        .offset(x: column.x, y: column.threadTop)
    }

    /// Greeting, the drawn gap, grid — the one rigid run in the column.
    private var startBlock: some View {
        VStack(spacing: 0) {
            GreetingBlock(scale: .fullScreen, width: column.width) { Orb(.hero) }

            SuggestionList(
                scale: .fullScreen,
                width: column.width,
                onSelect: actions.selectSuggestion
            )
            .padding(.top, column.startGapAboveSuggestions)
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
            scale: .fullScreen,
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
            scale: .fullScreen,
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
                over: ComposerMetrics.for(.fullScreen, width: column.width)
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

    /// - Parameter reserving: How much of the leading edge the sessions sidebar has taken —
    ///   board 19's 372 while it is open, and 0 otherwise, which is screen 07 unchanged.
    init(layout: ScreenLayout, reserving sidebar: CGFloat = 0) {
        x = layout.columnX(reserving: sidebar)
        width = layout.columnWidth(reserving: sidebar)
        top = layout.contentTop
        // The composer is anchored to this line, so it is the keyboard-aware one:
        // the column is the other surface that has to stay typed into. Identical
        // to `contentBottom` whenever no keyboard is up, which is every screen the
        // boards were drawn for.
        bottom = layout.contentBottomAboveKeyboard
        floor = layout.screenHeight
        greetingHeight = GreetingMetrics.for(.fullScreen, width: width).totalHeight
        suggestionsHeight = SuggestionChipMetrics.for(.fullScreen, width: width).containerHeight
        composer = ComposerMetrics.for(.fullScreen, width: width)
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

    /// What the band offers the block's two designed gaps once everything rigid has its
    /// height — greeting, grid and composer taken out of the contentTop→composer band.
    /// 472 on the reference screen, which is more than the design's 338, and the surplus is
    /// the slack that lands above the greeting. On a shorter screen it is less, and the gaps
    /// are what give: see `startGap(_:)`.
    private var startGapBudget: CGFloat {
        bottom - top - greetingHeight - suggestionsHeight - composerHeight
    }

    /// `174 + 164` — the vertical air screen 07 draws inside and under the block.
    private static var designedStartGaps: CGFloat { greetingToSuggestions + suggestionsToComposer }

    /// Screen 07's 174, on the screens that can afford it — and the block's compressed share
    /// of a shorter band everywhere else, so the whole hi state fits one screen instead of
    /// cropping its own orb. See `startGap(_:)`.
    var startGapAboveSuggestions: CGFloat { startGap(Self.greetingToSuggestions) }

    /// Screen 07's 164, compressed the same way and in the same proportion.
    var startGapBelowSuggestions: CGFloat { startGap(Self.suggestionsToComposer) }

    /// The designed gap, or its share of a band too short for the pair.
    ///
    /// The greeting, the grid and the composer are rigid — type leadings, chip heights, a
    /// pill — so on a screen shorter than the board's 1032 the only thing the block *can*
    /// give is its air, and it gives proportionally: both gaps shrink by the same factor, so
    /// the block keeps its shape rather than losing one gap to the other. Floored at
    /// `--space-gap` each; a band that cannot afford even that is genuinely too short for
    /// the block, and the column scrolls it exactly as the thread scrolls its history.
    private func startGap(_ designed: CGFloat) -> CGFloat {
        guard startGapBudget < Self.designedStartGaps else { return designed }
        return max(Self.startGapFloor, startGapBudget * designed / Self.designedStartGaps)
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
