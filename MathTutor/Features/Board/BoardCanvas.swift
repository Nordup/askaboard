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

    /// The tutor's semantic scene, composited by a transparent viewport-pinned
    /// layer view. `PKCanvasView` keeps its own drawing path completely
    /// untouched.
    var boardScene: BoardScene = .empty {
        didSet {
            guard boardScene != oldValue else { return }
            // Everything that follows from a new scene belongs to the layer
            // view: it schedules each `svg` element's local render and
            // reconciles its own element layers. The canvas hands the value
            // over and asks for a layout pass, which re-pins the frame and the
            // viewport.
            sceneOverlay.scene = boardScene
            setNeedsLayout()
        }
    }

    private let sceneOverlay = BoardSceneLayerView()

    /// Keeps the layer view's frame pinned to the viewport and its content
    /// transform in sync with the current pan/zoom. Called on layout passes and
    /// from the scroll delegate so a pan or pinch never leaves tutor geometry
    /// behind.
    func updateSceneOverlay() {
        if sceneOverlay.superview != self {
            addSubview(sceneOverlay)
        }
        // Always on top after add/update/layout: PencilKit can add its own
        // sublayers/views between updates, so the semantic layer must be
        // re-fronted every time rather than only when first attached.
        bringSubviewToFront(sceneOverlay)
        // Frame first, viewport second: `setViewport` culls against
        // `bounds.size`, so the size of this pass has to be in place before it
        // decides what the viewport can see.
        sceneOverlay.frame = bounds
        sceneOverlay.setViewport(contentOffset: contentOffset, zoomScale: zoomScale)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateSceneOverlay()
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
    /// Whether `btn/select`'s marquee is armed over this board.
    ///
    /// While it is, the canvas stops taking touches entirely: the pencil belongs
    /// to `BoardSelectionMarquee`, which is drawn above it. Turning interaction
    /// off — rather than swapping `canvas.tool` for something inert — is what also
    /// freezes the scroll, and a frozen scroll is the whole reason a picked region
    /// can be stored in view coordinates at all (see `BoardSelection`). It leaves
    /// first responder alone, so ⌘Z still reaches the board's own undo manager.
    let isSelecting: Bool
    let onDrawingChange: (PKDrawing) -> Void
    let onUndo: () -> Void
    let onRedo: () -> Void
    /// The tutor-authored semantic scene to render above the learner ink.
    let scene: BoardScene

    init(
        capture: CanvasCapture,
        initialDrawingData: Data?,
        tool: BoardTool = .defaultValue,
        penColor: PenColor = .defaultValue,
        thickness: StrokeThickness = .defaultValue,
        isActive: Bool = true,
        isSelecting: Bool = false,
        onDrawingChange: @escaping (PKDrawing) -> Void,
        onUndo: @escaping () -> Void,
        onRedo: @escaping () -> Void,
        scene: BoardScene = .empty
    ) {
        self.capture = capture
        self.initialDrawingData = initialDrawingData
        self.tool = tool
        self.penColor = penColor
        self.thickness = thickness
        self.isActive = isActive
        self.isSelecting = isSelecting
        self.onDrawingChange = onDrawingChange
        self.onUndo = onUndo
        self.onRedo = onRedo
        self.scene = scene
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> BoardCanvasView {
        let canvas = BoardCanvasView(frame: .zero)
        PencilCanvasConfiguration.configure(canvas, viewport: .zero)
        applyTool(to: canvas, coordinator: context.coordinator)
        // The first viewport report centers the board on the restored ink
        // through `capture`, so the capture must already know the canvas by
        // the time that closure can fire.
        context.coordinator.canvas = canvas
        capture.canvasView = canvas
        capture.scene = scene
        canvas.boardScene = scene
        if let initialDrawingData, let drawing = try? PKDrawing(data: initialDrawingData) {
            canvas.drawing = drawing
        }
        // Restored ink or a seeded tutor scene exists before the delegate can
        // report it. Hop out of SwiftUI's update transaction before publishing.
        let capture = capture
        Task { @MainActor in capture.refreshHasInk() }

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
        canvas.isUserInteractionEnabled = !isSelecting

        #if DEBUG
        let addsMultiTouchTaps = BoardConfig.current.addsMultiTouchTaps
        #else
        let addsMultiTouchTaps = true
        #endif
        if addsMultiTouchTaps {
            canvas.addGestureRecognizer(
                multiTouchTap(touches: 2, action: #selector(Coordinator.twoFingerUndo), coordinator: context.coordinator)
            )
            canvas.addGestureRecognizer(
                multiTouchTap(touches: 3, action: #selector(Coordinator.threeFingerRedo), coordinator: context.coordinator)
            )
        }
        return canvas
    }

    /// Two- and three-finger tap, built the one way that keeps them off the ink.
    ///
    /// Both are **finger** gestures by definition, so restricting them to direct
    /// touches means a pencil touch is never even offered to them — which matters
    /// because `delaysTouchesEnded` defaults to `true`: without these two lines,
    /// every stroke's final touch was held back until both recognizers had failed
    /// before PencilKit could see it. That is latency on the end of every letter,
    /// paid for a gesture the pencil can never make. It is also switched off
    /// outright, because a two-finger tap needs a second finger to *arrive*, and
    /// nothing about that requires delaying the first finger's lift.
    private func multiTouchTap(
        touches: Int,
        action: Selector,
        coordinator: Coordinator
    ) -> UITapGestureRecognizer {
        let tap = UITapGestureRecognizer(target: coordinator, action: action)
        tap.numberOfTouchesRequired = touches
        tap.numberOfTapsRequired = 1
        tap.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        tap.delaysTouchesBegan = false
        tap.delaysTouchesEnded = false
        tap.delegate = coordinator
        return tap
    }

    func updateUIView(_ canvas: BoardCanvasView, context: Context) {
        context.coordinator.parent = self
        capture.canvasView = canvas
        capture.scene = scene
        canvas.boardScene = scene
        // `updateUIView` is inside SwiftUI's render transaction. Publishing
        // `hasInk` synchronously from here triggers the runtime's undefined-
        // behavior warning when a tutor scene first arrives.
        let capture = capture
        Task { @MainActor in capture.refreshHasInk() }
        applyTool(to: canvas, coordinator: context.coordinator)
        // Showing or hiding full chat doesn't change the canvas bounds, but it
        // does change which view should own first responder. Viewport-driven
        // setup lives in `BoardCanvasView.onViewportChange`.
        context.coordinator.updateFirstResponder(isActive)
        context.coordinator.updateInteraction(enabled: !isSelecting)
    }

    static func dismantleUIView(_ uiView: BoardCanvasView, coordinator: Coordinator) {
        coordinator.teardown(canvas: uiView)
    }

    /// Arms the canvas with the rail's selection. Called from `makeUIView` as
    /// well as `updateUIView` because nothing else writes `canvas.tool` now that
    /// the tool picker is gone: a board that waited for SwiftUI's first update
    /// would spend that window inking PencilKit's default rather than the pen
    /// the rail is showing as selected.
    ///
    /// **Only when the selection actually changed.** `updateUIView` runs on every
    /// SwiftUI update of the screen — a tutor reply landing, a loading flag
    /// flipping — and each one used to hand `PKCanvasView` a freshly built tool it
    /// already had. Writing `canvas.tool` is not free: PencilKit takes it as the
    /// student picking up a different instrument, which is not something that
    /// should happen underneath a pen that is mid-word.
    private func applyTool(to canvas: PKCanvasView, coordinator: Coordinator) {
        let selection = InkSelection(tool: tool, color: penColor, thickness: thickness)
        guard coordinator.appliedInk != selection else { return }
        coordinator.appliedInk = selection
        canvas.tool = BoardInk.tool(for: tool, color: penColor, thickness: thickness)
    }

    /// The rail selection a canvas is currently armed with. A struct rather than
    /// a tuple so it can be held as an `Optional` and compared as one value.
    struct InkSelection: Equatable {
        let tool: BoardTool
        let color: PenColor
        let thickness: StrokeThickness
    }

    final class Coordinator: NSObject, PKCanvasViewDelegate, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        var parent: PencilCanvasView
        weak var canvas: BoardCanvasView?
        /// What `canvas.tool` was last set from — see `applyTool`.
        var appliedInk: InkSelection?
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
        ///
        /// Each direction is skipped when UIKit is already there. The retry is
        /// what the guard preserves — an update whose `becomeFirstResponder()`
        /// failed leaves `isFirstResponder` false, so the next update tries
        /// again — while a canvas that already holds focus is left alone rather
        /// than being asked, on every SwiftUI update, for something it has.
        ///
        /// **Deferred out of the caller's render transaction, never run inline.**
        ///
        /// `updateUIView` runs inside SwiftUI's render transaction, and a responder
        /// change is not transaction-safe: resigning kicks off UIKit's keyboard
        /// machinery synchronously, and on iPadOS 17 on device — with a third-party
        /// keyboard extension loaded — `resignFirstResponder()` re-enters layout and
        /// never returns. The main thread froze on the panel's full-screen control
        /// with exactly this call at the top of the stack. Same rule `refreshHasInk`
        /// already follows in `updateUIView`, for the same reason.
        ///
        /// The desired state is re-read inside the hop rather than captured: two
        /// updates queued in one runloop turn must land on the *latest* ask, and a
        /// canvas already in the right state must not be toggled again.
        func updateFirstResponder(_ active: Bool) {
            guard let canvas, canvas.isFirstResponder != active else { return }

            DispatchQueue.main.async { [weak canvas] in
                guard let canvas, canvas.isFirstResponder != active else { return }
                if active {
                    canvas.becomeFirstResponder()
                } else {
                    canvas.resignFirstResponder()
                }
            }
        }

        /// Deferred and change-guarded for exactly the reason `updateFirstResponder`
        /// is, one method up: disabling interaction on the view that currently holds
        /// first responder makes UIKit resign it synchronously, which is the same
        /// re-entrant keyboard path that froze the full-screen control on an
        /// iPadOS 17 device — this time from the marquee's `btn/select`. The desired
        /// state is re-read inside the hop, so a stale queued toggle is a no-op and
        /// an unchanged value never reaches UIKit at all.
        func updateInteraction(enabled: Bool) {
            guard let canvas, canvas.isUserInteractionEnabled != enabled else { return }

            DispatchQueue.main.async { [weak canvas] in
                guard let canvas, canvas.isUserInteractionEnabled != enabled else { return }
                canvas.isUserInteractionEnabled = enabled
            }
        }

        func teardown(canvas: PKCanvasView) {
            canvas.resignFirstResponder()
            self.canvas = nil
        }

        /// **Do not touch up the committed stroke here.** This was tried, on
        /// device, to hide the one artifact left in the board's ink: drawn fast
        /// enough, PencilKit's predicted tail is visible for a frame or two after
        /// the pencil lifts and is then retracted. The idea was to extend the
        /// committed stroke to where the preview had already drawn, so there was
        /// nothing to retract.
        ///
        /// It cannot be done. The only way to change a committed stroke is to
        /// assign `canvasView.drawing`, and that makes PencilKit re-render the
        /// whole drawing — the entire line blinks and redraws on every lift, which
        /// is far worse than the tail it was meant to hide. There is no
        /// partial-stroke mutation API. (Assigning `drawing` also does not
        /// register with PencilKit's undo manager; see `PencilCanvasConfiguration`.)
        ///
        /// The tail is PencilKit's own prediction and a stock `PKCanvasView` shows
        /// it too, so it is not something this app's configuration causes or can
        /// configure away. Shortening it needs control over the prediction itself —
        /// a confidence-weighted tail, the way `google/ink-stroke-modeler` and
        /// Procreate's own engine do it — which means not using PencilKit for ink.
        #if DEBUG
        func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) { InkTrace.penLifted() }
        #endif

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            #if DEBUG
            InkTrace.commitBegan(strokes: canvasView.drawing.strokes.count)
            #endif
            parent.onDrawingChange(canvasView.drawing)
            parent.capture.refreshHasInk()
            #if DEBUG
            InkTrace.commitEnded()
            #endif
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            (scrollView as? BoardCanvasView)?.updateSceneOverlay()
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            (scrollView as? BoardCanvasView)?.updateSceneOverlay()
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
