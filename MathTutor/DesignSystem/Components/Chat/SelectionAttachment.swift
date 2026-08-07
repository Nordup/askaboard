import SwiftUI

/// The geometry of a tinted card tucked *behind* a rounded shape so only a band of it
/// shows — the composer's attached selection (screen 05) and a sent message carrying one
/// (screen 08) are the same idiom at two widths and two radii.
///
/// Board 03 states the rule the whole thing turns on: *"A pill's top edge is only straight
/// between its corner radii. At 301 wide with a 29 radius, that straight run is
/// 301 − 2 × 29 = 243pt. Anything full-width sitting behind the pill must extend past
/// those curves, or a notch of background shows through at both corners."* And the law it
/// derives from that:
///
/// ```
/// cardHeight   = visibleBand + radiusOfShapeOnTop
/// cardTopRadii = radiusOfShapeOnTop
/// pillTop      = visibleBand
/// stackHeight  = visibleBand + pillHeight
/// ```
///
/// `cardHeight` is stored rather than computed because one of the design's two instances
/// does not obey the law — see `sentMessage`. `derivedCardHeight` is the law itself, so the
/// divergence is visible in code and asserted in tests instead of living in a comment.
struct AttachmentStackMetrics: Equatable, Sendable {
    /// Both layers are edge-to-edge; a card narrower than the shape on top would show the
    /// notch the rule is about.
    let width: CGFloat
    /// How much of the card is left uncovered — and exactly the height of its label row.
    let visibleBand: CGFloat
    /// The pill or bubble that sits in front.
    let bodyHeight: CGFloat
    /// The front shape's top corner radius. A capsule's is half its height; a bubble's is
    /// `--radius-bubble`.
    let bodyTopRadius: CGFloat
    /// As drawn in the design, which is not always `derivedCardHeight`.
    let cardHeight: CGFloat
    /// Card padding. The label row is inset asymmetrically so the dismiss glyph sits
    /// closer to the edge than the label does.
    let cardPaddingLeading: CGFloat
    let cardPaddingTrailing: CGFloat
    /// The label row's own inset inside that, from the `Attached context / Frame` node. A
    /// *padding*, not the label's offset: the row centres its content in whatever is left of
    /// the band after this comes off, so the label draws at 13, not at 6. See `SelectionCard`.
    let labelRowPaddingTop: CGFloat
    let labelRowPaddingInline: CGFloat

    /// The law. Equal to `cardHeight` everywhere except the sent message.
    var derivedCardHeight: CGFloat { visibleBand + bodyTopRadius }

    /// True when this instance follows the board's own derived law.
    var followsDerivedLaw: Bool { cardHeight == derivedCardHeight }

    /// How much of the card the front shape covers.
    var overlap: CGFloat { cardHeight - visibleBand }

    /// The whole stack: the card's visible band plus the full front shape.
    var totalHeight: CGFloat { visibleBand + bodyHeight }

    /// The straight run of the front shape's top edge — the span a card may *not* stop
    /// short of. The notch rule, as a number.
    var straightTopRun: CGFloat { width - 2 * bodyTopRadius }

    /// `265 = 301 − 20 − 16` in the composer, `188 = 224 − 20 − 16` in the sent message;
    /// the board calls it *"fills the card's visible band exactly"*.
    var labelRowWidth: CGFloat { max(0, width - cardPaddingLeading - cardPaddingTrailing) }
}

extension AttachmentStackMetrics {
    /// The composer's card (screen 05), derived from whatever the pill currently is. A capsule's
    /// effective radius is half its height, and the law is *card = visible band + that radius* —
    /// 38 + 29 = 67 against the 58pt pill the board was drawn at, 38 + 25 = 63 now the pill is
    /// 50. The **total** is 88 either way, because the overlap absorbs the difference: what the
    /// student sees is the 38pt band and the pill, and only the hidden part of the card moved.
    ///
    /// At full-screen scale the design draws no card at all; board 03 lists it as an open
    /// question and states the extrapolation itself: an 80pt pill *"(80 ÷ 2 = 40, implying
    /// a 40pt overlap and 40pt top radii by the derived law)"*. That is what is built here,
    /// against the pill's live height rather than the 80 it was written for.
    /// The visible band stays 38 because it is the label row's height, and the label's type
    /// does not change between scales.
    static func composer(_ scale: ChatScale, width: CGFloat) -> Self {
        let pillHeight: CGFloat = ComposerMetrics.for(scale).height
        let visibleBand: CGFloat = 38
        return Self(
            width: max(0, width),
            visibleBand: visibleBand,
            bodyHeight: pillHeight,
            bodyTopRadius: pillHeight / 2,
            cardHeight: visibleBand + pillHeight / 2,
            cardPaddingLeading: 20,
            cardPaddingTrailing: 16,
            labelRowPaddingTop: 6,
            labelRowPaddingInline: 3
        )
    }

    /// The composer's card at the column the design drew this scale at.
    static func composer(_ scale: ChatScale) -> Self { composer(scale, width: scale.contentWidth) }

