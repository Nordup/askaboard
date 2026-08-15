import CoreGraphics
import CryptoKit
import Foundation
import SwiftDraw
import UIKit

/// One parsed SVG document: the bitmap it was drawn into, and the size the
/// document declares for itself.
///
/// `size` is the document's own — its `width`/`height` attributes, or its
/// `viewBox` when it has none — in board points, and it is what layout uses.
/// `image` carries more pixels than that (see `BoardSVGStore.rasterOversample`)
/// and fewer for a document larger than the ceiling, so nothing outside this
/// file should read a length off the bitmap.
///
/// `@MainActor` for the reason `MathArtifact` is: a globally-isolated type is
/// implicitly `Sendable`, which is what lets one ride back from the render task
/// as a `Task`'s value.
@MainActor
struct ParsedSVG {
    let image: CGImage
    let size: CGSize

    /// Composites the figure into `rect`.
    ///
    /// `MathArtifact.draw` word for word, and for the same reason: a `CGImage`
    /// draws y-up while UIKit drawing contexts are y-down, so a figure handed
    /// straight to `context.draw` lands upside down. Whether the context is
    /// flipped is the caller's to decide *before* any rotation touches the CTM —
    /// a rotated CTM no longer reports it.
    func draw(in rect: CGRect, into context: CGContext, isFlipped: Bool) {
        guard rect.width > 0, rect.height > 0 else { return }
        context.saveGState()
        context.interpolationQuality = .high
        if isFlipped {
            context.translateBy(x: 0, y: rect.midY)
            context.scaleBy(x: 1, y: -1)
            context.translateBy(x: 0, y: -rect.midY)
        }
        context.draw(image, in: rect)
        context.restoreGState()
    }
}

/// The bitmaps behind the board's `svg` elements: one parse and one raster per
/// distinct document, served synchronously to the renderer.
///
/// The bookkeeping is `BoardMathStore`'s — a ready artifact read synchronously,
/// missing ones scheduled when a scene is installed, `.boardSceneArtifactReady`
/// when one lands — because the layer view already knows that shape. What is
/// new is the engine: SwiftDraw parses the document into Core Graphics draw
/// commands in this process, so there is no web view, no navigation, no
/// timeout, and no offscreen window between the model's markup and the board.
///
/// **The key is the markup and nothing else.** The frame the model placed a
/// figure in is layout, not resolution: the same document dropped into two
/// elements is one parse and one bitmap. That is the deliberate difference from
/// `BoardSVGCache`, whose key carried the frame and therefore rendered the same
/// figure again every time the model moved or resized it.
///
/// **Two kinds of failure, and they must not be confused.** Markup that does
/// not parse is refused permanently: SwiftDraw is deterministic, the same bytes
/// answer the same way on the next scene install, and retrying would re-parse a
/// broken document forever. That is `BoardMathStore`'s rule for LaTeX. A
/// document that parses and whose *raster* does not come back says nothing
/// about the markup — the ways to get there are allocation failures — so it is
/// not recorded at all, which is the rule `BoardSVGCache` had to learn about
/// WebKit timeouts. It is retried on the next scene install, and never from a
/// draw, so one failure cannot become a loop of them.
///
/// **Nothing is held at a size the board cannot show.** A figure may declare
/// any `viewBox` it likes, and a board element may span 25,000 points, so the
/// raster is capped on its long side. Under the cap it is *oversampled*
/// instead, because the board zooms and a 1:1 bitmap goes soft under a pinch.
/// What survives is held under a byte cap: a session where the model draws a
/// new figure every turn must degrade into re-rendering, never into memory
/// pressure. An evicted figure is not lost — the markup that made it is in the
/// element, so the next read schedules the render again.
@MainActor
final class BoardSVGStore {
    static let shared = BoardSVGStore()

    /// How many pixels are kept per board point, below the ceiling.
    ///
    /// `BoardMathStore.rasterOversample`'s reasoning, applied to figures: the
    /// board zooms to 4x on a 2x screen, a bitmap rasterized at the document's
    /// own size is soft the moment the learner pinches, and twice the linear
    /// size costs four times the pixels of a small figure and nothing that
    /// matters. It does not reach the board's maximum zoom, and deliberately:
    /// covering 8x would cost sixteen times the memory to sharpen the rarest
    /// view of a figure.
    nonisolated static let rasterOversample: CGFloat = 2

    /// The longest side, in pixels, any figure's bitmap may have.
    ///
    /// The ceiling the WebKit renderer put on its offscreen viewport, kept: a
    /// legal model frame can span most of the board, and a `viewBox` is just a
    /// number in a string the server does not police. Half of
    /// `BoardImageStore.maximumDecodedSide` because a figure is line art drawn
    /// at roughly its natural size — a photograph is pinned to a frame that can
    /// be zoomed into, a figure is not.
    nonisolated static let maximumRasterSide: CGFloat = 2_048

