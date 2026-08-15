import CoreGraphics
import UIKit

/// The identity of one cached bitmap: the element it was drawn from, and the
/// zoom bucket it was drawn for.
///
/// The key holds the element value, not `element.hashValue`. A 64-bit hash can
/// collide between two different elements, and the cache would then serve the
/// wrong bitmap for the rest of the session. A dictionary compares with `==`
/// after the hash, so equality decides the hit and a collision costs one extra
/// comparison instead of a wrong picture.
struct RasterKey: Hashable {
    let element: BoardElement
    let bucket: Int
}

/// The discrete set of scales a board bitmap is ever rendered at.
///
/// A continuous zoom would re-rasterize on every pinch frame. Rounding the zoom
/// to a power of two lets one bitmap serve a whole octave, so a pinch crosses a
/// bucket boundary only at 2x steps. The range stops at 1/8x and 4x: below that
/// the bitmap carries no visible detail, above it the pixels cost more than the
/// redraw they save.
enum ZoomBucket {
    /// 1/8x — the smallest bitmap the board ever keeps.
    static let minBucket = -3
    /// 4x — the largest bitmap the board ever keeps.
    static let maxBucket = 2

    /// Maps any zoom factor to a bucket in `minBucket ... maxBucket`.
    ///
    /// The two comparisons clamp in the scale domain, before the logarithm.
    /// That is what makes the function total: a zero, negative, infinite or
    /// `nan` zoom never reaches `log2`, so the `Int` conversion never sees a
    /// value it cannot represent. (`nan` fails both comparisons and lands on
    /// `minBucket`.) A trap here would kill the app on one bad layout pass,
    /// and the caller is a per-frame path.
    static func bucket(forZoom zoom: CGFloat) -> Int {
        guard zoom > scale(forBucket: minBucket) else { return minBucket }
        guard zoom < scale(forBucket: maxBucket) else { return maxBucket }
        // The guards leave log2(zoom) strictly inside (minBucket, maxBucket),
        // so the rounded exponent is already in range.
        return Int(log2(zoom).rounded())
    }

    static func scale(forBucket bucket: Int) -> CGFloat {
        pow(2, CGFloat(bucket))
    }
}

/// LRU bitmap cache for rendered board elements. Byte-capped so a board full
/// of large figures degrades to re-rasterization, never to memory pressure.
@MainActor
final class BoardRasterCache {
    private let byteLimit: Int
    private var images: [RasterKey: CGImage] = [:]
    private var order: [RasterKey] = []  // most recently used last
    private(set) var totalBytes = 0

    init(byteLimit: Int = 128 * 1024 * 1024) {
        self.byteLimit = byteLimit
    }

    func image(for key: RasterKey) -> CGImage? {
        guard let image = images[key] else { return nil }
        touch(key)
        return image
    }

    func store(_ image: CGImage, for key: RasterKey) {
        if let old = images[key] { totalBytes -= cost(of: old) }
        images[key] = image
        totalBytes += cost(of: image)
        touch(key)
        // `order.count > 1` keeps the entry that was just stored even when it
        // alone is over the cap: one oversized figure still draws from cache
        // rather than re-rasterizing on every frame.
        while totalBytes > byteLimit, let victim = order.first, order.count > 1 {
            order.removeFirst()
            if let evicted = images.removeValue(forKey: victim) {
                totalBytes -= cost(of: evicted)
            }
        }
    }

    /// Drops every bitmap. The caller is the memory-warning path: each entry
    /// can be redrawn from the scene, so under pressure the whole cache is
    /// cheaper to lose than to keep.
    func removeAll() {
        images.removeAll()
        order.removeAll()
        totalBytes = 0
    }

    private func touch(_ key: RasterKey) {
        if let index = order.firstIndex(of: key) { order.remove(at: index) }
        order.append(key)
    }

    private func cost(of image: CGImage) -> Int {
        image.bytesPerRow * image.height
    }
}
