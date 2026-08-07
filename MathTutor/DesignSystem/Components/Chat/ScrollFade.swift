import SwiftUI

/// The gradients that dissolve the thread into the surface at each end of it.
///
/// **The two ends are no longer one curve mirrored, and that is the design.** They were, and
/// the symmetry was the wrong idea: above the thread there is nothing worth keeping legible,
/// so the top fade goes all the way to the surface colour and the oldest messages genuinely
/// disappear behind the controls. Below it there is — a message travelling under the composer
/// is still part of the conversation — so the bottom fade *stops short*. It ramps to 80% and
/// holds 80% flat to the floor, which leaves the thread readable at about a fifth of its
/// contrast: pushed back behind the pill rather than deleted.
///
/// So an end is three things, and each one differs:
///
/// | | ramp | plateau | peak |
/// |---|---|---|---|
/// | top | 60 / 56 | the inset above the controls | 1.0 — gone |
/// | bottom | 32 | whatever the composer leaves | 0.8 — a veil |
///
/// **The plateau is a run, not a remainder.** At the top it is added to the ramp and the fade
/// is as tall as the two together. At the bottom it is what is left of the composer's own band
/// once the ramp has taken its 32, because the fade has to start exactly on the composer's top
/// edge and end exactly on the surface's floor — see `bottom(coveringComposer:)`.
struct ScrollFadeMetrics: Equatable, Sendable {
    /// Which end of the surface this fade belongs to. It decides which way the ramp runs and
    /// nothing else; what the ramp *does* is `curve` and `peak`.
    enum Edge: Equatable, Sendable {
        case top
        case bottom
    }

    /// How the alpha travels across the ramp.
    ///
    /// Both are monotonic and both are flat where they meet the plateau — a curve that arrived
    /// there at a slope would put a corner in the gradient, and the eye reads a corner in a
    /// gradient as a line. They differ at the *transparent* end, which is the end the top fade
    /// can afford to be careless about and the bottom fade cannot.
    enum Curve: Equatable, Sendable {
        /// α(s) = 1 − (1 − s)². Zero slope where it meets the plateau, slope 2 where it leaves
        /// transparency. The top fade's, and only defensible there: its transparent end is
        /// deep in the thread where the ramp is 60 points long, so the onset is spread over
        /// more than two lines and there is nothing for the corner to sit against.
        case easeOut
        /// α(s) = 3s² − 2s³. Zero slope at **both** ends.
        ///
        /// The bottom fade's, and the reason it is a second case rather than a shared one. Over
        /// a 32pt ramp the `easeOut` onset is steep enough to draw a visible line where the
        /// fade begins — the same failure the plateau end has always been shaped to avoid, at
        /// the other end of the same gradient. Smoothstep is the cheapest curve that is flat at
        /// both, so neither boundary is findable.
        case smoothstep

        /// `s` runs 0 at the transparent edge of the ramp to 1 where it meets the plateau.
        /// Clamped, so a caller cannot drive a gradient past its own band.
        func opacity(atRampFraction s: Double) -> Double {
            let t = min(max(s, 0), 1)
            switch self {
            case .easeOut: return 1 - pow(1 - t, 2)
            case .smoothstep: return t * t * (3 - 2 * t)
            }
        }
    }

    /// One sample of the ramp: the surface colour at an alpha, at a fraction of the fade's own
    /// height.
    struct Stop: Equatable, Sendable {
        let opacity: Double
        let location: Double
    }

    let edge: Edge
    let curve: Curve
    /// The dissolve itself.
    let ramp: CGFloat
    /// The flat run between the ramp and the fade's outer edge — what the chrome sits on.
    let plateau: CGFloat
    /// The opacity the plateau holds. 1 at the top, where content is meant to be gone;
    /// `bottomPeak` at the bottom, where it is meant to survive.
    let peak: Double

    var height: CGFloat { ramp + plateau }

    /// How many points the curve is sampled at before SwiftUI interpolates linearly between
    /// them. Twelve is comfortably past the point where the piecewise-linear approximation of a
    /// cubic is distinguishable, and matches the stop count the boards carry.
    static let sampleCount = 12

    /// The gradient's stops, top to bottom, whichever edge this is.
    ///
    /// Ramping the alpha of one colour, never a gradient to `.clear`: `.clear` is transparent
    /// *black*, so interpolating towards it greys the midpoint of a near-white ramp.
    var stops: [Stop] {
        guard height > 0, ramp > 0 else {
            // A fade with no ramp is still a flat wash of `peak` over its band — which is what
            // a composer band shorter than 32 leaves, and drawing nothing there would let the
            // thread run out from under the pill.
            return height > 0 ? [Stop(opacity: peak, location: 0), Stop(opacity: peak, location: 1)] : []
        }
        let rampFraction = Double(ramp / height)
        // `s` = 0 at the transparent edge, 1 where the ramp meets the plateau.
        let samples = (0..<Self.sampleCount).map { Double($0) / Double(Self.sampleCount - 1) }

        switch edge {
        case .top:
            // Solid at the surface's own top edge, dissolving downward. The `s = 1` sample lands
            // exactly on the end of the plateau, so the flat run needs no stop of its own.
            return [Stop(opacity: peak, location: 0)] + samples.reversed().map { s in
                Stop(opacity: curve.opacity(atRampFraction: s) * peak, location: 1 - s * rampFraction)
            }
        case .bottom:
            // Transparent where the thread is still fully legible, up to `peak` over the ramp,
            // and `peak` held from there to the floor.
            return samples.map { s in
                Stop(opacity: curve.opacity(atRampFraction: s) * peak, location: s * rampFraction)
            } + [Stop(opacity: peak, location: 1)]
        }
    }
}