    /// The resident budget for figure bitmaps, in bytes.
    ///
    /// Half of `BoardImageStore`'s and a quarter of `BoardRasterCache`'s,
    /// because re-making one of these costs neither a request nor a disk read:
    /// the markup is in the scene, so an eviction is paid back in CPU alone.
    private let byteLimit: Int

    private var documents: [String: ParsedSVG] = [:]
    /// Least recently used first — `BoardRasterCache`'s array, at this scale.
    private var order: [String] = []
    private var totalBytes = 0
    /// Keys whose markup does not parse. Nothing is ever retried for these.
    private var refused: Set<String> = []
    /// Keys whose last raster did not come back, since the last scene install.
    ///
    /// This is not a refusal — it says nothing about the markup — but it does
    /// stop a *draw* from re-scheduling the work. Without it, a figure that
    /// fails to rasterize would go draw → schedule → fail → notify → draw for
    /// as long as it stayed on the board. A scene install clears the set, which
    /// is the retry point.
    private var failedRaster: Set<String> = []
    private var inFlight: [String: Task<ParsedSVG?, Never>] = [:]

    /// How many times the parse-and-raster step has actually run. Tests read it
    /// to tell "answered from the cache" from "did the work again"; nothing in
    /// the app looks at it.
    private(set) var renderPassesForTesting = 0

    /// Forces a parsed document's raster to come back unusable.
    ///
    /// The one seam in this file, and it is deliberately not a stub renderer:
    /// the real parse and the real raster still run, and the outcome is
    /// overridden afterwards, on the main actor, immediately before the
    /// bookkeeping that is under test. So the test proves what the store does
    /// with a failed raster without changing what the store does at all.
    var failsRasterForTesting = false

    init(byteLimit: Int = 32 * 1024 * 1024) {
        self.byteLimit = byteLimit
    }

