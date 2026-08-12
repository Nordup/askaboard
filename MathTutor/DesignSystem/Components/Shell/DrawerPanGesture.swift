import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// The drawer's pan, recognised in UIKit so that its commitment can *cancel* — which is the
/// one thing three generations of SwiftUI-side fixes could not do.
///
/// The history, so it is not re-litigated: a swipe across either drawer surface kept pressing
/// the controls it crossed, because a SwiftUI `Button` fires on touch-*up* and cancels only
/// when the finger leaves its bounds — and a session row is 239 × 44, so a whole 100pt swipe
/// starts and ends inside one control. The fixes tried, in order: per-control `.disabled`
/// lists (missed controls), container `allowsHitTesting` (cannot reach a press already in
/// flight on iPadOS 17), and structural `.disabled` groups with the composer exempted as a
/// sibling — because `.disabled` resigns a focused `TextField` and drops the keyboard. That
/// exemption was itself the last hole: the composer's own buttons still fired under a swipe.
///
/// This type is the universal mechanism that replaces all of them, and it is what
/// `UIScrollView` does: when the touch commits to the horizontal axis — `DrawerReveal`'s own
/// 12pt / 38° arithmetic, not a re-derivation — the recognizer transitions to `.began` and
/// **every other recogniser analysing that touch is cancelled at the UIKit level**. That kills
/// an in-flight SwiftUI press natively, composer included, without disabling anything — touch
/// cancellation does not resign first responder, so the keyboard stays up mid-sentence. And
/// because commitment is a property of the *touch* and not of the drawer, it fires just the
/// same at a travel boundary where the pan produces no visible motion: a left-swipe on an
/// already-open drawer still cancels what it crosses.
///
/// A vertical start fails fast instead, so scrolling is exactly what it was; and a tap never
/// travels the 12 points, so it never meets this type at all. A still finger commits nothing
/// either, which is what keeps the session rows' long-press context menu alive.
final class DrawerPanRecognizer: UIGestureRecognizer {

    /// The tracked touch's total travel from touch-down, in window points. The same
    /// total-from-anchor a `DragGesture` reports, for the same reason `ResizeModel` demands
    /// it: a per-frame sum accumulates rounding and drifts off the finger.
    private(set) var translation: CGPoint = .zero

    /// Points per second, lightly low-passed. The raw last-sample quotient is digitiser
    /// noise — a 2pt step over 4ms reads as 500pt/s — and `DrawerReveal.flingVelocity`
    /// draws a line at 300, so the estimate has to be steadier than one sample.
    private(set) var velocity: CGPoint = .zero

