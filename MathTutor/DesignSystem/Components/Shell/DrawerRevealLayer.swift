import SwiftUI

/// The two panes of the docked panel, and the gesture that slides one off the other.
///
/// **This exists to be the only thing that re-renders while a finger is down.** It was written
/// inline in `TutorPanel` first, with the drag in that view's own `@State`, and on an iPad 6th
/// generation the reveal was visibly behind the finger. The reason is structural rather than a
/// slow drawing path: a `@State` write re-runs the body it lives in, so every touch event
/// rebuilt the *whole* panel — the message thread and each of its rows, the composer, the
/// fades, the session list — sixty times a second, to move two panes sideways.
///
/// Here the panes arrive as already-built view values and are stored. A drag re-runs only this
/// body, which hands the same two values back with new offsets and opacities; SwiftUI compares
/// them, finds them unchanged, and never asks the thread or the drawer for a body at all. The
/// per-frame work is then two offsets, two opacities and a clip, which is what it always should
/// have been.
///
/// The corollary is a rule for callers: **nothing progress-dependent may be passed into the
/// content**. The panes are handed to this type and never rebuilt for the gesture's sake, so
/// they cannot take an argument that changes while a finger is down — and nothing here needs
/// them to. Everything the gesture has to do to them, it does from the outside: it moves them,
/// veils them, and withdraws them from hit testing.
struct DrawerRevealLayer<Drawer: View, Chat: View>: View {
    /// How far the chat travels — the drawer's own width. See `SessionsDrawerMetrics`.
    let travel: CGFloat
    /// The panel's own frame. Both panes are laid out against it.
    let size: CGSize
    /// The settled state, which lives on `UIState` because the full-screen surface reads it
    /// too. The *live* position does not: see `drag`.
    let isOpen: Bool
    /// Called once, on release, with where the drawer settled. The caller wraps its own state
    /// write however it likes; the animation is already open around this call.
    let onSettle: (Bool) -> Void
    @ViewBuilder let drawer: Drawer
    @ViewBuilder let chat: Chat

    /// The reveal gesture in progress, or `nil` between gestures — board 18.
    ///
    /// `@State` here rather than on `UIState` for the reason `BoardScreen.previewPanelWidth` is
    /// local too: publishing an environment object on every touch event invalidates every
    /// consumer of it, and the board is one of them — the whole point of this type is that a
    /// drawer swipe must not ask `PKCanvasView` to lay itself out again. `UIState` learns the
    /// answer once, on release.
    ///
    /// It also carries the intent lock: the axis is decided once and stored for the rest of the
    /// touch, so a drag that starts sideways and curls downward keeps panning, and one that
    /// starts downward never pans at all.
    @State private var drag: Drag?

    /// One touch's committed answer.
    private struct Drag {
        /// Never `.undecided` — see `DrawerReveal.axis(for:)`. A drag is only stored once it
        /// has an answer, and until then the question is asked again on the next frame.
        let axis: DrawerReveal.Axis
        /// Where the drawer was when this touch landed — 0 or 1. Every frame resolves from this
        /// plus the gesture's *total* translation, never from the previous frame, which is the
        /// anchor rule `ResizeModel` is built on for the same reason: a per-frame sum
        /// accumulates rounding and drifts away from the finger over a long drag.
        let anchor: CGFloat
        var progress: CGFloat
    }

    /// Where the drawer is right now: the live drag if one has committed to the horizontal
    /// axis, and the settled state otherwise.
    private var progress: CGFloat {
        if let drag, drag.axis == .horizontal { return drag.progress }
        return isOpen ? 1 : 0
    }

