import SwiftUI

/// Screen anatomy, from board 09 — kept as the arithmetic rather than as its results.
///
/// Board blurb: *"The product is a single fixed device layout — one screen size, iPad Pro
/// 13-inch landscape, no breakpoints and no responsive reflow. Every position on this board
/// is therefore an absolute value you can type straight into a layout constraint."* And on
/// the invariants: *"Nothing here is derived at runtime."*
///
/// That held right up until the app was installed on an iPad 6th generation — 1024 × 768 —
/// where the tutor panel's absolute x 1011…1348 is entirely off the right edge. The fix is
/// not a scale factor. Read the board again and every one of its numbers is already a
/// derivation, written out longhand:
///
/// ```
/// board width  = 1376 − 28 − 337 − 24 − 72 − 24 − 28 = 863
/// content top  = 0 + 28 = 28
/// safe band    = 1032 − 28 − 28 = 976
/// collapsed    = 863 + 24 + 337 = 1224
/// column x     = 0 + (1376 − 68 − 740) ÷ 2 = 284
/// ```
///
/// **The lanes read left to right: panel, rail, board.** The redesign mirrors the shell — the
/// tutor takes the leading edge, the rail sits between the tutor and the canvas, and the board
/// runs to the trailing edge inset. Collapsing the tutor takes the panel and one gap out of
/// the row, so the rail slides into the leading position and the board absorbs the rest. That
/// is why the rail and the board each publish two x's rather than one: their lane depends on
/// whether the panel is in the row, which is the screen's decision and not this type's.
///
/// Only the left-hand operand of each is device-specific. Substituting the real width, the
/// real height and the real status-bar bottom for 1376, 1032 and 0 is therefore *more*
/// faithful to the board than the constants were: the constants were the answers, and this
/// type is the working. `ScreenLayout.reference` feeds the board's own three numbers back in
/// and reproduces every published value to the point — `LayoutTests` asserts each one.
///
/// **The boards reserve nothing at the top.** They once drew a 24pt status band at y 16 and
/// measured content from `40 + 28 = 68`; the 16 was a drawing's margin that no iPad reports,
/// and the band itself is gone, so the boards inset 28 from the glass on all four sides.
/// The app does **not** hide the system bar, so on device `safeAreaTop` is what iPadOS
/// reserves and `contentTop` is 24 + 28 = 52 — the same expression with a different number in
/// it. `reference` is the boards' screen; a measured layout is the device's.
///
/// **What is fixed and what flexes.** The rail is 72 because `--container-rail` says *"fixed —
/// the rail never resizes"*. The dock still starts at the design's 337pt width, while a
/// student may resize it within the usable range below. The board absorbs the remaining
/// width and the safe band absorbs the remaining height.
///
/// Named `ScreenLayout` rather than `Layout` because SwiftUI ships a `Layout` protocol. Swift
/// resolves the bare name to this type — a module prefers its own — so the shorter name did
/// compile, but every tool that reads the code without building it reported the SwiftUI
/// protocol instead, and a reader has no way to tell which one a call site meant.
///
/// Cheap by construction: it stores the six numbers it was handed and computes the rest on
/// read, so it costs nothing to make, nothing to copy into the environment, and `Equatable`
/// compares inputs rather than twenty-five outputs.
struct ScreenLayout: Equatable, Sendable {
    /// The window's full size — not the safe-area-inset size. Insets arrive separately because
    /// every edge inset in the design is measured from the **obstruction, not the glass**: the
    /// top from the status bar, the bottom from the home indicator, the sides from whatever the
    /// system reserves there. One rule, four edges — see `contentTop`.
    let size: CGSize

    let safeAreaTop: CGFloat
    let safeAreaLeading: CGFloat
    let safeAreaTrailing: CGFloat
    let safeAreaBottom: CGFloat

    /// How far the software keyboard reaches **past the device's own bottom
    /// inset**, and deliberately not folded into `safeAreaBottom`.
    ///
    /// Past, not from the screen edge, because the keyboard is drawn over the
    /// home indicator: the two are alternatives, and a sum would be 20 points of
    /// double-counting. Stated as the difference, `safeAreaBottom + keyboardInset`
    /// is the obstruction either way and no case needs a `max`.
    ///
    /// SwiftUI reports the keyboard as a bottom safe-area inset like any other,
    /// and folding it in there is what this separation exists to undo: it made
    /// `contentHeight` — and with it the board, the rail and the peek — shrink
    /// by ~350 points the moment a student tapped the composer. On the board
    /// that was not cosmetic. A marquee region picked before the keyboard opened
    /// stopped intersecting the canvas's own bounds, so `snapshotData` returned
    /// nil and the send silently degraded to a text-only turn: the learner
    /// pointed at their working, typed a question, and the tutor was handed the
    /// question with no picture. See `BoardSelection`.
    ///
    /// So the two answers are kept apart. `contentHeight` is the *screen's*
    /// band and never moves for a keyboard; `contentHeightAboveKeyboard` is the
    /// one for a surface that has to stay reachable while typing, which is the
    /// tutor panel and the full-screen column and nothing else. The board is an
    /// infinite scrolling canvas — a keyboard over its bottom edge costs
    /// nothing, and resizing it costs the selection.
    let keyboardInset: CGFloat

