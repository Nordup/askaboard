import CoreGraphics
import XCTest
@testable import MathTutor

/// Axis C's new middle state and the geometry of the drag that produces it.
///
/// The behaviour under test is the one board 05 open question 7 leaves undrawn:
/// `btn/select` used to attach the whole board because there was nowhere for a
/// picked region to live, so tapping it changed nothing a student could see and
/// no pencil drag could narrow it.
final class BoardSelectionTests: XCTestCase {
    func testAnIdleSelectionLeavesTheBoardInking() {
        let selection = BoardSelection.none

        XCTAssertNil(selection.region)
        XCTAssertFalse(selection.isAttached)
        XCTAssertFalse(selection.capturesBoardDrags, "With nothing selected the pencil must still write")
    }

    func testArmingTakesThePencilOffTheInkBeforeAnyRegionExists() {
        let selection = BoardSelection.arming

        XCTAssertNil(selection.region)
        XCTAssertFalse(selection.isAttached)
        XCTAssertTrue(
            selection.capturesBoardDrags,
            "btn/select has to take the pencil off the ink, or the drag that picks a region writes one instead"
        )
    }

    func testAnAttachedRegionStaysArmedSoASecondDragCanRedrawIt() {
        let region = CGRect(x: 10, y: 20, width: 100, height: 80)
        let selection = BoardSelection.attached(region)

        XCTAssertEqual(selection.region, region)
        XCTAssertTrue(selection.isAttached)
        XCTAssertTrue(
            selection.capturesBoardDrags,
            "A student who mis-drew a region must be able to drag a new one rather than write over their work"
        )
    }

    // MARK: - The drag

    func testAMarqueePicksTheSameRegionWhicheverWayItIsDragged() {
        let downRight = BoardMarquee.region(from: CGPoint(x: 10, y: 20), to: CGPoint(x: 110, y: 120))
        let upLeft = BoardMarquee.region(from: CGPoint(x: 110, y: 120), to: CGPoint(x: 10, y: 20))

        XCTAssertEqual(downRight, CGRect(x: 10, y: 20, width: 100, height: 100))
        XCTAssertEqual(upLeft, downRight, "Dragging up-and-left picks the region, not a negative one")
    }

    func testADragTooSmallToBeARegionIsNotCommitted() {
        let slip = BoardMarquee.committedRegion(
            from: CGPoint(x: 40, y: 40),
            to: CGPoint(x: 40 + BoardMarquee.minimumSide - 1, y: 90)
        )

        XCTAssertNil(slip, "A tap that slipped must not crop the board to a strip of blank paper")
    }

    func testADragPastTheMinimumOnBothSidesIsCommitted() {
        let region = BoardMarquee.committedRegion(from: CGPoint(x: 40, y: 40), to: CGPoint(x: 100, y: 90))

        XCTAssertEqual(region, CGRect(x: 40, y: 40, width: 60, height: 50))
    }
}
