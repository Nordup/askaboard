import SwiftUI
import UIKit

/// The docked ↔ full-screen morph's gesture, bundled for the two surfaces that drive it.
///
/// The gesture starts in two owners — the leading edge zone inside `DockRevealLayer` going
/// up, the peek's lane inside `TutorFullScreen` coming down — while the one view that
/// renders it is `PresentationFlightLayer`. Both owners hold the model as a plain reference
/// and only write; the closures are `BoardScreen`'s, which owns the settle and the mounts.
@MainActor
struct PresentationFlightHandle {
    /// The live position. Written by the gesture owners, observed only by the flight layer.
    let drag: PresentationMorphModel
    /// `PresentationMorph.travel(in:)` — 1011 on the reference screen.
    let travel: CGFloat
    /// A pan committed to this axis. `BoardScreen` flips its own un-animated flight flag
    /// here and resigns the composer's focus on a main-queue hop — never inside a render
    /// transaction; see `BoardCanvas.Coordinator.updateFirstResponder` for the scar.
    let onBegin: () -> Void
    /// The committed pan released, with its release velocity. `BoardScreen` reads the live
    /// progress, applies the shared release rule and settles the morph.
    let onRelease: (CGFloat) -> Void

    /// A tracked frame, from either owner.
    func track(anchor: CGFloat, translation: CGFloat) {
        drag.trackContinuously(
            PresentationMorph.progress(from: anchor, translation: translation, travel: travel)
        )
    }
}

/// Which piece of the flight a view is. Grows one role per step of the rebuild —
/// see the 2026-08-12 research brief, §6.2's table, which this enum is the code half of.
enum FlightRole {
    /// The tutor's face: a pure x translation on the lead curve, y and size fixed.
    case orb
    /// The greeting title + subtitle: one 301-wide block, translated on the staggered lead —
    /// glyphs never change size, the text simply walks to the middle of the screen.
    case greeting
    /// The four suggestion chips: leading edge on the lead curve, **width 301 → 600 linear
    /// on the finger** — the hi state's one genuine width interpolation. Nothing inside a
    /// chip re-wraps, so the stretch is a real `.frame(width:)` and stays crisp.
    case chips
    /// The composer pill: the chips' path and width interpolation, plus the one vertical
    /// component in the hi state — its bottom edge drops the 18pt from the panel's floor
    /// inset to the content band's own bottom. Bottom-anchored, so a pill grown by typed
    /// lines keeps its bottom edge on the interpolated line exactly as it does at rest.
    case composer
    /// The sidebar toggle: 18 points in each axis, linear, never fading — it exists at both
    /// ends and the eye is allowed to follow it.
    case toggle
    /// The panel-controls pair: the one unmatched element. Opacity out over the first
    /// quarter of the travel with a 12pt trailing drift — Material's `FADE_MODE_OUT`.
    case panelControls
    /// The docked thread copy: laid out once at the panel's column, translated on the
    /// staggered lead, traded on the crossfade band. Half of the morph's one real fade.
    case dockedThread
    /// The full-screen thread copy: laid out once at the reading column, arriving from
    /// 60pt short of home on the lead curve. The other half of the fade.
    case fullThread
    /// The live board card: translated toward the trailing edge by `boardShift` — never
    /// resized, never faded — so its leading edge lands exactly on the peek's own line.
    case board
    /// The tool rail: the board's own shift, fading out over the first 35% — the ground
    /// leaves as one plane, rail and card together, instead of the card sliding out from
    /// beside a nailed-down toolbar. The one other unmatched element beside the controls.
    case rail
    /// The peek silhouette: a distinct artwork crossfading over the arriving card's last
    /// 15% of travel.
    case peek
    /// The panel's extracted elevation: a static-shaped underlay that only ever changes
    /// opacity, gone by 30% — never a shadow on the morphing shape itself, which would
    /// re-rasterise its input every frame.
    case panelShadow
    /// Board 19's sidebar, folding its own width off the leading edge along the same
    /// progress. The *flag* is untouched — the fold is what the morph does to the sidebar's
    /// position, not to the learner's choice.
    case sidebar
    /// The panel's own fill riding on the container while it is still mostly the panel —
    /// `--color-surface-panel` over the pane's white, gone per `panelFillOpacity`.
    case containerPanelFill
}

