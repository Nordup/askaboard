import SwiftUI

/// One chip, measured off board 03b §3 at both scales.
///
/// **The width and the height are derived, not measured.** Task 8 publishes 158 × 40 and
/// 209 × 48 and then shows its own working — `4 + 32 + 8 + 84 + 8 + 14 + 8 = 158` and
/// `5 + 38 + 10 + 120 + 10 + 16 + 10 = 209` — so the parts are the drawing and the two
/// sizes are the check. The height is the same story from the other axis: the thumbnail box
/// is inset uniformly, so `32 + 2 × 4 = 40` and `38 + 2 × 5 = 48`, which is why one padding
/// covers both edges and both directions.
///
/// The scale's step here is the composer's own — the chip grows with the pill it sits
/// above, not with the column — so every value below is one the wide surface already draws.
struct AttachmentChipMetrics: Equatable, Sendable {
    /// Inset on the leading edge, and above and below the thumbnail box.
    let paddingLeading: CGFloat
    /// Wider than the leading inset, because the ✕ needs air where a picture does not.
    let paddingTrailing: CGFloat
    /// Between the box, the label lane and the ✕.
    let gap: CGFloat
    /// The chip's own corner. `--radius-sm` in the panel, `--radius-md` full-screen — one
    /// of the few places the two scales take different radius tokens, because a 48pt chip
    /// with a 10pt corner reads tighter than a 40pt one with the same.
    let radius: CGFloat
    /// Square, and it clips whatever image lands in it.
    let thumbnailSize: CGFloat
    let thumbnailRadius: CGFloat
    /// The filename's lane. **Fixed**, not hugging: task 8 §7.7 — Paper drops an explicit
    /// width on a text node, so the drawing enforces the lane by fixing the chip and
    /// letting the label take the remainder, and in code that is a fixed frame with tail
    /// truncation.
    ///
    /// 84 truncates a long filename hard, and that is the settled trade: 54 would fit two
    /// whole chips in the panel's 281pt lane but cuts most real filenames to about seven
    /// characters, so the row scrolls instead (§6a).
    let labelWidth: CGFloat
    /// `composer/dismiss`. 14 / 16 — not the label card's 14 / 18, because this one sits on
    /// a 40pt chip rather than in a 52pt band.
    let dismissSize: CGFloat
    /// Between one chip and the next.
    let rowGap: CGFloat
    /// The filename. 15 / 18 · 600 in the panel; 17 / 22 · 600 full-screen, which is the
    /// step `menu/sessions` already makes for a row title rather than a new specimen.
    let labelStyle: DS.TextStyle

    /// `paddingLeading + box + gap + lane + gap + ✕ + paddingTrailing` — 158 and 209.
    ///
    /// A chip that cannot be removed gives back the ✕ and the gap before it rather than
    /// leaving a hole where the control was: `isRemovable: false` is the sent message, and
    /// a sent attachment has no control at all.
    func width(removable: Bool = true) -> CGFloat {
        let trailing = removable ? gap + dismissSize : 0
        return paddingLeading + thumbnailSize + gap + labelWidth + trailing + paddingTrailing
    }

    /// The thumbnail box plus its uniform inset — 40 and 48, which is what the card's
    /// visible band is built from.
    var height: CGFloat { thumbnailSize + 2 * paddingLeading }

    /// Board 03b §3, panel stage.
    static let panel = Self(
        paddingLeading: DS.Space.s1,
        paddingTrailing: DS.Space.s2,
        gap: DS.Space.s2,
        radius: DS.Radius.sm,
        thumbnailSize: 32,
        thumbnailRadius: DS.Radius.xs,
        labelWidth: 84,
        dismissSize: Icon.composerDismiss.renderSize,
        rowGap: DS.Space.s2,
        labelStyle: .label
    )

    /// Board 03b §3, full-screen stage. `5` and `10` are off the 4pt scale and are taken as
    /// drawn — the same licence `SessionSwitcherMetrics` already takes for its own 10.
    static let fullScreen = Self(
        paddingLeading: 5,
        paddingTrailing: 10,
        gap: 10,
        radius: DS.Radius.md,
        thumbnailSize: 38,
        thumbnailRadius: DS.Radius.sm,
        labelWidth: 120,
        dismissSize: 16,
        rowGap: DS.Space.s3,
        // 17 / 22 · 600 — `--text-body` on `--leading-control`, the same box a menu row
        // title takes. Not `labelLarge`: that is the *card's* label style at this scale,
        // and a filename on a chip is not the band label it replaced.
        labelStyle: TextStyle(size: DS.Size.body, leading: DS.Leading.control, weight: .semibold)
    )

