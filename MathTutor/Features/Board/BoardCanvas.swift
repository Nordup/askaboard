import PencilKit
import SwiftUI
import UIKit

/// The board's PencilKit surface, with the empty-text edit menu routed out.
///
/// PencilKit installs its own `UIEditMenuInteraction` on iPadOS 17, and a plain
/// tap on the board presents its default text-editing menu ("Select All |
/// Insert Space") even though a board has no text to select or insert. Routing
/// the two empty-text actions out of the responder chain removes those items
/// while leaving PencilKit's lasso selection menu (cut, copy, paste, duplicate,
/// delete) untouched, since that menu is presented by PencilKit itself, not by
/// the responder actions this override blocks.
final class BoardPencilCanvasView: PKCanvasView {
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        switch action {
        case #selector(UIResponder.selectAll(_:)), Selector(("insertText:")):
            // "Select All" and "Insert Space" come from the board's text-editing
            // menu, which has no text to act on. Every other action (including
            // the lasso's cut/copy/paste/duplicate/delete) keeps the responder
            // chain's normal answer.
            return false
        default:
            return super.canPerformAction(action, withSender: sender)
        }
    }

    override func target(forAction action: Selector, withSender sender: Any?) -> Any? {
        switch action {
        case #selector(UIResponder.selectAll(_:)), Selector(("insertText:")):
            // The responder chain must not be able to route these two empty-text
            // actions at all, not merely report them unavailable. PencilKit can
            // build its edit menu from the responder chain, so a nil target here
            // closes the second path the popup could reach a handler through.
            return nil
        default:
            return super.target(forAction: action, withSender: sender)
        }
    }
}

/// A public board host that paints the board's opaque paper and composites the
/// tutor scene below PencilKit's own transparent ink surface.
///
/// Board setup depends on the viewport, but SwiftUI only re-invokes
/// `updateUIView` when one of the representable's own arguments changes — not
/// when Auto Layout finally gives the canvas a real size. Depending on that
/// meant a cold launch configured the board against a zero viewport and never
/// corrected it. UIKit's layout pass is the signal that actually tracks
/// geometry.
final class BoardCanvasView: UIView {
    /// Called on each layout pass whose size differs from the last reported
    /// one, skipping empty sizes. The first call is the board's real start.
    var onViewportChange: ((CGSize) -> Void)?

    private var reportedViewport: CGSize?

    let pencilCanvas: BoardPencilCanvasView

    var drawing: PKDrawing {
        get { pencilCanvas.drawing }
        set { pencilCanvas.drawing = newValue }
    }

    var contentOffset: CGPoint {
        get { pencilCanvas.contentOffset }
        set {
            pencilCanvas.contentOffset = newValue
            updateSceneOverlay()
        }
    }

    var zoomScale: CGFloat {
        get { pencilCanvas.zoomScale }
        set {
            pencilCanvas.setZoomScale(newValue, animated: false)
            updateSceneOverlay()
        }
    }

    var contentSize: CGSize { pencilCanvas.contentSize }

    /// What the learner is looking at, in drawing coordinates plus zoom — the
    /// persisted "camera". Computed from the scroll view's own state so pan and
    /// pinch always report through the same normalization.
    var camera: BoardCamera {
        BoardCamera(
            center: PencilCanvasConfiguration.center(
                in: bounds,
                contentOffset: pencilCanvas.contentOffset,
                scaledContentSize: pencilCanvas.contentSize,
                zoomScale: pencilCanvas.zoomScale
            ),
            zoomScale: pencilCanvas.zoomScale
        )
    }

