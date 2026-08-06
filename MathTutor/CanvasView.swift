import PencilKit
import SwiftUI
import UIKit

enum PencilCanvasConfiguration {
    static let minimumZoomScale: CGFloat = 0.25
    static let maximumZoomScale: CGFloat = 3
    static let defaultZoomScale: CGFloat = 1

    /// The board is one very large fixed square rather than a page: ~18 screens
    /// of pan in every direction from the origin on a 12.9" iPad at 1x zoom.
    ///
    /// Growing the content on demand would be literally unbounded, but
    /// extending up or left means translating every existing stroke — and
    /// assigning `canvas.drawing` does not register with PencilKit's undo
    /// manager, so each shift would desynchronize undo. A fixed extent avoids
    /// that entirely. The magnitude is also deliberate: ink coordinates lose
    /// visible precision as 32-bit floats only in the millions, so 50,000
    /// leaves the far corners ~40x clear.
    static let boardExtent: CGFloat = 50_000

    /// Where a session starts, in drawing coordinates. Centering the viewport
    /// here is what makes panning up and left possible at all.
    static let boardOrigin = CGPoint(x: boardExtent / 2, y: boardExtent / 2)

    /// The widest span of board a single evaluation image may cover.
    ///
    /// `CanvasCapture.renderPNG` caps the longest rendered side at 2,000px, so
    /// the render scale is `2000 / span`. At 4,000pt that is 0.5, which keeps
    /// 50pt handwriting ~25px tall — still legible. An unbounded span would not:
    /// the evaluated region is the union of every stroke on a 50,000pt board, so
    /// one stray mark far from the work is enough to shrink a whole solution to
    /// a few pixels and get confident feedback on a smudge.
    static let maximumEvaluationSpan: CGFloat = 4_000

    static func contentSize(for viewport: CGSize) -> CGSize {
        CGSize(
            width: max(boardExtent, viewport.width),
            height: max(boardExtent, viewport.height)
        )
    }

    static func initialContentOffset(viewport: CGSize) -> CGPoint {
        CanvasScroller.offset(
            centering: CGRect(origin: boardOrigin, size: .zero),
            viewport: viewport,
            zoomScale: defaultZoomScale,
            scaledContentSize: contentSize(for: viewport)
        )
    }

    @MainActor
    static func configure(
        _ canvas: PKCanvasView,
        viewport: CGSize,
        preserveViewport: Bool = false
    ) {
        let previousZoomScale = canvas.zoomScale
        let previousContentOffset = canvas.contentOffset

        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.drawingPolicy = .pencilOnly
        canvas.isScrollEnabled = true
        canvas.contentInsetAdjustmentBehavior = .never
        canvas.minimumZoomScale = minimumZoomScale
        canvas.maximumZoomScale = maximumZoomScale
        canvas.contentSize = contentSize(for: viewport)
        // The board has no reachable edges, so edge padding would only distort
        // the offset math it was meant to soften.
        canvas.contentInset = .zero
        // A scroll indicator whose thumb is 2% of the track reports nothing.
        canvas.showsHorizontalScrollIndicator = false
        canvas.showsVerticalScrollIndicator = false
        canvas.alwaysBounceVertical = true
        canvas.alwaysBounceHorizontal = true

        // Native UIScrollView gestures handle finger navigation. Restricting
        // them to direct touches leaves PencilKit's pencil path free to ink.
        let directTouch = NSNumber(value: UITouch.TouchType.direct.rawValue)
        canvas.panGestureRecognizer.allowedTouchTypes = [directTouch]
        canvas.panGestureRecognizer.minimumNumberOfTouches = 1
        canvas.panGestureRecognizer.maximumNumberOfTouches = 2
        canvas.pinchGestureRecognizer?.allowedTouchTypes = [directTouch]
        canvas.pinchGestureRecognizer?.isEnabled = true

        if preserveViewport {
            canvas.setZoomScale(
                min(max(previousZoomScale, minimumZoomScale), maximumZoomScale),
                animated: false
            )
            canvas.contentOffset = previousContentOffset
        } else {
            canvas.setZoomScale(defaultZoomScale, animated: false)
            canvas.contentOffset = initialContentOffset(viewport: viewport)
        }
    }
}

