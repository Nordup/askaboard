import SwiftUI

/// The resize strip's own numbers.
///
/// Split out from the view for the same reason `TutorPanelMetrics` is: the numbers are
/// assertable without a host, and a spec that lives in a `body` cannot be regression-tested.
enum ResizeHandleMetrics {
    /// Painted only while the gesture is live. Fits inside `--space-gap` with room either
    /// side, so it never touches the surfaces it sits between.
    static let capsuleThickness: CGFloat = DS.Space.s1
    static let capsuleLength: CGFloat = DS.Space.s12
    static let capsuleRadius: CGFloat = DS.Radius.xs

    static let appear: Double = 0.12
    static let disappear: Double = 0.18

    /// Non-zero so a tap on the strip is a tap and not a half-point resize. Two points is
    /// enough to reject a tap and small enough that the drag still feels like it starts
    /// under the finger.
    static let minimumDragDistance: CGFloat = 2

    /// How much one VoiceOver increment moves the edge. `--space-gap`, so the adjustable
    /// action moves the panel by a unit the design already uses.
    static let accessibilityStep: CGFloat = DS.Space.gap

    /// How wide the grabbable strip is: all of the gutter, plus whatever dead margin the
    /// surface it belongs to can spare, and **nothing** from the surface opposite.
    ///
    /// The asymmetry is the whole rule, and it is where this departs from every splitter it
    /// was modelled on. VS Code centres its sash on the seam and `react-resizable-panels`
    /// grows its hit region evenly in both directions, which is right when both neighbours
    /// are ordinary content. Here one of them is a live `PKCanvasView`: a hit region that
    /// overlaps it by a single point swallows ink strokes at exactly the place a
    /// right-handed student's hand rests. So the general rule this encodes is that **a
    /// resize region may only claim space no content can reach** — and where a neighbour's
    /// content runs to its own edge, the margin on that side is zero.
    ///
    /// For the tutor panel that is `24 + 18 = 42`: `--space-gap` is empty screen-grey, and
    /// `--space-panel-inset` is dead by construction because board 02 specs the 301pt column
    /// against it.
    static func hitBreadth(gutter: CGFloat, into contentMargin: CGFloat) -> CGFloat {
        gutter + max(0, contentMargin)
    }
}

/// A drag strip that resizes the surface it is attached to.
///
/// Reusable on any edge of any surface: it takes an edge, the constraints to obey, a label
/// for VoiceOver and a binding to write, and knows nothing about panels, boards or
/// `ScreenLayout`. Both axes work, because `ResizeEdge` carries the sign and `ResizeModel`
/// has one code path.
///
/// **Nothing is painted at rest.** The strip occupies gutter that already exists, so adding
/// it changes no layout and creates no space. That costs discoverability, which is a trade
/// made deliberately: the two `PanelControls` buttons remain the visible route to the same
/// states, and the mitigations here — the double-tap reset and the adjustable action — cost
/// no pixels.
///
/// **The feedback is haptic, and that is not decoration.** A desktop splitter tells you it
/// has been grabbed by changing the cursor and tells you it has hit a bound by changing it
/// again. A touchscreen has neither, and worse, the finger covers the pixels a touch-down
/// state would reveal. So `.sensoryFeedback` carries what the cursor carried: a light impact
/// on grab, a rigid one the moment a bound is reached, a medium one on collapse.
struct ResizeHandle: View {
    /// Which edge of the surface this sits on. Supplies the direction of growth.
    let edge: ResizeEdge

    /// How long the strip is along its own axis — the full height of the content band for a
    /// vertical seam.
    let span: CGFloat

    /// The empty space between the two surfaces that the strip may claim in full.
    let gutter: CGFloat

    /// How far into its own surface the strip may reach — the surface's dead inset. Never
    /// the opposite surface's; see `ResizeHandleMetrics.hitBreadth`.
    let contentMargin: CGFloat

    /// The bounds to obey. Recomputed by the caller on every layout pass, so a window change
    /// re-clamps without this view knowing anything happened.
    let constraints: ResizeConstraints

    /// What VoiceOver announces for this handle. The type doc above claims this component
    /// "knows nothing about panels, boards or `ScreenLayout`" — that claim is false if the
    /// string is baked in here, so it is the caller's to supply. Task 6 passes "Resize the
    /// tutor panel"; a second adopter supplies its own and gets a correct label instead of a
    /// silently wrong one, which is what a hard-coded string would have produced.
    let label: String

    /// The size being driven. Written on every frame of the drag.
    @Binding var size: CGFloat

    /// Fired once when a drag begins, so the caller can freeze whatever it needs to. Paired
    /// with `onEnd`, fired once when the drag concludes, so the caller knows when it is safe
    /// to unfreeze it again.
    var onBegin: () -> Void = {}

