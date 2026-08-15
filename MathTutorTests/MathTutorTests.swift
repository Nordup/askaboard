import Foundation
import PencilKit
import UIKit
import XCTest
@testable import MathTutor

final class MathTutorTests: XCTestCase {
    func testAppearancePreferenceDefaultsToLightAndRoundTrips() throws {
        let suiteName = "MathTutorTests.appearance.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertEqual(AppearancePreference.load(from: defaults), .light)
        AppearancePreference.save(.dark, to: defaults)
        XCTAssertEqual(AppearancePreference.load(from: defaults), .dark)
        AppearancePreference.save(.system, to: defaults)
        XCTAssertEqual(AppearancePreference.load(from: defaults), .system)

        defaults.set("unsupported", forKey: AppearancePreference.key)
        XCTAssertEqual(AppearancePreference.load(from: defaults), .light)
    }

    func testCanvasViewportMapperTracksPanAndZoom() {
        let bounds = CGRect(x: 80, y: 120, width: 1_000, height: 700)
        let selectedViewport = CGRect(x: 100, y: 200, width: 240, height: 120)
        let drawingRect = CanvasViewportMapper.drawingRect(
            for: selectedViewport,
            canvasBounds: bounds,
            zoomScale: 2
        )

        XCTAssertEqual(drawingRect.origin.x, 90, accuracy: 0.001)
        XCTAssertEqual(drawingRect.origin.y, 160, accuracy: 0.001)
        XCTAssertEqual(drawingRect.width, 120, accuracy: 0.001)
        XCTAssertEqual(drawingRect.height, 60, accuracy: 0.001)
    }

    func testPencilCanvasConfigurationCentersAnInfiniteBoard() {
        let viewport = CGSize(width: 1_024, height: 768)
        let contentSize = PencilCanvasConfiguration.contentSize(for: viewport)

        XCTAssertEqual(contentSize.width, PencilCanvasConfiguration.boardExtent)
        XCTAssertEqual(contentSize.height, PencilCanvasConfiguration.boardExtent)
        XCTAssertEqual(PencilCanvasConfiguration.boardOrigin, CGPoint(x: 25_000, y: 25_000))

        // The session starts in the middle of the board, not at a corner, which
        // is what makes panning up and left possible at all.
        let offset = PencilCanvasConfiguration.initialContentOffset(viewport: viewport)
        XCTAssertEqual(offset.x, 25_000 - 512, accuracy: 0.001)
        XCTAssertEqual(offset.y, 25_000 - 384, accuracy: 0.001)

        XCTAssertEqual(PencilCanvasConfiguration.minimumZoomScale, 0.25, accuracy: 0.0001)
        XCTAssertLessThan(PencilCanvasConfiguration.minimumZoomScale, PencilCanvasConfiguration.defaultZoomScale)
        XCTAssertLessThan(PencilCanvasConfiguration.defaultZoomScale, PencilCanvasConfiguration.maximumZoomScale)
    }

    func testCanvasScrollerCentersInkAndClampsAtBoardEdges() {
        let viewport = CGSize(width: 1_000, height: 800)
        let board = CGSize(width: 50_000, height: 50_000)

        let centered = CanvasScroller.offset(
            centering: CGRect(x: 24_800, y: 24_900, width: 400, height: 200),
            viewport: viewport,
            zoomScale: 1,
            scaledContentSize: board
        )
        XCTAssertEqual(centered.x, 24_500, accuracy: 0.001)
        XCTAssertEqual(centered.y, 24_600, accuracy: 0.001)

        // Ink near a corner cannot be centered; the offset clamps to the
        // scrollable range instead of scrolling past the board.
        let clampedLow = CanvasScroller.offset(
            centering: CGRect(x: 10, y: 10, width: 20, height: 20),
            viewport: viewport,
            zoomScale: 1,
            scaledContentSize: board
        )
        XCTAssertEqual(clampedLow.x, 0, accuracy: 0.001)
        XCTAssertEqual(clampedLow.y, 0, accuracy: 0.001)

        let clampedHigh = CanvasScroller.offset(
            centering: CGRect(x: 49_980, y: 49_980, width: 10, height: 10),
            viewport: viewport,
            zoomScale: 1,
            scaledContentSize: board
        )
        XCTAssertEqual(clampedHigh.x, 49_000, accuracy: 0.001)
        XCTAssertEqual(clampedHigh.y, 49_200, accuracy: 0.001)

        // The target is unscaled drawing space, the result is scaled scroll
        // space, so the same ink sits twice as far out at 2x zoom.
        let zoomed = CanvasScroller.offset(
            centering: CGRect(x: 24_800, y: 24_900, width: 400, height: 200),
            viewport: viewport,
            zoomScale: 2,
            scaledContentSize: CGSize(width: 100_000, height: 100_000)
        )
        XCTAssertEqual(zoomed.x, 49_500, accuracy: 0.001)
        XCTAssertEqual(zoomed.y, 49_600, accuracy: 0.001)
    }

