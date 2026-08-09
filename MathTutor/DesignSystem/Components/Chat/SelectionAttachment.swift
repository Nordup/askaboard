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
    /// Which of the two treatments this instance is.
    ///
    /// Stored rather than recovered from one of the values it picks. The card's contents
    /// need it — a chip's thumbnail box, label lane and ✕ all step with the scale, and
    /// `AttachmentChipMetrics` is the lookup — and inferring it from, say, the label style
    /// breaks the moment two instances at different scales happen to share one.
    let scale: ChatScale
    /// Both layers are edge-to-edge; a card narrower than the shape on top would show the
    /// notch the rule is about.
    let width: CGFloat
    /// How much of the card is left uncovered — and exactly the height of its label row.
    let visibleBand: CGFloat
    /// The pill or bubble that sits in front. **Zero** in the one instance that has nothing
    /// in front of it — see `sentChips`.
    ///
    /// `private(set)`, like `ComposerMetrics.width`, so the only thing that can write it is
    /// a factory in this file: a caller may pick an instance, never assemble one.
    private(set) var bodyHeight: CGFloat
    /// The front shape's top corner radius. A capsule's is half its height; a bubble's is
    /// `--radius-bubble`.
    let bodyTopRadius: CGFloat
    /// As drawn in the design, which is not always `derivedCardHeight`. `private(set)` for
    /// the same reason `bodyHeight` is.
    private(set) var cardHeight: CGFloat
    /// Card padding. The label row is inset asymmetrically so the dismiss glyph sits
    /// closer to the edge than the label does.
    let cardPaddingLeading: CGFloat
    let cardPaddingTrailing: CGFloat
    /// The label row's own inset inside that, from the `Attached context / Frame` node. A
    /// *padding*, not the label's offset: the row centres its content in whatever is left of
    /// the band after this comes off, so the label draws at 13, not at 6. See `SelectionCard`.
    let labelRowPaddingTop: CGFloat
    let labelRowPaddingInline: CGFloat
    /// The label on the band. `--text-label` 15 / 18 · 600 in the panel; the wide surface
    /// steps it, because a 15pt label beside a 21pt placeholder is the panel's card sitting
    /// on the reading column's pill.
    let labelStyle: DS.TextStyle
    /// `composer/dismiss`, which steps with the label rather than staying at the panel's 14.
    let dismissGlyphSize: CGFloat

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
    ///
    /// The chips card's trailing padding is 0, so this is its whole scrolling lane:
    /// `281 = 301 − 20`, which is the number task 8 §6a does the three-chip arithmetic
    /// against.
    var labelRowWidth: CGFloat { max(0, width - cardPaddingLeading - cardPaddingTrailing) }

    /// One chip's height: the visible band less the row's padding above and below it.
    ///
    /// The inverse of the band's own arithmetic — task 8 §5 states the band as
    /// `6 + 40 + 6` in the panel and `8 + 48 + 8` full-screen — so a chip's height is a
    /// *consequence* of the band rather than a third number that can drift out of
    /// agreement with it. It comes back out at `AttachmentChipMetrics.height`, and a test
    /// asserts the round trip.
    var chipHeight: CGFloat { max(0, visibleBand - 2 * labelRowPaddingTop) }
}

/// Everything about the card that is the *card's* rather than the shape's, as one per-scale
/// set — and the reason the two scales stopped looking like the same component.
///
/// **The design draws this at panel scale only.** Board 03 lists the wide card as an open
/// question and gives no numbers for it, so the code drew the panel's — 38pt band, a 15/18
/// label, 20/16 and 6/3 — behind a 68pt pill carrying a 21/30 placeholder. Every value was
/// *correct* and the card still read as borrowed, because a card that does not step while
/// everything around it does is a panel card on a reading column.
///
/// The wide column is the panel's numbers stepped by the one ratio the composer itself
/// steps by — its pill, `68 ÷ 50 = 1.36` — then snapped to the spacing scale. Every one of
/// them lands on a value the wide surface already uses, which is the check that the ratio is
/// the right one:
///
/// ```
/// band     38 → 52   band + pill goes 88 → 120, the same 1.36
/// leading  20 → 28   --spacing-7, the wide pill's own paddingLeading
/// trailing 16 → 24   --spacing-6, the wide bubble's own paddingInline
/// row top   6 →  8   --spacing-2
/// row side  3 →  4   --spacing-1
/// label  15/18 → 17/25 · 600, the step `SessionPlanMetrics` already makes for its kicker
/// dismiss  14 → 18   with the other composer glyphs, which step 20 → 26 and 22 → 26
/// ```
///
/// The label lands at 17.5 down the wide band where the panel's lands at 13 — the same
/// fraction of the band, which is what "proportional" has to mean for a value that is
/// centred rather than pinned.
private struct CardStyle {
    let visibleBand: CGFloat
    let paddingLeading: CGFloat
    let paddingTrailing: CGFloat
    let labelRowTop: CGFloat
    let labelRowInline: CGFloat
    let labelStyle: DS.TextStyle
    let dismissGlyph: CGFloat

