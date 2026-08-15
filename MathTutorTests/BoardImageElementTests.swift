import CoreGraphics
import UIKit
import XCTest
@testable import MathTutor

/// The `image` primitive — a picture the server already holds, placed on the
/// board by its blob key — and the store that turns that key into a bitmap.
///
/// Four rules can only be proven here. The wire element is flat, and the key is
/// `blob_id` in snake_case; camel-casing it would decode to an empty key and
/// leave a permanent grey rectangle where a picture belongs, with nothing
/// failing anywhere to say so. The bytes are cached on disk under the digest,
/// so the second sight of a blob costs no request at all. A download that
/// *failed* separates into two cases — the blob is not there (fail closed, the
/// way `BoardMathStore` treats LaTeX that does not parse) and the network was
/// not there (retryable, the way `BoardSVGCache` treats a WebKit timeout) — and
/// confusing the two either re-fetches an unusable blob every turn or blanks a
/// picture for the rest of the session. And the placeholder that stands in
/// while the download runs is never cached: `RasterKey` holds the element
/// value, and that value is identical before and after the bytes land.
@MainActor
final class BoardImageElementTests: XCTestCase {

    // MARK: - The wire element

    func testDecodesFromTheFlatWireElement() throws {
        // The exact field set `server/app/tutor/board_scene.py`'s `ImageElement`
        // defines: id, kind, x, y, width, height, blob_id, and the seven style
        // keys beside them — one flat object, no nesting.
        let json = """
        {"id":"i1","kind":"image","x":10,"y":20,"width":120,"height":90,
         "blob_id":"sha256:\(String(repeating: "ab", count: 32))",
         "role":"hint","stroke":"#0155FB","fill":"#FFE3E3","stroke_width":6,
         "opacity":0.5,"dash":[6,4],"rotation":15}
        """
        let element = try JSONDecoder().decode(BoardElement.self, from: Data(json.utf8))

        guard case .image(let image) = element else { return XCTFail("expected an image element") }
        XCTAssertEqual(image.id, "i1")
        XCTAssertEqual(image.kind, .image)
        XCTAssertEqual(image.x, 10)
        XCTAssertEqual(image.y, 20)
        XCTAssertEqual(image.width, 120)
        XCTAssertEqual(image.height, 90)
        XCTAssertEqual(image.blobId, "sha256:\(String(repeating: "ab", count: 32))")
        XCTAssertEqual(image.style.role, .hint)
        XCTAssertEqual(image.style.stroke, "#0155FB")
        XCTAssertEqual(image.style.fill, "#FFE3E3")
        XCTAssertEqual(image.style.strokeWidth, 6)
        XCTAssertEqual(image.style.opacity, 0.5)
        XCTAssertEqual(image.style.dash, [6, 4])
        XCTAssertEqual(image.style.rotation, 15)
    }

