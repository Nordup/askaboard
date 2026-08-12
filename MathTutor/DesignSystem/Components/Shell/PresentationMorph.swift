import SwiftUI

/// The docked panel and the full-screen reading column as two ends of one travel — the
/// interactive container morph between screens 05/08 and screen 07.
///
/// This used to be a commit-triggered spring with a content crossfade, on the argument that
/// board 05 states the two tutor surfaces as *different variants* with no interpolable
/// intermediate. That argument still holds for the **contents** — the type scale, the chip
/// layout and the composer all change, and none of them is re-laid-out here — but it never
/// held for the **container**: a rounded rectangle at the panel's frame and a rounded
/// rectangle at the chat pane's frame have every intermediate a finger could ask for. So the
/// container morphs one-to-one with the finger, and the contents ride inside it, each laid
/// out exactly once for its own presentation and crossfaded late in the travel.
///
/// Like `DrawerReveal` and `DockReveal`, every number here is arithmetic rather than a gesture
/// handler, so the curves are assertable without a host. The release rule and the spring
/// delegate to `DrawerReveal` — one thumb, one feel, however many axes.
///
/// **Progress runs `0` docked → `1` full screen**, and every curve is a pure function of that
/// one number, which is what makes the gesture reversible mid-flight: a swipe that turns
/// around retraces exactly the frames it produced on the way out.
struct PresentationMorph: Equatable, Sendable {

    // MARK: - The two ends

    /// Screens 05/08: the panel's own frame — `panelX, contentTop, panelWidth`, the
    /// keyboard-aware content band.
    let dockedFrame: CGRect

    /// Screen 07: the chat pane. The whole screen with the sidebar shut, and the pane the
    /// sidebar leaves with it open — the same two answers `TutorFullScreen.chatSurface` draws.
    let fullScreenFrame: CGRect

    /// `TutorPanelMetrics.cornerRadius` — the panel's 28, on all four corners.
    let dockedRadius: CGFloat

    /// The chat pane's leading radius at the far end: `SessionsDrawerMetrics.chatCornerRadius`
    /// while the sidebar is open — board 19's rounded seam — and `0` while it is not, which is
    /// screen 07's full-bleed white. The trailing corners end at `0` either way.
    let fullScreenLeadingRadius: CGFloat

    /// How far the sidebar travels to fold in and out — its own width, the same number the
    /// toggle's spring is normalised by.
    let sidebarWidth: CGFloat

    /// The screen itself — the far end of the **clip**, which is deliberately looser than the
    /// far end of the visible container. See `clipFrame(at:)`.
    let screenFrame: CGRect

    init(layout: ScreenLayout, isSidebarOpen: Bool) {
        dockedFrame = CGRect(
            x: layout.panelX,
            y: layout.contentTop,
            width: layout.panelWidth,
            height: layout.contentHeightAboveKeyboard
        )
        let sidebar = isSidebarOpen ? layout.sessionsSidebarWidth : 0
        fullScreenFrame = CGRect(
            x: sidebar,
            y: 0,
            width: max(0, layout.screenWidth - sidebar),
            height: layout.screenHeight
        )
        dockedRadius = TutorPanelMetrics.cornerRadius
        fullScreenLeadingRadius = isSidebarOpen ? SessionsDrawerMetrics.chatCornerRadius : 0
        sidebarWidth = layout.sessionsSidebarWidth
        screenFrame = CGRect(x: 0, y: 0, width: layout.screenWidth, height: layout.screenHeight)
    }

    // MARK: - Travel

    /// How far the container's trailing edge moves: the chat pane's trailing edge less the
    /// panel's — `1376 − 365 = 1011` on the reference screen. The finger maps to that edge
    /// one-to-one, the same first rule every tracked gesture in the shell has.
    ///
    /// Independent of the sidebar by construction: the pane always ends on the screen's
    /// trailing edge, and the panel always ends at `dockTravel`.
    var travel: CGFloat { screenFrame.maxX - dockedFrame.maxX }

    /// The travel without building the endpoints — for the surface that only drives the
    /// gesture and never draws it.
    static func travel(in layout: ScreenLayout) -> CGFloat {
        layout.screenWidth - layout.dockTravel
    }

    /// Where along the travel a drag has got to. Clamped at both ends like the drawer's, and
    /// unlike the dock's: past `1` the container is already the whole screen, and past `0` the
    /// state below docked belongs to a different gesture (the surface's own left-swipe), so
    /// neither end has anything to rubber-band toward.
    static func progress(from anchor: CGFloat, translation: CGFloat, travel: CGFloat) -> CGFloat {
        DrawerReveal.progress(from: anchor, translation: translation, travel: travel)
    }

