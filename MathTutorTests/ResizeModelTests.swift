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
}