    /// What the student has asked the docked panel to be, clamped by whoever set it.
    ///
    /// Board 02 called the panel *"the only fixed-width surface in the product"*, and for as
    /// long as the product was one device that was a description rather than a constraint.
    /// It is now an input, which changes nothing about the arithmetic below — `panelX` and
    /// `boardWidthDocked` were always written as subtractions from this number, so they
    /// follow for free.
    ///
    /// The design's 337 is the default, not a resize boundary: see `defaultPanelWidth` and
    /// `minimumPanelWidth`.
    let panelWidth: CGFloat

    /// Insets are `EdgeInsets` at the boundary (that is what `GeometryProxy` hands you) and
    /// scalars inside, so the type is trivially `Sendable` and its `Equatable` is four
    /// comparisons rather than a nested struct's.
    ///
    /// `panelWidth` arrives the same way and for the same reason the size does: it is an
    /// input the screen knows and the layout does not. It defaults to `--container-panel`,
    /// so every existing call site — and every preview, gallery specimen and test that never
    /// passes one — lays out exactly as it did when the panel was a constant.
    init(
        size: CGSize,
        safeArea: EdgeInsets = EdgeInsets(),
        panelWidth: CGFloat = ScreenLayout.defaultPanelWidth,
        keyboardInset: CGFloat = 0
    ) {
        self.size = size
        safeAreaTop = safeArea.top
        safeAreaLeading = safeArea.leading
        safeAreaTrailing = safeArea.trailing
        safeAreaBottom = safeArea.bottom
        self.panelWidth = panelWidth
        self.keyboardInset = max(0, keyboardInset)
    }

    // MARK: - The reference device

    /// iPad Pro 13-inch landscape, the one device board 09 was drawn against.
    ///
    /// This is a fixture, not a re-derivation: the three numbers are read off the board, so
    /// the regression suite compares the model's output against the design rather than
    /// against itself. It is also the environment default, which means a view that never
    /// gets measured behaves exactly as it did before this file changed.
    static let reference = ScreenLayout(
        size: CGSize(width: DS.Container.screen, height: referenceHeight),
        // Nothing reserved on any edge, because the boards reserve nothing: they were drawn
        // with no status bar and every panel inset 28 from the glass. This is the fixture that
        // reproduces `design/reference/*.png`, so it takes the boards' numbers — a device with
        // its status bar showing reports 24 here and lands `contentTop` at 52 instead.
        safeArea: EdgeInsets()
    )

    /// `--container-screen` carries the reference width; the export has no height token, so
    /// the other half of `1376 × 1032` lives here.
    static let referenceHeight: CGFloat = 1032

    // MARK: - Screen

    var screenWidth: CGFloat { size.width }
    var screenHeight: CGFloat { size.height }

    /// What is left across once the system's own furniture comes off. Every horizontal lane
    /// is cut out of this, not out of `size.width`.
    var usableWidth: CGFloat { max(0, size.width - safeAreaLeading - safeAreaTrailing) }

    // MARK: - Status region and vertical lanes

    /// Where the system's status region ends — the y that `--space-edge` is measured down from.
    ///
    /// **No floor, and do not restore one.** This was `max(safeAreaTop, 40)`, on the reading that board
    /// 09's `y 0 … 16 screen top padding above the status bar` plus its 24pt band was the
    /// shortest status region the app would ever see. It is not a region any device reserves:
    /// landscape reports 24 where there is a camera housing and 20 where there is a home
    /// button, and **no iPad reports 40**. The 16 is the air above the band on the *board* —
    /// a drawing's margin, not hardware — so flooring at 40 silently spent 16 points of every
    /// real screen buying back a gap that does not exist on it.
    ///
    /// It is therefore the inset, unmodified — 24 on a landscape iPad with a camera housing,
    /// 20 with a home button, and 0 only where nothing is reserved, which is what the boards
    /// draw and what `reference` supplies. It stays an expression rather than becoming a
    /// constant because the value is whatever the window reports, so a Split View or a new
    /// device needs no special case anywhere.
    var statusBarBottom: CGFloat { safeAreaTop }

    /// `--space-edge` measured from the **obstruction, not the glass**. This is the rule the
    /// whole vertical model turns on, and `contentBottom` is the same sentence.
    ///
    /// Board 01 states the token as 28 *"on all four sides"*, and the boards reserve nothing
    /// above the content, so on the drawing every edge gets it literally: *"content starts at
    /// 0 + 28 = 28."* They used to measure the top from a 40pt status band instead, which is
    /// the same rule — the inset applied to the nearest obstruction — evaluated back when there
    /// was an obstruction to apply it to.
    ///
    /// So: `24 + 28 = 52` on a landscape iPad with its status bar showing, which is what the
    /// app ships; `20 + 28 = 48` on a home-button one; and `0 + 28 = 28` where nothing is
    /// reserved, which is the boards' own screen and `reference`. None of those is a special
    /// case; they are one expression with a different number in it.
    var contentTop: CGFloat { statusBarBottom + DS.Space.edge }

