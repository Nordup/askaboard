import CoreGraphics
import SwiftDraw
import UIKit
import XCTest
@testable import MathTutor

/// What SwiftDraw 0.29.0 draws, recorded as assertions.
///
/// The board renders the tutor's SVG figures. This file is the record of what
/// the renderer supports, written before the board depends on it, so that a
/// later release that changes an answer turns a test red instead of turning a
/// figure blank on a child's iPad.
///
/// Two kinds of test live here and both must stay:
///
/// 1. **API pins.** `SVG(data:)`, `.size` and `rasterize(scale:)` are the three
///    calls the board makes. A rename in a later 0.x release breaks the build
///    here first, next to a comment that says what the call was for.
/// 2. **Feature probes.** Each one draws a document that uses one SVG feature
///    and then reads the pixels back. `XCTAssertNotNil` on its own proves
///    nothing: `rasterize` returns a non-optional `UIImage`, so a document that
///    parses but draws nothing still gives an image — a blank one. Only the
///    pixels separate "supported" from "silently dropped".
///
/// Two of the probes contradicted the server, and the server has since been
/// corrected: `server/app/tutor/board_scene.py` no longer warns about `<mask>`
/// at all, and its `<filter>` warning now says the effect is dropped while the
/// shape still draws. The test names below are what those two warnings are
/// written from. If one of them goes red, fix the warning to match the new
/// answer — do not fix these tests.
///
/// The `@testable import MathTutor` is deliberate although no app type is used.
/// It proves the name `SVG` stays unambiguous while both modules are in scope,
/// which is the context the board's own renderer will compile in.
@MainActor
final class SwiftDrawProbeTests: XCTestCase {

    // MARK: - API pins

    /// The three calls the board makes, in one test.
    ///
    /// `rasterize(scale:)` takes an explicit scale on purpose. The default
    /// argument is `0`, which makes SwiftDraw read `UIScreen.main.scale`, and
    /// that turns every pixel count below into a property of the host device.
    func testSVGDataInitAndRasterizeAndSizeAreTheAPI() throws {
        let svg = try XCTUnwrap(SVG(data: Data(Markup.filledSquare.utf8)))
        XCTAssertEqual(svg.size, CGSize(width: 100, height: 100))

        let image = svg.rasterize(scale: 1)
        XCTAssertEqual(image.size, CGSize(width: 100, height: 100))
        XCTAssertEqual(image.scale, 1)
        let bitmap = try XCTUnwrap(image.cgImage)
        XCTAssertEqual(bitmap.width, 100)
        XCTAssertEqual(bitmap.height, 100)
    }

    /// A scale above 1 multiplies the pixels and leaves the point size alone.
    /// The board caches a bitmap per zoom bucket, so this is the call that
    /// turns a bucket into a resolution.
    func testRasterizeScaleMultipliesPixelsNotPoints() throws {
        let svg = try XCTUnwrap(SVG(data: Data(Markup.filledSquare.utf8)))
        let image = svg.rasterize(scale: 2)
        XCTAssertEqual(image.size, CGSize(width: 100, height: 100))
        XCTAssertEqual(image.scale, 2)
        XCTAssertEqual(try XCTUnwrap(image.cgImage).width, 200)
    }

    /// `rasterize(size:scale:)` scales the artwork to a target box. The board
    /// draws a figure at the size the scene gives it, not at the size the
    /// document declares, so this is the second rasterize call it needs.
    func testRasterizeToAnExplicitSizeScalesTheArtwork() throws {
        let svg = try XCTUnwrap(SVG(data: Data(Markup.filledSquare.utf8)))
        let image = svg.rasterize(size: CGSize(width: 300, height: 150), scale: 1)
        XCTAssertEqual(image.size, CGSize(width: 300, height: 150))
        XCTAssertEqual(try XCTUnwrap(image.cgImage).width, 300)
    }

    /// A document with a `viewBox` and no `width`/`height` takes its size from
    /// the box. The tutor writes figures this way.
    func testViewBoxAloneGivesTheSize() {
        let svg = SVG(data: Data(Markup.viewBoxOnly.utf8))
        XCTAssertEqual(svg?.size, CGSize(width: 300, height: 120))
    }

    /// A fractional `viewBox` is truncated toward zero, not rounded.
    ///
    /// SwiftDraw holds the root width and height as `Int`, so `300.7` becomes
    /// `300`. Anything that lays a figure out from `svg.size` loses up to a
    /// point on each axis. Send whole numbers from the server.
    func testFractionalViewBoxIsTruncatedToWholePoints() {
        let svg = SVG(data: Data(Markup.fractionalViewBox.utf8))
        XCTAssertEqual(svg?.size, CGSize(width: 300, height: 120))
    }

