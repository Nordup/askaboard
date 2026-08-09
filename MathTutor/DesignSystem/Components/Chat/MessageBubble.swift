import MarkdownUI
import SwiftUI

/// Board 03: *"The asymmetry is the point. The tutor is unboxed text sitting directly on
/// the panel — it is the voice of the surface, not a participant in a chat log. Only the
/// student gets a bubble, right-aligned and shrunk to its content, so the eye can scan one
/// edge to find everything the student said. A port that boxes both sides loses the whole
/// hierarchy."*
struct MessageMetrics: Equatable, Sendable {
    /// The row a message is laid out in — the full content column. Tutor text fills it;
    /// a student bubble is pinned to its trailing edge.
    let rowWidth: CGFloat
    /// `max-width` — the bubble hugs its content up to here and wraps after.
    let bubbleMaxWidth: CGFloat
    let bubblePaddingBlock: CGFloat
    let bubblePaddingInline: CGFloat
    let bubbleRadius: CGFloat
    /// 17 / 25 for every message on the board except one — see `selectionTextStyle`.
    let textStyle: DS.TextStyle
    /// The column gap inside a multi-paragraph tutor message: *"12 — for a second
    /// paragraph"*.
    let paragraphGap: CGFloat
    /// A sent message that carries a board selection is the attachment stack again, at
    /// 224 wide with an 18pt bubble on top instead of a capsule.
    let selection: AttachmentStackMetrics
    /// **17 / 22, not the 25 every other message uses.** Measured on screen 08's eighth
    /// child; the board calls it out explicitly. It is the same line box the composer's
    /// placeholder takes, and for the same reason — one line, optically centred in a
    /// fixed-height box.
    let selectionTextStyle: DS.TextStyle

    /// *"Height for n wrapped lines = 12 + 25n + 12"* — 49 at one line, 74 at two, both
    /// measured in the live thread.
    func bubbleHeight(lines: Int) -> CGFloat {
        2 * bubblePaddingBlock + textStyle.leading * CGFloat(lines)
    }

    /// How much of the row a maxed-out bubble leaves clear beside it — 77 in the panel, 220
    /// in the reading column. This is the quantity the cap exists to produce, so it is the
    /// one held constant when the row narrows; see `bubbleMaxWidth(cap:in:drawnIn:)`.
    var bubbleGutter: CGFloat { rowWidth - bubbleMaxWidth }
}

extension MessageMetrics {
    /// The panel's message spec (board 03) and the reading column's (board 13), in a column
    /// of `width`.
    ///
    /// Everything that steps between the two is a lookup — 17/25 → 21/30, 12/16 → 16/24
    /// padding — because board 05 says the two are variants and not one responsive view.
    /// Only the row and the bubble's cap are computed, because only those two are a
    /// consequence of how much room there is.
    ///
    /// Board 13 on the wide spec, which closed the state table's one empty cell: *"the
    /// panel-scale message spec has been carried up to the 740 column for the first time...
    /// board 03 only ever specced the 301 column, so the full-screen thread was undefined
    /// until now."* Radius and message gap deliberately do not scale, and the selection
    /// stack is the one thing still undrawn at this width, so it keeps the panel's geometry —
    /// see `AttachmentStackMetrics.sentMessage(in:)`.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        let row = max(0, width)
        switch scale {
        case .panel:
            return Self(
                rowWidth: row,
                bubbleMaxWidth: bubbleMaxWidth(cap: 224, in: row, drawnIn: DS.Container.panelContent),
                bubblePaddingBlock: DS.Space.s3,
                bubblePaddingInline: DS.Space.s4,
                bubbleRadius: DS.Radius.bubble,
                textStyle: .body,
                paragraphGap: DS.Space.s3,
                selection: .sentMessage(in: row),
                selectionTextStyle: .bodyControl
            )
        case .fullScreen:
            return Self(
                rowWidth: row,
                bubbleMaxWidth: bubbleMaxWidth(cap: 520, in: row, drawnIn: DS.Container.column),
                bubblePaddingBlock: DS.Space.s4,
                bubblePaddingInline: DS.Space.s6,
                // Unchanged from panel scale, all four: the radius token, the paragraph
                // rhythm, the selection stack and its 17/22 line box.
                bubbleRadius: DS.Radius.bubble,
                textStyle: .lead,
                paragraphGap: DS.Space.s3,
                selection: .sentMessage(in: row),
                selectionTextStyle: .bodyControl
            )
        }
    }

    /// The bubble's `max-width` in a row that may be narrower than the one it was drawn in.
    ///
    /// The design states the cap twice — 224 of a 301 row, 520 of a 740 one — and the two are
    /// not the same fraction (0.744 against 0.703), so there is no percentage to carry
    /// across. What both do state is how much of the row a maxed-out bubble leaves clear
    /// beside it: 77 and 220. That gutter is what the cap is *for*. Board 03: the bubble is
    /// *"right-aligned and shrunk to its content, so the eye can scan one edge to find
    /// everything the student said"* — a bubble that reaches the far side of the row has
    /// stopped reading as one side of a conversation and starts reading as the tutor's own
    /// full-width text with a fill behind it.
    ///
    /// So the gutter is held and the measure gives, which is the only direction a measure
    /// ever moves: 424 in a 644 column, never more than the 520 the design drew.
    static func bubbleMaxWidth(cap: CGFloat, in rowWidth: CGFloat, drawnIn referenceRow: CGFloat) -> CGFloat {
        max(0, min(cap, rowWidth - (referenceRow - cap)))
    }

    /// The design's own two columns, which is what every published measurement was taken at.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }
    static var fullScreen: Self { .for(.fullScreen, width: DS.Container.column) }

    static func `for`(_ scale: ChatScale) -> Self { .for(scale, width: scale.contentWidth) }
}

