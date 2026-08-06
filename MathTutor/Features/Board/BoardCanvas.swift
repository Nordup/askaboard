import PencilKit
import SwiftUI
import UIKit

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
    /// The rail's current selection. The board holds no tool state of its own:
    /// it applies whatever these say on every update, so the rail stays the one
    /// place a tool is chosen.
    ///
    /// They default to the domain defaults — the same values the rail draws as
    /// its initial selection — so a caller that has not wired the rail yet still
    /// inks the pen the rail would be showing.
    let tool: BoardTool
    let penColor: PenColor
    let thickness: StrokeThickness
    /// Whether the whiteboard owns input focus. The canvas stays mounted while
    /// the full tutor chat is shown, so this explicit contract keeps UIKit focus
    /// in sync with the SwiftUI overlay state.
    let isActive: Bool
    let onDrawingChange: (PKDrawing) -> Void
    let onUndo: () -> Void
    let onRedo: () -> Void

    init(
        capture: CanvasCapture,
        initialDrawingData: Data?,
        tool: BoardTool = .defaultValue,
        penColor: PenColor = .defaultValue,
        thickness: StrokeThickness = .defaultValue,
        isActive: Bool = true,
        onDrawingChange: @escaping (PKDrawing) -> Void,
        onUndo: @escaping () -> Void,
        onRedo: @escaping () -> Void
    ) {
        self.capture = capture
        self.initialDrawingData = initialDrawingData
        self.tool = tool
        self.penColor = penColor
        self.thickness = thickness
        self.isActive = isActive
        self.onDrawingChange = onDrawingChange
        self.onUndo = onUndo
        self.onRedo = onRedo
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> BoardCanvasView {
        let canvas = BoardCanvasView(frame: .zero)
        PencilCanvasConfiguration.configure(canvas, viewport: .zero)
        applyTool(to: canvas)
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

        context.coordinator.updateFirstResponder(isActive)

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
        applyTool(to: canvas)
        // Showing or hiding full chat doesn't change the canvas bounds, but it
        // does change which view should own first responder. Viewport-driven
        // setup lives in `BoardCanvasView.onViewportChange`.
        context.coordinator.updateFirstResponder(isActive)
    }

    static func dismantleUIView(_ uiView: BoardCanvasView, coordinator: Coordinator) {
        coordinator.teardown(canvas: uiView)
    }

    /// Arms the canvas with the rail's selection. Called from `makeUIView` as
    /// well as `updateUIView` because nothing else writes `canvas.tool` now that
    /// the tool picker is gone: a board that waited for SwiftUI's first update
    /// would spend that window inking PencilKit's default rather than the pen
    /// the rail is showing as selected.
    private func applyTool(to canvas: PKCanvasView) {
        canvas.tool = BoardInk.tool(for: tool, color: penColor, thickness: thickness)
    }

    final class Coordinator: NSObject, PKCanvasViewDelegate, UIGestureRecognizerDelegate {
        var parent: PencilCanvasView
        weak var canvas: BoardCanvasView?
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

        /// Synchronizes UIKit's first-responder state with the SwiftUI
        /// whiteboard visibility contract. We apply the active path on every
        /// update (rather than only when the flag changes) so an early
        /// `becomeFirstResponder()` failure while the view is being mounted is
        /// retried by the next SwiftUI update.
        ///
        /// This outlived the tool picker it was written for. First responder is
        /// still what routes hardware ⌘Z to the canvas's own undo manager and
        /// what lets `PKLassoTool` raise the edit menu over a selection — and
        /// resigning it is what hands the keyboard to the full chat's composer.
        func updateFirstResponder(_ active: Bool) {
            guard let canvas else { return }

            if active {
                canvas.becomeFirstResponder()
            } else {
                canvas.resignFirstResponder()
            }
        }

        func teardown(canvas: PKCanvasView) {
            canvas.resignFirstResponder()
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
