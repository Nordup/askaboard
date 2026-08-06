import SwiftUI

/// The tutor's identity mark, at the four sizes the design draws it.
///
/// Board 02, verbatim: *"The orb is sized by free space, not by layout slot. While the
/// thread still has whitespace it stays large and does the greeting; once messages fill the
/// panel it shrinks to the 46pt thread size and becomes a marker above the composer.
/// **Treat the four sizes as one adaptive component driven by remaining space — not as four
/// separate assets to pick between.**"*
///
/// Which the halo makes literal: its two bloom gradients change alpha between hero and the
/// rest, and its core ellipse changes proportion at every size, so exporting four PNGs and
/// scaling one of them would be wrong in three places at once.
enum OrbSize: String, CaseIterable, Sendable {
    /// Screen 07's greeting. The only variant with a mouth.
    case hero
    /// Screen 05's panel header.
    case panel
    /// Screen 06's collapsed dock.
    case dock
    /// Screen 08's thinking indicator at the tail of the thread.
    case thread
}

struct OrbMetrics: Equatable, Sendable {
    let frame: CGSize
    /// A squashed pill, not a circle — the radius is `--radius-full` on a non-square box.
    let body: CGSize
    let eye: CGFloat
    let eyeGap: CGFloat
    /// The eye row's top edge within the body.
    let eyeTop: CGFloat
    let halo: CGSize
    /// The halo's `left` / `top` relative to the frame's origin. It is roughly 2× the frame
    /// and is not clipped.
    let haloOrigin: CGPoint
    /// Opacity of the first and second stop of each bloom gradient. Hero blooms harder.
    let bloomWarmAlphas: OrbBloomAlphas
    let bloomCoolAlphas: OrbBloomAlphas
    /// The core ellipse's radii as a fraction of the halo box. Differs at every size.
    let coreRadius: CGSize
    /// The smile's top-left within the body, or `nil` where the design draws no mouth.
    let smileOrigin: CGPoint?

    /// The halo is placed by its edges in the design and by its centre in SwiftUI, so the
    /// conversion lives here rather than in the view. It comes out non-zero only for hero
    /// and panel, whose halos sit 7 and 4 points above the frame's centre.
    var haloCentreOffset: CGSize {
        CGSize(
            width: haloOrigin.x + halo.width / 2 - frame.width / 2,
            height: haloOrigin.y + halo.height / 2 - frame.height / 2
        )
    }
}

struct OrbBloomAlphas: Equatable, Sendable {
    let start: Double
    let mid: Double
}

extension OrbSize {
    var metrics: OrbMetrics {
        switch self {
        case .hero:
            // The hero's eyes are placed absolutely (left 20 / 53, top 22 in an 84 × 66
            // body) because the smile takes the lower half; the gap below is what that
            // spacing works out to, 53 − 20 − 11.
            OrbMetrics(
                frame: CGSize(width: 150, height: 142),
                body: CGSize(width: 84, height: 66),
                eye: 11,
                eyeGap: 22,
                eyeTop: 22,
                halo: CGSize(width: 296, height: 282),
                haloOrigin: CGPoint(x: -73, y: -77),
                bloomWarmAlphas: OrbBloomAlphas(start: 0.78, mid: 0.36),
                bloomCoolAlphas: OrbBloomAlphas(start: 0.74, mid: 0.32),
                coreRadius: CGSize(width: 0.28, height: 0.27),
                smileOrigin: CGPoint(x: 33, y: 40)
            )
        case .panel:
            // `padding-top: 5` with the eyes centred in what is left: 5 + (42 − 5 − 7)/2.
            OrbMetrics(
                frame: CGSize(width: 96, height: 90),
                body: CGSize(width: 54, height: 42),
                eye: 7,
                eyeGap: 18,
                eyeTop: 20,
                halo: CGSize(width: 190, height: 180),
                haloOrigin: CGPoint(x: -47, y: -49),
                bloomWarmAlphas: OrbBloomAlphas(start: 0.75, mid: 0.34),
                bloomCoolAlphas: OrbBloomAlphas(start: 0.70, mid: 0.30),
                coreRadius: CGSize(width: 0.27, height: 0.26),
                smileOrigin: nil
            )
        case .dock:
            // `padding-top: 4` → 4 + (34 − 4 − 5.5)/2.
            OrbMetrics(
                frame: CGSize(width: 64, height: 64),
                body: CGSize(width: 44, height: 34),
                eye: 5.5,
                eyeGap: 14,
                eyeTop: 16.25,
                halo: CGSize(width: 130, height: 128),
                haloOrigin: CGPoint(x: -33, y: -32),
                bloomWarmAlphas: OrbBloomAlphas(start: 0.75, mid: 0.34),
                bloomCoolAlphas: OrbBloomAlphas(start: 0.70, mid: 0.30),
                coreRadius: CGSize(width: 0.29, height: 0.28),
                smileOrigin: nil
            )
        case .thread:
            // `padding-top: 3` → 3 + (25 − 3 − 4)/2.
            OrbMetrics(
                frame: CGSize(width: 46, height: 46),
                body: CGSize(width: 32, height: 25),
                eye: 4,
                eyeGap: 10,
                eyeTop: 12,
                halo: CGSize(width: 94, height: 92),
                haloOrigin: CGPoint(x: -24, y: -23),
                bloomWarmAlphas: OrbBloomAlphas(start: 0.75, mid: 0.34),
                bloomCoolAlphas: OrbBloomAlphas(start: 0.70, mid: 0.30),
                coreRadius: CGSize(width: 0.29, height: 0.28),
                smileOrigin: nil
            )
        }
    }
}