    func testDrawingDataRoundTripsCoordinatesNearBoardOrigin() throws {
        let origin = PencilCanvasConfiguration.boardOrigin
        let locations = [
            CGPoint(x: origin.x, y: origin.y),
            CGPoint(x: origin.x + 37.5, y: origin.y - 12.25),
            CGPoint(x: origin.x + 120.125, y: origin.y + 240.75)
        ]
        let controlPoints = locations.enumerated().map { index, point in
            PKStrokePoint(
                location: point,
                timeOffset: Double(index) * 0.02,
                size: CGSize(width: 8, height: 8),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        let path = PKStrokePath(controlPoints: controlPoints, creationDate: Date(timeIntervalSinceReferenceDate: 0))
        let drawing = PKDrawing(strokes: [
            PKStroke(ink: PKInk(.pen, color: .black), path: path, transform: .identity, mask: nil, randomSeed: 13)
        ])

        let restored = try PKDrawing(data: drawing.dataRepresentation())
        let restoredPath = try XCTUnwrap(restored.strokes.first?.path)
        XCTAssertEqual(restoredPath.count, locations.count)

        // Serialized ink keeps sub-pixel accuracy this far from zero: a 32-bit
        // float quantizes to ~0.002pt at 25,000, far below the 0.5pt physical
        // pixel. This fails loudly if the board extent ever grows enough for
        // that error to become visible.
        for (index, expected) in locations.enumerated() {
            XCTAssertEqual(restoredPath[index].location.x, expected.x, accuracy: 0.01)
            XCTAssertEqual(restoredPath[index].location.y, expected.y, accuracy: 0.01)
        }
    }

    @MainActor
    func testPencilCanvasConfigurationUsesPencilOnlyAndNativeFingerGestures() {
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        PencilCanvasConfiguration.configure(canvas, viewport: canvas.bounds.size)

        XCTAssertEqual(canvas.drawingPolicy, .pencilOnly)
        XCTAssertTrue(canvas.isScrollEnabled)
        XCTAssertEqual(canvas.minimumZoomScale, PencilCanvasConfiguration.minimumZoomScale)
        XCTAssertEqual(canvas.maximumZoomScale, PencilCanvasConfiguration.maximumZoomScale)
        XCTAssertEqual(canvas.zoomScale, PencilCanvasConfiguration.defaultZoomScale)
        XCTAssertEqual(canvas.panGestureRecognizer.allowedTouchTypes.first?.intValue, UITouch.TouchType.direct.rawValue)
        XCTAssertEqual(canvas.pinchGestureRecognizer?.allowedTouchTypes.first?.intValue, UITouch.TouchType.direct.rawValue)
    }

    @MainActor
    func testPreserveViewportReconfigureKeepsThePlaceAtNonDefaultZoom() {
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        PencilCanvasConfiguration.configure(canvas, viewport: canvas.bounds.size)
        canvas.setZoomScale(2, animated: false)
        let panned = CGPoint(x: 60_000, y: 61_000)
        canvas.contentOffset = panned

        // A rotation or split-view resize reconfigures with the viewport
        // preserved. The student must stay exactly where they were working,
        // and the whole board must stay reachable at that zoom.
        PencilCanvasConfiguration.configure(canvas, viewport: canvas.bounds.size, preserveViewport: true)

        XCTAssertEqual(canvas.zoomScale, 2, accuracy: 0.001)
        XCTAssertEqual(canvas.contentOffset.x, panned.x, accuracy: 0.5)
        XCTAssertEqual(canvas.contentOffset.y, panned.y, accuracy: 0.5)
        XCTAssertEqual(
            canvas.contentSize.width,
            PencilCanvasConfiguration.boardExtent * 2,
            accuracy: 1,
            "A preserved-viewport reconfigure must not shrink the reachable board at non-default zoom"
        )
    }

    @MainActor
    func testCanvasCaptureProducesBlackInk() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black)
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let imageData = try XCTUnwrap(capture.snapshotData())
        let pixels = try pixelStats(for: imageData)
        XCTAssertGreaterThan(pixels.darkPixelCount, 40, "A black PKDrawing must survive full-canvas capture")
    }

