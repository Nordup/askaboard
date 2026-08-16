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
/// Every bitmap is then flattened to 8-bit sRGB, so a pixel is four bytes on
/// every device and the byte cap below prices what it says it prices. What
/// survives is held under that cap: a session where the model draws a new
/// figure every turn must degrade into re-rendering, never into memory
/// pressure.
///
/// **A working set larger than the budget degrades, it does not thrash.** An
/// evicted figure is not lost — the markup that made it is in the element — but
/// a *draw* is not allowed to start the re-render. If it were, two figures that
/// cannot both fit would evict each other forever: draw → render → evict →
/// notify → reconcile → draw. So the retry point is a scene install, which
/// costs at most one render per figure, and until then the element draws as
/// nothing. The same rule covers a raster that failed, for the same reason.
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
    /// `BoardImageStore`'s budget, and priced the same way: every bitmap here
    /// is flattened to four bytes per pixel, so `cost(of:)` is the truth rather
    /// than an estimate that a wide-gamut device doubles behind its back.
    private let byteLimit: Int

    private var documents: [String: ParsedSVG] = [:]
    /// Least recently used first — `BoardRasterCache`'s array, at this scale.
    private var order: [String] = []
    private var totalBytes = 0
    /// Keys whose markup does not parse. Nothing is ever retried for these.
    private var refused: Set<String> = []
    /// Keys a *draw* must not schedule work for until the next scene install.
    ///
    /// Two things land here, and neither is a refusal. A raster that did not
    /// come back: the document parsed, so the markup is good, but a draw that
    /// re-scheduled it would go draw → schedule → fail → notify → draw for as
    /// long as the element stayed on the board. And a figure evicted under the
    /// byte cap: if a draw re-rendered it, two figures that cannot both fit
    /// would take turns evicting each other, and every eviction notifies, which
    /// makes the loop drive itself.
    ///
    /// Both cost the same thing — the element draws as nothing until the next
    /// scene install — and both are worth it. `prepare(scene:)` clears the set;
    /// `render(element:)` ignores it, because an explicit ask is not a draw.
    private var deferred: Set<String> = []
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

    /// What the resident figures cost right now, for the tests that price them.
    var totalBytesForTesting: Int { totalBytes }

    /// Removes every parsed figure when the system says memory is short.
    ///
    /// nonisolated(unsafe): deinit must remove a block-based observer, and
    /// deinit is nonisolated in Swift 6. Every other access is MainActor-only,
    /// and by the time deinit runs no other reference exists.
    /// `VoiceAudioSessionController` holds its observers the same way.
    private nonisolated(unsafe) var memoryWarningObserver: (any NSObjectProtocol)?

    init(byteLimit: Int = 64 * 1024 * 1024) {
        self.byteLimit = byteLimit
        memoryWarningObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.purgeUnderMemoryPressure() }
        }
    }

    deinit {
        if let memoryWarningObserver {
            NotificationCenter.default.removeObserver(memoryWarningObserver)
        }
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
        deferred.removeAll()
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
    /// A miss also *schedules* — the first sight of a figure is usually a draw,
    /// and the markup it needs is in the element that just asked — but only for
    /// a key the store has nothing recorded against. A refusal, a raster that
    /// failed, and a figure evicted under the byte cap all wait for the next
    /// scene install instead, because a draw that schedules work is a draw that
    /// can be made to schedule it again by the notification its own work posts.
    func document(for element: SVGElement) -> ParsedSVG? {
        let key = Self.cacheKey(for: element)
        if let document = documents[key] {
            touch(key)
            return document
        }
        if !refused.contains(key), !deferred.contains(key) {
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
                self.deferred.remove(key)
                self.remember(parsed, for: key)
                document = parsed
            case .unparseable:
                // Fail closed, and stay closed. `document(for:)` keeps
                // answering nil, so the element stays blank rather than
                // re-parsing the same broken markup on every scene install.
                // Nothing clears `deferred` here: a refusal outranks it in
                // every read, and a document that parsed once parses again.
                self.refused.insert(key)
                document = nil
            case .noRaster:
                // Nothing is recorded against the key beyond "not from a draw":
                // the document parsed, so the markup is good, and the next
                // scene install must be free to try it again.
                self.deferred.insert(key)
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
            // The figure that was just dropped is exactly the one a draw is
            // about to ask for again, and re-rendering it would drop this one
            // in its place. The next scene install decides which of them the
            // board still needs.
            deferred.insert(victim)
        }
    }

    /// Drops every parsed figure when the system says memory is short.
    ///
    /// Nothing is recorded against the keys, and that is what separates this
    /// from an eviction. An eviction defers, because the thing that would
    /// re-schedule it is the very draw that lost it and the two would take
    /// turns. Here nothing is competing for the same bytes, so every key is
    /// free to come back — and the markup that made each bitmap is still in the
    /// element that carries it.
    ///
    /// How much comes back depends on the element, and it is not simply "what
    /// the viewport can see". A figure the model gave a frame to is re-rendered
    /// by a draw, so the cull bounds it to the visible set. A figure *without*
    /// a frame is not: its layout is the document's own size, so
    /// `BoardSceneRenderer.elementBounds` asks `document(for:)` for it, and the
    /// cull computes bounds for every element in the scene. A board of frameless
    /// figures therefore re-renders scene-wide on the next reconcile.
    ///
    /// What must not happen is a repaint from inside this call.
    /// `BoardSceneLayerView` drops its tiles on the same notification and
    /// deliberately no longer reconciles on it; the next pan, zoom, scene
    /// install or landed artifact is what brings the visible figures back.
    private func purgeUnderMemoryPressure() {
        documents.removeAll()
        order.removeAll()
        totalBytes = 0
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
    /// means "read `UIScreen.main.scale`" (`SVG.defaultScale`), which off the
    /// main thread it reaches through `DispatchQueue.main.sync`: a hop onto the
    /// main thread inside every render, and — because every device this ships
    /// on is 2x — twice the pixels this function asked for, which is the ceiling
    /// above silently doubled.
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
        guard let bitmap = flattened(svg.rasterize(size: box, scale: 1), size: box),
              bitmap.width > 0, bitmap.height > 0
        else { return .noRaster }
        return .ready(bitmap, size)
    }

    /// The same drawing, in 8-bit sRGB, at one pixel per point.
    ///
    /// SwiftDraw rasterizes through `UIGraphicsImageRendererFormat.preferred()`
    /// with `preferredRange = .automatic`, and on a wide-gamut iPad that is an
    /// extended-range buffer: eight bytes per pixel, not four. A 2048 x 2048
    /// figure would then be 33 MB rather than 16, and `cost(of:)` — which the
    /// byte cap is priced in — would be reporting half of what the store
    /// actually holds. Board colours are sRGB hex, so the wider range buys
    /// nothing to pay for that with.
    ///
    /// `BoardSceneLayerView.rasterize` pins its tiles the same way, for the
    /// same reason. `opaque` stays false: a figure is drawn over the board, and
    /// everything the document did not paint has to stay clear.
    private nonisolated static func flattened(_ image: UIImage, size: CGSize) -> CGImage? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        format.preferredRange = .standard
        let standardRange = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return standardRange.cgImage
    }

    /// Pixels per board point for one document: the oversample, until the long
    /// side would pass the ceiling, and then whatever fits under it.
    ///
    /// The only caller has already refused a document under one point on either
    /// axis, so the division has a divisor of at least 1.
    private nonisolated static func rasterScale(forDocumentSize size: CGSize) -> CGFloat {
        min(rasterOversample, maximumRasterSide / max(size.width, size.height))
    }
}
