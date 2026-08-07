import CoreGraphics

/// Which way a surface is being resized.
///
/// The axis exists so one model serves both directions rather than growing a vertical
/// branch later. Nothing resizes vertically yet; the spec says so out loud, and keeping the
/// axis in the type from the start is what stops the horizontal case hard-coding `width`
/// everywhere it means `size along the drag`.
enum ResizeAxis: Equatable, Sendable {
    case horizontal
    case vertical
}

/// Which edge of the surface the handle sits on — and therefore which direction of drag
/// makes the surface bigger.
///
/// This is the only place the sign lives. The tutor panel is pinned to the screen's right
/// edge and its handle is on its **leading** side, so dragging left (a negative translation)
/// must *widen* it: `growthSign` is −1. A left-hand sidebar would put its handle on
/// `.trailing` and get +1. Every other type in the resize system is sign-agnostic because
/// of this property.
enum ResizeEdge: Equatable, Sendable {
    case leading
    case trailing
    case top
    case bottom

    var axis: ResizeAxis {
        switch self {
        case .leading, .trailing: .horizontal
        case .top, .bottom: .vertical
        }
    }

    /// Multiply a drag translation by this to get the change in size.
    ///
    /// A handle on the near edge (`leading` / `top`) grows its surface when dragged *toward*
    /// the origin, because the surface's far edge is pinned; a handle on the far edge grows
    /// it when dragged away.
    var growthSign: CGFloat {
        switch self {
        case .leading, .top: -1
        case .trailing, .bottom: 1
        }
    }
}

/// Which bound the gesture is currently pushing against, if any.
///
/// Carried on the resolution rather than recomputed by the view, because it is what fires
/// the haptic — and on a touchscreen that haptic is the *entire* feedback that a limit has
/// been reached. There is no cursor to change and no hover state to highlight, so a view
/// that had to re-derive this would be re-deriving the only signal the student gets.
enum ResizeLimit: Equatable, Sendable {
    case none
    case minimum
    case maximum
}

/// The bounds one resizable surface obeys.
///
/// Values, not rules: the caller works out what its minimum and maximum are from whatever
/// layout it has, and hands the numbers over. `ResizeConstraints` knows nothing about
/// panels, boards or screens, which is what makes the model reusable on any edge of any
/// surface.
struct ResizeConstraints: Equatable, Sendable {
    /// The smallest size the surface is ever *drawn* at. Dragging below it does not shrink
    /// the surface — it pins, rubber-bands, and eventually collapses.
    let minimum: CGFloat

    /// The largest size the surface may be drawn at.
    let maximum: CGFloat

    /// The virtual size below which the gesture collapses the surface, or `nil` where the
    /// surface is not collapsible.
    ///
    /// Compared against the *unclamped* proposed size, never against the drawn one — that
    /// is what makes a collapse reversible inside a single gesture. See `ResizeModel`.
    let collapseBelow: CGFloat?

    /// Apple's `UIScrollView` rubber-band coefficient. Named rather than inlined so a caller
    /// that wants a stiffer edge can say so, and so the 0.55 has somewhere to be explained.
    let rubberBand: CGFloat

    /// The coefficient `UIScrollView` uses, in the formula `b = (1 − 1/((x·c/d) + 1))·d`.
    static let defaultRubberBand: CGFloat = 0.55

    init(
        minimum: CGFloat,
        maximum: CGFloat,
        collapseBelow: CGFloat? = nil,
        rubberBand: CGFloat = ResizeConstraints.defaultRubberBand
    ) {
        self.minimum = minimum
        self.maximum = maximum
        self.collapseBelow = collapseBelow
        self.rubberBand = rubberBand
    }

    /// False where the window has become too small to honour both bounds at once.
    ///
    /// The model refuses to guess in that case rather than silently preferring one bound:
    /// picking the maximum would draw a panel wider than the board it is commentary on, and
    /// picking the minimum would claim a width that does not exist. The caller — which knows
    /// it has a collapsed state to fall back to — decides.
    var isSatisfiable: Bool { maximum >= minimum }
}

/// One frame's answer.
///
/// `size` and `handleOffset` are separate because they diverge under rubber band: the
/// surface stops at its bound while the handle keeps following the finger, which is the
/// whole visual language of "you are pushing against something".
struct ResizeResolution: Equatable, Sendable {
    /// The size to draw the surface at. Always within the constraints when they are
    /// satisfiable.
    let size: CGFloat

    /// How far past `size`'s own seam to draw the handle, in the drag's own coordinate
    /// direction. Zero unless the gesture is overshooting a bound.
    let handleOffset: CGFloat

    /// Whether this gesture position collapses the surface.
    let isCollapsed: Bool

    /// Which bound the gesture is pushing against.
    let limit: ResizeLimit
}
