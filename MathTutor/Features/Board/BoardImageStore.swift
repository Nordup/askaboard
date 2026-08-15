import CoreGraphics
import Foundation
import ImageIO
import OSLog
import UIKit

/// The bitmaps behind the board's `image` elements: one download per blob per
/// device, kept on disk, decoded to the size the board can actually show, and
/// served synchronously to the renderer.
///
/// The bookkeeping is `BoardMathStore`'s — a ready artifact read synchronously,
/// missing ones scheduled when a scene is installed, `.boardSceneArtifactReady`
/// when one lands — because the layer view already knows that shape and this is
/// the third subsystem to need it. What is new here is that the work is *remote
/// and repeatable*: the same blob key appears in every scene the model rewrites
/// for the rest of the session, and the same blob key appears again next week.
/// So the bytes are cached under their own digest in the Caches directory, and
/// the disk is consulted before anything is fetched.
///
/// **Two kinds of failure, and they must not be confused.** A blob that is not
/// there, or bytes that are not a picture, is refused permanently: it will
/// answer the same way on the next scene install, and retrying would re-fetch
/// the same unusable blob every turn. That is `BoardMathStore`'s rule for LaTeX
/// that does not parse. A failure that came from the *transport* — offline, a
/// timeout, a 5xx — says nothing about the blob and is not recorded at all,
/// which is the rule `BoardSVGCache` had to learn: an iPad that lost the
/// network for a moment must not lose the picture until the app restarts.
///
/// **Nothing here is held at the size it arrived in.** A photograph is the one
/// thing a board element can carry that is measured in tens of megabytes, and
/// the frame it is drawn into is a few hundred points wide. Blobs are decoded
/// through ImageIO's thumbnail path, off the main actor, to the largest size
/// the board can ever show them at, and what survives that is held under a byte
/// cap. An evicted picture is not lost: its bytes are still on disk, and the
/// next draw schedules the decode again.
@MainActor
final class BoardImageStore {
    static let shared = BoardImageStore()

    /// Stands in for the whole network layer, and only for tests.
    ///
    /// It replaces the fetch, never the disk: the cache is consulted first, so
    /// a stub loader proves the disk short-circuit by never being called. A
    /// `nil` result is a *transport* failure — the loader is the network, and a
    /// network that returned no bytes has said nothing about the blob.
    var loaderForTesting: ((String) async -> Data?)?

    /// How long one blob download may take. Longer than a plain request: a
    /// photograph can be several megabytes over a school's Wi-Fi. Still finite,
    /// because the element draws a placeholder in the meantime and a download
    /// that never ends would hold that placeholder forever.
    nonisolated static let timeout: TimeInterval = 30

    /// The longest side any decoded blob may have, whatever frame asked for it.
    ///
    /// The same ceiling `BoardSceneLayerView.maximumRasterSide` puts on the
    /// tile a picture is drawn into — the largest 2D texture the GPUs this
    /// ships on can hold — so a bitmap larger than this could not be composited
    /// even if something wanted it.
    nonisolated static let maximumDecodedSide = 4_096

    /// The resident budget for decoded pictures, in bytes.
    ///
    /// Priced the way `BoardRasterCache` prices its tiles, and for the same
    /// reason: a board full of photographs must degrade into re-decoding, never
    /// into memory pressure. 64 MB is roughly eight full-screen pictures at the
    /// maximum zoom bucket, which is far more than one scene shows at once.
    private let byteLimit: Int

    private static let log = Logger(subsystem: "com.nordup.MathTutor", category: "board-image")

    /// One decoded picture, and the budget it was decoded for.
    ///
    /// The budget is the *requested* longest side, not the bitmap's own: a
    /// small source image decodes smaller than asked, and recording what it
    /// produced would make every later pass believe the picture was still too
    /// coarse and decode it again forever.
    private struct Artifact {
        let image: CGImage
        let maxPixelSize: Int
    }