    /// Screens 05 and 08, measured.
    static let panel = Self(
        visibleBand: 38,
        paddingLeading: DS.Space.s5,
        paddingTrailing: DS.Space.s4,
        labelRowTop: 6,
        labelRowInline: 3,
        labelStyle: .label,
        dismissGlyph: Icon.composerDismiss.renderSize
    )

    /// The reading column. Extrapolated — see the type's own note for the ratio and for what
    /// each value lands on.
    static let fullScreen = Self(
        visibleBand: 52,
        paddingLeading: DS.Space.s7,
        paddingTrailing: DS.Space.s6,
        labelRowTop: DS.Space.s2,
        labelRowInline: DS.Space.s1,
        // 20 / 24 · 600. `labelFullScreen`'s 17 is the step board 13 states for the session
        // plan's kicker, and a kicker sits *under* its headline — this label sits beside a
        // 21pt placeholder and has to carry the band, so it takes the settings row's 20
        // instead. One step, and the band does not move: 24 + 8 still centres in 52.
        labelStyle: .labelLarge,
        dismissGlyph: 18
    )

    static func `for`(_ scale: ChatScale) -> Self {
        switch scale {
        case .panel: .panel
        case .fullScreen: .fullScreen
        }
    }
}

extension AttachmentStackMetrics {
    /// One card, built from its scale's style and the geometry of whatever shape hides it.
    ///
    /// Only three things are ever the *instance's*: the width, the height of the shape in
    /// front, and that shape's top radius. Everything else comes off `CardStyle`, so the two
    /// instances cannot drift and neither can the two scales.
    private static func card(
        _ scale: ChatScale,
        width: CGFloat,
        bodyHeight: CGFloat,
        bodyTopRadius: CGFloat,
        cardHeight: CGFloat? = nil
    ) -> Self {
        let style = CardStyle.for(scale)
        return Self(
            scale: scale,
            width: max(0, width),
            visibleBand: style.visibleBand,
            bodyHeight: bodyHeight,
            bodyTopRadius: bodyTopRadius,
            // `nil` takes the board's derived law; the sent message is the one instance that
            // does not obey it and says so at its call site.
            cardHeight: cardHeight ?? (style.visibleBand + bodyTopRadius),
            cardPaddingLeading: style.paddingLeading,
            cardPaddingTrailing: style.paddingTrailing,
            labelRowPaddingTop: style.labelRowTop,
            labelRowPaddingInline: style.labelRowInline,
            labelStyle: style.labelStyle,
            dismissGlyphSize: style.dismissGlyph
        )
    }

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
    ///
    /// The pill's **resting** height and radius, which is also what keeps this correct once the
    /// composer grows: `bodyHeight` is a floor rather than a fixed height (see `AttachmentStack`),
    /// and `cornerRadius` is held at half the resting height, so the curve the card is cut to is
    /// still the curve the pill draws when it is five lines tall.
    static func composer(_ scale: ChatScale, width: CGFloat) -> Self {
        let pill = ComposerMetrics.for(scale)
        return card(
            scale,
            width: width,
            bodyHeight: pill.height,
            bodyTopRadius: pill.cornerRadius
        )
    }

    /// The composer's card at the column the design drew this scale at.
    static func composer(_ scale: ChatScale) -> Self { composer(scale, width: scale.contentWidth) }

