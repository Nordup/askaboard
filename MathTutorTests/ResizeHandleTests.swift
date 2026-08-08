import CoreGraphics
import XCTest
@testable import MathTutor

/// The handle's own spec. The gesture itself is not asserted here — that is `ResizeModel`'s
/// job, and it is a function — so what is left is the hit geometry, which is the part with a
/// wrong answer that looks right.
final class ResizeHandleTests: XCTestCase {
    func testTheStripClaimsTheGutterPlusOnlyItsOwnSidesDeadMargin() {
        // 24pt of --space-gap, plus the panel's 18pt --space-panel-inset, and nothing at all
        // from the board: the board is a live PKCanvasView and any overlap eats ink.
        XCTAssertEqual(
            ResizeHandleMetrics.hitBreadth(gutter: DS.Space.gap, into: DS.Space.panelInset),
            42
        )
    }

    func testTheStripIsNeverNarrowerThanTheGutterItSitsIn() {
        XCTAssertEqual(ResizeHandleMetrics.hitBreadth(gutter: DS.Space.gap, into: 0), 24)
        XCTAssertEqual(
            ResizeHandleMetrics.hitBreadth(gutter: DS.Space.gap, into: -100),
            24,
            "a negative margin cannot shrink the strip below its gutter"
        )
    }

    /// 42 is under the HIG's 44, and that is a deliberate trade rather than an oversight: the
    /// strip is 42 × the full content band, and a long thin target is easy to acquire. The
    /// alternative was claiming two points of canvas, which is not a trade worth making.
    func testTheStripIsWithinTwoPointsOfTheHIGMinimum() {
        let breadth = ResizeHandleMetrics.hitBreadth(gutter: DS.Space.gap, into: DS.Space.panelInset)
        XCTAssertGreaterThanOrEqual(breadth, 42)
        // `abs`, not a bare `44 - breadth`: the un-absoluted form is algebraically identical
        // to the `>=` above (`44 - breadth <= 2` ⟺ `breadth >= 42`) and would still pass at
        // a breadth of 1000 — it asserts the same fact twice rather than bounding the gap
        // from above.
        XCTAssertLessThanOrEqual(abs(44 - breadth), 2)
    }

    func testTheDragHasToTravelBeforeItCounts() {
        XCTAssertGreaterThan(
            ResizeHandleMetrics.minimumDragDistance,
            0,
            "otherwise a tap on the strip resizes the panel by half a point"
        )
    }

    func testTheAccessibilityStepIsTheDesignSystemsGap() {
        XCTAssertEqual(ResizeHandleMetrics.accessibilityStep, DS.Space.gap)
    }
}
