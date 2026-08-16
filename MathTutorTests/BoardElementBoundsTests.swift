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

    /// The arc arm of `angle_marker`, at a radius under the floor the drawing
    /// applies.
    ///
    /// `draw(angleMarker:in:)` draws the arc at `max(4, radius)`, so a marker
    /// the model wrote with `radius: 1` is still four points out from the
    /// vertex. Sizing the tile from `max(radius, inset)` instead reported a
    /// rectangle of half the stroke width — three points across for an arc
    /// eight points across — and the layer view drew the element into it.
    func testASmallAngleMarkerBoundsTheArcTheRendererActuallyDraws() {
        var marker = AngleMarkerElement(
            id: "a", vertexX: 100, vertexY: 100,
            ray1X: 200, ray1Y: 100, ray2X: 100, ray2Y: 200,
            radius: 1
        )
        marker.style.strokeWidth = 6

        let bounds = BoardSceneRenderer.bounds(of: .angleMarker(marker), boardOrigin: .zero)

        // The drawn radius floors at 4, and the stroke puts half its width
        // outside that: a box of 2 * (4 + 3) on a side, centred on the vertex.
        XCTAssertEqual(bounds.minX, 93, accuracy: 0.01)
        XCTAssertEqual(bounds.minY, 93, accuracy: 0.01)
        XCTAssertEqual(bounds.width, 14, accuracy: 0.01)
        XCTAssertEqual(bounds.height, 14, accuracy: 0.01)
    }

    /// And at an ordinary radius the stroke inset is still there. The arc is
    /// centred on the radius, so half the pen hangs outside it — the same
    /// expansion every other stroked kind takes, and the one the right-angle
    /// arm of this same element already took.
    func testAngleMarkerBoundsIncludeTheStrokeInset() {
        var marker = AngleMarkerElement(
            id: "a", vertexX: 0, vertexY: 0,
            ray1X: 100, ray1Y: 0, ray2X: 0, ray2Y: 100,
            radius: 40
        )
        marker.style.strokeWidth = 8

        let bounds = BoardSceneRenderer.bounds(of: .angleMarker(marker), boardOrigin: .zero)

        XCTAssertEqual(bounds.width, 88, accuracy: 0.01)
        XCTAssertEqual(bounds.height, 88, accuracy: 0.01)
        XCTAssertEqual(bounds.minX, -44, accuracy: 0.01)
    }

    func testRotatedBoundsCoverTheDiagonal() {
        var rect = RectangleElement(id: "r", x: 0, y: 0, width: 100, height: 10)
        rect.style.rotation = 45
        let bounds = BoardSceneRenderer.bounds(of: .rectangle(rect), boardOrigin: .zero)
        XCTAssertGreaterThan(bounds.width, 70)  // hypot(100,10)/2 * 2 ≈ 100.5, rotated circle bound
    }
}