    private var artifacts: [String: Artifact] = [:]
    /// Least recently used first — `BoardRasterCache`'s array, at this scale.
    private var order: [String] = []
    private var totalBytes = 0
    /// Keys that will never produce a picture. Nothing is retried for these.
    private var refused: Set<String> = []
    /// Keys whose bytes are believed to be on disk right now.
    ///
    /// This is what makes an eviction recoverable without a scene change: a
    /// draw that misses re-schedules the decode only for a key in here, so the
    /// re-read is local and certain. A key is dropped from it the moment a load
    /// for it fails, which is what keeps a draw → schedule → fail → notify →
    /// draw cycle from becoming an unbounded retry loop.
    private var cached: Set<String> = []
    private var inFlight: [String: Task<CGImage?, Never>] = [:]

    init(byteLimit: Int = 64 * 1024 * 1024) {
        self.byteLimit = byteLimit
    }

    var artifactBytesForTesting: Int { totalBytes }

    /// The blob key, and nothing else.
    ///
    /// Unlike `BoardSVGCache`'s, this key carries no size: the frame is the
    /// element's layout, not the picture's resolution, and the same blob drawn
    /// into two different frames is still one download and one bitmap. What the
    /// frame does decide is the decode budget, which travels beside the bitmap
    /// rather than in its key — a second element asking for the same blob in a
    /// larger frame upgrades the one artifact instead of forking it.
    static func cacheKey(for element: ImageElement) -> String { element.blobId }

    /// The longest side, in pixels, a blob is decoded to for one element.
    ///
    /// The frame is the element's size in board points; the board zooms to
    /// `ZoomBucket.maxBucket` and the screen is 2x, so that product is the most
    /// any pixel of this picture can ever be asked to cover. Beyond it a larger
    /// bitmap is invisible and merely resident — a 12-megapixel photograph in a
    /// 180x120 frame is tens of megabytes held to show 1,440 pixels across.
    static func maxPixelSize(for element: ImageElement) -> Int {
        let longestSide = max(element.width, element.height)
        let scale = UITraitCollection.current.displayScale
        let displayScale = scale > 0 ? scale : 2
        let target = longestSide * ZoomBucket.scale(forBucket: ZoomBucket.maxBucket) * displayScale
        guard target.isFinite, target > 0 else { return 1 }
        return min(maximumDecodedSide, max(1, Int(target.rounded(.up))))
    }

    /// Ensures every `image` element in a scene has a download scheduled.
    /// Called when a scene is installed, including restored scenes on relaunch.
    /// This is also the retry point for a blob whose last attempt failed in
    /// transport.
    func prepare(scene: BoardScene) {
        for element in scene.elements {
            if case .image(let image) = element {
                prepare(imageElement: image)
            }
        }
    }

    func prepare(imageElement element: ImageElement) {
        let key = Self.cacheKey(for: element)
        guard !refused.contains(key), inFlight[key] == nil else { return }
        let maxPixelSize = Self.maxPixelSize(for: element)
        // A picture already decoded for a frame at least this large is done. A
        // smaller one is upgraded: the model can re-place the same blob bigger,
        // and a scene install is the only moment a frame can change.
        if let existing = artifacts[key], existing.maxPixelSize >= maxPixelSize { return }
        schedule(blobID: element.blobId, key: key, maxPixelSize: maxPixelSize)
    }

    /// The synchronous read the renderer draws from.
    ///
    /// A miss also *schedules* — but only for a blob whose bytes are already on
    /// disk, which is exactly the artifact this store evicted under its byte
    /// cap. Without that, a picture pushed out of memory would show its
    /// placeholder until something replaced the whole scene.
    func artifact(for element: ImageElement) -> CGImage? {
        let key = Self.cacheKey(for: element)
        if let existing = artifacts[key] {
            touch(key)
            return existing.image
        }
        if cached.contains(key) {
            prepare(imageElement: element)
        }
        return nil
    }

