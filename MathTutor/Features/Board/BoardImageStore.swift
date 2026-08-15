import CoreGraphics
import Foundation
import UIKit

/// The bitmaps behind the board's `image` elements: one download per blob per
/// device, kept on disk, served synchronously to the renderer.
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
/// there, or bytes that are not a picture, is recorded as done: it will answer
/// the same way on the next scene install, and retrying would re-fetch the same
/// unusable blob every turn. That is `BoardMathStore`'s rule for LaTeX that does
/// not parse. A failure that came from the *transport* — offline, a timeout, a
/// 5xx — says nothing about the blob and leaves the key retryable, which is the
/// rule `BoardSVGCache` had to learn: an iPad that lost the network for a
/// moment must not lose the picture until the app restarts.
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

    /// The one algorithm `server/app/tutor/board_scene.py` and
    /// `GET /v1/blobs/{key}` both accept.
    private nonisolated static let digestPrefix = "sha256:"
    private nonisolated static let hexadecimal = Set("0123456789abcdef")
    private nonisolated static let digestLength = 64
    private nonisolated static let cacheDirectoryName = "BoardImages"

    private var artifacts: [String: CGImage] = [:]
    private var completed: Set<String> = []
    private var inFlight: [String: Task<CGImage?, Never>] = [:]

    /// The blob key, and nothing else.
    ///
    /// Unlike `BoardSVGCache`'s, this key carries no size: the frame is the
    /// element's layout, not the picture's resolution, and the same blob drawn
    /// into two different frames is still one download and one bitmap. The
    /// renderer scales it into whatever rectangle the model asked for.
    static func cacheKey(for element: ImageElement) -> String { element.blobId }

    /// Ensures every `image` element in a scene has a download scheduled.
    /// Called when a scene is installed, including restored scenes on relaunch.
    func prepare(scene: BoardScene) {
        for element in scene.elements {
            if case .image(let image) = element {
                prepare(imageElement: image)
            }
        }
    }

    func prepare(imageElement element: ImageElement) {
        let key = Self.cacheKey(for: element)
        guard !completed.contains(key), inFlight[key] == nil else { return }
        schedule(blobID: element.blobId, key: key)
    }

    func artifact(for element: ImageElement) -> CGImage? {
        artifacts[Self.cacheKey(for: element)]
    }

    /// Fetches (or awaits an in-flight fetch) and returns the ready bitmap.
    /// Used by tests and capture paths that need the picture composited rather
    /// than merely scheduled.
    @discardableResult
    func render(element: ImageElement) async -> CGImage? {
        let key = Self.cacheKey(for: element)
        if let artifact = artifacts[key] { return artifact }
        if let task = inFlight[key] {
            return await task.value
        }
        if completed.contains(key) { return nil }
        return await schedule(blobID: element.blobId, key: key).value
    }

    @discardableResult
    private func schedule(blobID: String, key: String) -> Task<CGImage?, Never> {
        let task = Task { @MainActor [weak self] () -> CGImage? in
            guard let self else { return nil }
            let outcome = await self.load(blobID: blobID)
            self.inFlight[key] = nil
            let bitmap: CGImage?
            switch outcome {
            case .bitmap(let image):
                self.completed.insert(key)
                self.artifacts[key] = image
                bitmap = image
            case .refused:
                // Fail closed, and stay closed. `artifact(for:)` keeps
                // answering nil, so the element holds its placeholder rather
                // than fetching the same unusable blob on every scene install.
                self.completed.insert(key)
                bitmap = nil
            case .retry:
                self.completed.remove(key)
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
        /// There is nothing usable at this key, and there will not be.
        case refused
        /// The attempt failed for a reason that says nothing about the blob.
        case retry
    }

    private func load(blobID: String) async -> Outcome {
        guard let digest = Self.digest(ofBlobID: blobID) else { return .refused }
        switch await fetch(blobID: blobID, digest: digest) {
        case .unavailable:
            return .refused
        case .transient:
            return .retry
        case .bytes(let data, let fromDisk):
            guard let bitmap = Self.decode(data) else {
                guard fromDisk else { return .refused }
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

    /// What one attempt to get a blob's *bytes* came back with.
    private enum Fetch: Sendable {
        /// The bytes, and whether they came from the disk cache — which is what
        /// decides whether they are written back to it.
        case bytes(Data, fromDisk: Bool)
        case unavailable
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
                return http.statusCode >= 500 ? .transient : .unavailable
            }
            return .bytes(data, fromDisk: false)
        } catch {
            // Offline, timed out, TLS refused: the transport, not the blob.
            return .transient
        }
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
        // object rather than a re-encoding of it.
        try? data.write(to: directory.appendingPathComponent(digest), options: .atomic)
    }

    private nonisolated static func removeCachedBytes(digest: String) async {
        guard let url = cacheDirectory()?.appendingPathComponent(digest) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// Bytes to a bitmap, upright.
    ///
    /// EXIF orientation is a property of the `UIImage`, not of the bitmap
    /// underneath it, and the board draws the bitmap — so a photograph taken
    /// sideways would land on the board sideways. The server never re-encodes a
    /// fetched picture (`app/tutor/fetch_image.py` reads the header and stops),
    /// so the tag arrives intact and is resolved here, once, rather than by
    /// every path that draws.
    private static func decode(_ data: Data) -> CGImage? {
        guard !data.isEmpty, let image = UIImage(data: data),
              image.size.width > 0, image.size.height > 0
        else { return nil }
        guard image.imageOrientation != .up else { return image.cgImage }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let upright = UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
        return upright.cgImage
    }
}