// MARK: - Tutor

/// Bare text on the panel — no frame, no fill, no padding, no elevation.
///
/// Tutor copy is Markdown and stays Markdown: `TutorStructuredText` is the app's one
/// assistant renderer. The design's type is pushed into it through MarkdownUI's theme
/// rather than by wrapping, because MarkdownUI resolves its own font from the theme and
/// would otherwise draw the system face at 17pt — the right size in the wrong typeface,
/// which is the kind of near-miss nobody notices until the visual diff.
struct TutorMessageText: View {
    let markdown: String
    var metrics: MessageMetrics = .panel

    var body: some View {
        TutorStructuredText(markdown)
            .markdownTextStyle(\.text) {
                FontFamily(.custom(DS.Font.postScriptName(for: metrics.textStyle.weight)))
                FontSize(metrics.textStyle.size)
                ForegroundColor(DS.Color.ink)
            }
            .markdownBlockStyle(\.paragraph) { configuration in
                configuration.label
                    .lineSpacing(metrics.textStyle.lineSpacing)
                    .markdownMargin(top: metrics.paragraphGap)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Student

/// The student's own words, boxed and pinned right.
///
/// `Text(verbatim:)` via `LearnerLiteralText` is a correctness property, not a style
/// choice: learner text is user-authored data and must never be parsed as Markdown.
struct MessageBubble: View {
    let text: String
    var metrics: MessageMetrics = .panel

    var body: some View {
        LearnerLiteralText(text)
            .textStyle(metrics.textStyle)
            .foregroundStyle(DS.Color.ink)
            .padding(.vertical, metrics.bubblePaddingBlock)
            .padding(.horizontal, metrics.bubblePaddingInline)
            .frame(maxWidth: metrics.bubbleMaxWidth, alignment: .leading)
            // `.circular`, not `.continuous`: the design's radii are CSS corners, which
            // are circular arcs, and the card tucked behind this shape is sized off that
            // exact curve.
            .background(
                DS.Color.surfaceBubble,
                in: RoundedRectangle(cornerRadius: metrics.bubbleRadius, style: .circular)
            )
    }
}

/// A sent message with a board selection stuck to it — the attachment stack's second use.
///
/// Fixed at 224 × 58 the way the design draws it — unlike the plain bubble, which hugs its
/// content. The design has exactly one specimen and states no wrapping rule for this
/// variant, and the card behind it is sized off that fixed 58, so the height stays fixed
/// rather than being given a growth rule the board never wrote.
struct SelectionMessageBubble: View {
    let text: String
    var metrics: MessageMetrics = .panel

    var body: some View {
        SelectionAttachment.sent(metrics: metrics.selection) {
            StackedMessageBubble(text: text, metrics: metrics)
        }
    }
}

/// The student's words in the fixed box a stacked card sits behind.
///
/// Its own view because there are now **two** cards that sit behind this exact shape: screen
/// 08's "Selection" label, and the chips of a turn that carried files. They are the same
/// stack at the same 224 by ruling — a sent attachment belongs where the student's other
/// sent work already is — so the shape in front of them has to be one shape. Restated at
/// each call site it is a shape that drifts, which is the argument `SelectionAttachment`'s
/// own doc comment makes about the card.
///
/// Fixed at `bodyHeight`, unlike the plain bubble which hugs its content: the design has
/// exactly one specimen and states no wrapping rule for this variant, and the card behind it
/// is sized off that fixed height.
struct StackedMessageBubble: View {
    let text: String
    var metrics: MessageMetrics = .panel

    var body: some View {
        LearnerLiteralText(text)
            .textStyle(metrics.selectionTextStyle)
            .foregroundStyle(DS.Color.ink)
            .padding(.horizontal, 20)
            .frame(
                width: metrics.selection.width,
                height: metrics.selection.bodyHeight,
                alignment: .leading
            )
            .background(
                DS.Color.surfaceBubble,
                in: RoundedRectangle(cornerRadius: metrics.bubbleRadius, style: .circular)
            )
    }
}
