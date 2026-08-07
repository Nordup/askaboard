import CoreGraphics
import XCTest
@testable import MathTutor

/// The resize system's whole difficulty lives in `ResizeModel`, which is a pure function,
/// so it is all asserted here rather than through a gesture on a simulator.
///
/// The recorded lesson about lossy first taps is the reason: a UI test that synthesises a
/// drag can fail for reasons that have nothing to do with the arithmetic. Everything that
/// can be a value test is one.
final class ResizeModelTests: XCTestCase {
    // MARK: - Edges

    func testEdgeGrowthSignFollowsWhichSideTheHandleIsOn() {
        // A handle on the surface's leading edge grows it when dragged toward the origin,
        // which is the tutor panel: it is pinned right, so dragging left widens it.
        XCTAssertEqual(ResizeEdge.leading.growthSign, -1, "leading")
        XCTAssertEqual(ResizeEdge.top.growthSign, -1, "top")
        // A handle on the trailing edge is the mirror: dragging away from the origin grows it.
        XCTAssertEqual(ResizeEdge.trailing.growthSign, 1, "trailing")
        XCTAssertEqual(ResizeEdge.bottom.growthSign, 1, "bottom")
    }

    func testEdgeReportsItsAxis() {
        XCTAssertEqual(ResizeEdge.leading.axis, .horizontal, "leading")
        XCTAssertEqual(ResizeEdge.trailing.axis, .horizontal, "trailing")
        XCTAssertEqual(ResizeEdge.top.axis, .vertical, "top")
        XCTAssertEqual(ResizeEdge.bottom.axis, .vertical, "bottom")
    }

    // MARK: - Constraints

    func testConstraintsReportWhetherTheyCanBeSatisfied() {
        XCTAssertTrue(ResizeConstraints(minimum: 337, maximum: 600).isSatisfiable)
        // A window too narrow to give the panel its minimum without starving the board.
        XCTAssertFalse(ResizeConstraints(minimum: 337, maximum: 300).isSatisfiable)
    }

    func testConstraintsDefaultToApplesRubberBandCoefficient() {
        XCTAssertEqual(ResizeConstraints(minimum: 337, maximum: 600).rubberBand, 0.55)
    }

    // MARK: - The resolver

    /// The tutor panel's own numbers: 337 floor, 600 ceiling at the reference size,
    /// collapse at 0.6 × 337.
    private var panel: ResizeConstraints {
        ResizeConstraints(minimum: 337, maximum: 600, collapseBelow: 337 * 0.6)
    }

    private func resolve(start: CGFloat = 337, translation: CGFloat) -> ResizeResolution {
        ResizeModel.resolve(start: start, translation: translation, edge: .leading, constraints: panel)
    }

    func testNoTranslationIsNoChange() {
        let r = resolve(translation: 0)
        XCTAssertEqual(r.size, 337, "size")
        XCTAssertEqual(r.handleOffset, 0, "handleOffset")
        XCTAssertFalse(r.isCollapsed, "isCollapsed")
        XCTAssertEqual(r.limit, .none, "limit")
    }

    func testDraggingTowardTheOriginWidensALeadingEdgeSurface() {
        // The panel is pinned right; dragging its leading handle left is a negative
        // translation and must make the panel wider, not narrower.
        XCTAssertEqual(resolve(translation: -100).size, 437)
    }

    func testWidthIsClampedAtTheMaximumAndTheLimitIsReported() {
        let r = resolve(translation: -400) // 337 + 400 = 737, past the 600 ceiling
        XCTAssertEqual(r.size, 600, "size")
        XCTAssertEqual(r.limit, .maximum, "limit")
        XCTAssertFalse(r.isCollapsed, "isCollapsed")
    }

    func testWidthPinsAtTheMinimumBeforeTheCollapseThreshold() {
        // 337 − 50 = 287, below the floor but above 202.2.
        let r = resolve(translation: 50)
        XCTAssertEqual(r.size, 337, "size")
        XCTAssertEqual(r.limit, .minimum, "limit")
        XCTAssertFalse(r.isCollapsed, "isCollapsed")
    }

    func testCollapsesOnceTheVirtualSizeCrossesTheThreshold() {
        // 337 − 140 = 197, below 0.6 × 337 = 202.2.
        XCTAssertTrue(resolve(translation: 140).isCollapsed)
    }

    func testCollapseIsReversibleWithinOneGesture() {
        // The decision is recomputed from the gesture's total translation every frame
        // rather than latched, so dragging back out un-collapses.
        XCTAssertTrue(resolve(translation: 140).isCollapsed, "collapsed on the way in")
        XCTAssertFalse(resolve(translation: 40).isCollapsed, "un-collapsed on the way back")
    }

    func testANonCollapsibleSurfaceNeverCollapses() {
        let fixed = ResizeConstraints(minimum: 337, maximum: 600, collapseBelow: nil)
        let r = ResizeModel.resolve(start: 337, translation: 5000, edge: .leading, constraints: fixed)
        XCTAssertFalse(r.isCollapsed, "isCollapsed")
        XCTAssertEqual(r.size, 337, "size")
    }

