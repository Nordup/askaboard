import UIKit
import XCTest
@testable import MathTutor

/// The layer view is the board's render loop. Its contract has three parts:
/// the cull decides what exists at all, the viewport maths decides where the
/// cull looks, and the raster cache decides what is drawn twice. Every test
/// below pins one of those three, because a regression in any of them is
/// invisible in a screenshot until the board is large.
@MainActor
final class BoardSceneLayerTests: XCTestCase {
    private func scene(_ elements: [BoardElement]) -> BoardScene {
        BoardScene(elements: elements)
    }

    private func circle(_ id: String, _ cx: CGFloat, _ cy: CGFloat) -> BoardElement {
        .circle(CircleElement(id: id, cx: cx, cy: cy, radius: 10))
    }

    private func makeView() -> BoardSceneLayerView {
        let view = BoardSceneLayerView(frame: CGRect(x: 0, y: 0, width: 1_000, height: 800))
        view.boardOrigin = .zero
        return view
    }

    // MARK: - The cull

    func testCullingKeepsOnlyViewportIntersectingElements() {
        let ids = BoardSceneLayerView.visibleIds(
            scene: scene([circle("in", 100, 100), circle("out", 5_000, 5_000)]),
            viewport: CGRect(x: 0, y: 0, width: 1_000, height: 800),
            boardOrigin: .zero,
            margin: 200
        )
        XCTAssertEqual(ids, ["in"])
    }

    func testMarginKeepsNearOffscreenElements() {
        let ids = BoardSceneLayerView.visibleIds(
            scene: scene([circle("near", 1_100, 400)]),
            viewport: CGRect(x: 0, y: 0, width: 1_000, height: 800),
            boardOrigin: .zero,
            margin: 200
        )
        XCTAssertEqual(ids, ["near"])
    }

    /// `BoardSceneRenderer.bounds(of:boardOrigin:)` returns DRAWING
    /// coordinates, so the viewport the cull is given must be drawing
    /// coordinates too. On the real board the origin is 25,000 points in;
    /// culling in board coordinates would hide the whole scene.
    func testCullingComparesInDrawingCoordinates() {
        let origin = CGPoint(x: 25_000, y: 25_000)
        let atBoardZero = scene([circle("c", 0, 0)])
        XCTAssertEqual(
            BoardSceneLayerView.visibleIds(
                scene: atBoardZero,
                viewport: CGRect(x: 0, y: 0, width: 1_000, height: 800),
                boardOrigin: origin,
                margin: 0
            ),
            []
        )
        XCTAssertEqual(
            BoardSceneLayerView.visibleIds(
                scene: atBoardZero,
                viewport: CGRect(x: 24_800, y: 24_800, width: 400, height: 400),
                boardOrigin: origin,
                margin: 0
            ),
            ["c"]
        )
    }

    // MARK: - Mounting

    func testReconcileMountsOnlyVisibleLayers() {
        let view = makeView()
        view.scene = scene([circle("in", 100, 100), circle("out", 9_000, 9_000)])
        view.setViewport(contentOffset: .zero, zoomScale: 1)
        XCTAssertEqual(view.mountedElementIdsForTesting, ["in"])
    }

    /// The sign of `contentOffset`: a scroll to x=4,000 shows the board around
    /// x=4,000, not around x=-4,000. A flipped sign passes every static cull
    /// test above and still leaves the board blank on the device.
    func testPanMountsTheNewlyVisibleAndDropsTheRest() {
        let view = makeView()
        view.scene = scene([circle("in", 100, 100), circle("far", 4_500, 400)])
        view.setViewport(contentOffset: .zero, zoomScale: 1)
        XCTAssertEqual(view.mountedElementIdsForTesting, ["in"])
        view.setViewport(contentOffset: CGPoint(x: 4_000, y: 0), zoomScale: 1)
        XCTAssertEqual(view.mountedElementIdsForTesting, ["far"])
    }

    func testDeletedElementsUnmount() {
        let view = makeView()
        view.scene = scene([circle("a", 100, 100), circle("b", 300, 300)])
        XCTAssertEqual(view.mountedElementIdsForTesting, ["a", "b"])
        view.scene = scene([circle("a", 100, 100)])
        XCTAssertEqual(view.mountedElementIdsForTesting, ["a"])
    }

    /// A zero-area element has no bitmap to show. It must not reach a
    /// `CALayer` — an empty rectangle never intersects the viewport, and the
    /// mount path refuses it a second time.
    func testDegenerateBoundsNeverMount() {
        let view = makeView()
        view.scene = scene([
            .rectangle(RectangleElement(
                id: "flat",
                x: 100,
                y: 100,
                width: 0,
                height: 0,
                style: BoardStyle(strokeWidth: 0)
            ))
        ])
        XCTAssertEqual(view.mountedElementIdsForTesting, [])
    }

