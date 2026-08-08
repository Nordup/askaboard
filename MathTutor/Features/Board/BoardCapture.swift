import Combine
import PencilKit
import UIKit

@MainActor
final class CanvasCapture: ObservableObject {
    weak var canvasView: PKCanvasView?

    func undo() { canvasView?.undoManager?.undo() }
    func redo() { canvasView?.undoManager?.redo() }
    func clear() {
        canvasView?.drawing = PKDrawing()
        // Assigning `drawing` does not go through `PKCanvasViewDelegate`, so this
        // is the one emptying of the board that has to report itself.
        refreshHasInk()
    }

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
    ///
    /// Published rather than computed, because a control that is only meaningful
    /// on a board with work on it has to be able to *redraw* when the first
    /// stroke lands — and a computed property reading through a `weak` canvas
    /// reference gives SwiftUI nothing to observe. `refreshHasInk` writes only on
    /// a change of the boolean, so an ordinary session publishes this once: the
    /// board goes from empty to written-on and stays there.
    @Published private(set) var hasInk = false

    /// Re-reads the board. Called from the canvas's drawing delegate, which is
    /// the only thing that knows when the answer can have changed.
    func refreshHasInk() {
        let current = Self.hasEvaluableInk(in: canvasView?.drawing)
        guard current != hasInk else { return }
        hasInk = current
    }

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

    /// Everywhere the learner has written, as one rectangle.
    ///
    /// The whole extent, however sparse — no span cap and no cluster picking.
    /// That is only affordable because nothing reads this image: it is the
    /// thumbnail the tutor *aims* with, and anything it wants to read it asks
    /// for by region and this class renders fresh. When the server did the
    /// cropping, this had to be a guess at which 4,000pt window mattered, made
    /// before the model had said a word — and on a board with two clusters of
    /// work that guess sent the problems the learner had already finished
    /// instead of the one they were asking about.
    static func inkExtent(of drawing: PKDrawing) -> CGRect? {
        guard hasEvaluableInk(in: drawing) else { return nil }
        return drawing.bounds.insetBy(dx: -24, dy: -24)
    }

    /// The overview that rides on every turn: the whole board, small.
    ///
    /// Small on purpose. It is attached whether the tutor looks or not, so its
    /// job is to cost almost nothing and to be aimable — not to be legible. The
    /// full-resolution upload this replaced spent ~160KB a turn, including every
    /// turn where the model never looked at all.
    func overviewData() -> Data? {
        guard let canvasView, let extent = Self.inkExtent(of: canvasView.drawing) else { return nil }
        return renderPNG(drawingRect: extent, maximumDimension: Self.overviewMaximumDimension)
    }

    /// One region of the board, rendered now, at a resolution worth reading.
    ///
    /// `percent` is the rectangle the model asked for in percent of the
    /// overview, origin top left — the only coordinate system legible in the
    /// picture it was looking at when it chose. This maps that back onto the
    /// same ink extent `overviewData()` drew and renders it from the vectors, so
    /// a tutor zooming into one line of working gets that line at full detail
    /// rather than an upscale of a thumbnail. That is the whole reason this
    /// moved off the server.
    func renderRegion(percent: CGRect) -> Data? {
        guard let canvasView, let extent = Self.inkExtent(of: canvasView.drawing) else { return nil }
        return renderPNG(
            drawingRect: Self.drawingRect(forPercent: percent, in: extent),
            maximumDimension: Self.regionMaximumDimension
        )
    }

    /// Maps a percent-of-overview rectangle onto board coordinates.
    ///
    /// Clamped into the extent rather than trusted: the numbers are
    /// model-authored, and a region running off the edge means "the far end of
    /// the work" rather than an error worth spending a tool round on. A zero
    /// side would render nothing at all, so both are floored.
    static func drawingRect(forPercent percent: CGRect, in extent: CGRect) -> CGRect {
        let width = min(100, max(1, percent.width)) / 100 * extent.width
        let height = min(100, max(1, percent.height)) / 100 * extent.height
        let x = extent.minX + min(max(0, percent.minX), 100) / 100 * extent.width
        let y = extent.minY + min(max(0, percent.minY), 100) / 100 * extent.height
        return CGRect(
            x: min(x, extent.maxX - width),
            y: min(y, extent.maxY - height),
            width: width,
            height: height
        )
    }