    /// Whether this touch now belongs to the pan, and nothing else may act on it.
    ///
    /// This is the other half of the intent lock, and the half that makes it exclusive rather
    /// than merely simultaneous. It suppresses two different things, for one reason.
    ///
    /// **The scrollers.** `DragGesture(minimumDistance:)` and a `ScrollView` both recognise, so
    /// without this a diagonal drag pans the drawer *and* scrolls whatever is under the finger.
    /// The note: *"once the horizontal pan commits, vertical scroll is suppressed until the
    /// finger lifts."* Both lists, not just the thread — the gesture starts on either pane, so
    /// either pane's scroller can be the one competing with it.
    ///
    /// **The buttons.** A `Button` fires on touch-*up*, and its own cancellation is
    /// leave-the-bounds — which never triggers here, because a session row is 239 × 44 and a
    /// suggestion chip is 301 × 62, so a whole 100pt horizontal swipe starts and ends inside
    /// one control. A swipe across the drawer therefore opened whichever session it crossed.
    /// Disabling is the mechanism rather than a guard inside each action closure, and that is
    /// deliberate: it cancels a press that is already in flight, so the row stops looking
    /// pressed the instant the axis commits and its action is never reached. A guard would have
    /// to run *after* the gesture's own `onEnded` had already cleared the flag it read, which
    /// is an ordering SwiftUI does not promise.
    ///
    /// **Two mechanisms, because one of them only covers half the problem.**
    ///
    /// A press that would *begin* during a pan is stopped by `inertToTouches(_:)` on the whole
    /// container — hit testing is consulted when a touch lands, so a finger already sliding
    /// cannot pick up a new control on its way past.
    ///
    /// A press that had *already begun* when the axis committed is a different question, and on
    /// iPadOS 17 hit testing does not answer it: the target was resolved at touch-down and the
    /// in-flight press keeps it, so the button still fires on touch-up. That one needs
    /// `isEnabled`, which is what `inertDuringDrawerPan()` writes — disabling a control tears
    /// down its gesture, and a gesture that no longer exists cannot complete. It is published
    /// down the environment so the panes can read it without taking an argument that changes
    /// while a finger is down, which is the rule this whole type is built on.
    ///
    /// Both are applied to subtrees rather than to controls: there is no list of buttons to
    /// keep in step, and the one place the two differ — the composer, which must not be
    /// disabled or a focused field resigns and the keyboard drops mid-sentence — is expressed
    /// by where the modifier is attached, not by an exception inside it.
    private var isPanCommitted: Bool { drag?.axis == .horizontal }