    /// A sent message carrying a selection (screen 08).
    ///
    /// **This one violates the law it was built from.** The shape on top is an 18pt-radius
    /// bubble, so the law gives `38 + 18 = 56`; the card is 67. Board 03 explains why:
    /// *"in the file this bubble is a copy of the composer subtree"* — 67 is the composer's
    /// number, carried across without being re-derived, and *"11pt of the card is hidden
    /// for no reason"*. It is visually safe (67 > 56 covers the corner curves, so no notch
    /// appears), and 67 is what the screens draw, so 67 is what ships. `derivedCardHeight`
    /// keeps the 56 the law asks for one property away, for whenever the designer settles
    /// it.
    ///
    /// 224 is the one width the design gives this stack, at both scales — board 13 leaves it
    /// undrawn in the reading column and so it keeps the panel's geometry there. The row it
    /// sits in is the only thing that can take it away: a stack wider than its row would hang
    /// off the trailing edge it is pinned to, and the 224 is a maximum in the same sense the
    /// bubble's cap is. Every column the app produces is wider than 224, so the clamp only
    /// ever fires on a row that could not have drawn the design anyway.
    static func sentMessage(in rowWidth: CGFloat) -> Self {
        Self(
            width: max(0, min(224, rowWidth)),
            visibleBand: 38,
            bodyHeight: 58,
            bodyTopRadius: DS.Radius.bubble,
            cardHeight: 67,
            cardPaddingLeading: 20,
            cardPaddingTrailing: 16,
            labelRowPaddingTop: 6,
            labelRowPaddingInline: 3
        )
    }

    /// The stack as the design draws it, in the 301pt panel column it was measured in.
    static var sentMessage: Self { sentMessage(in: DS.Container.panelContent) }
}

// MARK: - The stack

/// Card behind, body in front — the z-order the board draws a Correct/Wrong diagram about.
///
/// *"Wrong — card height 38, stacked on the pill instead of behind it. Background bites
/// into both corners."* The card is the first child so it paints first, and the body is
/// offset down by the visible band rather than laid out below it, so the two overlap
/// instead of stacking.
struct AttachmentStack<Card: View, Content: View>: View {
    let metrics: AttachmentStackMetrics
    @ViewBuilder let card: () -> Card
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack(alignment: .topLeading) {
            card()
                .frame(width: metrics.width, height: metrics.cardHeight)
            content()
                .frame(width: metrics.width, height: metrics.bodyHeight)
                .offset(y: metrics.visibleBand)
        }
        // `.offset` moves paint, not layout, so the stack would otherwise measure the taller
        // of the two children. The design's height is the band plus the whole front shape.
        .frame(width: metrics.width, height: metrics.totalHeight, alignment: .topLeading)
    }
}

// MARK: - The card

/// The tinted card itself: top corners only, no shadow — *"the pill above it carries
/// 03 Control"* — and a label row pinned to the visible band.
struct SelectionCard: View {
    /// Screen 05's composer. The one the student can still take back.
    static let composerLabel = "Selection attached"
    /// Screen 08's sent message. Shorter copy, and no dismiss: a sent message cannot be
    /// detached.
    static let sentLabel = "Selection"

    let metrics: AttachmentStackMetrics
    let label: String
    /// `nil` renders no ✕ at all, which is the sent-message case.
    var onDismiss: (() -> Void)?

    var body: some View {
        labelRow
            // `align-items: center` sitting on top of the row's own `padding-top`, which is
            // not the same thing as pinning the content to the top of the band. The 6pt
            // padding comes off the 38 first and the 18pt label centres in the 32 that are
            // left: 6 + (32 − 18) ÷ 2 = 13, which is the `y` both instances in the file
            // report — screen 05's card and screen 08's. Pinned to `.top` the label lands at
            // 6 instead, hugging the card's top edge with 14pt of tint under it.
            .frame(width: metrics.labelRowWidth, height: metrics.visibleBand, alignment: .center)
            .padding(.leading, metrics.cardPaddingLeading)
            .padding(.trailing, metrics.cardPaddingTrailing)
            // `align-items: flex-start` — the label pins to the band, not to the middle of
            // a card that is mostly hidden.
            .frame(width: metrics.width, height: metrics.cardHeight, alignment: .topLeading)
            .background(
                DS.Color.brandTintSoft,
                in: UnevenRoundedRectangle(
                    topLeadingRadius: metrics.bodyTopRadius,
                    bottomLeadingRadius: 0,
                    bottomTrailingRadius: 0,
                    topTrailingRadius: metrics.bodyTopRadius
                )
            )
    }

    private var labelRow: some View {
        HStack(spacing: 0) {
            Text(verbatim: label)
                .textStyle(.label)
                .foregroundStyle(DS.Color.brand)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let onDismiss {
                Button(action: onDismiss) {
                    IconView(.composerDismiss, tint: DS.Color.brand)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove attached selection")
            }
        }
        .padding(.top, metrics.labelRowPaddingTop)
        .padding(.horizontal, metrics.labelRowPaddingInline)
    }
}