    /// `--space-edge` from the bottom obstruction: the home indicator where there is one, the
    /// screen's edge where there is not. **The same rule as `contentTop`, not a second one** —
    /// both are `safe inset + --space-edge`, so content keeps 28 points of air from whatever is
    /// nearest on either edge. `LayoutTests` asserts the two as one rule rather than leaving
    /// them to look like a coincidence.
    ///
    /// The alternative considered was `max(--space-edge, safeAreaBottom)`, which reads the
    /// indicator as already *being* the air. It is not: against a 20pt indicator that leaves
    /// content 8 points clear of it — cramped next to the 28 every other edge gets, and close
    /// enough that the composer's own shadow reaches the indicator. Nothing on the top edge is
    /// measured that way either; the status bar is cleared by 28, not overlapped by 8.
    var contentBottom: CGFloat { size.height - safeAreaBottom - DS.Space.edge }

    /// `1032 − 28 − 28 = 976`. The safe band is the height lane with give in it, so it takes
    /// whatever the status region and the two edge insets leave.
    var contentHeight: CGFloat { max(0, contentBottom - contentTop) }

    /// `contentBottom`, raised to clear the software keyboard.
    ///
    /// The same rule `contentTop` and `contentBottom` are, against one more
    /// obstruction: `--space-edge` from whatever is nearest, and while a student
    /// is typing the nearest thing is the keyboard. With none up `keyboardInset`
    /// is zero and this *is* `contentBottom`, which is why every surface that
    /// took the one number before this existed can keep taking it.
    var contentBottomAboveKeyboard: CGFloat {
        size.height - safeAreaBottom - keyboardInset - DS.Space.edge
    }

    /// The band for a surface that has to stay reachable while the student is
    /// typing into it: the tutor panel and the full-screen column.
    ///
    /// **Not the board's.** See `keyboardInset` for what shrinking the board
    /// costs — this is the half of that split that flexes, and it is spent on
    /// the two surfaces that own a composer.
    var contentHeightAboveKeyboard: CGFloat { max(0, contentBottomAboveKeyboard - contentTop) }

    // MARK: - Horizontal lanes, docked layout (screens 05 and 08)

    /// `0 + 28 = 28` — the left edge everything is measured out from, and the mirror of
    /// `contentRight`. `--space-edge` from the leading obstruction, the same rule `contentTop`
    /// and `contentBottom` are.
    var contentLeft: CGFloat { safeAreaLeading + DS.Space.edge }

    /// `1376 − 28 = 1348` — the right edge the board is measured back from.
    var contentRight: CGFloat { size.width - safeAreaTrailing - DS.Space.edge }

    /// `28` — the tutor takes the leading edge, and it is the one lane whose position does not
    /// depend on anything else in the row.
    ///
    /// It used to be `contentRight − panelWidth`, pinned to the trailing edge. Pinned leading
    /// it needs no clamp: `panelWidth` is a caller-supplied input, and a panel too wide for the
    /// window now overflows the *board's* lane — which `boardWidthDocked` clamps and `fit`
    /// refuses — rather than being pushed off the front of the screen.
    var panelX: CGFloat { contentLeft }

    /// `28 + 337 + 24 = 389` — the rail sits between the tutor and the canvas, so its lane
    /// starts where the panel ends. **The docked position**; see `railXCollapsed`.
    var railX: CGFloat { panelX + panelWidth + DS.Space.gap }

    /// `--space-edge` from the leading edge. With no panel in the row the rail takes the
    /// leading position, which is what screen 06 draws.
    var railXCollapsed: CGFloat { contentLeft }

    /// `--container-rail`, *"fixed — the rail never resizes"*. Height is fit-content and
    /// belongs to the rail component.
    static let railWidth: CGFloat = DS.Container.rail
    var railWidth: CGFloat { Self.railWidth }

    /// `389 + 72 + 24 = 485` — rail + gap, in the docked row.
    var boardX: CGFloat { railX + Self.railWidth + DS.Space.gap }

    /// `28 + 72 + 24 = 124` — the same sum with the panel and one gap taken out of the row.
    var boardXCollapsed: CGFloat { railXCollapsed + Self.railWidth + DS.Space.gap }

    /// `1376 − 28 − 337 − 24 − 72 − 24 − 28 = 863` — the width left over once both edge
    /// insets, the panel, the rail and both gaps come off. Written here as the distance from
    /// the board's own left edge to the trailing edge inset, which is the same arithmetic with
    /// the terms collected, and which cannot drift out of step with `boardX`.
    ///
    /// Clamped at 0 rather than allowed to go negative: below `Self.dockedMinimumWidth` this
    /// state does not fit at all, and `fit` says so out loud instead of handing a caller a
    /// negative frame.
    var boardWidthDocked: CGFloat { max(0, contentRight - boardX) }