    static func `for`(_ scale: ChatScale) -> Self {
        switch scale {
        case .panel: .panel
        case .fullScreen: .fullScreen
        }
    }
}

/// The attachment card's contents: one chip per thing attached to this message.
///
/// A row *inside* the card the board selection already had, not a new surface — the card's
/// top-only radii, its `--color-brand-tint-soft` fill and board 03 §2's notch rule all
/// still belong to `AttachmentStack` and to `attachmentCardSurface`. This is what sits in
/// the band, and the band's own fill.
///
/// **The board selection is one of these chips.** It was always an attachment: it already
/// drew this card, and it already survives into the sent message. Unifying them is what
/// lets a learner send the worksheet and their own attempt in one turn — *"here is the
/// problem, here is what I tried."* Paper draws the file chips and does not draw this one;
/// it takes the marquee glyph in the thumbnail box and the short copy `SelectionCard`
/// already has for a small container.
///
/// **The row scrolls and never wraps** (task 8 §6a, confirmed). Three panel chips need
/// `3 × 158 + 2 × 8 = 490` in a 281pt lane, so chip one shows whole and 115 points of chip
/// two show past it — the cut *is* the affordance, which is why the scroll indicator is
/// hidden rather than drawn over a 52pt band. Wrapping was rejected: three lines make a
/// 148pt band and a 173pt card, taller than the composer it belongs to. Full-screen has no
/// such problem — `3 × 209 + 2 × 12 = 651` fits the 710 available — so nothing about this
/// changes with the scale except that the scroller runs out of content.
struct AttachmentChipRow: View {
    let attachments: [PendingAttachment]
    /// Whether a board region is attached too. Drawn first, because it is the learner's own
    /// work and the files are the material.
    let showsSelection: Bool
    let metrics: AttachmentStackMetrics
    /// Thumbnails are looked up first and carried second: a chip exists from the moment the
    /// file is picked and its bytes arrive later, and a chip rebuilt for a *sent* message
    /// has only the store to get them from. `PendingAttachmentState.ready` carries the
    /// bytes the upload returned, which is what the composer's own draft uses.
    ///
    /// So the default — no store behind it — is right for every draft, and `MessageThread`
    /// is the one caller that passes anything: it is the only place a row is rebuilt for a
    /// message that was already sent.
    var thumbnail: (UUID) -> Data? = { _ in nil }
    let onRemove: (UUID) -> Void
    let onDismissSelection: () -> Void
    /// A sent message's chips carry no ✕ — there is nothing to take back.
    var isRemovable = true

    /// What the row will draw. Exposed for the tests, which have no way to count subviews.
    var chipCount: Int { attachments.count + (showsSelection ? 1 : 0) }

