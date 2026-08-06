import SwiftUI

/// The thread's top fade — *"a 72pt panel-coloured gradient pinned to the top of the
/// thread, so messages dissolve into the panel instead of being guillotined by its edge."*
///
/// The board's warning about it is the reason this is its own type: *"this is the one
/// colour in the whole file that is not tokenised. A CSS gradient cannot take a token for
/// its transparent stop, so #FCFCFC is hard-coded in all four stops. If
/// `var(--color-surface-panel)` ever changes, this gradient must be edited by hand or the
/// fade will bleed a different white over the messages."* In Swift a gradient stop *can*
/// take the token, so the fade takes it, and the untokenised colour disappears.
struct ScrollFadeMetrics: Equatable, Sendable {
    /// One stop of the ramp: the panel colour at an alpha, at a position.
    struct Stop: Equatable, Sendable {
        let opacity: Double
        let location: Double
    }

    let height: CGFloat
    /// `#FCFCFC 0%` · `#FCFCFC 34%` · `rgba(252,252,252,.72) 62%` · `rgba(252,252,252,0) 100%`.
    ///
    /// Stored in the file as oklab, and the board says to *"port as a plain sRGB alpha
    /// ramp"*. That instruction is doing real work: a gradient from an opaque colour to
    /// `.clear` interpolates towards transparent *black*, which greys the midpoint of a
    /// near-white ramp. Ramping the alpha of one colour cannot do that.
    let stops: [Stop]

    static let standard = Self(
        height: 72,
        stops: [
            Stop(opacity: 1, location: 0),
            Stop(opacity: 1, location: 0.34),
            Stop(opacity: 0.72, location: 0.62),
            Stop(opacity: 0, location: 1),
        ]
    )
}

struct ScrollFade: View {
    /// The thread's column — the fade spans it exactly, at whatever width it has.
    let width: CGFloat
    var metrics: ScrollFadeMetrics = .standard
    /// The surface the fade has to match. Defaults to the tutor panel, which is the only
    /// place the design puts a thread; a fade over another surface would have to be that
    /// surface's colour or it bleeds, which is the whole point of the board's warning.
    var color: Color = DS.Color.surfacePanel

    var body: some View {
        LinearGradient(
            stops: metrics.stops.map { .init(color: color.opacity($0.opacity), location: $0.location) },
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(width: max(0, width), height: metrics.height)
        // *"It is paint order, not a shadow"* — and paint that eats taps would make the
        // top of the thread unreachable.
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