    /// The first touch down, and the only one this recogniser ever reads. Later fingers are
    /// `ignore`d rather than averaged: the drawer is a one-finger gesture, and a second
    /// finger resting on the panel must not yank the translation between the two.
    private weak var trackedTouch: UITouch?
    private var origin: CGPoint = .zero
    private var lastPoint: CGPoint = .zero
    private var lastTimestamp: TimeInterval = 0

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if trackedTouch == nil, let touch = touches.first {
            trackedTouch = touch
            origin = touch.location(in: nil)
            lastPoint = origin
            lastTimestamp = touch.timestamp
        }
        for touch in touches where touch !== trackedTouch {
            ignore(touch, for: event)
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        let point = touch.location(in: nil)
        let dt = touch.timestamp - lastTimestamp
        if dt > 0 {
            velocity = CGPoint(
                x: 0.25 * velocity.x + 0.75 * (point.x - lastPoint.x) / dt,
                y: 0.25 * velocity.y + 0.75 * (point.y - lastPoint.y) / dt
            )
            lastPoint = point
            lastTimestamp = touch.timestamp
        }
        translation = CGPoint(x: point.x - origin.x, y: point.y - origin.y)

        switch state {
        case .possible:
            // The intent lock, verbatim from `DrawerReveal`: `.undecided` means "ask again
            // next frame", never an answer to store.
            switch DrawerReveal.axis(for: CGSize(width: translation.x, height: translation.y)) {
            case .undecided:
                break
            case .vertical:
                state = .failed
            case .horizontal:
                // Order matters only in that both must happen: the cancellation is explicit
                // (see the method's own doc for why `cancelsTouchesInView` alone is not
                // enough), and `.began` is what tells the SwiftUI side to start tracking.
                cancelOtherRecognizers(for: touch)
                state = .began
            }
        case .began, .changed:
            state = .changed
        default:
            break
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        translation = CGPoint(
            x: touch.location(in: nil).x - origin.x,
            y: touch.location(in: nil).y - origin.y
        )
        state = state == .possible ? .failed : .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        state = state == .possible ? .failed : .cancelled
    }

    override func reset() {
        super.reset()
        trackedTouch = nil
        translation = .zero
        velocity = .zero
    }

    /// The whole point of this class: on commitment, every other recogniser still analysing
    /// the tracked touch is cancelled.
    ///
    /// Explicit rather than left to UIKit's exclusivity, because the delegate deliberately
    /// answers *simultaneous* for everything — that is what keeps a scroll, a tap and a
    /// long-press behaving exactly as today for every touch that never commits. The price of
    /// simultaneity is that `.began` no longer forces the others out on its own, so this does
    /// it by hand: flipping `isEnabled` off and back on is UIKit's documented lever for
    /// cancelling a recogniser mid-analysis — a recognising one is sent to `.cancelled`, a
    /// `.possible` one drops the touch and can never fire from it. The `.possible` case is
    /// load-bearing: a tap recogniser sits in `.possible` until touch-*up*, so an in-flight
    /// SwiftUI button press is exactly a `.possible` recogniser waiting to fire.
    ///
    /// Scoped to descendants of the view this recogniser is attached to, so the window's own
    /// system recognisers — the keyboard gate, the edge-swipe gates — are never touched.
    private func cancelOtherRecognizers(for touch: UITouch) {
        guard let host = view else { return }
        for other in touch.gestureRecognizers ?? [] {
            guard other !== self,
                  let otherView = other.view, otherView.isDescendant(of: host),
                  other.state == .possible || other.state == .began || other.state == .changed
            else { continue }
            other.isEnabled = false
            other.isEnabled = true
        }
    }
}

// MARK: - The SwiftUI bridge

private struct DrawerPanSuspendedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True while something is drawn *over* the pan surface in the same SwiftUI tree — the
    /// settings window, today — and a swipe must reach that thing instead of the drawer.
    ///
    /// This exists because the recogniser is attached to a UIKit ancestor and gated by
    /// geometry, so unlike the old SwiftUI gesture it cannot see SwiftUI's paint order: a
    /// SwiftUI overlay is the same `UIView` as everything under it. Presented UIKit surfaces
    /// — the photo picker, the camera, the file importer, a context menu — need no flag; they
    /// live outside the hosting view and the recogniser never receives their touches.
    var isDrawerPanSuspended: Bool {
        get { self[DrawerPanSuspendedKey.self] }
        set { self[DrawerPanSuspendedKey.self] = newValue }
    }
}

/// Mount this in a `.background` of the pan surface: its own frame is the grab region, and
/// the callbacks are the gesture — committed horizontal pans only, translations and release
/// velocity in points, exactly the values `DrawerReveal`'s arithmetic takes.
///
/// The view itself takes no touches at all. The recogniser is attached to the topmost UIKit
/// ancestor under the window — the hosting view's own container — because a pass-through
/// overlay cannot both refuse hit-testing and receive touches; an ancestor receives every
/// touch in the subtree, and the delegate narrows that firehose to touches that *begin*
/// inside this view's bounds. Attaching below the window (rather than to it) is also what
/// keeps presented pickers, sheets and the keyboard out of reach: they are siblings of the
/// hosting hierarchy, not descendants.
struct DrawerPanGesture: UIViewRepresentable {
    /// The touch committed to the horizontal axis. Everything else it was pressing is
    /// already cancelled by the time this runs.
    var onCommit: () -> Void
    /// The committed pan moved; the value is the touch's total horizontal travel from
    /// touch-down — the same total a `DragGesture.Value.translation.width` reports.
    var onChange: (CGFloat) -> Void
    /// The committed pan finished: total horizontal travel, and release velocity in points
    /// per second. Also called, with velocity 0, when the system cancels the touch — the
    /// drawer settles by position, which is the least surprising place for it to land.
    var onEnd: (_ translation: CGFloat, _ velocity: CGFloat) -> Void

