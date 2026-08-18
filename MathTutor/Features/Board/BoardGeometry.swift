import PencilKit
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

    static func offset(
        centering target: CGRect,
        viewport: CGSize,
        zoomScale: CGFloat
    ) -> CGPoint {
        let scale = max(zoomScale, self.minimumZoomScale)
        return CanvasScroller.offset(
            centering: target,
            viewport: viewport,
            zoomScale: scale,
            // The scroll view's content size already includes the zoom, so the
            // restore clamp must use the same scaled size `CameraGeometry.center`
            // measures against — otherwise a zoomed camera restores to a
            // clamped offset computed against the unscaled board.
            scaledContentSize: CGSize(
                width: max(boardExtent, viewport.width) * scale,
                height: max(boardExtent, viewport.height) * scale
            )
        )
    }

    /// The view-independent position the live viewport centers on, in unscaled
    /// drawing coordinates.
    ///
    /// `viewport` is a rectangle in the canvas's own coordinate space (usually
    /// its bounds); `contentOffset` is the scroll view's scaled-space offset;
    /// `scaledContentSize` is the scroll view's content size, which already
    /// includes the zoom. Dividing the clamped scaled center by the zoom is
    /// what makes the saved camera stable across viewport sizes.
    static func center(
        in viewport: CGRect,
        contentOffset: CGPoint,
        scaledContentSize: CGSize,
        zoomScale: CGFloat
    ) -> CGPoint {
        let scale = max(zoomScale, .leastNonzeroMagnitude)
        let maximumOffset = CGPoint(
            x: max(0, scaledContentSize.width - viewport.width),
            y: max(0, scaledContentSize.height - viewport.height)
        )
        let clampedOffset = CGPoint(
            x: min(max(contentOffset.x, 0), maximumOffset.x),
            y: min(max(contentOffset.y, 0), maximumOffset.y)
        )
        return CGPoint(
            x: (clampedOffset.x + viewport.width / 2) / scale,
            y: (clampedOffset.y + viewport.height / 2) / scale
        )
    }

    @MainActor
    static func configure(
        _ canvas: PKCanvasView,
        viewport: CGSize,
        preserveViewport: Bool = false
    ) {
        #if DEBUG
        guard BoardConfig.current.usesBoardGeometry else {
            canvas.backgroundColor = .clear
            canvas.isOpaque = false
            canvas.drawingPolicy = .pencilOnly
            return
        }
        #endif
        let previousZoomScale = canvas.zoomScale
        let previousContentOffset = canvas.contentOffset

        // **The canvas is transparent; the board host paints the paper.**
        //
        // The host owns an opaque `BoardPaper` background with the scene
        // composited above it, and the native PencilKit canvas sits clear and
        // non-opaque on top so learner ink is PencilKit's own surface and the
        // only ink surface. A clear, non-opaque PencilKit surface presents
        // in-progress strokes on ordinary Core Animation commits instead of its
        // high-frequency path, which is the accepted wet-ink tradeoff for
        // exactly one live ink layer.
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

    /// The inverse: where a rectangle of the drawing currently sits on screen.
    ///
    /// Only one thing needs this — drawing the marquee over the region it picked,
    /// now that the region is *kept* in drawing coordinates (see `BoardSelection`).
    /// The mark has to follow the ink it was drawn around when the board resizes,
    /// and going back through the same mapping is what makes that automatic
    /// rather than a second set of coordinates to keep in step.
    ///
    /// It may well return a rectangle partly or wholly off screen. That is a true
    /// answer, not an error: the region is still selected, it is simply not
    /// visible, and what gets *sent* is rendered from the vectors and does not
    /// come through here at all.
    static func viewportRect(
        for drawingRect: CGRect,
        canvasBounds: CGRect,
        zoomScale: CGFloat
    ) -> CGRect {
        let scale = max(zoomScale, .leastNonzeroMagnitude)
        return CGRect(
            x: drawingRect.minX * scale - canvasBounds.minX,
            y: drawingRect.minY * scale - canvasBounds.minY,
            width: drawingRect.width * scale,
            height: drawingRect.height * scale
        )
    }
}
