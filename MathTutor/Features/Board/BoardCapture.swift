import Combine
import PencilKit
import UIKit

@MainActor
final class CanvasCapture: ObservableObject {
    weak var canvasView: PKCanvasView?
    /// The tutor-authored semantic scene, set by the live canvas representable
    /// from `TutorStore.session.boardScene`.
    var scene: BoardScene = .empty

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

        var target = canvasView.drawing.bounds
        if let sceneBounds = BoardSceneRenderer.bounds(
            of: scene,
            boardOrigin: PencilCanvasConfiguration.boardOrigin
        ) {
            target = target.isNull ? sceneBounds : target.union(sceneBounds)
        }
        if target.isNull || target.isEmpty {
            target = CGRect(origin: PencilCanvasConfiguration.boardOrigin, size: .zero)
        }

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

    /// One region of the board, rendered from the vectors.
    ///
    /// - Parameter drawingRegion: what to render, **in drawing coordinates**, or
    ///   `nil` for whatever is on screen right now.
    ///
    /// It used to take a viewport rectangle and intersect it with the canvas's
    /// current bounds, and that intersection is the bug this signature closes.
    /// A region the learner picked is a region of their *work*; the canvas's
    /// bounds are a fact about the window, and they move — the keyboard alone
    /// took a third of the board's height. A picked region that had scrolled or
    /// been resized out of view intersected to nothing, this returned nil, and
    /// `BoardScreen.send` quietly sent the question without the picture.
    ///
    /// Drawing coordinates have no such dependency: the strokes are where they
    /// have always been, so the render is correct whether the region is on
    /// screen, half off it, or behind the keyboard.
    func snapshotData(drawingRegion: CGRect? = nil) -> Data? {
        guard let canvasView else { return nil }
        let requested = drawingRegion ?? CanvasViewportMapper.drawingRect(
            for: CGRect(origin: .zero, size: canvasView.bounds.size),
            canvasBounds: canvasView.bounds,
            zoomScale: canvasView.zoomScale
        )
        guard requested.width > 0, requested.height > 0 else { return nil }
        return renderPNG(drawingRect: requested)
    }

    /// Where a rectangle drawn on screen sits in the drawing, and back again.
    ///
    /// The pair exists so `BoardSelection` can hold one honest answer: a marquee
    /// arrives from the gesture in view coordinates, is stored in the drawing's,
    /// and is converted back only to *draw* the mark. `nil` when there is no
    /// canvas to measure against, which is the same "no board" every other
    /// reader here returns.
    func drawingRect(forViewRect viewRect: CGRect) -> CGRect? {
        guard let canvasView else { return nil }
        return CanvasViewportMapper.drawingRect(
            for: viewRect,
            canvasBounds: canvasView.bounds,
            zoomScale: canvasView.zoomScale
        )
    }