    func testEncodesFlatBesideTheStyleFields() throws {
        let blobID = Self.uniqueBlobID()
        let element = BoardElement.image(ImageElement(
            id: "i2", x: 5, y: 6, width: 40, height: 30, blobId: blobID
        ))

        let data = try JSONEncoder().encode(element)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "image")
        XCTAssertEqual(json["blob_id"] as? String, blobID)
        XCTAssertNil(json["blobId"], "the wire key is snake_case")
        XCTAssertEqual(json["width"] as? Double, 40)
        XCTAssertEqual(json["height"] as? Double, 30)
        XCTAssertEqual(json["stroke_width"] as? Double, 4, "style rides beside the geometry")
        XCTAssertNil(json["style"], "the wire element is flat, never nested")
        XCTAssertEqual(try JSONDecoder().decode(BoardElement.self, from: data), element)
    }

    func testAnUnknownKindBesideAnImageCostsOnlyItsOwnElement() throws {
        let json = """
        {"upserts":[
          {"id":"i1","kind":"image","x":0,"y":0,"width":10,"height":10,
           "blob_id":"sha256:\(String(repeating: "cd", count: 32))",
           "role":"content","stroke":"#0A0A0A","fill":"transparent",
           "stroke_width":4,"opacity":1,"dash":[],"rotation":0},
          {"id":"h1","kind":"hologram","depth":3}
        ],"deletes":[],"replace_all":false}
        """
        let update = try JSONDecoder().decode(BoardSceneUpdate.self, from: Data(json.utf8))

        XCTAssertEqual(update.upserts.map(\.id), ["i1"])
    }

    // MARK: - The store

    func testRenderTurnsDownloadedBytesIntoABitmap() async throws {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let store = BoardImageStore()
        let bytes = Self.pngData(width: 6, height: 4)
        store.loaderForTesting = { _ in bytes }

        let bitmap = await store.render(element: Self.element(blobID))

        let image = try XCTUnwrap(bitmap)
        XCTAssertGreaterThan(image.width, 0)
        // The decode bounds a picture and never enlarges one, so a source this
        // small comes through as it is.
        XCTAssertLessThanOrEqual(image.width, 6)
        XCTAssertLessThanOrEqual(image.height, 4)
        XCTAssertNotNil(store.artifact(for: Self.element(blobID)), "a ready blob is served synchronously")
    }

    /// The download is the expensive half and the bytes are content-addressed,
    /// so a blob is fetched once per device rather than once per launch. A
    /// second store — a relaunch, as far as the disk is concerned — must find
    /// the picture without any loader at all.
    func testTheDiskCacheServesASecondStoreWithNoLoader() async throws {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let first = BoardImageStore()
        first.loaderForTesting = { _ in Self.pngData(width: 5, height: 5) }
        _ = await first.render(element: Self.element(blobID))

        let second = BoardImageStore()
        second.loaderForTesting = { _ in
            XCTFail("the disk cache is checked before anything is fetched")
            return nil
        }
        let bitmap = await second.render(element: Self.element(blobID))

        XCTAssertNotNil(bitmap)
        let url = try XCTUnwrap(BoardImageStore.cacheFileURL(forBlobID: blobID))
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: url.path),
            "the bytes are on disk under the digest"
        )
        XCTAssertEqual(url.lastPathComponent, String(blobID.dropFirst("sha256:".count)))
    }

    /// Bytes that are not a picture are the blob answering wrongly, and it will
    /// answer the same way next time. Recorded as done — `BoardMathStore`'s rule
    /// for LaTeX that does not parse — so a scene install does not re-fetch the
    /// same unusable blob for the rest of the session.
    func testBytesThatAreNotAPictureFailClosed() async {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let store = BoardImageStore()
        store.loaderForTesting = { _ in Data("<html>404, in prose</html>".utf8) }

        let refused = await store.render(element: Self.element(blobID))

        XCTAssertNil(refused)
        XCTAssertNil(store.artifact(for: Self.element(blobID)))

        // And the key stays refused even once a loader would answer properly.
        store.loaderForTesting = { _ in Self.pngData() }
        let retried = await store.render(element: Self.element(blobID))
        XCTAssertNil(retried, "a refused blob is not fetched again")
    }

    /// The opposite rule, and the one `BoardSVGCache` had to learn: a failure
    /// that came from the *transport* says nothing about the blob. Poisoning
    /// the key on it would leave a picture missing until the app restarted,
    /// because an iPad that was offline for a moment is the ordinary case.
    func testATransportFailureLeavesTheBlobRetryable() async throws {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let store = BoardImageStore()
        store.loaderForTesting = { _ in nil }

        let failed = await store.render(element: Self.element(blobID))
        XCTAssertNil(failed)

        store.loaderForTesting = { _ in Self.pngData(width: 3, height: 3) }
        let bitmap = await store.render(element: Self.element(blobID))

        XCTAssertNotNil(bitmap, "the next attempt is allowed to succeed")
    }

    /// A key whose shape is wrong never becomes a filename and never becomes a
    /// request. `GET /v1/blobs/{key}` builds a filesystem path from this string
    /// on the server and rejects anything that is not `sha256:` plus 64 hex
    /// characters before it does (`server/app/api/sessions.py`); the same rule
    /// holds here, where the string would name a file in the Caches directory.
    func testAMalformedBlobKeyIsNeverFetchedAndNeverNamesAFile() async {
        let malformedKeys = [
            "",
            "../../etc/passwd",
            "sha256:",
            "sha256:abc",
            "sha256:" + String(repeating: "A", count: 64),
            "md5:" + String(repeating: "0", count: 64),
        ]
        for malformed in malformedKeys {
            let store = BoardImageStore()
            store.loaderForTesting = { _ in
                XCTFail("a malformed key must not reach the loader: \(malformed)")
                return nil
            }
            let element = ImageElement(id: "bad", x: 0, y: 0, width: 10, height: 10, blobId: malformed)

            let bitmap = await store.render(element: element)

            XCTAssertNil(bitmap, malformed)
            XCTAssertNil(BoardImageStore.cacheFileURL(forBlobID: malformed), malformed)
        }
    }

    func testAReadyBitmapAnnouncesItself() async {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let store = BoardImageStore()
        store.loaderForTesting = { _ in Self.pngData() }
        let announced = expectation(forNotification: .boardSceneArtifactReady, object: nil)

        let bitmap = await store.render(element: Self.element(blobID))
        XCTAssertNotNil(bitmap)

        await fulfillment(of: [announced], timeout: 2)
    }

    func testPrepareSchedulesEveryImageInTheScene() async {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let store = BoardImageStore()
        store.loaderForTesting = { _ in Self.pngData() }
        let scene = BoardScene(elements: [
            .image(Self.element(blobID)),
            .circle(CircleElement(id: "c", cx: 0, cy: 0, radius: 5)),
        ])

        store.prepare(scene: scene)

        // `render` joins the download `prepare` already started rather than
        // starting a second one, so a bitmap here proves the scheduling.
        let bitmap = await store.render(element: Self.element(blobID))
        XCTAssertNotNil(bitmap)
    }

    // MARK: - Residency

    /// A photograph is the one thing a board element can carry that is measured
    /// in tens of megabytes, and the frame it is drawn into is a few hundred
    /// points wide. The decode bounds it by what the board can ever show — the
    /// frame's longest side, times the largest zoom bucket, times the screen
    /// scale — so the full-size bitmap is never allocated at all.
    func testALargePictureIsDownsampledToWhatTheFrameCanShow() async throws {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let element = ImageElement(id: "photo", x: 0, y: 0, width: 30, height: 20, blobId: blobID)
        let store = BoardImageStore()
        store.loaderForTesting = { _ in Self.pngData(width: 1_200, height: 900) }

        let rendered = await store.render(element: element)

        let bitmap = try XCTUnwrap(rendered)
        let bound = BoardImageStore.maxPixelSize(for: element)
        XCTAssertLessThanOrEqual(bound, 30 * 4 * 3, "the bound follows the frame, not the source")
        XCTAssertLessThanOrEqual(max(bitmap.width, bitmap.height), bound)
        XCTAssertLessThan(bitmap.width, 1_200, "the source is not held at its own size")
        XCTAssertGreaterThan(bitmap.width, 0)
    }

    /// Eviction under the byte cap must cost a decode, never the picture: the
    /// bytes are still on disk, so the next request re-reads them locally and
    /// the network is not touched again.
    func testAnEvictedPictureIsDecodedAgainFromDiskAndNotRefetched() async throws {
        let first = Self.uniqueBlobID()
        let second = Self.uniqueBlobID()
        defer { cleanUp(first) }
        defer { cleanUp(second) }
        // One byte of budget: every decode but the newest is evicted.
        let store = BoardImageStore(byteLimit: 1)
        store.loaderForTesting = { _ in Self.pngData(width: 8, height: 8) }

        let firstBitmap = await store.render(element: Self.element(first))
        let secondBitmap = await store.render(element: Self.element(second))
        XCTAssertNotNil(firstBitmap)
        XCTAssertNotNil(secondBitmap)
        XCTAssertNil(
            store.artifact(for: Self.element(first)),
            "the older picture was evicted to stay under the cap"
        )

        store.loaderForTesting = { _ in
            XCTFail("an evicted picture is re-decoded from disk, never fetched again")
            return nil
        }
        let recovered = await store.render(element: Self.element(first))

        XCTAssertNotNil(recovered)
    }

    /// The cap is a real cap: two pictures never both stay resident when one of
    /// them alone is over budget.
    func testResidentBytesStayUnderTheCap() async {
        let first = Self.uniqueBlobID()
        let second = Self.uniqueBlobID()
        defer { cleanUp(first) }
        defer { cleanUp(second) }
        let store = BoardImageStore(byteLimit: 1)
        store.loaderForTesting = { _ in Self.pngData(width: 8, height: 8) }

        _ = await store.render(element: Self.element(first))
        let afterOne = store.artifactBytesForTesting
        _ = await store.render(element: Self.element(second))

        XCTAssertGreaterThan(afterOne, 0)
        XCTAssertEqual(store.artifactBytesForTesting, afterOne, "one picture at a time")
    }

    /// A refused blob is refused for good, and eviction does not launder it:
    /// nothing is on disk for it, so a draw that misses schedules nothing.
    func testARefusedBlobIsNotRescheduledByADraw() async {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let store = BoardImageStore()
        store.loaderForTesting = { _ in Data("not a picture".utf8) }
        _ = await store.render(element: Self.element(blobID))

        store.loaderForTesting = { _ in
            XCTFail("a refused blob is never fetched again")
            return nil
        }
        XCTAssertNil(store.artifact(for: Self.element(blobID)))
        let retried = await store.render(element: Self.element(blobID))

        XCTAssertNil(retried)
    }

    // MARK: - Bounds and drawing

    /// The frame is the whole of it, before and after the bytes arrive. Unlike
    /// `math_text`, an image that has not downloaded still has a rectangle: the
    /// model placed it, and the layout it belongs to has to be visible while
    /// the picture is on its way.
    func testBoundsAreTheFrameEvenBeforeTheBitmapLands() {
        let element = ImageElement(
            id: "unfetched", x: 40, y: 60, width: 120, height: 80, blobId: Self.uniqueBlobID()
        )

        let bounds = BoardSceneRenderer.bounds(
            of: .image(element),
            boardOrigin: CGPoint(x: 1_000, y: 500)
        )

        XCTAssertEqual(bounds, CGRect(x: 1_040, y: 560, width: 120, height: 80))
    }

    func testThePlaceholderPaintsInsideTheFrameWhileTheBlobIsMissing() throws {
        let element = ImageElement(
            id: "pending", x: 0, y: 0, width: 60, height: 40, blobId: Self.uniqueBlobID()
        )

        let inked = try Self.inkedPixels(
            scene: BoardScene(elements: [.image(element)]),
            drawingRect: CGRect(x: -10, y: -10, width: 80, height: 60)
        )

        XCTAssertTrue(inked, "an image on its way still shows the learner where it will be")
    }

    func testTheDownloadedBitmapReachesTheCanvas() async throws {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let element = ImageElement(id: "drawn", x: 0, y: 0, width: 60, height: 40, blobId: blobID)
        BoardImageStore.shared.loaderForTesting = { _ in Self.pngData(width: 8, height: 8) }
        let bitmap = await BoardImageStore.shared.render(element: element)
        XCTAssertNotNil(bitmap)

        let inked = try Self.inkedPixels(
            scene: BoardScene(elements: [.image(element)]),
            drawingRect: CGRect(x: -10, y: -10, width: 80, height: 60)
        )

        XCTAssertTrue(inked, "the downloaded bitmap must reach the drawing context")
    }

    // MARK: - The raster cache

    /// The stale-placeholder hazard in its image form. `RasterKey` holds the
    /// element value, and an `image` element is byte-identical before and after
    /// its blob lands, so a cached placeholder would be served for the rest of
    /// the session — a grey rectangle over a picture that already exists.
    func testAPlaceholderIsDrawnButNeverCached() {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let view = Self.makeView()
        // Nothing ever lands, so the element holds its placeholder throughout.
        BoardImageStore.shared.loaderForTesting = { _ in nil }

        view.scene = BoardScene(elements: [
            .image(ImageElement(id: "pending", x: 100, y: 100, width: 60, height: 40, blobId: blobID))
        ])

        XCTAssertEqual(view.mountedElementIdsForTesting, ["pending"], "the frame is mounted meanwhile")
        XCTAssertNil(view.mountedRasterForTesting(id: "pending"))
        XCTAssertEqual(view.rasterCacheBytesForTesting, 0, "no placeholder is ever stored")
    }

    func testTheRealBitmapIsCached() async {
        let blobID = Self.uniqueBlobID()
        defer { cleanUp(blobID) }
        let view = Self.makeView()
        let element = ImageElement(id: "ready", x: 100, y: 100, width: 60, height: 40, blobId: blobID)
        BoardImageStore.shared.loaderForTesting = { _ in Self.pngData(width: 8, height: 8) }
        let bitmap = await BoardImageStore.shared.render(element: element)
        XCTAssertNotNil(bitmap)

        view.scene = BoardScene(elements: [.image(element)])

        XCTAssertNotNil(view.mountedRasterForTesting(id: "ready"))
        XCTAssertGreaterThan(view.rasterCacheBytesForTesting, 0)
    }

    // MARK: - The seed fixture

    func testFixtureCoversTheImageKind() throws {
        let images = E2ESeedFixture.scene().elements.compactMap { element -> ImageElement? in
            if case .image(let value) = element { return value }
            return nil
        }

        XCTAssertEqual(images.count, 1)
        let image = try XCTUnwrap(images.first)
        XCTAssertNotNil(
            BoardImageStore.cacheFileURL(forBlobID: image.blobId),
            "the fixture's key has the shape a real blob key has"
        )
        XCTAssertGreaterThan(image.width, 0)
        XCTAssertGreaterThan(image.height, 0)
    }

    // MARK: - Helpers

    /// Leaves neither a downloaded file in the simulator's Caches directory nor
    /// a loader on the shared store, whichever of the two a test used.
    private func cleanUp(_ blobID: String) {
        if let url = BoardImageStore.cacheFileURL(forBlobID: blobID) {
            try? FileManager.default.removeItem(at: url)
        }
        BoardImageStore.shared.loaderForTesting = nil
    }

    private static func makeView() -> BoardSceneLayerView {
        let view = BoardSceneLayerView(frame: CGRect(x: 0, y: 0, width: 1_000, height: 800))
        view.boardOrigin = .zero
        return view
    }

    private static func element(_ blobID: String) -> ImageElement {
        ImageElement(id: "i", x: 0, y: 0, width: 60, height: 40, blobId: blobID)
    }

    /// A fresh key per test, so a run never inherits a blob a previous run left
    /// on disk — which is exactly what the disk-cache test would otherwise
    /// mistake for its own write.
    private static func uniqueBlobID() -> String {
        let hex = (0..<64).map { _ in "0123456789abcdef".randomElement()! }
        return "sha256:" + String(hex)
    }

    private static func pngData(width: Int = 4, height: Int = 4) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let size = CGSize(width: CGFloat(width), height: CGFloat(height))
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        return image.pngData()!
    }

    /// Whether the scene put anything at all on the white canvas — the same
    /// probe `BoardMathElementTests` uses for typeset notation.
    private static func inkedPixels(scene: BoardScene, drawingRect: CGRect) throws -> Bool {
        let data = try XCTUnwrap(BoardSceneRenderer.renderPNG(
            scene: scene,
            drawingRect: drawingRect,
            boardOrigin: .zero
        ))
        let cgImage = try XCTUnwrap(UIImage(data: data)?.cgImage)
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
        return stride(from: 0, to: pixels.count, by: 4).contains { index in
            pixels[index] < 250 || pixels[index + 1] < 250 || pixels[index + 2] < 250
        }
    }
}
