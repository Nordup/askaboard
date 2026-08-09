import CoreGraphics

/// What the student has picked out of the board for the tutor to look at.
///
/// **Not from the design.** Board 05 open question 7 records that the design draws
/// no marquee, lasso path, handle or highlight on the canvas anywhere — *"screen
/// 08's board is pixel-identical to screen 05's despite a selection having been
/// sent"* — so a picked region had nowhere to live and `btn/select` attached the
/// whole board instead. That left the control with no visible result on the one
/// screen it appears on, which is a control that does not work. This is the
/// missing state, kept as small as a state can be: three cases and a rectangle.
///
/// The rectangle is in **PencilKit's drawing coordinates** — the strokes' own
/// space, not the canvas's view space.
///
/// It was view space, on the grounds that the board stops scrolling while a
/// selection is live (see `PencilCanvasView.isSelecting`), so nothing could move
/// underneath a stored rect. Freezing the scroll is not enough: a *resize* moves
/// the same mapping, and one happened on almost every send. The software
/// keyboard used to shorten the board by a third, so a region picked over the
/// learner's working — which is usually low on the board — no longer intersected
/// the canvas's bounds by the time they finished typing. `snapshotData` returned
/// nil for it and the send went out as text with no picture at all. The layout
/// half of that is fixed too (`ScreenLayout.keyboardInset`), but a region that
/// only survives while nothing resizes is a region that will be lost again by
/// the next thing that resizes.
///
/// Drawing coordinates have no such dependency, and the cost the old note
/// worried about does not appear: mapping back is needed only to *draw* the
/// marquee, once per layout pass, not once per scroll frame. What gets sent is
/// rendered from the vectors and never converts at all.
enum BoardSelection: Equatable, Sendable {
    /// Nothing picked, and the pencil inks.
    case none
    /// `btn/select` is lit and the marquee is armed, but no region has been drawn
    /// yet. Sending from here evaluates the whole board — which is exactly what
    /// this control did before it could pick a region, so the zero-effort path
    /// keeps its old behaviour.
    case arming
    /// A region is picked, in the drawing's own coordinates.
    case attached(CGRect)

    var isAttached: Bool { region != nil }

    var region: CGRect? {
        guard case .attached(let rect) = self else { return nil }
        return rect
    }

    /// Whether the board hands pencil drags to the marquee rather than to the ink.
    ///
    /// True for `attached` as well as `arming`, so a student who mis-drew a region
    /// drags a new one over it rather than writing on their own work — the second
    /// drag is the obvious correction, and the alternative is a mode you can only
    /// leave and re-enter.
    var capturesBoardDrags: Bool { self != .none }
}

/// The rectangle a marquee drag picks, and the smallest one that counts as a pick.
///
/// Free functions on a caseless enum for the same reason `BoardInk` is one: what a
/// drag selects is worth asserting without a canvas, a window, or a gesture.
enum BoardMarquee {
    /// **Not from the design**, which draws no marquee at all.
    ///
    /// A region smaller than this is a tap whose finger slipped, and honouring it
    /// would crop the board to a few points of blank paper — handing the tutor an
    /// empty image to grade in good faith, which is the failure
    /// `CanvasCapture.workCenteredRegion` already guards against on the other axis.
    /// 24 is `--space-gap`: comfortably past an accidental drag, comfortably inside
    /// a single written term.
    static let minimumSide: CGFloat = 24

    /// The rectangle between two corners, whichever way round they were dragged.
    /// `CGRect` has no negative extent, so this normalizes rather than trusting the
    /// order the two points arrived in.
    static func region(from start: CGPoint, to end: CGPoint) -> CGRect {
        CGRect(
            x: min(start.x, end.x),
            y: min(start.y, end.y),
            width: abs(end.x - start.x),
            height: abs(end.y - start.y)
        )
    }

    /// The region a finished drag attaches, or `nil` when it was too small to be
    /// one — in which case the caller leaves the marquee armed and the student
    /// simply drags again.
    static func committedRegion(from start: CGPoint, to end: CGPoint) -> CGRect? {
        let rect = region(from: start, to: end)
        guard rect.width >= minimumSide, rect.height >= minimumSide else { return nil }
        return rect
    }
}