    /// Fetches (or awaits an in-flight fetch) and returns the ready bitmap.
    /// Used by tests and capture paths that need the picture composited rather
    /// than merely scheduled.
    @discardableResult
    func render(element: ImageElement) async -> CGImage? {
        let key = Self.cacheKey(for: element)
        let maxPixelSize = Self.maxPixelSize(for: element)
        if let existing = artifacts[key], existing.maxPixelSize >= maxPixelSize {
            touch(key)
            return existing.image
        }
        if let task = inFlight[key] {
            return await task.value
        }
        if refused.contains(key) { return nil }
        let bitmap = await schedule(
            blobID: element.blobId, key: key, maxPixelSize: maxPixelSize
        ).value
        // A failed *upgrade* still leaves the coarser picture standing, and a
        // caller that already had one must not be told there is none: this
        // method and `artifact(for:)` answer the same question.
        return bitmap ?? artifacts[key]?.image
    }

    @discardableResult
    private func schedule(
        blobID: String,
        key: String,
        maxPixelSize: Int
    ) -> Task<CGImage?, Never> {
        let task = Task { @MainActor [weak self] () -> CGImage? in
            guard let self else { return nil }
            let outcome = await self.load(blobID: blobID, maxPixelSize: maxPixelSize)
            self.inFlight[key] = nil
            let bitmap: CGImage?
            switch outcome {
            case .bitmap(let image):
                self.cached.insert(key)
                self.store(image, maxPixelSize: maxPixelSize, for: key)
                bitmap = image
            case .refused(let reason):
                // Fail closed, and stay closed. `artifact(for:)` keeps
                // answering nil, so the element holds its placeholder rather
                // than fetching the same unusable blob on every scene install.
                // Said out loud once, because a picture that never appears is
                // otherwise indistinguishable from one that is still loading.
                Self.log.error(
                    "board image refused: \(reason, privacy: .public) key=\(Self.keyPrefix(blobID), privacy: .public)"
                )
                self.refused.insert(key)
                self.cached.remove(key)
                bitmap = nil
            case .retry:
                // Nothing is recorded about a key that failed in transport, so
                // the next scene install is free to try it again. `cached` is
                // the one thing that must be cleared: a draw re-schedules from
                // it, and leaving it set would turn one failure into a loop of
                // them through `.boardSceneArtifactReady`.
                self.cached.remove(key)
                bitmap = nil
            }
            NotificationCenter.default.post(name: .boardSceneArtifactReady, object: nil)
            return bitmap
        }
        inFlight[key] = task
        return task
    }

    /// What one attempt to get a blob came back with.
    private enum Outcome {
        case bitmap(CGImage)
        /// There is nothing usable at this key, and there will not be. The
        /// string is why, for the log.
        case refused(String)
        /// The attempt failed for a reason that says nothing about the blob.
        case retry
    }

    private func load(blobID: String, maxPixelSize: Int) async -> Outcome {
        guard let digest = Self.digest(ofBlobID: blobID) else {
            return .refused("blob key is not sha256 plus 64 hexadecimal characters")
        }
        switch await fetch(blobID: blobID, digest: digest) {
        case .unavailable(let reason):
            return .refused(reason)
        case .transient:
            return .retry
        case .bytes(let data, let fromDisk):
            // Off the main actor: ImageIO decodes the whole picture to produce
            // the thumbnail, and a 12-megapixel source is tens of milliseconds
            // of work that would otherwise land in the middle of a frame. The
            // SVG parse takes the same escape.
            let decoded = await Task.detached(priority: .userInitiated) {
                DecodedImage(image: Self.decode(data, maxPixelSize: maxPixelSize))
            }.value
            guard let bitmap = decoded.image else {
                guard fromDisk else { return .refused("bytes are not a picture") }
                // Bytes on disk that no longer decode are a truncated write or
                // a corrupted cache, not a blob that is not a picture. Drop the
                // file so the next attempt fetches it again, instead of serving
                // one bad write for the life of the installation.
                await Self.removeCachedBytes(digest: digest)
                return .retry
            }
            if !fromDisk {
                await Self.writeCachedBytes(data, digest: digest)
            }
            return .bitmap(bitmap)
        }
    }

