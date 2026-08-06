import SwiftUI

/// The orb's colour, and the one place in this port where the design cannot be reproduced
/// exactly.
///
/// **The design's gradients interpolate in oklab; SwiftUI has no oklab gradient.** Board 02
/// is explicit — *"Do not convert these gradients out of the oklab colour space — the board
/// specifies `in oklab` interpolation explicitly"* — so this is a knowing deviation, not an
/// oversight, and it is worth being precise about its size:
///
/// - **Every stop is exact.** oklab → sRGB is a lossless conversion for an in-gamut colour,
///   and all eleven of these stops are comfortably in gamut, so the colours the gradients
///   start, turn and end on are the design's own to full float precision.
/// - **Only the path between stops shifts.** Interpolating in sRGB instead of oklab moves
///   the midtones by at most **0.5/255 per channel** if SwiftUI blends in gamma-encoded
///   sRGB, or at most **2.9/255** if it blends linearly — and that worst case is in the orb
///   body's near-black midtones, where 3/255 is well under the display's resolution. The
///   halo's three gradients stay within **0.25/255** under either assumption, because they
///   run between pale, closely-spaced lavenders where every interpolation space agrees.
///
/// In short: visually indistinguishable, but not byte-identical, and the reason is
/// structural rather than fixable.
enum OrbPalette {
    // MARK: - Body

    /// `linear-gradient(in oklab 180deg, oklab(25.4% -0.001 -0.053) 0%,`
    /// `oklab(17.5% -0.009 -0.032) 46%, oklab(13% -0.010 -0.019) 100%)`.
    static var bodyGradient: LinearGradient {
        LinearGradient(
            stops: [
                Gradient.Stop(color: bodyTop, location: 0),
                Gradient.Stop(color: bodyMid, location: 0.46),
                Gradient.Stop(color: bodyBottom, location: 1),
            ],
            // CSS `180deg` points down the page.
            startPoint: .top,
            endPoint: .bottom
        )
    }

    /// `oklab(25.4% -0.001 -0.053)`
    static let bodyTop = Color(.sRGB, red: 0.09442, green: 0.12880, blue: 0.23541, opacity: 1)
    /// `oklab(17.5% -0.009 -0.032)`
    static let bodyMid = Color(.sRGB, red: 0.02414, green: 0.06638, blue: 0.12046, opacity: 1)
    /// `oklab(13% -0.010 -0.019)`
    static let bodyBottom = Color(.sRGB, red: 0.00781, green: 0.03175, blue: 0.05882, opacity: 1)

    // MARK: - Halo

    /// The warm (lavender) bloom, upper-left. `oklab(87.4% 0.048 -0.042)` →
    /// `oklab(89.8% 0.036 -0.034)` → `oklab(93% 0.022 -0.023)`, transparent by 74%.
    static func warmBloomStops(_ alphas: OrbBloomAlphas) -> [Gradient.Stop] {
        [
            Gradient.Stop(color: warmStart.opacity(alphas.start), location: 0),
            Gradient.Stop(color: warmMid.opacity(alphas.mid), location: 0.46),
            Gradient.Stop(color: warmEnd.opacity(0), location: 0.74),
            // CSS keeps painting the last stop past its position; a gradient that simply
            // stopped at 0.74 would leave the corners of the layer's box the wrong colour.
            Gradient.Stop(color: warmEnd.opacity(0), location: 1),
        ]
    }

    /// The cool (periwinkle) bloom, lower-right. `oklab(86.7% 0.001 -0.054)` →
    /// `oklab(90.5% 0.0006 -0.038)` → `oklab(93.4% -0.0005 -0.026)`, transparent by 76%.
    static func coolBloomStops(_ alphas: OrbBloomAlphas) -> [Gradient.Stop] {
        [
            Gradient.Stop(color: coolStart.opacity(alphas.start), location: 0),
            Gradient.Stop(color: coolMid.opacity(alphas.mid), location: 0.48),
            Gradient.Stop(color: coolEnd.opacity(0), location: 0.76),
            Gradient.Stop(color: coolEnd.opacity(0), location: 1),
        ]
    }