enum CanvasScroller {
    /// The scroll offset that centers `target` in the viewport, clamped to the
    /// board's scrollable range.
    ///
    /// `target` is in unscaled PencilKit drawing coordinates, while
    /// `viewport`, `scaledContentSize`, and the returned offset are in the
    /// scroll view's scaled space — the same convention `CanvasViewportMapper`
    /// inverts. Pass `canvas.contentSize` for `scaledContentSize`; UIScrollView
    /// already folds `zoomScale` into it.
    static func offset(
        centering target: CGRect,
        viewport: CGSize,
        zoomScale: CGFloat,
        scaledContentSize: CGSize
    ) -> CGPoint {
        let scale = max(zoomScale, .leastNonzeroMagnitude)
        let proposed = CGPoint(
            x: target.midX * scale - viewport.width / 2,
            y: target.midY * scale - viewport.height / 2
        )
        // A viewport wider than the board (possible only at minimum zoom on a
        // hypothetical huge display) has no scroll range, hence the max(0,).
        let maximum = CGPoint(
            x: max(0, scaledContentSize.width - viewport.width),
            y: max(0, scaledContentSize.height - viewport.height)
        )
        return CGPoint(
            x: min(max(proposed.x, 0), maximum.x),
            y: min(max(proposed.y, 0), maximum.y)
        )
    }
}

enum CanvasViewportMapper {
    /// Converts a rectangle in the canvas viewport (frame) coordinate space to
    /// the unscaled PencilKit drawing coordinate space. `canvasBounds` carries
    /// the current pan offset in the scaled viewport; dividing the complete
    /// coordinate by zoom keeps selected content stable while zooming.
    static func drawingRect(
        for viewportRect: CGRect,
        canvasBounds: CGRect,
        zoomScale: CGFloat
    ) -> CGRect {
        let scale = max(zoomScale, .leastNonzeroMagnitude)
        return CGRect(
            x: (canvasBounds.minX + viewportRect.minX) / scale,
            y: (canvasBounds.minY + viewportRect.minY) / scale,
            width: viewportRect.width / scale,
            height: viewportRect.height / scale
        )
    }
}

@MainActor
final class CanvasCapture: ObservableObject {
    weak var canvasView: PKCanvasView?

    func undo() { canvasView?.undoManager?.undo() }
    func redo() { canvasView?.undoManager?.redo() }
    func clear() { canvasView?.drawing = PKDrawing() }

    /// Scrolls the board to the student's ink, or back to the session origin
    /// when the board is empty. This is also how sessions saved before the
    /// board became infinite stay usable: their strokes sit near the board's
    /// top-left corner, and scrolling to them beats rewriting stored drawings.
    func centerOnContent(animated: Bool) {
        guard let canvasView else { return }
        let viewport = canvasView.bounds.size
        guard viewport.width > 0, viewport.height > 0 else { return }

        let inkBounds = canvasView.drawing.bounds
        let target = inkBounds.isNull || inkBounds.isEmpty
            ? CGRect(origin: PencilCanvasConfiguration.boardOrigin, size: .zero)
            : inkBounds

        canvasView.setContentOffset(
            CanvasScroller.offset(
                centering: target,
                viewport: viewport,
                zoomScale: canvasView.zoomScale,
                scaledContentSize: canvasView.contentSize
            ),
            animated: animated
        )
    }

    func snapshotData(region: CGRect? = nil) -> Data? {
        guard let canvasView else { return nil }
        let viewport = CGRect(origin: .zero, size: canvasView.bounds.size)
        let requestedViewport = (region ?? viewport).intersection(viewport)
        guard !requestedViewport.isNull, requestedViewport.width > 0, requestedViewport.height > 0 else {
            return nil
        }
        let requested = CanvasViewportMapper.drawingRect(
            for: requestedViewport,
            canvasBounds: canvasView.bounds,
            zoomScale: canvasView.zoomScale
        )
        return renderPNG(drawingRect: requested)
    }

