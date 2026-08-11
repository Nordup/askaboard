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

    /// How much of the leading edge the sessions sidebar has taken — board 19's 372 while it
    /// is open, nothing while it is not.
    ///
    /// The one number the whole of this surface reads off the drawer. It is the settled state
    /// and never a live drag position, unlike the docked panel's: see `drawerPan(travel:)`.
    private var sidebar: CGFloat {
        uiState.isSessionsDrawerOpen ? layout.sessionsSidebarWidth : 0
    }

    private var column: TutorColumnMetrics {
        TutorColumnMetrics(layout: layout, reserving: sidebar)
    }
    /// The composer and the band behind it, as one thing. See `ComposerSlotMetrics`.
    private var slot: ComposerSlotMetrics { .fullScreen(columnWidth: column.width) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            chatSurface
            sessionsSidebar

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
            ComposerSlot(metrics: slot, surfaceColor: DS.Color.surface) { composer }
                .offset(x: column.x, y: column.bottom - slot.band)

            if isAttachMenuOpen {
                attachMenu
            }
        }
        // The same right-swipe the docked panel takes — board 19: *"The same right-swipe still
        // opens the sidebar, and a left-swipe closes it."* Simultaneous, and locked to an axis
        // on the first frame, exactly as the panel's is.
        .simultaneousGesture(drawerPan(travel: layout.sessionsSidebarWidth))
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
        if uiState.isSessionsDrawerOpen {
            SessionsDrawer(
                sessions: store.sessions,
                currentID: store.session.id,
                width: layout.sessionsSidebarWidth,
                inset: SessionsDrawerMetrics.sidebarInset,
                height: layout.screenHeight,
                onNewChat: {
                    closeSidebar()
                    store.startNewSession()
                    adoptSessionUI()
                },
                onOpen: { id in
                    closeSidebar()
                    store.openSession(id: id)
                    adoptSessionUI()
                },
                onSettings: {
                    closeSidebar()
                    actions.openSettings()
                }
            )
            .offset(x: layout.sessionsSidebarX)
            .transition(.move(edge: .leading))
        }
    }

    // MARK: - The reveal gesture

    /// Board 19's swipe, arbitrated exactly as the panel's is.
    ///
    /// The intent lock is the same rule and the same threshold, so a vertical drag scrolls the
    /// thread and a horizontal one reaches for the sidebar; the difference is that this one
    /// commits on release rather than tracking, so there is no live progress to publish and no
    /// scroll to suppress mid-touch — the thread never gives a frame up to a gesture that ends
    /// up being the sidebar's.
    ///
    /// The 50%-of-travel rule has nothing to measure against here, so the direction decides:
    /// a committed rightward pan opens and a leftward one closes, and either way a fling in
    /// the opposite direction reverses it, which is `settlesOpen` with the progress pinned to
    /// where the drawer already was.
    private func drawerPan(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: DrawerReveal.intentThreshold, coordinateSpace: .local)
            .onEnded { value in
                guard DrawerReveal.axis(for: value.translation) == .horizontal else { return }
                let opens = DrawerReveal.settlesOpen(
                    progress: value.translation.width > 0 ? 1 : 0,
                    velocity: value.velocity.width
                )
                guard opens != uiState.isSessionsDrawerOpen else { return }
                withAnimation(DrawerReveal.settle(velocity: value.velocity.width, travel: travel)) {
                    if opens { uiState.openSessionsDrawer() } else { uiState.closeSessionsDrawer() }
                }
            }
    }

    private func closeSidebar() {
        uiState.closeSessionsDrawer()
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
    /// slack lands on top: at the reference that slack is 82 and reproduces 150 and 592 to the
    /// point, and where the grid grows the block rides up instead of down. `TutorColumnMetrics`
    /// is that arithmetic.
    ///
    /// It scrolls where the band cannot hold it — a landscape Split View window can be 190
    /// points short of a wrapped grid — for the reason `ToolRail` scrolls: every designed value
    /// survives, every chip stays reachable and legal to tap, and nothing new is drawn.
    ///
    /// **The scroll view exists only in that case**, and the switch is `ToolRailMetrics.Fit`'s:
    /// the column knows both heights, so it can say which branch it is in rather than having a
    /// container work it out. A scroll view clips to its bounds, and the block's outermost marks
    /// are a hero halo that spills 77 points past the orb and a row of chips whose `shadow/card`
    /// bleeds past the last one — so wrapping a column that fits would cost exactly the pixels
    /// this port is diffed on.
    ///
    /// The block no longer moves for `btn/settings` at any width: board 19 takes the gear off
    /// this screen and gives it to the sessions drawer, so nothing is pinned in the corner for
    /// the column to give way to. See `TutorColumnMetrics.columnTop`.
    ///
    /// Board 19 draws no other chrome either — the board peek is still the way back and the
    /// sidebar is a lane rather than a header — so this stays a bare column.
    @ViewBuilder
    private var startColumn: some View {
        if column.startScrolls {
            ScrollView(.vertical, showsIndicators: false) {
                // `justify-content: flex-end`, the rule the thread beside it is built on: the
                // block sits on the bottom of the band, so the chips stay by the composer and
                // it is the greeting that goes over the top edge.
                startBlock.frame(minHeight: column.startRegionHeight, alignment: .bottom)
            }
            .frame(width: column.width, height: column.startRegionHeight)
            .scrollBounceBehavior(.basedOnSize)
            .defaultScrollAnchor(.bottom)
            .offset(x: column.x, y: column.columnTop)
        } else {
            startBlock.offset(x: column.x, y: column.greetingTop)
        }
    }

    /// Greeting, the board's 174, grid — the one rigid run in the column, and the same view in
    /// both branches so the two cannot drift apart.
    private var startBlock: some View {
        VStack(spacing: 0) {
            GreetingBlock(scale: .fullScreen, width: column.width) { Orb(.hero) }

            SuggestionList(
                scale: .fullScreen,
                width: column.width,
                onSelect: actions.selectSuggestion
            )
            .padding(.top, TutorColumnMetrics.greetingToSuggestions)
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
    /// the content band's floor as the surface, since that is the line the composer slot is
    /// offset to and this surface has no underhang. Measured over the composer **with the
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
                in: column.bottom,
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
    static let greetingToSuggestions: CGFloat = 174
    /// Screen 07's `760 → 924`. The block is anchored on this, the way the thread is anchored
    /// on `--space-gap`: *"the newest message is always the same distance from the input,
    /// which is where the eye already is."*
    static let suggestionsToComposer: CGFloat = 164

    /// `ScreenLayout.columnX(reserving:)` — centred in what is left of the screen once the
    /// 68pt peek and the sessions sidebar have their places.
    let x: CGFloat
    /// `min(740, region − 2 × edge)`.
    let width: CGFloat
    /// The content band's top and bottom, the same two lines every other screen is cut from.
    let top: CGFloat
    let bottom: CGFloat
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
        greetingHeight = GreetingMetrics.for(.fullScreen, width: width).totalHeight
        suggestionsHeight = SuggestionChipMetrics.for(.fullScreen, width: width).containerHeight
        composer = ComposerMetrics.for(.fullScreen, width: width)
    }

    /// Bottom-anchored on the content band, as both boards draw it. With something attached
    /// the block grows upward by that card's visible band, so the pill stays put — and the
    /// two cards are not the same band, which is why this takes the card rather than a bool.
    func composerTop(showing card: ComposerCard) -> CGFloat {
        bottom - composer.height(showing: card)
    }

    /// The band the start block flows in: the content top down to the designed 164 above the
    /// composer.
    ///
    /// Measured against the **resting** composer, not the attached one. Board 07 draws no card
    /// in the wide composer at all; where the app shows one anyway — a selection made on the
    /// board has to be visible before it is sent — the card grows into its own 38pt band and
    /// the column above it does not move. A greeting that jumped 38 points the moment a
    /// selection was attached would be the composer redrawing the screen behind it.
    var startRegionHeight: CGFloat {
        max(0, composerTop(showing: .none) - Self.suggestionsToComposer - columnTop)
    }

    /// Greeting, the board's 174, grid. The one rigid run in the column.
    var startContentHeight: CGFloat {
        greetingHeight + Self.greetingToSuggestions + suggestionsHeight
    }

    /// What the band has over the block — 82 on the reference screen, and 0 where the wrapped
    /// grid has taken it all. Clamped, so an overflowing column starts at the top of the band
    /// and scrolls rather than being pulled up off its own greeting; `ThreadMetrics.offsets`
    /// clamps the same slack for the same reason.
    var startSlack: CGFloat { max(0, startRegionHeight - startContentHeight) }

    /// Whether the band can hold the block at all. The same question `ToolRailMetrics.fit`
    /// asks, and the answer decides whether there is a scroll view in the tree — see
    /// `TutorFullScreen.startColumn` for why that has to be a decision and not a default.
    var startScrolls: Bool { startContentHeight > startRegionHeight }

    /// `68 + 82 = 150` on the reference screen.
    var greetingTop: CGFloat { columnTop + startSlack }

    /// `150 + 268 + 174 = 592` on the reference screen.
    var suggestionsTop: CGFloat { greetingTop + greetingHeight + Self.greetingToSuggestions }

    /// The top of the band the column's content may use — the content top, now, at every
    /// width.
    ///
    /// It used to give way by one 32pt control band on any window narrow enough for the
    /// column to reach `btn/settings` in the screen's corner. There is no gear on this screen
    /// any more: board 19 moves settings into the sessions drawer, which owns its own lane and
    /// never overlaps the column at all. So the reservation goes with the control that needed
    /// it, and the narrow-window column gets its 32 points back.
    ///
    /// Kept as a property rather than folded into `top` because it is a different claim — the
    /// band the *content* may use, as against the band the screen leaves — and the next thing
    /// pinned to this corner will need it back.
    var columnTop: CGFloat { top }

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

    /// Screen top to the content band's floor. The composer is painted over its foot rather
    /// than sitting below it — see `threadClearing`, which is what holds the newest message off
    /// the pill.
    var threadHeight: CGFloat { max(0, bottom - threadTop) }

    /// What the thread has to clear at the bottom: the composer, and board 13's
    /// `--space-gap` above it.
    ///
    /// Against the **resting** composer, for the same reason `startRegionHeight` is: a
    /// selection card grows the composer upward, and a thread that reflowed the moment a
    /// selection was attached would be the composer redrawing the conversation behind it.
    var threadClearing: CGFloat { composerHeight + DS.Space.gap }

}
