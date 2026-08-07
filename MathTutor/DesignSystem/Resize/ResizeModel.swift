import CoreGraphics

/// One drag position in, one resolved size out — and nothing else in the file.
///
/// **Anchored, not accumulated.** Every resolution is computed from the size frozen when the
/// gesture began plus the gesture's *total* translation. It is never the previous frame's
/// size plus a per-frame delta, and the distinction is the difference between a resizer that
/// works and one that sticks: a frame spent pinned at a bound clamps, and if that clamped
/// value becomes the next frame's start then the travel which should have brought the
/// surface back off the bound has been silently thrown away. Drag 300 points past the
/// ceiling and 300 back, and an accumulating implementation leaves you at the ceiling.
/// `react-resizable-panels` reaches the same conclusion — it applies the drag delta to a
/// layout snapshot frozen at pointer-down — and it is the single correctness property
/// `ResizeModelTests` guards hardest.
///
/// **The collapse decision reads the unclamped size.** `size` is what gets drawn and is
/// always inside the constraints; the collapse threshold is compared against the *virtual*
/// size the finger is asking for, which may be far below the minimum. That is what makes a
/// collapse reversible inside one gesture: nothing latches, so dragging back out simply
/// resolves to a non-collapsed answer again.
///
/// No SwiftUI import, no view, no state. This is the whole of the difficulty and all of it
/// is testable as a function.
enum ResizeModel {
    static func resolve(
        start: CGFloat,
        translation: CGFloat,
        edge: ResizeEdge,
        constraints: ResizeConstraints
    ) -> ResizeResolution {
        // A non-finite start would poison every comparison below and end up as a NaN frame
        // width; a non-finite translation is a gesture the system should not have delivered.
        // Both resolve to "no change", which is the only answer that cannot make things
        // worse.
        guard start.isFinite, translation.isFinite else {
            return settled(at: start.isFinite ? start : constraints.minimum, constraints: constraints)
        }

        // The size the finger is asking for, before any bound is applied. Everything else is
        // derived from this one number.
        let proposed = start + edge.growthSign * translation

        if let threshold = constraints.collapseBelow, proposed < threshold {
            return ResizeResolution(
                size: constraints.minimum,
                handleOffset: 0,
                isCollapsed: true,
                limit: .minimum
            )
        }

        // Too narrow a window to honour both bounds. Refusing to choose is deliberate:
        // preferring the maximum would draw a panel wider than the board it is commentary
        // on, and preferring the minimum would claim width that does not exist. The caller
        // has a collapsed state to fall back to and `ScreenLayout.fit` to decide with.
        guard constraints.isSatisfiable else {
            return settled(at: constraints.minimum, constraints: constraints)
        }

        let clamped = min(max(proposed, constraints.minimum), constraints.maximum)
        let overshoot = proposed - clamped

        let limit: ResizeLimit =
            if proposed > constraints.maximum { .maximum }
            else if proposed < constraints.minimum { .minimum }
            else { .none }

        // The rubber band's asymptote is the surface's own minimum, so the handle can never
        // be pulled more than one panel-width past a bound however hard the student drags.
        // Using the minimum rather than the screen — which is what `UIScrollView` uses — keeps
        // the resistance proportional to the thing being resized rather than to the device.
        let banded = rubberBand(
            overshoot,
            coefficient: constraints.rubberBand,
            dimension: constraints.minimum
        )

        return ResizeResolution(
            size: clamped,
            handleOffset: edge.growthSign * banded,
            isCollapsed: false,
            limit: limit
        )
    }

    /// Apple's `UIScrollView` resistance curve, `b = (1 − 1/((|x|·c/d) + 1))·d`, made
    /// odd-symmetric so it works off either bound.
    ///
    /// Monotonic, asymptotic to `d`, and with a decreasing return on further travel — which
    /// is what reads as elastic rather than as lag. `c` is 0.55 by default because that is
    /// the constant `UIScrollView` uses and the one every iOS user's hand is calibrated to.
    static func rubberBand(_ x: CGFloat, coefficient: CGFloat, dimension: CGFloat) -> CGFloat {
        guard x != 0, dimension > 0, x.isFinite else { return 0 }
        let magnitude = abs(x)
        let resisted = (1 - (1 / ((magnitude * coefficient / dimension) + 1))) * dimension
        return x < 0 ? -resisted : resisted
    }

    /// A resolution that is not moving: pinned at `size`, no overshoot, not collapsed.
    private static func settled(at size: CGFloat, constraints: ResizeConstraints) -> ResizeResolution {
        let limit: ResizeLimit =
            if size <= constraints.minimum { .minimum }
            else if size >= constraints.maximum { .maximum }
            else { .none }
        return ResizeResolution(size: size, handleOffset: 0, isCollapsed: false, limit: limit)
    }
}