    /// Whether a drawing carries ink that board evaluation can render. This is
    /// exactly `snapshotAllInkData()`'s own precondition, so a control gated on
    /// it is available precisely when evaluation would produce an image.
    static func hasEvaluableInk(in drawing: PKDrawing?) -> Bool {
        guard let drawing else { return false }
        let bounds = drawing.bounds
        return !bounds.isNull && bounds.width > 0 && bounds.height > 0
    }

    /// Whether the attached board currently has anything to evaluate.
    var hasInk: Bool { Self.hasEvaluableInk(in: canvasView?.drawing) }

    /// Every stroke on the board, regardless of where the student has scrolled.
    /// A viewport-bounded capture would silently truncate a long solution that
    /// has been panned off screen, which an infinite board makes easy to do.
    ///
    /// `coversAllInk` is `false` exactly when the ink spans more board than one
    /// legible image can hold and the region was cropped to the student's work.
    /// Callers must say so rather than describing the result as the whole board.
    func snapshotAllInkData() -> (data: Data, coversAllInk: Bool)? {
        guard let canvasView, Self.hasEvaluableInk(in: canvasView.drawing) else { return nil }
        let padded = canvasView.drawing.bounds.insetBy(dx: -24, dy: -24)
        let span = PencilCanvasConfiguration.maximumEvaluationSpan
        let coversAllInk = padded.width <= span && padded.height <= span
        let region = coversAllInk
            ? padded
            : Self.workCenteredRegion(of: canvasView.drawing, span: span)
        guard let data = renderPNG(drawingRect: region) else { return nil }
        return (data, coversAllInk)
    }

    /// A `span`-square region centered on the centroid of the strokes' own
    /// bounding-box centers.
    ///
    /// The centroid, deliberately, and not the center of `drawing.bounds`: with
    /// a hundred strokes of real work and one stray dot far away, the average of
    /// the stroke centers still sits on the work, while the bounding box's
    /// center is dragged halfway to the dot and can miss both.
    private static func workCenteredRegion(of drawing: PKDrawing, span: CGFloat) -> CGRect {
        let centers = drawing.strokes.map { stroke in
            CGPoint(x: stroke.renderBounds.midX, y: stroke.renderBounds.midY)
        }
        let centroid = centers.isEmpty
            ? CGPoint(x: drawing.bounds.midX, y: drawing.bounds.midY)
            : CGPoint(
                x: centers.reduce(0) { $0 + $1.x } / CGFloat(centers.count),
                y: centers.reduce(0) { $0 + $1.y } / CGFloat(centers.count)
            )
        let region = square(around: centroid, span: span)
        // Two comparable clusters far apart put the centroid in the empty gap
        // between them, and a region containing no strokes renders as blank
        // paper the tutor would grade in good faith. Fall back to the stroke
        // nearest that midpoint so the image always carries ink.
        if drawing.strokes.contains(where: { $0.renderBounds.intersects(region) }) {
            return region
        }
        guard let nearest = centers.min(by: { first, second in
            hypot(first.x - centroid.x, first.y - centroid.y)
                < hypot(second.x - centroid.x, second.y - centroid.y)
        }) else { return region }
        return square(around: nearest, span: span)
    }

    private static func square(around center: CGPoint, span: CGFloat) -> CGRect {
        CGRect(x: center.x - span / 2, y: center.y - span / 2, width: span, height: span)
    }

