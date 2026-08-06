import SwiftUI

enum WhiteboardMetrics {
    static let cornerRadius = DS.Radius.xxxl
}

/// The drawing surface's card.
///
/// Board 02: *"The board keeps a constant 936pt height and a constant top-left origin in
/// every state; only its width changes when the tutor docks or collapses. That is what lets
/// the ink layer stay put instead of reflowing — the board is resized from the right edge,
/// never re-laid-out."*
///
/// **Both numbers are now given rather than known.** 936 was the content band of one 1032pt
/// screen and 863/1224 were what one 1376pt screen had left over; on a 768pt iPad the same
/// design rule produces different numbers, and a card that carried the old ones put a third
/// of itself off-screen. The board's actual rule — one height for every state, one origin,
/// only the width changing between docked and collapsed — is the caller's to hold, and it
/// still holds when the caller derives both from the window.
///
/// The ink itself arrives as `content` so this file never imports PencilKit: a design-system
/// component that knew about `PKCanvasView` could not be rendered in a specimen, and the
/// board's own note that the canvas is "not a live canvas" on screen 07 is a reminder that
/// the card and the ink are separable things.
struct WhiteboardSurface<Content: View>: View {
    private let width: CGFloat
    private let height: CGFloat
    private let content: Content

    init(width: CGFloat, height: CGFloat, @ViewBuilder content: () -> Content) {
        // Clamped rather than trusted: a `.frame` with a negative side is a runtime layout
        // error, and the one place these can go negative — a window narrower than the lanes
        // the design reserves — is exactly the case this component was made responsive for.
        self.width = max(0, width)
        self.height = max(0, height)
        self.content = content()
    }

    var body: some View {
        ZStack {
            DS.Color.surfaceCanvas
            DotGrid()
            content
        }
        .frame(width: width, height: height)
        // `overflow: clip` on the board is what stops ink and grid escaping the 28pt
        // corners, and clipping before the shadow is what keeps the shadow the card's
        // silhouette rather than the ink's.
        .clipShape(RoundedRectangle(cornerRadius: WhiteboardMetrics.cornerRadius))
        .elevation(.canvas)
    }
}

/// The canvas background texture, drawn rather than tiled from an asset.
///
/// Board 02 measures the pitch at **23.9 × 24.5** — not square, and not 24 — and then warns
/// about the export: *"background-size is 100%, so the asset STRETCHES with the board · both
/// boards ship a separate SVG at their own width to keep the pitch true."* Drawing the dots
/// removes that whole class of bug: one view is correct at 863 wide, at 1224, and at the
/// 51pt column inside the board peek, because the pitch is never a function of the width.
struct DotGrid: View {
    /// No token, and deliberately unequal.
    static let pitch = CGSize(width: 23.9, height: 24.5)
    static let dotRadius: CGFloat = 1.4
    /// `#F1F1F1` — no token. Board 02 records it as *"close to but not
    /// `var(--color-divider)` `#EFEFEF`"*, so it is transcribed rather than substituted.
    static let dotColor = Color(.sRGB, red: 241 / 255, green: 241 / 255, blue: 241 / 255, opacity: 1)

    var body: some View {
        Canvas(opaque: false, rendersAsynchronously: false) { context, size in
            let diameter = Self.dotRadius * 2
            var dots = Path()
            var y: CGFloat = 0
            while y < size.height {
                var x: CGFloat = 0
                while x < size.width {
                    dots.addEllipse(in: CGRect(x: x, y: y, width: diameter, height: diameter))
                    x += Self.pitch.width
                }
                y += Self.pitch.height
            }
            // One fill for the whole field: the design's tile is a single `<circle>` in a
            // `<pattern>`, and thousands of separate fill calls is the only way this becomes
            // slow enough to notice on a 1224pt board.
            context.fill(dots, with: .color(Self.dotColor))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

#if DEBUG
#Preview("Whiteboard surface") {
    WhiteboardSurface(width: 400, height: 300) { Color.clear }
        .padding(44)
        .background(DS.Color.surfaceScreen)
}
#endif