    /// Whether the release settles **full screen** — `DrawerReveal.settlesOpen` verbatim:
    /// velocity first at the same 300 pt/s, the halfway line second. A rightward fling opens
    /// the column, a leftward one brings the board back, from either end of the travel.
    static func settlesFullScreen(progress: CGFloat, velocity: CGFloat) -> Bool {
        DrawerReveal.settlesOpen(progress: progress, velocity: velocity)
    }

    // MARK: - The container

    /// The visible container: the panel's frame at `0`, the chat pane's at `1`, every edge
    /// interpolated independently.
    func containerFrame(at progress: CGFloat) -> CGRect {
        lerp(dockedFrame, fullScreenFrame, by: unit(progress))
    }

    /// What the two contents are clipped to. The same rectangle as the container through the
    /// whole travel that matters, but its far end is the **screen**, not the pane.
    ///
    /// The looseness is deliberate and it is the fix for a real pop: at rest in full screen
    /// the sidebar toggle animates the chat pane's frame on a spring, and a clip pinned to the
    /// pane would snap to the new frame instantly while the pane itself is still sliding —
    /// the chat's leading edge would clip-vanish before it moved. A clip that ends at the
    /// screen never bites at rest (nothing in either content paints outside its own pane),
    /// and mid-morph the difference between the two rectangles is at most the sidebar lane,
    /// where the folding sidebar is the only thing drawn.
    func clipFrame(at progress: CGFloat) -> CGRect {
        lerp(dockedFrame, screenFrame, by: unit(progress))
    }

    /// The container's corners: the panel's 28 all round at `0`; the pane's leading radius and
    /// square trailing corners at `1`.
    func containerRadii(at progress: CGFloat) -> RectangleCornerRadii {
        let t = unit(progress)
        let leading = dockedRadius + (fullScreenLeadingRadius - dockedRadius) * t
        let trailing = dockedRadius * (1 - t)
        return RectangleCornerRadii(
            topLeading: leading,
            bottomLeading: leading,
            bottomTrailing: trailing,
            topTrailing: trailing
        )
    }

    /// The clip's corners: the same leading interpolation, trailing to square — but toward
    /// radius `0` on the leading side too at the screen end, since the screen has no corners.
    func clipRadii(at progress: CGFloat) -> RectangleCornerRadii {
        let t = unit(progress)
        let radius = dockedRadius * (1 - t)
        return RectangleCornerRadii(
            topLeading: radius,
            bottomLeading: radius,
            bottomTrailing: radius,
            topTrailing: radius
        )
    }

    /// How much of the panel's own fill the container still carries — `--color-surface-panel`
    /// over the pane's white, gone linearly across the travel. The two colours are two points
    /// apart in every channel, so the blend is imperceptible frame to frame and exact at both
    /// ends, which is all it has to be.
    func panelFillOpacity(at progress: CGFloat) -> Double {
        Double(1 - unit(progress))
    }

    // MARK: - The content crossfade

    /// Where the outgoing content is still untouched — it holds full opacity to 60% of the
    /// travel, so the surface being left stays crisp for most of the drag.
    static let outgoingHoldUntil: CGFloat = 0.60
    /// Where the outgoing content has fully gone.
    static let outgoingGoneBy: CGFloat = 0.90
    /// Where the incoming content starts to arrive — just before the outgoing starts to
    /// leave, so there is no frame with neither on it.
    static let incomingFrom: CGFloat = 0.55
    /// Where the incoming content is fully there.
    static let incomingFullBy: CGFloat = 0.85

    /// The docked side of the crossfade: the panel, and the board with it. `1` through the
    /// first 60% of the travel, smoothstepped out by 90%.
    ///
    /// Smoothstepped for the reason the dock's handover is: both contents change at once in
    /// the band, and a linear ramp puts a corner on each at both ends of it.
    func dockedContentOpacity(at progress: CGFloat) -> Double {
        1 - smoothstep(unit(progress), from: Self.outgoingHoldUntil, to: Self.outgoingGoneBy)
    }

    /// The full-screen side: the reading column, and the board peek with it. `0` through the
    /// first 55%, fully in by 85% — it leads the outgoing fade by half a band, so the middle
    /// of the crossfade reads as a trade rather than a blank.
    func fullScreenContentOpacity(at progress: CGFloat) -> Double {
        smoothstep(unit(progress), from: Self.incomingFrom, to: Self.incomingFullBy)
    }

    // MARK: - The panel's shadow

