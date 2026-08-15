import CoreGraphics
import UIKit
import XCTest
@testable import MathTutor

/// The store that turns a scene's raw SVG into a bitmap the board can draw.
///
/// `SwiftDrawProbeTests` records what the *renderer* does with a document.
/// This file records what the *store* does with the renderer: which sizes it
/// reports, how many pixels it keeps, which failures it remembers and which it
/// forgives, and when it says a figure is ready.
///
/// Five claims here are the ones that would go wrong quietly:
///
/// 1. **The frame is not the document.** The element carries a frame the model
///    chose; the size the store reports is the document's own. Keying the
///    bitmap on the frame instead would fork one figure into a bitmap per
///    placement, which is what the WebKit cache did.
/// 2. **A bitmap is not a picture.** `rasterize` returns a non-optional
///    `UIImage`, so a store that only checks for nil would happily cache a
///    blank one. Only the pixels tell a drawn figure from an empty tile.
/// 3. **Two failures, two answers.** Markup that does not parse will not parse
///    on the next scene install either, so it is refused once and for good. A
///    raster that does not come back says nothing about the markup, so it is
///    not recorded at all — `BoardSVGCache`'s rule, kept.
/// 4. **A budget that is too small degrades; it never thrashes.** An evicted
///    figure is re-rendered on the next explicit ask or scene install, but not
///    by a draw — a draw that schedules work is a draw the completion's own
///    notification can make schedule it again. Four bytes a pixel, so that the
///    budget prices what it thinks it prices.
/// 5. **Up is up.** A `CGImage` draws y-up into a y-down UIKit context, so the
///    one composite path has to flip, and a figure that arrives upside down on
///    a child's iPad is a silent, total failure of the feature.
@MainActor
final class BoardSVGStoreTests: XCTestCase {

    // MARK: - The documents

    private static let namespace = #"xmlns="http://www.w3.org/2000/svg""#

    /// 100 x 80, filled corner to corner, in one flat colour that is easy to
    /// recognise in a pixel: r34 g102 b170.
    private static let triangle = """
    <svg \(namespace) viewBox="0 0 100 80"><path d="M0 80 L50 0 L100 80 Z" fill="#2266aa"/></svg>
    """

    /// A second document, so that "another figure" is never the same key.
    private static let square = """
    <svg \(namespace) viewBox="0 0 60 60"><rect width="60" height="60" fill="#204060"/></svg>
    """

    /// Larger on its long side than any bitmap the store will keep.
    private static let hugeDocument = """
    <svg \(namespace) viewBox="0 0 8000 4000"><rect width="8000" height="4000" fill="#204060"/></svg>
    """

    /// Red over blue, so that a vertical flip is unmistakable.
    private static let twoBands = """
    <svg \(namespace) viewBox="0 0 200 200">\
    <rect y="0" width="200" height="100" fill="#E33E38"/>\
    <rect y="100" width="200" height="100" fill="#0155FB"/></svg>
    """

    private func element(
        _ markup: String,
        id: String = "s",
        width: CGFloat = 100,
        height: CGFloat = 80
    ) -> SVGElement {
        SVGElement(id: id, x: 0, y: 0, width: width, height: height, svg: markup)
    }

    // MARK: - What a render produces

    func testRenderProducesImageAndViewBoxSize() async {
        let parsed = await BoardSVGStore.shared.render(element: element(Self.triangle))
        XCTAssertNotNil(parsed?.image)
        XCTAssertEqual(parsed?.size, CGSize(width: 100, height: 80))
    }

    func testMalformedMarkupFailsClosed() async {
        let parsed = await BoardSVGStore.shared.render(element: element("<svg><unclosed"))
        XCTAssertNil(parsed)
    }

    /// The frame the model placed the figure in changes nothing here: same
    /// markup, one key, one bitmap, one pass of work.
    func testTheElementFrameDoesNotChangeTheDocument() async throws {
        let store = BoardSVGStore()
        let inSmallFrame = await store.render(element: element(Self.triangle, width: 20, height: 16))
        let inLargeFrame = await store.render(
            element: element(Self.triangle, id: "s2", width: 900, height: 720)
        )
        let small = try XCTUnwrap(inSmallFrame)
        let large = try XCTUnwrap(inLargeFrame)

        XCTAssertEqual(small.size, CGSize(width: 100, height: 80))
        XCTAssertEqual(large.size, small.size)
        XCTAssertTrue(large.image === small.image, "one document, one bitmap")
        XCTAssertEqual(store.renderPassesForTesting, 1)
    }