    /// Restores a saved camera. The center travels through the same clamp as
    /// any live pan, so an older camera saved against a different viewport still
    /// lands inside the board's scrollable range.
    ///
    /// This is a programmatic first-layout configuration, not a learner gesture:
    /// the coordinator suppresses the pan/zoom report that follows so it is not
    /// mistaken for a user change.
    func restoreCamera(_ camera: BoardCamera) {
        let zoom = min(
            max(camera.zoomScale, PencilCanvasConfiguration.minimumZoomScale),
            PencilCanvasConfiguration.maximumZoomScale
        )
        pencilCanvas.setZoomScale(zoom, animated: false)
        pencilCanvas.contentOffset = PencilCanvasConfiguration.offset(
            centering: CGRect(origin: camera.center, size: .zero),
            viewport: bounds.size,
            zoomScale: pencilCanvas.zoomScale
        )
        updateSceneOverlay()
    }

    /// The camera a fresh canvas restores on its first real layout, if the
    /// session carries one. `nil` keeps the pre-camera behavior of opening
    /// centered on the session's ink.
    var initialCamera: BoardCamera?

    var mountedSceneElementIdsForTesting: Set<String> {
        sceneOverlay.mountedElementIdsForTesting
    }

    var mountedSceneFrameForTesting: CGRect? {
        sceneOverlay.mountedFrameForTesting(id: "scene")
    }

    func setZoomScale(_ scale: CGFloat, animated: Bool) {
        pencilCanvas.setZoomScale(scale, animated: animated)
        updateSceneOverlay()
    }

