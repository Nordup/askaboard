import SwiftUI

/// The dashed rectangle a student drags around the work they want looked at.
///
/// **Not from the design.** Board 05 open question 7: *"There is no marquee, lasso
/// path, handle, or highlight anywhere."* So the whole of this view is a decision,
/// and it is made as small as it can be by borrowing rather than inventing: the
/// stroke is `ui/selection-marker`'s own dash — the dashed square already used for
/// `btn/select` and for the composer's attachment glyph — scaled to the size it is
/// drawn at, in `--color-brand`, over `--color-brand-tint` at the opacity that
/// leaves handwriting underneath plainly readable. Nothing here is a new shape or
/// a new colour; it is the product's existing "a region of the board" mark, drawn
/// at board scale.
///
/// It draws and reports in the canvas's own **view** coordinates, because that is
/// all a drag on a view can know. Storing them is a different question, and the
/// answer is no: `BoardScreen.attachBoardSelection(viewRegion:)` converts to the
/// drawing's coordinates on the way in and back again on the way out, so a region
/// stays glued to the ink it was drawn around rather than to the window. See
/// `BoardSelection`.
struct BoardSelectionMarquee: View {
    /// The region already picked, if any, converted back into this view's
    /// coordinates by the caller. Drawn while it stands so the student can see
    /// what they are about to send.
    let attachedRegion: CGRect?
    /// A finished drag that was big enough to be a region, in this view's coordinates.
    let onSelect: (CGRect) -> Void

    /// Where the current drag started, in this view's coordinates. `DragGesture`
    /// reports `startLocation` on every change, so this exists only to know
    /// whether a drag is in progress at all.
    @State private var dragStart: CGPoint?
    @State private var dragCurrent: CGPoint?

    /// `--radius-sm`, the smallest the product has. A marquee is a temporary mark
    /// over a student's work, so it takes the least rounded corner rather than the
    /// board's own 28.
    private static let cornerRadius = DS.Radius.sm

    /// The stroke width. `ui/selection-marker` draws 2 at 24pt; at board scale the
    /// same 2 reads as a hairline over handwriting, so it is doubled once. Its dash
    /// keeps the glyph's own 4.6 : 3.9 ratio, scaled to match.
    private static let strokeWidth: CGFloat = 4
    private static let dash: [CGFloat] = [9.2, 7.8]

    /// **Not from the design.** The fill has to say "this region" without hiding
    /// the working it is drawn over — the same requirement `BoardInk.highlighterAlpha`
    /// answers for the highlighter, and it takes the same answer for the same reason.
    private static let fillOpacity: CGFloat = 0.3

    /// The rectangle on screen right now: the live drag while one is happening,
    /// otherwise whatever is attached.
    private var visibleRegion: CGRect? {
        if let dragStart, let dragCurrent {
            return BoardMarquee.region(from: dragStart, to: dragCurrent)
        }
        return attachedRegion
    }

    var body: some View {
        // `Color.clear` rather than a shape: the marquee has to take the whole
        // board's touches while it is armed, which is what keeps the pencil off
        // the ink without the canvas having to swap its tool.
        Color.clear
            .contentShape(Rectangle())
            .overlay(alignment: .topLeading) { mark }
            .gesture(drag)
            .accessibilityLabel("Board selection")
            .accessibilityHint("Drag to pick the area of your work to send to the tutor")
    }

    @ViewBuilder
    private var mark: some View {
        if let region = visibleRegion {
            let shape = RoundedRectangle(cornerRadius: Self.cornerRadius)
            shape
                .fill(DS.Color.brandTint.opacity(Self.fillOpacity))
                .overlay {
                    shape.strokeBorder(
                        DS.Color.brand,
                        style: StrokeStyle(
                            lineWidth: Self.strokeWidth,
                            lineCap: .round,
                            dash: Self.dash
                        )
                    )
                }
                .frame(width: region.width, height: region.height)
                .offset(x: region.minX, y: region.minY)
                .allowsHitTesting(false)
        }
    }

    /// `minimumDistance: 0` so the mark appears from the first movement rather
    /// than after SwiftUI's default 10pt — a selection that only starts drawing
    /// once you have already moved reads as a dropped touch.
    private var drag: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                dragStart = value.startLocation
                dragCurrent = value.location
            }
            .onEnded { value in
                dragStart = nil
                dragCurrent = nil
                // A drag too small to be a region leaves the marquee armed and
                // whatever was attached untouched, so a slipped tap costs nothing.
                if let region = BoardMarquee.committedRegion(from: value.startLocation, to: value.location) {
                    onSelect(region)
                }
            }
    }
}

#if DEBUG
#Preview("Board selection marquee") {
    BoardSelectionMarquee(
        attachedRegion: CGRect(x: 60, y: 40, width: 260, height: 180),
        onSelect: { _ in }
    )
    .frame(width: 400, height: 300)
    .background(DS.Color.surfaceCanvas)
}
#endif