    /// The bitmap carries more pixels than the document has points, because the
    /// board zooms and a 1:1 raster goes soft the moment the learner pinches.
    func testTheRasterIsOversampledForZoom() async throws {
        let rendered = await BoardSVGStore().render(element: element(Self.triangle))
        let parsed = try XCTUnwrap(rendered)

        XCTAssertEqual(parsed.size, CGSize(width: 100, height: 80))
        XCTAssertEqual(CGFloat(parsed.image.width), 100 * BoardSVGStore.rasterOversample)
        XCTAssertEqual(CGFloat(parsed.image.height), 80 * BoardSVGStore.rasterOversample)
    }

    /// A document larger than the ceiling is drawn smaller, not refused, and
    /// keeps its aspect ratio. `size` still reports the document, so layout is
    /// unaffected by how many pixels the store chose to keep.
    func testAHugeDocumentIsCappedAtTheMaximumRasterSide() async throws {
        let rendered = await BoardSVGStore().render(element: element(Self.hugeDocument))
        let parsed = try XCTUnwrap(rendered)

        XCTAssertEqual(parsed.size, CGSize(width: 8_000, height: 4_000))
        XCTAssertEqual(CGFloat(parsed.image.width), BoardSVGStore.maximumRasterSide)
        XCTAssertEqual(
            CGFloat(parsed.image.height), BoardSVGStore.maximumRasterSide / 2, accuracy: 1
        )
    }

    /// The pixels, not merely the image. `rasterize` hands back a `UIImage`
    /// whatever happened, so a document that parsed and drew nothing would
    /// otherwise be cached and shown as an empty patch of board.
    func testTheRasterCarriesTheFigureAndNotABlankBitmap() async throws {
        let rendered = await BoardSVGStore().render(element: element(Self.triangle))
        let parsed = try XCTUnwrap(rendered)
        let raster = try Raster(parsed.image)

        // The triangle is half of a 100 x 80 document, oversampled: about
        // 100 * 80 / 2 * oversample² pixels of ink.
        let oversample = BoardSVGStore.rasterOversample
        let expected = Double(100 * 80 / 2) * Double(oversample * oversample)
        XCTAssertGreaterThan(raster.inkedPixels, Int(expected * 0.9))
        XCTAssertEqual(raster.alpha(x: 2, y: 2), 0, "the corner outside the triangle stays clear")

        // Well inside the triangle: the fill, and nothing else.
        let pixel = raster.pixel(x: raster.width / 2, y: raster.height * 3 / 4)
        let seen = "r\(pixel.red) g\(pixel.green) b\(pixel.blue) a\(pixel.alpha)"
        XCTAssertEqual(pixel.alpha, 255, seen)
        XCTAssertLessThanOrEqual(abs(pixel.red - 34), 8, seen)
        XCTAssertLessThanOrEqual(abs(pixel.green - 102), 8, seen)
        XCTAssertLessThanOrEqual(abs(pixel.blue - 170), 8, seen)
    }

    // MARK: - The two kinds of failure

    /// Markup that does not parse is refused once. A second ask, and every
    /// later scene install, answers from the refusal rather than parsing the
    /// same broken document again.
    func testAParseFailureIsNeverRetried() async {
        let store = BoardSVGStore()
        let broken = element("<svg><unclosed")

        let first = await store.render(element: broken)
        let second = await store.render(element: broken)
        XCTAssertNil(first)
        XCTAssertNil(second)
        XCTAssertEqual(store.renderPassesForTesting, 1)

        // If `prepare` had scheduled a second pass, the `render` below would
        // join it and the count would climb.
        store.prepare(scene: BoardScene(elements: [.svg(broken)]))
        let third = await store.render(element: broken)
        XCTAssertNil(third)
        XCTAssertEqual(store.renderPassesForTesting, 1)
    }

