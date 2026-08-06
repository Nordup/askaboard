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