    func viewRect(forDrawingRect drawingRect: CGRect) -> CGRect? {
        guard let canvasView else { return nil }
        return CanvasViewportMapper.viewportRect(
            for: drawingRect,
            canvasBounds: canvasView.bounds,
            zoomScale: canvasView.zoomScale
        )
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
        let current = Self.hasEvaluableInk(in: canvasView?.drawing) || !scene.elements.isEmpty
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
        guard let canvasView, let padded = contentExtent() else { return nil }
        let span = PencilCanvasConfiguration.maximumEvaluationSpan
        let coversAllInk = padded.width <= span && padded.height <= span
        let region = coversAllInk
            ? padded
            : Self.workCenteredRegion(
                of: canvasView.drawing,
                scene: scene,
                span: span
            )
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

    /// The union of learner ink and tutor scene, in drawing coordinates, padded
    /// the way the ink extent is. `nil` only when both are empty.
    func contentExtent() -> CGRect? {
        var union = canvasView.flatMap { Self.inkExtent(of: $0.drawing) }
        if let sceneBounds = BoardSceneRenderer.bounds(
            of: scene,
            boardOrigin: PencilCanvasConfiguration.boardOrigin
        ) {
            let padded = sceneBounds.insetBy(dx: -24, dy: -24)
            union = union?.union(padded) ?? padded
        }
        return union
    }

    /// The overview that rides on every turn: the whole board, small.
    ///
    /// Small on purpose. It is attached whether the tutor looks or not, so its
    /// job is to cost almost nothing and to be aimable — not to be legible. The
    /// full-resolution upload this replaced spent ~160KB a turn, including every
    /// turn where the model never looked at all.
    func overviewData() -> Data? {
        guard let extent = contentExtent() else { return nil }
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
        guard let extent = contentExtent() else { return nil }
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
        guard let canvasView, let extent = contentExtent() else { return nil }
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

    /// The compact model-facing board state sent under `board_scene` on every
    /// turn: coordinate system, visible logical rectangle, learner ink bounds
    /// and clusters when present, then the exact tutor scene.
    ///
    /// It is data, not instructions; the server wraps it as quoted context.
    /// The string is capped at the request field's own limit; if the scene is
    /// too large, the omitted element count is stated rather than silently
    /// paying for an over-limit upload.
    func sceneContextString(maxCharacters: Int = 60_000) -> String? {
        guard let canvasView else { return nil }
        // Keep a precise read of the viewport before any async redraw can
        // publish new scroll state; the double-origin subtraction below was
        // the bug this value is tested against.
        let visible = visibleDrawingRect()
        let inkBounds = Self.inkExtent(of: canvasView.drawing)
        let clusters = Self.clusters(of: canvasView.drawing)

        var root: [String: Any] = [
            "kind": "board_scene_context",
            "data_not_instructions": true,
            "coordinate_system": "logical board points; (0,0) is drawing (25000,25000); +x right, +y down",
        ]
        if let visible {
            root["visible_logical_rect"] = logicalBox(visible)
            // Stable fractions of the visible viewport so the tutor can lay a
            // new standalone exercise out without guessing pixel sizes: the
            // upper band is the placement budget, the lower band stays clear
            // for the learner's own working.
            let regions = Self.layoutRegions(visible: visible)
            root["recommended_tutor_rect"] = logicalBox(regions.recommendedTutor)
            root["reserved_learner_work_rect"] = logicalBox(regions.reservedLearnerWork)
        }
        if let overview = contentExtent() {
            // `view_board` addresses percentages of this exact rectangle. By
            // returning the logical bounds as well, the tutor can turn a crop
            // it inspected back into precise coordinates for a nearby label or
            // correction instead of guessing from pixels.
            root["overview_logical_bounds"] = logicalBox(overview)
        }
        if let inkBounds {
            root["learner_ink_logical_bounds"] = logicalBox(inkBounds)
            root["learner_ink_clusters"] = clusters.map { cluster in
                [
                    "logical_box": logicalBox(cluster.box),
                    "strokes": cluster.count,
                    "newest_unix": cluster.newest.timeIntervalSince1970,
                ]
            }
        }
        if !scene.elements.isEmpty {
            root["tutor_elements"] = encodedElements(scene.elements)
        }

        var data = serialize(root)
        if data == nil {
            return nil
        }

        // Keep the response within the request field's cap. Clusters and ink
        // bounds are dropped first because the scene is the part the model
        // must be able to update; only then are trailing elements omitted.
        while let current = data, current.count > maxCharacters {
            if root["learner_ink_clusters"] != nil {
                root.removeValue(forKey: "learner_ink_clusters")
                data = serialize(root)
                continue
            }
            if root["learner_ink_logical_bounds"] != nil {
                root.removeValue(forKey: "learner_ink_logical_bounds")
                data = serialize(root)
                continue
            }
            guard var elements = root["tutor_elements"] as? [[String: Any]],
                  elements.count > 1
            else { break }
            let omitted = scene.elements.count - elements.count
            elements.removeLast()
            root["tutor_elements"] = elements
            root["truncated"] = true
            root["omitted_element_count"] = omitted + 1
            data = serialize(root)
        }
        return data
    }

    private func visibleDrawingRect() -> CGRect? {
        guard let canvasView else { return nil }
        let viewport = CGRect(origin: .zero, size: canvasView.bounds.size)
        guard viewport.width > 0, viewport.height > 0 else { return nil }
        return CanvasViewportMapper.drawingRect(
            for: viewport,
            canvasBounds: CGRect(origin: canvasView.contentOffset, size: viewport.size),
            zoomScale: canvasView.zoomScale
        )
    }

    /// The two spatial bands a fresh standalone exercise should respect:
    /// `recommendedTutor` is where the tutor draws its content, and
    /// `reservedLearnerWork` is the band the learner will write in, which the
    /// tutor must leave clear. Both are fractions of the visible drawing
    /// rect so the guidance holds at any pan, zoom, or orientation.
    ///
    /// Concrete fractions: horizontal inset 6%; the tutor band spans 6%–50%
    /// of the visible height, the learner band 58%–94%, leaving an 8% gutter
    /// between them.
    static func layoutRegions(visible: CGRect) -> (
        recommendedTutor: CGRect,
        reservedLearnerWork: CGRect
    ) {
        let insetX = visible.width * Self.tutorLayoutHorizontalInset
        return (
            CGRect(
                x: visible.minX + insetX,
                y: visible.minY + visible.height * Self.tutorLayoutTutorTop,
                width: visible.width * (1 - 2 * Self.tutorLayoutHorizontalInset),
                height: visible.height * (Self.tutorLayoutTutorBottom - Self.tutorLayoutTutorTop)
            ),
            CGRect(
                x: visible.minX + insetX,
                y: visible.minY + visible.height * Self.tutorLayoutLearnerTop,
                width: visible.width * (1 - 2 * Self.tutorLayoutHorizontalInset),
                height: visible.height * (Self.tutorLayoutLearnerBottom - Self.tutorLayoutLearnerTop)
            )
        )
    }

    private func logicalBox(_ drawingRect: CGRect) -> [Double] {
        let origin = PencilCanvasConfiguration.boardOrigin
        return [
            Double(drawingRect.minX - origin.x),
            Double(drawingRect.minY - origin.y),
            Double(drawingRect.maxX - origin.x),
            Double(drawingRect.maxY - origin.y),
        ]
    }

    private func encodedElements(_ elements: [BoardElement]) -> [Any] {
        guard let data = try? JSONEncoder().encode(elements),
              let array = try? JSONSerialization.jsonObject(with: data) as? [Any]
        else { return [] }
        return array
    }

    private func serialize(_ object: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys]
        ) else { return nil }
        return String(data: data, encoding: .utf8)
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

    /// Horizontal inset of both layout bands, as a fraction of visible width.
    private static let tutorLayoutHorizontalInset: CGFloat = 0.06
    /// Top of the recommended tutor band, as a fraction of visible height.
    private static let tutorLayoutTutorTop: CGFloat = 0.06
    /// Bottom of the recommended tutor band, as a fraction of visible height.
    private static let tutorLayoutTutorBottom: CGFloat = 0.50
    /// Top of the reserved learner band, as a fraction of visible height.
    private static let tutorLayoutLearnerTop: CGFloat = 0.58
    /// Bottom of the reserved learner band, as a fraction of visible height.
    private static let tutorLayoutLearnerBottom: CGFloat = 0.94

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
    private static func workCenteredRegion(
        of drawing: PKDrawing,
        scene: BoardScene,
        span: CGFloat
    ) -> CGRect {
        let sceneBounds = BoardSceneRenderer.bounds(
            of: scene,
            boardOrigin: PencilCanvasConfiguration.boardOrigin
        )
        if drawing.strokes.isEmpty, let sceneBounds {
            return square(
                around: CGPoint(x: sceneBounds.midX, y: sceneBounds.midY),
                span: span
            )
        }
        let centers = drawing.strokes.map { stroke in
            CGPoint(x: stroke.renderBounds.midX, y: stroke.renderBounds.midY)
        }
        let centroid = centers.isEmpty
            ? CGPoint(
                x: sceneBounds?.midX ?? drawing.bounds.midX,
                y: sceneBounds?.midY ?? drawing.bounds.midY
            )
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
    private func renderPNG(
        drawingRect requested: CGRect,
        maximumDimension: CGFloat = 2_000,
        scene: BoardScene? = nil
    ) -> Data? {
        guard let canvasView, requested.width > 0, requested.height > 0 else { return nil }

        // Keep handwriting crisp without sending an unnecessarily huge original-detail
        // image. A white background also avoids ambiguous transparent-PNG rendering.
        let scale = min(2, maximumDimension / max(requested.width, requested.height))
        let drawing = canvasView.drawing
        let sceneToDraw = scene ?? self.scene
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
                if !sceneToDraw.elements.isEmpty {
                    context.cgContext.saveGState()
                    context.cgContext.scaleBy(x: scale, y: scale)
                    context.cgContext.translateBy(x: -requested.minX, y: -requested.minY)
                    BoardSceneRenderer.draw(
                        scene: sceneToDraw,
                        in: context.cgContext,
                        boardOrigin: PencilCanvasConfiguration.boardOrigin
                    )
                    context.cgContext.restoreGState()
                }
            }
        }
        return image?.pngData()
    }
}
