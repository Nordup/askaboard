import SwiftUI

/// The regions the tutor looked at, attached to the turn it looked for.
///
/// Board 14. **Not from the original design** — board 05 open question 7 records
/// that the design never drew the tutor looking at anything, and screen 08's
/// board is pixel-identical to screen 05's despite a selection having been sent.
///
/// No caption and no card, which is the one decision the board is emphatic
/// about. The tutor already speaks as bare text in this lane, so the views sit
/// in it the same way: `gap` to the reply beneath them, and the thread's usual
/// `--space-message-gap` above. They read as one turn rather than an attachment
/// bolted to one. A caption was drawn and removed — the lane already says who
/// looked, so naming it was noise.
enum BoardViewsMetrics {
    /// **Not a design token.** One thumbnail, and the same one at every count —
    /// a single view is one of these rather than a full-width special case, so
    /// there is one size to implement and one rhythm to read.
    static let thumbnail = CGSize(width: 116, height: 69)
    /// Off the 4pt scale on purpose: `116 + 10 + 116 = 242` sits left inside the
    /// 301pt content column rather than stretching to fill it, which is what
    /// makes these read as attachments instead of a block.
    static let gap: CGFloat = 10
    /// The step from the views to the reply they belong to. Tighter than
    /// `--space-message-gap`, because that gap separates *turns* and this one
    /// joins a turn to itself.
    static let replyGap: CGFloat = 8
    static let cornerRadius = DS.Radius.sm

    /// How many fit across a column before the grid wraps.
    static func columns(in width: CGFloat) -> Int {
        max(1, Int((width + gap) / (thumbnail.width + gap)))
    }
}

struct BoardViewsRow: View {
    let views: [BoardView]
    /// Full width of the lane the thread is drawn in — the panel's 301, or the
    /// full-screen column's 740. Only the wrap point depends on it.
    let width: CGFloat
    var onOpen: ((BoardView) -> Void)?

    var body: some View {
        let columns = BoardViewsMetrics.columns(in: width)
        VStack(alignment: .leading, spacing: BoardViewsMetrics.gap) {
            ForEach(Array(rows(of: columns).enumerated()), id: \.offset) { _, row in
                HStack(spacing: BoardViewsMetrics.gap) {
                    ForEach(row) { view in
                        BoardViewThumbnail(view: view, onOpen: onOpen)
                    }
                }
            }
        }
        .frame(width: width, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(views.count == 1
            ? "The tutor looked at one region of the board"
            : "The tutor looked at \(views.count) regions of the board")
    }

    /// Chunked rather than laid out in a `Grid`, because the last row must sit
    /// left with its real width rather than being stretched to fill the column.
    private func rows(of columns: Int) -> [[BoardView]] {
        stride(from: 0, to: views.count, by: columns).map { start in
            Array(views[start..<min(start + columns, views.count)])
        }
    }
}

struct BoardViewThumbnail: View {
    let view: BoardView
    var onOpen: ((BoardView) -> Void)?

    var body: some View {
        Button { onOpen?(view) } label: {
            image
                .frame(
                    width: BoardViewsMetrics.thumbnail.width,
                    height: BoardViewsMetrics.thumbnail.height
                )
                .background(DS.Color.surfaceCanvas)
                .clipShape(RoundedRectangle(cornerRadius: BoardViewsMetrics.cornerRadius))
                // **A deliberate exception to board 01 rule 1**, which says the
                // rail's hairline is the only border in the product. A board
                // crop is `--color-surface-canvas` #FAFAFA sitting on
                // `--color-surface-panel` #FCFCFC: two parts in 255, which no
                // display resolves. Without an edge the thumbnails do not read
                // as objects at all — they read as ink floating on the panel.
                .overlay {
                    RoundedRectangle(cornerRadius: BoardViewsMetrics.cornerRadius)
                        .strokeBorder(DS.Color.shadow.opacity(0.04), lineWidth: 1)
                }
                .elevation(.control)
        }
        .buttonStyle(.plain)
        .disabled(onOpen == nil)
        .accessibilityLabel("Board view. \(view.detail)")
    }

    @ViewBuilder
    private var image: some View {
        if let uiImage = UIImage(data: view.imageData) {
            Image(uiImage: uiImage)
                .resizable()
                // `fit`, not `fill`: a crop cut off at the edge to fill a fixed
                // box is exactly the misreading these exist to let the learner
                // catch. Better letterboxed and whole.
                .aspectRatio(contentMode: .fit)
        } else {
            // Unreachable in practice — the device made these bytes itself a
            // moment ago — but a blank tile beats a crash on a corrupt PNG.
            Color.clear
        }
    }
}

#if DEBUG
#Preview("Board views") {
    let png = UIGraphicsImageRenderer(size: CGSize(width: 232, height: 138)).image { context in
        UIColor.white.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 232, height: 138))
        UIColor.black.setStroke()
        let path = UIBezierPath()
        path.move(to: CGPoint(x: 30, y: 60))
        path.addCurve(to: CGPoint(x: 200, y: 70), controlPoint1: .init(x: 90, y: 20), controlPoint2: .init(x: 140, y: 110))
        path.lineWidth = 4
        path.stroke()
    }.pngData()!

    return VStack(alignment: .leading, spacing: 40) {
        BoardViewsRow(views: [BoardView(imageData: png, detail: "Showing the whole board.")], width: 301)
        BoardViewsRow(views: (0..<3).map { _ in BoardView(imageData: png, detail: "A region.") }, width: 301)
    }
    .padding(40)
    .background(DS.Color.surfacePanel)
}
#endif
