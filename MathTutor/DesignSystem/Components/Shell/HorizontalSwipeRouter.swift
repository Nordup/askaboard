import CoreGraphics
import SwiftUI

/// What a committed horizontal pan *means*, given where the tutor is.
///
/// There is one recogniser for horizontal gestures in this app — `DrawerPanRecognizer`, and the
/// note on that type is the whole argument for why. What there was **not** was one place that
/// decided what a committed pan should drive: the docked panel's own layer read `isOpen` and
/// assumed "drawer", and the full-screen surface read `isSessionsSidebarOpen` and assumed
/// "sidebar". Adding a third meaning — a left-swipe that minimises the dock — to that shape
/// would have put a second `if` in each surface and left the table nowhere.
///
/// So the table is here, as arithmetic, for the reason `DrawerReveal`'s curves are: a routing
/// rule that lives inside an `onCommit` closure cannot be regression-tested, and this one has
/// thirteen cells. The recogniser stays one implementation; this decides what it drives.
///
/// The table has since grown the other two rungs of the presentation ladder — `enterFullScreen`
/// from the leading edge and `enterDocked` from the trailing one — and they went in as two rows
/// rather than as two more surfaces with an `if` in each, which is the whole argument above
/// making its second payment.
///
/// **Direction is read once, at commitment, and never revisited.** That is the same lock
/// `DrawerReveal.axis(for:)` is, one axis down: a swipe that starts left and curls back right
/// keeps driving the route it committed to, clamped at its own end of the travel. The
/// alternative — re-routing mid-gesture — is what makes "one continuous ambiguous gesture"
/// out of what the design states as two distinct ones: with the drawer open a left-swipe
/// closes the drawer, and *another* left-swipe after it collapses the dock.
enum HorizontalSwipeRouter {

    /// Which way a committed pan went. Read from the translation the recogniser reports at
    /// `.began`, which is already past `DrawerReveal.intentThreshold` and inside its cone, so
    /// the horizontal component is never zero in practice — the optional is for the caller
    /// that asks anyway.
    enum Direction: Equatable, Sendable {
        case left
        case right

        static func of(_ translation: CGFloat) -> Direction? {
            if translation > 0 { return .right }
            if translation < 0 { return .left }
            return nil
        }
    }

    /// Where the touch went down. Three regions, and each edge is a *presentation* control
    /// while the surface between them is a control of what the presentation contains.
    ///
    /// That split is the whole reason the origin exists. A swipe on a surface moves something
    /// inside the tutor — the drawer, the sidebar — and a swipe from an edge moves the tutor
    /// itself, up or down the ladder `collapsed → docked → fullScreen`. Neither edge zone
    /// overlaps a surface the tutor draws, so no touch has to be arbitrated between the two
    /// meanings: see `edgeZoneWidth` and `trailingEdgeZoneWidth`.
    enum Origin: Equatable, Sendable {
        /// Anywhere on a surface the tutor is already drawing: the docked panel, the
        /// full-screen column.
        case surface
        /// The screen's own leading edge, where the tutor draws nothing at all — 24 points of
        /// screen grey outside the docked panel's lane, and outside the collapsed board's.
        case leadingEdge
        /// The screen's own trailing edge in the full-screen state: the board peek's lane,
        /// which the reading column and the sidebar's own pan region both stay clear of.
        case trailingEdge
    }

    /// What a committed pan drives.
    ///
    /// `none` is a real answer and not a failure: a right-swipe on an already-open drawer
    /// moves nothing, and it still *committed*, so the presses it crossed were cancelled. That
    /// boundary case is exactly why commitment rather than motion is the trigger — see
    /// `DrawerPanRecognizer`.
    enum Transition: Equatable, Sendable {
        case openDrawer
        case closeDrawer
        /// Screens 05/08 → screen 06: the docked panel leaves and the collapsed dock arrives.
        case collapseDock
        /// Screen 06 → screens 05/08, from the leading edge.
        case expandDock
        /// Screens 05/08 → screen 07: the docked panel is replaced by the reading column,
        /// from the leading edge. One rung further up the ladder than `expandDock`, and
        /// deliberately the same edge and the same direction — a learner who has learnt that
        /// a right-swipe from the leading edge gives the tutor more room does not learn a
        /// second gesture for the second half of that sentence.
        case enterFullScreen
        /// Screen 07 → screens 05/08: the reading column leaves and the board comes back,
        /// from the trailing edge. The swipe form of the board peek's tap.
        case enterDocked
        case openSidebar
        case closeSidebar
        case none
    }

