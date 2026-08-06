import SwiftUI

/// The four openers, in the order the design lists them.
///
/// Board 03: *"Openers for a student who does not yet know what to ask."* Copy and glyph
/// are the same at both scales — screens 05 and 07 draw the same four items — so this is
/// one data source, not two.
enum Suggestion: String, CaseIterable, Identifiable, Sendable {
    case explain
    case example
    case exercise
    case confused

    var id: String { rawValue }

    var label: String {
        switch self {
        case .explain: "Explain this concept"
        case .example: "Give me an example"
        case .exercise: "Create an exercise"
        case .confused: "I don't understand this"
        }
    }

    var icon: Icon {
        switch self {
        case .explain: .chipExplain
        case .example: .chipExample
        case .exercise: .chipExercise
        case .confused: .chipConfused
        }
    }
}

/// Chip geometry at both scales. Board 03: *"They are icon-plus-label rows with no right
/// padding — the label ends where it ends, and the chip's width is set by its column, not
/// its content."*
struct SuggestionChipMetrics: Equatable, Sendable {
    /// One chip. Not a free value at either scale — it is what the sentence above says it
    /// is, the width of the column the chip lands in: the whole 301 in the panel, half of
    /// the 740 in the 2-up grid.
    let width: CGFloat
    let height: CGFloat
    /// `--radius-lg`. The one property that does not step with the scale: *"same as panel,
    /// deliberately not scaled"*.
    let radius: CGFloat
    /// Leading only. There is no trailing padding at either scale.
    let paddingLeading: CGFloat
    /// Icon → label.
    let gap: CGFloat
    let iconSize: CGFloat
    let labelStyle: DS.TextStyle
    /// Between chips, on both axes.
    let listGap: CGFloat
    /// 1 in the panel column, 2 in the reading column the design drew — and 1 again in a
    /// reading column too narrow to hold that pair. See `columns(_:in:)`.
    let columns: Int
    let containerWidth: CGFloat

    var rows: Int { Int((Double(Suggestion.allCases.count) / Double(columns)).rounded(.up)) }

    /// 4 × 62 + 3 × 10 = 278 in the panel; 2 × 74 + 20 = 168 in the reading column the design
    /// drew, and 4 × 74 + 3 × 20 = 356 where that column wrapped back to one chip a row.
    var containerHeight: CGFloat {
        CGFloat(rows) * height + CGFloat(rows - 1) * listGap
    }
}

extension SuggestionChipMetrics {
    /// The grid the design draws: a 1-up column in the panel, a 2 × 2 in the reading column.
    static func designColumns(_ scale: ChatScale) -> Int {
        switch scale {
        case .panel: 1
        case .fullScreen: 2
        }
    }

    /// `(740 − 20) ÷ 2 = 360` — the design's own 2-up split of its own column, and the reason
    /// the board can write *"360 × 2 + 20 = 740 exactly"*. 360 was never an independent
    /// number; it is what half a reading column comes to once the gap is taken out of it.
    static var fullScreenChipWidth: CGFloat { (DS.Container.column - DS.Space.s5) / 2 }

    /// How many chips a row of `width` actually holds.
    ///
    /// **The narrow reading column wraps to 1-up rather than shrinking the pair**, and the
    /// design decides that itself. Board 03 §8.2 gives the container as `flex-wrap: wrap`
    /// with `flex-shrink: 0` chips, and the blurb spells out why that matters: the grid is
    /// *"produced by wrapping a 740pt row, not by a grid definition, which matters if the
    /// copy ever grows."* `flex-shrink: 0` is CSS for "do not squeeze me to make us fit", and
    /// wrapping is the only other thing a flex row can do — so a row that cannot hold
    /// 360 + 20 + 360 puts one chip per line. The designer wrote that rule for copy that
    /// outgrows the row; a row that shrinks under the copy is the same event from the other
    /// side.
    ///
    /// The alternative — two columns of `(width − 20) ÷ 2` — would put the label of "I don't
    /// understand this" inside a 312pt chip on the narrowest column, against 62pt of icon,
    /// padding and gap, with `lineLimit(1)` and no measured label width anywhere on the
    /// board to say it fits. Wrapping keeps every chip at least as wide as the one the design
    /// measured, which is the same instinct as the bubble's cap: a measure may shrink, a
    /// single-line label may not.
    static func columns(_ scale: ChatScale, in width: CGFloat) -> Int {
        let design = designColumns(scale)
        guard design > 1 else { return 1 }
        let rowTheDesignDraws = CGFloat(design) * fullScreenChipWidth + CGFloat(design - 1) * DS.Space.s5
        return width >= rowTheDesignDraws ? design : 1
    }

    /// Board 03 §8: *"the chip's width is set by its column, not its content."* One rule,
    /// and both of the design's chips fall out of it — 301 ÷ 1 in the panel, (740 − 20) ÷ 2
    /// full-screen — which is also what makes a wrapped chip fill the reading column instead
    /// of sitting at 360 with 350pt of air beside it.
    static func chipWidth(columns: Int, listGap: CGFloat, in width: CGFloat) -> CGFloat {
        let columns = max(1, columns)
        return max(0, (width - listGap * CGFloat(columns - 1)) / CGFloat(columns))
    }

