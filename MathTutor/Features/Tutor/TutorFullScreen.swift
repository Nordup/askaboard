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
/// 352 wide of 1376, and a narrower column, still centred past the peek, on anything smaller.
struct TutorFullScreen: View {
    @EnvironmentObject private var store: TutorStore
    @EnvironmentObject private var uiState: UIState
    /// Screen 07 is placed out of the same measurement every other lane is cut from — see
    /// `TutorColumnMetrics` for what it does with it.
    @Environment(\.screenLayout) private var layout
    @Binding var text: String
    @ObservedObject var dictation: DictationController
    let actions: TutorActions

    private var column: TutorColumnMetrics { TutorColumnMetrics(layout: layout) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            switch uiState.conversation {
            case .start: startColumn
            case .active: threadColumn
            }
            composer.offset(
                x: column.x,
                y: column.composerTop(isAttached: uiState.isSelectionAttached)
            )
        }
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
    /// There are no `Panel controls` here — board 07 draws none, and the board peek is the
    /// screen's only affordance. Adding the row would put chrome on a board that has none.
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
            .offset(x: column.x, y: column.top)
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
        Group {
            TutorControlsRow(
                width: column.width,
                onDock: uiState.collapseTutor,
                onFullScreen: uiState.expandTutorToFullScreen,
                onSettings: actions.openSettings
            )
            .offset(x: column.x, y: column.top)

            TutorThreadView(scale: .fullScreen, width: column.width, actions: actions)
                .frame(width: column.width, height: column.threadHeight)
                .offset(x: column.x, y: column.threadTop)
        }
    }

    /// Board 07 draws no marquee and no attachment card in the wide composer, so the resting
    /// state has neither. An attachment made on the board still shows, because
    /// `AttachmentStackMetrics.composer(.fullScreen)` is the extrapolation board 03 states
    /// for it — and a selection that was invisible here would be consumed by the next send
    /// without the student ever seeing it.
    private var composer: some View {
        Composer(
            scale: .fullScreen,
            width: column.width,
            text: $text,
            selection: uiState.isSelectionAttached ? .attached : .unavailable,
            onSend: actions.send,
            onVoice: dictation.voiceHandler(text: $text),
            dictation: dictation.composerDictation,
            note: dictation.noteText,
            onDismissSelection: actions.dismissSelection
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

    /// `ScreenLayout.columnX` — centred in what is left of the screen once the 68pt peek has
    /// its place.
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
    /// The resting pill, and the pill with a selection card grown behind it.
    let composerHeight: CGFloat
    let attachedComposerHeight: CGFloat

    init(layout: ScreenLayout) {
        x = layout.columnX
        width = layout.columnWidth
        top = layout.contentTop
        bottom = layout.contentBottom
        greetingHeight = GreetingMetrics.for(.fullScreen, width: layout.columnWidth).totalHeight
        suggestionsHeight = SuggestionChipMetrics.for(.fullScreen, width: layout.columnWidth)
            .containerHeight
        let composer = ComposerMetrics.for(.fullScreen, width: layout.columnWidth)
        composerHeight = composer.height
        attachedComposerHeight = composer.attachedHeight
    }

    /// Bottom-anchored on the content band, as both boards draw it. With a selection attached
    /// the block grows upward by the card's visible band, so the pill stays put.
    func composerTop(isAttached: Bool) -> CGFloat {
        bottom - (isAttached ? attachedComposerHeight : composerHeight)
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
        max(0, composerTop(isAttached: false) - Self.suggestionsToComposer - top)
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
    var greetingTop: CGFloat { top + startSlack }

    /// `150 + 268 + 174 = 592` on the reference screen.
    var suggestionsTop: CGFloat { greetingTop + greetingHeight + Self.greetingToSuggestions }

    /// Board 13: the thread starts where the controls row ends.
    var threadTop: CGFloat { top + TutorPanelMetrics.controlsHeight }

    /// Board 13: `--space-gap` between the thread's bottom and the composer.
    var threadHeight: CGFloat {
        max(0, composerTop(isAttached: false) - DS.Space.gap - threadTop)
    }
}
