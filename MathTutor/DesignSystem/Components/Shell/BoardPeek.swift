import SwiftUI

enum BoardPeekMetrics {
    /// **68 — no token.** Board 02 states the peek's size as "68 × 936 — no token", and only
    /// the 936 was a screen number: the 68 is the silhouette's own tab width, drawn into the
    /// path's arcs, and it does not vary with the window.
    static let width: CGFloat = 68
    /// The height the design drew, kept as the shape's reference so a specimen and the
    /// pixel diff still have the authored silhouette to compare against.
    static let referenceHeight: CGFloat = 936
    /// `Board hinge icon`, absolute within the peek.
    static let hingeOrigin = CGPoint(x: 23, y: 22)

    // MARK: - Edge shadow

    /// The design's fake shadow is `left 3, top 2`, and a real shadow takes the same
    /// offsets.
    static let shadowOffset = CGSize(width: 3, height: 2)
    /// **`filter: blur(5px)`, not a `box-shadow` blur.** The two are different units: a CSS
    /// filter blur states the Gaussian's standard deviation directly, while a box-shadow's
    /// blur is twice it — which is why `Elevation.Layer` halves its own values and this does
    /// not. Halving here would draw the peek's edge at half the softness the design has.
    static let shadowRadius: CGFloat = 5
    static let shadowOpacity: Double = 0.11
}

/// The silhouette of the board when the tutor is full-screen.
///
/// Board 02: *"The silhouette is a single concave-fillet path, not a rounded rectangle: the
/// notch is what reads as a hinge."* A 68-wide tab down to `y = 64` holding the hinge icon,
/// then an 18pt concave fillet in to a 28-wide strip that runs to the bottom.
///
/// **The path is re-authored at the height it is drawn at, not scaled to it.** Every arc in
/// this `d` has `r = 18`, and a non-uniform scale to a shorter band would squash exactly
/// those arcs — the hinge notch is the one feature the board calls load-bearing, and a
/// flattened fillet is the tell. The only two numbers in the string that describe the band
/// rather than the shape are the strip's end and the box's bottom, so those two are the only
/// two that move; the tab, the concave fillet and every radius stay authored.
///
/// **Why only the strip stretches, and never the tab.** The tab is not decoration. It carries
/// the `board/hinge` glyph at a fixed local offset — `BoardPeekMetrics.hingeOrigin` (23, 22) —
/// and it is the touch target for returning to the board, so scaling it with the screen would
/// scale a tap target and an icon that are both specified at fixed sizes elsewhere: the icon
/// by `IconView`, the target by the size a finger is. Proportional scaling would also slide the
/// glyph away from its authored position inside the tab, which means the icon's placement would
/// have to be redrawn as a function of band height rather than read off the board. The tab is
/// top-anchored for the same reason it is fixed: a reach-back affordance belongs at the top,
/// where the hand that dismissed the board goes looking for it, not floating at a fraction of a
/// band whose height is a property of the device. So the straight run between the two authored
/// 18pt fillets is the only part with any give in it, and it absorbs the whole difference.
struct BoardPeekShape: Shape {
    /// The bottom fillet's radius, and so the gap between the strip's end and the box's
    /// bottom: the design's own `V918 … 10,936` is this relationship at 936.
    static let bottomFillet: CGFloat = 18
    /// Below this the strip has no length left and the bottom fillet would start inside the
    /// hinge notch. It is a floor, not a size — no real band comes near it.
    static let minimumHeight: CGFloat = 82 + bottomFillet

    /// The design's verbatim `d`, with the two band numbers substituted. At
    /// `BoardPeekMetrics.referenceHeight` this reproduces the authored string character for
    /// character: `V918 A18,18 0 0 1 10,936`.
    static func pathData(height: CGFloat) -> String {
        let bottom = max(height, minimumHeight)
        return "M0,0 H50 A18,18 0 0 1 68,18 V46 A18,18 0 0 1 50,64 H46 "
            + "A18,18 0 0 0 28,82 V\(number(bottom - bottomFillet)) "
            + "A18,18 0 0 1 10,\(number(bottom)) H0 Z"
    }

    /// The design's `d`, as authored.
    static var pathData: String { pathData(height: BoardPeekMetrics.referenceHeight) }

    func path(in rect: CGRect) -> Path {
        guard rect.width > 0, rect.height > 0 else { return Path() }
        // Only the width is ever scaled, and only if a caller frames the peek at something
        // other than its own 68: the height is built into the path above rather than scaled
        // into it, which is what keeps the fillets circular at every band height.
        let transform = CGAffineTransform(translationX: rect.minX, y: rect.minY)
            .scaledBy(x: rect.width / BoardPeekMetrics.width, y: 1)
        return SVGPath.path(from: Self.pathData(height: rect.height)).applying(transform)
    }

    /// `918.0` and `918` parse the same, but only one of them diffs against the board.
    private static func number(_ value: CGFloat) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%g", value)
    }
}

/// The 68pt sliver of board that stays on screen behind the full-screen tutor.
///
/// Board 02: *"In the full-screen tutor the board is not gone, it is hinged off-screen — a
/// 68pt sliver keeps the board present so returning to it feels like closing a door, not
/// loading a screen."*
///
/// The design's edge shadow is a blurred duplicate of the silhouette, because Paper drops
/// `box-shadow` on SVG paths. Board 01 rule 17 says outright to *"port the board peek's
/// shadow to a real shadow and delete the duplicated blurred path"*, so that is what this
/// does — the duplicate is gone and `.shadow` carries the same offset, blur and opacity.
struct BoardPeek: View {
    /// The band the peek spans — the same content height the board card is given, since the
    /// peek *is* the board's edge and the two have to end level.
    private let height: CGFloat
    /// The peek is the only board affordance on screen 07 and is what returns you to it.
    private let onTap: () -> Void

    init(height: CGFloat, onTap: @escaping () -> Void) {
        self.height = max(BoardPeekShape.minimumHeight, height)
        self.onTap = onTap
    }

    var body: some View {
        BoardPeekShape()
            .fill(DS.Color.surfaceCanvas)
            // Sized before anything is layered on it, so the grid and the hinge icon are
            // placed against the real 68 × band box rather than against whatever the parent
            // happened to offer.
            .frame(width: BoardPeekMetrics.width, height: height)
            // The grid is drawn full-bleed and clipped to the silhouette, which is how the
            // design's own "columns past x = 23.9 stop once the shape necks in" falls out
            // rather than being special-cased.
            .overlay { DotGrid().clipShape(BoardPeekShape()) }
            .overlay(alignment: .topLeading) {
                IconView(.boardHinge, tint: DS.Color.ink)
                    .offset(x: BoardPeekMetrics.hingeOrigin.x, y: BoardPeekMetrics.hingeOrigin.y)
            }
            .shadow(
                color: DS.Color.shadow.opacity(BoardPeekMetrics.shadowOpacity),
                radius: BoardPeekMetrics.shadowRadius,
                x: BoardPeekMetrics.shadowOffset.width,
                y: BoardPeekMetrics.shadowOffset.height
            )
            // The silhouette, not its bounding box: the notch is 40pt of empty screen that
            // belongs to the tutor behind it, and a rectangular hit area would swallow taps
            // meant for the panel.
            .contentShape(BoardPeekShape())
            .onTapGesture(perform: onTap)
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Back to the board")
    }
}

#if DEBUG
#Preview("Board peek") {
    BoardPeek(height: BoardPeekMetrics.referenceHeight, onTap: {})
        .padding(.leading, 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DS.Color.surface)
}
#endif
