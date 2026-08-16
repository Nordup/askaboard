import PencilKit
import UIKit
import XCTest
@testable import MathTutor

@MainActor
final class BoardSceneRendererTests: XCTestCase {
    func testBoundsIncludeStrokeExtentsAndEndpoints() {
        let scene = BoardScene(elements: [
            .line(LineElement(
                id: "line",
                x1: -100, y1: -50, x2: 100, y2: 50,
                style: BoardStyle(
                    role: .content,
                    stroke: "#0A0A0A",
                    fill: "transparent",
                    strokeWidth: 10,
                    opacity: 1,
                    dash: [],
                    rotation: 0
                )
            ))
        ])
        let origin = PencilCanvasConfiguration.boardOrigin
        let bounds = try! XCTUnwrap(BoardSceneRenderer.bounds(of: scene, boardOrigin: origin))

        XCTAssertLessThanOrEqual(bounds.minX, origin.x - 100)
        XCTAssertGreaterThanOrEqual(bounds.maxX, origin.x + 100)
        XCTAssertLessThanOrEqual(bounds.minY, origin.y - 50 - 5)
        XCTAssertGreaterThanOrEqual(bounds.maxY, origin.y + 50 + 5)
    }

    func testRenderPNGIsColoredAndNonBlank() throws {
        let scene = BoardScene(elements: [
            .rectangle(RectangleElement(
                id: "box",
                x: -100, y: -100, width: 200, height: 200,
                style: BoardStyle(
                    role: .content,
                    stroke: "#E33E38",
                    fill: "#FFE3E3",
                    strokeWidth: 8,
                    opacity: 1,
                    dash: [],
                    rotation: 0
                )
            ))
        ])
        let origin = PencilCanvasConfiguration.boardOrigin
        let drawingRect = CGRect(x: origin.x - 120, y: origin.y - 120, width: 240, height: 240)
        let data = try XCTUnwrap(
            BoardSceneRenderer.renderPNG(scene: scene, drawingRect: drawingRect)
        )
        let image = try XCTUnwrap(UIImage(data: data))
        let cgImage = try XCTUnwrap(image.cgImage)
        let width = cgImage.width
        let height = cgImage.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        let center = ((height / 2) * width + width / 2) * 4
        XCTAssertGreaterThan(Int(pixels[center]), 200, "center should be red-ish, not blank")
        XCTAssertGreaterThan(
            Int(pixels[center]) - Int(pixels[center + 2]),
            10,
            "red fill should dominate blue"
        )
    }

