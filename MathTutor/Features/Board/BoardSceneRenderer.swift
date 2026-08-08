import CoreGraphics
import UIKit

/// Precise Core Graphics drawing for the tutor's semantic scene.
///
/// The same routines serve two paths: the live transparent overlay above
/// `PKCanvasView` (drawn in drawing coordinates through the scroll transform)
/// and `CanvasCapture`'s white-backed PNGs (drawn in a requested drawing
/// rectangle). Everything here is main-actor UIKit work; the Domain scene
/// itself stays UI-free.
@MainActor
enum BoardSceneRenderer {
    static func draw(scene: BoardScene, in context: CGContext, boardOrigin: CGPoint) {
        context.saveGState()
        context.translateBy(x: boardOrigin.x, y: boardOrigin.y)
        for element in scene.elements {
            draw(element, in: context)
        }
        context.restoreGState()
    }

    /// Conservative content bounds in drawing coordinates, including stroke,
    /// arrowhead, text, and rotation extents.
    static func bounds(of scene: BoardScene, boardOrigin: CGPoint) -> CGRect? {
        var union: CGRect?
        for element in scene.elements {
            var rect = elementBounds(element, boardOrigin: boardOrigin)
            if element.style.rotation != 0 {
                rect = rotatedBounds(of: rect, degrees: element.style.rotation)
            }
            union = union?.union(rect) ?? rect
        }
        return union
    }

    static func renderPNG(
        scene: BoardScene,
        drawingRect: CGRect,
        boardOrigin: CGPoint = PencilCanvasConfiguration.boardOrigin,
        maximumDimension: CGFloat = 2_000
    ) -> Data? {
        guard !scene.elements.isEmpty, drawingRect.width > 0, drawingRect.height > 0 else { return nil }
        let scale = min(2, maximumDimension / max(drawingRect.width, drawingRect.height))
        let pixelSize = CGSize(width: drawingRect.width * scale, height: drawingRect.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: pixelSize, format: format).image { rendererContext in
            UIColor.white.setFill()
            rendererContext.fill(CGRect(origin: .zero, size: pixelSize))
            let cgContext = rendererContext.cgContext
            cgContext.saveGState()
            cgContext.scaleBy(x: scale, y: scale)
            cgContext.translateBy(x: -drawingRect.minX, y: -drawingRect.minY)
            draw(scene: scene, in: cgContext, boardOrigin: boardOrigin)
            cgContext.restoreGState()
        }
        return image.pngData()
    }

    // MARK: - Primitives