    /// `863 + 337 + 24 = 1224` — the board absorbs the panel and the gap the row no longer
    /// holds, so it runs from the collapsed rail's right edge to the screen's edge inset.
    var boardWidthCollapsed: CGFloat { max(0, contentRight - boardXCollapsed) }

    /// Where the resize strip's left edge sits — one `--space-panel-inset` back inside the
    /// panel's trailing edge, so the strip covers the panel's dead margin and the whole gutter
    /// between the panel and the rail.
    ///
    /// Published so both the strip's drawing code and its tests read the same number instead of
    /// each writing the expression at its own call site. That duplication is exactly how
    /// this file's own reference-render test used to go tautological: the test's private copy of
    /// the expression could never disagree with a re-derivation of itself, so a bug in the real
    /// call site had nothing to fail against. One property, read by both, closes that gap.
    ///
    /// **The strip changed sides with the panel, and the neighbour it leans on changed with
    /// it.** It used to run from `panelX − --space-gap` into the gutter between the board and a
    /// trailing panel; the panel now leads, so the strip runs from the panel's trailing edge
    /// and the surface on the other side of the gutter is the rail. Both surfaces still keep
    /// every point of their own content: the strip claims `--space-panel-inset`, which board 02
    /// specs as dead margin inside the panel, plus the `--space-gap` of empty screen-grey, and
    /// it stops on the rail's own left edge. It never touches the canvas at all now, which is
    /// the hazard `ResizeHandleMetrics.hitBreadth` was written against.
    var resizeStripX: CGFloat { panelX + panelWidth - DS.Space.panelInset }

    /// How far the docked panel has to travel to leave the screen: its own lane plus the
    /// leading inset it is pinned at, `28 + 337 = 365` on the reference screen.
    ///
    /// It is the panel's *trailing* edge measured from the screen's leading one, which is why
    /// this one number is both the travel and the reference the collapsed dock's fade is
    /// derived against — at any point of the travel the panel's trailing edge sits at
    /// `progress × dockTravel`. See `DockReveal.dockFadeStart(dockLeading:travel:)`.
    ///
    /// A lane, so it lives here: it follows a resized panel and a Split View window for free,
    /// and neither the layer that animates the panel nor the tests that pin the curve have to
    /// re-derive it. The panel leaves by the leading edge rather than fading, because that is
    /// the edge it is pinned to and the one the collapsed dock arrives from.
    var dockTravel: CGFloat { panelX + panelWidth }

    /// The width used by the design and restored by a resize-handle double tap.
    static let defaultPanelWidth: CGFloat = DS.Container.panel

    /// Smallest dock width that keeps its fixed controls and composer usable.
    ///
    /// At 260pt the 18pt insets leave a 224pt content column. After the composer's buttons,
    /// gaps, and padding, its flexible text lane still has 74pt; below this the dock is more
    /// useful collapsed or full-screen than as a cramped third layout variant.
    static let minimumPanelWidth: CGFloat = 260

    /// The width the board and the panel share, gap included on the panel's side.
    ///
    /// `1348 − 28 − 72 − 2 × 24 = 1200` on the reference screen. It exists because the panel's
    /// ceiling is a statement about this lane rather than about the screen.
    ///
    /// Stated as the row minus the rail and both gaps rather than as a subtraction from
    /// `boardX`: `boardX` is now a function of `panelWidth`, so deriving the lane from it would
    /// make the ceiling depend on the width it is supposed to bound.
    var dockedLaneWidth: CGFloat {
        max(0, contentRight - contentLeft - Self.railWidth - 2 * DS.Space.gap)
    }

    /// Everything in the shared lane except the board's minimum. The tutor may be much wider
    /// than the board; widening it is allowed to reduce the whiteboard to a compact strip.
    ///
    /// This makes the reference-screen ceiling `1200 - 200 = 1000`. Deliberately **not**
    /// floored at `minimumPanelWidth`: on a window too narrow to dock at all the two bounds
    /// genuinely cross, and reporting that honestly lets `ResizeConstraints.isSatisfiable`
    /// catch it.
    var maximumPanelWidth: CGFloat { max(0, dockedLaneWidth - Self.minimumBoardWidth) }

    /// What the student asked the panel to be, reconciled with what *this* window can host.
    ///
    /// `BoardScreen.resized(_:)` used to inline this as its own `min(max(requested,
    /// minimumPanelWidth), maximumPanelWidth)`, and `ShellComponentTests` kept a second,
    /// private copy of the identical expression to pin the arithmetic — which meant the four
    /// resize-width tests exercised a re-implementation rather than `BoardScreen`'s own code:
    /// delete `resized(_:)` entirely, or turn it into a write-back into `UIState`, and every
    /// one of those tests stayed green, because none of them called anything `BoardScreen`
    /// actually runs. Hoisting the composition here — onto the type that already owns
    /// `minimumPanelWidth` and `maximumPanelWidth` and every other lane derived from them —
    /// gives both call sites the one function that is actually load-bearing, so a regression
    /// in the real clamp now fails the tests that are supposed to catch it.
    ///
    /// Deliberately not the whole of `resized(_:)`: that also decides *whether* to reconcile
    /// at all — see its own guard for a window too narrow to host any panel — which is a
    /// decision about a `ScreenLayout` under construction, not about a width in isolation.
    func resolvingPanelWidth(_ requested: CGFloat) -> CGFloat {
        min(max(requested, Self.minimumPanelWidth), maximumPanelWidth)
    }

