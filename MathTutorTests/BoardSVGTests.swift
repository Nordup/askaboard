import CoreGraphics
import PencilKit
import UIKit
import XCTest
@testable import MathTutor

/// What an `svg` element means on the board.
///
/// `BoardSVGStoreTests` records what the store does with one document —
/// sizes, budgets, failures, readiness. This file records the layer above it:
/// where the figure lands, how big it is drawn, what the wire says, and what a
/// scene made before the frameless contract still looks like.
///
/// Four claims here are the ones that would go wrong quietly:
///
/// 1. **No frame means 1:1.** The document's `viewBox` is drawn one user unit
///    to one board point with its top-left corner at `(x, y)`. Sized anywhere
///    else, a figure the model measured against its neighbours would land
///    beside them at the wrong scale.
/// 2. **A frame still fits, and never stretches.** Every scene persisted
///    before this contract carries one, and the WebKit renderer letterboxed
///    the document inside it. A restored board has to look the way the learner
///    left it.
/// 3. **0 and `nil` are the same thing, in both directions.** The server's
///    schema is strict, so "no frame" is written as 0 on the wire; the element
///    says it as `nil`. A round trip through either spelling has to come back
///    unchanged, or a scene loses its frame — or grows one — on relaunch.
/// 4. **A figure with no bitmap yet has no bounds.** Reporting a rectangle for
///    a frameless element before the document is parsed would mount a layer
///    around a size nobody knows, and stretch the scene union to reach it.
@MainActor
final class BoardSVGTests: XCTestCase {

    // MARK: - The documents

    private static let namespace = #"xmlns="http://www.w3.org/2000/svg""#

    /// 100 x 80, filled corner to corner in one flat red, so that a pixel says
    /// both "the figure is here" and "the figure reaches this far".
    private static func filledDocument() -> String {
        """
        <svg \(Self.namespace) viewBox="0 0 100 80">\
        <rect width="100" height="80" fill="#E33E38"/></svg>
        """
    }

    /// The same 100 x 80 document, made unique so that no other test in this
    /// process can have left its bitmap in the shared store.
    private static func uniqueDocument() -> String {
        """
        <svg \(Self.namespace) viewBox="0 0 100 80">\
        <desc>\(UUID().uuidString)</desc>\
        <rect width="100" height="80" fill="#E33E38"/></svg>
        """
    }

    // MARK: - The wire

    func testSVGWireAndPersistenceRoundtripIsExact() throws {
        let raw = complexSVG()
        let element = SVGElement(
            id: "diagram",
            x: 10,
            y: 20,
            width: 260,
            height: 160,
            svg: raw,
            style: BoardStyle(
                role: .emphasis,
                stroke: "#0A0A0A",
                fill: "transparent",
                strokeWidth: 1,
                opacity: 0.8,
                dash: [],
                rotation: 30
            )
        )
        let scene = BoardScene(elements: [.svg(element)])

        let data = try JSONEncoder().encode(scene)
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let wire = try XCTUnwrap((json["elements"] as? [[String: Any]])?.first)
        XCTAssertEqual(wire["kind"] as? String, "svg")
        XCTAssertEqual(wire["svg"] as? String, raw)
        XCTAssertEqual(wire["width"] as? Double, 260)
        XCTAssertEqual(wire["rotation"] as? Double, 30)

        let restored = try JSONDecoder().decode(BoardScene.self, from: data)
        XCTAssertEqual(restored, scene)
        if case .svg(let value) = try XCTUnwrap(restored.elements.first) {
            XCTAssertEqual(value.svg, raw)
        } else {
            XCTFail("expected an svg element")
        }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var session = LearningSession.empty
        session.boardScene = scene
        let persistence = SessionPersistence(directoryURL: directory)
        persistence.save(session)
        let loaded = try XCTUnwrap(persistence.loadCurrent())
        XCTAssertEqual(loaded.boardScene, scene)
    }