    @Environment(\.isDrawerPanSuspended) private var isSuspended

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        let recognizer = DrawerPanRecognizer()
        recognizer.delegate = context.coordinator
        recognizer.addTarget(context.coordinator, action: #selector(Coordinator.handlePan(_:)))
        view.recognizer = recognizer
        context.coordinator.anchor = view
        return view
    }

    func updateUIView(_ uiView: AnchorView, context: Context) {
        context.coordinator.onCommit = onCommit
        context.coordinator.onChange = onChange
        context.coordinator.onEnd = onEnd
        context.coordinator.isSuspended = isSuspended
    }

    static func dismantleUIView(_ uiView: AnchorView, coordinator: Coordinator) {
        if let recognizer = uiView.recognizer {
            recognizer.view?.removeGestureRecognizer(recognizer)
        }
        uiView.recognizer = nil
    }

    /// The region view. Invisible, untouchable, and the recogniser's geometry reference —
    /// it re-homes the recogniser onto the right ancestor every time it lands in a window.
    final class AnchorView: UIView {
        var recognizer: DrawerPanRecognizer?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let recognizer else { return }
            recognizer.view?.removeGestureRecognizer(recognizer)
            guard window != nil, let target = attachTarget else { return }
            target.addGestureRecognizer(recognizer)
        }

        /// The last ancestor before the window: the root of the hosting hierarchy this view
        /// lives in. Everything SwiftUI draws for this scene is a descendant of it, and
        /// nothing presented over the scene is.
        private var attachTarget: UIView? {
            var candidate = superview
            while let view = candidate, let parent = view.superview {
                if parent is UIWindow { return view }
                candidate = parent
            }
            return candidate
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        weak var anchor: AnchorView?
        var isSuspended = false
        var onCommit: () -> Void = {}
        var onChange: (CGFloat) -> Void = { _ in }
        var onEnd: (CGFloat, CGFloat) -> Void = { _, _ in }

        @objc func handlePan(_ recognizer: DrawerPanRecognizer) {
            switch recognizer.state {
            case .began:
                onCommit()
                // The first frame already carries the 12pt decision vector, so it is
                // delivered rather than dropped — the same "no travel spent undecided"
                // rule `DragGesture(minimumDistance:)` gave the old implementation.
                onChange(recognizer.translation.x)
            case .changed:
                onChange(recognizer.translation.x)
            case .ended:
                onEnd(recognizer.translation.x, recognizer.velocity.x)
            case .cancelled:
                onEnd(recognizer.translation.x, 0)
            default:
                break
            }
        }

        /// The geometry gate: the recogniser hears the whole hosting hierarchy, and this
        /// narrows it to touches that begin inside the anchor's bounds. Decided at
        /// touch-*down* once per touch, which is the same moment hit-testing would have
        /// decided it.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch
        ) -> Bool {
            guard !isSuspended, let anchor, anchor.window != nil else { return false }
            return anchor.bounds.contains(touch.location(in: anchor))
        }

        /// Simultaneous with everything, always. Nothing may block the pan from watching a
        /// touch, and the pan blocks nothing until the touch commits — at which point
        /// `DrawerPanRecognizer.cancelOtherRecognizers(for:)` is the exclusivity, applied
        /// once, by hand, to exactly the touch that committed.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}