    /// Where the panel's elevation has fully dissolved, as a fraction of the travel.
    ///
    /// Early, and much earlier than the content fade, on purpose. The shadow is cast by a
    /// static-shaped underlay (never by the morphing container — a shadow re-rasterises its
    /// input per frame, which is the one cost the A10 cannot pay), so it cannot grow with the
    /// container; what it can do is leave before the container has grown past it. By 30% of
    /// the travel the panel's edge sits on the container's own fill with no shadow to betray
    /// it, and the panel reads as dissolving into the sheet rather than floating on it.
    static let shadowGoneBy: CGFloat = 0.30

    /// The underlay's opacity: `1` at rest, `0` from `shadowGoneBy` on.
    func panelShadowOpacity(at progress: CGFloat) -> Double {
        1 - smoothstep(unit(progress), from: 0, to: Self.shadowGoneBy)
    }

    // MARK: - The board

    /// How far the board card has slid toward the trailing edge, in whole points.
    ///
    /// The same distance the container's trailing edge has travelled, so the gap between the
    /// sheet's edge and the board's is constant through the whole drag: the pair reads as one
    /// push. The board's **content is never re-laid-out** — this is a translation of the live
    /// canvas, applied from outside, because a `PKCanvasView` handed a new size on every
    /// touch event stutters where a transform does not. At `1` the card is fully off the
    /// trailing edge and the peek silhouette — the artwork the design draws for exactly this
    /// state — has taken over on the incoming curve.
    ///
    /// Whole points for the reason every rasterised travel in the shell is — see
    /// `DrawerReveal.wholePoints(_:)`.
    func boardShift(at progress: CGFloat) -> CGFloat {
        DrawerReveal.wholePoints(unit(progress) * travel)
    }

    // MARK: - The sidebar

    /// How far the full-screen sidebar has folded out toward the leading edge — `0` at full
    /// screen, its own width off-screen at docked. It rides the same progress as everything
    /// else, so the fold is part of the one tracked gesture rather than a second animation.
    ///
    /// The *flag* is untouched: `UIState.isSessionsSidebarOpen` survives the trip and the
    /// sidebar is back the next time the column is — the fold is what the morph does to the
    /// sidebar's position, not to the learner's choice.
    func sidebarShift(at progress: CGFloat) -> CGFloat {
        DrawerReveal.wholePoints(-(1 - unit(progress)) * sidebarWidth)
    }

    // MARK: - Arithmetic

    private func unit(_ progress: CGFloat) -> CGFloat {
        min(1, max(0, progress))
    }

    private func lerp(_ a: CGRect, _ b: CGRect, by t: CGFloat) -> CGRect {
        CGRect(
            x: a.origin.x + (b.origin.x - a.origin.x) * t,
            y: a.origin.y + (b.origin.y - a.origin.y) * t,
            width: a.width + (b.width - a.width) * t,
            height: a.height + (b.height - a.height) * t
        )
    }

    private func smoothstep(_ x: CGFloat, from start: CGFloat, to end: CGFloat) -> Double {
        guard end > start else { return x >= end ? 1 : 0 }
        let t = min(1, max(0, (x - start) / (end - start)))
        return Double(t * t * (3 - 2 * t))
    }
}

// MARK: - The live position

/// The live position of the presentation morph, and the one function that ends it — the
/// `DockRevealModel` shape, one rung up the ladder, for the identical reasons.
///
/// A reference type because the gesture starts in two different owners — the leading edge
/// zone inside `DockRevealLayer` going up, the peek's lane inside `TutorFullScreen` coming
/// down — while the thing that renders it is `PresentationMorphLayer`, which is the only view
/// that observes it. Everyone else holds it as a plain `let` and writes.
@MainActor
final class PresentationMorphModel: ObservableObject {

    /// Where the morph is right now — `0` docked, `1` full screen — or `nil` between
    /// gestures, when the settled presentation is the answer.
    @Published private(set) var progress: CGFloat?

    /// True from a release (or a button's animated morph) until the spring has finished.
    /// Both contents stay mounted exactly this long — see `DockRevealModel.isSettling` for
    /// why a removal transition cannot do this job.
    @Published private(set) var isSettling = false

    var isDragging: Bool { progress != nil }

    /// Both presentations must stay mounted: a drag, or the spring after one.
    var isActive: Bool { progress != nil || isSettling }

    /// The pan committed. The anchor is whichever end the tutor was resting at.
    func begin(atFullScreen: Bool) {
        progress = atFullScreen ? 1 : 0
    }

    /// A tracked frame. Callers pass `PresentationMorph.progress(from:translation:travel:)`.
    func track(_ value: CGFloat) {
        progress = value
    }