    /// The markup, digested. Not the frame: see the type's note.
    static func cacheKey(for element: SVGElement) -> String {
        let digest = SHA256.hash(data: Data(element.svg.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Ensures every `svg` element in a scene has a render scheduled. Called
    /// when a scene is installed, including restored scenes on relaunch. This
    /// is also the retry point for a figure whose last raster did not come back.
    func prepare(scene: BoardScene) {
        failedRaster.removeAll()
        for element in scene.elements {
            if case .svg(let svg) = element {
                prepare(svgElement: svg)
            }
        }
    }

    func prepare(svgElement element: SVGElement) {
        let key = Self.cacheKey(for: element)
        guard !refused.contains(key), documents[key] == nil, inFlight[key] == nil else { return }
        schedule(markup: element.svg, key: key)
    }

    /// The synchronous read the renderer draws from.
    ///
    /// A miss also *schedules*, unless the markup was refused or its last raster
    /// failed. That is what makes an eviction self-healing: a figure pushed out
    /// under the byte cap would otherwise show nothing until the model next
    /// touched the board, and re-rendering it needs only the markup in the
    /// element that just asked.
    func document(for element: SVGElement) -> ParsedSVG? {
        let key = Self.cacheKey(for: element)
        if let document = documents[key] {
            touch(key)
            return document
        }
        if !refused.contains(key), !failedRaster.contains(key) {
            prepare(svgElement: element)
        }
        return nil
    }

    /// Renders (or awaits an in-flight render) and returns the ready document.
    /// Used by tests and capture paths that need the figure composited rather
    /// than merely scheduled.
    ///
    /// Unlike `document(for:)` this is an explicit ask, so it retries a failed
    /// raster rather than waiting for the next scene install.
    @discardableResult
    func render(element: SVGElement) async -> ParsedSVG? {
        let key = Self.cacheKey(for: element)
        if let document = documents[key] {
            touch(key)
            return document
        }
        if let task = inFlight[key] {
            return await task.value
        }
        if refused.contains(key) { return nil }
        return await schedule(markup: element.svg, key: key).value
    }

    @discardableResult
    private func schedule(markup: String, key: String) -> Task<ParsedSVG?, Never> {
        let task = Task { @MainActor [weak self] () -> ParsedSVG? in
            guard let self else { return nil }
            var outcome = await Self.rasterize(markup: markup)
            if self.failsRasterForTesting, case .ready = outcome { outcome = .noRaster }
            self.renderPassesForTesting += 1
            self.inFlight[key] = nil
            let document: ParsedSVG?
            switch outcome {
            case .ready(let image, let size):
                let parsed = ParsedSVG(image: image, size: size)
                self.failedRaster.remove(key)
                self.remember(parsed, for: key)
                document = parsed
            case .unparseable:
                // Fail closed, and stay closed. `document(for:)` keeps
                // answering nil, so the element stays blank rather than
                // re-parsing the same broken markup on every scene install.
                // Nothing clears `failedRaster` here: a refusal outranks it in
                // every read, and a document that parsed once parses again.
                self.refused.insert(key)
                document = nil
            case .noRaster:
                // Nothing is recorded against the key beyond "not from a draw":
                // the document parsed, so the markup is good, and the next
                // scene install must be free to try it again.
                self.failedRaster.insert(key)
                document = nil
            }
            NotificationCenter.default.post(name: .boardSceneArtifactReady, object: nil)
            return document
        }
        inFlight[key] = task
        return task
    }

    // MARK: - Residency

    private func remember(_ document: ParsedSVG, for key: String) {
        if let previous = documents[key] { totalBytes -= Self.cost(of: previous.image) }
        documents[key] = document
        totalBytes += Self.cost(of: document.image)
        touch(key)
        // `order.count > 1` keeps the figure that was just drawn even when it
        // alone is over the cap: one enormous document still draws from memory
        // rather than being re-rendered on every frame.
        while totalBytes > byteLimit, let victim = order.first, order.count > 1 {
            order.removeFirst()
            if let evicted = documents.removeValue(forKey: victim) {
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

    // MARK: - The engine contact

    /// What one attempt to turn markup into a bitmap came back with.
    ///
    /// `@unchecked Sendable` for the reason `BoardImageStore.DecodedImage` is:
    /// a `CGImage` is immutable once created and this one is not referenced
    /// again by the task that made it, so handing it across is safe — said
    /// explicitly rather than relying on how the CoreGraphics overlay happens
    /// to be annotated in a given SDK.
    private enum Outcome: @unchecked Sendable {
        case ready(CGImage, CGSize)
        /// SwiftDraw refused the document. It will refuse it next time too.
        case unparseable
        /// The document parsed and no usable bitmap came back.
        case noRaster
    }

    /// Off the main actor, because parsing and drawing a figure is tens of
    /// milliseconds of work that would otherwise land in the middle of a frame.
    /// The image decode takes the same escape in `BoardImageStore`.
    private nonisolated static func rasterize(markup: String) async -> Outcome {
        await Task.detached(priority: .userInitiated) {
            BoardSVGStore.raster(markup: markup)
        }.value
    }

    /// The whole of the SwiftDraw contact.
    ///
    /// The scale is passed explicitly on every call. SwiftDraw's default of `0`
    /// means "read `UIScreen.main.scale`", which it does through
    /// `DispatchQueue.main.sync` — from this task, with the main actor waiting
    /// on it, that is a deadlock rather than a wrong number.
    ///
    /// `rasterize(size:scale:)` rather than `rasterize(scale:)` for one reason:
    /// a document over the ceiling needs a scale below 1, and asking
    /// `UIGraphicsImageRendererFormat` for a fractional scale is a bet on
    /// undocumented behavior. Scaling the artwork into a box of the pixel size
    /// that is wanted, at scale 1, is the same drawing with nothing assumed.
    /// The box is derived by one uniform factor, so the aspect ratio is
    /// preserved and `sized(_:)`'s non-uniform scale never bites.
    private nonisolated static func raster(markup: String) -> Outcome {
        guard let svg = SVG(data: Data(markup.utf8)) else { return .unparseable }
        let size = svg.size
        // SwiftDraw holds the root width and height as `Int`, so a fractional
        // `viewBox` has already been truncated by here and a document under one
        // point on either axis arrives as zero. There is no bitmap to make from
        // that, and there will not be one next time either.
        guard size.width.isFinite, size.height.isFinite,
              size.width >= 1, size.height >= 1
        else { return .unparseable }

        let scale = rasterScale(forDocumentSize: size)
        let box = CGSize(
            width: max(1, (size.width * scale).rounded()),
            height: max(1, (size.height * scale).rounded())
        )
        guard let bitmap = svg.rasterize(size: box, scale: 1).cgImage,
              bitmap.width > 0, bitmap.height > 0
        else { return .noRaster }
        return .ready(bitmap, size)
    }

    /// Pixels per board point for one document: the oversample, until the long
    /// side would pass the ceiling, and then whatever fits under it.
    private nonisolated static func rasterScale(forDocumentSize size: CGSize) -> CGFloat {
        let longest = max(size.width, size.height)
        guard longest > 0 else { return rasterOversample }
        return min(rasterOversample, maximumRasterSide / longest)
    }
}