    /// `width` and `height` win over the `viewBox`, and a `px` suffix parses.
    func testWidthAndHeightAttributesWinOverTheViewBox() {
        let svg = SVG(data: Data(Markup.widthHeightPixels.utf8))
        XCTAssertEqual(svg?.size, CGSize(width: 300, height: 120))
    }

    /// Bad markup gives `nil` rather than an empty image, so the board can tell
    /// a broken document from an empty one and show the right thing.
    func testMalformedMarkupGivesNil() {
        XCTAssertNil(SVG(data: Data("<svg><not-closed>".utf8)))
    }

    /// A document with no `width`, no `height` and no `viewBox` also gives
    /// `nil`. SwiftDraw cannot pick a size, so it refuses the document.
    func testDocumentWithNoSizeAndNoViewBoxGivesNil() {
        XCTAssertNil(SVG(data: Data(Markup.noSize.utf8)))
    }

    // MARK: - Feature probes

    /// Paths inside a transformed group draw where the transform puts them.
    func testPathsAndGroupsRender() throws {
        let raster = try render(Markup.pathInGroup)
        assertColour(raster, x: 50, y: 25, red: 32, green: 64, blue: 96, alpha: 255)
        XCTAssertEqual(raster.alpha(x: 2, y: 95), 0, "outside the triangle stays clear")
        // The triangle is 80 wide and 60 tall, so it covers about 2400 pixels.
        XCTAssertTrue(
            (2_200...2_700).contains(raster.inkedPixels),
            "expected the triangle's area, got \(raster.inkedPixels)"
        )
    }

    /// A `linearGradient` in `defs`, referenced by `fill="url(#id)"`, draws a
    /// real ramp — red on the left, blue on the right, many shades between.
    func testLinearGradientRenders() throws {
        let raster = try render(Markup.linearGradient)
        XCTAssertGreaterThan(raster.red(x: 2, y: 50), 200, "left end should be red")
        XCTAssertGreaterThan(raster.blue(x: 97, y: 50), 200, "right end should be blue")
        XCTAssertGreaterThan(
            raster.distinctColours, 100,
            "a ramp has many colours; a flat fill would have one"
        )
    }

    /// A `<style>` block with a class selector applies.
    ///
    /// This is the probe the plan turns on. If it goes red, SwiftDraw ignores
    /// stylesheets, and the server has to flatten every CSS rule into
    /// presentation attributes before it sends a figure. Read the failure
    /// before you touch anything else in this file.
    func testCSSStyleBlockWithAClassSelectorRenders() throws {
        let raster = try render(Markup.cssClassSelector)
        assertColour(
            raster, x: 50, y: 50, red: 18, green: 52, blue: 86, alpha: 255,
            message: "the .a rule's fill #123456 did not reach the rect"
        )
    }

    /// The same block with an element selector, and a stroke as well as a fill,
    /// because a stylesheet the tutor writes will carry both.
    func testCSSStyleBlockWithAnElementSelectorAppliesFillAndStroke() throws {
        let raster = try render(Markup.cssElementSelector)
        assertColour(raster, x: 50, y: 50, red: 18, green: 52, blue: 86, alpha: 255)
        assertColour(
            raster, x: 50, y: 11, red: 255, green: 0, blue: 0, alpha: 255,
            message: "the stroke should sit on the rect's edge"
        )
    }

    /// An inline `style=""` attribute applies. This is the shape the server
    /// would fall back to if the `<style>` probe above ever fails.
    func testInlineStyleAttributeRenders() throws {
        let raster = try render(Markup.inlineStyleAttribute)
        assertColour(raster, x: 50, y: 50, red: 18, green: 52, blue: 86, alpha: 255)
    }

    /// `<text>` draws glyphs. The assertion counts ink rather than naming a
    /// pixel, because the glyph shapes depend on the platform's font.
    func testTextRenders() throws {
        let raster = try render(Markup.text)
        XCTAssertGreaterThan(raster.inkedPixels, 100, "expected glyphs, got a blank image")
        XCTAssertGreaterThan(
            raster.softPixels, 50,
            "glyph edges should be anti-aliased, which is what tells text from a rect"
        )
    }

