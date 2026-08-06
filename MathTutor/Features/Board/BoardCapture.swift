import Combine
import PencilKit
import UIKit

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

    /// The ink an evaluation image draws a stroke with.
    ///
    /// Evaluation flattens the board onto white paper, so ink colours are
    /// normalized rather than sent as drawn: a pale stroke would otherwise
    /// disappear into that background. For a mark that is meant to be opaque,
    /// solid black is exactly right.
    ///
    /// For a highlighter it is exactly wrong. `PKInk(.marker, color: .black)`
    /// discards the 0.3 alpha `BoardInk` gives the rail's one-tap highlighter
    /// and paints an opaque band straight over the working the student swiped it
    /// across — the tutor is handed a censor bar where the answer used to be.
    /// So translucent inks keep their transparency and only have their hue
    /// normalized: the band still reads as a grey stripe on white paper, and the
    /// ink underneath still reads through it.
    ///
    /// The alpha is capped at the rail's own `highlighterAlpha` rather than
    /// taken as drawn, because a saved session may carry a marker stroke from
    /// the days of `PKToolPicker` at any opacity, including 1. Capping can only
    /// ever make a band fainter, so it can never hide working.
    private static func evaluationInk(for ink: PKInk) -> PKInk {
        switch ink.inkType {
        case .marker, .watercolor:
            let alpha = min(ink.color.cgColor.alpha, BoardInk.highlighterAlpha)
            return PKInk(ink.inkType, color: UIColor.black.withAlphaComponent(alpha))
        default:
            // Pen, pencil, and every opaque ink a later OS adds. Defaulting an
            // unrecognized ink to solid black keeps the light-ink guarantee; the
            // named cases above are the only ones that trade it for legibility
            // of what lies beneath.
            return PKInk(ink.inkType, color: .black)
        }
    }

    private func renderPNG(drawingRect requested: CGRect) -> Data? {
        guard let canvasView, requested.width > 0, requested.height > 0 else { return nil }

        // Keep handwriting crisp without sending an unnecessarily huge original-detail
        // image. A white background also avoids ambiguous transparent-PNG rendering.
        let maximumDimension: CGFloat = 2_000
        let scale = min(2, maximumDimension / max(requested.width, requested.height))
        let drawing = canvasView.drawing
        let pixelSize = CGSize(width: requested.width * scale, height: requested.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        var image: UIImage?
        // PencilKit resolves some ink colors through the current trait collection
        // while rasterizing. Evaluation always flattens onto white paper, so use
        // an explicit light trait for the ink normalization below as well as for
        // PencilKit and UIKit rendering. This is scoped to the derived image and
        // never changes the live canvas/drawing.
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            let evaluationDrawing = drawing.strokes.isEmpty
                ? drawing
                : PKDrawing(strokes: drawing.strokes.map { stroke in
                    PKStroke(
                        ink: Self.evaluationInk(for: stroke.ink),
                        path: stroke.path,
                        transform: stroke.transform,
                        mask: stroke.mask,
                        randomSeed: stroke.randomSeed
                    )
                })
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
