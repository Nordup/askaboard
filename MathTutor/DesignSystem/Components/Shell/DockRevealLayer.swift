import SwiftUI

/// The live position of the dock gesture, and the one function that ends it.
///
/// **A reference type, and that is the whole design.** The pan that collapses the dock starts
/// on the *panel* — the region `DrawerRevealLayer` already owns, because the project has one
/// horizontal recogniser and extending it is the rule — while the thing that moves is the
/// panel's own placement, which is `DockRevealLayer`'s. A `@State` on either one cannot be
/// written by the other, and threading a per-frame value up through `BoardScreen` would
/// re-run that screen's body sixty times a second: `TutorPanel` is built there, so every touch
/// event would rebuild the message thread and the composer — precisely the cost
/// `DrawerRevealLayer` was extracted to avoid, reintroduced one level up.
///
/// So the live position lives here and is *observed by exactly one view*. `DockRevealLayer`
/// declares `@ObservedObject` and re-renders per frame, handing its two stored view values
/// back with new offsets; `BoardScreen`, `TutorPanel` and `DrawerRevealLayer` hold the same
/// object as a plain `let` and only write to it, so none of them is invalidated by a write.
/// That is the same reasoning `UIState.isSessionsDrawerOpen` is documented with, applied to a
/// value that changes per frame instead of once per gesture: it is not on `UIState` because
/// every consumer of that object — the board included — would be invalidated with it.
///
/// It also owns `settle(to:velocity:travel:_:)`, which is what makes the button paths and the
/// gesture path one path. `btn/dock`, the dock's orb, the resize-drag collapse and the swipe
/// all end here, so they all run the same spring and keep the panel mounted for the same
/// window — see `isSettling`.
@MainActor
final class DockRevealModel: ObservableObject {

    /// Where the panel is right now — `1` docked, `0` collapsed — or `nil` between gestures,
    /// when the settled presentation is the answer.
    ///
    /// Published, and the only thing in the app that is published per touch event.
    @Published private(set) var progress: CGFloat?

    /// True from a release until its spring has finished.
    ///
    /// The panel and the dock are each mounted in only one of the two presentations, so
    /// without this the losing surface would be torn out of the tree on the frame the
    /// presentation changed and the spring would animate nothing. A removal transition cannot
    /// do this job: the pane is already offset by the drag when the gesture ends, and a
    /// transition composes its own offset *on top* of that one, so the panel would leave from
    /// twice as far out as it actually is.
    @Published private(set) var isSettling = false

    /// A finger owns the panel.
    var isDragging: Bool { progress != nil }

    /// The panel and the dock must both stay mounted: a drag, or the spring after one.
    var isActive: Bool { progress != nil || isSettling }

    /// The pan committed. `docked` is where the panel was when the touch landed, and it is the
    /// anchor every later frame resolves from.
    func begin(from docked: Bool) {
        progress = docked ? 1 : 0
    }

    /// A tracked frame. Callers pass `DockReveal.progress(from:translation:travel:)`.
    func track(_ value: CGFloat) {
        progress = value
    }

    /// End the gesture — or perform the same transition without one.
    ///
    /// The presentation change is `apply`, made *inside* the animation and in the same
    /// transaction that clears the drag: clearing the drag outside it would hand the layer
    /// back its settled position and the panel would jump to the destination instead of
    /// springing to it, which is the mistake `DrawerRevealLayer.onEnd` documents at the other
    /// axis.
    ///
    /// `completionCriteria: .removed` rather than `.logicallyComplete`, because what the
    /// completion releases is the *mount*: a panel unmounted while its spring still has
    /// visible travel left disappears mid-flight.
    func settle(
        to docked: Bool,
        velocity: CGFloat,
        travel: CGFloat,
        _ apply: @escaping () -> Void
    ) {
        isSettling = true
        withAnimation(DockReveal.settle(velocity: velocity, travel: travel)) {
            progress = nil
            apply()
        } completion: { [weak self] in
            self?.isSettling = false
        }
    }
}

