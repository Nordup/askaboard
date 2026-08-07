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

    // MARK: - Anchored, not accumulated

    /// The property the whole model exists to guarantee, and the bug it exists to prevent.
    ///
    /// A resizer that accumulates per-frame deltas loses the travel spent pinned at a bound:
    /// each frame clamps, and the clamped value becomes the next frame's start, so dragging
    /// 300pt past the ceiling and 300pt back leaves the panel stuck at the ceiling instead
    /// of where it began. Resolving from the frozen start size and the gesture's *total*
    /// translation makes the round trip exact.
    func testDraggingPastABoundAndBackReturnsExactlyToTheStart() {
        let out = resolve(translation: -900)
        XCTAssertEqual(out.size, 600, "pinned at the ceiling on the way out")
        XCTAssertEqual(resolve(translation: 0).size, 337, "exactly back, not merely close")
    }

    func testResolutionDependsOnlyOnTotalTranslationNotOnHowItWasReached() {
        XCTAssertEqual(resolve(translation: -120).size, resolve(translation: -120).size)
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
        }
        XCTAssertEqual(ResizeModel.resolve(
            start: .nan, translation: -10, edge: .leading, constraints: panel
        ).size, 337, "a non-finite start falls back to the minimum")
    }

    func testAFlickFarPastTheCeilingClampsRatherThanOvershooting() {
        XCTAssertEqual(resolve(translation: -100_000).size, 600)
    }

    // MARK: - The other edges

    func testATrailingEdgeSurfaceGrowsInTheOppositeDirection() {
        let r = ResizeModel.resolve(start: 337, translation: 100, edge: .trailing, constraints: panel)
        XCTAssertEqual(r.size, 437, "a left-hand sidebar widens when dragged right")
    }

    func testTheVerticalAxisUsesTheSameCodePath() {
        let r = ResizeModel.resolve(start: 337, translation: 100, edge: .bottom, constraints: panel)
        XCTAssertEqual(r.size, 437, "bottom edge, dragged down, grows")
    }
}