    /// An unknown `font-family` falls back instead of dropping the text.
    /// SwiftDraw asks for "Helvetica" and then "Times", and both exist on iOS.
    func testTextWithAnUnknownFontFamilyStillRenders() throws {
        let raster = try render(Markup.textUnknownFamily)
        XCTAssertGreaterThan(raster.inkedPixels, 100)
    }

    /// A `clipPath` clips. The deleted mask warning used to send the model here
    /// instead; the `svg` arm's description now names clip paths outright, so
    /// this is still the probe that has to hold for that list to be true.
    func testClipPathIsApplied() throws {
        let raster = try render(Markup.clipPath)
        assertColour(raster, x: 25, y: 50, red: 32, green: 64, blue: 96, alpha: 255)
        XCTAssertEqual(raster.alpha(x: 75, y: 50), 0, "the clipped-away half should be clear")
    }

    // MARK: - Cross-checks against the server's lint warnings

    /// A `<filter>` does **not** remove the element. SwiftDraw parses the
    /// filter, prints one warning to stderr, and then draws the element with no
    /// filter applied at all.
    ///
    /// The proof is the byte comparison: the filtered document and the same
    /// document with the `filter` attribute removed produce identical pixels.
    /// The blur is absent, not the rectangle.
    ///
    /// `server/app/tutor/board_scene.py` used to tell the model `<filter>` "is
    /// unsupported and is not drawn". The first half was right and the second
    /// half was wrong, and the difference matters: a figure that leans on a drop
    /// shadow comes back hard-edged, not missing. The warning now says the
    /// effect is ignored and the shape still draws, which is this test in prose.
    func testFilterElementIsDrawnUnfilteredRatherThanDropped() throws {
        let filtered = try render(Markup.gaussianBlurFilter)
        let unfiltered = try render(Markup.filterControl)

        XCTAssertGreaterThan(filtered.inkedPixels, 2_000, "the rect must still be drawn")
        // Counted rather than compared with XCTAssertEqual, which would print
        // forty thousand bytes twice on a failure and hide the finding.
        XCTAssertEqual(filtered.pixels.count, unfiltered.pixels.count)
        let differingBytes = zip(filtered.pixels, unfiltered.pixels).filter(!=).count
        XCTAssertEqual(
            differingBytes, 0,
            "the filtered document should match the unfiltered one byte for byte; "
                + "\(differingBytes) bytes differ, so the filter did something"
        )
        XCTAssertEqual(
            filtered.softPixels, 0,
            "a blur would soften the edges; nothing here is softened"
        )
    }

    /// `SVG.Options.hideUnsupportedFilters` does nothing in 0.29.0.
    ///
    /// The option sets an internal `hasContents` flag that no code reads — the
    /// one `guard` that used it is commented out. So the escape hatch the
    /// warning message recommends is not available, and hiding a filtered
    /// element has to happen before the markup reaches the device.
    ///
    /// A later release may repair this. Then this test fails, and that failure
    /// is good news: read it as "the option works now".
    func testHideUnsupportedFiltersOptionDoesNotHideTheElement() throws {
        let svg = try XCTUnwrap(
            SVG(data: Data(Markup.gaussianBlurFilter.utf8), options: .hideUnsupportedFilters)
        )
        let raster = try render(svg)
        XCTAssertGreaterThan(
            raster.inkedPixels, 2_000,
            "the element is still drawn, so the option had no effect"
        )
    }

    /// A `<mask>` **is** applied. The masked-in half draws and the masked-out
    /// half is clear.
    ///
    /// `server/app/tutor/board_scene.py` used to tell the model `<mask>` "is
    /// unsupported and is not drawn". Against this renderer that was simply
    /// wrong, and it was the expensive kind of wrong: it pushed the model away
    /// from a feature that works. That warning is deleted; the `svg` arm's
    /// description now lists masks among the things the device draws.
    func testMaskIsAppliedRatherThanDropped() throws {
        let masked = try render(Markup.mask)
        assertColour(
            masked, x: 25, y: 50, red: 32, green: 64, blue: 96, alpha: 255,
            message: "the half the mask keeps should draw"
        )
        XCTAssertEqual(masked.alpha(x: 75, y: 50), 0, "the half the mask hides should be clear")

        // Against the same rect with no mask, so a half-covered result cannot
        // be mistaken for a renderer that ignored the mask and drew everything.
        let unmasked = try render(Markup.maskControl)
        XCTAssertEqual(unmasked.inkedPixels, 100 * 100)
        XCTAssertTrue(
            (4_800...5_200).contains(masked.inkedPixels),
            "expected about half the pixels, got \(masked.inkedPixels)"
        )
    }