    var body: some View {
        ZStack(alignment: .topLeading) {
            drawerPane
            chatPane
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        // Everything under the finger goes inert the moment the axis commits — one modifier,
        // both panes, every control in them. See `isPanCommitted` and `inertToTouches(_:)`.
        // It sits *below* the gesture, so the pan itself keeps receiving: the hit region the
        // recognizer uses is the `contentShape` on the outside of it.
        .inertToTouches(isPanCommitted)
        // **The panel's own bounds, restated here.** `TutorPanelSurface` already clips to this
        // radius, but its clip sits *under* the elevation shadow, and a shadow renders its
        // input into an offscreen buffer — so on iPadOS 17 the veil, mid-animation, was being
        // composited from that buffer and painting outside the dock. A clip inside the
        // animating container cannot be reordered against anything, and the two panes are the
        // only things that move, so this is the cheap place to guarantee it.
        .clipShape(RoundedRectangle(cornerRadius: TutorPanelMetrics.cornerRadius))
        // **The whole panel is the grab region, both panes.** Board 18 states the opening
        // half — *"A right-swipe anywhere in the chat area drags the drawer"* — and the closing
        // half has to hold on the other pane or the gesture is one-way: a left-swipe that starts
        // on a session row closes the drawer exactly as one that starts on the 74pt chat strip
        // does. So the gesture is on the container rather than on either child, and
        // `contentShape` makes the gaps between them grabbable too.
        //
        // Simultaneous rather than exclusive so a vertical drag still scrolls whichever list is
        // under the finger; the exclusivity the note asks for is the intent lock instead.
        .contentShape(.rect)
        .simultaneousGesture(pan)
        // A scroll already carrying momentum is stopped rather than left to coast under a pane
        // that has started moving. It reaches every scroller below through the environment, so
        // neither pane declares a parameter for it — which is the rule this type is built on,
        // since a parameter that changed while a finger was down would rebuild the pane it was
        // passed to. `isDrawerPanCommitted` travels the same way and for the same reason.
        .scrollDisabled(isPanCommitted)
        .environment(\.isDrawerPanCommitted, isPanCommitted)
    }

    /// Board 17's drawer, under the chat.
    ///
    /// It carries the white veil while it is the pane being covered, and loses it across the
    /// crossfade band — see `DrawerReveal.drawerVeil(at:)`. The veil is an overlay rather than
    /// an opacity on the drawer because it is a wash and not a fade: the surface colour stays
    /// exactly what the panel's is, which is the whole reason the seam between the two panes
    /// can be a rounded corner and nothing else.
    private var drawerPane: some View {
        drawer
            .frame(width: travel, height: size.height, alignment: .topLeading)
            .overlay(veil(DrawerReveal.drawerVeil(at: progress)))
            // The veil and the pane become one layer before either is moved. Without it the
            // wash is a second layer transformed independently, and a sub-pixel disagreement
            // between the two shows as a bright hairline down the seam.
            .compositingGroup()
            // **The drawer does not move.** Board 18's 12pt parallax is deliberately not
            // implemented — see `DrawerReveal.wholePoints(_:)` for the whole argument. It is
            // laid out once, at its full width, and the chat is the only thing that travels.
            // Unreachable while it is fully covered, so a stray touch on the strip's own edge
            // cannot land on a session row behind the chat.
            .allowsHitTesting(progress > 0)
            .accessibilityHidden(progress == 0)
    }

    /// Screens 05 and 08, as one opaque pane that travels.
    ///
    /// Opaque is load-bearing: it is the panel's own `--color-surface-panel`, and without it the
    /// drawer would read straight through the thread. Board 17 gives the two the same fill
    /// deliberately, so the boundary is carried by the pane's leading radius alone.
    ///
    /// The radius is 0 while the drawer is shut, which makes the closed state the panel exactly
    /// as it shipped: the pane fills the surface and the surface's own 28 is the only corner on
    /// screen.
    private var chatPane: some View {
        chat
            .frame(width: size.width, height: size.height, alignment: .top)
            .background(DS.Color.surfacePanel)
            // **Veil first, then clip.** This was the other half of the escaping-veil bug: the
            // wash used to be overlaid *after* the pane was clipped, so it kept its square
            // corners and its leading two spilled past the pane's rounded ones onto the drawer.
            // Inside the clip it is bounded by the same shape the pane is, at every frame of
            // the animation.
            .overlay(veil(DrawerReveal.chatVeil(at: progress)))
            .clipShape(
                UnevenRoundedRectangle(
                    topLeadingRadius: progress > 0 ? SessionsDrawerMetrics.stripCornerRadius : 0,
                    bottomLeadingRadius: progress > 0 ? SessionsDrawerMetrics.stripCornerRadius : 0
                )
            )
            .compositingGroup()
            // Board 18: *"A tap on the chat strip, or a left-swipe from it, closes the drawer."*
            // Mounted only while the drawer is showing, for the reason the switcher's dismiss
            // layer was: a view that swallows every touch on the chat is not something to leave
            // lying on it the rest of the time.
            .overlay {
                if progress > 0 {
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture {
                            withAnimation(DrawerReveal.settle(velocity: 0, travel: travel)) {
                                drag = nil
                                onSettle(false)
                            }
                        }
                        .accessibilityLabel("Close sessions")
                        .accessibilityAddTraits(.isButton)
                }
            }
            // Whole points. A `compositingGroup` rasterises the pane, and translating that
            // raster by a fraction resamples every glyph in it a little differently on every
            // frame — which on an A10 at 2x reads as the contents shimmering rather than
            // sliding. The travel is 263 points, so rounding costs nothing anyone can see.
            .offset(x: DrawerReveal.wholePoints(progress * travel))
    }

    /// The wash. White at an alpha, over content, with the surface colour untouched.
    ///
    /// Always mounted, at zero opacity when there is nothing to show, rather than inserted when
    /// the alpha rises. An overlay that appears mid-animation is a structural change to the
    /// tree, and SwiftUI gives it its own implicit transition — which is one more thing to
    /// composite on exactly the frames that are already the most expensive.
    private func veil(_ alpha: Double) -> some View {
        DS.Color.surface
            .opacity(alpha)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// Board 18's pan.
    ///
    /// `minimumDistance` is the intent threshold itself, so the first frame this ever sees is
    /// already far enough to have an axis and no travel is spent undecided. It is also what
    /// keeps every button on the panel working: a tap does not move 12 points.
    private var pan: some Gesture {
        DragGesture(minimumDistance: DrawerReveal.intentThreshold, coordinateSpace: .local)
            .onChanged { value in
                // `.undecided` means "ask again", so it is never stored — the guard re-asks on
                // the next frame instead of latching an answer the vector was too short to
                // give. It cannot happen while `minimumDistance` and the threshold agree, and
                // it is what stops that agreement being load-bearing.
                let axis = drag?.axis ?? DrawerReveal.axis(for: value.translation)
                guard axis != .undecided else { return }
                let anchor = drag?.anchor ?? (isOpen ? 1 : 0)
                guard axis == .horizontal else {
                    drag = Drag(axis: axis, anchor: anchor, progress: anchor)
                    return
                }
                drag = Drag(
                    axis: .horizontal,
                    anchor: anchor,
                    progress: DrawerReveal.progress(
                        from: anchor,
                        translation: value.translation.width,
                        travel: travel
                    )
                )
            }
            .onEnded { value in
                guard let drag else { return }
                guard drag.axis == .horizontal else {
                    self.drag = nil
                    return
                }
                let opens = DrawerReveal.settlesOpen(
                    progress: drag.progress,
                    velocity: value.velocity.width
                )
                // Both writes inside the one transaction. Clearing the drag outside it would
                // hand `progress` straight back to the settled value and the pane would jump to
                // its destination instead of springing to it.
                withAnimation(DrawerReveal.settle(velocity: value.velocity.width, travel: travel)) {
                    self.drag = nil
                    onSettle(opens)
                }
            }
    }
}

// MARK: - Going inert while a gesture owns the touch

private struct DrawerPanCommittedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Whether a drawer pan has committed to the horizontal axis for the touch in progress.
    ///
    /// Published by `DrawerRevealLayer` and read by `inertDuringDrawerPan()`. An environment
    /// value rather than an argument for two reasons: it reaches a control eight levels down
    /// without every view in between declaring a parameter it does not use, and — the
    /// load-bearing one — it changes twice per gesture rather than every frame, so the panes
    /// can stay untouched view values while the pan is running.
    var isDrawerPanCommitted: Bool {
        get { self[DrawerPanCommittedKey.self] }
        set { self[DrawerPanCommittedKey.self] = newValue }
    }
}

private struct InertDuringDrawerPan: ViewModifier {
    @Environment(\.isDrawerPanCommitted) private var isPanCommitted