    /// `--container-panel-content` = `337 − 2 × 18`.
    static let panelContentWidth: CGFloat = DS.Container.panelContent
    var panelContentWidth: CGFloat { Self.panelContentWidth }

    // MARK: - Full-screen tutor (screen 07)

    /// Flush right, no 28 inset — *"the one panel that touches a screen edge."* It still clears
    /// the safe area, which on the reference device is 0.
    ///
    /// The board hinges off the **trailing** edge now, which is the edge the board itself is on
    /// in every other state. `1376 − 68 = 1308` on the reference screen.
    var peekX: CGFloat { max(safeAreaLeading, size.width - safeAreaTrailing - Self.peekWidth) }

    /// Fixed by its own artwork: the peek is a board-edge SVG path with a hinge icon at local
    /// (23, 22), not a lane cut out of the screen.
    static let peekWidth: CGFloat = 68
    var peekWidth: CGFloat { Self.peekWidth }

    /// Where the reading column is allowed to live: everything to the left of the peek.
    /// *"because the peek occupies the trailing 68, that column is centred in what remains
    /// rather than on the screen."*
    var columnRegionX: CGFloat { columnRegionX(reserving: 0) }
    var columnRegionWidth: CGFloat { columnRegionWidth(reserving: 0) }

    /// `--container-column`, or whatever fits — `min(740, region − 2 × 28)`.
    ///
    /// The subtraction is what stops the column butting into the screen edge once the region
    /// drops below 740 + 2 × edge: at that point the margins stop being generous and become
    /// exactly `--space-edge`, which is the rule for a panel against a screen edge anyway. On
    /// the reference device `min(740, 1308 − 56) = 740`, so nothing changes.
    var columnWidth: CGFloat { columnWidth(reserving: 0) }

    /// `(1376 − 68 − 740) ÷ 2 = 284` — equal margins inside the region, not on the screen.
    var columnMargin: CGFloat { columnMargin(reserving: 0) }

    /// `0 + (1376 − 68 − 740) ÷ 2 = 284`. Margins 284 / 284.
    var columnX: CGFloat { columnX(reserving: 0) }

    /// The same four numbers, with a lane taken off the **leading** side of the region first.
    ///
    /// This is what the full-screen sessions sidebar needs, and it is deliberately the existing
    /// rule with one more term rather than a second rule. Board 19: *"The chat column re-centers
    /// in the width that is left of the sidebar and the board peek."* The peek already came off
    /// the trailing side; the sidebar comes off the leading one; the column is still centred in
    /// what is left, which is the sentence screen 07 was always written as.
    ///
    /// `reserving: 0` is screen 07 exactly, which is why every property above delegates here
    /// instead of the two spellings living side by side — the closed sidebar has to be
    /// bit-for-bit the layout that shipped, not a re-derivation of it.
    ///
    /// On the reference screen with board 19's 372 reserved: region `1308 − 372 = 936`, column
    /// `min(740, 936 − 56) = 740`, margins `(936 − 740) ÷ 2 = 98`, and `372 + 98 = 470` — which
    /// is where board 19 draws the greeting and the composer.
    func columnRegionX(reserving leading: CGFloat) -> CGFloat {
        safeAreaLeading + max(0, leading)
    }

    func columnRegionWidth(reserving leading: CGFloat) -> CGFloat {
        max(0, peekX - columnRegionX(reserving: leading))
    }

    func columnWidth(reserving leading: CGFloat) -> CGFloat {
        max(0, min(DS.Container.column, columnRegionWidth(reserving: leading) - 2 * DS.Space.edge))
    }

    func columnMargin(reserving leading: CGFloat) -> CGFloat {
        (columnRegionWidth(reserving: leading) - columnWidth(reserving: leading)) / 2
    }

    func columnX(reserving leading: CGFloat) -> CGFloat {
        columnRegionX(reserving: leading) + columnMargin(reserving: leading)
    }

    // MARK: - Sessions drawer (screens 17 · 18 · 19)

    /// The full-screen sessions sidebar's lane: flush against the leading edge, the full height
    /// of the screen, and only present while the sidebar is open.
    ///
    /// Not in `namedRegions`, for the reason the resize strip is not: those entries are the
    /// lanes the screen is *cut into*, all present at once and all checked against each other,
    /// and this is a lane that exists in one state of one screen and overlaps the column's own
    /// region by construction when it does. What it is checked against is `columnX(reserving:)`,
    /// which is where it actually bites.
    var sessionsSidebarX: CGFloat { safeAreaLeading }
    var sessionsSidebarWidth: CGFloat { SessionsDrawerMetrics.sidebarWidth }