    // MARK: - What a resolution writes back

    /// The collapse-by-drag regression: a bare `size = resolution.size` writes the floor into
    /// whatever the caller's binding is backed by, at the exact frame that should instead
    /// leave the caller's own remembered width untouched. See `nextSize`'s own doc.
    func testNextSizeHoldsTheCallersCurrentValueOnTheCollapseFrame() {
        let r = resolve(translation: 140) // crosses the collapse threshold, see above
        XCTAssertTrue(r.isCollapsed, "sanity: this frame must be the collapse frame")
        XCTAssertEqual(r.size, 337, "sanity: what is drawn is still the floor")

        XCTAssertEqual(
            ResizeModel.nextSize(current: 480, resolution: r),
            480,
            "the caller's own width — not the floor `resolution.size` carries — survives"
        )
    }

    /// Every other frame is a plain pass-through: `nextSize` must not also swallow ordinary
    /// drag frames, or a widen/narrow drag would silently stop tracking the finger.
    func testNextSizeIsAPassThroughWhenNotCollapsed() {
        let r = resolve(translation: -100) // widens to 437, not collapsed
        XCTAssertFalse(r.isCollapsed, "sanity")

        XCTAssertEqual(ResizeModel.nextSize(current: 337, resolution: r), r.size)
    }

    // MARK: - Exact values, not merely close

    /// `ResizeModel` is a pure, stateless function of `(start, translation, edge,
    /// constraints)` — it holds nothing between calls — so no sequence of calls to it can
    /// ever "accumulate": there is no state left over from one call for a later one to add a
    /// delta onto. That is *why* resolving a live gesture from a frozen start and its total
    /// translation works as a design, but it also means a test built from two independent
    /// `resolve` calls, as this one is, cannot exercise that design by itself — it would pass
    /// exactly the same way even if `resolve` secretly cached its last answer, because neither
    /// call here depends on the other's result. The property these names used to claim to
    /// guard — that a live gesture resolves from one frozen `start` across many frames rather
    /// than drifting frame to frame — lives entirely in `ResizeHandle`'s `@GestureState
    /// anchor`, and nothing in this file touches that: `anchor` has no seam a value test on
    /// `ResizeModel` can reach. What these two tests actually pin, and can actually fail on,
    /// is arithmetic exactness — a value landing on the literal answer, not one merely close
    /// to it.
    ///
    /// Clamping at a bound lands on the literal bound (600, not 599.999996 or 600.0001), and a
    /// zero translation returns the literal start (337) rather than a value near it.
    func testClampingAtABoundAndAZeroTranslationBothProduceExactValues() {
        let out = resolve(translation: -900)
        XCTAssertEqual(out.size, 600, "pinned at the ceiling")
        XCTAssertEqual(resolve(translation: 0).size, 337, "exactly the start, not merely close")
    }

    /// The same exactness claim where nothing clamps: `337 - (-120) = 457`, to the point.
    func testAnUnclampedTranslationProducesTheExactProposedSize() {
        XCTAssertEqual(resolve(translation: -120).size, 457)
    }

    // MARK: - Rubber band

    func testRubberBandIsZeroAtZeroAndOddSymmetric() {
        XCTAssertEqual(ResizeModel.rubberBand(0, coefficient: 0.55, dimension: 337), 0)
        let positive = ResizeModel.rubberBand(100, coefficient: 0.55, dimension: 337)
        let negative = ResizeModel.rubberBand(-100, coefficient: 0.55, dimension: 337)
        XCTAssertEqual(positive, -negative, accuracy: 0.0001)
    }

    func testRubberBandGrowsMonotonicallyButAtADecreasingRate() {
        let a = ResizeModel.rubberBand(50, coefficient: 0.55, dimension: 337)
        let b = ResizeModel.rubberBand(100, coefficient: 0.55, dimension: 337)
        let c = ResizeModel.rubberBand(150, coefficient: 0.55, dimension: 337)
        XCTAssertTrue(a < b && b < c, "monotonic")
        XCTAssertTrue(b - a > c - b, "each further point of travel buys less")
        XCTAssertTrue(c < 337, "asymptotic to the dimension, never past it")
    }

    func testTheHandleOvershootsWhileTheSurfaceStaysPinned() {
        let r = resolve(translation: -400)
        XCTAssertEqual(r.size, 600, "the surface holds at its bound")
        // Leading edge, so a widening overshoot moves the handle further in the drag's own
        // negative direction.
        XCTAssertTrue(r.handleOffset < 0, "the handle keeps following the finger")
        XCTAssertTrue(abs(r.handleOffset) < abs(-400), "but with resistance")
    }

    func testTheHandleDoesNotOvershootInsideTheBounds() {
        XCTAssertEqual(resolve(translation: -100).handleOffset, 0)
    }

    // MARK: - Degenerate input