    /// End the gesture — or run the same morph from rest, which is what the panel's
    /// full-screen button and the peek's tap do. One curve for every path, which is the
    /// `DockReveal.settle` rule applied to this rung of the ladder.
    ///
    /// The presentation change is `apply`, made inside the animation and in the same
    /// transaction that clears the drag — clearing it outside would hand the layer its
    /// settled position and everything would jump instead of springing. The completion is
    /// what releases the mounts, exactly as `DockRevealModel.settle`'s does.
    func settle(
        to fullScreen: Bool,
        velocity: CGFloat,
        travel: CGFloat,
        _ apply: @escaping () -> Void
    ) {
        isSettling = true
        withAnimation(DrawerReveal.settle(velocity: velocity, travel: travel)) {
            progress = nil
            apply()
        } completion: { [weak self] in
            self?.isSettling = false
        }
    }
}

// MARK: - Rendering one role of the morph

/// Which piece of the morph a view is.
enum PresentationMorphRole {
    /// The live board card: translated toward the trailing edge, fading on the docked curve.
    case board
    /// The docked panel's content: clipped to the morphing container, fading on the docked
    /// curve. `origin` is the panel's own origin, since the clip is applied in panel-local
    /// coordinates, inside `DockRevealLayer`'s offset.
    case dockedChat
    /// The panel's extracted elevation — a static-shaped underlay that only ever changes
    /// opacity. See `PresentationMorph.shadowGoneBy`.
    case panelShadow
    /// The reading column and everything screen 07 draws with it: clipped to the morphing
    /// container, fading on the full-screen curve.
    case fullScreenChat
    /// Board 19's sidebar, folding in and out along the same progress.
    case sidebar
    /// The board peek silhouette, arriving on the full-screen curve.
    case peek
}

/// The per-frame rendering of one role, as an **animatable** modifier.
///
/// Animatable is the whole point: a gesture writes `progress` directly and the modifier
/// renders it, while a settle — or a button's morph from rest — animates `animatableData`
/// through the spring, so every intermediate frame still goes through the *curves* rather
/// than lerping each modifier's end values. That is what makes the tap and the swipe one
/// system instead of two that merely share a duration.
struct PresentationMorphRender: ViewModifier {
    var progress: CGFloat
    let geometry: PresentationMorph
    let role: PresentationMorphRole
    var origin: CGPoint = .zero

    @ViewBuilder
    func body(content: Content) -> some View {
        switch role {
        case .board:
            content
                .offset(x: origin.x + geometry.boardShift(at: progress), y: origin.y)
                .opacity(geometry.dockedContentOpacity(at: progress))
        case .dockedChat:
            content
                .clipShape(PresentationMorphClipShape(
                    progress: progress, geometry: geometry, localOrigin: origin
                ))
                .opacity(geometry.dockedContentOpacity(at: progress))
        case .panelShadow:
            content
                .opacity(geometry.panelShadowOpacity(at: progress))
        case .fullScreenChat:
            content
                .clipShape(PresentationMorphClipShape(progress: progress, geometry: geometry))
                .opacity(geometry.fullScreenContentOpacity(at: progress))
        case .sidebar:
            content
                .offset(x: origin.x + geometry.sidebarShift(at: progress), y: origin.y)
        case .peek:
            content
                .opacity(geometry.fullScreenContentOpacity(at: progress))
        }
    }
}

/// `@preconcurrency` because `ViewModifier` is main-actor-inferred in Swift 6 while
/// `Animatable`'s requirements are nonisolated; SwiftUI evaluates `animatableData` on the
/// main actor during rendering, so the conformance's runtime assertion always holds.
extension PresentationMorphRender: @preconcurrency Animatable {
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }
}

/// The morphing container's silhouette — for the background fill.
struct PresentationMorphContainerShape: Shape {
    var progress: CGFloat
    let geometry: PresentationMorph

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(cornerRadii: geometry.containerRadii(at: progress))
            .path(in: geometry.containerFrame(at: progress))
    }
}

/// The clip the two contents ride inside — the looser cousin of the container shape; see
/// `PresentationMorph.clipFrame(at:)` for why the two part company at the far end.
struct PresentationMorphClipShape: Shape {
    var progress: CGFloat
    let geometry: PresentationMorph
    var localOrigin: CGPoint = .zero

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let frame = geometry.clipFrame(at: progress)
            .offsetBy(dx: -localOrigin.x, dy: -localOrigin.y)
        return UnevenRoundedRectangle(cornerRadii: geometry.clipRadii(at: progress))
            .path(in: frame)
    }
}
