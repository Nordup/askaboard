import UIKit

/// The tutor's scene, composited by Core Animation instead of redrawn.
///
/// This replaces the repaint-per-frame overlay. One content layer carries the
/// pan/zoom transform of the enclosing `PKCanvasView` scroll view, and every
/// visible element owns a sublayer whose contents are a bitmap rasterized once
/// per zoom bucket. A pan therefore costs one transform assignment instead of
/// a full-scene `draw(_:)` pass, and a scene far larger than the viewport
/// costs only the elements the viewport can actually see.
///
/// Two coordinate spaces meet here. *Board* coordinates are what the tutor
/// authors and what `BoardSceneRenderer.draw(element:in:)` draws in. *Drawing*
/// coordinates are board coordinates plus `boardOrigin`, which is what
/// `BoardSceneRenderer.bounds(of:boardOrigin:)` returns and what layer frames
/// and the cull are expressed in. `raster(for:bounds:)` is the one place that
/// reconciles the two.
@MainActor
final class BoardSceneLayerView: UIView {
    /// Board (0,0) expressed in drawing coordinates. Only the cull and the
    /// layer frames consume it; the bitmaps themselves are origin-independent
    /// (see `raster(for:bounds:)`), so moving the origin never invalidates the
    /// raster cache.
    var boardOrigin: CGPoint = PencilCanvasConfiguration.boardOrigin {
        didSet {
            guard boardOrigin != oldValue else { return }
            reconcile()
        }
    }

    var scene: BoardScene = .empty {
        didSet {
            guard scene != oldValue else { return }
            // Scheduling every `svg` and `math_text` element's render is this
            // view's own duty, not its container's: `raster(for:bounds:)` reads
            // the artifact and draws nothing until it lands, so a scene
            // installed without these calls would leave every such layer empty
            // forever. Restored scenes and scene replacements all reach the
            // board through the canvas's `boardScene`, which forwards here, so
            // this is the one place a scene's local renders are scheduled.
            BoardSVGCache.shared.prepare(scene: scene)
            BoardMathStore.shared.prepare(scene: scene)
            reconcile()
        }
    }

    /// The largest bitmap this view will ever allocate, in total pixels.
    ///
    /// A large figure is drawn at a reduced scale rather than dropped (see
    /// `raster(for:bounds:)`), so this bounds the allocation, not the set of
    /// elements that appear. At four bytes per pixel the worst case is 256 MB
    /// for one bitmap, which is the budget the plan chose; lowering it costs
    /// sharpness on huge figures at maximum zoom, never visibility.
    private static let maximumRasterPixels: CGFloat = 64_000_000

    /// The largest element this view will draw at all, in square board points.
    ///
    /// 2,000 x 2,000 points is half the span `BoardGeometry.maximumEvaluationSpan`
    /// allows for a whole solution region, so a single element past it is not a
    /// figure — it is one whose coordinates the server never clamped (an `svg`
    /// path's `d` string is not parsed there). Those are refused outright: the
    /// element stays blank and the app keeps its memory. A figure that is
    /// merely large is drawn whole, softer.
    private static let maximumElementArea: CGFloat = 4_000_000

    /// The longest side a bitmap may have, in pixels: the largest 2D texture
    /// the GPUs this ships on can hold. Core Animation cannot display a
    /// `contents` image longer than this, and area alone does not bound a
    /// side — a line across the whole board is a legal element with bounds of
    /// 50,000 x 4 points, whose area is tiny. Such an element is rasterized
    /// coarser rather than into a texture the compositor would drop.
    private static let maximumRasterSide: CGFloat = 16_384

    private let contentLayer = CALayer()
    private var elementLayers: [String: CALayer] = [:]
    private let rasterCache = BoardRasterCache()
    private var contentOffset: CGPoint = .zero
    private var zoomScale: CGFloat = 1
    private var currentBucket = ZoomBucket.bucket(forZoom: 1)
    private var lastCulledSize: CGSize = .zero

    private var mountedElementIds: Set<String> { Set(elementLayers.keys) }

