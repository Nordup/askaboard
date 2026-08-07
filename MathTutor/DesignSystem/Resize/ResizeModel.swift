import CoreGraphics

/// One drag position resolved to one size, plus one further function deciding what a
/// caller's own stored state should become after that resolution — and nothing else in the
/// file.
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

        // Too narrow a window to honour both bounds. The model does not refuse to choose
        // here — it picks the minimum, deliberately, because it is the legible failure: a
        // panel pinned at its floor against a starved board is visibly wrong and the student
        // can see why, where drawing the panel at the maximum would silently paint it over
        // the very board it is commentary on. `ScreenLayout.fit` is what keeps the window
        // out of this state in the common case; landing here at all means that failed.
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

    /// What a caller's bound state should become after one resolved frame.
    ///
    /// A bare `size = resolution.size` is right on every frame but one: on the collapse
    /// frame `resolve` reports `size: constraints.minimum`, which is correct to *draw* — the
    /// handle and the surface it drives both shrink to the floor — but wrong to *remember*.
    /// Writing it through a `Binding` puts it wherever the binding is backed by, which for
    /// the tutor panel is `UIState.panelWidth`: the width the student asked for, permanently
    /// overwritten by the floor at the exact moment `onCollapse()` is about to take the
    /// surface off screen anyway. Design spec edge case ⑭ — *"Collapse-by-drag and
    /// collapse-by-button both land in `.collapsed`. Reopening restores the custom width"* —
    /// is only true if that write never happens.
    ///
    /// So this holds `current` on the collapse frame instead of taking `resolution.size`, and
    /// is a pass-through everywhere else. Nothing is lost by holding rather than writing: the
    /// gesture's anchor is untouched by collapsing (see the note on `wasCollapsed` in
    /// `ResizeHandle`), so a drag back out within the same gesture re-resolves from it and
    /// this function starts writing again — edge case ⑮, which the model supports even though
    /// `ResizeHandle`'s own mounting policy never lets the app exercise it (see that type's
    /// caller for why).
    static func nextSize(current: CGFloat, resolution: ResizeResolution) -> CGFloat {
        resolution.isCollapsed ? current : resolution.size
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

    /// A resolution that is not being actively dragged: no overshoot, not collapsed, and
    /// `size` clamped inside the constraints exactly like the driven path above — never the
    /// raw `size` handed in, which can already be stale. `start` is frozen for a whole
    /// gesture, but the constraints are not: a Split View or Stage Manager resize can move
    /// `maximum` out from under a `start` that was valid a frame ago, and the very next
    /// non-finite translation must not hand the view that now-too-wide frame back unchanged.
    /// `ResizeResolution.size`'s own contract — "always within the constraints when they are
    /// satisfiable" — applies here exactly as it does to the driven path.
    ///
    /// `limit` uses the same strict comparison as `resolve` above, against the same
    /// pre-clamp `size`: a value resting exactly on a bound has not been pushed past it, and
    /// only being pushed past a bound should read as a limit — that is the one signal that
    /// fires the haptic, and a value merely coinciding with the floor is not that signal.
    private static func settled(at size: CGFloat, constraints: ResizeConstraints) -> ResizeResolution {
        guard constraints.isSatisfiable else {
            // No real bounds to compare against here; the fallback is always "pinned at the
            // minimum" — see the comment on the `isSatisfiable` guard in `resolve` above.
            return ResizeResolution(size: constraints.minimum, handleOffset: 0, isCollapsed: false, limit: .minimum)
        }
        let pinned = min(max(size, constraints.minimum), constraints.maximum)
        let limit: ResizeLimit =
            if size > constraints.maximum { .maximum }
            else if size < constraints.minimum { .minimum }
            else { .none }
        return ResizeResolution(size: pinned, handleOffset: 0, isCollapsed: false, limit: limit)
    }
}
