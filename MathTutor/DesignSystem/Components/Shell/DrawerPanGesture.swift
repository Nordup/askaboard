import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// One point the finger actually visited, as a time-stamped coordinate in window points.
///
/// UIKit delivers far more of these than a `touchesMoved` callback — `UIEvent` carries the
/// coalesced touches between two events — and the release velocity only has the energy the
/// recogniser actually saw. A velocity that samples just once per callback misses exactly the
/// terminal movement that decides a flick.
struct DrawerVelocitySample {
    let timestamp: TimeInterval
    let x: CGFloat
    let y: CGFloat
}

/// A time-aware estimator of the finger's recent speed, kept separate from the recogniser so
/// the windowing, the dedup and the terminal sample are assertable without a touch host.
///
/// The raw last-sample quotient is digitiser noise — a 2pt step over 4ms reads as 500pt/s —
/// so the answer is a least-squares linear regression over a short recent window. The window
/// is short enough (80ms) that a real flick keeps its energy, and a regression of
/// time-stamped points averages out a single noisy last sample instead of trusting it.
struct DrawerVelocitySampler {

    /// How far back the regression looks. A flick across 263 points takes ~200ms at the
    /// fling's 1300pt/s, so 80ms retains the moving tail without reaching back into the
    /// deliberate placement the flick begins from.
    static let window: TimeInterval = 0.08

    /// The smallest time span over which a regression is trusted. One 240Hz touch-sampling
    /// interval is enough to preserve a genuinely fast sub-frame flick; anything shorter is
    /// still the single-sample digitiser noise the window exists to reject.
    static let minimumSpan: TimeInterval = 1.0 / 240.0

    /// The samples inside the window, in timestamp order. Only the most recent window's worth
    /// is kept. Eighty milliseconds is long enough to average digitiser jitter without
    /// washing a quick terminal flick into the slower placement that preceded it.
    private(set) var samples: [DrawerVelocitySample] = []

    /// Start a new touch sequence. `origin` seeds the first visit so a still finger produces
    /// no velocity even though it produced no movement.
    mutating func reset(origin: CGPoint, timestamp: TimeInterval = 0) {
        samples = [DrawerVelocitySample(timestamp: timestamp, x: origin.x, y: origin.y)]
    }

    /// Ingests a visited point. Coalesced touches arrive in timestamp order but can repeat the
    /// same moment, so only a strictly newer timestamp is a new sample — an equal or
    /// non-increasing one is the same visit again and is ignored.
    mutating func feed(point: CGPoint, timestamp: TimeInterval) {
        if let last = samples.last, timestamp <= last.timestamp { return }
        samples.append(DrawerVelocitySample(timestamp: timestamp, x: point.x, y: point.y))
        trim(to: timestamp)
    }

    /// The recent speed in points per second, from the regression of time against position.
    mutating func velocity() -> CGPoint {
        guard let first = samples.first, let last = samples.last else { return .zero }
        let span = last.timestamp - first.timestamp
        guard span >= Self.minimumSpan else { return .zero }
        return Self.regressionSlope(samples)
    }

    /// Removes every sample older than the window, keeping at least the newest one.
    private mutating func trim(to now: TimeInterval) {
        let cutoff = now - Self.window
        while samples.count > 1, let first = samples.first, first.timestamp < cutoff {
            samples.removeFirst()
        }
    }