    /// One document shaped the way a tutor's figure is: a stylesheet, rounded
    /// rectangles, a fill, a stroke and centred text, all together.
    func testABoardShapedDocumentRenders() throws {
        let raster = try render(Markup.boardShapedFigure)
        assertColour(
            raster, x: 120, y: 40, red: 255, green: 227, blue: 227, alpha: 255,
            message: "the .wash class fill should cover the card"
        )
        XCTAssertEqual(raster.alpha(x: 2, y: 2), 0, "the margin outside the card stays clear")
        XCTAssertGreaterThan(raster.inkedPixels, 20_000)
    }

    // MARK: - Rasterizing and reading pixels

    private func render(_ markup: String) throws -> Raster {
        try render(try XCTUnwrap(SVG(data: Data(markup.utf8)), "the document failed to parse"))
    }

    /// Draws through `rasterize(scale:)` — the call the board will make — and
    /// then redraws the result into a plain 8-bit sRGB bitmap.
    ///
    /// The redraw is what makes the colour assertions safe to write down.
    /// `rasterize` asks for `UIGraphicsImageRendererFormat.preferred()`, which
    /// on a wide-gamut screen hands back an extended-range buffer whose bytes
    /// are not the sRGB bytes the document asked for. Drawing that image into a
    /// context we choose converts it back to a known space.
    private func render(_ svg: SVG) throws -> Raster {
        let bitmap = try XCTUnwrap(svg.rasterize(scale: 1).cgImage)
        let width = bitmap.width
        let height = bitmap.height
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
        context.draw(bitmap, in: CGRect(x: 0, y: 0, width: width, height: height))
        return Raster(width: width, height: height, pixels: pixels)
    }

    /// One rasterized document, indexed the way the SVG is: `x` and `y` count
    /// from the top-left corner, in points, at scale 1.
    private struct Raster {
        let width: Int
        let height: Int
        let pixels: [UInt8]

        private func index(_ x: Int, _ y: Int) -> Int { (y * width + x) * 4 }

        func red(x: Int, y: Int) -> Int { Int(pixels[index(x, y)]) }
        func green(x: Int, y: Int) -> Int { Int(pixels[index(x, y) + 1]) }
        func blue(x: Int, y: Int) -> Int { Int(pixels[index(x, y) + 2]) }
        func alpha(x: Int, y: Int) -> Int { Int(pixels[index(x, y) + 3]) }

        /// Pixels the renderer touched at all.
        var inkedPixels: Int {
            var count = 0
            for i in stride(from: 3, to: pixels.count, by: 4) where pixels[i] > 0 { count += 1 }
            return count
        }

        /// Pixels that are neither clear nor solid. Anti-aliased glyph edges
        /// and blurs make these; a hard-edged rectangle makes none.
        var softPixels: Int {
            var count = 0
            for i in stride(from: 3, to: pixels.count, by: 4)
            where pixels[i] > 0 && pixels[i] < 255 { count += 1 }
            return count
        }

        var distinctColours: Int {
            var seen = Set<UInt32>()
            for i in stride(from: 0, to: pixels.count, by: 4) where pixels[i + 3] > 0 {
                seen.insert(
                    UInt32(pixels[i]) << 24 | UInt32(pixels[i + 1]) << 16
                        | UInt32(pixels[i + 2]) << 8 | UInt32(pixels[i + 3])
                )
            }
            return seen.count
        }
    }

    /// A small tolerance absorbs the rounding of the colour-space conversion in
    /// `render(_:)`. It is far tighter than the gap between any two colours the
    /// probes use, so a wrong fill still fails.
    private func assertColour(
        _ raster: Raster,
        x: Int,
        y: Int,
        red: Int,
        green: Int,
        blue: Int,
        alpha: Int,
        tolerance: Int = 4,
        message: String = "",
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let actual = (
            raster.red(x: x, y: y), raster.green(x: x, y: y),
            raster.blue(x: x, y: y), raster.alpha(x: x, y: y)
        )
        let description = message.isEmpty ? "" : " — \(message)"
        for (name, want, got) in [
            ("red", red, actual.0), ("green", green, actual.1),
            ("blue", blue, actual.2), ("alpha", alpha, actual.3)
        ] {
            XCTAssertLessThanOrEqual(
                abs(want - got), tolerance,
                "pixel (\(x),\(y)) \(name): wanted \(want), got \(got); "
                    + "whole pixel r\(actual.0) g\(actual.1) b\(actual.2) a\(actual.3)\(description)",
                file: file, line: line
            )
        }
    }