    private static func draw(_ element: BoardElement, in context: CGContext) {
        let style = element.style
        context.saveGState()
        context.setAlpha(max(0, min(1, style.opacity)))
        if !style.dash.isEmpty {
            context.setLineDash(phase: 0, lengths: style.dash.map { CGFloat($0) })
        }
        context.setLineWidth(max(0.5, style.strokeWidth))
        context.setStrokeColor(UIColor(hex: style.stroke)?.cgColor ?? UIColor.black.cgColor)
        context.setFillColor(fillColor(for: style.fill))
        context.setLineCap(.round)
        context.setLineJoin(.round)

        switch element {
        case .text(let value):
            draw(text: value, in: context)
        case .line(let value):
            let bounds = elementBounds(.line(value), boardOrigin: .zero)
            withRotation(style.rotation, around: bounds, in: context) {
                context.move(to: CGPoint(x: value.x1, y: value.y1))
                context.addLine(to: CGPoint(x: value.x2, y: value.y2))
                context.strokePath()
            }
        case .arrow(let value):
            let bounds = elementBounds(.arrow(value), boardOrigin: .zero)
            withRotation(style.rotation, around: bounds, in: context) {
                draw(arrow: value, in: context)
            }
        case .rectangle(let value):
            let rect = CGRect(x: value.x, y: value.y, width: value.width, height: value.height)
            withRotation(style.rotation, around: rect, in: context) {
                if value.style.fill != "transparent" {
                    context.fill(rect)
                }
                context.stroke(rect)
            }
        case .ellipse(let value):
            let rect = CGRect(x: value.x, y: value.y, width: value.width, height: value.height)
            withRotation(style.rotation, around: rect, in: context) {
                if value.style.fill != "transparent" {
                    context.fillEllipse(in: rect)
                }
                context.strokeEllipse(in: rect)
            }
        case .circle(let value):
            let rect = CGRect(
                x: value.cx - value.radius,
                y: value.cy - value.radius,
                width: value.radius * 2,
                height: value.radius * 2
            )
            withRotation(style.rotation, around: rect, in: context) {
                if value.style.fill != "transparent" {
                    context.fillEllipse(in: rect)
                }
                context.strokeEllipse(in: rect)
            }
        case .polygon(let value):
            let path = path(points: value.points, closed: true)
            withRotation(style.rotation, around: bounds(of: value.points, origin: .zero), in: context) {
                if value.style.fill != "transparent" {
                    context.addPath(path)
                    context.fillPath()
                }
                context.addPath(path)
                context.strokePath()
            }
        case .polyline(let value):
            let path = path(points: value.points, closed: false)
            withRotation(style.rotation, around: bounds(of: value.points, origin: .zero), in: context) {
                context.addPath(path)
                context.strokePath()
            }
        case .freehand(let value):
            let path = smoothedPath(points: value.points)
            withRotation(style.rotation, around: bounds(of: value.points, origin: .zero), in: context) {
                context.addPath(path)
                context.strokePath()
            }
        case .arc(let value):
            let path = arcPath(element: value)
            let boundsRect = CGRect(
                x: value.cx - value.radius,
                y: value.cy - value.radius,
                width: value.radius * 2,
                height: value.radius * 2
            )
            withRotation(style.rotation, around: boundsRect, in: context) {
                context.addPath(path)
                context.strokePath()
            }
        case .angleMarker(let value):
            let bounds = elementBounds(.angleMarker(value), boardOrigin: .zero)
            withRotation(style.rotation, around: bounds, in: context) {
                draw(angleMarker: value, in: context)
            }
        case .svg(let value):
            let rect = CGRect(x: value.x, y: value.y, width: value.width, height: value.height)
            withRotation(style.rotation, around: rect, in: context) {
                if let artifact = BoardSVGCache.shared.artifact(for: value) {
                    artifact.draw(in: rect, into: context)
                }
            }
        }
        context.restoreGState()
    }