    /// Fired once when the drag that called `onBegin` concludes — however it concludes. Not
    /// only a deliberate release: also a cancellation, a system interruption, or `onCollapse`
    /// below causing this view itself to leave the hierarchy mid-gesture. It is driven off
    /// `isDragging`'s falling edge rather than `DragGesture.onEnded`, specifically so none of
    /// those paths can leave it unpaired with `onBegin` — see `isDragging` and `endDrag()`.
    var onEnd: () -> Void = {}

    /// Fired on the transition into collapse — once per crossing, not once per frame spent
    /// collapsed. See the gesture below for why that distinction is load-bearing.
    var onCollapse: () -> Void = {}

    /// Double-tap. VS Code's `onDidReset`.
    var onReset: () -> Void = {}

    /// The size when this gesture started. **This is the anchor** — every frame resolves
    /// from it plus the gesture's total translation, never from the previous frame. See
    /// `ResizeModel`.
    ///
    /// `@GestureState` rather than `@State`, on purpose: SwiftUI resets a `@GestureState`
    /// property to its initial value — `nil` here — whenever its gesture concludes, *for any
    /// reason*, including a cancellation or interruption this view is never told about (a
    /// system alert stealing the touch, an ancestor gesture winning, the view being torn
    /// down mid-drag). A plain `@State` has no such guarantee: nothing clears it except code
    /// in this file remembering to run, and the one path that used to do that — the collapse
    /// branch below calling an end-of-gesture reset while the finger was still down — is
    /// exactly what latched a collapse instead of letting it reverse. Letting the platform
    /// own the reset removes the failure mode instead of trying to catch every way into it
    /// by hand.
    @GestureState private var anchor: CGFloat?

    /// Whether the *previous* frame of the current gesture reported a collapse. Compared
    /// against this frame's answer to find the false → true transition, so `onCollapse` and
    /// its haptic fire once per crossing rather than once per frame spent below the
    /// threshold — see the gesture below.
    ///
    /// This is `@State`, not `@GestureState`, and that needs explaining given the note on
    /// `anchor` above. `@GestureState` can only ever be *written* from inside a `.updating`
    /// closure — there is no setter anywhere else — which means a value that must be *read*
    /// for comparison inside `.onChanged` and then *written* for the next frame cannot live
    /// there: `.onChanged` cannot commit the new value itself, and doing the read-compare-
    /// write inside `.updating` instead runs into the other documented `.updating` caveat,
    /// that SwiftUI does not promise to call it exactly once per value — a firing that ran
    /// twice for one logical frame would double the very haptic this exists to de-duplicate.
    /// So the comparison lives in the one place that is guaranteed to run its own reads and
    /// writes in the order they are written: `.onChanged`, sequentially, within a single
    /// closure invocation. What still needs `@GestureState`'s guarantee is *this* value's
    /// immunity to leaking across a cancelled gesture into the next one — and it gets that not
    /// by being read at the top of `.onChanged` (an earlier version tried that, and it does not
    /// work: `.onChanged` is the *outer* node wrapping `.updating`'s `GestureStateGesture`, so
    /// `anchor` already reads non-`nil` on the very first `.onChanged` of a gesture, and a check
    /// there for "is this the first frame" is never true) but by being reset on the rising edge
    /// of `isDragging` in `body` below, which is ordering-independent by construction.
    @State private var wasCollapsed = false

    /// What the last resolved frame reported, kept only to drive the capsule and the
    /// haptics.
    @State private var overshoot: CGFloat = 0
    @State private var limit: ResizeLimit = .none
    @State private var collapseCount = 0
    @State private var grabCount = 0

    /// Whether a finger is currently down on the strip. Derived from `anchor` rather than
    /// tracked as its own flag, so there is exactly one thing that can say "dragging" and it
    /// is the one SwiftUI itself keeps honest across a cancellation.
    ///
    /// This is also the single source of truth for the gesture's begin/end lifecycle — see
    /// the `.onChange(of: isDragging)` in `body` below, and why it replaced watching for
    /// `.onChanged`'s first frame.
    private var isDragging: Bool { anchor != nil }

