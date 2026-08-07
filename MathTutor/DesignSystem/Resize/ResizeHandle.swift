import SwiftUI

/// The resize strip's own numbers.
///
/// Split out from the view for the same reason `TutorPanelMetrics` is: the numbers are
/// assertable without a host, and a spec that lives in a `body` cannot be regression-tested.
enum ResizeHandleMetrics {
    /// Painted only while the gesture is live. Fits inside `--space-gap` with room either
    /// side, so it never touches the surfaces it sits between.
    static let capsuleThickness: CGFloat = 4
    static let capsuleLength: CGFloat = 48
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
/// Reusable on any edge of any surface: it takes an edge, the constraints to obey and a
/// binding to write, and knows nothing about panels, boards or `ScreenLayout`. Both axes
/// work, because `ResizeEdge` carries the sign and `ResizeModel` has one code path.
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

    /// The size being driven. Written on every frame of the drag.
    @Binding var size: CGFloat

    /// Fired once when a drag begins, so the caller can freeze whatever it needs to.
    var onBegin: () -> Void = {}

    /// Fired when the gesture crosses the collapse threshold.
    var onCollapse: () -> Void = {}

    /// Double-tap. VS Code's `onDidReset`.
    var onReset: () -> Void = {}

    /// The size when this gesture started. **This is the anchor** — every frame resolves
    /// from it plus the gesture's total translation, never from the previous frame. See
    /// `ResizeModel`.
    @State private var startSize: CGFloat?

    /// What the last resolved frame reported, kept only to drive the capsule and the
    /// haptics.
    @State private var overshoot: CGFloat = 0
    @State private var limit: ResizeLimit = .none
    @State private var isDragging = false
    @State private var collapseCount = 0
    @State private var grabCount = 0

    var body: some View {
        strip
            .contentShape(Rectangle())
            .overlay(capsule)
            .gesture(drag)
            .onTapGesture(count: 2) { onReset() }
            .accessibilityElement()
            .accessibilityLabel("Resize the tutor panel")
            .accessibilityValue("\(Int(size.rounded())) points")
            .accessibilityAdjustableAction(adjust)
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
                .transition(.opacity)
                .allowsHitTesting(false)
        }
    }

    // MARK: - The gesture

    private var drag: some Gesture {
        DragGesture(minimumDistance: ResizeHandleMetrics.minimumDragDistance)
            .onChanged { value in
                let anchor = startSize ?? beginDrag()
                let translation = edge.axis == .horizontal
                    ? value.translation.width
                    : value.translation.height

                let resolution = ResizeModel.resolve(
                    start: anchor,
                    translation: translation,
                    edge: edge,
                    constraints: constraints
                )

                // Unanimated, deliberately. The panel must track the finger one-for-one;
                // wrapping this in a `withAnimation` is the classic failure and produces a
                // panel that lags behind the drag. Only the *release* animates.
                size = resolution.size
                limit = resolution.limit
                withAnimation(.easeOut(duration: ResizeHandleMetrics.appear)) {
                    overshoot = resolution.handleOffset
                }

                if resolution.isCollapsed {
                    collapseCount += 1
                    endDrag()
                    onCollapse()
                }
            }
            .onEnded { _ in endDrag() }
    }

    private func beginDrag() -> CGFloat {
        startSize = size
        grabCount += 1
        withAnimation(.easeOut(duration: ResizeHandleMetrics.appear)) { isDragging = true }
        onBegin()
        return size
    }

    /// The single exit from a drag, however it ends — released, collapsed, or cancelled out
    /// from under us by a backgrounding or a window change. It always leaves a committed
    /// state and never a half-drag, which is why every path goes through here rather than
    /// unwinding its own state.
    private func endDrag() {
        startSize = nil
        limit = .none
        withAnimation(.easeOut(duration: ResizeHandleMetrics.disappear)) {
            isDragging = false
            overshoot = 0
        }
    }

    private func adjust(_ direction: AccessibilityAdjustmentDirection) {
        let step = direction == .increment
            ? ResizeHandleMetrics.accessibilityStep
            : -ResizeHandleMetrics.accessibilityStep
        guard constraints.isSatisfiable else { return }
        size = min(max(size + step, constraints.minimum), constraints.maximum)
    }
}
