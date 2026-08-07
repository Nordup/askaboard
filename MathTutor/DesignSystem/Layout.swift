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
/// board width  = 1376 − 28 − 72 − 24 − 337 − 24 − 28 = 863
/// content top  = 0 + 28 = 28
/// safe band    = 1032 − 28 − 28 = 976
/// collapsed    = 863 + 24 + 337 = 1224
/// column x     = 68 + (1376 − 68 − 740) ÷ 2 = 352
/// ```
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
/// the rail never resizes"*, and the docked panel is 337 because that is what leaves the 301pt
/// content column the 18pt inset is specced against. Every inset is a token. So the board is
/// the only lane with anywhere to give, and it absorbs all remaining width; the safe band
/// absorbs all remaining height. Nothing here invents a spacing value — only the *positions*
/// became derived.
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

    /// What the student has asked the docked panel to be, clamped by whoever set it.
    ///
    /// Board 02 called the panel *"the only fixed-width surface in the product"*, and for as
    /// long as the product was one device that was a description rather than a constraint.
    /// It is now an input, which changes nothing about the arithmetic below — `panelX` and
    /// `boardWidthDocked` were always written as subtractions from this number, so they
    /// follow for free.
    ///
    /// The design's 337 is its **floor**, not its value: see `minimumPanelWidth`. A panel is
    /// never drawn narrower than it was designed, only wider — or collapsed to the dock.
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
        panelWidth: CGFloat = ScreenLayout.minimumPanelWidth
    ) {
        self.size = size
        safeAreaTop = safeArea.top
        safeAreaLeading = safeArea.leading
        safeAreaTrailing = safeArea.trailing
        safeAreaBottom = safeArea.bottom
        self.panelWidth = panelWidth
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

    // MARK: - Horizontal lanes, docked layout (screens 05 and 08)

    /// `--space-edge` from the left.
    var railX: CGFloat { safeAreaLeading + DS.Space.edge }

    /// `--container-rail`, *"fixed — the rail never resizes"*. Height is fit-content and
    /// belongs to the rail component.
    static let railWidth: CGFloat = DS.Container.rail
    var railWidth: CGFloat { Self.railWidth }

    /// `28 + 72 + 24 = 124` — edge + rail + gap.
    var boardX: CGFloat { railX + Self.railWidth + DS.Space.gap }

    /// `1376 − 28 = 1348` — the right edge everything docked is measured back from.
    var contentRight: CGFloat { size.width - safeAreaTrailing - DS.Space.edge }

    /// `1376 − 28 − 72 − 24 − 337 − 24 − 28 = 863` — the width left over once both edge
    /// insets, the rail and both inter-panel gaps come off. Written here as the distance
    /// between two already-derived edges, which is the same arithmetic with the terms
    /// collected, and which cannot drift out of step with `boardX` and `panelX`.
    ///
    /// Clamped at 0 rather than allowed to go negative: below `Self.dockedMinimumWidth` this
    /// state does not fit at all, and `fit` says so out loud instead of handing a caller a
    /// negative frame.
    var boardWidthDocked: CGFloat { max(0, panelX - DS.Space.gap - boardX) }

    /// `863 + 24 + 337 = 1224` — the board absorbs the gap it used to sit behind plus the
    /// panel, so it runs from its own left edge to the screen's edge inset.
    var boardWidthCollapsed: CGFloat { max(0, contentRight - boardX) }

    /// `124 + 863 + 24`, equivalently `1376 − 28 − 337 = 1011`. The second spelling is the one
    /// implemented: the panel is pinned to the right edge and the board is what flexes, so the
    /// panel's position must not depend on the board's width.
    ///
    /// Clamped at 0 for the same reason `boardWidthDocked` is: `panelWidth` stopped being a
    /// 337 constant and became a caller-supplied input, so a panel wider than `contentRight`
    /// is now representable. Nothing upstream of this file is meant to ask for one — `fit`
    /// gates the docked layout on `panelWidth <= maximumPanelWidth` before anything draws —
    /// but a stray or pre-clamp call site should get a pinned-left panel rather than a
    /// negative x that pushes it off the far edge instead.
    var panelX: CGFloat { max(0, contentRight - panelWidth) }

    /// Where the resize strip's left edge sits — the gutter's own left edge, one `--space-gap`
    /// inside `panelX`.
    ///
    /// Published so both the strip's drawing code and its tests read the same number instead of
    /// each writing `panelX - --space-gap` at its own call site. That duplication is exactly how
    /// this file's own reference-render test used to go tautological: the test's private copy of
    /// the expression could never disagree with a re-derivation of itself, so a bug in the real
    /// call site had nothing to fail against. One property, read by both, closes that gap.
    ///
    /// It also states a fact `boardWidthDocked` already implies rather than a new one:
    /// `boardWidthDocked` is `max(0, panelX - --space-gap - boardX)`, so wherever that clamp does
    /// not fire — every size this type produces a docked layout for — `boardX + boardWidthDocked`
    /// reduces algebraically to `panelX - --space-gap`, this property's own definition. The strip
    /// therefore begins exactly where the board ends, by construction, not by coincidence: it
    /// lives entirely inside the gutter between them and cannot claim a point of the canvas
    /// without the two lanes it sits between having already overlapped.
    var resizeStripX: CGFloat { panelX - DS.Space.gap }

    /// `--container-panel`, now read as the smallest width the panel is ever *drawn* at.
    ///
    /// 337 is what leaves the 301pt column `--space-panel-inset` is specced against, and
    /// board 05 is explicit that the panel and full-screen treatments are *"two variants,
    /// not one responsive view."* There is no third variant, so nothing narrower than the
    /// one that was drawn ever appears: dragging inward pins here and then collapses.
    static let minimumPanelWidth: CGFloat = DS.Container.panel

    /// The width the board and the panel share, gap included on the panel's side.
    ///
    /// `1348 − 124 − 24 = 1200` on the reference screen. It exists because the panel's
    /// ceiling is a statement about this lane rather than about the screen.
    var dockedLaneWidth: CGFloat { max(0, contentRight - boardX - DS.Space.gap) }

    /// Half the shared lane — which is `minimumBoardWidth`'s rule applied live rather than
    /// as a static floor.
    ///
    /// That constant says *"the board must never end up narrower than the panel it sits
    /// beside — the board is the product and the tutor is the commentary."* Written as a
    /// live constraint, `panel ≤ board` is `panel ≤ lane ÷ 2`, and the recursion the naive
    /// reading suggests — the maximum depending on `boardWidthDocked`, which depends on the
    /// panel — collapses algebraically before it ever needs iterating.
    ///
    /// `600` on the reference screen, where a panel at its ceiling is exactly as wide as the
    /// board. Deliberately **not** floored at `minimumPanelWidth`: on a window too narrow to
    /// dock at all the two bounds genuinely do cross, and reporting that honestly is what
    /// lets `ResizeConstraints.isSatisfiable` catch it instead of the layout quietly
    /// preferring one bound.
    var maximumPanelWidth: CGFloat { dockedLaneWidth / 2 }

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

    /// Flush left, no 28 inset — *"the one panel that touches a screen edge."* It still clears
    /// the safe area, which on the reference device is 0.
    var peekX: CGFloat { safeAreaLeading }

    /// Fixed by its own artwork: the peek is a board-edge SVG path with a hinge icon at local
    /// (23, 22), not a lane cut out of the screen.
    static let peekWidth: CGFloat = 68
    var peekWidth: CGFloat { Self.peekWidth }

    /// Where the reading column is allowed to live: everything to the right of the peek.
    /// *"because the peek occupies the left 68, that column is centred in what remains rather
    /// than on the screen."*
    var columnRegionX: CGFloat { peekX + Self.peekWidth }
    var columnRegionWidth: CGFloat { max(0, size.width - safeAreaTrailing - columnRegionX) }

    /// `--container-column`, or whatever fits — `min(740, region − 2 × 28)`.
    ///
    /// The subtraction is what stops the column butting into the screen edge once the region
    /// drops below 740 + 2 × edge: at that point the margins stop being generous and become
    /// exactly `--space-edge`, which is the rule for a panel against a screen edge anyway. On
    /// the reference device `min(740, 1308 − 56) = 740`, so nothing changes.
    var columnWidth: CGFloat {
        max(0, min(DS.Container.column, columnRegionWidth - 2 * DS.Space.edge))
    }

    /// `(1376 − 68 − 740) ÷ 2 = 284` — equal margins inside the region, not on the screen.
    var columnMargin: CGFloat { (columnRegionWidth - columnWidth) / 2 }

    /// `68 + (1376 − 68 − 740) ÷ 2 = 352`. Margins 284 / 284.
    var columnX: CGFloat { columnRegionX + columnMargin }

    // MARK: - Collapsed dock (screen 06)

    /// The dock's own size, fixed by its contents: orb + label in a `gap: 16` row.
    static let collapsedDockWidth: CGFloat = 132
    static let collapsedDockHeight: CGFloat = 64
    var collapsedDockWidth: CGFloat { Self.collapsedDockWidth }
    var collapsedDockHeight: CGFloat { Self.collapsedDockHeight }

    /// `124 + 1224 = 1348` — the collapsed board's right edge, which is the dock's anchor.
    var collapsedBoardRight: CGFloat { boardX + boardWidthCollapsed }

    /// `1348 − 24 − 132 = 1192`.
    ///
    /// Board 09 calls this out as *"the one exception to the edge rule"*: the dock is inset
    /// `--space-gap` 24 from the **board's** bottom-right corner rather than `--space-edge`
    /// 28 from the screen's, *"so it reads as sitting on the board rather than on the
    /// screen."* The 24-against-28 is the whole of the exception, and it is why this cannot be
    /// spelled `contentRight − edge − width`.
    ///
    /// It is anchored to `collapsedBoardRight` rather than `contentRight` even though those two
    /// are the same number wherever the collapsed board reaches the edge inset — which is every
    /// size the app supports. They part company only where `boardWidthCollapsed` clamps at
    /// zero, and there following the board is the reading that stays true to *"sitting on the
    /// board"*.
    var collapsedDockX: CGFloat { collapsedBoardRight - DS.Space.gap - Self.collapsedDockWidth }

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
        /// arithmetic still evaluates, but the board it leaves is narrower than the panel
        /// beside it, which inverts the hierarchy the design is built on.
        case boardOnly
        /// No state in the design fits. Nothing here is negative, but nothing here is usable
        /// either, and a caller should say so rather than draw it.
        case unsupported
    }

    /// The board must never end up narrower than the panel it sits beside — the board is the
    /// product and the tutor is the commentary, and a 255pt board next to a 337pt panel reads
    /// as the reverse. `--container-panel` is therefore the board's floor as well as the
    /// panel's width; no new number is introduced to express it.
    static let minimumBoardWidth: CGFloat = DS.Container.panel

    /// `28 + 72 + 24 + 337 + 24 + 337 + 28 = 850` — edge + rail + gap + board + gap + panel +
    /// edge, with the board at its floor and the panel at whatever the student has asked for.
    ///
    /// Instance rather than static since the panel's width became an input: a wider panel
    /// genuinely does need a wider window to stay docked, and a threshold that ignored the
    /// panel would let a 600pt panel dock beside a narrower-than-337 board. `collapsedMinimumWidth`
    /// stays static for the mirror-image reason — there is no panel in that state, so a wide
    /// one must not raise the width at which the board alone stops fitting.
    ///
    /// **This alone does not guarantee `board >= panel`.** It only raises the board's floor
    /// from 200 (an unnamed number the design never chose) to `minimumBoardWidth` — the same
    /// 337 the panel's own floor is. Above that floor the two widths are independent inputs
    /// again: a `panelWidth` past 337 can still outrun `boardWidthDocked` on a window this
    /// alone is satisfied by, which is exactly the inversion `minimumBoardWidth`'s doc warns
    /// against. The actual guarantee is the conjunction `fit` computes — this threshold *and*
    /// `panelWidth <= maximumPanelWidth` — not this number by itself.
    var dockedMinimumWidth: CGFloat {
        2 * DS.Space.edge + Self.railWidth + 2 * DS.Space.gap + panelWidth + Self.minimumBoardWidth
    }

    /// `28 + 72 + 24 + 337 + 28 = 489` — the same sum with the panel and one gap removed,
    /// which is exactly what collapsing does.
    static let collapsedMinimumWidth: CGFloat =
        2 * DS.Space.edge + railWidth + DS.Space.gap + minimumBoardWidth

    /// `24 + 64 = 88`. Straight out of the dock's own anchor: `collapsedDockY` is measured up
    /// from `contentBottom`, so a band shorter than this puts the dock above the board's top
    /// edge. Vertical minimums otherwise belong to the components — the rail is fit-content,
    /// and the panel's `18 + 32 + 810 + 58 + 18` stack has a flexible thread in the middle.
    static let minimumContentHeight: CGFloat = DS.Space.gap + collapsedDockHeight

    /// `.threeLane` is two conditions, not one, and both are load-bearing for `ScreenLayout`
    /// itself even though only the first ever actually decides the answer in the shipped app.
    /// `usableWidth >= dockedMinimumWidth` is the window being wide enough to fit the board at
    /// its floor beside the panel at its current width; `panelWidth <= maximumPanelWidth` is
    /// the hierarchy rule — the panel is commentary, so it may never end up wider than the
    /// board it sits beside. Above `minimumPanelWidth` the two are independent: a window can
    /// satisfy the first while a sufficiently wide panel already fails the second, and a
    /// `dockedMinimumWidth` that only checked the first would still report `.threeLane` for a
    /// panel wider than the board it is next to.
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
    /// list is not even non-overlapping at face value: "board · docked" and "board · collapsed"
    /// both start at `boardX` on purpose, because they are two widths for the same lane in two
    /// presentations that are never drawn at once.
    ///
    /// No "resize strip" entry, deliberately: that footprint needs `ResizeHandleMetrics`, a
    /// SwiftUI component's own metrics enum, and this type is pure lane arithmetic that knows
    /// nothing about the components drawn in its lanes — `resizeStripX` alone stays here
    /// because it is genuinely lane arithmetic (see its own doc), but the strip's width is
    /// asserted in `ShellComponentTests` instead, where a dependency on `ResizeHandleMetrics`
    /// belongs.
    var namedRegions: [(name: String, x: CGFloat, width: CGFloat)] {
        [
            ("rail", railX, railWidth),
            ("board · docked", boardX, boardWidthDocked),
            ("board · collapsed", boardX, boardWidthCollapsed),
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
        GeometryReader { proxy in
            let insets = proxy.safeAreaInsets
            self
                .environment(
                    \.screenLayout,
                    ScreenLayout(
                        size: CGSize(
                            width: proxy.size.width + insets.leading + insets.trailing,
                            height: proxy.size.height + insets.top + insets.bottom
                        ),
                        safeArea: insets
                    )
                )
                .ignoresSafeArea()
        }
    }
}

extension DS {
    /// So a feature can reach for it as `DS.Layout` alongside the token namespaces.
    typealias Layout = ScreenLayout
}