    var mountedElementIdsForTesting: Set<String> { mountedElementIds }
    var rasterCacheBytesForTesting: Int { rasterCache.totalBytes }

    /// The bitmap a mounted element is showing, so a test can see what the
    /// raster path produced. `nil` means the element drew nothing. Read from
    /// the cache rather than cast back out of `layer.contents`: `apply`
    /// assigns exactly this image, and a stored bitmap is the same object.
    func mountedRasterForTesting(id: String) -> CGImage? {
        guard elementLayers[id] != nil,
              let element = scene.elements.first(where: { $0.id == id })
        else { return nil }
        return rasterCache.image(for: RasterKey(element: element, bucket: currentBucket))
    }


    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isOpaque = false
        backgroundColor = .clear
        // Elements are mounted half a viewport beyond the visible edge so a
        // fast pan finds them already there. Sublayers are not clipped by
        // their superlayer, so without this the prefetched band would
        // composite outside the canvas, over the chat panel beside it. The
        // old overlay clipped implicitly, through `draw(_:)`.
        clipsToBounds = true
        contentLayer.anchorPoint = .zero
        layer.addSublayer(contentLayer)
        accessibilityIdentifier = "tutor-scene-overlay"
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(artifactDidBecomeReady),
            name: .boardSVGCacheDidRender,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(artifactDidBecomeReady),
            name: .boardSceneArtifactReady,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleMemoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("BoardSceneLayerView is created in code only")
    }

    /// The container sizes this view after `scene` may already be set, and a
    /// zero-size view culls everything away. The first real size has to re-run
    /// the cull or the board stays blank until the learner pans.
    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != lastCulledSize else { return }
        reconcile()
    }

    /// Called from the scroll delegate on every pan and zoom tick. It sets a
    /// transform; it never draws.
    func setViewport(contentOffset: CGPoint, zoomScale: CGFloat) {
        self.contentOffset = contentOffset
        // A scroll view that is still being configured can report a zoom of
        // zero, and every viewport rectangle below divides by this value.
        // Clamping once here keeps `nan` and infinity out of both the layer
        // transform (Core Animation traps on them) and the cull.
        self.zoomScale = zoomScale.isFinite && zoomScale > 0 ? zoomScale : 1
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // Drawing point p maps to view point `p * zoom - contentOffset`, which
        // is the transform the repaint overlay concatenated by hand.
        contentLayer.setAffineTransform(
            CGAffineTransform(translationX: -contentOffset.x, y: -contentOffset.y)
                .scaledBy(x: self.zoomScale, y: self.zoomScale)
        )
        CATransaction.commit()
        let bucket = ZoomBucket.bucket(forZoom: self.zoomScale)
        guard bucket == currentBucket else {
            // A new bucket invalidates every mounted bitmap's resolution.
            currentBucket = bucket
            reconcile()
            return
        }
        reconcileVisibilityOnly()
    }

    /// The culling decision: which element ids a viewport can show.
    ///
    /// Pure, and the only place the decision is made. `viewport` and the
    /// returned elements' bounds are both in drawing coordinates, expanded by
    /// `margin` drawing points on every side.
    static func visibleIds(
        scene: BoardScene,
        viewport: CGRect,
        boardOrigin: CGPoint,
        margin: CGFloat
    ) -> Set<String> {
        let expanded = viewport.insetBy(dx: -margin, dy: -margin)
        var ids: Set<String> = []
        for element in scene.elements {
            let bounds = BoardSceneRenderer.bounds(of: element, boardOrigin: boardOrigin)
            if bounds.intersects(expanded) { ids.insert(element.id) }
        }
        return ids
    }

    /// Everything the view can show right now, in drawing coordinates.
    private var drawingViewport: CGRect {
        CGRect(
            x: contentOffset.x / zoomScale,
            y: contentOffset.y / zoomScale,
            width: bounds.width / zoomScale,
            height: bounds.height / zoomScale
        )
    }

    /// Half a viewport of prefetch on every side. Dividing by the zoom keeps
    /// the band the same size on screen at any zoom, which is what matters:
    /// the band exists to stay ahead of a finger moving in screen points.
    private var cullMargin: CGFloat {
        max(bounds.width, bounds.height) / 2 / zoomScale
    }

    private func currentlyVisibleIds() -> Set<String> {
        Self.visibleIds(
            scene: scene,
            viewport: drawingViewport,
            boardOrigin: boardOrigin,
            margin: cullMargin
        )
    }

    /// Mounts what the viewport can see, unmounts what it cannot, and refreshes
    /// the bitmap of everything that stays.
    func reconcile() {
        lastCulledSize = bounds.size
        apply(visible: currentlyVisibleIds())
    }

    /// The pan path. A scroll tick that does not change the visible set has
    /// nothing to do — the transform already moved every mounted layer.
    private func reconcileVisibilityOnly() {
        let visible = currentlyVisibleIds()
        guard visible != mountedElementIds else { return }
        apply(visible: visible)
    }

    private func apply(visible: Set<String>) {
        // z-order is the scene's array order. The visible set does not carry
        // it, so each element's index travels with it.
        var elementsById: [String: (zOrder: Int, element: BoardElement)] = [:]
        elementsById.reserveCapacity(scene.elements.count)
        for (index, element) in scene.elements.enumerated() where elementsById[element.id] == nil {
            elementsById[element.id] = (index, element)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (id, layer) in elementLayers where !visible.contains(id) || elementsById[id] == nil {
            layer.removeFromSuperlayer()
            elementLayers[id] = nil
        }
        for id in visible {
            guard let entry = elementsById[id] else { continue }
            let bounds = BoardSceneRenderer.bounds(
                of: entry.element,
                boardOrigin: boardOrigin
            ).standardized
            guard Self.isMountable(bounds) else {
                // An element can also *become* degenerate through an update,
                // so this drops any layer it already had.
                unmount(id)
                continue
            }
            let layer = elementLayers[id] ?? makeElementLayer(id: id)
            // Sublayer order is the order layers were added, which the visible
            // set does not preserve, so the scene's order is restated here on
            // every pass rather than trusted to survive mounting.
            layer.zPosition = CGFloat(entry.zOrder)
            layer.frame = bounds
            layer.contents = raster(for: entry.element, bounds: bounds)
        }
        CATransaction.commit()
    }

    /// Every rectangle that reaches a `CALayer` passes through here. Core
    /// Animation traps on a `nan` or infinite frame, and a zero-area element
    /// has no bitmap to show, so neither is ever mounted. (An empty rectangle
    /// also fails `intersects`, so the cull normally drops these first; this
    /// is the guarantee, not the optimization.)
    private static func isMountable(_ rect: CGRect) -> Bool {
        rect.width > 0 && rect.height > 0
            && rect.minX.isFinite && rect.minY.isFinite
            && rect.width.isFinite && rect.height.isFinite
    }

    private func makeElementLayer(id: String) -> CALayer {
        let layer = CALayer()
        layer.anchorPoint = .zero
        contentLayer.addSublayer(layer)
        elementLayers[id] = layer
        return layer
    }

    private func unmount(_ id: String) {
        elementLayers[id]?.removeFromSuperlayer()
        elementLayers[id] = nil
    }

    /// The bitmap for one element at the current zoom bucket.
    ///
    /// Reconciling the two coordinate spaces is this method's duty, not the
    /// renderer's: `bounds(of:boardOrigin:)` returns drawing coordinates (the
    /// origin is already added) while `draw(element:in:)` draws in board
    /// coordinates (no origin). So the context translates by `-bounds.origin`
    /// to put the tile's top-left at the pixel origin, then by `+boardOrigin`
    /// to undo the origin that `bounds` added. The two cancel exactly, which
    /// is why the bitmap — and therefore `RasterKey` — does not depend on
    /// `boardOrigin`.
    private func raster(for element: BoardElement, bounds: CGRect) -> CGImage? {
        // An `svg` element whose WebKit artifact has not landed yet draws
        // nothing. `RasterKey` holds the element value, and that value does
        // not change when the artifact arrives, so an empty bitmap stored now
        // would be served for the rest of the session. Draw nothing, cache
        // nothing, and wait for `.boardSVGCacheDidRender` to reconcile.
        if case .svg(let value) = element, BoardSVGCache.shared.artifact(for: value) == nil {
            return nil
        }
        // `math_text` carries the same hazard and one more guard against it:
        // its bounds are `.zero` until the typeset lands, so `apply` unmounts
        // it rather than reaching here at all. This keeps the cache honest if
        // that ever changes.
        if case .mathText(let value) = element, BoardMathStore.shared.artifact(for: value) == nil {
            return nil
        }
        let key = RasterKey(element: element, bucket: currentBucket)
        if let cached = rasterCache.image(for: key) { return cached }
        // Two branches, by the element's size in board points. An absurd
        // element is refused; a merely large one is drawn whole at whatever
        // scale fits the pixel cap. A 1,000 x 1,000-point figure asks for
        // 64 million pixels at bucket 2 (4x bucket, 2x display), and a pinch
        // reaches that bucket, so refusing on pixels alone would make ordinary
        // figures vanish at high zoom. Soft beats invisible.
        let boardArea = bounds.width * bounds.height
        guard boardArea > 0, boardArea <= Self.maximumElementArea else { return nil }
        // The reduction depends only on the element's bounds and the bucket,
        // both of which `RasterKey` already identifies, so one key still means
        // exactly one bitmap.
        let scale = min(
            ZoomBucket.scale(forBucket: currentBucket) * displayScale,
            (Self.maximumRasterPixels / boardArea).squareRoot(),
            Self.maximumRasterSide / max(bounds.width, bounds.height)
        )
        // Flooring keeps the bitmap a whole number of pixels, which is what
        // makes the cap hold exactly rather than after a rounding-up. The
        // context is then scaled to the size that survived, so the element
        // still maps onto the whole tile instead of overflowing its last
        // fractional pixel.
        let pixelSize = CGSize(
            width: (bounds.width * scale).rounded(.down),
            height: (bounds.height * scale).rounded(.down)
        )
        guard pixelSize.width >= 1, pixelSize.height >= 1,
              pixelSize.width * pixelSize.height <= Self.maximumRasterPixels
        else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        // Board colours are sRGB hex. Extended range would buy nothing and
        // double every bitmap's bytes, which the cache's byte cap and the
        // pixel cap above are both priced in four bytes per pixel.
        format.preferredRange = .standard
        let image = UIGraphicsImageRenderer(size: pixelSize, format: format).image { context in
            let cg = context.cgContext
            cg.scaleBy(x: pixelSize.width / bounds.width, y: pixelSize.height / bounds.height)
            cg.translateBy(x: -bounds.minX, y: -bounds.minY)
            cg.translateBy(x: boardOrigin.x, y: boardOrigin.y)
            BoardSceneRenderer.draw(element: element, in: cg)
        }
        guard let cgImage = image.cgImage else { return nil }
        // Only whole bitmaps from this renderer pass are ever stored: the
        // cache prices an entry as `bytesPerRow * height`, which a cropped or
        // otherwise derived image would under-report.
        rasterCache.store(cgImage, for: key)
        return cgImage
    }

    /// A view that is not in a window yet reports a `displayScale` of 0, and a
    /// bitmap rendered at 0 is empty. Every device this ships on is 2x.
    private var displayScale: CGFloat {
        let scale = traitCollection.displayScale
        return scale > 0 ? scale : 2
    }

    /// `svg` elements draw empty until WebKit finishes, and nothing was cached
    /// for them, so one reconcile fills them in.
    @objc private func artifactDidBecomeReady() {
        reconcile()
    }

    /// The bitmaps are the largest thing this view owns and every one of them
    /// can be redrawn from the scene. Dropping the cache frees the off-screen
    /// ones outright; the reconcile that follows repaints only what the
    /// viewport can currently see.
    @objc private func handleMemoryWarning() {
        rasterCache.removeAll()
        reconcile()
    }
}