    /// A raster that does not come back is not recorded against the key: the
    /// document parsed, so the markup is good, and the next ask must be free to
    /// try again. This is the rule `BoardSVGCache` had to learn about WebKit
    /// timeouts, kept for the reasons that survive the renderer swap.
    ///
    /// The retry is an *explicit* ask. A draw must not start one: the failed
    /// render posts `.boardSceneArtifactReady`, the layer view reconciles on it
    /// and draws again, so a self-scheduling draw would spin for as long as the
    /// element stayed on the board.
    func testARasterFailureDoesNotPoisonTheKey() async throws {
        let store = BoardSVGStore()
        store.failsRasterForTesting = true
        let failed = await store.render(element: element(Self.triangle))
        XCTAssertNil(failed)
        XCTAssertEqual(store.renderPassesForTesting, 1)

        // Two reconcile passes' worth of draws. Work scheduled by one of them
        // would announce itself when it finished, which is the notification
        // that brings the layer view back for the next pass — so an inverted
        // expectation on it is the loop's own trigger, asserted absent.
        let quiet = expectation(forNotification: .boardSceneArtifactReady, object: nil)
        quiet.isInverted = true
        for _ in 0..<2 {
            XCTAssertNil(store.document(for: element(Self.triangle)))
            await Task.yield()
        }
        await fulfillment(of: [quiet], timeout: 0.5)
        XCTAssertEqual(
            store.renderPassesForTesting, 1, "a draw must never retry a failed raster"
        )

        store.failsRasterForTesting = false
        let retried = await store.render(element: element(Self.triangle))
        let parsed = try XCTUnwrap(retried)
        XCTAssertEqual(parsed.size, CGSize(width: 100, height: 80))
        XCTAssertEqual(store.renderPassesForTesting, 2, "the second ask did the work again")
    }

    // MARK: - Scheduling and readiness

    /// `document(for:)` is the renderer's synchronous read: nothing before the
    /// bitmap lands, the bitmap after. The miss also schedules, and the render
    /// that follows joins that one pass rather than starting a second.
    func testDocumentAnswersOnlyOnceTheRasterHasLanded() async throws {
        let store = BoardSVGStore()
        let figure = element(Self.triangle)
        XCTAssertNil(store.document(for: figure))

        let rendered = await store.render(element: figure)
        _ = try XCTUnwrap(rendered)
        XCTAssertNotNil(store.document(for: figure))
        XCTAssertEqual(store.renderPassesForTesting, 1)
    }

    /// Installing a scene schedules every figure in it and nothing else.
    func testPrepareSchedulesEveryFigureInTheScene() async {
        let store = BoardSVGStore()
        let first = element(Self.triangle, id: "a")
        let second = element(Self.square, id: "b")
        let scene = BoardScene(elements: [
            .svg(first),
            .text(TextElement(id: "t", x: 0, y: 0, text: "not a figure", fontSize: 20)),
            .svg(second),
        ])
        store.prepare(scene: scene)

        let firstDocument = await store.render(element: first)
        let secondDocument = await store.render(element: second)
        XCTAssertNotNil(firstDocument)
        XCTAssertNotNil(secondDocument)
        XCTAssertEqual(
            store.renderPassesForTesting, 2, "prepare did the work; the renders joined it"
        )
    }

    /// The board is told, so the layer view can reconcile a figure it drew as
    /// nothing a moment ago.
    func testALandedRasterAnnouncesItself() async {
        let store = BoardSVGStore()
        let ready = expectation(forNotification: .boardSceneArtifactReady, object: nil)
        await store.render(element: element(Self.triangle))
        await fulfillment(of: [ready], timeout: 1)
    }

    // MARK: - Residency

    /// Every bitmap is four bytes a pixel, whatever the screen can show.
    ///
    /// SwiftDraw rasterizes through `UIGraphicsImageRendererFormat.preferred()`
    /// at `preferredRange = .automatic`, which on a wide-gamut iPad is an
    /// extended-range buffer at eight bytes a pixel. Left alone, one 2048-pixel
    /// figure would be 33 MB and the byte cap would be counting half of what
    /// the store holds.
    func testTheRasterIsFlattenedToFourBytesPerPixel() async throws {
        let store = BoardSVGStore()
        let rendered = await store.render(element: element(Self.triangle))
        let parsed = try XCTUnwrap(rendered)

        XCTAssertEqual(parsed.image.bitsPerPixel, 32)
        XCTAssertEqual(parsed.image.bitsPerComponent, 8)
        XCTAssertEqual(
            store.totalBytesForTesting, parsed.image.bytesPerRow * parsed.image.height,
            "the budget is priced in the bytes the bitmap actually holds"
        )
        XCTAssertLessThan(
            store.totalBytesForTesting, parsed.image.width * parsed.image.height * 8,
            "an extended-range bitmap would be twice this"
        )
    }

