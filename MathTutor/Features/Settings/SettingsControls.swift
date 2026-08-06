import SwiftUI

/// The three surfaces boards 10–13 add to the system, and the one rule that tells them
/// apart: **all three are the same shape, and only the fill says what will happen.**
///
/// - raised white + elevation 03 → safe and tappable (`select/option · default`)
/// - `--color-brand-tint` → the chosen one (`select/option · selected`)
/// - `--color-surface-bubble` with **no shadow** → destructive (`btn/destructive`)
///
/// That last one is the system's answer to a destructive action. Everything safe is lifted
/// off the surface; the things that destroy are the only things that sit *in* it. Board 10
/// spends no colour on it at all — *"the component is named `btn/destructive`, but it
/// carries no red, no colour, and no visual danger signal at all… the entire destructive
/// signal is carried by the section heading ('Irreversible') and the caption."*
///
/// `DS.Color.incorrect` is **not** available here and its own token description says so:
/// *"NOT for destructive, warning or validation UI."*

// MARK: - btn/primary

/// The one new violet moment in the system.
///
/// Foundations rule 2 allows brand colour in exactly three places — the send button, the
/// selected tool slot, and the attachment label. The design had no way to say *"this is the
/// primary action"* for anything but send, so board 11 spends a fourth: a brand-filled pill,
/// at two scales. There is no fifth. Anything else that wants to look important is a
/// suggestion chip, which is what board 14 means by *"the violet budget is spent
/// elsewhere."*
///
/// **No disabled state.** Board 11 draws the button because there is something to do, and
/// removes the composer entirely rather than greying one out — *"there is no disabled state
/// anywhere in this system."*
struct PrimaryButtonMetrics: Equatable, Sendable {
    let scale: ChatScale
    /// The column the button is laid out in. The panel button fills it; the full-screen one
    /// only needs to know it is inside it.
    let columnWidth: CGFloat
    /// Panel: fills the column. Full screen: `align-self: flex-start` and hugs its label, so
    /// the CTA is deliberately lighter than the composer above it.
    let fillsColumn: Bool
    let height: CGFloat
    /// 0 in the panel — *"the label is centred, not inset"*.
    let paddingInline: CGFloat
    let labelStyle: DS.TextStyle
    /// Identical at both scales, and the same level a chip takes.
    let elevation: Elevation = .control

    /// What the button hands `.frame`: the column in the panel, and nothing full screen,
    /// where the width is the label's own.
    var frameWidth: CGFloat? { fillsColumn ? columnWidth : nil }

    /// The measured 220 for `Start on the board`: label 156 + 32 × 2.
    func width(labelWidth: CGFloat) -> CGFloat { labelWidth + 2 * paddingInline }
}

extension PrimaryButtonMetrics {
    /// The button in a column of `width`.
    ///
    /// The height, the inset and the label are the scale's and hold. What the column decides
    /// is only what `fillsColumn` already said it decides — how wide a filled button is — and
    /// the panel's 301 was the design's column rather than a property of the button.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        let column = max(0, width)
        switch scale {
        case .panel:
            return Self(
                scale: .panel,
                columnWidth: column,
                fillsColumn: true,
                // **58 is derived, not free**: it is the panel composer's height, so the
                // button occupies the composer's slot exactly when the composer is not there.
                height: ComposerMetrics.panel.height,
                paddingInline: 0,
                labelStyle: TextStyle(size: DS.Size.body, leading: DS.Leading.control, weight: .semibold)
            )
        case .fullScreen:
            return Self(
                scale: .fullScreen,
                columnWidth: column,
                fillsColumn: false,
                // 64 *is* free — and pointedly not the full-screen composer's 80.
                height: 64,
                paddingInline: DS.Space.s8,
                labelStyle: TextStyle(size: DS.Size.bodyLarge, leading: DS.Leading.snug, weight: .semibold)
            )
        }
    }

    /// Board 11's no-key CTA and board 12's plan tail, in the 301pt column both were drawn in.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }

    /// Board 13's plan tail, in the 740pt column it was drawn in.
    static var fullScreen: Self { .for(.fullScreen, width: DS.Container.column) }

    static func `for`(_ scale: ChatScale) -> Self { .for(scale, width: scale.contentWidth) }
}

struct PrimaryButton: View {
    let title: String
    var scale: ChatScale = .panel
    /// The column the button is laid out in — it fills it in the panel. `nil` takes the one
    /// the design drew this scale in.
    var width: CGFloat?
    let action: () -> Void

    private var metrics: PrimaryButtonMetrics { .for(scale, width: width ?? scale.contentWidth) }