    /// How wide the collapsed state's leading-edge grab region is.
    ///
    /// **24, and narrow on purpose.** The collapsed screen belongs to the board, and the one
    /// thing that must not become harder is drawing on it. Two facts keep the two apart, and
    /// the width is only the second of them:
    ///
    /// 1. In the collapsed lane arithmetic the canvas starts at `boardXCollapsed` — the
    ///    leading inset, the rail and a gap, which is 124 points on the reference screen and
    ///    never less than that on any device. The zone is 24 points of empty screen grey and
    ///    does not reach the rail at 28, let alone the canvas. **It does not overlap
    ///    `PKCanvasView` at all**, so there is no ink for it to steal.
    /// 2. Where a future layout did put the canvas under it, the intent lock is still the
    ///    arbitration: a stroke that starts vertically fails the recogniser at 12 points and
    ///    the canvas keeps the touch, and a horizontal commitment cancels the canvas's own
    ///    recognisers exactly as it cancels a button's. The zone additionally refuses Apple
    ///    Pencil touches outright — see `DrawerPanGesture.ignoresPencil` — because a pencil in
    ///    this app is always drawing and never navigating.
    ///
    /// `--space-gap` is the value rather than a number of its own: the zone is the air between
    /// the screen edge and the first lane, and that air is one gap wide.
    ///
    /// **The same 24 points serve the docked state**, where they are the air between the screen
    /// edge and `panelX` — the panel is pinned at `contentLeft`, which is `--space-edge` in, so
    /// the zone stops 4 points short of the panel and never overlaps the panel's own pan region.
    /// One zone at one width in both states is also what makes the ladder legible: the learner
    /// keeps swiping right from the same strip of screen and the tutor keeps growing.
    static let edgeZoneWidth: CGFloat = DS.Space.gap

    /// How wide the full-screen state's trailing-edge grab region is: **the board peek's own
    /// lane**, and not a second number.
    ///
    /// The zone is wider than the leading one because the thing it is made of is different. The
    /// leading zone is air the layout happens to leave; this one is a lane that is already
    /// reserved and already means "the board" — `TutorFullScreen` cuts exactly this width out of
    /// the sidebar's pan region so the peek's tap can survive, and `ScreenLayout.columnWidth`
    /// reserves it on both sides so the reading column never reaches it. Taking the whole lane
    /// therefore costs nothing that was previously reachable, and it puts the swipe on the one
    /// piece of the screen that already draws the destination.
    ///
    /// It does not fight the peek's tap: a tap never travels `DrawerReveal.intentThreshold`, so
    /// the recogniser never commits and never cancels it. It does not fight a scroll either —
    /// the thread is 740 points wide and centred, so nothing scrollable is under this lane — and
    /// it refuses Apple Pencil touches at touch-down for the reason the leading zone does.
    static let trailingEdgeZoneWidth: CGFloat = BoardPeekMetrics.width