    /// The least-squares slope of point against time for each axis. `n` is at least 2 here
    /// because `velocity()` guarded the span, and a zero time-variance (all samples at one
    /// instant) yields zero rather than a divide-by-zero. Time is centred on the first sample
    /// before it is squared: `UITouch.timestamp` is system uptime, and after days of uptime a
    /// raw `sum(t²) - sum(t)²/n` subtracts two huge nearly equal numbers to recover an 80ms
    /// variance. Centring keeps that fit numerically stable however long the device has run.
    private static func regressionSlope(_ samples: [DrawerVelocitySample]) -> CGPoint {
        guard let timeOrigin = samples.first?.timestamp else { return .zero }
        let n = Double(samples.count)
        let sumT = samples.reduce(0) { $0 + ($1.timestamp - timeOrigin) }
        let sumX = samples.reduce(0) { $0 + Double($1.x) }
        let sumY = samples.reduce(0) { $0 + Double($1.y) }
        let sumTX = samples.reduce(0) {
            $0 + ($1.timestamp - timeOrigin) * Double($1.x)
        }
        let sumTY = samples.reduce(0) {
            $0 + ($1.timestamp - timeOrigin) * Double($1.y)
        }
        let sumTT = samples.reduce(0) {
            let t = $1.timestamp - timeOrigin
            return $0 + t * t
        }
        let denominator = sumTT - sumT * sumT / n
        guard denominator != 0 else { return .zero }
        return CGPoint(
            x: (sumTX - sumT * sumX / n) / denominator,
            y: (sumTY - sumT * sumY / n) / denominator
        )
    }
}