    /// The composer's card when it holds chips rather than a label — board 16 and board
    /// 03b §3.
    ///
    /// **A second instance, not the first one with different contents.** The label card's
    /// `visibleBand` is *exactly the height of its label row*, and a chip carrying a
    /// thumbnail does not fit one line of text: 40 points of chip do not go into 38, and
    /// 48 do not go into 52 with any room around them. Everything structural is still the
    /// label card's — the same width edge-to-edge with the pill, the same front shape, the
    /// same top radii — and `derivedCardHeight` still holds, which is what the tests pin.
    ///
    /// The band is task 8 §5's own arithmetic rather than a measured constant:
    /// `6 + 40 + 6 = 52` in the panel and `8 + 48 + 8 = 64` full-screen, against a card of
    /// `52 + 25 = 77` and `64 + 34 = 98` — the two sizes the drawing reports.
    ///
    /// Two paddings are the chips card's own and not the label card's:
    ///
    /// - **Trailing is 0.** The row is a horizontal scroller and bleeds to the card's right
    ///   edge, so an overflowing chip is cut by the card's own clip rather than stopping
    ///   short in a gutter. That cut *is* the scroll cue — see `AttachmentChipRow`.
    /// - **Leading is 20 / 30.** The panel's is the label card's 20; the wide card's 30 is
    ///   measured, and two points wider than the label card's 28. Off the 4pt scale, and
    ///   taken as drawn rather than snapped to `--spacing-7`: the drawing is the source and
    ///   this is not a value the port gets to round.
    static func composerChips(_ scale: ChatScale, width: CGFloat) -> Self {
        let label = composer(scale, width: width)
        let chip = AttachmentChipMetrics.for(scale)
        let band = chip.height + 2 * label.labelRowPaddingTop
        return Self(
            scale: scale,
            width: label.width,
            visibleBand: band,
            bodyHeight: label.bodyHeight,
            bodyTopRadius: label.bodyTopRadius,
            cardHeight: band + label.bodyTopRadius,
            cardPaddingLeading: scale == .panel ? DS.Space.s5 : 30,
            cardPaddingTrailing: 0,
            labelRowPaddingTop: label.labelRowPaddingTop,
            labelRowPaddingInline: label.labelRowPaddingInline,
            // The card draws no label of its own — the chips carry the names — so these
            // two are the *chip's* type and glyph rather than the band label's. Set
            // rather than inherited so nothing reading this instance is handed the label
            // card's 20/24 and 18, which are a full step off what the chips draw.
            labelStyle: chip.labelStyle,
            dismissGlyphSize: chip.dismissSize
        )
    }

    /// The chips a **sent** turn carried — screen 08's lane, not the composer's.
    ///
    /// **This is a ruling, and it is the whole point of the method.** A sent attachment is
    /// part of the student's turn, so it sits exactly where their other sent work already
    /// sits: `sentMessage`'s stack, on the trailing edge, 224 wide, with the same 58pt
    /// bubble and the same `--radius-bubble` in front of it. Drawn at the thread's own
    /// column instead — 301, or 740 full-screen — it read as a system band across the
    /// conversation rather than as something the student sent, and the thread carried two
    /// sent-attachment treatments that disagreed about where a sent attachment lives.
    ///
    /// So the geometry is `sentMessage`'s, read from it rather than restated, and only the
    /// band is the chips': a chip carrying a 32pt thumbnail does not fit a card sized to one
    /// label row, which is the same reason `composerChips` is a second instance of the
    /// composer's card rather than the first one with different contents.
    ///
    /// The lane is narrower than the composer's — `224 − 20 = 204` against 281 — and nothing
    /// has to be invented for that: the row is a horizontal scroller and the cut chip is the
    /// affordance, exactly as it already is in the composer (see `AttachmentChipRow`). Which
    /// is also why the trailing padding is 0 here as it is there, where `sentMessage`'s
    /// label card takes 16: the row bleeds to the card's edge so an overflowing chip is cut
    /// by the clip rather than stopping short in a gutter.
    ///
    /// Unlike `sentMessage` this one **does** obey the derived law — `52 + 18 = 70` — because
    /// its card height is derived here rather than carried over from the composer subtree.
    static func sentChips(in rowWidth: CGFloat) -> Self {
        let sent = sentMessage(in: rowWidth)
        let chip = AttachmentChipMetrics.for(sent.scale)
        let band = chip.height + 2 * sent.labelRowPaddingTop
        return Self(
            scale: sent.scale,
            width: sent.width,
            visibleBand: band,
            bodyHeight: sent.bodyHeight,
            bodyTopRadius: sent.bodyTopRadius,
            cardHeight: band + sent.bodyTopRadius,
            cardPaddingLeading: sent.cardPaddingLeading,
            // 0, not the label card's 16 — see this method's note.
            cardPaddingTrailing: 0,
            labelRowPaddingTop: sent.labelRowPaddingTop,
            labelRowPaddingInline: sent.labelRowPaddingInline,
            // The chip's own type and glyph, not the band label's — the same substitution
            // `composerChips` makes, and for the same reason.
            labelStyle: chip.labelStyle,
            dismissGlyphSize: chip.dismissSize
        )
    }