    /// A decoded bitmap on its way back from the decode task.
    ///
    /// `CGImage` is immutable once created and this one is not referenced again
    /// by the task that made it, so handing it across is safe; the box says so
    /// explicitly rather than relying on how the CoreGraphics overlay happens
    /// to be annotated in a given SDK.
    private struct DecodedImage: @unchecked Sendable {
        let image: CGImage?
    }

    /// What one attempt to get a blob's *bytes* came back with.
    private enum Fetch: Sendable {
        /// The bytes, and whether they came from the disk cache — which is what
        /// decides whether they are written back to it.
        case bytes(Data, fromDisk: Bool)
        case unavailable(String)
        case transient
    }

    private func fetch(blobID: String, digest: String) async -> Fetch {
        if let cached = await Self.readCachedBytes(digest: digest) {
            return .bytes(cached, fromDisk: true)
        }
        if let loaderForTesting {
            guard let data = await loaderForTesting(blobID) else { return .transient }
            return .bytes(data, fromDisk: false)
        }
        // A build with no token cannot reach the backend at all. Transient
        // rather than refused: nothing was learned about the blob, and the
        // scene install that follows a real configuration must be free to try.
        guard let configuration = BackendConfiguration.load() else { return .transient }
        return await Self.download(blobID: blobID, configuration: configuration)
    }