/// The drawer's pan, recognised in UIKit so that its commitment can *cancel* — which is the
/// one thing three generations of SwiftUI-side fixes could not do.
///
/// The history, so it is not re-litigated: a swipe across either drawer surface kept pressing
/// the controls it crossed, because a SwiftUI `Button` fires on touch-*up* and cancels only
/// when the finger leaves its bounds — and a session row is 227 × 44, so a whole 100pt swipe
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

    /// Points per second, fitted over the recent coalesced touch samples. The raw last-sample
    /// quotient is digitiser noise — a 2pt step over 4ms reads as 500pt/s — and
    /// `DrawerReveal.flingVelocity` draws a line at 300, so the estimate has to be steadier
    /// than one sample without averaging away a real terminal flick.
    private(set) var velocity: CGPoint = .zero

    /// The first touch down, and the only one this recogniser ever reads. Later fingers are
    /// `ignore`d rather than averaged: the drawer is a one-finger gesture, and a second
    /// finger resting on the panel must not yank the translation between the two.
    private weak var trackedTouch: UITouch?
    private var origin: CGPoint = .zero
    private var velocitySampler = DrawerVelocitySampler()

    /// The touch sequence is over, whatever ended it — see `reset()`.
    ///
    /// The argument is the last translation this recogniser measured, because `reset()` clears
    /// it and a stranded gesture still has to settle *somewhere*.
    var onTerminate: ((CGFloat) -> Void)?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if trackedTouch == nil, let touch = touches.first {
            trackedTouch = touch
            origin = touch.location(in: nil)
            velocitySampler.reset(origin: origin, timestamp: touch.timestamp)
        }
        for touch in touches where touch !== trackedTouch {
            ignore(touch, for: event)
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        let point = touch.location(in: nil)
        translation = CGPoint(x: point.x - origin.x, y: point.y - origin.y)
        // UIKit hands out the coalesced touches *between* this event and the previous one,
        // the current touch included. They carry the movement a once-per-callback sample
        // would skip, and they arrive in timestamp order — feeding them in that order lets
        // the terminal fast movement actually reach the velocity. Equal timestamps are the
        // same visit and the sampler dedupes them.
        let coalesced = (event.coalescedTouches(for: touch) ?? [touch])
            .sorted { $0.timestamp < $1.timestamp }
        for sampleTouch in coalesced {
            let samplePoint = sampleTouch.location(in: nil)
            velocitySampler.feed(point: samplePoint, timestamp: sampleTouch.timestamp)
        }
        velocity = velocitySampler.velocity()

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
        let point = touch.location(in: nil)
        translation = CGPoint(
            x: point.x - origin.x,
            y: point.y - origin.y
        )
        // The terminal ended touch is the most recent movement there is — it is exactly the
        // fast tail a flick is thrown with — so it is fed before the velocity is published.
        velocitySampler.feed(point: point, timestamp: touch.timestamp)
        velocity = velocitySampler.velocity()
        state = state == .possible ? .failed : .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        state = state == .possible ? .failed : .cancelled
    }

    /// **The one exit every touch sequence takes, and the reason the commit can be trusted to
    /// end.**
    ///
    /// `.ended` and `.cancelled` are not the whole of how a recogniser stops. UIKit also ends
    /// one by flipping `isEnabled` off — which is what `cancelOtherRecognizers(for:)` does to
    /// every recogniser on a committing touch, this class's siblings included — and by
    /// `removeGestureRecognizer`, which `AnchorView.didMoveToWindow` and `dismantleUIView` both
    /// call. **Neither of those sends an action message**, so a pan that had already committed
    /// left its owner's flag set with nothing left to clear it: the panel kept
    /// `inertToTouches`, or `DockRevealModel.isActive` stayed true, and the surface went on
    /// drawing perfectly while refusing every touch. `DockRevealModel` is `BoardScreen`'s, so
    /// that one survived until the app was relaunched.
    ///
    /// `reset()` is called after all four — the two states and the two silent cancellations —
    /// so the end is delivered from here and the coordinator's `PanEndLatch` makes it exactly
    /// once. Guarding the known silent paths one at a time would leave the next one.
    override func reset() {
        // Before `super`, and before the fields below are cleared: a stranded gesture still has
        // to settle at wherever the finger actually left it.
        let finalTranslation = translation.x
        super.reset()
        trackedTouch = nil
        translation = .zero
        velocity = .zero
        velocitySampler.reset(origin: .zero)
        onTerminate?(finalTranslation)
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

// MARK: - Exactly one end per commit

/// Whether the pan that committed has been settled yet.
///
/// Every surface the pan drives sets a flag in `onCommit` and clears it in `onEnd` — the docked
/// panel's `drag` and `isCollapsing`, `DockRevealModel.progress`, the full-screen surface's
/// `isPanCommitted` — and each of those flags withdraws a whole surface from hit testing while
/// it holds. So a missed `onEnd` is not a dropped frame; it is a surface that draws normally and
/// answers no touch until it unmounts.
///
/// The recogniser now reports its end from up to two places — the state transition and
/// `reset()` — and a released pan legitimately hits both. This is what makes the second one a
/// no-op: a value type, because the whole of the state is one flag and the coordinator is the
/// only thing that owns one.
struct PanEndLatch {
    private(set) var isCommitted = false

    /// The pan committed to the axis. Idempotent: a second commit without an end in between is
    /// the same open gesture.
    mutating func commit() { isCommitted = true }

    /// Whether *this* is the end to deliver. True once per commit, and false for every report
    /// that arrives after it — or for one that arrives with no commit behind it at all, which
    /// is every `reset()` of a tap or a vertical scroll.
    mutating func end() -> Bool {
        guard isCommitted else { return false }
        isCommitted = false
        return true
    }
}

// MARK: - The SwiftUI bridge

private struct DrawerPanSuspendedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True while something is drawn *over* the pan surface in the same SwiftUI tree — the
    /// settings window, or `BoardScreen`'s context-menu shield — and a touch must reach that
    /// thing instead of the drawer.
    ///
    /// This exists because the recogniser is attached to a UIKit ancestor and gated by
    /// geometry, so unlike the old SwiftUI gesture it cannot see SwiftUI's paint order: a
    /// SwiftUI overlay is the same `UIView` as everything under it. Presented UIKit surfaces
    /// — the photo picker, the camera, the file importer — need no flag; they live outside
    /// the hosting view and the recogniser never receives their touches. A context menu is
    /// the exception it looks like it isn't: the *menu* lives in its own window, but on
    /// iPadOS 17 the tap that dismisses it is also delivered to this window, so the menu
    /// suspends the pan through this flag for exactly that touch.
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
    /// Whether a touch from an Apple Pencil is refused outright, before the intent lock is
    /// ever consulted.
    ///
    /// `false` everywhere the region is a tutor surface: a pencil resting on the chat and
    /// swiping is a swipe, and there is nothing on that surface for it to be doing instead.
    /// `true` for the collapsed state's leading-edge zone, which is 24 points of screen beside
    /// a whiteboard: in this app a pencil is always drawing and never navigating, so a pencil
    /// stroke that starts near the edge must reach `PKCanvasView` intact — not commit, cancel
    /// the canvas's recognisers and leave a 12-point orphan of a stroke behind.
    ///
    /// Refused at `shouldReceive`, which is touch-*down*, so the recogniser never enters
    /// `.possible` for that touch at all and there is no window in which it could cancel
    /// anything.
    var ignoresPencil = false
    /// The touch committed to the horizontal axis, with the translation that decided it —
    /// already past `DrawerReveal.intentThreshold` and inside its cone, so its sign is the
    /// gesture's direction. Everything else the touch was pressing is already cancelled by the
    /// time this runs.
    ///
    /// The direction is delivered *here*, at commitment, because that is when it is decided
    /// and the routing table is read exactly once — see `HorizontalSwipeRouter`. A route
    /// re-chosen on a later frame is what turns two distinct gestures into one ambiguous one.
    var onCommit: (_ translation: CGFloat) -> Void
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
        // The backstop for every way UIKit can stop a committed pan without an action message —
        // see `DrawerPanRecognizer.reset()`. Weak because the recogniser outlives this
        // representable: it is owned by the ancestor it is attached to, not by the anchor.
        recognizer.onTerminate = { [weak coordinator = context.coordinator] translation in
            coordinator?.terminate(translation)
        }
        view.recognizer = recognizer
        context.coordinator.anchor = view
        return view
    }

    func updateUIView(_ uiView: AnchorView, context: Context) {
        context.coordinator.onCommit = onCommit
        context.coordinator.onChange = onChange
        context.coordinator.onEnd = onEnd
        context.coordinator.isSuspended = isSuspended
        context.coordinator.ignoresPencil = ignoresPencil
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
        var ignoresPencil = false
        var onCommit: (CGFloat) -> Void = { _ in }
        var onChange: (CGFloat) -> Void = { _ in }
        var onEnd: (CGFloat, CGFloat) -> Void = { _, _ in }

        /// Whether the committed pan still owes its owner an `onEnd` — see `PanEndLatch`.
        private var latch = PanEndLatch()

        @objc func handlePan(_ recognizer: DrawerPanRecognizer) {
            switch recognizer.state {
            case .began:
                latch.commit()
                onCommit(recognizer.translation.x)
                // The first frame already carries the 12pt decision vector, so it is
                // delivered rather than dropped — the same "no travel spent undecided"
                // rule `DragGesture(minimumDistance:)` gave the old implementation.
                onChange(recognizer.translation.x)
            case .changed:
                onChange(recognizer.translation.x)
            case .ended:
                if latch.end() { onEnd(recognizer.translation.x, recognizer.velocity.x) }
            case .cancelled:
                if latch.end() { onEnd(recognizer.translation.x, 0) }
            default:
                break
            }
        }

        /// The touch sequence is over and no state transition reported it — a sibling
        /// recogniser disabled this one mid-pan, or the anchor left its window. See
        /// `DrawerPanRecognizer.reset()`.
        ///
        /// Velocity 0, which is the same answer `.cancelled` already gives: a gesture nobody
        /// released has no fling, so the surface settles by position. Called after *every*
        /// sequence, released ones included, and the latch is what makes those a no-op.
        func terminate(_ translation: CGFloat) {
            // Claimed synchronously, delivered later: the latch has to close now, or a report
            // arriving in between would settle the same gesture twice.
            guard latch.end() else { return }
            // **Out of the current transaction.** `reset()` is reachable from
            // `dismantleUIView`, which SwiftUI runs inside an update, and `onEnd` writes the
            // state of the very surface being torn down — the hazard `BoardCanvas.swift`
            // carries the scar of. One runloop turn later the tree has settled and the write is
            // an ordinary one. The delay costs nothing anyone can see: this path only runs when
            // the gesture had already been stopped without telling us, and a frame is what it
            // saves against a surface that stays inert until it unmounts.
            //
            // The callback is read *inside* the hop rather than captured, the rule
            // `BoardCanvas.updateFirstResponder` already follows: `updateUIView` may have handed
            // this coordinator a newer one, and the newer one owns the flag that needs clearing.
            DispatchQueue.main.async { [weak self] in
                self?.onEnd(translation, 0)
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
            // See `DrawerPanGesture.ignoresPencil`: refused here rather than at commitment, so
            // the recogniser never analyses the touch and never cancels anything holding it.
            if ignoresPencil, touch.type == .pencil { return false }
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