    private func renderPNG(drawingRect requested: CGRect) -> Data? {
        guard let canvasView, requested.width > 0, requested.height > 0 else { return nil }

        // Keep handwriting crisp without sending an unnecessarily huge original-detail
        // image. A white background also avoids ambiguous transparent-PNG rendering.
        let maximumDimension: CGFloat = 2_000
        let scale = min(2, maximumDimension / max(requested.width, requested.height))
        // Evaluation images use a white paper background. Normalize ink colors
        // for this derived image so light PencilKit strokes remain visible instead
        // of disappearing into that background. The live drawing is never mutated.
        let evaluationDrawing = canvasView.drawing.strokes.isEmpty
            ? canvasView.drawing
            : PKDrawing(strokes: canvasView.drawing.strokes.map { stroke in
                PKStroke(
                    ink: PKInk(stroke.ink.inkType, color: .black),
                    path: stroke.path,
                    transform: stroke.transform,
                    mask: stroke.mask,
                    randomSeed: stroke.randomSeed
                )
            })
        let pixelSize = CGSize(width: requested.width * scale, height: requested.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        var image: UIImage?
        // PencilKit resolves some ink colors through the current trait collection
        // while rasterizing. Evaluation always flattens onto white paper, so use
        // an explicit light trait for both PencilKit and UIKit rendering. This is
        // scoped to the derived image and never changes the live canvas/drawing.
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            let drawingImage = evaluationDrawing.image(from: requested, scale: scale)
            image = UIGraphicsImageRenderer(size: pixelSize, format: format).image { context in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: pixelSize))
                drawingImage.draw(in: CGRect(origin: .zero, size: pixelSize))
            }
        }
        return image?.pngData()
    }
}

/// A `PKCanvasView` that reports its laid-out size.
///
/// Board setup depends on the viewport, but SwiftUI only re-invokes
/// `updateUIView` when one of the representable's own arguments changes — not
/// when Auto Layout finally gives the canvas a real size. Depending on that
/// meant a cold launch configured the board against a zero viewport and never
/// corrected it. UIKit's layout pass is the signal that actually tracks
/// geometry.
final class BoardCanvasView: PKCanvasView {
    /// Called on each layout pass whose size differs from the last reported
    /// one, skipping empty sizes. The first call is the board's real start.
    var onViewportChange: ((CGSize) -> Void)?

    private var reportedViewport: CGSize?

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = bounds.size
        guard size.width > 0, size.height > 0, size != reportedViewport else { return }
        reportedViewport = size
        onViewportChange?(size)
    }
}

struct PencilCanvasView: UIViewRepresentable {
    @ObservedObject var capture: CanvasCapture
    let initialDrawingData: Data?
    /// Whether the whiteboard owns input focus and should present PencilKit's
    /// native tool picker. The canvas stays mounted while the full tutor chat
    /// is shown, so this explicit contract keeps UIKit focus in sync with the
    /// SwiftUI overlay state.
    let isActive: Bool
    let onDrawingChange: (PKDrawing) -> Void
    let onUndo: () -> Void
    let onRedo: () -> Void

    init(
        capture: CanvasCapture,
        initialDrawingData: Data?,
        isActive: Bool = true,
        onDrawingChange: @escaping (PKDrawing) -> Void,
        onUndo: @escaping () -> Void,
        onRedo: @escaping () -> Void
    ) {
        self.capture = capture
        self.initialDrawingData = initialDrawingData
        self.isActive = isActive
        self.onDrawingChange = onDrawingChange
        self.onUndo = onUndo
        self.onRedo = onRedo
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> BoardCanvasView {
        let canvas = BoardCanvasView(frame: .zero)
        PencilCanvasConfiguration.configure(canvas, viewport: .zero)
        // The first viewport report centers the board on the restored ink
        // through `capture`, so the capture must already know the canvas by
        // the time that closure can fire.
        context.coordinator.canvas = canvas
        capture.canvasView = canvas
        if let initialDrawingData, let drawing = try? PKDrawing(data: initialDrawingData) {
            canvas.drawing = drawing
        }

        // UIKit's own layout pass — not SwiftUI's update cycle — is what
        // reliably knows the canvas's real size. The canvas owns this closure,
        // so `canvas` itself is captured weakly to avoid a retain cycle;
        // `coordinator` doesn't hold the canvas strongly (it holds it `weak`),
        // so it is safe to capture normally.
        //
        // This assignment must stay below the drawing restore: if a layout pass
        // fired in between, the first report would center an empty board and
        // latch the first-report flag, so a session's saved ink would be left
        // off screen again. Do not tidy it upward.
        let coordinator = context.coordinator
        canvas.onViewportChange = { [weak canvas] size in
            guard let canvas else { return }
            coordinator.handleViewportChange(canvas: canvas, size: size)
        }

        // Install the delegate after restoring persisted ink so the initial load
        // does not publish a drawing change while SwiftUI is still updating views.
        canvas.delegate = context.coordinator

        let toolPicker = PKToolPicker()
        toolPicker.addObserver(canvas)
        context.coordinator.toolPicker = toolPicker
        context.coordinator.updateActivation(isActive)

        let undoTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.twoFingerUndo))
        undoTap.numberOfTouchesRequired = 2
        undoTap.numberOfTapsRequired = 1
        undoTap.delegate = context.coordinator
        canvas.addGestureRecognizer(undoTap)