/// The orb.
///
/// Decorative throughout: it is the tutor's face, not a control, so the button that happens
/// to contain it in the collapsed dock carries the label and this carries none.
struct Orb: View {
    private let size: OrbSize

    init(_ size: OrbSize) {
        self.size = size
    }

    var body: some View {
        let metrics = size.metrics
        return orbBody(metrics)
            .frame(width: metrics.frame.width, height: metrics.frame.height)
            // A background, not a `ZStack` layer: the halo is roughly twice the frame and
            // the design does not clip it, so it has to draw outside the layout box without
            // enlarging it.
            .background {
                OrbHalo(metrics: metrics)
                    .offset(
                        x: metrics.haloCentreOffset.width,
                        y: metrics.haloCentreOffset.height
                    )
            }
            .accessibilityHidden(true)
    }

    private func orbBody(_ metrics: OrbMetrics) -> some View {
        Capsule()
            .fill(OrbPalette.bodyGradient)
            .frame(width: metrics.body.width, height: metrics.body.height)
            .overlay(alignment: .top) {
                HStack(spacing: metrics.eyeGap) {
                    eye(metrics.eye)
                    eye(metrics.eye)
                }
                .padding(.top, metrics.eyeTop)
            }
            .overlay(alignment: .topLeading) {
                if let origin = metrics.smileOrigin {
                    OrbSmile()
                        .stroke(
                            DS.Color.surface,
                            style: StrokeStyle(lineWidth: OrbSmile.strokeWidth, lineCap: .round)
                        )
                        .frame(width: OrbSmile.viewBox.width, height: OrbSmile.viewBox.height)
                        .offset(x: origin.x, y: origin.y)
                }
            }
    }

    /// `#FFFFFF` in the design and untokenised there; `DS.Color.surface` is the same white
    /// with a name, which is the substitution `IconView` already makes for `composer/send`.
    private func eye(_ diameter: CGFloat) -> some View {
        Circle().fill(DS.Color.surface).frame(width: diameter, height: diameter)
    }
}

/// The hero's mouth, at the one size the design draws it.
struct OrbSmile: Shape {
    static let viewBox = CGSize(width: 18, height: 10)
    static let strokeWidth: CGFloat = 2.4
    /// The design's verbatim `d`, kept as the string so it can be diffed against the board.
    static let pathData = "M1.6 1.6C4 6.4 14 6.4 16.4 1.6"

    func path(in rect: CGRect) -> Path {
        guard Self.viewBox.width > 0, Self.viewBox.height > 0 else { return Path() }
        let scale = min(rect.width / Self.viewBox.width, rect.height / Self.viewBox.height)
        let transform = CGAffineTransform(
            translationX: rect.minX + (rect.width - Self.viewBox.width * scale) / 2,
            y: rect.minY + (rect.height - Self.viewBox.height * scale) / 2
        )
        .scaledBy(x: scale, y: scale)
        return SVGPath.path(from: Self.pathData).applying(transform)
    }
}

#if DEBUG
#Preview("Orb") {
    HStack(spacing: 120) {
        ForEach(OrbSize.allCases, id: \.self) { Orb($0) }
    }
    .padding(120)
    .background(DS.Color.surface)
}
#endif
