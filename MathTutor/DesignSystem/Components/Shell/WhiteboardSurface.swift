import SwiftUI

enum WhiteboardMetrics {
    static let cornerRadius = DS.Radius.xxxl
}

/// The drawing surface's card.
///
/// Board 02: *"The board keeps a constant 936pt height and a constant top origin in
/// every state; only its width changes when the tutor docks or collapses. That is what lets
/// the ink layer stay put instead of reflowing — the board is resized from one edge,
/// never re-laid-out."*
///
/// **Which edge is the leading one now.** The redesign puts the tutor and the rail before the
/// board in the row, so docking and collapsing move the card's left edge while its right edge
/// stays on the screen's trailing inset. Nothing here changes for that: the card is still one
/// height, one width per state, and the ink still rides with it rather than reflowing inside
/// it. The caller supplies both the width and the origin — see `BoardScreen.boardX`.
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
    private let liveCanvasSurround: Color?
    private let content: Content

    /// - Parameter liveCanvasOver: the colour the card sits on, and **only** for a
    ///   `content` that is a live `PKCanvasView`. See `body`. `nil` — the default,
    ///   and what every specimen uses — draws the paper here and clips the content
    ///   to the card, exactly as this component always did.
    init(
        width: CGFloat,
        height: CGFloat,
        liveCanvasOver liveCanvasSurround: Color? = nil,
        @ViewBuilder content: () -> Content
    ) {
        // Clamped rather than trusted: a `.frame` with a negative side is a runtime layout
        // error, and the one place these can go negative — a window narrower than the lanes
        // the design reserves — is exactly the case this component was made responsive for.
        self.width = max(0, width)
        self.height = max(0, height)
        self.liveCanvasSurround = liveCanvasSurround
        self.content = content()
    }

    /// **Nothing is allowed to mask or blend the live canvas.**
    ///
    /// PencilKit keeps the stroke under the pencil on its own high-frequency path,
    /// and that path needs a plain opaque layer it can present. Both of the things
    /// this component used to do to the canvas took that away: a `clipShape` for
    /// the 28pt corners put it inside a mask, which is an offscreen buffer, and a
    /// `--color-surface-canvas` fill plus a `DotGrid` underneath a transparent
    /// canvas gave every frame of every stroke two layers to blend back over. The
    /// symptom of losing it is a stroke that arrives in segments instead of
    /// following the tip.
    ///
    /// So when the content *is* that canvas, it paints the paper (`BoardPaper`)
    /// and this draws the card's corners **on top of it** — four opaque wedges in
    /// the colour the card sits on, which is what `liveCanvasOver` is. The pixels
    /// are the ones a rounded clip would produce; the canvas underneath is left
    /// unmasked. The canvas is its own rectangular clip already — `UIScrollView`
    /// sets `clipsToBounds` — so the corners are all that was ever missing.
    ///
    /// The cost of the wedges is that they are painted in a colour rather than cut
    /// out, so a caller that puts the board on something other than a flat fill
    /// would see them. `BoardScreen` is the only caller that passes one, and the
    /// board sits on `--color-surface-screen` in every state that draws it.
    var body: some View {
        let card = RoundedRectangle(cornerRadius: WhiteboardMetrics.cornerRadius)
        ZStack {
            // The shadow is cast by an opaque copy of the card rather than by the
            // stack's own live pixels. Visually identical — the card is an opaque
            // fill edge to edge — but derived from the content it would be a
            // function of live ink, and Core Animation would re-derive the board's
            // shadow on every frame a pencil moved.
            card.fill(DS.Color.surfaceCanvas).elevation(.canvas)

            if let liveCanvasSurround {
                content
                CardCorners(cornerRadius: WhiteboardMetrics.cornerRadius)
                    .fill(liveCanvasSurround, style: FillStyle(eoFill: true))
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            } else {
                DotGrid().clipShape(card)
                content.clipShape(card)
            }
        }
        .frame(width: width, height: height)
    }
}

/// The four corners a rounded card cuts out of its bounding box, as a fillable
/// shape: the full rectangle with the rounded rectangle punched out of it under
/// an even-odd fill.
///
/// Circular corners, not `.continuous`, for the reason `ToolRail` gives: the
/// design's radius is a CSS `border-radius`, which is a circular arc.
struct CardCorners: Shape {
    let cornerRadius: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        path.addPath(Path(roundedRect: rect, cornerRadius: cornerRadius, style: .circular))
        return path
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