    /// The same card as a **message of its own** — a turn that is files and no words.
    ///
    /// **Undrawn.** Every card in this file hides `bodyTopRadius` of itself behind the shape
    /// in front (see `AttachmentStack`, and the law at the top of the file). A turn with no
    /// bubble has nothing in front of it, so drawing `sentChips` there paints that hidden
    /// band: a square-cornered tinted rectangle hanging under the chips, over a bubble's
    /// height of empty row. Photographing a worksheet and sending it wordlessly is the
    /// camera row's whole purpose, so that is not a state the product can ship in.
    ///
    /// So the overlap goes to zero — the card is exactly its own visible band — and there is
    /// no body for the stack to reserve. The caller rounds all four corners rather than only
    /// the top two, because both pairs are edges here rather than tucks.
    ///
    /// **This wants a Paper pass.** The radius is `sentMessage`'s own `--radius-bubble`,
    /// carried to all four corners: the curve every other thing the student sent is drawn
    /// with, which is a defensible reading of an undrawn state and not a designed one.
    static func sentChipsAlone(in rowWidth: CGFloat) -> Self {
        var metrics = sentChips(in: rowWidth)
        metrics.bodyHeight = 0
        metrics.cardHeight = metrics.visibleBand
        return metrics
    }

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
    /// **Panel style at both scales**, unlike the composer's card: this stack keeps the
    /// panel's whole geometry in the reading column — 224 wide, a 58pt bubble, a 17/22 line
    /// box — because board 13 leaves it undrawn there, so stepping only its card would step
    /// half a component. When the wide stack is drawn, this takes the scale like the composer
    /// does and everything follows.
    static func sentMessage(in rowWidth: CGFloat) -> Self {
        card(
            .panel,
            width: min(224, rowWidth),
            bodyHeight: 58,
            bodyTopRadius: DS.Radius.bubble,
            // 67, not the law's 56 — see this method's note.
            cardHeight: 67
        )
    }

    /// The stack as the design draws it, in the 301pt panel column it was measured in.
    static var sentMessage: Self { sentMessage(in: DS.Container.panelContent) }
}

// MARK: - The stack

/// Card behind, body in front — the z-order the board draws a Correct/Wrong diagram about.
///
/// *"Wrong — card height 38, stacked on the pill instead of behind it. Background bites
/// into both corners."* The card is a `.background`, which paints behind and takes no layout,
/// and it is offset up out of the band the body reserves for it — so the two overlap instead
/// of stacking.
///
/// **The body sets the height and the stack grows upward from the body's bottom edge.** The
/// composer's pill grows with what is typed into it, and a stack pinned to a fixed
/// `bodyHeight` would either squash it or push it down through the surface floor it is
/// anchored to. `minHeight` means the resting geometry is exactly what it was — `visibleBand +
/// bodyHeight`, the design's `totalHeight` — and the card rides up with the pill's top edge
/// rather than staying where a resting pill's top used to be. The sent message frames its own
/// bubble at exactly `bodyHeight`, so nothing about that instance moves.
struct AttachmentStack<Card: View, Content: View>: View {
    let metrics: AttachmentStackMetrics
    @ViewBuilder let card: () -> Card
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .frame(width: metrics.width)
            .frame(minHeight: metrics.bodyHeight, alignment: .bottom)
            .background(alignment: .top) {
                card()
                    .frame(width: metrics.width, height: metrics.cardHeight)
                    // Up by the band, so the card's bottom lands `bodyTopRadius` *inside* the
                    // body — under the shape's corner curves, which is the notch rule.
                    .offset(y: -metrics.visibleBand)
            }
            // The card takes no layout, so the band it shows above the body has to be
            // reserved here or the stack would measure the body alone.
            .padding(.top, metrics.visibleBand)
    }
}