    init(frame: CGRect, pencilCanvas: BoardPencilCanvasView = BoardPencilCanvasView(frame: .zero)) {
        self.pencilCanvas = pencilCanvas
        super.init(frame: frame)
        pencilCanvas.isUserInteractionEnabled = true
        pencilCanvas.alpha = 1
        let scale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        backgroundColor = BoardPaper.background(scale: scale)
        isOpaque = true
        pencilCanvas.backgroundColor = .clear
        pencilCanvas.isOpaque = false
        pencilCanvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        sceneOverlay.isUserInteractionEnabled = false
        sceneOverlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(sceneOverlay)
        addSubview(pencilCanvas)
        updateSceneOverlay()
    }

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

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("BoardCanvasView is created in code only")
    }

    /// Keeps the layer view's frame pinned to the viewport and its content
    /// transform in sync with the current pan/zoom. Called on layout passes and
    /// from the scroll delegate so a pan or pinch never leaves tutor geometry
    /// behind.
    func updateSceneOverlay() {
        pencilCanvas.frame = bounds
        sceneOverlay.frame = bounds
        updatePaperSurface()
        sceneOverlay.setViewport(contentOffset: pencilCanvas.contentOffset, zoomScale: pencilCanvas.zoomScale)
    }

    private func updatePaperSurface() {
        let scale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        backgroundColor = BoardPaper.background(scale: scale)
        isOpaque = true
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
    /// Called on pan/zoom so the store can rest-save the board's camera. The
    /// programmatic first-layout restore does not call it; a real learner pan
    /// does.
    let onCameraChange: (BoardCamera) -> Void
    /// The tutor-authored semantic scene. The host places it above the opaque
    /// paper and below PencilKit's native ink.
    let scene: BoardScene
    /// The camera to restore on the board's first real layout, when the session
    /// has one. `nil` keeps the pre-camera behavior of opening centered on the
    /// session's ink.
    let initialCamera: BoardCamera?

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
        onCameraChange: @escaping (BoardCamera) -> Void = { _ in },
        initialCamera: BoardCamera? = nil,
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
        self.onCameraChange = onCameraChange
        self.scene = scene
        self.initialCamera = initialCamera
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> BoardCanvasView {
        let canvas = BoardCanvasView(frame: .zero)
        canvas.initialCamera = initialCamera
        let pencilCanvas = canvas.pencilCanvas
        PencilCanvasConfiguration.configure(pencilCanvas, viewport: .zero)
        applyTool(to: pencilCanvas, coordinator: context.coordinator)
        // The first viewport report centers the board on the restored ink
        // through `capture`, so the capture must already know the canvas by
        // the time that closure can fire.
        context.coordinator.canvas = pencilCanvas
        context.coordinator.host = canvas
        capture.canvasView = pencilCanvas
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
        pencilCanvas.delegate = context.coordinator

        context.coordinator.updateFirstResponder(isActive)
        canvas.isUserInteractionEnabled = !isSelecting

        #if DEBUG
        let addsMultiTouchTaps = BoardConfig.current.addsMultiTouchTaps
        #else
        let addsMultiTouchTaps = true
        #endif
        if addsMultiTouchTaps {
            pencilCanvas.addGestureRecognizer(
                multiTouchTap(touches: 2, action: #selector(Coordinator.twoFingerUndo), coordinator: context.coordinator)
            )
            pencilCanvas.addGestureRecognizer(
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
        let pencilCanvas = canvas.pencilCanvas
        context.coordinator.parent = self
        context.coordinator.host = canvas
        capture.canvasView = pencilCanvas
        capture.scene = scene
        canvas.boardScene = scene
        // `updateUIView` is inside SwiftUI's render transaction. Publishing
        // `hasInk` synchronously from here triggers the runtime's undefined-
        // behavior warning when a tutor scene first arrives.
        let capture = capture
        Task { @MainActor in capture.refreshHasInk() }
        applyTool(to: pencilCanvas, coordinator: context.coordinator)
        // Showing or hiding full chat doesn't change the canvas bounds, but it
        // does change which view should own first responder. Viewport-driven
        // setup lives in `BoardCanvasView.onViewportChange`.
        context.coordinator.updateFirstResponder(isActive)
        context.coordinator.updateInteraction(enabled: !isSelecting)
    }

    static func dismantleUIView(_ uiView: BoardCanvasView, coordinator: Coordinator) {
        coordinator.teardown(canvas: uiView.pencilCanvas)
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
        weak var canvas: PKCanvasView?
        weak var host: BoardCanvasView?
        /// What `canvas.tool` was last set from — see `applyTool`.
        var appliedInk: InkSelection?
        /// Whether `BoardCanvasView.onViewportChange` has fired at least
        /// once. Doubles as the "first report vs. later" routing signal: the
        /// first report configures fresh and centers on ink; every later one
        /// (rotation, split view) preserves the viewport instead.
        var didConfigure = false
        init(_ parent: PencilCanvasView) {
            self.parent = parent
        }

        /// Routes a `BoardCanvasView` layout report to board setup. The first
        /// report restores the session's saved camera when it has one, otherwise
        /// it configures fresh and opens on the session's existing ink; every
        /// later one (rotation, split view) preserves the viewport instead.
        func handleViewportChange(canvas: BoardCanvasView, size: CGSize) {
            let pencilCanvas = canvas.pencilCanvas
            let isFirstReport = !didConfigure
            isApplyingViewportConfiguration = true
            defer { isApplyingViewportConfiguration = false }
            if isFirstReport, let camera = canvas.initialCamera {
                PencilCanvasConfiguration.configure(pencilCanvas, viewport: size, preserveViewport: false)
                canvas.restoreCamera(camera)
                didConfigure = true
                return
            }
            PencilCanvasConfiguration.configure(pencilCanvas, viewport: size, preserveViewport: !isFirstReport)
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
            host?.updateSceneOverlay()
            reportCameraIfNeeded()
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            host?.updateSceneOverlay()
            reportCameraIfNeeded()
        }

        /// True only while layout is configuring, restoring, or preserving the
        /// viewport. UIKit invokes scroll delegates synchronously from those
        /// setters, and those callbacks are geometry maintenance rather than a
        /// learner camera change.
        private var isApplyingViewportConfiguration = false

        /// Persists pan/zoom from the delegate callbacks. The scroll view
        /// reports continuously while a finger is down, so the store's rest
        /// timer gets re-armed per report exactly as the ink path does, keeping
        /// high-frequency camera updates out of `@Published` session state.
        ///
        /// The programmatic restore itself is not reported (see
        /// `handleViewportChange`); a later real pan is, because it changes the
        /// camera again.
        private func reportCameraIfNeeded() {
            guard !isApplyingViewportConfiguration else { return }
            guard let host else { return }
            parent.onCameraChange(host.camera)
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