        let redoTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.threeFingerRedo))
        redoTap.numberOfTouchesRequired = 3
        redoTap.numberOfTapsRequired = 1
        redoTap.delegate = context.coordinator
        canvas.addGestureRecognizer(redoTap)
        return canvas
    }

    func updateUIView(_ canvas: BoardCanvasView, context: Context) {
        context.coordinator.parent = self
        capture.canvasView = canvas
        // Showing or hiding full chat doesn't change the canvas bounds, but
        // it does change which view should own first responder and the tool
        // picker. Viewport-driven setup lives in `BoardCanvasView.onViewportChange`.
        context.coordinator.updateActivation(isActive)
    }

    static func dismantleUIView(_ uiView: BoardCanvasView, coordinator: Coordinator) {
        coordinator.teardown(canvas: uiView)
    }

    final class Coordinator: NSObject, PKCanvasViewDelegate, UIGestureRecognizerDelegate {
        var parent: PencilCanvasView
        weak var canvas: BoardCanvasView?
        var toolPicker: PKToolPicker?
        /// Whether `BoardCanvasView.onViewportChange` has fired at least
        /// once. Doubles as the "first report vs. later" routing signal: the
        /// first report configures fresh and centers on ink; every later one
        /// (rotation, split view) preserves the viewport instead.
        var didConfigure = false

        init(_ parent: PencilCanvasView) { self.parent = parent }

        /// Routes a `BoardCanvasView` layout report to board setup. The first
        /// report configures the board fresh and opens it on the session's
        /// existing ink; every later one (rotation, split view) preserves the
        /// viewport instead.
        func handleViewportChange(canvas: BoardCanvasView, size: CGSize) {
            let isFirstReport = !didConfigure
            PencilCanvasConfiguration.configure(canvas, viewport: size, preserveViewport: !isFirstReport)
            didConfigure = true
            // `configure` can only center the board origin — it never sees the
            // drawing. Restored ink wins over that default, but only on the
            // first real layout: later viewport changes must not yank a
            // panned-away student back to their strokes.
            if isFirstReport {
                parent.capture.centerOnContent(animated: false)
            }
        }

        /// Synchronizes UIKit's first-responder/tool-picker state with the
        /// SwiftUI whiteboard visibility contract. We apply the active path on
        /// every update (rather than only when the flag changes) so an early
        /// `becomeFirstResponder()` failure while the view is being mounted is
        /// retried by the next SwiftUI update.
        func updateActivation(_ active: Bool) {
            guard let canvas else { return }

            if active {
                toolPicker?.setVisible(true, forFirstResponder: canvas)
                canvas.becomeFirstResponder()
            } else {
                toolPicker?.setVisible(false, forFirstResponder: canvas)
                canvas.resignFirstResponder()
            }
        }

        func teardown(canvas: PKCanvasView) {
            toolPicker?.setVisible(false, forFirstResponder: canvas)
            canvas.resignFirstResponder()
            toolPicker?.removeObserver(canvas)
            toolPicker = nil
            self.canvas = nil
        }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            parent.onDrawingChange(canvasView.drawing)
        }

        @objc func twoFingerUndo() {
            parent.onUndo()
        }

        @objc func threeFingerRedo() {
            parent.onRedo()
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            false
        }
    }
}