    // MARK: - The documents

    /// Kept apart from the tests so that each probe reads as one claim, and so
    /// that the filter probe and its control differ by exactly one attribute.
    private enum Markup {
        static let namespace = #"xmlns="http://www.w3.org/2000/svg""#

        static let filledSquare = """
        <svg \(namespace) viewBox="0 0 100 100"><rect width="100" height="100" fill="#204060"/></svg>
        """

        static let viewBoxOnly = """
        <svg \(namespace) viewBox="0 0 300 120"/>
        """

        static let fractionalViewBox = """
        <svg \(namespace) viewBox="0 0 300.7 120.9"/>
        """

        static let widthHeightPixels = """
        <svg \(namespace) width="300px" height="120px" viewBox="0 0 600 240"/>
        """

        static let noSize = """
        <svg \(namespace)><rect width="10" height="10"/></svg>
        """

        static let pathInGroup = """
        <svg \(namespace) viewBox="0 0 100 100">\
        <g transform="translate(10,10)"><path d="M0 0 L80 0 L40 60 Z" fill="#204060"/></g>\
        </svg>
        """

        static let linearGradient = """
        <svg \(namespace) viewBox="0 0 100 100"><defs>\
        <linearGradient id="g">\
        <stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>\
        </linearGradient></defs>\
        <rect width="100" height="100" fill="url(#g)"/></svg>
        """

        static let cssClassSelector = """
        <svg \(namespace) viewBox="0 0 100 100"><style>.a{fill:#123456}</style>\
        <rect class="a" width="100" height="100"/></svg>
        """

        static let cssElementSelector = """
        <svg \(namespace) viewBox="0 0 100 100">\
        <style>rect{fill:#123456;stroke:#ff0000;stroke-width:6}</style>\
        <rect x="10" y="10" width="80" height="80"/></svg>
        """

        static let inlineStyleAttribute = """
        <svg \(namespace) viewBox="0 0 100 100">\
        <rect width="100" height="100" style="fill:#123456"/></svg>
        """

        static let text = """
        <svg \(namespace) viewBox="0 0 200 50">\
        <text x="10" y="30" font-size="20">probe</text></svg>
        """

        static let textUnknownFamily = """
        <svg \(namespace) viewBox="0 0 200 50">\
        <text x="10" y="30" font-size="20" font-family="NotARealFontFamily">probe</text></svg>
        """

        /// A blur wide enough that a working filter could not be missed: the
        /// rect would bleed well past its edges and soften every pixel on them.
        static let gaussianBlurFilter = """
        <svg \(namespace) viewBox="0 0 100 100"><defs>\
        <filter id="f"><feGaussianBlur stdDeviation="6"/></filter></defs>\
        <rect x="25" y="25" width="50" height="50" fill="#204060" filter="url(#f)"/></svg>
        """

        /// `gaussianBlurFilter` with the filter taken away. Any pixel that
        /// differs between the two is the filter doing something.
        static let filterControl = """
        <svg \(namespace) viewBox="0 0 100 100">\
        <rect x="25" y="25" width="50" height="50" fill="#204060"/></svg>
        """

        static let mask = """
        <svg \(namespace) viewBox="0 0 100 100"><defs>\
        <mask id="m"><rect x="0" y="0" width="50" height="100" fill="#ffffff"/></mask></defs>\
        <rect width="100" height="100" fill="#204060" mask="url(#m)"/></svg>
        """

        /// `mask` with the mask taken away: the rect covers the whole document.
        static let maskControl = filledSquare

        static let clipPath = """
        <svg \(namespace) viewBox="0 0 100 100"><defs>\
        <clipPath id="c"><rect x="0" y="0" width="50" height="100"/></clipPath></defs>\
        <rect width="100" height="100" fill="#204060" clip-path="url(#c)"/></svg>
        """

        static let boardShapedFigure = """
        <svg \(namespace) viewBox="0 0 240 160">\
        <style>.frame{fill:none;stroke:#1F2933;stroke-width:3}.wash{fill:#FFE3E3}</style>\
        <rect class="wash" x="20" y="20" width="200" height="120" rx="8"/>\
        <rect class="frame" x="20" y="20" width="200" height="120" rx="8"/>\
        <text x="120" y="90" font-size="18" text-anchor="middle" fill="#1F2933">7 + 5</text>\
        </svg>
        """
    }
}