    /// How far the docked chat pane slides to reveal the drawer beneath it — the drawer's own
    /// width, since the two are the same travel seen from either side. `337 × 0.78 = 263`.
    var sessionsDrawerWidth: CGFloat { SessionsDrawerMetrics.width(inPanel: panelWidth) }

    /// What is left of the panel for the pushed-aside chat: `337 − 263 = 74`.
    var pushedChatWidth: CGFloat { SessionsDrawerMetrics.stripWidth(inPanel: panelWidth) }

    // MARK: - Collapsed dock (screen 06)

    /// The dock's own size, fixed by its contents: orb + label in a `gap: 16` row.
    static let collapsedDockWidth: CGFloat = 132
    static let collapsedDockHeight: CGFloat = 64
    var collapsedDockWidth: CGFloat { Self.collapsedDockWidth }
    var collapsedDockHeight: CGFloat { Self.collapsedDockHeight }

    /// `124` — the collapsed board's left edge, which is the dock's anchor.
    var collapsedBoardLeft: CGFloat { boardXCollapsed }

    /// `124 + 1224 = 1348` — the collapsed board's right edge. No longer the dock's anchor;
    /// kept because it is the one number that says where the collapsed canvas ends.
    var collapsedBoardRight: CGFloat { boardXCollapsed + boardWidthCollapsed }

    /// `124 + 24 = 148`.
    ///
    /// Board 09 calls this out as *"the one exception to the edge rule"*: the dock is inset
    /// `--space-gap` 24 from the **board's** bottom-left corner rather than `--space-edge`
    /// 28 from the screen's, *"so it reads as sitting on the board rather than on the
    /// screen."* The 24-against-28 is the whole of the exception, and it is why this cannot be
    /// spelled `contentLeft + edge`.
    ///
    /// The corner is the board's leading one now rather than its trailing one, for the reason
    /// the whole shell mirrored: the tutor lives on the leading side, so the affordance that
    /// brings it back belongs on the side the hand already goes to. It is anchored to
    /// `collapsedBoardLeft` rather than to `contentLeft` because the two part company wherever
    /// the rail pushes the board in, and following the board is what stays true to *"sitting on
    /// the board"*.
    var collapsedDockX: CGFloat { collapsedBoardLeft + DS.Space.gap }

    /// `1004 − 24 − 64 = 916`, measured up from the board's bottom edge for the same reason.
    var collapsedDockY: CGFloat { contentBottom - DS.Space.gap - Self.collapsedDockHeight }

    // MARK: - Where the design stops working

    /// Which of the design's own states this size can host.
    ///
    /// Deliberately not a new visual layout — the design has three states and this only picks
    /// between them. Below the threshold the answer is screen 06, which the design already
    /// draws and which the student already reaches by hand.
    enum Fit: Equatable, Sendable {
        /// Screens 05 / 08: rail, board and docked tutor across the safe band.
        case threeLane
        /// Screen 06 only: rail and board, tutor behind the collapsed dock. The docked lane
        /// arithmetic still evaluates, but the board it leaves is below its usable floor.
        case boardOnly
        /// No state in the design fits. Nothing here is negative, but nothing here is usable
        /// either, and a caller should say so rather than draw it.
        case unsupported
    }

    /// Smallest board strip retained beside a maximized dock. It remains large enough to
    /// preserve spatial context and the drawing surface, while prioritizing chat when the
    /// student deliberately drags the seam almost all the way across the window.
    static let minimumBoardWidth: CGFloat = 200

    /// Edge + requested panel + gap + rail + gap + board floor + edge, with the board at its
    /// floor and the panel at whatever the student has asked for.
    ///
    /// Instance rather than static since the panel's width became an input: a wider panel
    /// genuinely does need a wider window to stay docked, and a threshold that ignored the
    /// panel would let a wide panel dock beside a narrower-than-200 board. `collapsedMinimumWidth`
    /// stays static for the mirror-image reason — there is no panel in that state, so a wide
    /// one must not raise the width at which the board alone stops fitting.
    ///
    /// This threshold and `maximumPanelWidth` express the same usable-board rule from two
    /// directions: enough total width must exist for the requested panel plus the board's
    /// floor, and the requested panel must leave that floor in the shared lane.
    var dockedMinimumWidth: CGFloat {
        2 * DS.Space.edge + Self.railWidth + 2 * DS.Space.gap + panelWidth + Self.minimumBoardWidth
    }

    /// `28 + 72 + 24 + 200 + 28 = 352` — the same sum with the panel and one gap removed,
    /// which is exactly what collapsing does.
    static let collapsedMinimumWidth: CGFloat =
        2 * DS.Space.edge + railWidth + DS.Space.gap + minimumBoardWidth

    /// `24 + 64 = 88`. Straight out of the dock's own anchor: `collapsedDockY` is measured up
    /// from `contentBottom`, so a band shorter than this puts the dock above the board's top
    /// edge. Vertical minimums otherwise belong to the components — the rail is fit-content,
    /// and the panel's `18 + 32 + 810 + 58 + 18` stack has a flexible thread in the middle.
    static let minimumContentHeight: CGFloat = DS.Space.gap + collapsedDockHeight

