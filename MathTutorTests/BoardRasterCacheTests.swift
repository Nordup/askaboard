import UIKit
import XCTest
@testable import MathTutor

/// The raster cache is the board's bitmap memory budget. Three rules define it:
/// a stored bitmap comes back for the same key, the byte cap drops the least
/// recently used entry instead of growing without bound, and `ZoomBucket` fixes
/// the discrete set of scales a bitmap is ever rendered at.
@MainActor
final class BoardRasterCacheTests: XCTestCase {
    /// Scale 1 and the standard colour range keep the bitmap at exactly
    /// `side * side * 4` bytes, so the byte limits below stay independent of
    /// the host display's scale and gamut.
    private func makeImage(side: Int) -> CGImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        let size = CGSize(width: side, height: side)
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { $0.fill(CGRect(origin: .zero, size: size)) }.cgImage!
    }

    private func makeKey(id: String, x: CGFloat) -> RasterKey {
        RasterKey(
            element: .line(LineElement(id: id, x1: x, y1: 0, x2: x + 10, y2: 10)),
            bucket: 0
        )
    }

    func testStoreAndFetch() {
        let cache = BoardRasterCache()
        let key = makeKey(id: "l1", x: 0)
        cache.store(makeImage(side: 4), for: key)
        XCTAssertNotNil(cache.image(for: key))
    }

    func testEvictsLeastRecentlyUsedAtByteLimit() {
        let cache = BoardRasterCache(byteLimit: 4 * 64 * 64 * 2)  // room for ~two 64px images
        let first = makeKey(id: "l1", x: 0)
        let second = makeKey(id: "l2", x: 100)
        let third = makeKey(id: "l3", x: 200)
        cache.store(makeImage(side: 64), for: first)
        cache.store(makeImage(side: 64), for: second)
        _ = cache.image(for: first)  // touch the first so the second is LRU
        cache.store(makeImage(side: 64), for: third)
        XCTAssertNil(cache.image(for: second))
        XCTAssertNotNil(cache.image(for: first))
    }

    /// The memory-warning path. Every bitmap can be redrawn from the scene, so
    /// under pressure the cache drops all of them — entries and bytes both,
    /// or the byte total would keep evicting a cache that is already empty.
    func testRemoveAllDropsEveryEntryAndItsBytes() {
        let cache = BoardRasterCache()
        let key = makeKey(id: "l1", x: 0)
        cache.store(makeImage(side: 16), for: key)
        cache.store(makeImage(side: 16), for: makeKey(id: "l2", x: 100))
        cache.removeAll()
        XCTAssertNil(cache.image(for: key))
        XCTAssertEqual(cache.totalBytes, 0)
    }

    func testZoomBucketsClampToPowersOfTwo() {
        XCTAssertEqual(ZoomBucket.bucket(forZoom: 1.0), 0)
        XCTAssertEqual(ZoomBucket.bucket(forZoom: 2.0), 1)
        XCTAssertEqual(ZoomBucket.bucket(forZoom: 0.05), -3)   // clamped low
        XCTAssertEqual(ZoomBucket.bucket(forZoom: 32.0), 2)    // clamped high
        XCTAssertEqual(ZoomBucket.scale(forBucket: -3), 0.125)
        XCTAssertEqual(ZoomBucket.scale(forBucket: 2), 4)
    }

    /// `bucket(forZoom:)` runs on every pinch frame, so no zoom value may trap
    /// it. A zero, a negative, an infinity and a `nan` all have to land inside
    /// the bucket range instead of crashing the conversion to `Int`.
    func testZoomBucketIsTotalForDegenerateZoom() {
        XCTAssertEqual(ZoomBucket.bucket(forZoom: 0), ZoomBucket.minBucket)
        XCTAssertEqual(ZoomBucket.bucket(forZoom: -1), ZoomBucket.minBucket)
        XCTAssertEqual(ZoomBucket.bucket(forZoom: .nan), ZoomBucket.minBucket)
        XCTAssertEqual(ZoomBucket.bucket(forZoom: .infinity), ZoomBucket.maxBucket)
    }
}