    /// A frameless figure survives the round trip the device makes on every
    /// turn: it is written as 0, because the server's schema requires the key,
    /// and 0 comes back as no frame at all.
    func testAFramelessFigureIsWrittenAsZeroAndReadBackAsNoFrame() throws {
        let element = SVGElement(id: "fig", x: 40, y: -60, svg: Self.filledDocument())
        XCTAssertNil(element.width)
        XCTAssertNil(element.height)
        XCTAssertNil(element.frame)

        let scene = BoardScene(elements: [.svg(element)])
        let data = try JSONEncoder().encode(scene)
        let wire = try XCTUnwrap(
            (try JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { ($0["elements"] as? [[String: Any]])?.first }
        )
        XCTAssertEqual(wire["width"] as? Double, 0, "the strict schema requires the key")
        XCTAssertEqual(wire["height"] as? Double, 0)
        XCTAssertEqual(wire["x"] as? Double, 40)

        let restored = try JSONDecoder().decode(BoardScene.self, from: data)
        XCTAssertEqual(restored, scene, "0 must decode back to no frame, not to a 0 x 0 box")
    }

    /// The server sends 0 for "natural size", and a build older than the frame
    /// sent no key at all. Both mean the same thing here.
    func testZeroAndMissingFrameKeysBothDecodeAsNoFrame() throws {
        for frame in ["\"width\": 0, \"height\": 0, ", ""] {
            let json = """
            {"elements": [{"id": "fig", "kind": "svg", "x": 5, "y": 6, \(frame)\
            "svg": "<svg viewBox=\\"0 0 10 10\\"/>"}]}
            """
            let scene = try JSONDecoder().decode(BoardScene.self, from: Data(json.utf8))
            guard case .svg(let value) = try XCTUnwrap(scene.elements.first) else {
                return XCTFail("expected an svg element")
            }
            XCTAssertNil(value.width, "frame keys: \(frame.isEmpty ? "absent" : "zero")")
            XCTAssertNil(value.height)
            XCTAssertNil(value.frame)
            XCTAssertEqual(value.x, 5)
        }
    }

    /// A scene persisted before the frameless contract, decoded by this build.
    /// The frame it carries is the layout the learner is looking at, so it has
    /// to survive the migration intact.
    func testALegacyScenesFrameIsKept() throws {
        let json = """
        {"elements": [{"id": "old", "kind": "svg", "x": 100, "y": 50,\
        "width": 200, "height": 100, "svg": "<svg viewBox=\\"0 0 20 10\\"/>",\
        "stroke_width": 4}]}
        """
        let scene = try JSONDecoder().decode(BoardScene.self, from: Data(json.utf8))
        guard case .svg(let value) = try XCTUnwrap(scene.elements.first) else {
            return XCTFail("expected an svg element")
        }
        XCTAssertEqual(value.width, 200)
        XCTAssertEqual(value.height, 100)
        XCTAssertEqual(value.frame, CGRect(x: 100, y: 50, width: 200, height: 100))
    }

    /// One number is not a frame. Whichever axis is missing, the only sane
    /// reading is the document's own size — a box with no area draws nothing.
    func testAHalfFrameIsNoFrame() {
        let wide = SVGElement(id: "a", x: 0, y: 0, width: 200, svg: Self.filledDocument())
        let tall = SVGElement(id: "b", x: 0, y: 0, height: 200, svg: Self.filledDocument())
        XCTAssertNil(wide.frame)
        XCTAssertNil(tall.frame)
    }

    // MARK: - Bounds

    func testSVGBoundsHonorFrameAndRotation() throws {
        let element = SVGElement(
            id: "s",
            x: 100,
            y: 50,
            width: 200,
            height: 100,
            svg: #"<svg viewBox="0 0 200 100"></svg>"#,
            style: BoardStyle(strokeWidth: 0)
        )
        let origin = PencilCanvasConfiguration.boardOrigin
        let unrotated = try XCTUnwrap(
            BoardSceneRenderer.bounds(of: BoardScene(elements: [.svg(element)]), boardOrigin: origin)
        )
        XCTAssertEqual(
            unrotated,
            CGRect(x: origin.x + 100, y: origin.y + 50, width: 200, height: 100)
        )

        var rotated = element
        rotated.style.rotation = 45
        let rotatedBounds = try XCTUnwrap(
            BoardSceneRenderer.bounds(of: BoardScene(elements: [.svg(rotated)]), boardOrigin: origin)
        )
        XCTAssertGreaterThan(rotatedBounds.width, unrotated.width)
        XCTAssertGreaterThan(rotatedBounds.height, unrotated.height)
        XCTAssertEqual(rotatedBounds.width, hypot(200, 100), accuracy: 0.001)
    }

    /// A framed figure reports its frame before anything has been parsed: the
    /// document is scaled into that box whatever it turns out to be, so a
    /// restored scene mounts its figures on the very first pass.
    ///
    /// The stroke is not a pen a figure is outlined with, so it does not widen
    /// the rectangle — `image` and `math_text` report theirs the same way.
    func testAFramedFigureReportsItsFrameBeforeItIsParsed() throws {
        let element = SVGElement(
            id: "framed",
            x: 10,
            y: 20,
            width: 200,
            height: 100,
            svg: Self.uniqueDocument(),
            style: BoardStyle(strokeWidth: 12)
        )
        let origin = PencilCanvasConfiguration.boardOrigin
        let bounds = BoardSceneRenderer.bounds(of: .svg(element), boardOrigin: origin)
        XCTAssertEqual(
            bounds, CGRect(x: origin.x + 10, y: origin.y + 20, width: 200, height: 100)
        )
    }

    /// A frameless figure has no bounds until its document is parsed, and the
    /// document's own size afterwards. `.zero` is what the scene union and the
    /// layer view's mount test both drop, so nothing is laid out around a size
    /// nobody knows yet.
    func testAFramelessFiguresBoundsAreTheDocumentOnceItIsParsed() async throws {
        let element = SVGElement(id: "loose", x: 30, y: -40, svg: Self.uniqueDocument())
        let origin = PencilCanvasConfiguration.boardOrigin

        XCTAssertEqual(BoardSceneRenderer.bounds(of: .svg(element), boardOrigin: origin), .zero)
        XCTAssertNil(
            BoardSceneRenderer.bounds(of: BoardScene(elements: [.svg(element)]), boardOrigin: origin),
            "an element with no bounds is left out of the scene union entirely"
        )

        let parsed = await BoardSVGStore.shared.render(element: element)
        _ = try XCTUnwrap(parsed)

        XCTAssertEqual(
            BoardSceneRenderer.bounds(of: .svg(element), boardOrigin: origin),
            CGRect(x: origin.x + 30, y: origin.y - 40, width: 100, height: 80)
        )
    }

    // MARK: - Drawing

    /// No frame: the document is drawn at its own size, with the `viewBox`'s
    /// top-left corner exactly at `(x, y)`.
    func testAFramelessFigureIsDrawnOneToOneAtItsOrigin() async throws {
        let element = SVGElement(id: "loose", x: 20, y: 30, svg: Self.uniqueDocument())
        let parsed = await BoardSVGStore.shared.render(element: element)
        _ = try XCTUnwrap(parsed)

        let raster = try drawScene(BoardScene(elements: [.svg(element)]), size: CGSize(width: 200, height: 160))

        XCTAssertTrue(raster.isRed(x: 22, y: 32), "the figure starts at (x, y)")
        XCTAssertTrue(raster.isRed(x: 118, y: 108), "and ends 100 x 80 points later")
        XCTAssertTrue(raster.isWhite(x: 18, y: 32), "nothing is drawn left of x")
        XCTAssertTrue(raster.isWhite(x: 22, y: 28), "nothing is drawn above y")
        XCTAssertTrue(raster.isWhite(x: 122, y: 108), "and nothing past the document's width")
        XCTAssertTrue(raster.isWhite(x: 118, y: 112), "or past its height")
    }

    /// A frame: the whole document is scaled to fit inside it and centred,
    /// keeping its aspect ratio. A 100 x 80 document in a 200 x 200 box is
    /// drawn 200 x 160, so a band of board shows above and below it — proof
    /// that the figure was not stretched to fill the frame.
    func testAFramedFigureIsFittedAndCentredWithoutStretching() async throws {
        let element = SVGElement(
            id: "framed",
            x: 0,
            y: 0,
            width: 200,
            height: 200,
            svg: Self.uniqueDocument()
        )
        let parsed = await BoardSVGStore.shared.render(element: element)
        _ = try XCTUnwrap(parsed)

        XCTAssertEqual(
            BoardSceneRenderer.figureRect(
                for: element, documentSize: CGSize(width: 100, height: 80)
            ),
            CGRect(x: 0, y: 20, width: 200, height: 160)
        )

        let raster = try drawScene(BoardScene(elements: [.svg(element)]), size: CGSize(width: 200, height: 200))
        XCTAssertTrue(raster.isRed(x: 100, y: 100), "the figure fills the middle of the frame")
        XCTAssertTrue(raster.isRed(x: 4, y: 100), "corner to corner across the wide axis")
        XCTAssertTrue(raster.isRed(x: 196, y: 100))
        XCTAssertTrue(raster.isWhite(x: 100, y: 8), "and is letterboxed rather than stretched")
        XCTAssertTrue(raster.isWhite(x: 100, y: 192))
    }

    /// The learner's capture is the whole board flattened to a PNG, and a
    /// figure that draws on the board has to appear in it.
    func testCompositeCaptureIncludesRenderedSVG() async throws {
        let element = makeComplexElement()
        let parsed = await BoardSVGStore.shared.render(element: element)
        _ = try XCTUnwrap(parsed)

        let capture = CanvasCapture()
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_000, height: 700))
        capture.canvasView = canvas
        capture.scene = BoardScene(elements: [.svg(element)])
        capture.refreshHasInk()
        XCTAssertTrue(capture.hasInk)