    func testSemanticOnlyCaptureProducesOverviewRegionsAndEvaluation() {
        let capture = CanvasCapture()
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_000, height: 700))
        capture.canvasView = canvas
        capture.refreshHasInk()
        XCTAssertFalse(capture.hasInk)
        capture.scene = BoardScene(elements: [
            .circle(CircleElement(
                id: "circle",
                cx: 50, cy: 0, radius: 120,
                style: BoardStyle(
                    role: .content,
                    stroke: "#0155FB",
                    fill: "transparent",
                    strokeWidth: 6,
                    opacity: 1,
                    dash: [],
                    rotation: 0
                )
            ))
        ])
        capture.refreshHasInk()
        XCTAssertTrue(capture.hasInk, "a semantic-only board is still board content")

        XCTAssertNotNil(capture.overviewData())
        XCTAssertNotNil(capture.renderRegion(percent: CGRect(x: 0, y: 0, width: 100, height: 100)))
        XCTAssertNotNil(capture.snapshotAllInkData())
        XCTAssertTrue(capture.contentExtent()?.width ?? 0 > 0)
    }

    /// The board of a session the learner is not looking at has no
    /// `PKCanvasView` behind it, and `view_board` still has to answer for it.
    /// This is the render that has no canvas to read — it is handed the
    /// drawing and the scene instead.
    func testARegionRendersFromStoredBoardStateWithNoCanvas() {
        let scene = BoardScene(elements: [
            .circle(CircleElement(
                id: "circle",
                cx: 50, cy: 0, radius: 120,
                style: BoardStyle(
                    role: .content,
                    stroke: "#0155FB",
                    fill: "transparent",
                    strokeWidth: 6,
                    opacity: 1,
                    dash: [],
                    rotation: 0
                )
            ))
        ])

        let data = CanvasCapture.regionPNG(
            percent: CGRect(x: 0, y: 0, width: 100, height: 100),
            drawing: PKDrawing(),
            scene: scene
        )

        XCTAssertNotNil(data, "a stored scene is a board, canvas or no canvas")
    }

    /// The one honest `nil`: nothing has been drawn and nothing placed, so
    /// there is no region to render and the device must say so rather than
    /// send white paper.
    func testAnEmptyStoredBoardRendersNothing() {
        XCTAssertNil(
            CanvasCapture.regionPNG(
                percent: CGRect(x: 0, y: 0, width: 100, height: 100),
                drawing: PKDrawing(),
                scene: .empty
            )
        )
    }

    func testCenterOnContentIncludesTutorSceneWhenThereIsNoInk() {
        let capture = CanvasCapture()
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_000, height: 700))
        canvas.contentSize = PencilCanvasConfiguration.contentSize(for: canvas.bounds.size)
        canvas.zoomScale = 1
        capture.canvasView = canvas
        capture.scene = BoardScene(elements: [
            .text(TextElement(
                id: "target",
                x: 800, y: 600, text: "here", fontSize: 48,
                alignment: .left, width: 0, style: BoardStyle()
            ))
        ])

        capture.centerOnContent(animated: false)

        let origin = PencilCanvasConfiguration.boardOrigin
        XCTAssertGreaterThan(canvas.contentOffset.x, origin.x - 1_000)
        XCTAssertGreaterThan(canvas.contentOffset.y, origin.y - 1_000)
    }

    func testSceneContextStringDescribesSystemVisibleRectAndElements() throws {
        let capture = CanvasCapture()
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_000, height: 700))
        canvas.contentSize = PencilCanvasConfiguration.contentSize(for: canvas.bounds.size)
        canvas.contentOffset = CGPoint(x: 25_500, y: 24_650)
        canvas.zoomScale = 1
        capture.canvasView = canvas
        capture.scene = BoardScene(elements: [
            .arrow(ArrowElement(
                id: "vector",
                x1: 0, y1: 0, x2: 300, y2: -180, headSize: 16,
                style: BoardStyle(role: .content, stroke: "#0155FB", fill: "transparent",
                                  strokeWidth: 4, opacity: 1, dash: [], rotation: 0)
            ))
        ])

        let data = try XCTUnwrap(capture.sceneContextString()?.data(using: .utf8))
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(object["kind"] as? String, "board_scene_context")
        let visible = try XCTUnwrap(object["visible_logical_rect"] as? [Double])
        // The visible rect must be a single origin subtraction: drawing
        // offset (25,500, 24,650) minus origin (25,000, 25,000), with the
        // viewport width/height unchanged.
        let expectedVisible: [Double] = [500, -350, 1_500, 350]
        XCTAssertEqual(visible, expectedVisible)
        // The tutor layout contract: stable fractions of the visible rect,
        // with the recommended band in the upper half and the learner band
        // below an 8% gutter.
        XCTAssertEqual(
            object["recommended_tutor_rect"] as? [Double],
            [560, -308, 1_440, 0]
        )
        XCTAssertEqual(
            object["reserved_learner_work_rect"] as? [Double],
            [560, 56, 1_440, 308]
        )
        XCTAssertEqual((object["overview_logical_bounds"] as? [Double])?.count, 4)
        XCTAssertNotNil(object["tutor_elements"])
        XCTAssertTrue(data.count <= 60_000)
    }

    func testLayoutRegionsDeriveStableFractionsOfTheVisibleRect() {
        let visible = CGRect(x: 500, y: -350, width: 1_000, height: 700)
        let regions = CanvasCapture.layoutRegions(visible: visible)

        XCTAssertEqual(
            regions.recommendedTutor,
            CGRect(x: 560, y: -308, width: 880, height: 308)
        )
        XCTAssertEqual(
            regions.reservedLearnerWork,
            CGRect(x: 560, y: 56, width: 880, height: 252)
        )
        // Recommended band ends before the learner band begins: the gutter
        // between them stays clear.
        XCTAssertLessThanOrEqual(
            regions.recommendedTutor.maxY,
            regions.reservedLearnerWork.minY
        )
    }

    func testRightAlignedWideTextHonorsBoxWidthAndAlignment() throws {
        let scene = BoardScene(elements: [
            .text(TextElement(
                id: "wide-right",
                x: -300,
                y: -40,
                text: "long exercise line\nsecond line",
                fontSize: 48,
                alignment: .right,
                width: 600,
                style: BoardStyle(
                    role: .content,
                    stroke: "#0A0A0A",
                    fill: "transparent",
                    strokeWidth: 2,
                    opacity: 1,
                    dash: [],
                    rotation: 0
                )
            ))
        ])
        let origin = PencilCanvasConfiguration.boardOrigin
        let bounds = try XCTUnwrap(
            BoardSceneRenderer.bounds(of: scene, boardOrigin: origin)
        )

        // The box is 600 wide and is not allowed to shrink to natural width.
        XCTAssertEqual(bounds.width, 600, accuracy: 0.001)
        XCTAssertGreaterThan(bounds.height, 40, "multiline text must be measured naturally")
        XCTAssertEqual(bounds.minX, origin.x - 300, accuracy: 0.001)

        let data = try XCTUnwrap(
            BoardSceneRenderer.renderPNG(
                scene: scene,
                drawingRect: CGRect(x: origin.x - 320, y: origin.y - 160, width: 640, height: 320)
            )
        )
        XCTAssertFalse(data.isEmpty)
    }

    func testArcSupportsPreciseClockwiseSweepGreaterThan180Degrees() throws {
        let scene = BoardScene(elements: [
            .arc(ArcElement(
                id: "large-arc",
                cx: 0,
                cy: 0,
                radius: 100,
                startAngle: 0,
                endAngle: 270,
                style: BoardStyle(
                    role: .content,
                    stroke: "#0155FB",
                    fill: "transparent",
                    strokeWidth: 6,
                    opacity: 1,
                    dash: [],
                    rotation: 0
                )
            ))
        ])
        let origin = PencilCanvasConfiguration.boardOrigin
        let bounds = try XCTUnwrap(
            BoardSceneRenderer.bounds(of: scene, boardOrigin: origin)
        )

        // A 270-degree clockwise sweep from 0 touches all four quadrant
        // extremes: right, bottom, left, and top of the circle.
        XCTAssertLessThanOrEqual(bounds.minX, origin.x - 100)
        XCTAssertGreaterThanOrEqual(bounds.maxX, origin.x + 100)
        XCTAssertLessThanOrEqual(bounds.minY, origin.y - 100)
        XCTAssertGreaterThanOrEqual(bounds.maxY, origin.y + 100)
    }
}