    /// The whole table. Thirteen reachable cells, and every one of them is stated rather than
    /// falling out of a default.
    ///
    /// | presentation | drawer / sidebar | direction | origin | → |
    /// |---|---|---|---|---|
    /// | docked | — | right | leadingEdge | `enterFullScreen` |
    /// | docked | — | left | leadingEdge | as `surface` |
    /// | docked | closed | right | surface | `openDrawer` |
    /// | docked | closed | left | surface | `collapseDock` |
    /// | docked | open | left | surface | `closeDrawer` |
    /// | docked | open | right | surface | `none` |
    /// | collapsed | — | right | leadingEdge | `expandDock` |
    /// | collapsed | — | right | surface | `none` |
    /// | collapsed | — | left | any | `none` |
    /// | fullScreen | — | left | trailingEdge | `enterDocked` |
    /// | fullScreen | — | right | trailingEdge | `none` |
    /// | fullScreen | closed | right | surface / leadingEdge | `openSidebar` |
    /// | fullScreen | open | left | surface / leadingEdge | `closeSidebar` |
    /// | fullScreen | closed | left | surface / leadingEdge | `none` |
    /// | fullScreen | open | right | surface / leadingEdge | `none` |
    ///
    /// **The ladder, read off the two edge columns:** collapsed —edge-right→ docked
    /// —edge-right→ fullScreen going up, and fullScreen —edge-left→ docked —surface-left→
    /// collapsed coming down. The one asymmetry is deliberate: the rung down from docked is a
    /// swipe on the panel rather than on an edge, because the panel is what leaves, and because
    /// the drawer has to have the first claim on a left-swipe made over it.
    ///
    /// Note what the table does **not** contain: a collapse from a docked panel with the drawer
    /// open. The drawer is covering 78% of the panel, so the first left-swipe is unambiguously
    /// about the drawer, and the collapse is the swipe after it. `enterFullScreen` deliberately
    /// does **not** share that precedence: the edge's right-swipe is a presentation control, and
    /// it answers the same whether the drawer is open or closed. The drawer loses nothing by
    /// it — `BoardScreen` closes the docked drawer on every presentation change anyway, and the
    /// full-screen state has its own sessions surface, the sidebar — so refusing the swipe
    /// bought no safety and cost the learner a gesture that visibly did nothing. The drawer's
    /// first claim is on the surface it covers, not on the edge beside it.
    ///
    /// A **left**-swipe from the leading edge is not a cell of its own: it falls through to
    /// whatever the surface would have answered, so it closes an open drawer and collapses the
    /// dock exactly as the panel's own does. There is nothing to the left of the leading edge to
    /// give it a second meaning, and the collapsed state answers `none` there for that reason.
    static func transition(
        presentation: TutorPresentation,
        isDrawerOpen: Bool,
        isSidebarOpen: Bool,
        direction: Direction,
        origin: Origin = .surface
    ) -> Transition {
        switch presentation {
        case .docked:
            // The one cell the edge takes off the surface. Every other docked cell — including
            // every left-swipe from the edge — is the panel's own answer, unchanged.
            if origin == .leadingEdge, direction == .right {
                return .enterFullScreen
            }
            switch (isDrawerOpen, direction) {
            case (false, .right): return .openDrawer
            case (false, .left): return .collapseDock
            case (true, .left): return .closeDrawer
            case (true, .right): return .none
            }
        case .collapsed:
            // The collapsed screen has no tutor surface to swipe on, so the edge zone is the
            // only origin that means anything here. A right-swipe out on the board is the
            // board's — a two-finger pan, a marquee — and must stay the board's.
            guard origin == .leadingEdge, direction == .right else { return .none }
            return .expandDock
        case .fullScreen:
            // The peek's lane, which is the board's. A left-swipe out of it puts the column
            // away and brings the board back — the same destination the peek's tap has, so the
            // sliver of board on the trailing edge answers to a push as well as to a tap.
            //
            // **The sidebar is not consulted here, and that is the rule rather than an
            // omission.** Board 19's sidebar is a lane of the leading edge that covers nothing
            // and survives a presentation change (see `UIState.isSessionsSidebarOpen`), so it is
            // not a thing the learner has to finish with before leaving — unlike the docked
            // drawer, which is why the leading edge *does* consult that one. A left-swipe 1300
            // points away from the sidebar is about the board.
            if origin == .trailingEdge {
                return direction == .left ? .enterDocked : .none
            }
            // Board 19, unchanged, on every other origin: the sidebar and nothing else. The
            // leading edge is not a cell here — the sidebar already answers the whole surface
            // including its own lane, and the state below docked is not reachable from a
            // reading column.
            switch (isSidebarOpen, direction) {
            case (false, .right): return .openSidebar
            case (true, .left): return .closeSidebar
            case (false, .left), (true, .right): return .none
            }
        }
    }
}

