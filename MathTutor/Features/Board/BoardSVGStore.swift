import CoreGraphics
import CryptoKit
import Foundation
import SwiftDraw
import UIKit
import WebKit

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
/// It is oversampled to the board's most extreme draw — maximum zoom times the
/// screen's own scale — so a figure stays sharp when the learner zooms and
/// writes on it.
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
    /// This is the largest scale any outer board tile is ever drawn at — the
    /// board's maximum zoom bucket times the screen's own scale — so a figure
    /// stays sharp when the learner zooms to 4x on a 2x screen and writes on
    /// it. `BoardImageStore` prices its photograph decodes the same way. The
    /// long side is still bounded by `maximumRasterSide`, so a document that
    /// cannot be kept at this density is drawn coarser rather than unbounded.
    nonisolated static var rasterOversample: CGFloat { cachedZoomResolution }

    /// The value behind `rasterOversample`.
    ///
    /// SwiftDraw's raster path runs off the main actor, where
    /// `UITraitCollection` is not safe to read, so the value is computed once
    /// on the main actor (in `init`) and reused everywhere. `nonisolated(unsafe)`
    /// for that same reason: every access after the first init is a read.
    private nonisolated(unsafe) static var cachedZoomResolution: CGFloat = 8

    /// Sets `cachedZoomResolution` from the current screen. Called on the main
    /// actor, once the first store is built.
    private static func refreshRasterOversample() {
        let screenScale = UITraitCollection.current.displayScale
        let displayScale = screenScale > 0 ? screenScale : 2
        cachedZoomResolution = ZoomBucket.scale(forBucket: ZoomBucket.maxBucket) * displayScale
    }

    /// The longest side, in pixels, any figure's bitmap may have.
    ///
    /// The ceiling the WebKit renderer put on its offscreen viewport, kept: a
    /// legal model frame can span most of the board, and a `viewBox` is just a
    /// number in a string the server does not police.
    ///
    /// `BoardImageStore.maximumDecodedSide` is the same bound. A square figure
    /// at this side is 4,096 x 4,096 x 4 bytes — 64 MiB, two of which fit the
    /// raised residency budget below, and well inside it for the landscape
    /// figures a lesson actually draws. It is also enough to keep an ordinary
    /// figure sharp at the board's maximum zoom — a ~500-point figure reaches
    /// 8 pixels a point (4,096 / 500), the density `rasterOversample` targets.
    /// A document too large for this is drawn coarser rather than refused.
    nonisolated static let maximumRasterSide: CGFloat = 4_096

    /// The resident budget for figure bitmaps, in bytes.
    ///
    /// Priced the way `BoardImageStore`'s is, but raised for SVG: every bitmap
    /// here is flattened to four bytes per pixel, so `cost(of:)` is the truth
    /// rather than an estimate that a wide-gamut device doubles behind its
    /// back. At the current 8 pixels-per-point oversample a realistic teaching
    /// set — a solution region, a worked step, an annotation and a formula
    /// band — prices to about 102 MB of flat raster, which the earlier 64 MiB
    /// budget could not all hold. Evicting one of those figures makes its
    /// element draw as a blank box, so the default is raised to the smallest
    /// rounded bound that keeps the whole set resident.
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

    init(byteLimit: Int = 128 * 1024 * 1024) {
        self.byteLimit = byteLimit
        Self.refreshRasterOversample()
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
    fileprivate enum Outcome: @unchecked Sendable {
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
        // Ordinary SVG keeps the fast SwiftDraw path. A document that draws an
        // emoji inside `<text>` cannot: SwiftDraw turns a text run into Core
        // Text outlines, and Apple Color Emoji has no outline, so the glyph is
        // silently absent. Those documents take the WebKit raster fallback
        // below, which renders the raw document with the system's own text
        // engine. The split keeps a plain figure off the WebKit path entirely.
        if containsDrawnEmoji(inTextOf: markup) {
            return await WebKitSVGRasterizer.rasterize(markup: markup)
        }
        return await Task.detached(priority: .userInitiated) {
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
    /// extended-range buffer: eight bytes per pixel, not four. A 4096 x 4096
    /// figure would then be 128 MB rather than 64, and `cost(of:)` — which the
    /// byte cap is priced in — would be reporting half of what the store
    /// actually holds. Board colours are sRGB hex, so the wider range buys
    /// nothing to pay for that with.
    ///
    /// `BoardSceneLayerView.rasterize` pins its tiles the same way, for the
    /// same reason. `opaque` stays false: a figure is drawn over the board, and
    /// everything the document did not paint has to stay clear.
    fileprivate nonisolated static func flattened(_ image: UIImage, size: CGSize) -> CGImage? {
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
    fileprivate nonisolated static func rasterScale(forDocumentSize size: CGSize) -> CGFloat {
        min(rasterOversample, maximumRasterSide / max(size.width, size.height))
    }

    /// Whether a raw SVG document draws an emoji inside a `<text>` or `<tspan>`
    /// element's character data.
    ///
    /// Emoji can reach a document two ways and only one of them drops a glyph
    /// under SwiftDraw's outline path: inside a drawn `<text>`/`<tspan>` run
    /// they vanish, while in a `<title>`, an attribute, an id or a comment they
    /// were never going to be drawn anyway. Detection is scoped to the actual
    /// character data of text-bearing elements (via `XMLParser`), so a
    /// decorative emoji does not send an ordinary figure down the WebKit path.
    ///
    /// The emoji test mirrors the former server lint rule for which characters
    /// carry `Emoji_Presentation` (plus the variation selector and
    /// combining-keycap markers that turn a digit into `1️⃣`), so a document the
    /// device routes to WebKit and one the server declines to warn about agree.
    /// Internal so the routing regression in `BoardSVGStoreTests` can pin the
    /// exact decision without driving two renderers.
    nonisolated static func containsDrawnEmoji(inTextOf markup: String) -> Bool {
        let delegate = TextEmojiDetector()
        let parser = XMLParser(data: Data(markup.utf8))
        parser.delegate = delegate
        parser.shouldResolveExternalEntities = false
        // The delegate aborts as soon as it sees one emoji. `parse()` therefore
        // returns false on the successful fast-exit path as well as for malformed
        // XML, so the delegate's result is the authority.
        _ = parser.parse()
        return delegate.foundEmoji
    }
}

/// Collects the character data of SVG text-bearing elements (`<text>` and
/// `<tspan>`) so the store can decide whether a document actually draws an
/// emoji. `<title>` and other tags never contribute: SVG defines them as
/// non-rendered metadata, matching the server's own lint rule.
private final class TextEmojiDetector: NSObject, XMLParserDelegate {
    private var textDepth = 0
    private(set) var foundEmoji = false

    // `text` and `tspan` are the only two SVG elements whose content is drawn
    // as text runs. Every other element's character data is metadata that
    // SwiftDraw never rasterizes.
    private static let textElements: Set<String> = ["text", "tspan"]

    func parser(
        _ parser: XMLParser,
        didStartElement elementName: String,
        namespaceURI: String?,
        qualifiedName qName: String?,
        attributes attributeDict: [String: String] = [:]
    ) {
        let localName = elementName.split(separator: ":").last.map(String.init) ?? elementName
        if Self.textElements.contains(localName) {
            textDepth += 1
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        inspect(string, parser: parser)
    }

    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
        if let string = String(data: CDATABlock, encoding: .utf8) {
            inspect(string, parser: parser)
        }
    }

    func parser(
        _ parser: XMLParser,
        didEndElement elementName: String,
        namespaceURI: String?,
        qualifiedName qName: String?
    ) {
        let localName = elementName.split(separator: ":").last.map(String.init) ?? elementName
        if Self.textElements.contains(localName), textDepth > 0 {
            textDepth -= 1
        }
    }

    private func inspect(_ string: String, parser: XMLParser) {
        guard textDepth > 0, !foundEmoji else { return }
        for scalar in string.unicodeScalars where scalar.properties.isEmojiPresentation
            || scalar.value == 0xFE0F || scalar.value == 0x20E3 {
            foundEmoji = true
            parser.abortParsing()
            return
        }
    }
}

// MARK: - WebKit emoji fallback

/// The raster engine for raw SVG documents that draw emoji inside `<text>`.
///
/// Apple Color Emoji is a bitmap/colour font, so SwiftDraw's Core Text outline
/// conversion produces no glyph for those runs and they disappear. WebKit is
/// the platform's own SVG renderer and draws `<text>` with the system text
/// stack, so the emoji survive. To keep that capability out of the fast path a
/// `Parser` only lands here after the store decided the document actually needs
/// it.
///
/// This restores the project's earlier `BoardSVGRenderer` design for the
/// narrow case that needs it: one reusable noninteractive `WKWebView` in an
/// offscreen window, JavaScript disabled, a content rule list that blocks every
/// external `http(s)`/`ftp`/`file` fetch, hard navigation and operation
/// timeouts, and a PDF-first render with a snapshot fallback. The exact UTF-8
/// bytes are handed straight to WebKit; nothing is parsed, trimmed or rewritten.
@MainActor
private final class WebKitSVGRasterizer: NSObject, WKNavigationDelegate {
    private static let contentRuleIdentifier = "mathTutor.blockExternalNetwork.v2"
    private static let blockExternalRuleJSON = """
    [
      {"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
      {"trigger":{"url-filter":"^ftp:"},"action":{"type":"block"}},
      {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}}
    ]
    """
    private static let navigationTimeoutNanoseconds: UInt64 = 10_000_000_000
    private static let operationTimeoutNanoseconds: UInt64 = 15_000_000_000
    /// WebKit needs a settle pass after `didFinish` before async layout is
    /// captured. The original probe used 2s on iPad iOS 26.
    private static let renderSettleNanoseconds: UInt64 = 2_000_000_000

    private static let shared = WebKitSVGRasterizer()

    private var webView: WKWebView?
    private var hostWindow: UIWindow?
    private var contentRuleList: WKContentRuleList?
    private var pendingNavigation: TimedCompletion<Bool>?
    private weak var pendingWebNavigation: WKNavigation?
    /// The renderer owns one reusable web view, so loads must be serialized.
    /// Otherwise a second emoji figure replaces the first one's navigation
    /// continuation and each cache key can receive the other's pixels.
    private var lastRender: Task<UIImage?, Never>?

    /// Parses the document with SwiftDraw to learn its size, then rasterizes it
    /// at the store's normal oversample/ceiling policy through WebKit. Returns
    /// the same `Outcome` the SwiftDraw engine does.
    static func rasterize(markup: String) async -> BoardSVGStore.Outcome {
        // The document size comes from the native parse, which is deterministic
        // and needs no web view. Refuse malformed or dimensionless markup before
        // allocating the offscreen renderer.
        guard let svg = SVG(data: Data(markup.utf8)) else { return .unparseable }
        let size = svg.size
        guard size.width.isFinite, size.height.isFinite,
              size.width >= 1, size.height >= 1
        else { return .unparseable }

        let scale = BoardSVGStore.rasterScale(forDocumentSize: size)
        let box = CGSize(
            width: max(1, (size.width * scale).rounded()),
            height: max(1, (size.height * scale).rounded())
        )
        guard let image = await shared.render(markup: markup, pixelSize: box),
              let bitmap = BoardSVGStore.flattened(image, size: box),
              bitmap.width > 0, bitmap.height > 0
        else { return .noRaster }
        return .ready(bitmap, size)
    }

    /// One render of a raw document into a transparent bitmap at `pixelSize`.
    private func render(markup: String, pixelSize: CGSize) async -> UIImage? {
        let previous = lastRender
        let task = Task { @MainActor [weak self] () -> UIImage? in
            guard let self else { return nil }
            if let previous { _ = await previous.value }
            return await self.renderNow(markup: markup, pixelSize: pixelSize)
        }
        lastRender = task
        return await task.value
    }

    private func renderNow(markup: String, pixelSize: CGSize) async -> UIImage? {
        // External-resource blocking is part of the renderer's trust boundary.
        // If WebKit cannot install it, fail the figure rather than render the
        // model-authored document with unrestricted network/file access.
        guard await installContentRuleListIfNeeded() else { return nil }
        let webView = ensureWebView(size: pixelSize)
        webView.frame = CGRect(origin: .zero, size: pixelSize)
        hostWebView(webView, size: pixelSize)

        guard await load(svg: markup, in: webView) else { return nil }
        try? await Task.sleep(nanoseconds: Self.renderSettleNanoseconds)

        if let pdfData = await createPDF(in: webView, pixelSize: pixelSize),
           !pdfData.isEmpty,
           Self.pdfIsUsable(pdfData, expectedSize: pixelSize),
           let pdfImage = Self.rasterize(pdf: pdfData, pixelSize: pixelSize) {
            return pdfImage
        }
        return await takeSnapshot(in: webView)
    }

    private func installContentRuleListIfNeeded() async -> Bool {
        if contentRuleList != nil { return true }
        guard let store = WKContentRuleListStore.default() else { return false }
        contentRuleList = await withCheckedContinuation { continuation in
            store.lookUpContentRuleList(forIdentifier: Self.contentRuleIdentifier) { rule, _ in
                if let rule {
                    continuation.resume(returning: rule)
                    return
                }
                store.compileContentRuleList(
                    forIdentifier: Self.contentRuleIdentifier,
                    encodedContentRuleList: Self.blockExternalRuleJSON
                ) { compiled, _ in
                    continuation.resume(returning: compiled)
                }
            }
        }
        return contentRuleList != nil
    }

    private func ensureWebView(size: CGSize) -> WKWebView {
        if let webView { return webView }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = false
        configuration.defaultWebpagePreferences = preferences
        if let contentRuleList {
            configuration.userContentController.add(contentRuleList)
        }
        let webView = WKWebView(frame: CGRect(origin: .zero, size: size), configuration: configuration)
        webView.navigationDelegate = self
        webView.isUserInteractionEnabled = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.backgroundColor = .clear
        self.webView = webView
        return webView
    }

    /// Keeps the offscreen view in a window far outside the screen so local SVG
    /// rendering never flashes UI or steals first responder.
    private func hostWebView(_ webView: WKWebView, size: CGSize) {
        if let hostWindow, hostWindow.frame.size == size,
           webView.superview === hostWindow.rootViewController?.view {
            return
        }
        if webView.superview != nil {
            webView.removeFromSuperview()
        }
        let window: UIWindow
        if let hostWindow, hostWindow.frame.size == size {
            window = hostWindow
        } else {
            window = UIWindow(frame: CGRect(
                x: -10_000,
                y: -10_000,
                width: max(1, size.width),
                height: max(1, size.height)
            ))
            window.windowLevel = UIWindow.Level(rawValue: -1_000)
            window.rootViewController = UIViewController()
            window.isHidden = false
            self.hostWindow = window
        }
        window.rootViewController?.view.addSubview(webView)
    }

    private func load(svg: String, in webView: WKWebView) async -> Bool {
        await withCheckedContinuation { continuation in
            let completion = TimedCompletion(continuation)
            pendingNavigation = completion
            completion.arm(
                nanoseconds: Self.navigationTimeoutNanoseconds,
                timeoutValue: false
            ) { [weak self, weak webView] in
                guard let self, self.pendingNavigation === completion else { return }
                webView?.stopLoading()
                self.pendingNavigation = nil
                self.pendingWebNavigation = nil
            }
            pendingWebNavigation = webView.load(
                Data(svg.utf8),
                mimeType: "image/svg+xml",
                characterEncodingName: "UTF-8",
                baseURL: URL(string: "about:blank")!
            )
            if pendingWebNavigation == nil {
                finishNavigation(false)
            }
        }
    }

    private func createPDF(in webView: WKWebView, pixelSize: CGSize) async -> Data? {
        let configuration = WKPDFConfiguration()
        configuration.rect = CGRect(origin: .zero, size: pixelSize)
        return await withCheckedContinuation { continuation in
            let completion = TimedCompletion(continuation)
            completion.arm(
                nanoseconds: Self.operationTimeoutNanoseconds,
                timeoutValue: nil
            )
            webView.createPDF(configuration: configuration) { result in
                completion.resume(try? result.get())
            }
        }
    }

    private func takeSnapshot(in webView: WKWebView) async -> UIImage? {
        await withCheckedContinuation { continuation in
            let completion = TimedCompletion(continuation)
            completion.arm(
                nanoseconds: Self.operationTimeoutNanoseconds,
                timeoutValue: nil
            )
            webView.takeSnapshot(with: nil) { image, _ in
                completion.resume(image)
            }
        }
    }

    /// PDF is y-up and scaled to `pixelSize`; redraw it into a transparent
    /// bitmap through the same flattened pipeline as the snapshot path.
    private static func rasterize(pdf: Data, pixelSize: CGSize) -> UIImage? {
        guard let provider = CGDataProvider(data: pdf as CFData),
              let document = CGPDFDocument(provider),
              let page = document.page(at: 1)
        else { return nil }
        let pageRect = page.getBoxRect(.mediaBox)
        guard pageRect.width > 0, pageRect.height > 0 else { return nil }
        return UIGraphicsImageRenderer(size: pixelSize).image { context in
            let cg = context.cgContext
            cg.saveGState()
            cg.interpolationQuality = .high
            let scaleX = pixelSize.width / pageRect.width
            let scaleY = pixelSize.height / pageRect.height
            cg.translateBy(x: 0, y: pixelSize.height)
            cg.scaleBy(x: scaleX, y: -scaleY)
            cg.translateBy(x: -pageRect.minX, y: -pageRect.minY)
            cg.drawPDFPage(page)
            cg.restoreGState()
        }
    }

    private static func pdfIsUsable(_ data: Data, expectedSize: CGSize) -> Bool {
        guard let provider = CGDataProvider(data: data as CFData),
              let document = CGPDFDocument(provider),
              let page = document.page(at: 1)
        else { return false }
        let box = page.getBoxRect(.mediaBox)
        let tolerance: CGFloat = 1
        return box.width > 0
            && box.height > 0
            && abs(box.width - expectedSize.width) <= tolerance
            && abs(box.height - expectedSize.height) <= tolerance
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === pendingWebNavigation else { return }
        finishNavigation(true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard navigation === pendingWebNavigation else { return }
        finishNavigation(false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard navigation === pendingWebNavigation else { return }
        finishNavigation(false)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        let scheme = navigationAction.request.url?.scheme?.lowercased()
        if scheme == "http" || scheme == "https" || scheme == "ftp" || scheme == "file" {
            finishNavigation(false)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    private func finishNavigation(_ success: Bool) {
        pendingNavigation?.resume(success)
        pendingNavigation = nil
        pendingWebNavigation = nil
    }
}

/// Resumes a WebKit callback exactly once, with a real timeout that does not
/// wait for the losing operation. A task-group race would wait for every child,
/// so a child suspended on a callback that never arrives could still hang.
@MainActor
private final class TimedCompletion<Value: Sendable> {
    private var continuation: CheckedContinuation<Value, Never>?
    private var timeoutTask: Task<Void, Never>?

    init(_ continuation: CheckedContinuation<Value, Never>) {
        self.continuation = continuation
    }

    func arm(
        nanoseconds: UInt64,
        timeoutValue: Value,
        onTimeout: @escaping @MainActor () -> Void = {}
    ) {
        timeoutTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: nanoseconds)
            } catch {
                return
            }
            guard let self, self.continuation != nil else { return }
            onTimeout()
            self.resume(timeoutValue)
        }
    }

    func resume(_ value: Value) {
        guard let continuation else { return }
        self.continuation = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        continuation.resume(returning: value)
    }
}
