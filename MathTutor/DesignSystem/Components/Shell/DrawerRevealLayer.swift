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
struct DrawerRevealLayer<Drawer: View, Chat: View, Chrome: View>: View {
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
    /// What belongs to the **dock** rather than to either pane: drawn last, at the panel's own
    /// coordinates, and never moved, veiled or clipped by the reveal.
    ///
    /// Boards 17 and 18 put the layout pair here. It was a child of the chat until it was drawn
    /// against the device: the pair travelled with the pane, slid 263 points to the right and
    /// then clipped in half at the pane's edge, so the one control that puts the panel away was
    /// unreachable exactly while the drawer was open over it. It is chrome of the surface, not
    /// content of a pane, and this slot is where that distinction is expressed.
    ///
    /// It is *inside* the container, deliberately, so it inherits everything the panes inherit
    /// from it: `inertToTouches` cancels a press on it the moment the pan commits, the same as
    /// anywhere else, and the pan can start on it.
    @ViewBuilder let chrome: Chrome

    /// The committed pan in progress, or `nil` between gestures — board 18.
    ///
    /// `@State` here rather than on `UIState` for the reason `BoardScreen.previewPanelWidth` is
    /// local too: publishing an environment object on every touch event invalidates every
    /// consumer of it, and the board is one of them — the whole point of this type is that a
    /// drawer swipe must not ask `PKCanvasView` to lay itself out again. `UIState` learns the
    /// answer once, on release.
    ///
    /// Only ever a *horizontal* pan. The intent lock lives in `DrawerPanRecognizer` now: a
    /// vertical start fails there and never reaches this view at all, so there is no axis to
    /// store — a stored drag *is* the commitment.
    @State private var drag: Drag?

    /// One committed touch's state.
    private struct Drag {
        /// Where the drawer was when this touch landed — 0 or 1. Every frame resolves from this
        /// plus the gesture's *total* translation, never from the previous frame, which is the
        /// anchor rule `ResizeModel` is built on for the same reason: a per-frame sum
        /// accumulates rounding and drifts away from the finger over a long drag.
        let anchor: CGFloat
        var progress: CGFloat
    }

    /// Where the drawer is right now: the live drag if one has committed, and the settled
    /// state otherwise.
    private var progress: CGFloat {
        drag?.progress ?? (isOpen ? 1 : 0)
    }

    /// Whether a pan owns the touch in progress.
    ///
    /// The heavy lifting — cancelling the presses and the scroll of the *committing* touch —
    /// is UIKit's now: `DrawerPanRecognizer` cancels every other recogniser on that touch at
    /// the instant the axis commits, which is what `UIScrollView` does and what no SwiftUI-side
    /// mechanism could reach on iPadOS 17. What this flag still drives is the touches that
    /// come *after*: `inertToTouches(_:)` keeps a second finger from picking up a control
    /// mid-pan, and `scrollDisabled` keeps that same second finger from scrolling a list the
    /// pan is sliding.
    private var isPanCommitted: Bool { drag != nil }

    var body: some View {
        ZStack(alignment: .topLeading) {
            drawerPane
            chatPane
            // Last, so it paints over both panes, and outside `chatPane` so it takes none of
            // the pane's offset, radius or veil. See `chrome`.
            chrome
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        // Later touches — a second finger, mid-pan — find nothing to press. The committing
        // touch's own presses are cancelled at the UIKit level (see `DrawerPanRecognizer`),
        // which hit testing could never do; this covers the touches that have not landed yet,
        // which is the one thing hit testing does cover. Safe over the composer: it changes
        // neither focus nor enablement, so the keyboard stays.
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
        // does. So the recogniser's region is the whole container rather than either child —
        // the background view's own frame is the grab region, gaps included.
        //
        // Less the trailing panel inset: the resize handle's strip overlaps the panel's last
        // 18 points (`ResizeHandle`'s `contentMargin`), and it used to win those touches by
        // paint order — a UIKit recogniser cannot see SwiftUI paint order, so the overlap is
        // stated as geometry instead. A resize drag is horizontal too, and one that committed
        // the drawer pan would be cancelled by it.
        .background {
            DrawerPanGesture(
                onCommit: {
                    let anchor: CGFloat = isOpen ? 1 : 0
                    drag = Drag(anchor: anchor, progress: anchor)
                },
                onChange: { translation in
                    guard var drag else { return }
                    drag.progress = DrawerReveal.progress(
                        from: drag.anchor,
                        translation: translation,
                        travel: travel
                    )
                    self.drag = drag
                },
                onEnd: { _, velocity in
                    guard let drag else { return }
                    let opens = DrawerReveal.settlesOpen(
                        progress: drag.progress,
                        velocity: velocity
                    )
                    // Both writes inside the one transaction. Clearing the drag outside it
                    // would hand `progress` straight back to the settled value and the pane
                    // would jump to its destination instead of springing to it.
                    withAnimation(DrawerReveal.settle(velocity: velocity, travel: travel)) {
                        self.drag = nil
                        onSettle(opens)
                    }
                }
            )
            .padding(.trailing, TutorPanelMetrics.inset)
        }
        // A scroll already carrying momentum on a *second* finger is stopped rather than left
        // to coast under a pane that has started moving — the committing finger's own scroll
        // is already cancelled by the recogniser. It reaches every scroller below through the
        // environment, so neither pane declares a parameter for it — which is the rule this
        // type is built on, since a parameter that changed while a finger was down would
        // rebuild the pane it was passed to.
        .scrollDisabled(isPanCommitted)
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

}

// MARK: - Going inert while a gesture owns the touch

extension View {
    /// Stops this subtree responding to touches that have not landed yet, without changing
    /// whether anything is *enabled*.
    ///
    /// The one SwiftUI-side guard the drawer pan still needs, and it is for the *other*
    /// fingers. The committing touch's own presses are cancelled natively —
    /// `DrawerPanRecognizer` cancels every recogniser on that touch the instant the axis
    /// commits, exactly as `UIScrollView` would, which is what finally reaches an in-flight
    /// press on iPadOS 17. But a second finger landing mid-pan is a new touch, and hit
    /// testing *is* consulted for those: withdrawing the subtree is what keeps that finger
    /// from picking up a control while the panes are moving.
    ///
    /// Safe to put over everything, the composer included, because it changes neither focus
    /// nor enablement — no `TextField` resigns, and the keyboard stays up mid-sentence. That
    /// property is why the old structural `.disabled` groups, and the composer-shaped hole
    /// they had to leave, are gone.
    func inertToTouches(_ inert: Bool) -> some View {
        allowsHitTesting(!inert)
    }
}