// MARK: - The idiom

/// Card, shape, label — the whole thing, as **one** view.
///
/// Both of the design's instances come through here: the composer's attached pill (screen 05)
/// and a sent message carrying a selection (screen 08). They differ in exactly three things —
/// the metrics, the label, and whether there is a ✕ — and in nothing else, which is what
/// board 03 means by *"the same idiom at two widths and two radii"*.
///
/// Assembling the stack and the card separately at each call site is how two instances of one
/// idiom drift: it takes only one of them to gain a modifier. The two constructors below are
/// the only way in, so the label and the dismiss cannot be paired wrongly either — a sent
/// message with a ✕ on it is not a state that exists.
struct SelectionAttachment<Content: View>: View {
    private let metrics: AttachmentStackMetrics
    private let label: String
    private let onDismiss: (() -> Void)?
    private let content: Content

    private init(
        metrics: AttachmentStackMetrics,
        label: String,
        onDismiss: (() -> Void)?,
        @ViewBuilder content: () -> Content
    ) {
        self.metrics = metrics
        self.label = label
        self.onDismiss = onDismiss
        self.content = content()
    }

    /// Screen 05's composer — the attachment the student can still take back.
    static func composer(
        metrics: AttachmentStackMetrics,
        onDismiss: (() -> Void)?,
        @ViewBuilder content: () -> Content
    ) -> Self {
        Self(metrics: metrics, label: SelectionCard.composerLabel, onDismiss: onDismiss, content: content)
    }

    /// Screen 08's sent message — shorter copy and no ✕, because a sent message cannot be
    /// detached.
    static func sent(
        metrics: AttachmentStackMetrics,
        @ViewBuilder content: () -> Content
    ) -> Self {
        Self(metrics: metrics, label: SelectionCard.sentLabel, onDismiss: nil, content: content)
    }

    var body: some View {
        AttachmentStack(metrics: metrics) {
            SelectionCard(metrics: metrics, label: label, onDismiss: onDismiss)
        } content: {
            content
        }
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
    /// The same word on a chip, where the container is 84 points wide and
    /// "Selection attached" would truncate to about half of itself.
    ///
    /// Its own constant rather than a second use of `sentLabel`: the two agree today by
    /// coincidence of length, and a chip in the composer and a cap on a sent message are
    /// not the same string with the same reason behind it.
    static let chipLabel = "Selection"

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
            .attachmentCardSurface(metrics)
    }

    private var labelRow: some View {
        HStack(spacing: 0) {
            Text(verbatim: label)
                .textStyle(metrics.labelStyle)
                .foregroundStyle(DS.Color.brand)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let onDismiss {
                Button(action: onDismiss) {
                    IconView(.composerDismiss, size: metrics.dismissGlyphSize, tint: DS.Color.brand)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove attached selection")
            }
        }
        .padding(.top, metrics.labelRowPaddingTop)
        .padding(.horizontal, metrics.labelRowPaddingInline)
    }
}

extension View {
    /// The card itself, under whatever fills its band: full width, `cardHeight` tall, its
    /// two top corners cut to the curve of the shape in front and its bottom two square
    /// because they are behind it.
    ///
    /// Extracted because there are two things that fill the band now — the selection's
    /// label row and the attachment chips — and the card under them is the same card. Two
    /// call sites each spelling out a fill, a height and four radii is how one of them
    /// gains a modifier the other does not.
    func attachmentCardSurface(_ metrics: AttachmentStackMetrics) -> some View {
        frame(width: metrics.width, height: metrics.cardHeight, alignment: .topLeading)
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
}
