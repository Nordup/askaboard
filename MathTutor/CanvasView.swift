import PencilKit
import SwiftUI
import UIKit

enum PencilCanvasConfiguration {
    static let minimumZoomScale: CGFloat = 0.75
    static let maximumZoomScale: CGFloat = 3
    static let defaultZoomScale: CGFloat = 1
    static let minimumContentSize = CGSize(width: 2_400, height: 1_600)
    static let contentInset = UIEdgeInsets(top: 96, left: 64, bottom: 224, right: 64)

    static func contentSize(for viewport: CGSize) -> CGSize {
        CGSize(
            width: max(minimumContentSize.width, viewport.width),
            height: max(minimumContentSize.height, viewport.height)
        )
    }

    static func initialContentOffset() -> CGPoint {
        CGPoint(x: -contentInset.left, y: -contentInset.top)
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
        canvas.contentInset = contentInset
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
            canvas.contentOffset = initialContentOffset()
        }
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
        guard requested.width > 0, requested.height > 0 else { return nil }

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

    func makeUIView(context: Context) -> PKCanvasView {
        let canvas = PKCanvasView(frame: .zero)
        PencilCanvasConfiguration.configure(canvas, viewport: .zero)
        if let initialDrawingData, let drawing = try? PKDrawing(data: initialDrawingData) {
            canvas.drawing = drawing
        }
        // Install the delegate after restoring persisted ink so the initial load
        // does not publish a drawing change while SwiftUI is still updating views.
        canvas.delegate = context.coordinator

        let toolPicker = PKToolPicker()
        toolPicker.addObserver(canvas)
        context.coordinator.toolPicker = toolPicker
        context.coordinator.canvas = canvas
        capture.canvasView = canvas
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

    func updateUIView(_ canvas: PKCanvasView, context: Context) {
        context.coordinator.parent = self
        capture.canvasView = canvas
        // Activation must be handled before the viewport early return. Showing
        // or hiding full chat does not change the canvas bounds, but it does
        // change which view should own first responder and the tool picker.
        context.coordinator.updateActivation(isActive)
        let viewport = canvas.bounds.size
        guard viewport != .zero, context.coordinator.lastViewportSize != viewport else { return }
        PencilCanvasConfiguration.configure(canvas, viewport: viewport, preserveViewport: context.coordinator.didConfigure)
        context.coordinator.lastViewportSize = viewport
        context.coordinator.didConfigure = true
    }

    static func dismantleUIView(_ uiView: PKCanvasView, coordinator: Coordinator) {
        coordinator.teardown(canvas: uiView)
    }

    final class Coordinator: NSObject, PKCanvasViewDelegate, UIGestureRecognizerDelegate {
        var parent: PencilCanvasView
        weak var canvas: PKCanvasView?
        var toolPicker: PKToolPicker?
        var lastViewportSize: CGSize = .zero
        var didConfigure = false

        init(_ parent: PencilCanvasView) { self.parent = parent }

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