/// The docked panel and the collapsed dock as two positions of one surface — screens 05/08 and
/// screen 06, and the swipe between them.
///
/// **The `DrawerRevealLayer` pattern, one level out, and for the identical reason.** The panel
/// arrives here as an already-built view value and is stored. A drag re-runs only *this* body,
/// which hands the same value back with a new offset; SwiftUI compares it, finds it unchanged,
/// and never asks the thread, the composer or the drawer for a body at all. The per-frame work
/// is one offset, one opacity and a second offset, which is what it has to be for a 365-point
/// travel to track a finger on an A10.
///
/// The corollary is the same rule for callers: **nothing progress-dependent may be passed into
/// either slot**. Both are handed over once and never rebuilt for the gesture's sake, and
/// nothing here needs them to be — everything the gesture does to them, it does from outside.
///
/// **Mounting is conditional, and deliberately not always-on.** Screen 06 gives the board the
/// screen to itself, which is a performance promise as much as a layout: a message thread left
/// mounted off the leading edge would still be laid out and drawn on every frame the learner
/// spends inking. So each surface is mounted in its own presentation, plus for the duration of
/// a gesture and the spring after it — `DockRevealModel.isActive` — which costs one build of
/// the panel at the moment the edge-zone pan commits, the same build a tap on the orb costs
/// today.
struct DockRevealLayer<Panel: View, Dock: View>: View {
    /// How far the panel travels to leave the screen: `ScreenLayout.dockTravel`, its own lane
    /// plus the leading inset, so the trailing edge finishes exactly on the screen edge.
    let travel: CGFloat
    /// The panel's docked origin — `panelX`, `contentTop`.
    let panelOrigin: CGPoint
    /// The collapsed dock's origin — board 09's 24 points inside the collapsed board's
    /// bottom-left corner.
    let dockOrigin: CGPoint
    /// The leading-edge grab region, in the same coordinates the two origins are: where a pan
    /// may start to bring a collapsed dock back. See `HorizontalSwipeRouter.edgeZoneWidth`.
    let edgeZone: CGRect
    /// The settled state — what the screen has decided it is drawing, which is the student's
    /// axis reconciled with what fits. The *live* position is not here; see `drag`.
    let isDocked: Bool
    /// Whether the panel's own sessions drawer is showing.
    ///
    /// Read for exactly one cell of the table — the leading edge's right-swipe, which an open
    /// drawer refuses so that a presentation never changes underneath a drawer the learner has
    /// not finished with. See `HorizontalSwipeRouter.transition(...)`.
    var isDrawerOpen = false
    /// The gesture in progress, shared with the panel's own pan region. See `DockRevealModel`.
    @ObservedObject var drag: DockRevealModel
    /// Called inside the settle animation with where the dock landed. `true` is docked.
    let onSettle: (Bool) -> Void
    /// A leading-edge right-swipe on the **docked** panel released, with its release velocity.
    ///
    /// A callback rather than a second `DockRevealModel` route, because nothing this layer owns
    /// moves: the panel is not sliding anywhere, it is being replaced by a surface this layer
    /// does not draw. The caller settles it on the shared spring — see `BoardScreen`.
    ///
    /// Reached only when no `flight` handle is supplied — the commit-triggered fallback.
    var onEnterFullScreen: (CGFloat) -> Void = { _ in }
    /// The presentation morph's gesture, when the screen runs the tracked container morph:
    /// the same right-swipe, but every frame between commit and release drives the flight
    /// layer's progress instead of waiting for the release. `nil` keeps the commit-triggered
    /// spring — previews and specimens never pass one.
    var flight: PresentationFlightHandle? = nil
    @ViewBuilder let panel: Panel
    @ViewBuilder let dock: Dock

    /// True from the leading edge's right-swipe committing on a docked panel until it is
    /// released. There is no position to store: the transition is commit-triggered, so this is
    /// the whole of the gesture's state.
    @State private var isEnteringFullScreen = false

    /// Where the panel is right now: the live drag if one has committed, and the settled
    /// presentation otherwise.
    private var progress: CGFloat { drag.progress ?? (isDocked ? 1 : 0) }

