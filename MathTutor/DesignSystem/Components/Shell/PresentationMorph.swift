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

    /// The lead curve, a beat behind the orb: `p` remapped to `[0.05, 1]` before easing, so
    /// the greeting follows the tutor's face by a stagger of 5% of the travel rather than
    /// moving as one welded plate with it.
    static func leadStaggered(_ progress: CGFloat) -> CGFloat {
        lead((progress - 0.05) / 0.95)
    }

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

    /// The chip stack's leading edge: 46 → 388 on the lead curve. The leading edge, not the
    /// centre — the width below is interpolating at the same time, and the pair is what
    /// carries the centre through the same +491.5 every other element travels.
    func chipsX(at progress: CGFloat) -> CGFloat {
        travelled(
            from: dockedColumnX,
            by: PresentationMorph.lead(progress) * (fullColumnX - dockedColumnX),
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

    /// The pill's leading edge: the chips' own path — 46 → 388 on the lead curve.
    func composerX(at progress: CGFloat) -> CGFloat {
        chipsX(at: progress)
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

    /// The pan committed. The anchor is whichever end the tutor was resting at.
    func begin(atFullScreen: Bool) {
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
        withAnimation(DrawerReveal.settle(velocity: velocity, travel: travel)) {
            progress = nil
            apply()
        } completion: { [weak self] in
            self?.isSettling = false
            onFinished?()
        }
    }

    /// A tracked frame, in a transaction marked continuous — the flag SwiftUI provides for
    /// exactly this case: per-frame values written by a gesture rather than by an animation.
    func trackContinuously(_ value: CGFloat) {
        var transaction = Transaction()
        transaction.isContinuous = true
        withTransaction(transaction) { progress = value }
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