    private static func draw(text: TextElement, in context: CGContext) {
        let measurement = textMeasurement(text)
        let drawWidth = text.width > 0 ? text.width : measurement.width
        let naturalHeight = measurement.height
        let drawRect = CGRect(x: text.x, y: text.y, width: drawWidth, height: naturalHeight)
        withRotation(text.style.rotation, around: drawRect, in: context) {
            let paragraph = NSMutableParagraphStyle()
            switch text.alignment {
            case .left: paragraph.alignment = .left
            case .center: paragraph.alignment = .center
            case .right: paragraph.alignment = .right
            }
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: max(8, text.fontSize)),
                .foregroundColor: UIColor(hex: text.style.stroke) ?? UIColor.black,
                .paragraphStyle: paragraph,
            ]
            (text.text as NSString).draw(
                in: drawRect,
                withAttributes: attributes
            )
        }
    }

    private static func draw(arrow: ArrowElement, in context: CGContext) {
        let tail = CGPoint(x: arrow.x1, y: arrow.y1)
        let head = CGPoint(x: arrow.x2, y: arrow.y2)
        context.move(to: tail)
        context.addLine(to: head)
        context.strokePath()

        let dx = head.x - tail.x
        let dy = head.y - tail.y
        let length = max(sqrt(dx * dx + dy * dy), .leastNonzeroMagnitude)
        let unit = CGPoint(x: dx / length, y: dy / length)
        let perpendicular = CGPoint(x: -unit.y, y: unit.x)
        let size = max(4, arrow.headSize)
        let base = CGPoint(x: head.x - unit.x * size, y: head.y - unit.y * size)
        context.move(to: head)
        context.addLine(to: CGPoint(x: base.x + perpendicular.x * size * 0.5, y: base.y + perpendicular.y * size * 0.5))
        context.addLine(to: CGPoint(x: base.x - perpendicular.x * size * 0.5, y: base.y - perpendicular.y * size * 0.5))
        context.closePath()
        context.setFillColor(UIColor(hex: arrow.style.stroke)?.cgColor ?? UIColor.black.cgColor)
        context.fillPath()
    }

    private static func draw(angleMarker: AngleMarkerElement, in context: CGContext) {
        let vertex = CGPoint(x: angleMarker.vertexX, y: angleMarker.vertexY)
        let ray1 = CGPoint(x: angleMarker.ray1X, y: angleMarker.ray1Y)
        let ray2 = CGPoint(x: angleMarker.ray2X, y: angleMarker.ray2Y)
        let radius = max(4, angleMarker.radius)

        if angleMarker.rightAngle {
            let direction1 = normalized(from: vertex, to: ray1)
            let direction2 = normalized(from: vertex, to: ray2)
            let corner = CGPoint(
                x: vertex.x + (direction1.x + direction2.x) * radius,
                y: vertex.y + (direction1.y + direction2.y) * radius
            )
            let path = CGMutablePath()
            path.move(to: CGPoint(x: vertex.x + direction1.x * radius, y: vertex.y + direction1.y * radius))
            path.addLine(to: corner)
            path.addLine(to: CGPoint(x: vertex.x + direction2.x * radius, y: vertex.y + direction2.y * radius))
            context.addPath(path)
            context.strokePath()
            return
        }

        let start = atan2(ray1.y - vertex.y, ray1.x - vertex.x)
        let end = atan2(ray2.y - vertex.y, ray2.x - vertex.x)
        let path = sampledArcPath(
            center: vertex,
            radius: radius,
            startAngle: start * 180 / .pi,
            endAngle: end * 180 / .pi,
            takesShortestSweep: true
        )
        context.addPath(path)
        context.strokePath()
    }

    private static func path(points: [BoardPoint], closed: Bool) -> CGPath {
        let path = CGMutablePath()
        guard let first = points.first else { return path }
        path.move(to: CGPoint(x: first.x, y: first.y))
        for point in points.dropFirst() {
            path.addLine(to: CGPoint(x: point.x, y: point.y))
        }
        if closed { path.closeSubpath() }
        return path
    }

    /// A smooth freehand approximation through the sampled points, using
    /// quadratic curves through segment midpoints. Simple, deterministic, and
    /// keeps the stroke well inside the computed bounds.
    private static func smoothedPath(points: [BoardPoint]) -> CGPath {
        let path = CGMutablePath()
        guard let first = points.first else { return path }
        guard points.count > 2 else {
            path.move(to: CGPoint(x: first.x, y: first.y))
            for point in points.dropFirst() {
                path.addLine(to: CGPoint(x: point.x, y: point.y))
            }
            return path
        }
        path.move(to: CGPoint(x: first.x, y: first.y))
        for index in 1..<(points.count - 1) {
            let current = points[index]
            let next = points[index + 1]
            let midpoint = CGPoint(x: (current.x + next.x) / 2, y: (current.y + next.y) / 2)
            path.addQuadCurve(
                to: midpoint,
                control: CGPoint(x: current.x, y: current.y)
            )
        }
        if let last = points.last {
            path.addLine(to: CGPoint(x: last.x, y: last.y))
        }
        return path
    }

    private static func arcPath(element: ArcElement) -> CGPath {
        sampledArcPath(
            center: CGPoint(x: element.cx, y: element.cy),
            radius: max(0, element.radius),
            startAngle: element.startAngle,
            endAngle: element.endAngle,
            takesShortestSweep: false
        )
    }

    /// Angles are degrees, 0 = right, increasing clockwise in the board's
    /// +y-down coordinate system. Explicit arcs sweep clockwise from start to
    /// end, so 0 -> 270 is the requested 270-degree arc. Angle markers use the
    /// shorter interior sweep between their two rays.
    private static func sampledArcPath(
        center: CGPoint,
        radius: CGFloat,
        startAngle: CGFloat,
        endAngle: CGFloat,
        takesShortestSweep: Bool
    ) -> CGPath {
        var start = startAngle.truncatingRemainder(dividingBy: 360)
        var end = endAngle.truncatingRemainder(dividingBy: 360)
        if start < 0 { start += 360 }
        if end < 0 { end += 360 }
        var delta = end - start
        if takesShortestSweep {
            if delta > 180 { delta -= 360 }
            if delta < -180 { delta += 360 }
        } else if delta < 0 {
            delta += 360
        }
        let segments = max(4, min(128, Int(abs(delta) / 5) + 1))
        let path = CGMutablePath()
        for index in 0...segments {
            let angle = (start + delta * CGFloat(index) / CGFloat(segments)) * .pi / 180
            let point = CGPoint(
                x: center.x + radius * cos(angle),
                y: center.y + radius * sin(angle)
            )
            if index == 0 {
                path.move(to: point)
            } else {
                path.addLine(to: point)
            }
        }
        return path
    }

    private static func textMeasurement(_ text: TextElement) -> CGSize {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: max(8, text.fontSize)),
            .paragraphStyle: paragraph(for: text.alignment),
        ]
        let constraintWidth = text.width > 0 ? text.width : 1_000_000
        let rect = (text.text as NSString).boundingRect(
            with: CGSize(width: constraintWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attributes,
            context: nil
        )
        return CGSize(
            width: text.width > 0 ? text.width : max(1, ceil(rect.width)),
            height: max(1, ceil(rect.height))
        )
    }

    private static func paragraph(for alignment: BoardTextAlignment) -> NSParagraphStyle {
        let paragraph = NSMutableParagraphStyle()
        switch alignment {
        case .left: paragraph.alignment = .left
        case .center: paragraph.alignment = .center
        case .right: paragraph.alignment = .right
        }
        return paragraph
    }

    private static func withRotation(
        _ degrees: CGFloat,
        around rect: CGRect,
        in context: CGContext,
        body: () -> Void
    ) {
        guard degrees != 0, !rect.isNull, rect.width > 0, rect.height > 0 else {
            body()
            return
        }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        context.saveGState()
        context.translateBy(x: center.x, y: center.y)
        context.rotate(by: degrees * .pi / 180)
        context.translateBy(x: -center.x, y: -center.y)
        body()
        context.restoreGState()
    }

    private static func elementBounds(_ element: BoardElement, boardOrigin: CGPoint) -> CGRect {
        let style = element.style
        let inset = max(0, style.strokeWidth / 2)
        let originX = boardOrigin.x
        let originY = boardOrigin.y
        let rect: CGRect
        switch element {
        case .text(let value):
            let size = textMeasurement(value)
            let width = value.width > 0 ? value.width : size.width
            rect = CGRect(x: value.x + originX, y: value.y + originY, width: width, height: size.height)
        case .line(let value):
            rect = CGRect(
                x: min(value.x1, value.x2) + originX,
                y: min(value.y1, value.y2) + originY,
                width: abs(value.x2 - value.x1),
                height: abs(value.y2 - value.y1)
            ).insetBy(dx: -inset, dy: -inset)
        case .arrow(let value):
            rect = CGRect(
                x: min(value.x1, value.x2) + originX,
                y: min(value.y1, value.y2) + originY,
                width: abs(value.x2 - value.x1),
                height: abs(value.y2 - value.y1)
            ).insetBy(dx: -max(inset, value.headSize), dy: -max(inset, value.headSize))
        case .rectangle(let value):
            rect = CGRect(x: value.x + originX, y: value.y + originY, width: value.width, height: value.height)
                .insetBy(dx: -inset, dy: -inset)
        case .ellipse(let value):
            rect = CGRect(x: value.x + originX, y: value.y + originY, width: value.width, height: value.height)
                .insetBy(dx: -inset, dy: -inset)
        case .circle(let value):
            rect = CGRect(
                x: value.cx - value.radius + originX,
                y: value.cy - value.radius + originY,
                width: value.radius * 2,
                height: value.radius * 2
            ).insetBy(dx: -inset, dy: -inset)
        case .polygon(let value):
            rect = bounds(of: value.points, origin: CGPoint(x: originX, y: originY)).insetBy(dx: -inset, dy: -inset)
        case .polyline(let value):
            rect = bounds(of: value.points, origin: CGPoint(x: originX, y: originY)).insetBy(dx: -inset, dy: -inset)
        case .freehand(let value):
            rect = bounds(of: value.points, origin: CGPoint(x: originX, y: originY)).insetBy(dx: -inset, dy: -inset)
        case .arc(let value):
            let side = value.radius + max(inset, 4)
            rect = CGRect(
                x: value.cx - side + originX,
                y: value.cy - side + originY,
                width: side * 2,
                height: side * 2
            )
        case .angleMarker(let value):
            let vertex = CGPoint(x: value.vertexX, y: value.vertexY)
            if value.rightAngle {
                let first = normalized(
                    from: vertex,
                    to: CGPoint(x: value.ray1X, y: value.ray1Y)
                )
                let second = normalized(
                    from: vertex,
                    to: CGPoint(x: value.ray2X, y: value.ray2Y)
                )
                let radius = max(4, value.radius)
                let points = [
                    BoardPoint(x: vertex.x + first.x * radius, y: vertex.y + first.y * radius),
                    BoardPoint(
                        x: vertex.x + (first.x + second.x) * radius,
                        y: vertex.y + (first.y + second.y) * radius
                    ),
                    BoardPoint(x: vertex.x + second.x * radius, y: vertex.y + second.y * radius),
                ]
                rect = bounds(of: points, origin: CGPoint(x: originX, y: originY))
                    .insetBy(dx: -inset, dy: -inset)
            } else {
                let radius = max(value.radius, inset)
                rect = CGRect(
                    x: value.vertexX - radius + originX,
                    y: value.vertexY - radius + originY,
                    width: radius * 2,
                    height: radius * 2
                )
            }
        case .svg(let value):
            rect = CGRect(
                x: value.x + originX,
                y: value.y + originY,
                width: value.width,
                height: value.height
            ).insetBy(dx: -inset, dy: -inset)
        }
        return rect
    }

    private static func bounds(of points: [BoardPoint], origin: CGPoint) -> CGRect {
        guard let first = points.first else { return .zero }
        var minX = first.x
        var minY = first.y
        var maxX = first.x
        var maxY = first.y
        for point in points {
            minX = min(minX, point.x)
            minY = min(minY, point.y)
            maxX = max(maxX, point.x)
            maxY = max(maxY, point.y)
        }
        return CGRect(x: minX + origin.x, y: minY + origin.y, width: maxX - minX, height: maxY - minY)
    }

    private static func rotatedBounds(of rect: CGRect, degrees: CGFloat) -> CGRect {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let radius = hypot(rect.width, rect.height) / 2
        return CGRect(
            x: center.x - radius,
            y: center.y - radius,
            width: radius * 2,
            height: radius * 2
        )
    }

    private static func normalized(from start: CGPoint, to end: CGPoint) -> CGPoint {
        let length = max(hypot(end.x - start.x, end.y - start.y), .leastNonzeroMagnitude)
        return CGPoint(x: (end.x - start.x) / length, y: (end.y - start.y) / length)
    }

    private static func fillColor(for hex: String) -> CGColor {
        if hex == "transparent" {
            return UIColor.clear.cgColor
        }
        return UIColor(hex: hex)?.cgColor ?? UIColor.clear.cgColor
    }
}