    /// `GET {baseURL}/v1/blobs/{key}` under the device bearer token — the same
    /// address and the same credential every other call in `Services` uses,
    /// through `BackendConfiguration` rather than a second client of its own.
    ///
    /// `nonisolated`, so the download runs off the main actor: a Swift 6
    /// `nonisolated async` function does not inherit its caller's executor, and
    /// several megabytes should not arrive through the thread that is drawing
    /// the board.
    private nonisolated static func download(
        blobID: String,
        configuration: BackendConfiguration
    ) async -> Fetch {
        var request = URLRequest(
            url: configuration.baseURL.appendingPathComponent("v1/blobs/\(blobID)")
        )
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .transient }
            guard (200..<300).contains(http.statusCode) else {
                // 404 is the ordinary refusal — a key naming a blob the store
                // does not have, which `board_scene.py` deliberately does not
                // check when it parses the tool call — and it will name nothing
                // next time either. A 5xx is the server having a bad minute and
                // says nothing about the blob.
                return http.statusCode >= 500
                    ? .transient
                    : .unavailable("HTTP \(http.statusCode)")
            }
            return .bytes(data, fromDisk: false)
        } catch {
            // Offline, timed out, TLS refused: the transport, not the blob.
            return .transient
        }
    }

    // MARK: - Residency

    private func store(_ image: CGImage, maxPixelSize: Int, for key: String) {
        if let old = artifacts[key] { totalBytes -= Self.cost(of: old.image) }
        artifacts[key] = Artifact(image: image, maxPixelSize: maxPixelSize)
        totalBytes += Self.cost(of: image)
        touch(key)
        // `order.count > 1` keeps the picture that was just decoded even when
        // it alone is over the cap: one large photograph still draws from
        // memory rather than being decoded again on every frame.
        while totalBytes > byteLimit, let victim = order.first, order.count > 1 {
            order.removeFirst()
            if let evicted = artifacts.removeValue(forKey: victim) {
                totalBytes -= Self.cost(of: evicted.image)
            }
        }
    }

    private func touch(_ key: String) {
        if let index = order.firstIndex(of: key) { order.remove(at: index) }
        order.append(key)
    }

    private nonisolated static func cost(of image: CGImage) -> Int {
        image.bytesPerRow * image.height
    }

    // MARK: - The key

    /// The 64 hexadecimal characters a blob key names its bytes with, or `nil`
    /// when the string is not a blob key at all.
    ///
    /// This is the only gate between a scene's string and both a URL and a
    /// filename. `GET /v1/blobs/{key}` on the server builds a filesystem path
    /// from the same string and rejects on shape before it does, for exactly
    /// this reason — `../../etc/passwd` is a perfectly good `String`. Rejecting
    /// on shape is what closes it; sanitising the path is not.
    nonisolated static func digest(ofBlobID blobID: String) -> String? {
        guard blobID.hasPrefix(digestPrefix) else { return nil }
        let digest = blobID.dropFirst(digestPrefix.count)
        guard digest.count == digestLength,
              digest.allSatisfy({ hexadecimal.contains($0) })
        else { return nil }
        return String(digest)
    }

    /// Enough of a key to tell two blobs apart in a log line, and no more.
    private nonisolated static func keyPrefix(_ blobID: String) -> String {
        String(blobID.prefix(digestPrefix.count + 12))
    }

    /// Where a blob's bytes live on this device, or `nil` when the key is not
    /// one. Exposed so a test can clean up after itself.
    nonisolated static func cacheFileURL(forBlobID blobID: String) -> URL? {
        guard let digest = digest(ofBlobID: blobID) else { return nil }
        return cacheDirectory()?.appendingPathComponent(digest)
    }

    /// The Caches directory, which the system may reclaim under pressure. That
    /// is the right home for these: every file in it can be fetched again, and
    /// losing one costs a download rather than any board content.
    private nonisolated static func cacheDirectory() -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent(cacheDirectoryName, isDirectory: true)
    }

    /// The one algorithm `server/app/tutor/board_scene.py` and
    /// `GET /v1/blobs/{key}` both accept.
    private nonisolated static let digestPrefix = "sha256:"
    private nonisolated static let hexadecimal = Set("0123456789abcdef")
    private nonisolated static let digestLength = 64
    private nonisolated static let cacheDirectoryName = "BoardImages"

    // MARK: - Disk and decode

    private nonisolated static func readCachedBytes(digest: String) async -> Data? {
        guard let url = cacheDirectory()?.appendingPathComponent(digest) else { return nil }
        return try? Data(contentsOf: url)
    }

    private nonisolated static func writeCachedBytes(_ data: Data, digest: String) async {
        guard let directory = cacheDirectory() else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // The bytes exactly as they arrived, under the digest that names them:
        // the file is the blob, so a later read is the same content-addressed
        // object rather than a re-encoding of it. It is also what makes an
        // eviction cheap to undo — the decode budget can change, the bytes
        // cannot.
        try? data.write(to: directory.appendingPathComponent(digest), options: .atomic)
    }

    private nonisolated static func removeCachedBytes(digest: String) async {
        guard let url = cacheDirectory()?.appendingPathComponent(digest) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Bytes to a bitmap no larger than the board can show, upright.
    ///
    /// ImageIO's thumbnail path rather than `UIImage(data:)`, for two reasons.
    /// It bounds the result: `kCGImageSourceThumbnailMaxPixelSize` is a limit
    /// and not a target, so a small picture passes through untouched while a
    /// photograph is downsampled during the decode instead of after it — the
    /// full-size bitmap is never allocated at all. And
    /// `kCGImageSourceCreateThumbnailWithTransform` applies the EXIF
    /// orientation to the pixels, which the board needs because it draws the
    /// `CGImage` directly and a `CGImage` carries no orientation. The server
    /// never re-encodes a fetched picture (`app/tutor/fetch_image.py` reads the
    /// header and stops), so that tag arrives intact and would otherwise put a
    /// photograph on the board on its side.
    ///
    /// `ShouldCacheImmediately` forces the pixels now, on whichever thread this
    /// is running on, rather than lazily inside the first draw.
    private nonisolated static func decode(_ data: Data, maxPixelSize: Int) -> CGImage? {
        guard !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, nil)
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixelSize),
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}