    /// Layers are mounted half a viewport beyond the visible edge, so the view
    /// has to clip. Without this the prefetched band composites outside the
    /// canvas, over the chat panel beside it.
    func testPrefetchedLayersAreClippedToTheViewport() {
        XCTAssertTrue(makeView().clipsToBounds)
    }

    // MARK: - Rasters

    /// Crossing a zoom bucket is the one thing that re-rasterizes. The bitmap
    /// for the new bucket is a second cache entry, so the cache grows.
    func testCrossingAZoomBucketRasterizesAgain() {
        let view = makeView()
        view.scene = scene([circle("in", 100, 100)])
        view.setViewport(contentOffset: .zero, zoomScale: 1)
        let atBucketZero = view.rasterCacheBytesForTesting
        XCTAssertGreaterThan(atBucketZero, 0)
        view.setViewport(contentOffset: .zero, zoomScale: 2)
        XCTAssertGreaterThan(view.rasterCacheBytesForTesting, atBucketZero)
    }

    /// A figure large enough to blow the pixel cap at high zoom is drawn whole
    /// at a reduced scale, not dropped. A 1,200-point square asks for 9,600
    /// pixels a side at bucket 2 (4x bucket, 2x display) — 92 million pixels,
    /// past the 64 million cap — and a normal pinch reaches that bucket, so
    /// refusing on pixels alone would make ordinary figures vanish at maximum
    /// zoom.
    func testLargeElementIsRasterizedSofterRatherThanDropped() {
        let view = makeView()
        // The bucket is set before the scene so the element is rasterized once.
        view.setViewport(contentOffset: .zero, zoomScale: 4)
        view.scene = scene([
            .rectangle(RectangleElement(
                id: "big",
                x: 0,
                y: 0,
                width: 1_200,
                height: 1_200,
                style: BoardStyle(strokeWidth: 0)
            ))
        ])
        guard let raster = view.mountedRasterForTesting(id: "big") else {
            return XCTFail("a large but legitimate figure must still be drawn")
        }
        XCTAssertLessThanOrEqual(raster.width * raster.height, 64_000_000)
        XCTAssertLessThan(raster.width, 9_600, "the scale must have been reduced")
        XCTAssertGreaterThan(raster.width, 1_200, "and still be finer than one pixel per point")
    }

    /// Area alone does not bound a bitmap's longest side: a rule across the
    /// board is 20,000 points long and a few points tall, so its area is tiny
    /// while its width at bucket scale is past any GPU's texture limit. Core
    /// Animation would drop such a texture, so it is rasterized coarser.
    func testBoardWidthLineStaysInsideTheTextureLimit() {
        let view = makeView()
        view.scene = scene([.line(LineElement(id: "rule", x1: 0, y1: 100, x2: 20_000, y2: 100))])
        guard let raster = view.mountedRasterForTesting(id: "rule") else {
            return XCTFail("a board-width line must still be drawn")
        }
        XCTAssertLessThanOrEqual(raster.width, 16_384)
        XCTAssertGreaterThanOrEqual(raster.height, 1)
    }

    /// The other branch. An element whose board-point area is absurd is one
    /// whose coordinates the server never clamped, and it is refused: no
    /// bitmap, and nothing stored under a key that would serve it again.
    func testAbsurdlyLargeElementIsRefusedWithoutCaching() {
        let view = makeView()
        view.scene = scene([
            .rectangle(RectangleElement(
                id: "huge",
                x: 0,
                y: 0,
                width: 10_000,
                height: 10_000,
                style: BoardStyle(strokeWidth: 0)
            ))
        ])
        XCTAssertEqual(view.mountedElementIdsForTesting, ["huge"])
        XCTAssertNil(view.mountedRasterForTesting(id: "huge"))
        XCTAssertEqual(view.rasterCacheBytesForTesting, 0)
    }

    /// An `svg` element whose WebKit artifact has not landed draws nothing.
    /// The cache key is the element value and that value does not change when
    /// the artifact arrives, so caching the empty bitmap now would serve an
    /// empty picture for the rest of the session.
    func testIncompleteSVGIsNeverCached() {
        // A unique document guarantees a cache miss even when another test in
        // this process already rendered SVGs through the shared cache.
        let markup = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\
        <desc>\(UUID().uuidString)</desc><rect width="10" height="10" fill="#123456"/></svg>
        """
        let view = makeView()
        view.scene = scene([
            .svg(SVGElement(id: "s", x: 100, y: 100, width: 50, height: 50, svg: markup))
        ])
        XCTAssertEqual(view.mountedElementIdsForTesting, ["s"])
        XCTAssertEqual(view.rasterCacheBytesForTesting, 0)
    }
}