        let result = try XCTUnwrap(capture.snapshotAllInkData())
        let image = try XCTUnwrap(UIImage(data: result.data))
        let raster = try Raster(XCTUnwrap(image.cgImage))
        XCTAssertGreaterThan(raster.colouredRatio, 0.05, "the capture should carry the figure")
    }

    /// Markup the parser refuses draws nothing, in either shape, and takes
    /// nothing down with it: the frameless element reports no bounds, the
    /// framed one still reports its frame, and neither crashes the pass.
    func testMalformedSVGDrawsNothingAndDoesNotCrash() async {
        let broken = SVGElement(id: "bad", x: 0, y: 0, svg: "<svg><broken></svg")
        let notSVG = SVGElement(
            id: "bad2", x: 0, y: 0, width: 120, height: 80, svg: "not svg at all"
        )
        let origin = PencilCanvasConfiguration.boardOrigin

        let brokenDocument = await BoardSVGStore.shared.render(element: broken)
        let notSVGDocument = await BoardSVGStore.shared.render(element: notSVG)
        XCTAssertNil(brokenDocument)
        XCTAssertNil(notSVGDocument)

        XCTAssertEqual(BoardSceneRenderer.bounds(of: .svg(broken), boardOrigin: origin), .zero)
        XCTAssertEqual(
            BoardSceneRenderer.bounds(of: .svg(notSVG), boardOrigin: origin),
            CGRect(x: origin.x, y: origin.y, width: 120, height: 80)
        )

        let raster = try? drawScene(
            BoardScene(elements: [.svg(broken), .svg(notSVG)]),
            size: CGSize(width: 200, height: 200)
        )
        XCTAssertEqual(raster?.colouredRatio, 0, "unparseable markup draws nothing at all")
    }

    // MARK: - The fixture

    func testFixtureCoversSVGKindWithComplexMarkup() throws {
        let scene = E2ESeedFixture.scene()
        let svgElements = scene.elements.compactMap { element -> SVGElement? in
            if case .svg(let value) = element { return value }
            return nil
        }
        XCTAssertEqual(svgElements.count, 1)
        let element = try XCTUnwrap(svgElements.first)
        for token in ["linearGradient", "clipPath", "filter", "marker", "<text", "transform", "foreignObject"] {
            XCTAssertTrue(element.svg.contains(token), "fixture should exercise \(token)")
        }
        XCTAssertNotNil(
            element.frame, "the seeded figure keeps a frame, so the legacy path stays exercised"
        )

        let origin = PencilCanvasConfiguration.boardOrigin
        let bounds = try XCTUnwrap(
            BoardSceneRenderer.bounds(of: BoardScene(elements: [.svg(element)]), boardOrigin: origin)
        )
        XCTAssertGreaterThanOrEqual(bounds.minX, origin.x - 500)
        XCTAssertLessThanOrEqual(bounds.maxX, origin.x + 500)
        XCTAssertGreaterThanOrEqual(bounds.minY, origin.y - 350)
        XCTAssertLessThanOrEqual(bounds.maxY, origin.y - 100, "fixture SVG stays above learner workspace")
    }

    // MARK: - Helpers

    /// One scene, drawn through the real renderer onto white, at board origin
    /// zero so a board point is a pixel and an assertion can name a place.
    private func drawScene(_ scene: BoardScene, size: CGSize) throws -> Raster {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            BoardSceneRenderer.draw(scene: scene, in: context.cgContext, boardOrigin: .zero)
        }
        return try Raster(XCTUnwrap(image.cgImage))
    }

    private func makeComplexElement(x: CGFloat = 0, y: CGFloat = 0) -> SVGElement {
        SVGElement(
            id: "diagram",
            x: x,
            y: y,
            width: 260,
            height: 145,
            svg: complexSVG(),
            style: BoardStyle(strokeWidth: 0)
        )
    }

    private func complexSVG() -> String {
        #"""
        <svg viewBox="0 0 260 160" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#E3EEFF"/>
              <stop offset="1" stop-color="#FFF3C7"/>
            </linearGradient>
            <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="2"/>
            </filter>
            <clipPath id="clip">
              <rect x="10" y="8" width="150" height="92" rx="12"/>
            </clipPath>
            <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L9,3 L0,6 z" fill="#E33E38"/>
            </marker>
          </defs>
          <rect x="5" y="5" width="250" height="150" rx="14" fill="url(#bg)" stroke="#0A5A48" stroke-width="2"/>
          <g clip-path="url(#clip)">
            <path d="M20 82 C60 12, 110 132, 150 42" fill="none" stroke="#0155FB" stroke-width="4"/>
            <path d="M60 104 L120 32 L170 32" fill="none" stroke="#40A365" stroke-width="3" stroke-dasharray="6 4" transform="translate(8 0) rotate(-6 100 60)"/>
          </g>
          <circle cx="150" cy="42" r="14" fill="#6051DC" filter="url(#soft)"/>
          <text x="20" y="28" font-family="sans-serif" font-size="16" fill="#0A0A0A">Force diagram</text>
          <line x1="20" y1="122" x2="232" y2="122" stroke="#E33E38" stroke-width="3" marker-end="url(#arrow)"/>
          <g transform="rotate(8 190 122)">
            <path d="M178 122 L198 118 L194 126 z" fill="#E33E38"/>
          </g>
          <foreignObject x="118" y="10" width="124" height="24" font-size="12">
            <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:sans-serif;font-size:12px;color:#0A0A0A">F = 60 N</div>
          </foreignObject>
        </svg>
        """#
    }

    /// One bitmap, redrawn into a plain 8-bit sRGB buffer so a colour can be
    /// named. `BoardSVGStoreTests` holds the same reader for the same reason.
    private struct Raster {
        let width: Int
        let height: Int
        private let pixels: [UInt8]

        init(_ image: CGImage) throws {
            width = image.width
            height = image.height
            var buffer = [UInt8](repeating: 0, count: width * height * 4)
            let context = try XCTUnwrap(CGContext(
                data: &buffer,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            pixels = buffer
        }

        func pixel(x: Int, y: Int) -> (red: Int, green: Int, blue: Int) {
            let index = (y * width + x) * 4
            return (Int(pixels[index]), Int(pixels[index + 1]), Int(pixels[index + 2]))
        }

        /// The documents above are filled with one flat red, and the ground is
        /// white, so "is the figure here" is a question about one pixel.
        func isRed(x: Int, y: Int) -> Bool {
            let pixel = pixel(x: x, y: y)
            return pixel.red - pixel.blue > 60 && pixel.red - pixel.green > 60
        }

        func isWhite(x: Int, y: Int) -> Bool {
            let pixel = pixel(x: x, y: y)
            return pixel.red > 245 && pixel.green > 245 && pixel.blue > 245
        }

        /// How much of the bitmap carries colour rather than grey or white —
        /// the "something was drawn" measure for a figure with no one flat
        /// fill to point at.
        var colouredRatio: Double {
            var coloured = 0
            for index in stride(from: 0, to: pixels.count, by: 4) {
                let red = Int(pixels[index])
                let green = Int(pixels[index + 1])
                let blue = Int(pixels[index + 2])
                if max(red, green, blue) - min(red, green, blue) >= 16 { coloured += 1 }
            }
            return Double(coloured) / Double(width * height)
        }
    }
}