extension ScrollFadeMetrics {
    /// The top fade's ramp: 60 in the panel, 56 in the reading column.
    ///
    /// Longer than a line on purpose. *"The dissolve has to be longer than a line-height or a
    /// message drops from hidden to solid in one step and reads as a clip rather than a fade."*
    /// At 60 against a 25pt line that is 2.4 lines, so two or three messages are mid-dissolve at
    /// once. The reading column's is shorter for the same reason its whole fade is 64 rather
    /// than 80 — there is no 18pt panel inset above its controls. The ratio is not a scale
    /// factor; both numbers are the ones the boards carry.
    static func topRamp(for scale: ChatScale) -> CGFloat {
        switch scale {
        case .panel: 60
        case .fullScreen: 56
        }
    }

    /// The top fade: *"solid 20 then ramp"* in the panel, 8 in the reading column.
    ///
    /// The plateau is the inset above the controls, not the row itself — the controls sit *in*
    /// the ramp by design, which is what puts α at .75 on the icon baseline: *"text passes
    /// faintly behind the controls instead of stopping under them."*
    static func top(for scale: ChatScale) -> Self {
        Self(
            edge: .top,
            curve: .easeOut,
            ramp: topRamp(for: scale),
            plateau: scale == .panel ? 20 : 8,
            peak: 1
        )
    }

    /// The bottom fade's ramp. **One number, both scales, every screen.**
    ///
    /// Not `topRamp`'s 60/56, and not a per-scale lookup either. The top fade's length is set by
    /// how much thread it has to dissolve; this one's is set by the composer, and the composer's
    /// top edge is the same edge at both scales. 32 is where the onset stops being findable
    /// without the veil creeping up into the newest message.
    static let bottomRamp: CGFloat = 32

    /// What the bottom fade settles at, and the single value that makes it a veil rather than a
    /// wipe.
    ///
    /// A message that has travelled under the pill is still legible at 0.8 — roughly a fifth of
    /// its contrast — which reads as the conversation continuing behind the composer. At 1.0 the
    /// strip beside and below the pill goes blank and reads as the thread having ended.
    static let bottomPeak: Double = 0.8

    /// The bottom fade, over the band the composer occupies.
    ///
    /// **`band` is composer-top to surface-floor**, and both halves of that matter. The fade
    /// begins exactly where the input field begins — not at its centre, not above it — and ends
    /// on the foot of whatever surface it is anchored in, so its height *is* the band rather
    /// than being derived from it. The ramp lives inside that, which is why the plateau is the
    /// remainder here and an addition at the top.
    ///
    /// No `ChatScale`. The panel and the reading column pass different bands and get the same
    /// gradient, which is the whole of *"each screen, same fade"* — the only thing a screen
    /// gets to say is where its composer starts.
    ///
    /// A band shorter than the ramp is squeezed rather than overflowed: the fade still ends on
    /// the floor, it just has less room to get there. That is board 11's slot on a short iPad,
    /// not a case the boards draw.
    static func bottom(coveringComposer band: CGFloat) -> Self {
        let covered = max(0, band)
        let ramp = min(bottomRamp, covered)
        return Self(
            edge: .bottom,
            curve: .smoothstep,
            ramp: ramp,
            plateau: covered - ramp,
            peak: bottomPeak
        )
    }
}

/// One end of the fade, as paint.
struct ScrollFade: View {
    /// The band the fade spans. In the panel this is the panel's **full** width, not the
    /// content column: board 03 puts both fades outside the thread precisely so they can run
    /// corner to corner — *"which is why they can carry the panel's own corner radii."*
    let width: CGFloat
    let metrics: ScrollFadeMetrics
    /// The surface the fade has to match, and the reason this takes a parameter at all. In CSS
    /// it could not: *"a CSS gradient cannot take a token for its transparent stop, so #FCFCFC
    /// is hard-coded in every stop."* In Swift the stop takes the token, so the file's one
    /// untokenised colour does not survive the port.
    var color: Color = DS.Color.surfacePanel

    var body: some View {
        LinearGradient(
            stops: metrics.stops.map { .init(color: color.opacity($0.opacity), location: $0.location) },
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(width: max(0, width), height: metrics.height)
        // *"none — it is paint order, not a shadow"*, and paint that ate taps would make the
        // thread unreachable under it.
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

#if DEBUG
#Preview("Scroll fades") {
    ZStack(alignment: .top) {
        VStack(alignment: .leading, spacing: DS.Space.messageGap) {
            ForEach(0..<9) { i in
                Text("A line of the conversation, number \(i + 1), dissolving into the panel.")
                    .textStyle(.body)
                    .frame(width: TutorPanelMetrics.contentWidth, alignment: .leading)
            }
        }
        .padding(.horizontal, TutorPanelMetrics.inset)

        ScrollFade(width: TutorPanelMetrics.width, metrics: .top(for: .panel))
            .frame(maxHeight: .infinity, alignment: .top)
        ScrollFade(
            width: TutorPanelMetrics.width,
            metrics: .bottom(coveringComposer: ComposerMetrics.panel.height + TutorPanelMetrics.inset)
        )
        .frame(maxHeight: .infinity, alignment: .bottom)
    }
    .frame(width: TutorPanelMetrics.width, height: 420)
    .background(DS.Color.surfacePanel)
    .clipShape(RoundedRectangle(cornerRadius: TutorPanelMetrics.cornerRadius))
    .padding(44)
    .background(DS.Color.surfaceScreen)
}
#endif