    private var chip: AttachmentChipMetrics { .for(metrics.scale) }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: chip.rowGap) {
                if showsSelection {
                    AttachmentChip(
                        title: SelectionCard.chipLabel,
                        subtitle: nil,
                        state: .selection,
                        metrics: chip,
                        onRemove: dismissSelectionAction
                    )
                }
                ForEach(attachments) { attachment in
                    AttachmentChip(
                        title: attachment.filename,
                        subtitle: subtitle(for: attachment),
                        state: state(for: attachment),
                        metrics: chip,
                        onRemove: removeAction(for: attachment)
                    )
                }
            }
            .padding(.leading, metrics.cardPaddingLeading)
            // 0 on the chips card: the row bleeds to the card's right edge so an
            // overflowing chip is cut by the clip rather than stopping short in a gutter.
            .padding(.trailing, metrics.cardPaddingTrailing)
            // The band is `padding + chip + padding`, so this is the same number on both
            // edges and the chip's own height is what is left.
            .padding(.vertical, metrics.labelRowPaddingTop)
        }
        // A single chip must not rubber-band: nothing scrolls until something overflows.
        .scrollBounceBehavior(.basedOnSize)
        // The cut chip is the cue the design draws. A system indicator over a 52pt band
        // would sit on top of the chips it is describing.
        .scrollIndicators(.hidden)
        .frame(width: metrics.width, height: metrics.visibleBand, alignment: .topLeading)
        .attachmentCardSurface(metrics)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attachments")
    }

    /// `nil` on a sent message's chips, which is what draws them without a ✕ and narrows
    /// them by the width the control would have taken.
    private var dismissSelectionAction: (() -> Void)? {
        guard isRemovable else { return nil }
        return onDismissSelection
    }

    private func removeAction(for attachment: PendingAttachment) -> (() -> Void)? {
        guard isRemovable else { return nil }
        return { onRemove(attachment.id) }
    }

    private func state(for attachment: PendingAttachment) -> AttachmentChip.Appearance {
        switch attachment.state {
        case .uploading: .converting
        case .failed: .failed
        case let .ready(message, carried):
            .thumbnail(thumbnail(message.id) ?? carried)
        }
    }

    /// The second line: how many pages arrived, and nothing else.
    ///
    /// Nothing for a one-page file, because "1 page" is noise on a chip that already shows
    /// the file's name. Nothing while it converts, because the ring is already saying it.
    ///
    /// **And nothing when it fails**, which is the one that had to be taken back out. The
    /// server's refusal is a sentence written to tell a learner what to do instead — *"That
    /// file is too large, try a photo of one page at a time"* — and this lane is 84 points
    /// wide at 15pt with one line, so it arrived as three words and an ellipsis: enough to
    /// know something broke and not enough to know what. It goes to the note line above the
    /// pill instead, which board 15 §02 draws full-width for exactly this and which the
    /// composer already announces to VoiceOver when it appears. See
    /// `ComposerAttachments.failureNote`. The chip is still visibly the failed one.
    private func subtitle(for attachment: PendingAttachment) -> String? {
        switch attachment.state {
        case .uploading, .failed: nil
        case let .ready(message, _):
            message.pageCount > 1 ? "\(message.pageCount) pages" : nil
        }
    }
}

/// One chip: a thumbnail box, a name, and the ✕ that takes it back.
///
/// The states are appearances of *one shape*, not several layouts — task 8 §4 is explicit
/// that the converting chip is an "identical box, so nothing reflows when conversion
/// finishes". A chip that resized when its upload landed would move the row under the
/// finger already reaching for the ✕ beside it.
///
/// The label is `--color-ink` and the ✕ is `--color-icon`, where the attached-selection
/// card draws both in `--color-brand` (§7.3): a filename is content rather than a state,
/// and the card can hold several of them now. The chip's own fill is `--color-surface`, so
/// each one reads as a separate removable object on the tinted card (§7.4).
struct AttachmentChip: View {
    enum Appearance: Equatable {
        /// The upload is in flight. The whole of "converting" — there is no server-side
        /// status to poll.
        case converting
        case thumbnail(Data?)
        case failed
        /// The board region, which has no file and no thumbnail — the marquee glyph stands
        /// in for one.
        case selection
    }

    let title: String
    let subtitle: String?
    let state: Appearance
    let metrics: AttachmentChipMetrics
    /// `nil` renders no ✕ at all, which is the sent-message case — the same rule
    /// `SelectionCard` follows.
    var onRemove: (() -> Void)?

    /// `chip/converting`'s ring, in the drawing's own numbers: an 18pt slot holding a
    /// 6.6-radius arc at 2.4 stroke, swept 270°.
    ///
    /// One size at both scales. It sits inside a box that does step (32 → 38), and the
    /// drawing gives one ring — the same call `ui/plus` gets, which renders 20 in both
    /// composers rather than being scaled up to match its neighbours.
    enum Ring {
        static let slot: CGFloat = 18
        static let radius: CGFloat = 6.6
        static let stroke: CGFloat = 2.4
        /// 270 ÷ 360.
        static let sweep: CGFloat = 0.75
        /// **Not from the design.** Paper draws one static frame of an indeterminate
        /// indicator, and a 270° arc that never moves reads as a broken ring rather than
        /// as work in progress. One turn a second, linear, like every other indeterminate
        /// mark in the product.
        static let period: TimeInterval = 1
    }

    @State private var spinning = false