    /// A figure pushed out under the byte cap is not lost: the markup that made
    /// it is in the element, so an explicit ask renders it again. What must not
    /// ask is a draw — see the test below for why.
    func testAnEvictedFigureIsRenderedAgainRatherThanLost() async throws {
        let store = BoardSVGStore(byteLimit: 1)
        let first = element(Self.triangle, id: "a")
        let second = element(Self.square, id: "b")
        let firstDocument = await store.render(element: first)
        let secondDocument = await store.render(element: second)
        _ = try XCTUnwrap(firstDocument)
        _ = try XCTUnwrap(secondDocument)

        XCTAssertNil(store.document(for: first), "the older figure gave up its bytes")
        let reRendered = await store.render(element: first)
        XCTAssertNotNil(reRendered)
        XCTAssertEqual(store.renderPassesForTesting, 3)
    }

    /// Two figures that cannot both fit must not take turns evicting each other.
    ///
    /// Every completed render posts `.boardSceneArtifactReady`, the layer view
    /// reconciles on it, and reconciling draws — so a draw that re-rendered an
    /// evicted figure would drive its own next round for as long as the board
    /// showed both. The tile cache does not damp it either: the layer view
    /// consults this store before its own cache. So the board degrades — one of
    /// the two draws as nothing — and the scene install is what re-decides.
    func testAWorkingSetOverTheBudgetDoesNotThrash() async throws {
        let store = BoardSVGStore(byteLimit: 1)
        let first = element(Self.triangle, id: "a")
        let second = element(Self.square, id: "b")
        let firstDocument = await store.render(element: first)
        let secondDocument = await store.render(element: second)
        _ = try XCTUnwrap(firstDocument)
        _ = try XCTUnwrap(secondDocument)
        XCTAssertEqual(store.renderPassesForTesting, 2)

        // Twenty reconcile passes: each one draws both elements, and each
        // suspension lets anything that was scheduled run and be counted.
        for _ in 0..<20 {
            _ = store.document(for: first)
            _ = store.document(for: second)
            await Task.yield()
        }
        XCTAssertEqual(
            store.renderPassesForTesting, 2, "draws alone must not schedule a single render"
        )

        // The scene install is the retry point, and it costs one pass.
        store.prepare(scene: BoardScene(elements: [.svg(first)]))
        let back = await store.render(element: first)
        XCTAssertNotNil(back)
        XCTAssertEqual(store.renderPassesForTesting, 3)
    }

    // MARK: - Compositing

    /// The composite path, in the orientation every UIKit drawing context has.
    /// Red is on top in the document; red has to stay on top on the board.
    func testDrawingIntoAFlippedContextKeepsTheFigureUpright() async throws {
        let rendered = await BoardSVGStore().render(
            element: element(Self.twoBands, width: 200, height: 200)
        )
        let parsed = try XCTUnwrap(rendered)

        let size = CGSize(width: 200, height: 200)
        let composited = UIGraphicsImageRenderer(size: size).image { context in
            parsed.draw(
                in: CGRect(origin: .zero, size: size),
                into: context.cgContext,
                isFlipped: context.cgContext.ctm.d < 0
            )
        }
        let raster = try Raster(XCTUnwrap(composited.cgImage))

        let top = raster.pixel(x: raster.width / 2, y: raster.height / 4)
        let bottom = raster.pixel(x: raster.width / 2, y: raster.height * 3 / 4)
        XCTAssertGreaterThan(top.red - top.blue, 40, "the top band should be red, not inverted")
        XCTAssertGreaterThan(
            bottom.blue - bottom.red, 40, "the bottom band should be blue, not inverted"
        )
    }

    // MARK: - Reading pixels back

    /// One bitmap, redrawn into a plain 8-bit sRGB buffer so that a colour can
    /// be written down. The store's own raster asks for the preferred renderer
    /// format, which on a wide-gamut screen is not sRGB bytes.
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

        func pixel(x: Int, y: Int) -> (red: Int, green: Int, blue: Int, alpha: Int) {
            let index = (y * width + x) * 4
            return (
                Int(pixels[index]), Int(pixels[index + 1]),
                Int(pixels[index + 2]), Int(pixels[index + 3])
            )
        }

        func alpha(x: Int, y: Int) -> Int { pixel(x: x, y: y).alpha }

        var inkedPixels: Int {
            var count = 0
            for index in stride(from: 3, to: pixels.count, by: 4) where pixels[index] > 0 {
                count += 1
            }
            return count
        }
    }
}