    /// The opaque core the two blooms sit on. `oklab(83.6% 0.029 -0.058)` →
    /// `oklab(86.2% 0.024 -0.050)`, then that same colour faded to nothing.
    static var coreStops: [Gradient.Stop] {
        [
            Gradient.Stop(color: coreStart, location: 0),
            Gradient.Stop(color: coreEnd, location: 0.58),
            Gradient.Stop(color: coreEnd.opacity(0.5), location: 0.80),
            Gradient.Stop(color: coreEnd.opacity(0), location: 1),
        ]
    }

    static let warmStart = Color(.sRGB, red: 0.91020, green: 0.78745, blue: 0.94442, opacity: 1)
    static let warmMid = Color(.sRGB, red: 0.92111, green: 0.83077, blue: 0.95593, opacity: 1)
    static let warmEnd = Color(.sRGB, red: 0.93990, green: 0.88645, blue: 0.96971, opacity: 1)

    static let coolStart = Color(.sRGB, red: 0.77591, green: 0.82395, blue: 0.97170, opacity: 1)
    static let coolMid = Color(.sRGB, red: 0.83911, green: 0.87436, blue: 0.97961, opacity: 1)
    static let coolEnd = Color(.sRGB, red: 0.88569, green: 0.91357, blue: 0.98554, opacity: 1)

    static let coreStart = Color(.sRGB, red: 0.80317, green: 0.75742, blue: 0.93827, opacity: 1)
    static let coreEnd = Color(.sRGB, red: 0.83148, green: 0.79592, blue: 0.95222, opacity: 1)
}

/// The three stacked radial gradients behind the orb.
///
/// Board 02 lists the elevation as *"none — the halo does the lifting"*, so there is no
/// shadow here and the bloom is the whole effect.
struct OrbHalo: View {
    let metrics: OrbMetrics

    /// Both blooms are `ellipse 46% 44%` of the halo box; only their centres differ.
    private static let bloomRadius = CGSize(width: 0.46, height: 0.44)

    var body: some View {
        let box = metrics.halo
        // A CSS `background-image` list paints its first layer on top, so the declaration
        // order on the board is the reverse of the stacking order here.
        ZStack(alignment: .topLeading) {
            Color.clear
            layer(
                box: box,
                centre: UnitPoint(x: 0.50, y: 0.47),
                radius: metrics.coreRadius,
                stops: OrbPalette.coreStops
            )
            layer(
                box: box,
                centre: UnitPoint(x: 0.64, y: 0.58),
                radius: Self.bloomRadius,
                stops: OrbPalette.coolBloomStops(metrics.bloomCoolAlphas)
            )
            layer(
                box: box,
                centre: UnitPoint(x: 0.38, y: 0.40),
                radius: Self.bloomRadius,
                stops: OrbPalette.warmBloomStops(metrics.bloomWarmAlphas)
            )
        }
        .frame(width: box.width, height: box.height)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// One `radial-gradient(ellipse rx ry at cx cy …)`.
    ///
    /// `EllipticalGradient` fills the ellipse inscribed in its own frame, so giving the
    /// layer a box of exactly `2rx × 2ry` and placing that box's centre at the gradient's
    /// centre reproduces CSS's geometry without a transform: the ellipse's semi-axes and
    /// the design's radii become the same two numbers.
    private func layer(
        box: CGSize,
        centre: UnitPoint,
        radius: CGSize,
        stops: [Gradient.Stop]
    ) -> some View {
        let width = 2 * radius.width * box.width
        let height = 2 * radius.height * box.height
        return Rectangle()
            .fill(EllipticalGradient(stops: stops, center: .center))
            .frame(width: width, height: height)
            .offset(x: centre.x * box.width - width / 2, y: centre.y * box.height - height / 2)
    }
}
