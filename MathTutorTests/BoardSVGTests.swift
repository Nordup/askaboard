import PencilKit
import UIKit
import XCTest
@testable import MathTutor

@MainActor
final class BoardSVGTests: XCTestCase {
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

    func testLocalWebKitRenderProducesNonblankColoredOutput() async throws {
        let element = makeComplexElement()
        let rendered = await BoardSVGCache.shared.render(element: element)
        let artifact = try XCTUnwrap(rendered)
        let image = renderImage(
            artifact: artifact,
            size: CGSize(width: element.width, height: element.height)
        )
        let stats = pixelStats(image)
        XCTAssertGreaterThan(stats.nonWhiteRatio, 0.05, "SVG should draw visible content")
        XCTAssertGreaterThan(stats.coloredRatio, 0.05, "SVG gradient/paths should be colored")
    }

    func testPDFCachePreservesVerticalOrientation() async throws {
        let element = SVGElement(
            id: "orientation",
            x: 0,
            y: 0,
            width: 200,
            height: 200,
            svg: #"""
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
              <rect x="0" y="0" width="200" height="100" fill="#E33E38"/>
              <rect x="0" y="100" width="200" height="100" fill="#0155FB"/>
            </svg>
            """#,
            style: BoardStyle(strokeWidth: 0)
        )
        let rendered = await BoardSVGCache.shared.render(element: element)
        let artifact = try XCTUnwrap(rendered)
        let image = renderImage(
            artifact: artifact,
            size: CGSize(width: element.width, height: element.height)
        )
        let top = pixelAt(image, xFraction: 0.5, yFraction: 0.1)
        let bottom = pixelAt(image, xFraction: 0.5, yFraction: 0.9)
        XCTAssertGreaterThan(
            top.red - top.blue,
            40,
            "top half should be red, not inverted"
        )
        XCTAssertGreaterThan(
            bottom.blue - bottom.red,
            40,
            "bottom half should be blue, not inverted"
        )
    }

    func testRenderViewportIsBoundedForHugeFrames() async throws {
        let element = SVGElement(
            id: "huge",
            x: 0,
            y: 0,
            width: 5_000,
            height: 3_000,
            svg: #"""
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5000 3000" width="5000" height="3000">
              <rect x="0" y="0" width="5000" height="3000" fill="#0155FB"/>
            </svg>
            """#,
            style: BoardStyle(strokeWidth: 0)
        )
        let rendered = await BoardSVGCache.shared.render(element: element)
        let artifact = try XCTUnwrap(rendered)
        XCTAssertLessThanOrEqual(
            max(artifact.pixelSize.width, artifact.pixelSize.height),
            BoardSVGRenderer.maximumRenderDimension + 0.001
        )
        XCTAssertEqual(
            artifact.pixelSize.width / artifact.pixelSize.height,
            5_000 / 3_000,
            accuracy: 0.01
        )
    }

    func testCompositeCaptureIncludesRenderedSVG() async throws {
        let element = makeComplexElement()
        let rendered = await BoardSVGCache.shared.render(element: element)
        _ = try XCTUnwrap(rendered)

        let capture = CanvasCapture()
        let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 1_000, height: 700))
        capture.canvasView = canvas
        capture.scene = BoardScene(elements: [.svg(element)])
        capture.refreshHasInk()
        XCTAssertTrue(capture.hasInk)

        let result = try XCTUnwrap(capture.snapshotAllInkData())
        let image = try XCTUnwrap(UIImage(data: result.data))
        let stats = pixelStats(image)
        XCTAssertGreaterThan(stats.nonWhiteRatio, 0.05, "capture should include the SVG")
        XCTAssertGreaterThan(stats.coloredRatio, 0.05)
    }

    func testMalformedSVGDoesNotCrash() async throws {
        let malformed = SVGElement(
            id: "bad",
            x: 0,
            y: 0,
            width: 120,
            height: 80,
            svg: "<svg><broken></svg",
            style: BoardStyle(strokeWidth: 0)
        )
        let artifact = await BoardSVGCache.shared.render(element: malformed)
        if let artifact {
            let image = renderImage(
                artifact: artifact,
                size: CGSize(width: malformed.width, height: malformed.height)
            )
            XCTAssertFalse(image.size.width == 0 || image.size.height == 0)
        }

        let notSVG = SVGElement(
            id: "bad2",
            x: 0,
            y: 0,
            width: 120,
            height: 80,
            svg: "not svg at all",
            style: BoardStyle(strokeWidth: 0)
        )
        let blank = await BoardSVGCache.shared.render(element: notSVG)
        if let blank {
            let image = renderImage(
                artifact: blank,
                size: CGSize(width: notSVG.width, height: notSVG.height)
            )
            XCTAssertFalse(image.size.width == 0 || image.size.height == 0)
        }
    }

    func testReplacementChangesCacheKeyAndOutput() async throws {
        let blue = SVGElement(
            id: "shape",
            x: 0,
            y: 0,
            width: 160,
            height: 160,
            svg: #"""
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160"><rect x="10" y="10" width="140" height="140" fill="#0155FB"/></svg>
            """#,
            style: BoardStyle(strokeWidth: 0)
        )
        let red = SVGElement(
            id: "shape",
            x: 0,
            y: 0,
            width: 160,
            height: 160,
            svg: #"""
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160"><circle cx="80" cy="80" r="70" fill="#E33E38"/></svg>
            """#,
            style: BoardStyle(strokeWidth: 0)
        )
        XCTAssertNotEqual(
            BoardSVGCache.cacheKey(svg: blue.svg, width: blue.width, height: blue.height),
            BoardSVGCache.cacheKey(svg: red.svg, width: red.width, height: red.height)
        )

        let renderedA = await BoardSVGCache.shared.render(element: blue)
        let artifactA = try XCTUnwrap(renderedA)
        let renderedB = await BoardSVGCache.shared.render(element: red)
        let artifactB = try XCTUnwrap(renderedB)
        let imageA = renderImage(
            artifact: artifactA,
            size: CGSize(width: blue.width, height: blue.height)
        )
        let imageB = renderImage(
            artifact: artifactB,
            size: CGSize(width: red.width, height: red.height)
        )
        let statsA = pixelStats(imageA)
        let statsB = pixelStats(imageB)
        XCTAssertGreaterThan(statsA.blueAtCenter - statsA.redAtCenter, 40, "blue square should dominate")
        XCTAssertGreaterThan(statsB.redAtCenter - statsB.blueAtCenter, 40, "red circle should dominate")
    }

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

    private func renderImage(artifact: SVGRenderedArtifact, size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            artifact.draw(in: CGRect(origin: .zero, size: size), into: context.cgContext)
        }
    }

    private struct PixelStats {
        var nonWhiteRatio: Double
        var coloredRatio: Double
        var redAtCenter: Int
        var greenAtCenter: Int
        var blueAtCenter: Int
    }

    private func pixelStats(_ image: UIImage) -> PixelStats {
        let cgImage = image.cgImage!
        let width = cgImage.width
        let height = cgImage.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        var nonWhite = 0
        var colored = 0
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let red = Int(pixels[index])
            let green = Int(pixels[index + 1])
            let blue = Int(pixels[index + 2])
            if red < 245 || green < 245 || blue < 245 {
                nonWhite += 1
            }
            if max(red, green, blue) - min(red, green, blue) >= 16 {
                colored += 1
            }
        }
        let center = ((height / 2) * width + width / 2) * 4
        return PixelStats(
            nonWhiteRatio: Double(nonWhite) / Double(width * height),
            coloredRatio: Double(colored) / Double(width * height),
            redAtCenter: Int(pixels[center]),
            greenAtCenter: Int(pixels[center + 1]),
            blueAtCenter: Int(pixels[center + 2])
        )
    }

    private func pixelAt(_ image: UIImage, xFraction: CGFloat, yFraction: CGFloat) -> (red: Int, green: Int, blue: Int) {
        let cgImage = image.cgImage!
        let width = cgImage.width
        let height = cgImage.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        let x = min(width - 1, max(0, Int(xFraction * CGFloat(width))))
        let y = min(height - 1, max(0, Int(yFraction * CGFloat(height))))
        let offset = (y * width + x) * 4
        return (Int(pixels[offset]), Int(pixels[offset + 1]), Int(pixels[offset + 2]))
    }
}