    var body: some View {
        Button(action: action) {
            Text(verbatim: title)
                .textStyle(metrics.labelStyle)
                // `#FFFFFF` literal in the design. `DS.Color.surface` is that same white
                // with a name — the substitution `IconView` already makes for
                // `composer/send`, and for the same reason: a label handed the default ink
                // would vanish into the violet under it.
                .foregroundStyle(DS.Color.surface)
                .lineLimit(1)
                .padding(.horizontal, metrics.paddingInline)
                .frame(width: metrics.frameWidth, height: metrics.height)
                // `--radius-full` on a 58 or 64pt box: a capsule, never a corner value.
                .background(DS.Color.brand, in: Capsule())
                .elevation(metrics.elevation)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - btn/destructive

/// Bubble grey, flat, and irreversible.
///
/// The absence of a shadow is the whole signal. Board 10 draws no pressed state, no disabled
/// state and — deliberately — **no confirmation dialog**: *"'cannot be undone' is asserted,
/// but no dialog exists"*, and this system has no modal pattern to put one in. The warning
/// lives in the section heading and caption above the row.
enum DestructiveButtonMetrics {
    /// A third control height, matching neither `btn/primary`'s 58 nor a chip's 62.
    static let height: CGFloat = 56
    /// Component-internal, and written as a literal exactly as the design writes it. It
    /// happens to equal `--space-edge`, but binding it to that token would move a button's
    /// padding the day the screen's edge inset moves — Foundations rule 11.
    static let paddingInline: CGFloat = 28
    static let fill = DS.Color.surfaceBubble
    /// **No elevation.** This is the only control in the product that has none.
    static let elevation: Elevation? = nil
    static let labelStyle = TextStyle(size: DS.Size.body, leading: DS.Leading.control, weight: .medium)
    /// `--spacing-4` between the two buttons on board 10's Actions row.
    static let rowGap = DS.Space.s4

    /// `"Remove API key"` 114 + 28 × 2 = 170 · `"Reset this session"` 127 + 28 × 2 = 183.
    static func width(labelWidth: CGFloat) -> CGFloat { labelWidth + 2 * paddingInline }
}

struct DestructiveButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(verbatim: title)
                .textStyle(DestructiveButtonMetrics.labelStyle)
                .foregroundStyle(DS.Color.ink)
                .lineLimit(1)
                .padding(.horizontal, DestructiveButtonMetrics.paddingInline)
                .frame(height: DestructiveButtonMetrics.height)
                .background(DestructiveButtonMetrics.fill, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - select/option

/// The board's one genuinely new surface, and its two states.
///
/// *"Exactly two — `default` and `selected`. The only difference is the fill. No border, no
/// ring, no checkmark, no weight change, no shadow change."* Which makes the selection
/// invisible to VoiceOver unless the trait is set, so `SelectOption` sets it.
enum SelectOptionMetrics {
    /// **236 is derived**: `(740 − 16 × 2) ÷ 3`, the only width that fits three across the
    /// column at a `--spacing-4` gap. 90 is free — it is what the child stack needs.
    static let size = CGSize(width: 236, height: 90)
    static let paddingBlock: CGFloat = 20
    /// Off the 4px scale, and no token — component-internal, per Foundations rule 11.
    static let paddingInline: CGFloat = 22
    /// `--radius-lg`, the same 14 the suggestion chips and the selected tool slot take.
    static let radius = DS.Radius.lg
    /// Elevation 03 in **both** states.
    static let elevation: Elevation = .control
    /// 20 / 24 · 500 — identical in both states.
    static let titleStyle: DS.TextStyle = .chipFullScreen
    /// 17 / 22 · 400 · secondary — identical in both states.
    static let captionStyle: DS.TextStyle = .bodyControl
    static let captionTopMargin = DS.Space.s1
    /// Between options, on both axes. Board 10's 2 × 3 effort grid is a wrapped 740 row.
    static let gap = DS.Space.s4
    static let columns = 3

    /// `(740 − 16 × 2) ÷ 3 = 236`.
    static func width(inColumn column: CGFloat, across count: Int = columns) -> CGFloat {
        (column - gap * CGFloat(count - 1)) / CGFloat(count)
    }

    /// `20 + 24 + 4 + 22 + 20 = 90`.
    static var stackedHeight: CGFloat {
        2 * paddingBlock + titleStyle.leading + captionTopMargin + captionStyle.leading
    }

    /// `236 − 22 × 2 = 192`.
    static var contentWidth: CGFloat { contentWidth(for: size.width) }

    /// The same subtraction in an option of any width. The two paddings are the design's and
    /// hold; the label's measure is what gives, which is the only direction a measure moves.
    static func contentWidth(for width: CGFloat) -> CGFloat { max(0, width - 2 * paddingInline) }

    /// `90 × 2 + 16 = 196` — the effort grid.
    static func gridHeight(rows: Int) -> CGFloat {
        CGFloat(rows) * size.height + CGFloat(rows - 1) * gap
    }

    /// The one thing that changes between the two states.
    static func fill(isSelected: Bool) -> Color {
        isSelected ? DS.Color.brandTint : DS.Color.surface
    }
}

struct SelectOption: View {
    let title: String
    let caption: String
    let isSelected: Bool
    /// The option's own width — `width(inColumn:)` of whatever column the section is in.
    /// `nil` takes the 236 the design drew, which is that function at 740.
    var width: CGFloat?
    let action: () -> Void

    private var optionWidth: CGFloat { width ?? SelectOptionMetrics.size.width }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: title)
                    .textStyle(SelectOptionMetrics.titleStyle)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)

                Text(verbatim: caption)
                    .textStyle(SelectOptionMetrics.captionStyle)
                    .foregroundStyle(DS.Color.inkSecondary)
                    .lineLimit(1)
                    .padding(.top, SelectOptionMetrics.captionTopMargin)
            }
            .frame(width: SelectOptionMetrics.contentWidth(for: optionWidth), alignment: .leading)
            .padding(.vertical, SelectOptionMetrics.paddingBlock)
            .padding(.horizontal, SelectOptionMetrics.paddingInline)
            .frame(
                width: optionWidth,
                height: SelectOptionMetrics.size.height,
                alignment: .leading
            )
            .background(
                SelectOptionMetrics.fill(isSelected: isSelected),
                // `.circular`, not `.continuous`: the design's radii are CSS corners.
                in: RoundedRectangle(cornerRadius: SelectOptionMetrics.radius, style: .circular)
            )
            .elevation(SelectOptionMetrics.elevation)
        }
        .buttonStyle(.plain)
        // The fill is the only visual difference between the two states, so without this
        // the selected option is indistinguishable from the other five to a screen reader.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
