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

    /// Fired once when the drag that called `onBegin` concludes — however it concludes: a
    /// deliberate release, a cancellation, a system interruption, or `onCollapse` below
    /// causing this view itself to leave the hierarchy mid-gesture. No single SwiftUI
    /// callback covers all four, so `endDrag()` is reachable from three different
    /// terminators and is idempotent (`hasBegun` guards it) so that whichever one or two of
    /// them a given gesture happens to trigger, `onEnd()` still fires exactly once. See
    /// `endDrag()`.
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
    /// closure invocation.
    ///
    /// It is reset to `false` inside `.onChanged`'s own `hasBegun` guard, *before* the first
    /// resolution of a new gesture is examined — not on a rising edge observed elsewhere. An
    /// earlier version reset it from a `.onChange(of: isDragging)` rising edge instead, which
    /// looks equivalent but is a distinct SwiftUI callback that runs during a later view
    /// update, *after* `.onChanged` has already delivered at least one event: if that first
    /// event already crossed the collapse threshold, `onCollapse()` would fire correctly, and
    /// then the rising-edge reset would clobber the record of it — so the *next* frame would
    /// see `wasCollapsed == false` again and fire a second, spurious `onCollapse()`. Resetting
    /// inside the same guard that decides whether this is the gesture's first event removes
    /// the gap between "examine this frame's collapse state" and "have last frame's state
    /// available to compare against" entirely, because both now happen in the one place and
    /// in the order they are written.
    @State private var wasCollapsed = false

    /// Whether this gesture has already run its begin-of-drag bookkeeping (`onBegin()`, the
    /// grab haptic, resetting `wasCollapsed`). Plain `@State`, not `@GestureState`, because
    /// `endDrag()` needs to read and clear it *after* the gesture that set it has already
    /// concluded — a `@GestureState` would already be back to its initial value by then.
    ///
    /// This is what makes `endDrag()` idempotent: guarding on `hasBegun` is what lets three
    /// independent terminators (`.onEnded`, `isDragging`'s falling edge, `.onDisappear`) all
    /// call it without coordinating with each other, because at most one of them does
    /// anything and the rest are no-ops. See `endDrag()`.
    @State private var hasBegun = false

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
    /// Its falling edge is one of `endDrag()`'s three terminators — see `body` — but its
    /// *rising* edge no longer drives anything: `.onChange(of:)` is a view-graph node that
    /// runs during a later view update, strictly after `.onChanged` has already delivered
    /// that gesture's first event and written `size`/`limit`/`overshoot` at least once. A
    /// begin callback fired from there would arrive too late for a caller's `onBegin` freeze
    /// to matter and would race `wasCollapsed`'s reset against `.onChanged`'s own read of it.
    /// See the `hasBegun` guard inside `.onChanged`, in `drag` below, for where begin
    /// actually lives now.
    private var isDragging: Bool { anchor != nil }

    var body: some View {
        withResizeHaptics(withResizeAccessibility(handle))
    }

    /// The strip's drag mechanics and its two non-gesture interactions (double-tap, and the
    /// three ways a gesture can conclude other than a deliberate release — see the comment
    /// above `.onEnded` in `drag`, and `.onDisappear` here). Kept as its own node, rather than
    /// folded into `body`'s chain along with the accessibility and haptics modifiers, because
    /// SourceKit was timing out type-checking `body` as one ~14-modifier expression; splitting
    /// it into three shorter ones (this, `withResizeAccessibility`, `withResizeHaptics`) is
    /// what fixed that — see the type doc on `withResizeAccessibility` for the same note.
    private var handle: some View {
        strip
            .contentShape(Rectangle())
            .overlay(capsule)
            .gesture(drag)
            // The falling edge of `isDragging`. Fires when `anchor` resets to `nil` — a
            // deliberate release *if* `.onEnded` below already ran and made `endDrag()` a
            // no-op, but this is also the only one of the three terminators that reaches a
            // cancellation or a system interruption: those are exactly the cases
            // `@GestureState` resets `anchor` for without any event this view is told about,
            // and `isDragging` is the only one of the three signals derived from `anchor`
            // rather than from a gesture callback SwiftUI might simply not deliver.
            .onChange(of: isDragging) { _, isNowDragging in
                if !isNowDragging { endDrag() }
            }
            // The collapse/dismount path. `onCollapse()` inside `drag` below can lead its
            // caller to take this view out of the `.docked` state entirely — Task 6 removes
            // the handle from the hierarchy once the panel is collapsed — and a removed
            // view's `.onChange` action does not run; disappearance is `.onDisappear`'s
            // domain, not `.onChange`'s. Without this, `onEnd()` would stay unpaired on
            // exactly the routine path `onCollapse` names, not just on a rare interruption.
            .onDisappear { endDrag() }
            .onTapGesture(count: 2) { onReset() }
    }

    /// The five `.accessibility*` modifiers, split out from `handle` above so `body`'s own
    /// expression stays short enough for SourceKit to type-check promptly — a 14-modifier
    /// chain in one expression produced "unable to type-check this expression in reasonable
    /// time" in live diagnostics (the project still built with `swiftc`; this is a tooling
    /// cost, not a build failure). Grouping by concern rather than splitting arbitrarily
    /// keeps each piece readable on its own, which an arbitrary split at, say, the seventh
    /// modifier would not.
    private func withResizeAccessibility(_ content: some View) -> some View {
        content
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityValue("\(Int(size.rounded())) points")
            .accessibilityAdjustableAction(adjust)
            // `.accessibilityElement()` collapses the whole subtree into one node, which is
            // also why the double-tap in `handle` above is unreachable to VoiceOver: a
            // VoiceOver double-tap activates the element's primary action, not the raw
            // tap-gesture recogniser underneath. This is the same reset surfaced as a named
            // custom action instead, so the mitigation the type doc promises actually reaches
            // the audience it is a mitigation for.
            .accessibilityAction(named: "Reset") { onReset() }
    }

    /// The three haptics that replace a desktop cursor. `.rigid` fires on the *transition*
    /// into a limit rather than every frame spent inside one, because `limit` only changes
    /// when the state does.
    private func withResizeHaptics(_ content: some View) -> some View {
        content
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
                // Begin runs here, synchronously with the gesture's first delivered event —
                // not from `isDragging`'s rising edge (see the doc on `isDragging` above).
                // `.onChanged` is a gesture callback, invoked during event delivery itself;
                // `.onChange(of:)` is a view-graph node whose action runs during a later view
                // update. Firing `onBegin()` from the later point would let a caller's freeze
                // land only *after* `size` had already been written below at least once — the
                // exact inversion of "freeze before anything moves" `onBegin`'s own doc
                // promises. `hasBegun` makes this run once per gesture rather than once per
                // event, and resetting `wasCollapsed` here, before this frame's resolution is
                // examined, is what keeps that reset from racing the read of it a few lines
                // down — see `wasCollapsed`'s doc for the failure that ordering caused.
                if !hasBegun {
                    hasBegun = true
                    wasCollapsed = false
                    grabCount += 1
                    onBegin()
                }

                // `anchor ?? size`: by the time `.onChanged` runs, `.updating` above has
                // already committed `anchor` for this event — `.onChanged` is the outer node
                // wrapping `.updating`'s `GestureStateGesture`, so the write is guaranteed to
                // have already landed; that ordering is what makes `hasBegun` legible here in
                // the first place (`.onChanged` sees every event `.updating` does, in the same
                // order). The `?? size` fallback exists only as defence in depth: if it were
                // ever reached, `size` at gesture-start *is* the correct anchor, so the
                // fallback cannot silently produce a wrong answer even if that guarantee
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
                //
                // `ResizeModel.nextSize`, not a bare `resolution.size`: on the collapse frame
                // `resolution.size` is `constraints.minimum` — right for drawing, wrong for
                // this view's caller to remember. This view is about to leave the hierarchy
                // (Task 6 mounts it only in `.docked`), so pinning the bound state to the
                // floor here buys nothing and costs the width the student actually asked for.
                // Dragging back out of a collapse within the same gesture resolves from the
                // same untouched `anchor` and writes again, so nothing already captured is
                // lost by skipping this one frame's write. See `nextSize`'s own doc for the
                // design-spec edge case this is.
                size = ResizeModel.nextSize(current: size, resolution: resolution)
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
            // The one gesture callback SwiftUI guarantees fires exactly once per gesture,
            // however briefly that gesture lived. It exists alongside `isDragging`'s falling
            // edge and `.onDisappear` in `handle` above rather than replacing either of them,
            // because each catches a different way this can end and none of the three covers
            // all of them alone: this one is what closes the case where touch-down, the
            // qualifying move past `minimumDragDistance`, and the release all land between two
            // view updates (a main-thread stall, or coalesced event delivery) — `isDragging`
            // would go `false → true → false` with no render in between, and its `.onChange`
            // would never fire at all. `endDrag()`'s `hasBegun` guard is what makes calling it
            // from here safe even when `isDragging`'s `.onChange` also fires for the same
            // gesture: whichever runs first does the work, the other finds `hasBegun` already
            // `false` and returns.
            .onEnded { _ in endDrag() }
    }

    /// The single place a gesture's end-of-drag bookkeeping happens — resetting `limit`,
    /// animating `overshoot` back to zero, and firing `onEnd()` — reachable from three
    /// independent terminators in `handle` and `drag` above: `isDragging`'s falling edge
    /// (covers a cancellation or a system interruption, the cases `@GestureState` resets
    /// `anchor` for without delivering this view any event), `.onEnded` (covers the
    /// deliberate-release case even when no intervening render gave `isDragging`'s `.onChange`
    /// a chance to fire), and `.onDisappear` (covers `onCollapse` causing this view to leave
    /// the hierarchy mid-gesture, which neither of the other two can reach: a removed view's
    /// `.onChange` action does not run, and there may be no further gesture event to trigger
    /// `.onEnded` either).
    ///
    /// The `hasBegun` guard is what lets three call sites coexist without coordinating: at
    /// most one of them ever does anything for a given gesture, because whichever runs first
    /// sets `hasBegun = false` and every other one that fires afterwards — for the same
    /// gesture, or spuriously — finds the guard already closed and returns immediately.
    private func endDrag() {
        guard hasBegun else { return }
        hasBegun = false
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