// MARK: - The dock's own travel and settle

/// The physics of the panel leaving and coming back, as arithmetic rather than as a gesture
/// handler — `DrawerReveal` for the other axis of the same recogniser.
///
/// It is a second type rather than more members on `DrawerReveal` because the two describe
/// different motions of different surfaces: the drawer slides one pane *inside* the panel and
/// crossfades two veils across the travel, while this slides the whole panel off the screen
/// and fades the dock in behind it. What they deliberately **share** is the release rule and
/// the spring — a learner must not have to learn two different feels for two swipes made with
/// the same thumb — so both of those delegate to `DrawerReveal` rather than restating it.
enum DockReveal {

    // MARK: - Travel

    /// How far past either end of the travel the panel may still be dragged, as a fraction of
    /// the travel — about 22 points on the reference screen.
    ///
    /// The drawer takes no rubber band at all, and says so: it lives inside the panel's clip
    /// and *"there is nothing past either end to reveal"*. The dock is the opposite case at
    /// both ends. Past the collapsed end the panel is being pushed further off a screen edge
    /// it has already left, and past the docked end it would be pushed off the leading inset
    /// into space the board does not own — neither is a place the panel may rest, but a hard
    /// stop at both reads as the gesture having been dropped rather than bounded. So the
    /// finger keeps producing motion and the motion asymptotes.
    static let overshoot: CGFloat = 0.06

    /// Where along the travel a drag has got to: `1` docked, `0` collapsed.
    ///
    /// **One-to-one with the finger inside the travel**, which is the same first rule the
    /// drawer has and the reason the panel can be dragged to a stop halfway and left there
    /// without the finger and the pane disagreeing. Outside the travel the excess is resisted
    /// — see `overshoot`.
    ///
    /// Anchored on where the panel was when the touch landed, never on the previous frame:
    /// the anchor rule `ResizeModel` and `DrawerReveal` are both built on, because a per-frame
    /// sum accumulates rounding and drifts off the finger over a long drag. The dock's travel
    /// is the longest in the app — 365 points on the reference screen — so it is the one with
    /// the most drift to accumulate.
    static func progress(from anchor: CGFloat, translation: CGFloat, travel: CGFloat) -> CGFloat {
        guard travel > 0 else { return anchor }
        let raw = anchor + translation / travel
        if raw > 1 { return 1 + resisted(raw - 1) }
        if raw < 0 { return -resisted(-raw) }
        return raw
    }

    /// The rubber band: linear at the boundary, asymptotic to `overshoot`.
    ///
    /// `x / (1 + x / limit)` rather than a square root or a fixed fraction, because those two
    /// properties are what make it read as resistance instead of as a slower gesture. Its
    /// derivative is 1 at zero excess, so the very first point past the end still tracks the
    /// finger exactly and there is no corner where the band starts; and it never reaches the
    /// limit, so no amount of pull finds a second hard stop further out.
    private static func resisted(_ excess: CGFloat) -> CGFloat {
        guard excess > 0, overshoot > 0 else { return 0 }
        return excess / (1 + excess / overshoot)
    }

    /// Whether the release settles **docked**.
    ///
    /// `DrawerReveal.settlesOpen(progress:velocity:)` verbatim, delegated rather than copied:
    /// velocity first and position second, the same 300 pt/s fling and the same halfway line.
    /// The two gestures are made with the same thumb on the same surface and are told apart
    /// only by their direction, so a release rule that differed between them by even the
    /// boundary case would be felt as the panel judging the same swipe two ways.
    ///
    /// The names swap and nothing else does: `1` is docked here where it is open there, so a
    /// rightward fling docks and a leftward one collapses, which is the direction each of
    /// those swipes already means.
    static func settlesDocked(progress: CGFloat, velocity: CGFloat) -> Bool {
        DrawerReveal.settlesOpen(progress: progress, velocity: velocity)
    }

