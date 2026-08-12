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

    @ViewBuilder
    func body(content: Content) -> some View {
        switch role {
        case .orb:
            content.offset(x: flight.orbX(at: progress), y: flight.orbTop)
        case .greeting:
            content.offset(x: flight.greetingX(at: progress), y: flight.greetingTop)
        case .chips:
            content
                .frame(width: flight.chipsWidth(at: progress))
                .offset(x: flight.chipsX(at: progress), y: flight.chipsTop)
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
struct PresentationFlightLayer<Board: View, Rail: View, Tutor: View, Floating: View>: View {
    /// The container's arithmetic — endpoints, radii, fill and shadow curves.
    let morph: PresentationMorph
    /// The shared elements' paths.
    let flight: PresentationFlight
    /// The settled end: `true` when the screen is drawing the full-screen column.
    let isFullScreen: Bool
    /// Which fill the tutor is showing. The greeting's flight copies exist only in the
    /// start state; the thread state flies its own set.
    let conversation: ConversationPhase
    @ObservedObject var model: PresentationMorphModel
    @ViewBuilder let board: Board
    @ViewBuilder let rail: Rail
    @ViewBuilder let tutor: Tutor
    @ViewBuilder let floating: Floating

    /// Where the morph is right now: the live drag, or the settled end.
    private var progress: CGFloat { model.progress ?? (isFullScreen ? 1 : 0) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            board
            rail
            if model.isActive {
                containerUnderlay
            }
            tutor
            if model.isActive {
                flightElements
            }
            floating
        }
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
            PresentationMorphContainerShape(progress: progress, geometry: morph)
                .fill(DS.Color.surface)
            PresentationMorphContainerShape(progress: progress, geometry: morph)
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
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func render(_ role: FlightRole) -> FlightRender {
        FlightRender(progress: progress, role: role, flight: flight, geometry: morph)
    }
}

/// The greeting's flight copy: the title and subtitle exactly as `GreetingBlock` draws them
/// at the panel treatment, laid out **once at the docked column's width** and only ever
/// translated. The subtitle is capped at 277 at both ends and the title is one line, so the
/// 301-wide block centred on the destination column's centre is pixel-identical to the
/// destination's own — the honest, crisp, vector answer to "text taking shape".
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