    @MainActor
    func testCanvasCaptureKeepsSelectedInkAfterPanAndZoom() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black)
        let capture = CanvasCapture()
        capture.canvasView = canvas

        canvas.setZoomScale(2, animated: false)
        canvas.contentOffset = CGPoint(x: 180, y: 220)
        XCTAssertEqual(canvas.bounds.minX, 180, accuracy: 0.001)
        XCTAssertEqual(canvas.bounds.minY, 220, accuracy: 0.001)
        // MEASUREMENT (Fix 1): does UIScrollView re-derive contentSize from the
        // zoom view when zoomScale changes?
        XCTAssertEqual(canvas.contentSize.width, 100_000, accuracy: 1)

        let fullData = try XCTUnwrap(capture.snapshotData())
        let selectedViewport = CGRect(x: 0, y: 240, width: 500, height: 300)
        let selected = try XCTUnwrap(capture.drawingRect(forViewRect: selectedViewport))
        let selectedData = try XCTUnwrap(capture.snapshotData(drawingRegion: selected))
        XCTAssertGreaterThan(try pixelStats(for: fullData).darkPixelCount, 40)
        XCTAssertGreaterThan(try pixelStats(for: selectedData).darkPixelCount, 20, "The selected visible region must retain its ink after pan and zoom")

        XCTAssertEqual(selected.origin.x, 90, accuracy: 0.001)
        XCTAssertEqual(selected.origin.y, 230, accuracy: 0.001)
        XCTAssertEqual(selected.width, 250, accuracy: 0.001)
        XCTAssertEqual(selected.height, 150, accuracy: 0.001)
    }

    /// The regression the whole selection path was rebuilt around.
    ///
    /// A region picked while the board was tall — the learner's own working, low
    /// on the canvas — used to stop existing the moment the keyboard shortened
    /// the board under it: the stored rectangle no longer intersected the
    /// canvas's bounds, the capture came back nil, and the send went out as text
    /// with no picture. Rendering from the drawing's coordinates makes the
    /// viewport irrelevant, which is the point.
    @MainActor
    func testAPickedRegionSurvivesTheBoardShrinkingUnderIt() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black)
        let capture = CanvasCapture()
        capture.canvasView = canvas

        // Picked around the working, low on a board that was fully on screen —
        // `makeDrawing` puts its ink at y 250.
        let picked = try XCTUnwrap(
            capture.drawingRect(forViewRect: CGRect(x: 100, y: 230, width: 200, height: 200))
        )

        // The keyboard opens: the canvas keeps its origin and loses its bottom,
        // leaving the picked region entirely below the visible band. This is
        // where the old viewport intersection came back empty.
        canvas.bounds = CGRect(x: 0, y: 0, width: canvas.bounds.width, height: 60)

        let data = try XCTUnwrap(
            capture.snapshotData(drawingRegion: picked),
            "A region off the bottom of a shortened board is still a region of the learner's work"
        )
        XCTAssertGreaterThan(try pixelStats(for: data).darkPixelCount, 20)
    }

    /// The two conversions are one mapping read in both directions, so a region
    /// that goes out and comes back is the region that went out — which is what
    /// lets the marquee be drawn from a rectangle stored in the other space.
    @MainActor
    func testAViewRectRoundTripsThroughDrawingCoordinates() throws {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas
        canvas.setZoomScale(2, animated: false)
        canvas.contentOffset = CGPoint(x: 180, y: 220)

        let picked = CGRect(x: 40, y: 240, width: 500, height: 300)
        let stored = try XCTUnwrap(capture.drawingRect(forViewRect: picked))
        let drawn = try XCTUnwrap(capture.viewRect(forDrawingRect: stored))

        XCTAssertEqual(drawn.minX, picked.minX, accuracy: 0.001)
        XCTAssertEqual(drawn.minY, picked.minY, accuracy: 0.001)
        XCTAssertEqual(drawn.width, picked.width, accuracy: 0.001)
        XCTAssertEqual(drawn.height, picked.height, accuracy: 0.001)
    }

    /// Scrolling moves the mark, because the region is anchored to the ink now
    /// rather than to the window: the same working stays inside the same
    /// rectangle, and the rectangle is drawn wherever that working currently is.
    @MainActor
    func testAStoredRegionFollowsTheInkWhenTheBoardScrolls() throws {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let picked = CGRect(x: 100, y: 100, width: 200, height: 200)
        let stored = try XCTUnwrap(capture.drawingRect(forViewRect: picked))
        canvas.contentOffset = CGPoint(x: 0, y: 150)
        let drawn = try XCTUnwrap(capture.viewRect(forDrawingRect: stored))

        XCTAssertEqual(drawn.minY, picked.minY - 150, accuracy: 0.001, "The mark scrolls with the work")
        XCTAssertEqual(drawn.minX, picked.minX, accuracy: 0.001)
        XCTAssertEqual(drawn.size, picked.size)
    }

    @MainActor
    func testCanvasCapturePreservesLightInkContrast() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .white)
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let imageData = try XCTUnwrap(capture.snapshotData())
        let pixels = try pixelStats(for: imageData)
        XCTAssertGreaterThan(pixels.nonWhitePixelCount, 40, "Light PencilKit ink must remain visible in the evaluation PNG")
    }

    @MainActor
    func testCanvasCaptureFlattensLightInkOnWhiteBackgroundInDarkTrait() throws {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas

        var imageData: Data?
        UITraitCollection(userInterfaceStyle: .dark).performAsCurrent {
            canvas.drawing = makeDrawing(color: .label)
            imageData = capture.snapshotData()
        }

        let pixels = try pixelStats(for: XCTUnwrap(imageData))
        XCTAssertGreaterThan(
            pixels.darkPixelCount,
            40,
            "Light dynamic PencilKit ink must remain visible on the flattened white background"
        )
    }

    /// Normalizing ink for the flattened white background must not turn the
    /// highlighter into a redaction pen. A `.marker` stroke forced to opaque
    /// black paints over exactly the working the student swiped it across, and
    /// the tutor is then asked to grade a black bar.
    @MainActor
    func testHighlighterBandDoesNotPaintOverTheWorkItMarks() throws {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let working = makeDrawing(color: .black)
        let band = try makeHighlighterStrokes(over: working.bounds)
        let bandDrawing = PKDrawing(strokes: band)
        let highlightedDrawing = PKDrawing(strokes: working.strokes + band)
        XCTAssertEqual(
            highlightedDrawing.bounds,
            bandDrawing.bounds,
            "This fixture is only meaningful if the band buries the working entirely"
        )

        // One bounding box between the two, so both snapshots crop and rasterize
        // identically and their pixel counts are directly comparable.
        canvas.drawing = bandDrawing
        let bandOnly = try XCTUnwrap(capture.snapshotAllInkData())
        canvas.drawing = highlightedDrawing
        let highlighted = try XCTUnwrap(capture.snapshotAllInkData())

        let bandInk = try inkPixelCount(for: bandOnly.data)
        let highlightedInk = try inkPixelCount(for: highlighted.data)

        // A highlighter is translucent by definition, so on blank paper it must
        // leave no pixel as dark as handwriting. This is what fails when the
        // stroke is normalized to opaque black: the whole band goes to ink.
        XCTAssertEqual(bandInk, 0, "A highlighter must not rasterize as a band of solid ink")

        // It still has to be visible as a band, or the emphasis is lost.
        XCTAssertGreaterThan(
            try pixelStats(for: bandOnly.data).nonWhitePixelCount,
            5_000,
            "A highlighter must still read as a band on the flattened white paper"
        )

        // And the working underneath still has to read as handwriting. Only the
        // band-carries-no-ink assertion above makes this one mean anything: it
        // is what rules out these dark pixels being the band itself.
        XCTAssertGreaterThan(
            highlightedInk,
            1_000,
            "The working under a highlighter must survive into the evaluation image"
        )
    }

    /// Every swatch is normalized the same way. A highlighter's hue is dropped
    /// for the evaluation image the way a pen's is, so a pale swatch still reads
    /// as a band on white paper — but none of the five may bring opacity back
    /// and cover the working.
    @MainActor
    func testHighlighterStaysVisibleAndTranslucentInEveryPenColour() throws {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let working = makeDrawing(color: .black)
        for color in PenColor.allCases {
            let band = try makeHighlighterStrokes(over: working.bounds, color: color)
            canvas.drawing = PKDrawing(strokes: band)
            let bandOnly = try XCTUnwrap(capture.snapshotAllInkData())

            XCTAssertEqual(
                try inkPixelCount(for: bandOnly.data),
                0,
                "A \(color.hex) highlighter rasterized as solid ink and would hide the working"
            )
            XCTAssertGreaterThan(
                try pixelStats(for: bandOnly.data).nonWhitePixelCount,
                5_000,
                "A \(color.hex) highlighter must still read as a band"
            )
        }
    }

    @MainActor
    func testBoardEvaluationCapturesInkOutsideTheVisibleViewport() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black, origin: CGPoint(x: 10_000, y: 12_000))
        let capture = CanvasCapture()
        capture.canvasView = canvas

        // The viewport snapshot renders blank paper: the ink is 10,000pt away.
        let visible = try XCTUnwrap(capture.snapshotData())
        XCTAssertEqual(
            try pixelStats(for: visible).darkPixelCount,
            0,
            "The viewport snapshot cannot see ink that is 10,000pt off screen"
        )

        let allInk = try XCTUnwrap(
            capture.snapshotAllInkData(),
            "Board evaluation must capture ink wherever it lives on the board"
        )
        XCTAssertGreaterThan(try pixelStats(for: allInk.data).darkPixelCount, 40)
        XCTAssertTrue(allInk.coversAllInk, "Ink this compact fits in one legible image")
    }

    @MainActor
    func testBoardEvaluationSnapshotIsNilOnAnEmptyBoard() {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas

        XCTAssertNil(capture.snapshotAllInkData(), "An empty board must not send an evaluation image")
    }

    @MainActor
    func testBoardEvaluationCoversAllInkForOrdinaryWorkNearTheOrigin() throws {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black, origin: PencilCanvasConfiguration.boardOrigin)
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let snapshot = try XCTUnwrap(capture.snapshotAllInkData())
        XCTAssertTrue(snapshot.coversAllInk, "A page of ordinary work is evaluated whole")
        XCTAssertGreaterThan(
            try pixelStats(for: snapshot.data).darkPixelCount,
            40,
            "The evaluated image must still contain the student's ink"
        )
    }

    @MainActor
    func testBoardEvaluationBoundsAnEnormousSpanAndReportsPartialCoverage() throws {
        let canvas = configuredCanvas()
        canvas.drawing = PKDrawing(strokes:
            makeDrawing(color: .black, origin: CGPoint(x: 5_000, y: 25_000)).strokes
                + makeDrawing(color: .black, origin: CGPoint(x: 45_000, y: 25_000)).strokes
        )
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let snapshot = try XCTUnwrap(capture.snapshotAllInkData())
        XCTAssertFalse(
            snapshot.coversAllInk,
            "Ink spanning 40,000pt cannot be rendered legibly in one image, so evaluation must not claim it was"
        )

        let image = try XCTUnwrap(UIImage(data: snapshot.data))
        // 4,000pt of board at the renderer's 2,000px cap is a 0.5 scale, which
        // keeps 50pt handwriting ~25px tall instead of a few pixels.
        XCTAssertEqual(image.size.width, PencilCanvasConfiguration.maximumEvaluationSpan / 2, accuracy: 1)
        XCTAssertEqual(image.size.height, PencilCanvasConfiguration.maximumEvaluationSpan / 2, accuracy: 1)

        // These two clusters sit 40,000pt apart, so their centroid lands in the
        // empty gap between them. Bounding the region is not enough on its own:
        // without a fallback the crop contains no strokes at all and the tutor
        // grades blank paper while being told it is the student's working area.
        XCTAssertGreaterThan(
            try pixelStats(for: snapshot.data).darkPixelCount,
            40,
            "A bounded evaluation region must still contain ink, never blank paper"
        )
    }

    @MainActor
    func testBoardEvaluationKeepsTheWorkWhenOneStrayMarkIsFarAway() throws {
        let center = PencilCanvasConfiguration.boardOrigin
        let clusterStrokes = makeClusterStrokes(center: center, span: 3_800, strokeCount: 100)
        let clusterBounds = PKDrawing(strokes: clusterStrokes).bounds

        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas

        canvas.drawing = PKDrawing(strokes: clusterStrokes)
        let clusterOnly = try XCTUnwrap(capture.snapshotAllInkData())
        XCTAssertTrue(clusterOnly.coversAllInk)
        let clusterDarkPixels = try pixelStats(for: clusterOnly.data).darkPixelCount
        XCTAssertGreaterThan(clusterDarkPixels, 1_000)

        let strayMark = makeDrawing(color: .black, origin: CGPoint(x: center.x + 30_000, y: center.y))
        canvas.drawing = PKDrawing(strokes: clusterStrokes + strayMark.strokes)
        let withStrayMark = try XCTUnwrap(capture.snapshotAllInkData())
        XCTAssertFalse(withStrayMark.coversAllInk)

        // Centering the crop on the average stroke center keeps it on the work:
        // one stray mark moves a hundred-stroke average by a fraction of the
        // crop, so nearly all of the cluster survives at the same render scale.
        let darkPixels = try pixelStats(for: withStrayMark.data).darkPixelCount
        XCTAssertGreaterThan(Double(darkPixels), Double(clusterDarkPixels) * 0.75)
        XCTAssertLessThan(Double(darkPixels), Double(clusterDarkPixels) * 1.15)

        // The bounding box's center, by contrast, is dragged halfway to the
        // stray mark and lands on blank board — missing the work entirely.
        let span = PencilCanvasConfiguration.maximumEvaluationSpan
        let boundsCentered = CGRect(
            x: canvas.drawing.bounds.midX - span / 2,
            y: canvas.drawing.bounds.midY - span / 2,
            width: span,
            height: span
        )
        XCTAssertFalse(
            boundsCentered.intersects(clusterBounds),
            "This fixture is only meaningful if a bounding-box-centered crop would have missed the work"
        )
    }

    @MainActor
    func testCenterOnContentBringsDistantInkIntoTheViewport() {
        let canvas = configuredCanvas()
        canvas.drawing = makeDrawing(color: .black, origin: CGPoint(x: 30_000, y: 41_000))
        let capture = CanvasCapture()
        capture.canvasView = canvas

        let viewportRect = CGRect(origin: .zero, size: canvas.bounds.size)
        let before = CanvasViewportMapper.drawingRect(
            for: viewportRect,
            canvasBounds: canvas.bounds,
            zoomScale: canvas.zoomScale
        )
        XCTAssertFalse(before.intersects(canvas.drawing.bounds), "Ink 30,000pt away must start off screen")

        capture.centerOnContent(animated: false)

        let after = CanvasViewportMapper.drawingRect(
            for: viewportRect,
            canvasBounds: canvas.bounds,
            zoomScale: canvas.zoomScale
        )
        XCTAssertTrue(
            after.contains(CGPoint(x: canvas.drawing.bounds.midX, y: canvas.drawing.bounds.midY)),
            "Centering must scroll the board to wherever the student's ink lives"
        )
    }

    @MainActor
    func testCenterOnContentReturnsToTheBoardOriginWhenEmpty() {
        let canvas = configuredCanvas()
        let capture = CanvasCapture()
        capture.canvasView = canvas
        canvas.contentOffset = CGPoint(x: 40_000, y: 40_000)

        capture.centerOnContent(animated: false)

        XCTAssertEqual(
            canvas.contentOffset.x,
            PencilCanvasConfiguration.boardOrigin.x - canvas.bounds.width / 2,
            accuracy: 0.5
        )
        XCTAssertEqual(
            canvas.contentOffset.y,
            PencilCanvasConfiguration.boardOrigin.y - canvas.bounds.height / 2,
            accuracy: 0.5
        )
    }

    /// `hasInk` is published state now rather than a computed read-through, so it
    /// tracks the board by being told — `refreshHasInk()` stands in for the drawing
    /// delegate that calls it in the app. The point of the change is that a control
    /// gated on it can redraw; see `CanvasCaptureInkStateTests`.
    @MainActor
    func testCanvasCaptureReportsWhetherTheBoardHasEvaluableInk() {
        let capture = CanvasCapture()
        capture.refreshHasInk()
        XCTAssertFalse(capture.hasInk, "With no canvas attached there is nothing to evaluate")

        let canvas = configuredCanvas()
        capture.canvasView = canvas
        capture.refreshHasInk()
        XCTAssertFalse(capture.hasInk, "An empty board has no ink to evaluate")
        XCTAssertNil(capture.snapshotAllInkData())

        canvas.drawing = makeDrawing(color: .black)
        capture.refreshHasInk()
        XCTAssertTrue(capture.hasInk)
        XCTAssertNotNil(capture.snapshotAllInkData())

        canvas.drawing = PKDrawing()
        capture.refreshHasInk()
        XCTAssertFalse(capture.hasInk, "Clearing the board must make the evaluate control unavailable again")
        XCTAssertNil(capture.snapshotAllInkData())
    }

    @MainActor
    func testViewportChangeCentersOnInkOnceAndThenPreservesTheStudentsPan() {
        let capture = CanvasCapture()
        let parent = PencilCanvasView(
            capture: capture,
            initialDrawingData: nil,
            onDrawingChange: { _ in },
            onUndo: { },
            onRedo: { }
        )
        let coordinator = PencilCanvasView.Coordinator(parent)
        let canvas = BoardCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        canvas.drawing = makeDrawing(color: .black, origin: CGPoint(x: 30_000, y: 41_000))
        capture.canvasView = canvas
        coordinator.canvas = canvas

        coordinator.handleViewportChange(canvas: canvas, size: canvas.bounds.size)

        let visible = CanvasViewportMapper.drawingRect(
            for: CGRect(origin: .zero, size: canvas.bounds.size),
            canvasBounds: canvas.bounds,
            zoomScale: canvas.zoomScale
        )
        XCTAssertTrue(
            visible.contains(CGPoint(x: canvas.drawing.bounds.midX, y: canvas.drawing.bounds.midY)),
            "The first viewport report must open the board on the session's existing ink"
        )

        // The student pans away to blank board; a later report (rotation, split
        // view) must leave them there rather than yanking them back to the ink.
        let panned = CGPoint(x: 1_200, y: 2_400)
        canvas.contentOffset = panned
        coordinator.handleViewportChange(canvas: canvas, size: canvas.bounds.size)

        XCTAssertEqual(canvas.contentOffset.x, panned.x, accuracy: 0.5)
        XCTAssertEqual(canvas.contentOffset.y, panned.y, accuracy: 0.5)
    }

    @MainActor
    func testBoardCanvasViewDoesNotReportAnEmptyLayout() {
        let canvas = BoardCanvasView(frame: .zero)
        var receivedSizes: [CGSize] = []
        canvas.onViewportChange = { receivedSizes.append($0) }

        canvas.setNeedsLayout()
        canvas.layoutIfNeeded()

        XCTAssertTrue(receivedSizes.isEmpty, "A zero-size layout must never report a viewport")
    }

    @MainActor
    func testBoardCanvasViewReportsTheFirstNonEmptySize() {
        let canvas = BoardCanvasView(frame: .zero)
        var receivedSizes: [CGSize] = []
        canvas.onViewportChange = { receivedSizes.append($0) }

        canvas.frame = CGRect(x: 0, y: 0, width: 1_024, height: 768)
        canvas.setNeedsLayout()
        canvas.layoutIfNeeded()

        XCTAssertEqual(receivedSizes, [CGSize(width: 1_024, height: 768)])
    }

    @MainActor
    func testBoardCanvasViewDoesNotReReportAnUnchangedSize() {
        let canvas = BoardCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        var receivedSizes: [CGSize] = []
        canvas.onViewportChange = { receivedSizes.append($0) }

        canvas.setNeedsLayout()
        canvas.layoutIfNeeded()
        canvas.setNeedsLayout()
        canvas.layoutIfNeeded()

        XCTAssertEqual(receivedSizes.count, 1, "An unchanged size must not be reported a second time")
    }

    @MainActor
    func testBoardCanvasViewReportsAGenuineSizeChange() {
        let canvas = BoardCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        var receivedSizes: [CGSize] = []
        canvas.onViewportChange = { receivedSizes.append($0) }

        canvas.setNeedsLayout()
        canvas.layoutIfNeeded()
        canvas.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        canvas.setNeedsLayout()
        canvas.layoutIfNeeded()

        XCTAssertEqual(receivedSizes, [CGSize(width: 1_024, height: 768), CGSize(width: 800, height: 600)])
    }

    @MainActor
    func testEvaluationPersistsLearnerAndTutorTurnsAndDismissKeepsHistory() async throws {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()
        let initialMessageCount = store.session.messages.count

        store.evaluate(imageData: Data([1, 2, 3]), regionDescription: "the selected rectangle")
        for _ in 0..<50 where store.isEvaluating {
            try await Task.sleep(for: .milliseconds(20))
        }

        XCTAssertFalse(store.isEvaluating)
        let newMessages = Array(store.session.messages.dropFirst(initialMessageCount))
        let evaluationTurn = try XCTUnwrap(newMessages.first(where: { $0.signal == .evaluate }))
        XCTAssertEqual(evaluationTurn.role, .learner)
        XCTAssertTrue(
            evaluationTurn.text.isEmpty,
            "Nothing was typed, so the turn carries no words — see the region description instead"
        )

        let tutorReply = try XCTUnwrap(newMessages.first(where: { $0.role == .tutor }))
        XCTAssertFalse(tutorReply.text.isEmpty)
        XCTAssertEqual(store.evaluationText, tutorReply.text)

        store.clearEvaluation()
        XCTAssertNil(store.evaluationText)
        XCTAssertTrue(store.session.messages.contains(tutorReply), "Dismissing the highlighted feedback must not remove conversation history")
    }

    /// A student who types "check my work" and sends it with a region attached
    /// must have that exact text in the thread — with no generated area-description
    /// paragraph underneath it.
    ///
    /// `BoardScreen.send` used to leave the typed text sitting in the composer
    /// and send a canned "Please evaluate my work on …" in its place, so the one
    /// message the tutor received was never the one the student wrote. It then
    /// appended "(About …)" below the student's own question; that paragraph should not exist.
    @MainActor
    func testAnEvaluationCarriesTheStudentsOwnQuestionWhenTheyTypedOne() async throws {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()
        let initialMessageCount = store.session.messages.count

        store.evaluate(
            imageData: Data([1, 2, 3]),
            regionDescription: "the area you selected",
            question: "did I factor this right?"
        )
        for _ in 0..<50 where store.isEvaluating {
            try await Task.sleep(for: .milliseconds(20))
        }

        let newMessages = Array(store.session.messages.dropFirst(initialMessageCount))
        let evaluationTurn = try XCTUnwrap(newMessages.first(where: { $0.signal == .evaluate }))
        XCTAssertEqual(
            evaluationTurn.text,
            "did I factor this right?",
            "The student's own question must arrive exactly as written"
        )
        XCTAssertFalse(
            evaluationTurn.text.contains("area you selected"),
            "The learner's message must not carry generated area-description text"
        )
        XCTAssertFalse(
            evaluationTurn.text.contains("(About"),
            "The learner's message must not carry an auto-appended region note"
        )
    }

    /// With nothing typed, the turn is the picture and nothing else.
    ///
    /// It used to be a canned "Please evaluate my work on the whole board." — the
    /// device writing a sentence in the learner's voice that the learner had not
    /// said, and then showing it back to them in their own bubble. Pointing at a
    /// piece of working is already a complete request, and `regionDescription`
    /// says what is being pointed at where a policy line belongs: in the third
    /// person, in the prompt, not in the thread.
    @MainActor
    func testAnEvaluationWithNoTypedQuestionCarriesNoWords() async throws {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()
        let initialMessageCount = store.session.messages.count

        store.evaluate(imageData: Data([1, 2, 3]), regionDescription: "the whole board", question: nil)
        for _ in 0..<50 where store.isEvaluating {
            try await Task.sleep(for: .milliseconds(20))
        }

        let newMessages = Array(store.session.messages.dropFirst(initialMessageCount))
        let evaluationTurn = try XCTUnwrap(newMessages.first(where: { $0.signal == .evaluate }))
        XCTAssertEqual(evaluationTurn.text, "")
        XCTAssertNotNil(
            store.selectionViews[evaluationTurn.id],
            "The picture is the whole turn, so it has to be there for the thread to draw"
        )
    }

    /// Whitespace is not a question. A composer holding only a space must produce
    /// the same wordless turn a empty one does, rather than a bubble with a space in it.
    @MainActor
    func testAnEvaluationTreatsBlankTypingAsNoQuestion() async throws {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()
        let initialMessageCount = store.session.messages.count

        store.evaluate(imageData: Data([1, 2, 3]), regionDescription: "the whole board", question: "   ")
        for _ in 0..<50 where store.isEvaluating {
            try await Task.sleep(for: .milliseconds(20))
        }

        let newMessages = Array(store.session.messages.dropFirst(initialMessageCount))
        let evaluationTurn = try XCTUnwrap(newMessages.first(where: { $0.signal == .evaluate }))
        XCTAssertEqual(evaluationTurn.text, "")
    }

    /// A session that opens with a picture has no words to take a goal from, and
    /// must not report the empty string as one.
    @MainActor
    func testAWordlessFirstTurnDoesNotBecomeTheGoal() async throws {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()

        store.evaluate(imageData: Data([1, 2, 3]), regionDescription: "the whole board", question: nil)
        for _ in 0..<50 where store.isEvaluating {
            try await Task.sleep(for: .milliseconds(20))
        }
        store.send("is this right?")
        for _ in 0..<50 where store.isLoading {
            try await Task.sleep(for: .milliseconds(20))
        }

        let goal = store.session.messages.first { $0.role == .learner && !$0.text.isEmpty }?.text
        XCTAssertEqual(goal, "is this right?")
    }

    /// A send that could not read the board says so above the composer, and says
    /// it there rather than in the thread: nothing was sent, so there is no turn
    /// for a thread failure to be about.
    @MainActor
    func testABoardCaptureFailureIsSaidAboveTheComposer() {
        let store = TutorStore(service: DemoTutorService())

        XCTAssertNil(store.composerNote)
        store.reportBoardCaptureFailure()
        XCTAssertEqual(store.composerNote, TutorStore.boardCaptureFailed)
        XCTAssertNil(store.errorMessage, "Nothing was sent, so no turn failed")

        store.clearComposerNote()
        XCTAssertNil(store.composerNote)
    }

    func testNewSessionsDefaultToLuna() {
        XCTAssertEqual(LearningSession.empty.selectedModel, .luna)
        XCTAssertEqual(LearningSession.empty.reasoningEffort, .high)
        // The mini since 2026-08-16, reversing the decision voice mode shipped
        // on: voice audio is the product's largest cost line and the mini is a
        // third of it.
        XCTAssertEqual(LearningSession.empty.selectedVoiceModel, .mini)
    }

    func testReasoningEffortRoundTripsAndUnknownValuesUseHighDefault() throws {
        for effort in ReasoningEffort.allCases {
            let data = try JSONEncoder().encode(effort)
            XCTAssertEqual(try JSONDecoder().decode(ReasoningEffort.self, from: data), effort)
        }

        let unknown = Data(#""future_effort""#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(ReasoningEffort.self, from: unknown), .high)
    }

    func testLearningSessionBackwardDecodeDefaultsMissingReasoningEffort() throws {
        var sessionObject = try jsonObject(for: LearningSession.empty)
        sessionObject.removeValue(forKey: "reasoningEffort")
        let legacyData = try JSONSerialization.data(withJSONObject: sessionObject)
        let decodedLegacy = try JSONDecoder().decode(LearningSession.self, from: legacyData)
        XCTAssertEqual(decodedLegacy.reasoningEffort, .high)

        sessionObject["reasoningEffort"] = "future_effort"
        let unknownData = try JSONSerialization.data(withJSONObject: sessionObject)
        let decodedUnknown = try JSONDecoder().decode(LearningSession.self, from: unknownData)
        XCTAssertEqual(decodedUnknown.reasoningEffort, .high)
    }

    /// A `session.json` written before `id` existed must still decode — and
    /// must get a fresh id, not fail to decode or default to some fixed
    /// nil-like sentinel, since that id is what ties this session's turns
    /// together on the backend going forward.
    func testLearningSessionBackwardDecodeDefaultsMissingIDToAFreshOne() throws {
        var sessionObject = try jsonObject(for: LearningSession.empty)
        sessionObject.removeValue(forKey: "id")
        let legacyData = try JSONSerialization.data(withJSONObject: sessionObject)
        let decoded = try JSONDecoder().decode(LearningSession.self, from: legacyData)
        XCTAssertNotNil(decoded.id)

        let decodedAgain = try JSONDecoder().decode(LearningSession.self, from: legacyData)
        XCTAssertNotEqual(decoded.id, decodedAgain.id, "Each decode of an id-less session must mint its own fresh id")
    }

    @MainActor
    func testStoreReasoningEffortSetterPersistsInSession() {
        let store = TutorStore(service: DemoTutorService())
        store.setReasoningEffort(.xhigh)
        XCTAssertEqual(store.session.reasoningEffort, .xhigh)
        store.resetSession()
        XCTAssertEqual(store.session.reasoningEffort, .high)
    }

    func testTutorPromptPolicyContainsEveryExperimentalDraftSection() {
        let policy = TutorPromptPolicy.system
        for heading in [
            "# ABOUT",
            "## UNDERSTAND THE USER",
            "## LEARNER-LED MODE",
            "## GOAL",
            "## KINDS OF OBJECTIVES",
            "## BOARD",
            "## RESEARCH",
            "## MEMORY",
            "## TOOLS",
        ] {
            XCTAssertTrue(policy.contains(heading), "Missing draft section: \(heading)")
        }
    }

    func testTutorPromptPolicyContainsEveryAvailableTool() {
        let policy = TutorPromptPolicy.system.lowercased()
        for tool in [
            "set_workspace",
            "view_board",
            "update_board",
            "remember",
            "forget",
            "search_memory",
            "search_sessions",
            "search_history",
            "get_session",
            "list_sessions",
            "record_evidence",
        ] {
            XCTAssertTrue(policy.contains(tool), "Missing draft tool: \(tool)")
        }
        XCTAssertFalse(policy.contains("recent_sessions"), "`recent_sessions` was replaced by `list_sessions`")
    }

    func testTutorPromptPolicyEnforcesTheLearnerLedInvariant() {
        let policy = TutorPromptPolicy.system
        XCTAssertTrue(policy.contains("## LEARNER-LED MODE"))
        XCTAssertTrue(policy.contains(
            "When the learner is solving or deriving something themselves, do not advance beyond their current step. Give at most one question, check, or requested hint per reply. Do not reveal the next step, derivation, or final answer unless they explicitly ask to leave learner-led mode."
        ))
    }

    func testTutorPromptPolicyOrdersLearnerLedAfterObjectivesBeforeBoard() throws {
        let policy = TutorPromptPolicy.system
        let objectives = try XCTUnwrap(policy.range(of: "## KINDS OF OBJECTIVES"))
        let learnerLed = try XCTUnwrap(policy.range(of: "## LEARNER-LED MODE"))
        let board = try XCTUnwrap(policy.range(of: "## BOARD"))
        XCTAssertLessThan(objectives.lowerBound, learnerLed.lowerBound)
        XCTAssertLessThan(learnerLed.lowerBound, board.lowerBound)

        let objectivesTail = try XCTUnwrap(
            policy.range(of: "There might be other scenarios, try do identify them and figure out my intent.")
        )
        XCTAssertLessThan(objectivesTail.lowerBound, learnerLed.lowerBound)
    }

    func testTutorPromptPolicyKeepsTheThreeDraftMergeAdditions() {
        let policy = TutorPromptPolicy.system
        XCTAssertTrue(policy.contains(
            "And provide materials for me to read and learn from in a way that it's easy to read/see/understand from my level of knowledge and personal preferences"
        ))
        XCTAssertTrue(policy.contains(
            "And use board to visualize concepts, structure the material."
        ))
        XCTAssertTrue(policy.contains(
            "Mb even I would incentivize you to use board more often to draw/visualize, make an experience memorable by incorporating sense of art and design."
        ))
    }

    func testTutorPromptPolicyRequestsTypesetMathDelimiters() {
        let policy = TutorPromptPolicy.system
        XCTAssertTrue(policy.contains("Write replies as polished Markdown"))
        XCTAssertTrue(policy.contains("\\( ... \\)"))
        XCTAssertTrue(policy.contains("\\[ ... \\]"))
        XCTAssertTrue(policy.contains("instead of showing raw source"))
    }

    func testDemoFlowStaysGenericAndTreatsDontKnowAsSignal() async throws {
        let service = DemoTutorService()
        let initial = TutorRequest(messages: [TutorMessage(role: .learner, text: "I want to learn algebra")], goal: "I want to learn algebra", exercise: nil, plan: nil, imageData: nil, imageRegionDescription: nil, signal: nil, model: .sol)
        let planned = try await service.respond(to: initial)
        XCTAssertNil(planned.plan)
        XCTAssertNil(planned.exercise)
        XCTAssertTrue(planned.text.lowercased().contains("exact problem"))
        XCTAssertFalse(planned.text.lowercased().contains("radical"))

        let dontKnow = TutorRequest(messages: initial.messages, goal: initial.goal, exercise: sampleExercise, plan: samplePlan, imageData: nil, imageRegionDescription: nil, signal: .dontKnow, model: .sol)
        let reply = try await service.respond(to: dontKnow)
        XCTAssertTrue(reply.text.lowercased().contains("useful signal"))
        XCTAssertEqual(reply.plan, samplePlan)
        XCTAssertEqual(reply.exercise, sampleExercise)
    }

    func testDemoAnswersDirectMathQuestionWithoutInventingWorkspace() async throws {
        let request = TutorRequest(
            messages: [TutorMessage(role: .learner, text: "What is 2 + 2?")],
            goal: "What is 2 + 2?",
            exercise: nil,
            plan: nil,
            imageData: nil,
            imageRegionDescription: nil,
            signal: nil,
            model: .luna
        )
        let reply = try await DemoTutorService().respond(to: request)
        XCTAssertNil(reply.plan)
        XCTAssertNil(reply.exercise)
        XCTAssertFalse(reply.text.lowercased().contains("radical"))
    }

    func testSessionRoundTripsDrawingAndMessages() throws {
        var session = LearningSession.empty
        session.plan = samplePlan
        session.exercise = sampleExercise
        session.messages = [TutorMessage(role: .tutor, text: "hello")]
        session.drawingData = Data([0, 1, 2, 3])
        let data = try JSONEncoder().encode(session)
        let decoded = try JSONDecoder().decode(LearningSession.self, from: data)
        XCTAssertEqual(decoded, session)
    }

    func testReasoningDeltasGrowASingleItem() {
        var trail = ActivityTrail()
        trail.appendReasoning("Checking ")
        trail.appendReasoning("the domain")
        XCTAssertEqual(trail.items.count, 1)
        guard case let .reasoning(_, text) = trail.items[0] else {
            return XCTFail("expected a reasoning item")
        }
        XCTAssertEqual(text, "Checking the domain")
    }

    func testReasoningAfterAStepStartsANewItem() {
        var trail = ActivityTrail()
        trail.appendReasoning("First")
        trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looking"))
        trail.appendReasoning("Second")
        XCTAssertEqual(trail.items.count, 3)
    }

    func testAStepWithAKnownIDIsReplacedInPlace() {
        var trail = ActivityTrail()
        trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looking at the board"))
        trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looked at the top left of the board"))
        XCTAssertEqual(trail.items.count, 1)
        guard case let .step(step) = trail.items[0] else {
            return XCTFail("expected a step item")
        }
        XCTAssertEqual(step.label, "Looked at the top left of the board")
    }

    func testReplacingAStepKeepsItsImage() {
        var trail = ActivityTrail()
        var first = TrailStep(id: "call_a", tool: "view_board", label: "Looking at the board")
        first.imageID = UUID()
        trail.upsert(first)
        trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looked at the top left of the board"))
        guard case let .step(step) = trail.items[0] else {
            return XCTFail("expected a step item")
        }
        XCTAssertEqual(step.imageID, first.imageID)
    }

    func testATutorMessageWrittenBeforeTrailsExistedStillDecodes() throws {
        let json = Data("""
        {"id":"\(UUID().uuidString)","role":"tutor","text":"Hello","createdAt":0}
        """.utf8)
        let message = try JSONDecoder().decode(TutorMessage.self, from: json)
        XCTAssertNil(message.activity)
        XCTAssertEqual(message.text, "Hello")
    }

    func testATrailSurvivesEncodingAndDecoding() throws {
        var trail = ActivityTrail()
        trail.appendReasoning("Checking the domain")
        trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looked at the top left of the board"))
        trail.duration = 75
        var message = TutorMessage(role: .tutor, text: "Try squaring both sides.")
        message.activity = trail

        let data = try JSONEncoder().encode(message)
        let decoded = try JSONDecoder().decode(TutorMessage.self, from: data)
        XCTAssertEqual(decoded.activity, trail)
    }

    #if DEBUG
    func testE2EFixtureContainsVectorInkWithUsefulBounds() throws {
        let drawing = E2ESeedFixture.drawing()
        XCTAssertGreaterThanOrEqual(drawing.strokes.count, 50)
        XCTAssertGreaterThan(drawing.dataRepresentation().count, 1_000)
        XCTAssertGreaterThan(drawing.bounds.width, 400)
        XCTAssertGreaterThan(drawing.bounds.height, 300)

        var session = LearningSession.empty
        E2ESeedFixture.seedSession(&session)
        XCTAssertEqual(session.plan, .radicalEquation)
        XCTAssertEqual(session.exercise, .radicalEquation)
        let seededData = try XCTUnwrap(session.drawingData)
        let seededDrawing = try? PKDrawing(data: seededData)
        XCTAssertEqual(seededDrawing?.strokes.count, drawing.strokes.count)
        XCTAssertGreaterThan(seededDrawing?.bounds.width ?? 0, 400)
        XCTAssertNotNil(seededDrawing)
    }
    #endif

    @MainActor
    func testStartWorkingDoesNotInventMissingWorkspaceContent() {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()
        store.startWorking()
        XCTAssertFalse(store.isWorkspace)
        XCTAssertNil(store.session.plan)
        XCTAssertNil(store.session.exercise)
        XCTAssertTrue(store.errorMessage?.contains("has not prepared") == true)
    }

    /// A build with no usable token cannot reach its backend. There is no setup screen to
    /// send anyone to — the app has no credential surface — so the send is simply refused and
    /// the turn fails, leaving the learner's message unsent rather than half-recorded.
    @MainActor
    func testStoreGuardsRequestsWhenTheBackendCannotBeReached() {
        // `configuration: nil` is a build compiled with no device token — the
        // state a clean checkout is in, and the one a Release build used to be
        // stuck in permanently before the token became a build setting.
        let store = TutorStore(
            service: TutorServiceRouter(), persistence: .inMemory, configuration: nil
        )
        store.resetSession()
        XCTAssertFalse(store.usesLiveTutor)

        store.send("Explain fractions")

        XCTAssertEqual(store.session.messages.count, 1)
        XCTAssertEqual(store.errorMessage, TutorServiceError.notConfigured.errorDescription)
    }

    // The three `TutorPanelLayout` geometry tests that stood here were deleted with the
    // floating, draggable, resizable tutor panel they covered. The design replaces it with a
    // fixed 337pt panel whose position is a constant, so there is no geometry left to assert.

    private static let samplePlan = SessionPlan(
        title: "Algebra confidence",
        goal: "Understand one equation",
        outcomes: ["Choose a reversible operation"],
        steps: ["Name the operation", "Check the result"],
        currentStep: 0
    )

    private static let sampleExercise = Exercise(
        title: "Try this",
        prompt: "Solve x + 3 = 7",
        hint: "Undo the addition",
        context: "A short algebra check"
    )

    private var samplePlan: SessionPlan { Self.samplePlan }
    private var sampleExercise: Exercise { Self.sampleExercise }

    @MainActor
    private func configuredCanvas() -> PKCanvasView {
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        PencilCanvasConfiguration.configure(canvas, viewport: canvas.bounds.size)
        // These tests assert on rasterization, not on where a session starts, so
        // they view the board's top-left corner and place ink there. Tests that
        // care about the centered start position set their own offset.
        canvas.contentOffset = .zero
        return canvas
    }

    private func makeDrawing(color: UIColor, origin: CGPoint = CGPoint(x: 120, y: 250)) -> PKDrawing {
        let ink = PKInk(.pen, color: color)
        let points = [
            CGPoint(x: origin.x, y: origin.y),
            CGPoint(x: origin.x + 40, y: origin.y),
            CGPoint(x: origin.x + 40, y: origin.y + 50),
            CGPoint(x: origin.x, y: origin.y + 50),
            CGPoint(x: origin.x, y: origin.y)
        ]
        let controlPoints = points.enumerated().map { index, point in
            PKStrokePoint(
                location: point,
                timeOffset: Double(index) * 0.02,
                size: CGSize(width: 8, height: 8),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        let path = PKStrokePath(controlPoints: controlPoints, creationDate: Date(timeIntervalSinceReferenceDate: 0))
        let stroke = PKStroke(ink: ink, path: path, transform: .identity, mask: nil, randomSeed: 13)
        return PKDrawing(strokes: [stroke])
    }

    /// A highlighter band swiped across `target`, inked exactly as the rail's
    /// one-tap highlighter inks it.
    ///
    /// Enough overlapping passes to bury `target` completely, which is the worst
    /// case for an evaluation image: if the band rasterizes opaque, there is
    /// nothing of the working left for the tutor to read.
    private func makeHighlighterStrokes(
        over target: CGRect,
        color: PenColor = .black,
        thickness: StrokeThickness = .bold
    ) throws -> [PKStroke] {
        let tool = try XCTUnwrap(
            BoardInk.tool(for: .highlighter, color: color, thickness: thickness) as? PKInkingTool
        )
        let width = tool.width
        let passes = Int((target.height / (width / 2)).rounded(.up)) + 1
        return (0..<passes).map { pass in
            let y = target.minY + CGFloat(pass) * width / 2
            let controlPoints = [target.minX - width, target.midX, target.maxX + width]
                .enumerated()
                .map { index, x in
                    PKStrokePoint(
                        location: CGPoint(x: x, y: y),
                        timeOffset: Double(index) * 0.02,
                        size: CGSize(width: width, height: width),
                        opacity: 1,
                        force: 1,
                        azimuth: 0,
                        altitude: .pi / 2
                    )
                }
            return PKStroke(
                ink: tool.ink,
                path: PKStrokePath(
                    controlPoints: controlPoints,
                    creationDate: Date(timeIntervalSinceReferenceDate: 0)
                ),
                transform: .identity,
                mask: nil,
                randomSeed: UInt32(101 + pass)
            )
        }
    }

    /// A grid of small marks filling a `span`-square around `center`, as
    /// `strokeCount` separate strokes — a stand-in for a page of real work.
    private func makeClusterStrokes(center: CGPoint, span: CGFloat, strokeCount: Int) -> [PKStroke] {
        let columns: Int = max(1, Int(Double(strokeCount).squareRoot().rounded(.up)))
        let step: CGFloat = span / CGFloat(max(1, columns - 1))
        let left: CGFloat = center.x - span / 2
        let top: CGFloat = center.y - span / 2
        var strokes: [PKStroke] = []
        for index in 0..<strokeCount {
            let column: CGFloat = CGFloat(index % columns)
            let row: CGFloat = CGFloat(index / columns)
            let origin = CGPoint(x: left + column * step, y: top + row * step)
            strokes.append(contentsOf: makeDrawing(color: .black, origin: origin).strokes)
        }
        return strokes
    }

    private struct PixelStats {
        var darkPixelCount: Int
        var nonWhitePixelCount: Int
    }

    private func pixelStats(for data: Data) throws -> PixelStats {
        let values = try luminances(for: data)
        return PixelStats(
            darkPixelCount: values.filter { $0 < 220 }.count,
            nonWhitePixelCount: values.filter { $0 < 250 }.count
        )
    }

    /// Pixels dark enough to be handwriting rather than paper or a highlighter
    /// band, on the same 0–255 average-channel scale `pixelStats(for:)` uses.
    private func inkPixelCount(for data: Data) throws -> Int {
        try luminances(for: data).filter { $0 < 60 }.count
    }

    private func luminances(for data: Data) throws -> [Int] {
        let image = try XCTUnwrap(UIImage(data: data)?.cgImage)
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        let context = try XCTUnwrap(CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        return stride(from: 0, to: pixels.count, by: 4).map { index in
            let red = Int(pixels[index])
            let green = Int(pixels[index + 1])
            let blue = Int(pixels[index + 2])
            return (red + green + blue) / 3
        }
    }

    private func jsonObject<T: Encodable>(for value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