    /// What the tutor is told about where the ink sits.
    ///
    /// The overview alone is not always aimable: a board whose writing occupies
    /// two percent of a very large empty field renders as a few specks, and a
    /// model looking at specks cannot choose a region worth asking for. So the
    /// device — which knows the strokes, their positions and when each was
    /// drawn — says it in words, in the same percent coordinates the tool takes.
    ///
    /// Recency is included because it is the one thing the picture cannot show
    /// and the tutor most needs: on a board carrying both today's work and
    /// yesterday's, "written most recently" is what distinguishes the problem
    /// being asked about from the one already finished.
    func manifest() -> String? {
        guard let canvasView, let extent = Self.inkExtent(of: canvasView.drawing) else { return nil }
        let clusters = Self.clusters(of: canvasView.drawing)
        guard clusters.count > 1 else { return nil }

        let ordered = clusters.sorted { $0.newest > $1.newest }
        let lines = ordered.enumerated().map { index, cluster -> String in
            let box = cluster.box
            let x = (box.minX - extent.minX) / extent.width * 100
            let y = (box.minY - extent.minY) / extent.height * 100
            let width = box.width / extent.width * 100
            let height = box.height / extent.height * 100
            let age = index == 0 ? "most recently written" : "older"
            return String(
                format: "  - area %d (%@): x %.0f%%, y %.0f%%, %.0f%% wide, %.0f%% tall, %d strokes",
                index + 1, age as NSString, x, y, max(1, width), max(1, height), cluster.count
            )
        }
        let heading = "WHERE THE WRITING IS: the board has \(ordered.count) separate areas of "
            + "writing, far enough apart that most of the overview is blank. Aim `view_board` "
            + "at one of these rather than at the whole board:"
        return ([heading] + lines).joined(separator: "\n")
    }

    /// Groups strokes that sit near each other into areas of writing.
    ///
    /// A greedy single pass rather than a real clustering algorithm, because the
    /// question is only ever "is this the same piece of work?" and the answer is
    /// a matter of hundreds of points on a fifty-thousand-point board. The
    /// threshold is `--space-content`-ish in board terms: far enough that two
    /// lines of the same working never split, close enough that work done in a
    /// different part of the board never merges.
    static func clusters(of drawing: PKDrawing) -> [(box: CGRect, count: Int, newest: Date)] {
        var clusters: [(box: CGRect, count: Int, newest: Date)] = []
        for stroke in drawing.strokes {
            let bounds = stroke.renderBounds
            let written = stroke.path.creationDate
            if let index = clusters.firstIndex(where: {
                $0.box.insetBy(dx: -clusterGap, dy: -clusterGap).intersects(bounds)
            }) {
                clusters[index] = (
                    clusters[index].box.union(bounds),
                    clusters[index].count + 1,
                    max(clusters[index].newest, written)
                )
            } else {
                clusters.append((bounds, 1, written))
            }
        }
        return clusters
    }

    /// **Not a design value.** 600pt is roughly two lines of handwriting: close
    /// enough that a worked solution stays one area, far enough that a fresh
    /// start elsewhere on the board reads as a different one.
    private static let clusterGap: CGFloat = 600

    /// The long side of the overview, in pixels. Aiming, not reading.
    private static let overviewMaximumDimension: CGFloat = 900

    /// The long side of a rendered region, in pixels.
    ///
    /// Reading size. Handwriting whose x-height is ~50 board points lands well
    /// past legible here for any region a tutor sensibly asks for, and the cap
    /// is what stops a model that asks for the whole board being charged for a
    /// multi-megapixel image it cannot use.
    private static let regionMaximumDimension: CGFloat = 1_536

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

    /// - Parameter maximumDimension: The long side of the rendered PNG, in
    ///   pixels. 2,000 for an image that goes straight into the model's context;
    ///   `boardMaximumDimension` for the board upload the server crops from. It
    ///   is a parameter rather than a constant because those two answers are set
    ///   by different things — see `boardData()`.
    private func renderPNG(drawingRect requested: CGRect, maximumDimension: CGFloat = 2_000) -> Data? {
        guard let canvasView, requested.width > 0, requested.height > 0 else { return nil }

        // Keep handwriting crisp without sending an unnecessarily huge original-detail
        // image. A white background also avoids ambiguous transparent-PNG rendering.
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