    func body(content: Content) -> some View {
        content.disabled(isPanCommitted)
    }
}

extension View {
    /// Cancels any press in this subtree that is already under way when a drawer pan commits.
    ///
    /// **This is the half `inertToTouches(_:)` cannot do.** Hit testing is consulted when a
    /// touch lands: withdrawing a view from it stops a *new* touch finding a control, but a
    /// press that began before the pan committed has already resolved its target and keeps it,
    /// so on iPadOS 17 the button fires on touch-up regardless. A `Button` acts on touch-*up*
    /// and cancels only when the finger leaves its bounds, which never happens here — a session
    /// row is 239 × 44 and a suggestion chip is 301 × 62, so a whole 100pt swipe starts and
    /// ends inside one control.
    ///
    /// `disabled` reaches it because it does not filter events, it removes the recogniser:
    /// `isEnabled` going false tears the control's gesture out of the view, and a gesture that
    /// no longer exists cannot complete or fire its action. The pressed state clears with it.
    ///
    /// **Attach it to a subtree that contains no text field.** That is the whole of the
    /// keyboard exception, and it is structural rather than a list: `disabled` resigns a focused
    /// `TextField`'s first responder, so a swipe mid-sentence would drop the keyboard. The
    /// composer is a sibling of everything this is applied to, never a descendant.
    func inertDuringDrawerPan() -> some View {
        modifier(InertDuringDrawerPan())
    }

    /// Stops this subtree responding to touches, without changing whether it is *enabled*.
    ///
    /// The one mechanism the drawer's gesture uses to keep a swipe from pressing what it
    /// crosses, applied once at the pan surface rather than control by control. A `Button`
    /// fires on touch-*up* and cancels only when the finger leaves its bounds — which never
    /// happens here, because a session row is 239 × 44 and a suggestion chip is 301 × 62, so a
    /// whole 100pt horizontal swipe starts and ends inside one control. Withdrawing the subtree
    /// from hit testing ends the press that is already in flight, so the control stops looking
    /// pressed at the instant the axis commits and its action is never reached.
    ///
    /// **It covers touches that have not landed yet, and only those.** Hit testing is consulted
    /// when a touch begins, so this cannot reach a press that is already under way — that was
    /// found the hard way on an iPadOS 17 device, where a swipe still pressed the button it
    /// started on. `inertDuringDrawerPan()` is the other half and cancels those.
    ///
    /// It is worth keeping both rather than collapsing to the second: this one is safe to put
    /// over *everything*, the composer included, because it changes neither focus nor
    /// enablement — so a finger already travelling cannot pick up a new control on its way
    /// past, including one inside the composer that `disabled` must never touch.
    ///
    /// Applied *inside* whatever carries the gesture. The recognizer's own hit region comes
    /// from the `contentShape` outside this, so the pan keeps receiving while everything it is
    /// panning over has stopped.
    func inertToTouches(_ inert: Bool) -> some View {
        allowsHitTesting(!inert)
    }
}