#if DEBUG
/// A deterministic, vector-only PencilKit fixture for simulator/device E2E runs.
/// It is intentionally compiled out of release builds and is only applied by the
/// `--e2e-seed-radical-attempt` launch argument in `TutorStore`.
enum E2ESeedFixture {
    static let launchArgument = "--e2e-seed-radical-attempt"

    private struct Glyph {
        let width: CGFloat
        let strokes: [[CGPoint]]
    }

    private static let glyphs: [Character: Glyph] = [
        "0": Glyph(width: 42, strokes: [[CGPoint(x: 0.5, y: 0), CGPoint(x: 0.15, y: 0.14), CGPoint(x: 0, y: 0.5), CGPoint(x: 0.15, y: 0.86), CGPoint(x: 0.5, y: 1), CGPoint(x: 0.85, y: 0.86), CGPoint(x: 1, y: 0.5), CGPoint(x: 0.85, y: 0.14), CGPoint(x: 0.5, y: 0)]]),
        "1": Glyph(width: 32, strokes: [[CGPoint(x: 0.18, y: 0.2), CGPoint(x: 0.5, y: 0), CGPoint(x: 0.5, y: 1)], [CGPoint(x: 0.15, y: 1), CGPoint(x: 0.85, y: 1)]]),
        "2": Glyph(width: 42, strokes: [[CGPoint(x: 0.08, y: 0.18), CGPoint(x: 0.25, y: 0.02), CGPoint(x: 0.7, y: 0), CGPoint(x: 0.98, y: 0.2), CGPoint(x: 0.88, y: 0.42), CGPoint(x: 0.08, y: 1), CGPoint(x: 0.98, y: 1)]]),
        "3": Glyph(width: 42, strokes: [[CGPoint(x: 0.08, y: 0.08), CGPoint(x: 0.85, y: 0.08), CGPoint(x: 0.52, y: 0.48), CGPoint(x: 0.8, y: 0.48), CGPoint(x: 0.98, y: 0.68), CGPoint(x: 0.82, y: 0.98), CGPoint(x: 0.08, y: 0.98)]]),
        "4": Glyph(width: 42, strokes: [[CGPoint(x: 0.72, y: 0), CGPoint(x: 0.72, y: 1)], [CGPoint(x: 0.04, y: 0.64), CGPoint(x: 0.98, y: 0.64)], [CGPoint(x: 0.04, y: 0.64), CGPoint(x: 0.62, y: 0)]]),
        "5": Glyph(width: 42, strokes: [[CGPoint(x: 0.92, y: 0.04), CGPoint(x: 0.12, y: 0.04), CGPoint(x: 0.08, y: 0.48), CGPoint(x: 0.72, y: 0.48), CGPoint(x: 0.96, y: 0.7), CGPoint(x: 0.78, y: 0.98), CGPoint(x: 0.08, y: 0.98)]]),
        "x": Glyph(width: 42, strokes: [[CGPoint(x: 0.08, y: 0.1), CGPoint(x: 0.92, y: 0.9)], [CGPoint(x: 0.92, y: 0.1), CGPoint(x: 0.08, y: 0.9)]]),
        "o": Glyph(width: 42, strokes: [[CGPoint(x: 0.5, y: 0.08), CGPoint(x: 0.16, y: 0.2), CGPoint(x: 0.06, y: 0.52), CGPoint(x: 0.2, y: 0.88), CGPoint(x: 0.56, y: 0.96), CGPoint(x: 0.88, y: 0.78), CGPoint(x: 0.94, y: 0.42), CGPoint(x: 0.78, y: 0.12), CGPoint(x: 0.5, y: 0.08)]]),
        "r": Glyph(width: 36, strokes: [[CGPoint(x: 0.1, y: 0.04), CGPoint(x: 0.1, y: 1)], [CGPoint(x: 0.1, y: 0.24), CGPoint(x: 0.38, y: 0.08), CGPoint(x: 0.82, y: 0.18)]]),
        "+": Glyph(width: 38, strokes: [[CGPoint(x: 0.5, y: 0.08), CGPoint(x: 0.5, y: 0.92)], [CGPoint(x: 0.08, y: 0.5), CGPoint(x: 0.92, y: 0.5)]]),
        "−": Glyph(width: 38, strokes: [[CGPoint(x: 0.08, y: 0.5), CGPoint(x: 0.92, y: 0.5)]]),
        "=": Glyph(width: 42, strokes: [[CGPoint(x: 0.08, y: 0.35), CGPoint(x: 0.92, y: 0.35)], [CGPoint(x: 0.08, y: 0.68), CGPoint(x: 0.92, y: 0.68)]]),
        "(": Glyph(width: 24, strokes: [[CGPoint(x: 0.86, y: 0), CGPoint(x: 0.35, y: 0.5), CGPoint(x: 0.86, y: 1)]]),
        ")": Glyph(width: 24, strokes: [[CGPoint(x: 0.14, y: 0), CGPoint(x: 0.65, y: 0.5), CGPoint(x: 0.14, y: 1)]]),
        "√": Glyph(width: 62, strokes: [[CGPoint(x: 0.02, y: 0.48), CGPoint(x: 0.2, y: 0.78), CGPoint(x: 0.39, y: 0.06)], [CGPoint(x: 0.39, y: 0.06), CGPoint(x: 0.98, y: 0.06)] ]),
        "²": Glyph(width: 30, strokes: [[CGPoint(x: 0.06, y: 0.28), CGPoint(x: 0.2, y: 0.04), CGPoint(x: 0.62, y: 0.04), CGPoint(x: 0.9, y: 0.26), CGPoint(x: 0.06, y: 0.94), CGPoint(x: 0.94, y: 0.94)]])
    ]