    var body: some View {
        strip
            .contentShape(Rectangle())
            .overlay(capsule)
            .gesture(drag)
            // The begin/end edges of a gesture, read off `isDragging` rather than off
            // `.onChanged`'s first call or `.onEnded`. Two independent problems forced this:
            //
            // `.onChanged` cannot see its own first frame. `.onChanged` wraps `.updating`'s
            // `GestureStateGesture` (`_ChangedGesture` is the outer node), so by the time
            // `.onChanged` runs for a gesture's first event, `.updating` above has already
            // committed `anchor`, and a check for "is `anchor` still `nil`" inside `.onChanged`
            // is never true. An earlier version of this file tried exactly that and, as a
            // result, never fired `onBegin()` or the grab haptic at all — the single most
            // important of the three haptics the type doc promises, since it is the only
            // confirmation on a touchscreen that the handle was caught.
            //
            // `.onEnded` cannot see every way a gesture ends. It only fires on a deliberate
            // release. A cancellation, a system interruption, or `onCollapse` below causing
            // this view to leave the hierarchy mid-gesture all skip it, which is what left
            // `onEnd()` unpaired with `onBegin()` on exactly the paths `@GestureState` was
            // adopted to survive.
            //
            // `isDragging` has neither problem: it is a plain computed property over
            // `@GestureState`, so reading it carries no ordering assumption, and `@GestureState`
            // resets — and therefore this fires — on every way a gesture can conclude, not only
            // a deliberate release. As a side effect this is also what makes `endDrag()`'s
            // `limit = .none` land in a genuinely separate render from the next gesture's first
            // `onChanged`, which is what makes the `.rigid` haptic re-fire correctly if a fresh
            // drag immediately re-pins the same bound a cancelled one left behind.
            .onChange(of: isDragging) { _, isNowDragging in
                if isNowDragging {
                    onBegin()
                    grabCount += 1
                    wasCollapsed = false
                } else {
                    endDrag()
                }
            }
            .onTapGesture(count: 2) { onReset() }
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityValue("\(Int(size.rounded())) points")
            .accessibilityAdjustableAction(adjust)
            // `.accessibilityElement()` collapses the whole subtree into one node, which is
            // also why the double-tap above is unreachable to VoiceOver: a VoiceOver
            // double-tap activates the element's primary action, not the raw tap-gesture
            // recogniser underneath. This is the same reset surfaced as a named custom
            // action instead, so the mitigation the type doc promises actually reaches the
            // audience it is a mitigation for.
            .accessibilityAction(named: "Reset") { onReset() }
            // The three haptics that replace a desktop cursor. `.rigid` fires on the
            // *transition* into a limit rather than every frame spent inside one, because
            // `limit` only changes when the state does.
            .sensoryFeedback(.impact(weight: .light), trigger: grabCount)
            .sensoryFeedback(.impact(flexibility: .rigid), trigger: limit) { _, new in
                new != .none
            }
            .sensoryFeedback(.impact(weight: .medium), trigger: collapseCount)
    }

    // MARK: - Geometry

    private var breadth: CGFloat {
        ResizeHandleMetrics.hitBreadth(gutter: gutter, into: contentMargin)
    }

    /// The strip takes no space in layout — it is `.overlay`-style furniture placed by its
    /// caller — but it does need a size to hit-test against.
    @ViewBuilder
    private var strip: some View {
        switch edge.axis {
        case .horizontal: Color.clear.frame(width: breadth, height: span)
        case .vertical: Color.clear.frame(width: span, height: breadth)
        }
    }

    /// The one thing that is ever painted, and only while a finger is down.
    ///
    /// It is drawn at the strip's centre rather than at the finger's position, which is a
    /// simplification the span makes safe: the strip is the full height of the band, so a
    /// centred capsule is never far from the finger, and tracking the touch's `y` would put
    /// the capsule directly under the fingertip where it cannot be seen anyway.
    ///
    /// The fade is an `AnyTransition` with its own attached animation rather than a
    /// `withAnimation` around the state that adds or removes this view, because that state
    /// is now `isDragging` — derived from the `@GestureState` `anchor` — and `@GestureState`
    /// changes (including its own reset on a cancelled gesture) are not something this view
    /// can wrap in `withAnimation` itself. Attaching the animation to the transition instead
    /// means the fade plays however the view enters or leaves, appear and disappear on their
    /// own separate durations, with no dependency on who caused the change or how.
    @ViewBuilder
    private var capsule: some View {
        if isDragging {
            RoundedRectangle(cornerRadius: ResizeHandleMetrics.capsuleRadius)
                .fill(DS.Color.inkTertiary)
                .frame(
                    width: edge.axis == .horizontal
                        ? ResizeHandleMetrics.capsuleThickness
                        : ResizeHandleMetrics.capsuleLength,
                    height: edge.axis == .horizontal
                        ? ResizeHandleMetrics.capsuleLength
                        : ResizeHandleMetrics.capsuleThickness
                )
                .offset(
                    x: edge.axis == .horizontal ? overshoot : 0,
                    y: edge.axis == .vertical ? overshoot : 0
                )
                .transition(
                    .asymmetric(
                        insertion: .opacity.animation(.easeOut(duration: ResizeHandleMetrics.appear)),
                        removal: .opacity.animation(.easeOut(duration: ResizeHandleMetrics.disappear))
                    )
                )
                .allowsHitTesting(false)
        }
    }