    /// The chip set in a column of `width`. Everything except the grid is a per-scale
    /// lookup — the board holds the radius still on purpose, and steps the rest.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        let container = max(0, width)
        let columns = columns(scale, in: container)
        switch scale {
        case .panel:
            let listGap: CGFloat = 10
            return Self(
                width: chipWidth(columns: columns, listGap: listGap, in: container),
                height: 62,
                radius: DS.Radius.lg,
                // 18, and deliberately not `--space-panel-inset`, which is also 18: board 01
                // rule 11 says component internals are tuned by eye and carry no token, so
                // binding this to a layout token would move the chip's padding the day the
                // panel's inset moves.
                paddingLeading: 18,
                gap: 14,
                iconSize: 22,
                // 17 / 22, not the type scale's `chipPanel` 17 / 24. Two boards measure 22 on
                // this node — `03 §8.1` and `14`'s recovery chip — so the leading is built
                // from the tokens the boards actually name rather than taken from the scale's
                // pairing.
                labelStyle: TextStyle(size: DS.Size.body, leading: DS.Leading.control, weight: .medium),
                listGap: listGap,
                columns: columns,
                containerWidth: container
            )
        case .fullScreen:
            return Self(
                width: chipWidth(columns: columns, listGap: DS.Space.s5, in: container),
                height: 74,
                radius: DS.Radius.lg,
                paddingLeading: 22,
                gap: DS.Space.s4,
                iconSize: 24,
                labelStyle: .chipFullScreen,
                listGap: DS.Space.s5,
                columns: columns,
                containerWidth: container
            )
        }
    }

    /// The design's own two: `301 × 62` stacked four deep, and `360 × 74` in a 2 × 2.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }
    static var fullScreen: Self { .for(.fullScreen, width: DS.Container.column) }

    static func `for`(_ scale: ChatScale) -> Self { .for(scale, width: scale.contentWidth) }
}

// MARK: - Views

/// *"Both scales carry elevation 03 so they read as tappable objects lying on the surface
/// rather than fields cut into it."*
///
/// The glyph's colour is injected rather than fixed, because board 14 reuses this component
/// verbatim for error recovery with exactly one override: *"recovery chips take
/// `var(--color-icon)`, not `var(--color-brand)`, because a repair is not a suggestion."*
/// Every box-model value stays the same, which is why that is a parameter and not a variant.
struct SuggestionChip: View {
    let icon: Icon
    let label: String
    var scale: ChatScale = .panel
    /// The **column** the chip is laid out in, not the chip's own width — a full-screen chip
    /// takes half of it where the grid is 2-up. `nil` takes the column the design drew.
    var width: CGFloat?
    var tint: Color = DS.Color.brand
    let action: () -> Void

    private var metrics: SuggestionChipMetrics { .for(scale, width: width ?? scale.contentWidth) }

    var body: some View {
        Button(action: action) {
            HStack(spacing: metrics.gap) {
                IconView(icon, size: metrics.iconSize, tint: tint)
                    .accessibilityHidden(true)

                Text(verbatim: label)
                    .textStyle(metrics.labelStyle)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)

                Spacer(minLength: 0)
            }
            .padding(.leading, metrics.paddingLeading)
            .frame(width: metrics.width, height: metrics.height, alignment: .leading)
            .background(
                DS.Color.surface,
                in: RoundedRectangle(cornerRadius: metrics.radius, style: .circular)
            )
            .elevation(.control)
        }
        .buttonStyle(.plain)
    }
}

extension SuggestionChip {
    /// The four openers, which are the only chips that take the brand glyph colour.
    init(
        suggestion: Suggestion,
        scale: ChatScale = .panel,
        width: CGFloat? = nil,
        action: @escaping () -> Void
    ) {
        self.init(icon: suggestion.icon, label: suggestion.label, scale: scale, width: width, action: action)
    }
}

/// All four chips: a column in the panel, a 2 × 2 in the reading column that wraps back to a
/// column when the reading column is too narrow to hold the pair.
///
/// The design produces the grid by wrapping a row; this lays the same result out explicitly,
/// with the column count resolved up front in `SuggestionChipMetrics.columns(_:in:)`. Same
/// result, but the block's height is a number the layout can be asked for before it is drawn,
/// which is what the greeting block needs to keep totalling 522.
struct SuggestionList: View {
    var scale: ChatScale = .panel
    /// The column the grid fills.
    var width: CGFloat?
    let onSelect: (Suggestion) -> Void

    private var column: CGFloat { width ?? scale.contentWidth }
    private var metrics: SuggestionChipMetrics { .for(scale, width: column) }

    var body: some View {
        VStack(spacing: metrics.listGap) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: metrics.listGap) {
                    ForEach(row) { suggestion in
                        SuggestionChip(suggestion: suggestion, scale: scale, width: column) {
                            onSelect(suggestion)
                        }
                    }
                }
            }
        }
        .frame(width: metrics.containerWidth, height: metrics.containerHeight, alignment: .topLeading)
    }

    private var rows: [[Suggestion]] {
        stride(from: 0, to: Suggestion.allCases.count, by: metrics.columns).map { start in
            Array(Suggestion.allCases[start ..< min(start + metrics.columns, Suggestion.allCases.count)])
        }
    }
}