    /// Read off the two surfaces' actual placement rather than fixed — see
    /// `DockReveal.dockFadeStart(dockLeading:travel:)`.
    private var fadeStart: CGFloat {
        DockReveal.dockFadeStart(dockLeading: dockOrigin.x, travel: travel)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            panelSlot
            dockSlot
            edgeZoneRegion
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The docked panel, placed at its own lane and offset by however much of the travel it
    /// has given up.
    ///
    /// Hit testing goes off for the whole gesture and the spring after it, which is what
    /// `inertToTouches(_:)` does inside the panel one level down and for the same reason: the
    /// committing touch's presses are already cancelled natively by `DrawerPanRecognizer`, and
    /// this is about the fingers that land afterwards, on a surface that is on its way out.
    @ViewBuilder
    private var panelSlot: some View {
        if isDocked || drag.isActive {
            panel
                .offset(
                    x: panelOrigin.x + DockReveal.panelOffset(at: progress, travel: travel),
                    y: panelOrigin.y
                )
                .allowsHitTesting(!drag.isActive)
                .accessibilityHidden(progress <= 0)
                // **For the taps, not for the swipes.** A swipe mounts the panel at
                // commitment, un-animated and already out at `-travel`, and every frame after
                // that is the offset above — the transition never runs. A *tap* on the orb has
                // no such frame: the panel is inserted in the same transaction that docks it,
                // and a modifier has no previous value to animate from, so the panel would
                // appear finished. The transition supplies that missing "from", and it is the
                // same distance the offset would have covered, so the two paths cannot
                // disagree about where the panel comes in from.
                .transition(.offset(x: -travel))
        }
    }

    /// Screen 06's dock, fading and sliding in behind the panel as it leaves.
    ///
    /// Painted after the panel, which is the order `BoardScreen` already drew the floating
    /// region in — *"screen 06's dock floats on the canvas card"*. That is why the fade cannot
    /// start until the panel's edge has passed it; see `DockReveal.dockFadeStart`.
    @ViewBuilder
    private var dockSlot: some View {
        if !isDocked || drag.isActive {
            let opacity = DockReveal.dockOpacity(at: progress, fadeStart: fadeStart)
            dock
                .opacity(opacity)
                .offset(
                    x: dockOrigin.x - DS.Space.gap * DockReveal.dockSlide(at: progress, fadeStart: fadeStart),
                    y: dockOrigin.y
                )
                // Nothing hit-tests at zero opacity, and nothing on its way out hit-tests at
                // all: one number decides both, the same rule the sidebar toggle follows.
                .allowsHitTesting(opacity >= 1 && !drag.isActive)
                .accessibilityHidden(opacity <= 0)
                // The mirror of the panel's, for the same reason and over the same distance:
                // `btn/dock` inserts the dock in the transaction that collapses the tutor, so
                // without a "from" the orb would appear at full strength instead of arriving
                // behind the panel. A swipe never reaches this — the dock is already mounted,
                // at zero, from the moment the pan commits.
                .transition(.opacity.combined(with: .offset(x: -DS.Space.gap)))
        }
    }

    /// The rung up, from either state: a right-swipe from the screen's leading edge.
    ///
    /// **One zone, two destinations, and that is the ladder.** Collapsed, it brings the panel
    /// back — tracked, because the panel is a rigid surface with a measured travel and the
    /// finger can hold it anywhere along it. Docked, it goes full-screen — commit-triggered,
    /// because the thing on the other side is not the panel at a different offset: board 05
    /// states the reading column as *a different variant*, with its own type scale, chip
    /// layout, composer and lane, so there is no position between the two for a finger to rest
    /// at. Both releases end on `DockReveal.settle`, so the two rungs feel like one gesture.
    ///
    /// It takes no touches of its own (`DrawerPanGesture` hit-tests nothing; its frame is only
    /// the recogniser's geometry gate), so the region costs nothing until a finger actually
    /// starts inside those 24 points — which is what makes it affordable to mount in both
    /// states rather than in the collapsed one alone. It overlaps neither surface: the
    /// collapsed board's canvas starts at `boardXCollapsed`, and the docked panel starts at
    /// `panelX`, 4 points past the zone's own end.
    ///
    /// **It refuses Apple Pencil touches.** In this app a pencil is always drawing and never
    /// navigating, and the one thing the collapsed screen must not make harder is inking. The
    /// zone does not overlap the canvas at any device size — see
    /// `HorizontalSwipeRouter.edgeZoneWidth` — so this is the second of two guards rather than
    /// the only one, and it is the one that would still hold if the lanes ever moved.
    ///
    /// A left-swipe that starts here routes as the surface would: the collapse when the panel
    /// is docked, and nothing at all when it is already collapsed, since there is no state to
    /// the left of that. Either way it committed and cancelled whatever it crossed, which is
    /// the property `DrawerPanRecognizer` exists for.
    private var edgeZoneRegion: some View {
        DrawerPanGesture(
            ignoresPencil: true,
            onCommit: { translation in
                switch route(translation) {
                // The two rungs this layer can drive itself, because the panel is the surface
                // that moves for both: back in from the collapsed state, and out again from
                // the docked one. The second is the panel's own left-swipe answered from four
                // points outside it, so the strip beside the panel does not read as dead.
                case .expandDock: drag.begin(from: false)
                case .collapseDock: drag.begin(from: true)
                case .enterFullScreen:
                    isEnteringFullScreen = true
                    // The tracked morph, where the screen runs one: anchor at docked and
                    // let the flight layer render every frame from here to the release.
                    // `begin` is a plain write from a UIKit callback — no transaction, so
                    // the flight mounts un-animated at its anchor, which is the same rule
                    // `drag.begin` follows one rung down.
                    if let flight {
                        flight.drag.begin(atFullScreen: false)
                        flight.onBegin()
                    }
                // `closeDrawer` is the remaining reachable cell, and it is deliberately not
                // acted on here: the drawer is inside the panel and belongs to the panel's own
                // pan region. The touch still committed and still cancelled what it crossed.
                default: break
                }
            },
            onChange: { translation in
                if isEnteringFullScreen {
                    // The morph tracks the finger one-to-one against the container's
                    // trailing edge — the first rule every tracked gesture in the shell has.
                    flight?.track(anchor: 0, translation: translation)
                    return
                }
                guard drag.isDragging else { return }
                drag.track(
                    DockReveal.progress(
                        from: isDocked ? 1 : 0,
                        translation: translation,
                        travel: travel
                    )
                )
            },
            onEnd: { _, velocity in
                if isEnteringFullScreen {
                    isEnteringFullScreen = false
                    // Tracked: the release rule needs the real position, and the settle is
                    // the caller's — it owns the mounts the spring has to hold open.
                    if let flight {
                        flight.onRelease(velocity)
                        return
                    }
                    // The one thing a commit-triggered transition still owes the finger: a
                    // release that flings *back* the way it came takes it back. The same
                    // `DrawerReveal` rule the sidebar's own commit-triggered swipe uses, with
                    // the progress pinned at the destination — a committed rightward pan is
                    // already all the way there unless the release says otherwise.
                    guard DrawerReveal.settlesOpen(progress: 1, velocity: velocity) else { return }
                    onEnterFullScreen(velocity)
                    return
                }
                guard let progress = drag.progress else { return }
                let docked = DockReveal.settlesDocked(progress: progress, velocity: velocity)
                drag.settle(to: docked, velocity: velocity, travel: travel) {
                    onSettle(docked)
                }
            }
        )
        .frame(width: edgeZone.width, height: edgeZone.height)
        .offset(x: edgeZone.minX, y: edgeZone.minY)
    }

    private func route(_ translation: CGFloat) -> HorizontalSwipeRouter.Transition {
        guard let direction = HorizontalSwipeRouter.Direction.of(translation) else { return .none }
        return HorizontalSwipeRouter.transition(
            presentation: isDocked ? .docked : .collapsed,
            isDrawerOpen: isDrawerOpen,
            isSidebarOpen: false,
            direction: direction,
            origin: .leadingEdge
        )
    }
}