    /// `.threeLane` is two conditions, not one. `usableWidth >= dockedMinimumWidth` is the
    /// window being wide enough to fit the board at its floor beside the requested panel;
    /// `panelWidth <= maximumPanelWidth` independently keeps a directly constructed layout
    /// honest about the same rule.
    ///
    /// Belt-and-braces, not a reachable case in the shipped app: the only place that builds a
    /// `ScreenLayout` with a caller-chosen `panelWidth` is `BoardScreen.resized(_:)`, and it
    /// constructs one from `base.resolvingPanelWidth(uiState.panelWidth)` — already `<=
    /// maximumPanelWidth` by construction — before `fit` is ever consulted on the result. So
    /// the second conjunct never actually flips a verdict the first conjunct did not already
    /// agree with in a running app; a reader chasing a case where it does will not find one.
    /// The conjunct stays anyway because `ScreenLayout` is a public value type with a public
    /// `panelWidth:` initializer parameter, not just `BoardScreen`'s private arithmetic — a
    /// test, a preview, or a future caller that builds one directly with an unclamped width
    /// should get a `fit` that is honest about what it was actually handed, not one that
    /// silently trusts a caller it has no way to verify clamped first.
    var fit: Fit {
        guard contentHeight >= Self.minimumContentHeight else { return .unsupported }
        if usableWidth >= dockedMinimumWidth && panelWidth <= maximumPanelWidth { return .threeLane }
        if usableWidth >= Self.collapsedMinimumWidth { return .boardOnly }
        return .unsupported
    }

    /// Whether the tutor may sit docked beside the board at this size. Below the threshold the
    /// tutor is still reachable — the collapsed dock opens it full-screen — so nothing is lost
    /// except the side-by-side view that would not have been readable anyway.
    var canDockTutor: Bool { fit == .threeLane }

    /// Every region this type publishes, for a caller that wants to check its own work. Useful
    /// mostly to the tests, which assert nothing here is negative and that every region stays
    /// on screen — not that nothing overlaps. Nothing here ever asserted non-overlap, and the
    /// list is not even non-overlapping at face value: the docked and collapsed entries are the
    /// same two lanes in two presentations that are never drawn at once, so the collapsed board
    /// runs straight through the docked panel's lane on purpose.
    ///
    /// No "resize strip" entry, deliberately: that footprint needs `ResizeHandleMetrics`, a
    /// SwiftUI component's own metrics enum, and this type is pure lane arithmetic that knows
    /// nothing about the components drawn in its lanes — `resizeStripX` alone stays here
    /// because it is genuinely lane arithmetic (see its own doc), but the strip's width is
    /// asserted in `ShellComponentTests` instead, where a dependency on `ResizeHandleMetrics`
    /// belongs.
    var namedRegions: [(name: String, x: CGFloat, width: CGFloat)] {
        [
            ("rail · docked", railX, railWidth),
            ("rail · collapsed", railXCollapsed, railWidth),
            ("board · docked", boardX, boardWidthDocked),
            ("board · collapsed", boardXCollapsed, boardWidthCollapsed),
            ("panel", panelX, panelWidth),
            ("peek", peekX, peekWidth),
            ("column", columnX, columnWidth),
            ("dock", collapsedDockX, collapsedDockWidth),
        ]
    }
}

// MARK: - Reference-size accessors

/// The values the board publishes, at the size the board was drawn against.
///
/// These are the old constants, unchanged in value and unchanged in name, now sourced from
/// `reference` instead of typed in. They exist so the port can happen one view at a time:
/// a call site that has not yet been handed a measured `ScreenLayout` still compiles and
/// still behaves exactly as it did. **A view that draws should not use them** — it should
/// read `@Environment(\.screenLayout)`, which is the same numbers on the reference device
/// and the right ones everywhere else.
extension ScreenLayout {
    static var screenWidth: CGFloat { reference.screenWidth }
    static var screenHeight: CGFloat { reference.screenHeight }

    static var statusBarBottom: CGFloat { reference.statusBarBottom }

    static var contentTop: CGFloat { reference.contentTop }
    static var contentBottom: CGFloat { reference.contentBottom }
    static var contentHeight: CGFloat { reference.contentHeight }

    static var railX: CGFloat { reference.railX }
    static var boardX: CGFloat { reference.boardX }
    static var boardWidthDocked: CGFloat { reference.boardWidthDocked }
    static var boardWidthCollapsed: CGFloat { reference.boardWidthCollapsed }
    static var panelX: CGFloat { reference.panelX }
    static var panelWidth: CGFloat { reference.panelWidth }

    static var peekX: CGFloat { reference.peekX }
    static var columnWidth: CGFloat { reference.columnWidth }
    static var columnMargin: CGFloat { reference.columnMargin }
    static var columnX: CGFloat { reference.columnX }