    // MARK: - The gesture

    private var drag: some Gesture {
        DragGesture(minimumDistance: ResizeHandleMetrics.minimumDragDistance)
            // Idempotent capture of the pre-drag size: the first time this runs for a given
            // gesture, `state` is `nil` and becomes `size`; every time after, it is already
            // set and is left alone. That idempotence is what makes it safe regardless of
            // exactly how many times SwiftUI calls this closure for a given touch event —
            // the one thing `.updating` does not promise — because re-running it with the
            // same inputs cannot change the answer once it is set.
            .updating($anchor) { _, state, _ in
                if state == nil { state = size }
            }
            .onChanged { value in
                // `anchor ?? size`: by the time `.onChanged` runs, `.updating` above has
                // already committed `anchor` for this event — see the comment on `body`'s
                // `.onChange(of: isDragging)` for why that ordering, unlike the begin/end
                // edges, *is* safe to depend on here (`.onChanged` is the outer node wrapping
                // `.updating`'s `GestureStateGesture`, so the write is guaranteed to have
                // already landed). The `?? size` fallback exists only as defence in depth: if
                // it were ever reached, `size` at gesture-start *is* the correct anchor, so
                // the fallback cannot silently produce a wrong answer even if that guarantee
                // turned out to be wrong. It must never be relied on past the first frame,
                // though — by then `size` has moved away from the true anchor, and falling
                // back to it then would be exactly the anchored-to-accumulated regression
                // `ResizeModel`'s own doc warns about. It never is: `.updating`'s idempotence
                // (`if state == nil`) guarantees `anchor` stays set for the rest of the
                // gesture once it is written once.
                let start = anchor ?? size
                let translation = edge.axis == .horizontal
                    ? value.translation.width
                    : value.translation.height

                let resolution = ResizeModel.resolve(
                    start: start,
                    translation: translation,
                    edge: edge,
                    constraints: constraints
                )

                // Unanimated, deliberately. The panel must track the finger one-for-one;
                // wrapping this in a `withAnimation` is the classic failure and produces a
                // panel that lags behind the drag. Only the *release* animates — see
                // `endDrag()`. `overshoot` used to be wrapped in `withAnimation` here too,
                // which re-triggered a 0.12s ease on every single frame of a rubber-banded
                // drag and made the capsule visibly trail the finger instead of tracking it;
                // now it is unanimated here and animated back to zero only once, on release.
                size = resolution.size
                limit = resolution.limit
                overshoot = resolution.handleOffset

                // Fire on the false → true transition only, never on every frame spent below
                // the threshold. The previous version called `endDrag()` from inside this
                // branch, which — with the finger still down — nils the anchor a real touch
                // is still using; the very next `onChanged` then re-anchored at the just-
                // collapsed minimum and re-collapsed against it immediately, every frame,
                // for as long as the touch stayed down: a haptic and `onCollapse()` storm,
                // and worse, a collapse that could never reverse within the gesture because
                // the anchor kept being retaken at the floor. Holding the anchor fixed for
                // the gesture's entire lifetime — never touched by this branch — is what
                // restores the reversibility `ResizeModel`'s own doc promises: drag back out
                // of a collapse within the same gesture and `resolution.isCollapsed` simply
                // goes back to `false` against the same unmoved anchor.
                if resolution.isCollapsed && !wasCollapsed {
                    collapseCount += 1
                    onCollapse()
                }
                wasCollapsed = resolution.isCollapsed
            }
    }

    /// Runs on the falling edge of `isDragging`, from `body`'s `.onChange(of: isDragging)` —
    /// not from `DragGesture.onEnded`, and deliberately: `onEnded` only covers a deliberate
    /// release, and this needs to cover every way a gesture can conclude, including a
    /// cancellation, a system interruption, and `onCollapse` above causing this view to leave
    /// the hierarchy mid-gesture. `isDragging` is derived from `anchor`, `@GestureState`, which
    /// SwiftUI resets on all of those paths without this file having to enumerate them, so
    /// tying this to `isDragging` rather than to `.onEnded` is what makes `onEnd()` — and the
    /// capsule, which is also driven by `isDragging` — impossible to leave stranded.
    private func endDrag() {
        limit = .none
        withAnimation(.easeOut(duration: ResizeHandleMetrics.disappear)) {
            overshoot = 0
        }
        onEnd()
    }

    private func adjust(_ direction: AccessibilityAdjustmentDirection) {
        guard constraints.isSatisfiable else { return }
        let step = direction == .increment
            ? ResizeHandleMetrics.accessibilityStep
            : -ResizeHandleMetrics.accessibilityStep
        size = min(max(size + step, constraints.minimum), constraints.maximum)
    }
}