    private static let lines = [
        "√(x + 5) = x − 1",
        "x + 5 = (x − 1)²",
        "x + 5 = x² − 2x + 1",
        "0 = x² − 3x − 4",
        "0 = (x − 4)(x + 1)",
        "x = 4 or x = −1"
    ]

    static func drawing() -> PKDrawing {
        let ink = PKInk(.pen, color: .black)
        let strokes = lines.enumerated().flatMap { lineIndex, line in
            // Keep every line below the exercise card/top bar and above the native
            // tool picker so the seeded attempt is fully visible on an iPad board.
            makeLine(line, origin: CGPoint(x: 84, y: 410 + CGFloat(lineIndex) * 60), ink: ink)
        }
        return PKDrawing(strokes: strokes)
    }

    static func drawingData() -> Data { drawing().dataRepresentation() }

    static func seedSession(_ session: inout LearningSession) {
        session.plan = .radicalEquation
        session.exercise = .radicalEquation
        session.drawingData = drawingData()
        session.lastSavedAt = .now
    }

    private static func makeLine(_ line: String, origin: CGPoint, ink: PKInk) -> [PKStroke] {
        let baselineHeight: CGFloat = 52
        var cursor = origin.x
        var result: [PKStroke] = []
        for character in line {
            if character == " " {
                cursor += 24
                continue
            }
            guard let glyph = glyphs[character] else {
                cursor += 30
                continue
            }
            let isSuperscript = character == "²"
            let scale = isSuperscript ? CGSize(width: 0.62, height: 0.62) : CGSize(width: 1, height: 1)
            let yOffset = isSuperscript ? -18 : 0
            for template in glyph.strokes {
                let points = template.map { point in
                    CGPoint(
                        x: cursor + point.x * glyph.width * scale.width,
                        y: origin.y + CGFloat(yOffset) + point.y * baselineHeight * scale.height
                    )
                }
                result.append(makeStroke(points, ink: ink))
            }
            cursor += glyph.width * scale.width + 8
        }
        return result
    }

    private static func makeStroke(_ points: [CGPoint], ink: PKInk) -> PKStroke {
        let controlPoints = points.enumerated().map { index, point in
            PKStrokePoint(
                location: point,
                timeOffset: Double(index) * 0.02,
                size: CGSize(width: 5, height: 5),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        let path = PKStrokePath(controlPoints: controlPoints, creationDate: Date(timeIntervalSinceReferenceDate: 0))
        return PKStroke(ink: ink, path: path, transform: .identity, mask: nil, randomSeed: 7)
    }
}
#endif