/// The per-frame rendering of one flight role, as an **animatable** modifier.
///
/// Animatable is what makes a tap and a swipe one system: a gesture writes `progress`
/// directly and the modifier renders it, while a settle animates `animatableData` through
/// the spring, so every intermediate frame goes through the *curves*.
///
/// The rule this type obeys, from the freeze post-mortem: `animatableData` varies
/// **geometry only** — offsets, widths, opacities. It never decides what exists; every
/// mount around it is keyed on state written outside animation transactions.
struct FlightRender: ViewModifier {
    var progress: CGFloat
    let role: FlightRole
    let flight: PresentationFlight
    let geometry: PresentationMorph
    /// Which way this flight is going — the thread's fade bands are the one place the two
    /// legs differ (see `PresentationMorph.dockedThreadOpacity`). Affects opacity only.
    var isReturnLeg = false

    @ViewBuilder
    func body(content: Content) -> some View {
        switch role {
        case .orb:
            content.offset(x: flight.orbX(at: progress), y: flight.orbTop)
        case .greeting:
            content.offset(x: flight.greetingX(at: progress), y: flight.greetingTop)
        case .toggle:
            content.offset(x: flight.toggleX(at: progress), y: flight.toggleY(at: progress))
        case .panelControls:
            content
                .offset(x: flight.controlsX(at: progress), y: flight.dockedControlsOrigin.y)
                .opacity(PresentationMorph.controlsOpacity(at: progress))
        case .dockedThread:
            content
                .offset(x: flight.dockedThreadX(at: progress), y: flight.dockedThreadTop)
                .opacity(PresentationMorph.dockedThreadOpacity(at: progress, returnLeg: isReturnLeg))
        case .fullThread:
            content
                .offset(x: flight.fullThreadX(at: progress), y: 0)
                .opacity(PresentationMorph.fullThreadOpacity(at: progress, returnLeg: isReturnLeg))
        case .board:
            content.offset(x: geometry.boardShift(at: progress))
        case .rail:
            content
                .offset(x: geometry.railShift(at: progress))
                .opacity(PresentationMorph.railOpacity(at: progress))
        case .peek:
            content.opacity(geometry.peekOpacity(at: progress))
        case .panelShadow:
            content.opacity(geometry.panelShadowOpacity(at: progress))
        case .sidebar:
            content.offset(x: geometry.sidebarShift(at: progress))
        case .chips:
            content
                .frame(width: flight.chipsWidth(at: progress))
                .offset(x: flight.chipsX(at: progress), y: flight.chipsTop)
        case .composer:
            content
                .frame(width: flight.composerWidth(at: progress))
                .frame(height: flight.composerBottom(at: progress), alignment: .bottom)
                .offset(x: flight.composerX(at: progress))
        case .containerPanelFill:
            content.opacity(geometry.panelFillOpacity(at: progress))
        }
    }
}

/// `@preconcurrency` for the reason `PresentationMorphRender`'s conformance is: SwiftUI
/// evaluates `animatableData` on the main actor during rendering.
extension FlightRender: @preconcurrency Animatable {
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }
}

/// The travelling scene's dip — the space-switcher breath, applied to the **whole screen
/// scene** as one group about one fixed anchor: `PresentationMorph.flightScale` about the
/// screen's centre. It wraps the layer's entire stack — board card, rail, chat surface,
/// flight copies and the arriving peek — because the user's read of the shipped chat-only
/// dip was that the ground refused to move ("board doesn't scale while moving"); the OS
/// space switcher this quotes zooms everything, and so does this. One `scaleEffect` is a
/// render-tree transform: the live `PKCanvasView` is never resized or re-laid-out, its
/// existing tiles are composited under one matrix, exactly as the OS app switcher treats
/// a whole app's layer. Per-element scaling stays rejected — parts wobbling about
/// themselves instead of one scene breathing. Exactly 1 at both endpoints, so the
/// pixel-parity handoff to the settled surfaces is untouched, and at rest the modifier is
/// an identity transform. Geometry only, like every animatable here — it decides nothing
/// about what exists.
struct FlightDip: ViewModifier {
    var progress: CGFloat

    func body(content: Content) -> some View {
        content.scaleEffect(
            PresentationMorph.flightScale(at: progress),
            anchor: PresentationMorph.flightDipAnchor
        )
    }
}

extension FlightDip: @preconcurrency Animatable {
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }
}