    var body: some View {
        HStack(spacing: metrics.gap) {
            preview
                .frame(width: metrics.thumbnailSize, height: metrics.thumbnailSize)
                .clipShape(RoundedRectangle(cornerRadius: metrics.thumbnailRadius))

            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: title)
                    .textStyle(metrics.labelStyle)
                    .foregroundStyle(titleColor)
                    .lineLimit(1)
                    // Tail, per task 8 §7.7, even though a middle truncation would keep the
                    // extension: the drawing states the treatment and this is not the place
                    // to improve on it.
                    .truncationMode(.tail)
                if let subtitle {
                    Text(verbatim: subtitle)
                        .textStyle(ComposerMetrics.noteStyle)
                        .foregroundStyle(DS.Color.inkSecondary)
                        .lineLimit(1)
                }
            }
            .frame(width: metrics.labelWidth, alignment: .leading)

            if let onRemove {
                Button(action: onRemove) {
                    IconView(.composerDismiss, size: metrics.dismissSize, tint: DS.Color.icon)
                        // 14 points is far under Apple's 44, and the row's arithmetic must
                        // not move: given back as negative padding, exactly as the marquee
                        // in the pill below already does.
                        .expandedTapTarget(ComposerMetrics.minimumTapTarget, over: metrics.dismissSize)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(title)")
            }
        }
        .padding(.leading, metrics.paddingLeading)
        .padding(.trailing, metrics.paddingTrailing)
        .frame(
            width: metrics.width(removable: onRemove != nil),
            height: metrics.height,
            alignment: .leading
        )
        .background(DS.Color.surface, in: RoundedRectangle(cornerRadius: metrics.radius))
        .accessibilityElement(children: .combine)
        .accessibilityValue(Self.value(for: state))
    }

    /// What the chip's mark says, for a learner who cannot see it. The filename is the
    /// label and does not move; this is the state beside it — Apple's own split, and the
    /// one `ComposerVoiceButton` already follows.
    ///
    /// It carries more weight than it looks now that the failed chip has no sentence on it:
    /// the box's grey and its cross are the whole of that state on screen, and this is the
    /// whole of it in the other modality. The refusal's *words* arrive through the note
    /// line, which the composer announces separately.
    static func value(for state: Appearance) -> String {
        switch state {
        case .converting: "Converting"
        case .failed: "Failed"
        case .thumbnail, .selection: ""
        }
    }

    /// The filename drops to `--color-ink-tertiary` while the file converts and comes back
    /// to `--color-ink` when it lands — the one thing about a converting chip that does
    /// change, and it changes no geometry.
    private var titleColor: Color {
        state == .converting ? DS.Color.inkTertiary : DS.Color.ink
    }

    @ViewBuilder
    private var preview: some View {
        switch state {
        case .converting:
            ring
        case let .thumbnail(data):
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                // A ready attachment always carries its thumbnail, so this is the chip for
                // one whose bytes did not decode: the box that would have held a picture,
                // rather than a chip that has visibly lost a part.
                DS.Color.brandTint
            }
        case .failed:
            // Undrawn — task 8 draws the chip and the converting chip and stops there. The
            // bubble grey stands in for the picture that never arrived, and the cross on it
            // is now the whole of "this one did not work" on screen, since the sentence
            // moved to the note line. `--color-incorrect` rather than `--color-icon` so it
            // does not read as a second dismiss control beside the real one.
            IconView(.uiCross, size: metrics.dismissSize, tint: DS.Color.incorrect)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(DS.Color.surfaceBubble)
        case .selection:
            IconView(.uiSelectionMarker, tint: DS.Color.brand)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(DS.Color.brandTint)
        }
    }

    /// Arc over track, both on the tint box the drawing puts behind them.
    private var ring: some View {
        ZStack {
            Circle()
                .stroke(DS.Color.surface, lineWidth: Ring.stroke)
            Circle()
                .trim(from: 0, to: Ring.sweep)
                .stroke(DS.Color.brand, style: StrokeStyle(lineWidth: Ring.stroke, lineCap: .round))
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(
                    .linear(duration: Ring.period).repeatForever(autoreverses: false),
                    value: spinning
                )
        }
        .frame(width: 2 * Ring.radius, height: 2 * Ring.radius)
        .frame(width: Ring.slot, height: Ring.slot)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DS.Color.brandTint)
        .onAppear { spinning = true }
        .accessibilityHidden(true)
    }
}