    static var collapsedDockX: CGFloat { reference.collapsedDockX }
    static var collapsedDockY: CGFloat { reference.collapsedDockY }
}

// MARK: - Threading it through SwiftUI

private struct ScreenLayoutKey: EnvironmentKey {
    /// The reference device, so a preview or a test view that was never measured draws the
    /// board exactly as it was drawn before this file learned to compute.
    static let defaultValue = ScreenLayout.reference
}

extension EnvironmentValues {
    /// How a view gets its layout: `@Environment(\.screenLayout) private var layout`.
    var screenLayout: ScreenLayout {
        get { self[ScreenLayoutKey.self] }
        set { self[ScreenLayoutKey.self] = newValue }
    }
}

extension View {
    /// Measures the window once, at the root, and publishes the result to everything below.
    ///
    /// One `GeometryReader` for the whole app rather than one per surface: the lanes have to
    /// agree with each other, so they must all be cut from the same measurement.
    ///
    /// The reader is deliberately **not** given `.ignoresSafeArea()`. A reader that has already
    /// absorbed the safe area has none left to report — `proxy.safeAreaInsets` comes back all
    /// zeroes — and `ScreenLayout` would then measure `--space-edge` from the glass instead of
    /// from the status bar, putting `contentTop` at 28 and tucking the first row of content
    /// under the system clock. That was the shipped behaviour of an earlier version of this
    /// modifier, and it is the exact bug the responsive work exists to prevent, so the ordering
    /// here is load-bearing rather than stylistic.
    ///
    /// So: a plain reader is laid out *inside* the safe area, which makes `proxy.size` the
    /// window minus the insets and `safeAreaInsets` the real ones. The window is the two added
    /// back. The content then takes `.ignoresSafeArea()` for itself, so it still fills the
    /// screen and draws from global (0, 0) exactly as before — only the numbers it is handed
    /// change.
    func measuringScreenLayout() -> some View {
        modifier(ScreenLayoutMeasurement())
    }
}

/// The measurement, and the one thing it has to keep separate from it.
///
/// **The keyboard is not an inset like the others.** The device's insets describe
/// the screen and change when the screen does — a rotation, a Split View drag.
/// SwiftUI reports the software keyboard through the same channel, and a single
/// reader cannot tell the two apart: it hands back one bottom number that
/// silently grows by ~350 points while a student types, and every lane cut from
/// it shrinks, the board included. See `ScreenLayout.keyboardInset` for what that
/// cost the one feature that stores coordinates against the board.
///
/// So the reader takes `.ignoresSafeArea(.keyboard)` and measures the screen as
/// though no keyboard existed — that is the measurement everything is cut from —
/// and the keyboard is measured *beside* it rather than around it. A sibling is
/// the load-bearing part: wrapping the reader in a second, keyboard-aware one
/// does not work, because a subtree that ignores the keyboard stops the inset
/// being applied anywhere above it and the outer reader reads a flat zero. The
/// probe is the only thing in the app still asking for keyboard avoidance, which
/// is what keeps SwiftUI applying it at all.
private struct ScreenLayoutMeasurement: ViewModifier {
    /// What the probe reports: the bottom inset *with* the keyboard in it, which
    /// is the device's own whenever there is no keyboard. The difference between
    /// this and the reader's bottom is the keyboard's own reach — see
    /// `ScreenLayout.keyboardInset` for why it is stored as the difference.
    @State private var bottomInsetWithKeyboard: CGFloat = 0

    func body(content: Content) -> some View {
        ZStack {
            KeyboardInsetProbe()

            GeometryReader { screen in
                let insets = screen.safeAreaInsets
                content
                    .environment(
                        \.screenLayout,
                        ScreenLayout(
                            size: CGSize(
                                width: screen.size.width + insets.leading + insets.trailing,
                                height: screen.size.height + insets.top + insets.bottom
                            ),
                            safeArea: insets,
                            keyboardInset: bottomInsetWithKeyboard - insets.bottom
                        )
                    )
                    .ignoresSafeArea()
            }
            .ignoresSafeArea(.keyboard)
        }
        .onPreferenceChange(KeyboardInsetKey.self) { bottomInsetWithKeyboard = $0 }
    }
}

/// How far up the screen the keyboard reaches, reported by the one view that has
/// not opted out of it.
///
/// Zero-sized and hit-testing nothing: it is a measurement, not a layer. It sits
/// at the bottom of the stack so its own safe-area inset *is* the keyboard's
/// intrusion, which on iPad is also correct for the shortcut bar a hardware
/// keyboard leaves behind — that band covers the composer just as the full
/// keyboard does, and it is not the device's inset either.
private struct KeyboardInsetProbe: View {
    var body: some View {
        GeometryReader { proxy in
            Color.clear.preference(key: KeyboardInsetKey.self, value: proxy.safeAreaInsets.bottom)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct KeyboardInsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

extension DS {
    /// So a feature can reach for it as `DS.Layout` alongside the token namespaces.
    typealias Layout = ScreenLayout
}
