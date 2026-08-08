import CryptoKit
import UIKit
import WebKit

extension Notification.Name {
    /// Posted on the main actor after a local SVG render completes, so the
    /// transparent board overlay can redraw without owning the render pipeline.
    static let boardSVGCacheDidRender = Notification.Name("boardSVGCacheDidRender")
}

/// Resumes a WebKit callback exactly once, with a real timeout that does not
/// wait for the losing operation. A task-group race is not sufficient here:
/// structured concurrency waits for every child before leaving the group, so
/// a child suspended on a callback that never arrives can still hang forever.
@MainActor
private final class SVGTimedCompletion<Value: Sendable> {
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

/// A locally rendered complete SVG document. Prefer WebKit's vector PDF output
/// so pan/zoom and capture scaling stay crisp; fall back to a snapshot only
/// when PDF generation is unavailable for a document.
@MainActor
struct SVGRenderedArtifact {
    enum Storage {
        case pdf(Data)
        case image(UIImage)
    }

    var storage: Storage
    var pixelSize: CGSize

    func draw(in rect: CGRect, into context: CGContext) {
        guard rect.width > 0, rect.height > 0 else { return }
        switch storage {
        case .pdf(let data):
            guard let provider = CGDataProvider(data: data as CFData),
                  let document = CGPDFDocument(provider),
                  let page = document.page(at: 1)
            else { return }
            let pageRect = page.getBoxRect(.mediaBox)
            guard pageRect.width > 0, pageRect.height > 0 else { return }
            context.saveGState()
            let scaleX = rect.width / pageRect.width
            let scaleY = rect.height / pageRect.height
            // PDFs are y-up. UIKit drawing contexts are normally y-down, so
            // flip around the destination's vertical axis when the current
            // CTM indicates a flipped coordinate system.
            let isFlipped = context.ctm.d < 0
            context.translateBy(x: rect.minX, y: isFlipped ? rect.maxY : rect.minY)
            context.scaleBy(x: scaleX, y: isFlipped ? -scaleY : scaleY)
            context.translateBy(x: -pageRect.minX, y: -pageRect.minY)
            context.drawPDFPage(page)
            context.restoreGState()
        case .image(let image):
            image.draw(in: rect)
        }
    }
}

/// A single reusable, noninteractive `WKWebView` that renders raw SVG to a
/// cached artifact. JavaScript is disabled and a WebKit content rule list
/// blocks external `http(s)`, `ftp`, and `file` resource loads; embedded and
/// `data:` content still works. This is renderer sandboxing, not SVG parsing
/// or markup rewriting.
@MainActor
final class BoardSVGRenderer: NSObject, WKNavigationDelegate {
    private static let contentRuleIdentifier = "mathTutor.blockExternalNetwork.v1"
    private static let blockExternalRuleJSON = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}}]
    """
    private static let navigationTimeoutNanoseconds: UInt64 = 10_000_000_000
    private static let operationTimeoutNanoseconds: UInt64 = 15_000_000_000
    /// WebKit needs a settle pass after `didFinish` before CSS/SMIL animation
    /// and async layout are captured; the probe used 2s on iPad iOS 26.
    private static let renderSettleNanoseconds: UInt64 = 2_000_000_000
    /// Longest offscreen WebKit/PDF side. A legal model frame can span the
    /// whole board; capping the render viewport keeps that from allocating a
    /// 50,000pt WKWebView or PDF. The artifact still scales into the logical
    /// frame when drawn.
    static let maximumRenderDimension: CGFloat = 2_048

    private var webView: WKWebView?
    private var hostWindow: UIWindow?
    private var contentRuleList: WKContentRuleList?
    private var pendingNavigation: SVGTimedCompletion<Bool>?
    private weak var pendingWebNavigation: WKNavigation?
    private var lastRender: Task<SVGRenderedArtifact?, Never>?

    /// Serializes renders: WebKit is single-tasked per view, and a scene can
    /// schedule many elements at once.
    func render(svg: String, width: CGFloat, height: CGFloat) async -> SVGRenderedArtifact? {
        let previous = lastRender
        let task = Task { @MainActor [weak self] () -> SVGRenderedArtifact? in
            guard let self else { return nil }
            if let previous { _ = await previous.value }
            return await self.renderNow(svg: svg, width: width, height: height)
        }
        lastRender = task
        return await task.value
    }

    private func renderNow(svg: String, width: CGFloat, height: CGFloat) async -> SVGRenderedArtifact? {
        let pixelSize = Self.cappedRenderSize(width: width, height: height)
        await installContentRuleListIfNeeded()
        let webView = ensureWebView(size: pixelSize)
        webView.frame = CGRect(origin: .zero, size: pixelSize)
        hostWebView(webView, size: pixelSize)

        // The model payload is treated as a complete raw SVG document. Its
        // exact UTF-8 bytes are handed straight to WebKit; nothing is parsed,
        // trimmed, wrapped, or rewritten here.
        guard await load(svg: svg, in: webView) else { return nil }
        try? await Task.sleep(nanoseconds: Self.renderSettleNanoseconds)

        if let pdfData = await createPDF(in: webView, pixelSize: pixelSize),
           !pdfData.isEmpty,
           Self.pdfIsUsable(pdfData, expectedSize: pixelSize) {
            return SVGRenderedArtifact(storage: .pdf(pdfData), pixelSize: pixelSize)
        }
        guard let snapshot = await takeSnapshot(in: webView) else { return nil }
        return SVGRenderedArtifact(storage: .image(snapshot), pixelSize: pixelSize)
    }

    private static func cappedRenderSize(width: CGFloat, height: CGFloat) -> CGSize {
        let safeWidth = max(1, width)
        let safeHeight = max(1, height)
        let longest = max(safeWidth, safeHeight)
        guard longest > maximumRenderDimension else {
            return CGSize(width: safeWidth, height: safeHeight)
        }
        let scale = maximumRenderDimension / longest
        return CGSize(
            width: max(1, safeWidth * scale),
            height: max(1, safeHeight * scale)
        )
    }

    private func installContentRuleListIfNeeded() async {
        guard contentRuleList == nil else { return }
        guard let store = WKContentRuleListStore.default() else { return }
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

    /// WebKit renders most reliably when the view participates in a window's
    /// layout pass. Keep one offscreen window far outside the screen so local
    /// SVG rendering never flashes UI or steals first responder.
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
            let completion = SVGTimedCompletion(continuation)
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
            let completion = SVGTimedCompletion(continuation)
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
        let pngData: Data? = await withCheckedContinuation { continuation in
            let completion = SVGTimedCompletion(continuation)
            completion.arm(
                nanoseconds: Self.operationTimeoutNanoseconds,
                timeoutValue: nil
            )
            webView.takeSnapshot(with: nil) { image, _ in
                completion.resume(image?.pngData())
            }
        }
        return pngData.flatMap(UIImage.init(data:))
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
        if scheme == "http" || scheme == "https" {
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

/// In-memory cache keyed by raw SVG plus element dimensions, with a single
/// asynchronous render pipeline. `BoardSceneRenderer` draws cached artifacts
/// synchronously; the canvas schedules missing entries whenever a scene is
/// installed, and the overlay is notified when an entry becomes ready.
@MainActor
final class BoardSVGCache {
    static let shared = BoardSVGCache()

    private let renderer = BoardSVGRenderer()
    private var artifacts: [String: SVGRenderedArtifact] = [:]
    private var completed: Set<String> = []
    private var inFlight: [String: Task<SVGRenderedArtifact?, Never>] = [:]

    static func cacheKey(svg: String, width: CGFloat, height: CGFloat) -> String {
        let digest = SHA256.hash(data: Data(svg.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "\(Int(width.rounded()))x\(Int(height.rounded()))|\(hex)"
    }

    /// Ensures every SVG element in a scene has a render scheduled. Called
    /// when a scene is installed, including restored scenes on relaunch.
    func prepare(scene: BoardScene) {
        for element in scene.elements {
            if case .svg(let svg) = element {
                prepare(svgElement: svg)
            }
        }
    }

    func prepare(svgElement element: SVGElement) {
        let key = Self.cacheKey(svg: element.svg, width: element.width, height: element.height)
        guard !completed.contains(key), inFlight[key] == nil else { return }
        schedule(element: element, key: key)
    }

    func artifact(for element: SVGElement) -> SVGRenderedArtifact? {
        artifacts[Self.cacheKey(svg: element.svg, width: element.width, height: element.height)]
    }

    /// Renders (or awaits an in-flight render) and returns the ready artifact.
    /// Used by tests and capture paths that need compositing after readiness.
    @discardableResult
    func render(element: SVGElement) async -> SVGRenderedArtifact? {
        let key = Self.cacheKey(svg: element.svg, width: element.width, height: element.height)
        if let artifact = artifacts[key] { return artifact }
        if let task = inFlight[key] {
            return await task.value
        }
        if completed.contains(key) { return nil }
        let task = schedule(element: element, key: key)
        return await task.value
    }

    @discardableResult
    private func schedule(element: SVGElement, key: String) -> Task<SVGRenderedArtifact?, Never> {
        let task = Task { @MainActor [weak self] () -> SVGRenderedArtifact? in
            guard let self else { return nil }
            let artifact = await self.renderer.render(
                svg: element.svg,
                width: element.width,
                height: element.height
            )
            self.inFlight[key] = nil
            if let artifact {
                self.completed.insert(key)
                self.artifacts[key] = artifact
            } else {
                // A transient WebKit failure must not poison this source for
                // the rest of the app session. A later scene install or an
                // explicit render may retry it; malformed SVG still fails
                // closed without crashing.
                self.completed.remove(key)
            }
            NotificationCenter.default.post(name: .boardSVGCacheDidRender, object: nil)
            return artifact
        }
        inFlight[key] = task
        return task
    }
}
