import XCTest
@testable import MathTutor

/// The per-element bounds the raster cache sizes its tiles from.
///
/// `BoardSceneRenderer.bounds(of:boardOrigin:)` is the single place that
/// expands a primitive's geometry by its stroke inset and, when the style
/// rotates it, by the rotation sweep. The scene-level bounds are a union of
/// these, so a rule proven here holds for the whole board.
@MainActor
final class BoardElementBoundsTests: XCTestCase {
    func testLineBoundsIncludeStrokeInset() {
        var line = LineElement(id: "l", x1: 0, y1: 0, x2: 100, y2: 0)
        line.style.strokeWidth = 4
        let bounds = BoardSceneRenderer.bounds(of: .line(line), boardOrigin: .zero)
        XCTAssertEqual(bounds.minY, -2, accuracy: 0.01)
        XCTAssertEqual(bounds.height, 4, accuracy: 0.01)
    }

    func testRotatedBoundsCoverTheDiagonal() {
        var rect = RectangleElement(id: "r", x: 0, y: 0, width: 100, height: 10)
        rect.style.rotation = 45
        let bounds = BoardSceneRenderer.bounds(of: .rectangle(rect), boardOrigin: .zero)
        XCTAssertGreaterThan(bounds.width, 70)  // hypot(100,10)/2 * 2 ≈ 100.5, rotated circle bound
    }
}