    /// The settle animation — `DrawerReveal.settle(velocity:travel:)`, and deliberately the
    /// identical spring.
    ///
    /// This is what makes the gesture and the button feel like one thing: `btn/dock`, the
    /// dock's own orb, the resize-drag collapse and the swipe all run *this* call, so there is
    /// one curve for arriving at screen 06 and one for leaving it, whichever control was used.
    /// Before this the buttons changed the presentation with no animation at all and the
    /// panel simply vanished, which is a fourth behaviour rather than a fourth control.
    ///
    /// Seeded with the release velocity for the reason the drawer's is: a spring that starts
    /// from rest loses the speed the finger already had, and the hand-off reads as a stall.
    static func settle(velocity: CGFloat, travel: CGFloat) -> Animation {
        DrawerReveal.settle(velocity: velocity, travel: travel)
    }

    /// How far the panel is offset from its docked lane, in whole points.
    ///
    /// Negative throughout: the panel leaves by the leading edge, which is the edge it is
    /// pinned to. Rounded for the reason the drawer's panes are — a `compositingGroup`
    /// rasterises the surface, and translating that raster by a fraction resamples every glyph
    /// in it differently on every frame, which on an A10 reads as the text shimmering rather
    /// than the panel sliding.
    static func panelOffset(at progress: CGFloat, travel: CGFloat) -> CGFloat {
        DrawerReveal.wholePoints((progress - 1) * travel)
    }

    // MARK: - The dock behind it

    /// Where along the travel the collapsed dock may start to appear: the fraction of the
    /// travel at which the panel's own trailing edge has cleared the dock's leading edge.
    ///
    /// **Derived, not chosen.** The panel's trailing edge sits at `progress × travel` — the
    /// travel is measured from the screen's leading edge, so the two are the same number seen
    /// from either side — and the dock is anchored at `collapsedDockX`, which is inside the
    /// panel's own lane while the panel is still there. A constant here would have been a
    /// number that is right at 337 points of panel and wrong at every other width the student
    /// can drag the panel to; this is the same geometry the two surfaces are actually placed
    /// by. On the reference screen it comes out `148 ÷ 365 = 0.405`.
    ///
    /// It matters because the dock is painted *over* the panel — screen 06's dock floats on
    /// the canvas card, and the floating region is drawn last — so an orb that faded up any
    /// earlier would be an orb on top of the panel that is still covering its corner.
    static func dockFadeStart(dockLeading: CGFloat, travel: CGFloat) -> CGFloat {
        guard travel > 0 else { return 0 }
        return min(1, max(0, dockLeading / travel))
    }

    /// The dock's opacity: `1` collapsed, `0` from `fadeStart` on, smoothstepped between.
    ///
    /// Smoothstepped rather than linear, unlike the sidebar toggle's ramp. The toggle is one
    /// mark leaving a pane that keeps moving; this is a *handover* — the dock arrives exactly
    /// as the panel's edge passes it — and a linear ramp puts a corner on the orb at both ends
    /// of the band, which on the frames where the panel is also moving fastest reads as the
    /// orb blinking on rather than as the two surfaces trading places.
    static func dockOpacity(at progress: CGFloat, fadeStart: CGFloat) -> Double {
        guard fadeStart > 0 else { return progress <= 0 ? 1 : 0 }
        let t = min(1, max(0, progress / fadeStart))
        return Double(1 - t * t * (3 - 2 * t))
    }

    /// How far the dock is still to travel, `0` at rest and `1` fully away — the same curve as
    /// the opacity, so the fade and the slide are one movement and cannot disagree.
    ///
    /// The caller multiplies it by the distance; `--space-gap` is what the dock uses, which is
    /// the same inset it is anchored on. It slides *with* the panel rather than against it:
    /// both leave by the leading edge, so the pair reads as one surface being pulled off
    /// rather than as two things passing each other.
    static func dockSlide(at progress: CGFloat, fadeStart: CGFloat) -> CGFloat {
        CGFloat(1 - dockOpacity(at: progress, fadeStart: fadeStart))
    }
}