    func testUnsatisfiableConstraintsResolveToTheMinimumAndSayTheyArePinned() {
        // A window too narrow for both bounds. The model must not silently pick the maximum
        // and draw a panel wider than the board.
        let squeezed = ResizeConstraints(minimum: 337, maximum: 300, collapseBelow: 202)
        let r = ResizeModel.resolve(start: 337, translation: -50, edge: .leading, constraints: squeezed)
        XCTAssertEqual(r.size, 337, "size")
        XCTAssertEqual(r.limit, .minimum, "limit")
        XCTAssertEqual(r.handleOffset, 0, "handleOffset")
    }

    func testNonFiniteInputResolvesToTheStartRatherThanPropagatingNaN() {
        for bad in [CGFloat.nan, .infinity, -.infinity] {
            let r = resolve(translation: bad)
            XCTAssertEqual(r.size, 337, "translation \(bad)")
            XCTAssertFalse(r.isCollapsed, "translation \(bad) must not collapse")
            // 337 is `panel.minimum`, and resting exactly on it — as opposed to being pushed
            // past it — is the same non-event `testNoTranslationIsNoChange` reports as
            // `.none` for translation 0. A non-finite translation must not report a limit
            // just because the start it fell back to happens to coincide with the floor.
            XCTAssertEqual(r.limit, .none, "translation \(bad) must not report a limit at rest")
        }
        XCTAssertEqual(ResizeModel.resolve(
            start: .nan, translation: -10, edge: .leading, constraints: panel
        ).size, 337, "a non-finite start falls back to the minimum")
    }

    func testNonFiniteTranslationPreservesAnOffMinimumStartRatherThanSubstitutingTheMinimum() {
        // `resolve(translation:)` defaults `start` to 337, which is coincidentally also
        // `panel.minimum`, so nothing above proves the non-finite path kept `start` rather
        // than silently substituting the minimum for it. A start away from the minimum does.
        XCTAssertEqual(resolve(start: 500, translation: .nan).size, 500)
    }

    func testAStaleStartAboveTheNewMaximumClampsOnANonFiniteTranslation() {
        // A window resize (Split View, Stage Manager) can move `maximum` below a `start`
        // that was valid a moment ago. The very next non-finite translation must clamp to
        // the new bound rather than handing the view an over-wide frame — `size` promises to
        // stay within the constraints whenever they are satisfiable, and this path is no
        // exception.
        let shrunk = ResizeConstraints(minimum: 337, maximum: 600, collapseBelow: 202)
        let r = ResizeModel.resolve(start: 900, translation: .nan, edge: .leading, constraints: shrunk)
        XCTAssertEqual(r.size, 600, "size clamps to the new maximum rather than staying stale")
        XCTAssertEqual(r.limit, .maximum, "limit")
    }

    func testAFlickFarPastTheCeilingClampsRatherThanOvershooting() {
        XCTAssertEqual(resolve(translation: -100_000).size, 600)
    }

    // MARK: - Boundaries

    func testLandingExactlyOnTheMinimumIsNotReportedAsAtALimit() {
        // Proposed size lands exactly on the floor without being pushed past it, so this is
        // not a clamp: no limit, no handle overshoot.
        let r = ResizeModel.resolve(start: 400, translation: 63, edge: .leading, constraints: panel)
        XCTAssertEqual(r.size, 337, "size")
        XCTAssertEqual(r.limit, .none, "limit")
        XCTAssertEqual(r.handleOffset, 0, "handleOffset")
    }

    func testLandingExactlyOnTheMaximumIsNotReportedAsAtALimit() {
        let r = ResizeModel.resolve(start: 337, translation: -263, edge: .leading, constraints: panel)
        XCTAssertEqual(r.size, 600, "size")
        XCTAssertEqual(r.limit, .none, "limit")
        XCTAssertEqual(r.handleOffset, 0, "handleOffset")
    }

    func testAFixedSizeSurfaceWhereMinimumEqualsMaximumAlwaysResolvesToThatSize() {
        // Degenerate but legal: `isSatisfiable` only requires `maximum >= minimum`, and a
        // surface with no travel at all should still resolve deterministically rather than
        // hit the unsatisfiable branch.
        let fixed = ResizeConstraints(minimum: 400, maximum: 400)
        let r = ResizeModel.resolve(start: 400, translation: 50, edge: .leading, constraints: fixed)
        XCTAssertEqual(r.size, 400, "size")
        XCTAssertEqual(r.limit, .minimum, "limit")
    }

    // MARK: - The other edges

    func testATrailingEdgeSurfaceGrowsInTheOppositeDirection() {
        let r = ResizeModel.resolve(start: 337, translation: 100, edge: .trailing, constraints: panel)
        XCTAssertEqual(r.size, 437, "a left-hand sidebar widens when dragged right")
    }

    func testATopEdgeSurfaceGrowsTowardTheOrigin() {
        let r = ResizeModel.resolve(start: 337, translation: -100, edge: .top, constraints: panel)
        XCTAssertEqual(r.size, 437, "top edge, dragged up (negative), grows")
    }

    func testTheVerticalAxisUsesTheSameCodePath() {
        let r = ResizeModel.resolve(start: 337, translation: 100, edge: .bottom, constraints: panel)
        XCTAssertEqual(r.size, 437, "bottom edge, dragged down, grows")
    }
}