/// The transparent viewport-pinned overlay that keeps tutor geometry in
/// lockstep with the `PKCanvasView` scroll and zoom transform.
final class BoardSceneOverlayView: UIView {
    var scene: BoardScene = .empty {
        didSet {
            guard scene != oldValue else { return }
            setNeedsDisplay()
        }
    }

    var contentOffset: CGPoint = .zero {
        didSet { setNeedsDisplay() }
    }

    var zoomScale: CGFloat = 1 {
        didSet { setNeedsDisplay() }
    }

    var boardOrigin: CGPoint = PencilCanvasConfiguration.boardOrigin

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        accessibilityIdentifier = "tutor-scene-overlay"
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(svgCacheDidRender),
            name: .boardSVGCacheDidRender,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func svgCacheDidRender() {
        setNeedsDisplay()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("BoardSceneOverlayView is created in code only")
    }

    override func draw(_ rect: CGRect) {
        guard !scene.elements.isEmpty, let context = UIGraphicsGetCurrentContext() else { return }
        context.saveGState()
        context.concatenate(CGAffineTransform(
            a: zoomScale,
            b: 0,
            c: 0,
            d: zoomScale,
            tx: -contentOffset.x,
            ty: -contentOffset.y
        ))
        BoardSceneRenderer.draw(scene: scene, in: context, boardOrigin: boardOrigin)
        context.restoreGState()
    }
}

private extension UIColor {
    convenience init?(hex: String) {
        let value = hex.trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix("#"), value.count == 7,
              let digits = UInt32(value.dropFirst(), radix: 16)
        else { return nil }
        self.init(
            red: CGFloat((digits >> 16) & 0xFF) / 255,
            green: CGFloat((digits >> 8) & 0xFF) / 255,
            blue: CGFloat(digits & 0xFF) / 255,
            alpha: 1
        )
    }
}
