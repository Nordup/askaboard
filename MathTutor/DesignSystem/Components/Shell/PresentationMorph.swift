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
        boardTravel = max(0, layout.peekX - layout.boardX)
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

    /// The arrival spring's damping — the drawer's 30, two notches livelier. `20` puts the
    /// damping ratio at ~0.56: the settle arrives with a visible snap where the drawer's
    /// ratio (~0.84) glides. Judged against the deepened dip: a scene that shrank 15% on
    /// the way needs an arrival with real spring in it, or the snap-back to size reads as
    /// a fade rather than a landing.
    static let settleDamping: CGFloat = 20

    /// The settle animation — `DrawerReveal.settle`, the shared construction, at this
    /// morph's own damping. Every path through the morph ends here: swipe releases and
    /// button replays alike, which is what keeps the two one system.
    static func settle(velocity: CGFloat, travel: CGFloat) -> Animation {
        DrawerReveal.settle(velocity: velocity, travel: travel, damping: settleDamping)
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
    ///
    /// **The corners finish early.** Material's shape-mask threshold: entering, the radius
    /// completes by **75%** of the travel — a square-cornered box that is still growing
    /// reads as "arrived" — and returning it runs **0.30 … 0.90**, so the panel's corners
    /// are back before the box has finished shrinking onto them. One direction parameter,
    /// not two functions.
    func containerRadii(at progress: CGFloat, returnLeg: Bool = false) -> RectangleCornerRadii {
        let t = returnLeg
            ? CGFloat(Self.unitSmoothstep(progress, from: 0.30, to: 0.90))
            : CGFloat(Self.unitSmoothstep(progress, from: 0, to: 0.75))
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
    /// over the pane's white, gone linearly over the **first 30%** of the travel. Two
    /// colours two points apart in every channel do not need 1011 points to blend; the
    /// dissolve finishes while the panel's shadow is going, and the pair reads as one event.
    func panelFillOpacity(at progress: CGFloat) -> Double {
        Double(1 - min(1, max(0, unit(progress) / Self.shadowGoneBy)))
    }

    // MARK: - The peek's arrival

    /// Where the peek silhouette starts to arrive over the clipped board card — the last
    /// 15% of the travel, once the card's leading edge is already landing on the peek's own
    /// line and the mask has nearly resolved to the silhouette. The card itself never
    /// fades: the crossfade is between the masked live card and the distinct artwork that
    /// stands in for it at rest.
    static let peekArrivesFrom: CGFloat = 0.85

    /// The peek artwork's opacity — `0` until the card is all but home, `1` at rest.
    func peekOpacity(at progress: CGFloat) -> Double {
        smoothstep(unit(progress), from: Self.peekArrivesFrom, to: 1)
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

    /// How far the board card slides toward the trailing edge: **`peekX − boardX`** — 846
    /// on the reference screen — so its leading edge lands *exactly on the peek's leading
    /// edge* and the card reads as sliding under the screen's edge and becoming the hinge
    /// tab. The old `+travel` (1011) carried the edge past the peek and off the screen
    /// while a separate silhouette faded up where it should have stopped: two objects, one
    /// crossfade, no continuity.
    let boardTravel: CGFloat

    /// The card's translation at `progress`, in whole points. The board's **content is
    /// never re-laid-out** — this is a translation of the live canvas, applied from
    /// outside, because a `PKCanvasView` handed a new size on every touch event stutters
    /// where a transform does not. The card's opacity stays at 1 the whole way; the peek
    /// artwork crossfades over the masked card's last 15% (`peekOpacity`).
    ///
    /// Whole points for the reason every rasterised travel in the shell is — see
    /// `DrawerReveal.wholePoints(_:)`.
    func boardShift(at progress: CGFloat) -> CGFloat {
        DrawerReveal.wholePoints(unit(progress) * boardTravel)
    }

    /// Where the mask over the sliding card starts resolving toward the peek silhouette —
    /// the last 45% of the travel. Before it the card is clipped to its own rounded rect;
    /// by `1` the visible sliver is the silhouette's own box. The ink translates with the
    /// card (motion the eye can follow) while the shape resolves around it (shape the eye
    /// can read); a mask edge sweeping a stationary canvas would read as a wipe, which was
    /// the old bug in a sentence.
    static let boardMaskFrom: CGFloat = 0.55

    /// The mask's own 0…1, remapped from the travel's `boardMaskFrom … 1`.
    func boardMaskProgress(at progress: CGFloat) -> CGFloat {
        min(1, max(0, (unit(progress) - Self.boardMaskFrom) / (1 - Self.boardMaskFrom)))
    }

    // MARK: - The rail

    /// Where the tool rail has fully gone, as a fraction of the travel.
    ///
    /// The rail is the one element of the ground with no counterpart at full screen — it
    /// serves a canvas the reading column does not show — so, like the panel-controls
    /// pair, it fades rather than arrives. But it does not *only* fade: it rides the
    /// board's own shift (`railShift`) while it goes, so the ground leaves as one plane —
    /// rail and card together, one flock — instead of the card sliding out from beside a
    /// nailed-down toolbar, which was the shipped bug in a sentence ("toolbar doesn't
    /// move at all"). The band is a little wider than the controls' 0.25: the rail is
    /// bigger, and a big thing that vanishes in a quarter of the travel reads as popped.
    /// Pure in `progress`, so the return leg fades it back in over the same band and a
    /// reversed gesture retraces its own frames. Endpoints exact: opacity 1 at docked,
    /// 0 from 35% on — and at rest in full screen the rail is unmounted anyway.
    static let railGoneBy: CGFloat = 0.35

    /// The rail's opacity: `1` at docked, `0` from `railGoneBy` on, smoothstepped.
    static func railOpacity(at progress: CGFloat) -> Double {
        1 - unitSmoothstep(progress, from: 0, to: railGoneBy)
    }

    /// The rail's translation: the board's own, exactly — the two are one ground plane
    /// and must move as one. Whole points for the same rasterised-composite reason.
    func railShift(at progress: CGFloat) -> CGFloat {
        boardShift(at: progress)
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

    // MARK: - The shared elements' lead

    /// The slight ease-out the shared elements run ahead of the finger-locked container:
    /// `1 − (1 − p)²`, clamped. The container is glued to the finger; the contents settle
    /// slightly before it does, which is the one principle every production container
    /// transform shares — Material runs its fade in the first quarter of the travel, the
    /// App Store runs position on a spring while size runs linear. Without the lead the
    /// transition reads as a box dragging its cargo.
    static func lead(_ progress: CGFloat) -> CGFloat {
        let p = min(1, max(0, progress))
        return 1 - (1 - p) * (1 - p)
    }

    /// The lead curve, a beat late: `p` remapped to `[stagger, 1]` before easing, so an
    /// element leaves after the one ahead of it and still arrives with everything at both
    /// ends — the remap keeps the endpoints exact, only the interior shifts.
    ///
    /// One family, three beats (`greetingStagger`, `chipsStagger`, `composerStagger`): the
    /// orb leads on the bare curve, the greeting follows the face, the chips follow the
    /// greeting and the pill brings up the rear. The old arrangement ran the orb, the chips
    /// and the pill on the identical curve — a welded convoy with one straggler — and this
    /// is what makes the ensemble read as a flock instead: same path, staggered departures.
    static func leadStaggered(_ progress: CGFloat, by stagger: CGFloat) -> CGFloat {
        guard stagger > 0, stagger < 1 else { return lead(progress) }
        return lead((progress - stagger) / (1 - stagger))
    }

    /// The greeting's beat behind the orb — 5% of the travel, as shipped.
    static let greetingStagger: CGFloat = 0.05

    /// The chips' beat, one step behind the greeting.
    static let chipsStagger: CGFloat = 0.08

    /// The pill's beat, at the rear of the flock. Its *width* stays linear on the finger —
    /// the stretch tracks the box — only the departure is staggered.
    static let composerStagger: CGFloat = 0.10

    /// The greeting's curve, kept as the named spelling the flight paths read.
    static func leadStaggered(_ progress: CGFloat) -> CGFloat {
        leadStaggered(progress, by: greetingStagger)
    }

    // MARK: - The ensemble's dip

    /// How much smaller the travelling scene reads at the middle of the flight — the
    /// OS space-switcher's gesture language: the surface visibly zooms out while you move
    /// between spaces and snaps back to size as it lands. `0.15` at the deepest point, on
    /// the user's explicit call: 0.05 was imperceptible on device ("I wanted it to zoom
    /// out"), so this is a felt recede, not a hint.
    ///
    /// The dip wraps the **whole screen scene** now — the board card, the rail and the
    /// arriving peek included, not only the chat surface — on the user's second call: the
    /// "chat lifts off a still ground" reading was rejected ("board doesn't scale while
    /// moving"), and the space switcher it quotes zooms *everything*. One `scaleEffect`
    /// on one screen-framed stack: the live `PKCanvasView` is never resized or re-laid-out
    /// — a scale is a render-tree transform on its existing tiles, the same thing the OS
    /// app switcher does to a whole app's layer — so the canvas contract survives intact.
    static let flightDipDepth: CGFloat = 0.15

    /// `scale(p) = 1 − depth · sin(π·p)`: **exactly 1 at both endpoints** — the pixel-parity
    /// contract survives the dip untouched — with the minimum at mid-flight. It rides the
    /// same progress every other curve rides, so a scrub shows the dip under the finger and
    /// the settle spring carries the snap back to size. Clamped like every curve here: an
    /// overshooting spring renders the endpoint, never a magnified extrapolation.
    static func flightScale(at progress: CGFloat) -> CGFloat {
        let p = min(1, max(0, progress))
        guard p > 0, p < 1 else { return 1 }
        return 1 - Self.flightDipDepth * sin(.pi * p)
    }

    /// The one shared anchor the dip scales about — the **screen's own centre**, fixed for
    /// the whole travel. It used to be the container's centre, recomputed per frame; with
    /// the whole screen in the dip that anchor added a lateral drift (everything slid
    /// toward wherever the container's centre was that frame — against the board's own
    /// rightward travel at mid-flight) and it re-derived the transform every frame for no
    /// visible gain. A fixed centre is the space switcher's own read — the screen recedes
    /// in place — and one constant the render server never has to chase. Per-element
    /// anchors stay rejected for the reason they always were: parts wobbling about
    /// themselves instead of one scene breathing.
    static let flightDipAnchor: UnitPoint = .center

    // MARK: - The unmatched elements' fades

    /// Where the panel-controls pair has fully gone — Material's `FADE_MODE_OUT` window,
    /// the first quarter of the travel. It is the only element that should vanish early: it
    /// is the control the learner just pressed.
    static let controlsGoneBy: CGFloat = 0.25

    /// The pair's opacity: `1` at docked, `0` from a quarter of the travel on.
    static func controlsOpacity(at progress: CGFloat) -> Double {
        1 - unitSmoothstep(progress, from: 0, to: controlsGoneBy)
    }

    // MARK: - The thread crossfade

    /// The one genuine crossfade in the morph: the thread's bubbles re-wrap between the two
    /// columns, so two copies — each laid out once, glyph sizes matching — trade places
    /// mid-flight and read as text re-flowing rather than as a dissolve.
    ///
    /// The bands are Material's asymmetry: entering, the trade happens in the middle of the
    /// travel (`0.30 … 0.55` out, `0.30 … 0.60` in, overlapping — `FADE_MODE_CROSS`, never
    /// sequential, or the gap would show white); returning, the destination commits late
    /// (`0.45 … 0.70` / `0.40 … 0.75`). One function with a direction parameter, not two
    /// sets of functions.
    static func dockedThreadOpacity(at progress: CGFloat, returnLeg: Bool) -> Double {
        returnLeg
            ? 1 - unitSmoothstep(progress, from: 0.40, to: 0.75)
            : 1 - unitSmoothstep(progress, from: 0.30, to: 0.55)
    }

    static func fullThreadOpacity(at progress: CGFloat, returnLeg: Bool) -> Double {
        returnLeg
            ? unitSmoothstep(progress, from: 0.45, to: 0.70)
            : unitSmoothstep(progress, from: 0.30, to: 0.60)
    }

    private static func unitSmoothstep(_ x: CGFloat, from start: CGFloat, to end: CGFloat) -> Double {
        guard end > start else { return x >= end ? 1 : 0 }
        let t = min(1, max(0, (x - start) / (end - start)))
        return Double(t * t * (3 - 2 * t))
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

// MARK: - The shared elements' paths

/// Where each shared element of the docked ↔ full-screen morph is, at every point of the
/// travel — the per-element half of the arithmetic, beside `PresentationMorph`'s container
/// half.
///
/// The decisive measurement (2026-08-12 research brief, §2): with the reading column drawn
/// at the panel treatment (`TutorColumnMetrics.liveScale == .panel`, capped at 600), the two
/// endpoints draw **the same components at the same type scale on the same baselines**. The
/// docked start state and the full-screen start state differ in a horizontal translation of
/// the content column — `+491.5` at its centre on the reference screen — and a widening of
/// the chips and the pill from 301 to 600. Nothing scales, nothing re-typesets, nothing
/// needs a snapshot. So the shared elements are **single instances that travel**, never
/// pairs that dissolve, and this type is the path each one travels.
///
/// Every function is pure in `progress`, like the container's, so the return leg is the
/// same code read backwards and a gesture that turns around retraces its own frames.
struct PresentationFlight: Equatable, Sendable {

    /// The docked content column: `panelX + --space-panel-inset`, `panelWidth − 2 × inset` —
    /// x 46, width 301 on the reference screen.
    let dockedColumnX: CGFloat
    let dockedColumnWidth: CGFloat

    /// The reading column the full-screen surface actually draws — `TutorColumnMetrics`,
    /// sidebar-aware, capped at the panel treatment's 600. x 388, width 600 on the
    /// reference screen with the sidebar shut.
    let fullColumnX: CGFloat
    let fullColumnWidth: CGFloat

    /// The orb's top edge, identical at both ends by construction: both surfaces stack
    /// `--space-panel-inset + controls row + 120` below the content top —
    /// `TutorFullScreen.startBlock` mirrors `TutorPanel.startFill` exactly so *"the morph's
    /// two endpoints agree about where the tutor's face is."* 198 on the reference screen.
    let orbTop: CGFloat

    /// `Orb(.panel)`'s layout frame — 96 × 90. The size is fixed through the whole travel;
    /// the orb's path is a pure x translation.
    static let orbFrame = OrbSize.panel.metrics.frame

    /// The docked thread band's top — the panel's own content top. The full-screen thread's
    /// is the screen's raw top (`0`): its text scrolls freely off the screen edge.
    let dockedThreadTop: CGFloat

    /// The composer pill's bottom edge at each end. The docked pill sits the panel's 18pt
    /// inset above the panel's floor (986 on the reference screen); the full-screen pill's
    /// bottom **is** the content band's own bottom (1004). Both are keyboard-aware, so the
    /// flight follows a raised pill exactly as it follows a resting one.
    let dockedComposerBottom: CGFloat
    let fullComposerBottom: CGFloat

    init(layout: ScreenLayout, isSidebarOpen: Bool) {
        dockedColumnX = layout.panelX + TutorPanelMetrics.inset
        dockedColumnWidth = TutorPanelMetrics.contentWidth(for: layout.panelWidth)
        let column = TutorColumnMetrics(
            layout: layout,
            reserving: isSidebarOpen ? layout.sessionsSidebarWidth : 0
        )
        fullColumnX = column.x
        fullColumnWidth = column.width
        orbTop = layout.contentTop
            + TutorPanelMetrics.inset + TutorPanelMetrics.controlsHeight
            + PanelStack.orbTopMargin
        dockedComposerBottom = layout.contentTop + layout.contentHeightAboveKeyboard
            - TutorPanelMetrics.inset
        fullComposerBottom = layout.contentBottomAboveKeyboard
        fullToggle = CGPoint(
            x: layout.contentLeft + (isSidebarOpen ? layout.sessionsSidebarWidth : 0),
            y: layout.contentTop
        )
        dockedThreadTop = layout.contentTop
    }

    /// How far the content column's **centre** moves — `+491.5` on the reference screen.
    /// The one number the hi state's whole translation is.
    var columnShift: CGFloat {
        (fullColumnX + fullColumnWidth / 2) - (dockedColumnX + dockedColumnWidth / 2)
    }

    /// The orb's leading edge at rest docked — centred in the 301 column, 148.5 on the
    /// reference screen.
    var dockedOrbX: CGFloat {
        dockedColumnX + (dockedColumnWidth - Self.orbFrame.width) / 2
    }

    /// The orb's leading edge along the travel: the docked position plus the column shift on
    /// the lead curve, so the tutor's face arrives slightly before the box does.
    func orbX(at progress: CGFloat) -> CGFloat {
        travelled(from: dockedOrbX, by: PresentationMorph.lead(progress) * columnShift, at: progress)
    }

    // MARK: - The greeting

    /// The greeting block's top edge — identical at both ends for the reason the orb's is:
    /// both surfaces hang the block `--spacing-10` under the same orb. 328 on the reference
    /// screen.
    var greetingTop: CGFloat { orbTop + Self.orbFrame.height + DS.Space.s10 }

    /// The greeting text's leading edge along the travel. The block is laid out **once, at
    /// the docked column's width**, and only translated: the title is one line and the
    /// subtitle is capped at 277 at both ends, so a centred 301-wide block at the far
    /// column's centre is pixel-identical to the destination's own — no re-typesetting, no
    /// crossfade, the glyphs simply walk to the middle of the screen. It rides the
    /// staggered lead, one beat behind the orb.
    func greetingX(at progress: CGFloat) -> CGFloat {
        travelled(
            from: dockedColumnX,
            by: PresentationMorph.leadStaggered(progress) * columnShift,
            at: progress
        )
    }

    // MARK: - The chips

    /// The chip stack's top edge — the greeting's own chain, identical at both ends because
    /// both surfaces draw `GreetingBlock` at the panel treatment: title, its margins, the
    /// subtitle and `--spacing-8` down from the block's top. 452 on the reference screen.
    var chipsTop: CGFloat {
        let greeting = GreetingMetrics.for(.panel, width: dockedColumnWidth)
        return greetingTop
            + greeting.titleTopMargin + greeting.titleHeight
            + greeting.subtitleTopMargin + greeting.subtitleHeight
            + (greeting.suggestionsTopMargin ?? 0)
    }

    /// The chip stack's leading edge: 46 → 388 on the lead curve, one flock-beat behind
    /// the greeting (`chipsStagger`). The leading edge, not the centre — the width below is
    /// interpolating at the same time, and the pair is what carries the centre through the
    /// same +491.5 every other element travels.
    func chipsX(at progress: CGFloat) -> CGFloat {
        travelled(
            from: dockedColumnX,
            by: PresentationMorph.leadStaggered(progress, by: PresentationMorph.chipsStagger)
                * (fullColumnX - dockedColumnX),
            at: progress
        )
    }

    /// The chip stack's width: **301 → 600, linear on the finger.** The one genuine width
    /// interpolation in the hi state — nothing inside a chip re-wraps (an icon and one
    /// `lineLimit(1)` label), so the stretch is a real `.frame(width:)` and stays crisp.
    /// Linear, not led: the stretch tracks the box, which is glued to the finger.
    func chipsWidth(at progress: CGFloat) -> CGFloat {
        travelled(
            from: dockedColumnWidth,
            by: min(1, max(0, progress)) * (fullColumnWidth - dockedColumnWidth),
            at: progress
        )
    }

    // MARK: - The composer

    /// The pill's leading edge: the chips' path, one more beat behind (`composerStagger`) —
    /// the rear of the flock. 46 → 388, exact at both ends like every path here.
    func composerX(at progress: CGFloat) -> CGFloat {
        travelled(
            from: dockedColumnX,
            by: PresentationMorph.leadStaggered(progress, by: PresentationMorph.composerStagger)
                * (fullColumnX - dockedColumnX),
            at: progress
        )
    }

    /// The pill's width: the chips' own interpolation — 301 → 600, linear on the finger.
    /// The row's children are fixed-size buttons anchored at both ends around one flexible
    /// text lane, so the stretch re-wraps nothing.
    func composerWidth(at progress: CGFloat) -> CGFloat {
        chipsWidth(at: progress)
    }

    /// The pill's bottom edge: 986 → 1004 on the reference screen, linear on the finger —
    /// the one shared element with a vertical component, +18 as the panel's floor inset
    /// hands over to the content band's own bottom.
    func composerBottom(at progress: CGFloat) -> CGFloat {
        travelled(
            from: dockedComposerBottom,
            by: min(1, max(0, progress)) * (fullComposerBottom - dockedComposerBottom),
            at: progress
        )
    }

    /// The marquee glyph's slot in the flight pill — the glyph plus its gap, `24 + 10`.
    ///
    /// The one interior asymmetry between the two pills: the docked composer always draws
    /// `btn/select`, the wide one only while a selection is attached (board 07 draws no
    /// marquee in the wide pill). With a selection attached the slot holds at both ends;
    /// without one it folds to zero, linear on the finger, so the text lane absorbs it
    /// smoothly and the endpoint layouts match the settled surfaces exactly.
    func composerMarqueeSlot(at progress: CGFloat, isSelectionAttached: Bool) -> CGFloat {
        let slot = Icon.uiSelectionMarker.renderSize + ComposerMetrics.panel.gap
        guard !isSelectionAttached else { return slot }
        return slot * (1 - min(1, max(0, progress)))
    }

    // MARK: - The sidebar toggle

    /// The toggle's top-left at each end: the panel's chrome corner `(46, 46)` and the chat
    /// pane's own `(28 + sidebar, 28)` — 18 points in each axis, nearly stationary. It must
    /// **not** fade: it exists at both ends, and the eye is allowed to follow it.
    var dockedToggle: CGPoint {
        CGPoint(x: dockedColumnX, y: dockedToggleY)
    }
    let fullToggle: CGPoint
    private var dockedToggleY: CGFloat {
        fullToggle.y + TutorPanelMetrics.inset
    }

    /// Linear on the finger — 18 points needs no lead.
    func toggleX(at progress: CGFloat) -> CGFloat {
        travelled(
            from: dockedToggle.x,
            by: min(1, max(0, progress)) * (fullToggle.x - dockedToggle.x),
            at: progress
        )
    }

    func toggleY(at progress: CGFloat) -> CGFloat {
        travelled(
            from: dockedToggle.y,
            by: min(1, max(0, progress)) * (fullToggle.y - dockedToggle.y),
            at: progress
        )
    }

    // MARK: - The panel controls

    /// The layout pair's width — two 32pt buttons and their 14pt gap.
    static var controlsPairWidth: CGFloat {
        2 * TutorPanelMetrics.controlButton + TutorPanelMetrics.controlsGap
    }

    /// The pair's top-left at rest: trailing end of the docked content column, on the chrome
    /// row. The one element with no counterpart at full screen — it fades, early, because it
    /// is the control the learner just pressed and it leaving immediately is correct.
    var dockedControlsOrigin: CGPoint {
        CGPoint(
            x: dockedColumnX + dockedColumnWidth - Self.controlsPairWidth,
            y: dockedToggleY
        )
    }

    /// A 12pt trailing drift over the fade band — motion out, not just a dissolve.
    func controlsX(at progress: CGFloat) -> CGFloat {
        let fade = min(1, max(0, progress / PresentationMorph.controlsGoneBy))
        return travelled(from: dockedControlsOrigin.x, by: 12 * fade, at: progress)
    }

    // MARK: - The thread

    /// How far short of its final position the incoming thread starts — it arrives rather
    /// than appears.
    static let threadArrivalCounterTravel: CGFloat = 60

    /// The docked thread's band: the panel's own — x it shares with the greeting's path.
    func dockedThreadX(at progress: CGFloat) -> CGFloat {
        greetingX(at: progress)
    }

    /// The full-screen thread's leading edge: from 60pt short of home, closing on the lead
    /// curve so it lands exactly on the settled column.
    func fullThreadX(at progress: CGFloat) -> CGFloat {
        travelled(
            from: fullColumnX - Self.threadArrivalCounterTravel,
            by: PresentationMorph.lead(progress) * Self.threadArrivalCounterTravel,
            at: progress
        )
    }

    // MARK: - Arithmetic

    /// Whole points through the travel — every rasterised composite in the shell moves on
    /// whole points, or its text resamples a fraction of a pixel differently every frame —
    /// with the **exact** value at both endpoints, because the flight copy is swapped for
    /// the surface's own copy at rest and a half-point column centre (491.5's fault) must
    /// not round into a one-point jump at the handoff.
    private func travelled(from start: CGFloat, by shift: CGFloat, at progress: CGFloat) -> CGFloat {
        if progress <= 0 { return start }
        if progress >= 1 { return start + shift }
        return DrawerReveal.wholePoints(start + shift)
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

    /// Which leg the current flight is: `true` from full screen toward the board. Set at
    /// `begin`, beside the published anchor, and read only by the flight layer's fade
    /// curves — the return leg trades the thread later than the enter leg does. Not its own
    /// publisher: it changes only when `progress` does.
    private(set) var isReturnLeg = false

    /// True from a release (or a button's animated morph) until the spring has finished.
    /// Both contents stay mounted exactly this long — see `DockRevealModel.isSettling` for
    /// why a removal transition cannot do this job.
    @Published private(set) var isSettling = false

    var isDragging: Bool { progress != nil }

    /// Both presentations must stay mounted: a drag, or the spring after one.
    var isActive: Bool { progress != nil || isSettling }

    /// Which flight the model is on. Bumped by every `begin` and every `settle`, and read
    /// by `finishSettle(of:onFinished:)`: a settle spring's completion is only allowed to
    /// release the mounts if no newer flight has started under it. Without this, a gesture
    /// that commits while the previous flight's spring is still running — grab the morph
    /// back mid-settle — is later interrupted by the *old* spring's completion, which
    /// clears the mount flag under the live drag: the surfaces' own copies come back at
    /// full opacity while the flight copies are still in the air, and the screen shows
    /// both. That is the "elements do not disappear" class of leak, closed here.
    private(set) var generation = 0

    /// The pan committed. The anchor is whichever end the tutor was resting at — which,
    /// for a gesture that catches a settling flight, is the end the interrupted spring was
    /// already heading for: the settled presentation flipped at the spring's start, so the
    /// anchor and the screen agree by construction.
    func begin(atFullScreen: Bool) {
        generation += 1
        isReturnLeg = atFullScreen
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
    /// `onFinished` runs in the spring's completion, after the mounts are released — it is
    /// where a caller clears its own "a flight is in progress" state, and it is the one
    /// place that is guaranteed to be **outside** every animation transaction. Mount
    /// decisions belong there and nowhere animated — see the freeze post-mortem in the
    /// 2026-08-12 research brief, §9.3.
    func settle(
        to fullScreen: Bool,
        velocity: CGFloat,
        travel: CGFloat,
        onFinished: (() -> Void)? = nil,
        _ apply: @escaping () -> Void
    ) {
        isSettling = true
        generation += 1
        let flight = generation
        withAnimation(PresentationMorph.settle(velocity: velocity, travel: travel)) {
            progress = nil
            apply()
        } completion: { [weak self] in
            self?.finishSettle(of: flight, onFinished: onFinished)
        }
    }

    /// A settle spring's completion, gated by generation. Stale completions — the spring a
    /// newer gesture already interrupted — do nothing at all: neither `isSettling` nor the
    /// caller's mount flag may move under a live flight. Internal (not private) so the
    /// gating is assertable without a running animation.
    func finishSettle(of flight: Int, onFinished: (() -> Void)? = nil) {
        guard flight == generation else { return }
        isSettling = false
        onFinished?()
    }

    /// A tracked frame, in a transaction marked continuous — the flag SwiftUI provides for
    /// exactly this case: per-frame values written by a gesture rather than by an animation.
    func trackContinuously(_ value: CGFloat) {
        var transaction = Transaction()
        transaction.isContinuous = true
        withTransaction(transaction) { progress = value }
    }
}

// MARK: - The container's and the board's shapes

/// The morphing container's silhouette — for the background fill.
struct PresentationMorphContainerShape: Shape {
    var progress: CGFloat
    let geometry: PresentationMorph
    /// The corner band runs `0 … 0.75` entering and `0.30 … 0.90` returning — see
    /// `containerRadii(at:returnLeg:)`.
    var isReturnLeg = false

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(
            cornerRadii: geometry.containerRadii(at: progress, returnLeg: isReturnLeg)
        )
        .path(in: geometry.containerFrame(at: progress))
    }
}

/// The clip the flight rides inside is never a custom path — the container shape above is a
/// plain uneven rounded rectangle, the cheapest silhouette the render server has. The one
/// custom-path clip in the morph is the board's, below, because `BoardPeekShape` genuinely
/// cannot be a rounded rect — and even it spends most of the travel as one.
///
/// The mask over the sliding board card: the card's own rounded rect until
/// `PresentationMorph.boardMaskFrom`, then narrowing toward the peek silhouette's box — the
/// leading corners easing from the card's 28 to the silhouette's 18 — and resolving to
/// `BoardPeekShape` itself at the very end, under the peek artwork's crossfade.
///
/// In **card-local** coordinates: the mask's leading edge tracks the distance still to
/// travel, so the visible window narrows exactly as the card slides under the screen edge.
struct BoardFlightMask: Shape {
    /// `PresentationMorph.boardMaskProgress(at:)` — 0 full card, 1 the peek's silhouette.
    var progress: CGFloat

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let t = min(1, max(0, progress))
        guard t > 0 else {
            return RoundedRectangle(cornerRadius: WhiteboardMetrics.cornerRadius, style: .circular)
                .path(in: rect)
        }
        guard t < 1 else {
            return BoardPeekShape().path(
                in: CGRect(x: 0, y: 0, width: BoardPeekMetrics.width, height: rect.height)
            )
        }
        // Between the two: the card's silhouette narrowing onto the peek's box, leading
        // radii easing 28 → 18, trailing square from the start of the band — the trailing
        // corners are already off past the screen edge.
        let width = rect.width + (BoardPeekMetrics.width - rect.width) * t
        let leading = WhiteboardMetrics.cornerRadius
            + (BoardPeekShape.bottomFillet - WhiteboardMetrics.cornerRadius) * t
        return UnevenRoundedRectangle(
            cornerRadii: RectangleCornerRadii(
                topLeading: leading,
                bottomLeading: leading,
                bottomTrailing: 0,
                topTrailing: 0
            )
        )
        .path(in: CGRect(x: 0, y: 0, width: width, height: rect.height))
    }
}