/// The region that hosts the board, the rail, the tutor and the floating peek — and, while
/// a docked ↔ full-screen morph is in flight, the morphing container and the flight copies
/// of the shared elements.
///
/// **The `DockRevealLayer` discipline, one rung up.** Every slot arrives as an
/// already-built view value and is stored; a gesture frame re-runs only this body, which
/// hands the same values back — SwiftUI compares them, finds them unchanged, and never asks
/// the thread, the composer or the canvas for a body. The per-frame work is the container's
/// two paths and a handful of flight modifiers.
///
/// **This is the only view that observes `PresentationMorphModel`** — the repo's one-view
/// rule for a per-frame publisher.
///
/// **Mounts are never decided by animated state.** The container and the flight copies
/// mount on `model.isActive`, which changes exactly twice per flight: at gesture commitment
/// (a UIKit callback, no transaction) and in the settle spring's completion. The settled
/// presentation still flips *inside* the settle transaction — that is the spring — but by
/// then everything whose existence depends on the flight is already mounted and stays
/// mounted until the completion releases it.
struct PresentationFlightLayer<
    Board: View, Rail: View, Tutor: View, Floating: View,
    DockedThread: View, FullThread: View, Sidebar: View
>: View {
    /// The container's arithmetic — endpoints, radii, fill and shadow curves.
    let morph: PresentationMorph
    /// The shared elements' paths.
    let flight: PresentationFlight
    /// The settled end: `true` when the screen is drawing the full-screen column.
    let isFullScreen: Bool
    /// Which fill the tutor is showing. The greeting's flight copies exist only in the
    /// start state; the thread state flies its own set.
    let conversation: ConversationPhase
    /// What the composer's flight copy draws in its text lane — the learner's own draft, at
    /// the same metrics the live field renders it.
    let composerText: String
    /// Whether the marquee glyph holds its slot at both ends (a selection is attached) or
    /// folds away toward the wide pill, which draws no marquee at rest.
    let isSelectionAttached: Bool
    /// Whether the pill draws a mic — availability, not scale, decides it, exactly as it
    /// decides for the live composer.
    let showsVoice: Bool
    @ObservedObject var model: PresentationMorphModel
    @ViewBuilder let board: Board
    @ViewBuilder let rail: Rail
    @ViewBuilder let tutor: Tutor
    @ViewBuilder let floating: Floating
    /// The thread's two crossfade copies, built by the caller — which has the store and the
    /// actions in reach — **as stored slots**: each is laid out once at its own column and
    /// must not be rebuilt per frame. Mounted only in the thread state, only in flight.
    @ViewBuilder let dockedThread: DockedThread
    @ViewBuilder let fullThread: FullThread
    /// The full-screen sessions sidebar's flight copy — mounted by the caller only while
    /// the learner's sidebar flag is set. It folds its own width off the leading edge over
    /// the same progress, drawn under the container so the growing sheet covers the seam.
    @ViewBuilder let sidebar: Sidebar

    /// Where the morph is right now: the live drag, or the settled end.
    private var progress: CGFloat { model.progress ?? (isFullScreen ? 1 : 0) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            // The card's flight modifier is attached unconditionally — a structural branch
            // around this slot would remount `PKCanvasView` at every commitment and lose
            // the ink contract. At rest the offset is exactly 0 (docked) or the settled
            // 846 under an invisible card (full screen); no mask ever wraps the canvas,
            // because at the shipped curves the mask's cut edge never crosses the screen
            // edge (`PresentationFlightTests` proves it), so it would buy an offscreen
            // pass on the live canvas for zero visible pixels. `BoardFlightMask` stays
            // compiled and tested as the design of record for a device where the curves
            // ever change.
            board.modifier(render(.board))
            // The rail rides the board's shift and fades over the first 35% — the ground
            // leaves as one plane. Unconditional like the board's, for the same reason: a
            // structural branch here would remount the rail at every commitment. At rest
            // the shift is exactly 0 (docked) or the rail is unmounted (full screen).
            rail.modifier(render(.rail))
            ZStack(alignment: .topLeading) {
                if model.isActive {
                    sidebar.modifier(render(.sidebar))
                    containerUnderlay
                }
                tutor
                if model.isActive {
                    flightElements
                }
            }
            .frame(
                width: morph.screenFrame.width,
                height: morph.screenFrame.height,
                alignment: .topLeading
            )
            floating.modifier(render(.peek))
        }
        // The dip wraps the WHOLE scene — board card, rail, chat surface, flight copies
        // and the arriving peek — as one screen-framed stack about the screen's centre,
        // so everything zooms out and snaps back together (the user's space-switcher
        // ask; a chat-only dip over a still ground was rejected on device). At rest the
        // scale is exactly 1, so this wrapper is an identity outside flights and decides
        // no mounts.
        .frame(
            width: morph.screenFrame.width,
            height: morph.screenFrame.height,
            alignment: .topLeading
        )
        .modifier(FlightDip(progress: progress))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The morphing container: the pane's white at every point, with the panel's own grey
    /// riding on it while it is still mostly the panel. Drawn under the tutor slot, so the
    /// origin surface's contents stay crisp on top of it while the box grows or shrinks
    /// beneath them.
    ///
    /// Two animatable paths per frame — inside the brief's budget ("one is fine, six are
    /// not"), and both are plain uneven rounded rectangles, never a custom-path clip.
    private var containerUnderlay: some View {
        ZStack(alignment: .topLeading) {
            // The panel's elevation, extracted to a static-shaped underlay: the shape never
            // changes, so the shadow is rasterised once and only its opacity moves — gone
            // by 30%, together with the panel's fill, so the panel reads as dissolving
            // into the sheet rather than floating on it.
            RoundedRectangle(cornerRadius: TutorPanelMetrics.cornerRadius)
                .fill(DS.Color.surfacePanel)
                .frame(width: morph.dockedFrame.width, height: morph.dockedFrame.height)
                .compositingGroup()
                .elevation(.panel)
                .offset(x: morph.dockedFrame.minX, y: morph.dockedFrame.minY)
                .modifier(render(.panelShadow))
            PresentationMorphContainerShape(
                progress: progress, geometry: morph, isReturnLeg: model.isReturnLeg
            )
                .fill(DS.Color.surface)
            PresentationMorphContainerShape(
                progress: progress, geometry: morph, isReturnLeg: model.isReturnLeg
            )
                .fill(DS.Color.surfacePanel)
                .modifier(render(.containerPanelFill))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// The flight copies of the shared elements — single instances that travel, replacing
    /// the surfaces' own copies for exactly the duration of the flight. Built as values in
    /// this body: each is value-identical from frame to frame, so only its flight modifier
    /// changes and nothing inside it re-renders.
    @ViewBuilder
    private var flightElements: some View {
        ZStack(alignment: .topLeading) {
            if conversation == .start {
                Orb(.panel)
                    .modifier(render(.orb))
                FlightGreeting(width: flight.dockedColumnWidth)
                    .modifier(render(.greeting))
                FlightChips()
                    .modifier(render(.chips))
            } else {
                // The one real crossfade: two copies of the thread, each laid out once at
                // its own column, co-located mid-flight so the trade reads as the same
                // text re-flowing into new line breaks. Both mounted for the whole flight.
                dockedThread
                    .modifier(render(.dockedThread))
                fullThread
                    .modifier(render(.fullThread))
            }
            SidebarToggleButton(action: {})
                .modifier(render(.toggle))
            PanelControls(onDock: {}, onFullScreen: {}, alignment: .leading)
                .modifier(render(.panelControls))
            FlightComposer(
                progress: progress,
                flight: flight,
                text: composerText,
                isSelectionAttached: isSelectionAttached,
                showsVoice: showsVoice
            )
            .modifier(render(.composer))
        }
        // Framed to the screen so every child's `.offset` placement stays in screen
        // coordinates. The dip no longer rides here: the whole screen scene — board,
        // rail, container, resting tutor and these copies — takes one `FlightDip` at the
        // layer's root, so everything zooms as a unit instead of the copies dipping over
        // a still box.
        .frame(
            width: morph.screenFrame.width,
            height: morph.screenFrame.height,
            alignment: .topLeading
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func render(_ role: FlightRole) -> FlightRender {
        FlightRender(
            progress: progress,
            role: role,
            flight: flight,
            geometry: morph,
            isReturnLeg: model.isReturnLeg
        )
    }
}

/// The greeting's flight copy: the title and subtitle exactly as `GreetingBlock` draws them
/// at the panel treatment, laid out **once at the docked column's width** and only ever
/// translated. The subtitle is capped at 277 at both ends and the title is one line, so the
/// 301-wide block centred on the destination column's centre is pixel-identical to the
/// destination's own — the honest, crisp, vector answer to "text taking shape".
/// The composer pill's flight copy: every fixed child of the row exactly as `Composer`
/// draws it at the panel treatment, around a text lane that is a plain `Text` run of the
/// draft — **no `TextField`**, so the whole first-responder hazard is off the animated path
/// (the live field is the origin surface's, hidden and focus-resigned for the duration).
///
/// Width-flexible like the chips, so the outer flight modifier's `.frame(width:)` is the
/// interpolation. The one interior track of its own is the marquee's slot, which folds to
/// zero toward the wide pill (board 07 draws no marquee there) — which is why this view is
/// itself `Animatable`: the fold must run through the settle spring, not jump at release.
private struct FlightComposer: View {
    var progress: CGFloat
    let flight: PresentationFlight
    let text: String
    let isSelectionAttached: Bool
    let showsVoice: Bool

    var body: some View {
        let metrics = ComposerMetrics.panel
        HStack(alignment: .bottom, spacing: 0) {
            IconView(.uiPlus, size: metrics.plusSize, tint: DS.Color.icon)
                .frame(height: metrics.innerHeight)

            // The marquee and the gap before it, as one folding slot — trailing-aligned so
            // the glyph slides under the plus as the slot closes, clipped at the seam.
            HStack(spacing: 0) {
                IconView(
                    .uiSelectionMarker,
                    size: metrics.marqueeSize,
                    tint: isSelectionAttached ? DS.Color.brand : DS.Color.icon
                )
                .frame(height: metrics.innerHeight)
            }
            .frame(
                width: flight.composerMarqueeSlot(at: progress, isSelectionAttached: isSelectionAttached),
                alignment: .trailing
            )
            .clipped()

            ZStack(alignment: .leading) {
                if text.isEmpty {
                    Text(verbatim: metrics.placeholder)
                        .textStyle(metrics.placeholderStyle)
                        .foregroundStyle(DS.Color.inkTertiary)
                } else {
                    Text(verbatim: text)
                        .textStyle(metrics.placeholderStyle)
                        .foregroundStyle(DS.Color.ink)
                        .lineLimit(ComposerMetrics.maxLines)
                }
            }
            .frame(maxWidth: .infinity, minHeight: metrics.innerHeight, alignment: .leading)
            .padding(.leading, metrics.gap)

            if showsVoice {
                ComposerVoiceButton(metrics: metrics, action: {})
                    .frame(height: metrics.innerHeight)
                    .padding(.leading, metrics.gap)
            }

            ComposerSendButton(metrics: metrics, action: {})
                .frame(height: metrics.innerHeight)
                .padding(.leading, metrics.gap)
        }
        .padding(.leading, metrics.paddingLeading)
        .padding(.trailing, metrics.paddingTrailing)
        .padding(.vertical, metrics.paddingVertical)
        .fixedSize(horizontal: false, vertical: true)
        .background(
            DS.Color.surface,
            in: RoundedRectangle(cornerRadius: metrics.cornerRadius, style: .circular)
        )
        .elevation(.control)
    }
}

extension FlightComposer: @preconcurrency Animatable {
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }
}

/// The chip stack's flight copy: the four openers exactly as `SuggestionChip` draws them at
/// the panel treatment, with one difference — each chip is **width-flexible**, so the width
/// the flight modifier interpolates outside reaches every row as one `.frame(width:)`. All
/// the fixed metrics (62pt rows, 10pt gaps, 18pt padding, 22pt icon, the un-scaled 14pt
/// radius) are the panel treatment's own at both ends, so nothing but the width moves.
private struct FlightChips: View {
    var body: some View {
        let metrics = SuggestionChipMetrics.for(.panel, width: DS.Container.panelContent)
        VStack(spacing: metrics.listGap) {
            ForEach(Suggestion.allCases) { suggestion in
                HStack(spacing: metrics.gap) {
                    IconView(suggestion.icon, size: metrics.iconSize, tint: DS.Color.brand)
                    Text(verbatim: suggestion.label)
                        .textStyle(metrics.labelStyle)
                        .foregroundStyle(DS.Color.ink)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.leading, metrics.paddingLeading)
                .frame(maxWidth: .infinity, minHeight: metrics.height, maxHeight: metrics.height, alignment: .leading)
                .background(
                    DS.Color.surface,
                    in: RoundedRectangle(cornerRadius: metrics.radius, style: .circular)
                )
                .elevation(.control)
            }
        }
    }
}

private struct FlightGreeting: View {
    let width: CGFloat

    var body: some View {
        let metrics = GreetingMetrics.for(.panel, width: width)
        VStack(spacing: 0) {
            Text(verbatim: GreetingCopy.title)
                .textStyle(metrics.titleStyle)
                .foregroundStyle(DS.Color.ink)
                .multilineTextAlignment(.center)
                .frame(width: metrics.width, height: metrics.titleHeight)
                .padding(.top, metrics.titleTopMargin)

            Text(verbatim: GreetingCopy.subtitle)
                .textStyle(metrics.subtitleStyle)
                .foregroundStyle(DS.Color.inkSecondary)
                .multilineTextAlignment(.center)
                .frame(width: metrics.subtitleWidth, height: metrics.subtitleHeight)
                .padding(.top, metrics.subtitleTopMargin)
        }
        .frame(width: width, alignment: .top)
    }
}
