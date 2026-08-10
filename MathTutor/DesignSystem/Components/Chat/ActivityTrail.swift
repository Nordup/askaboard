import SwiftUI

/// What a turn did, shown above the reply — the record `state/thinking`'s three
/// dots cannot carry. Board 14 §04 ("Activity trail"), added 2026-08-10.
///
/// A reasoning turn at Max effort spends most of its length before the first
/// word of the reply — thinking, then reading the board, then drawing — and
/// the dots describe every second of that identically, which the design
/// calls out directly: *"a silent wait that long reads as a hang."* This is
/// what fills the wait: the reasoning as it streams, and a named row for
/// every tool the tutor reaches for. When the turn ends the same view
/// collapses to `Worked for 1m 15s ›`, tappable back open — the record
/// survives, it just stops sitting in the way of the answer.
///
/// This is also the one place in the product with a hairline rule around
/// content, and the design is explicit that it is an earned exception:
/// *"board 14's no-card rule holds everywhere else because the tutor's prose
/// is the only thing in the lane, and here it is not."*
struct ActivityTrailView: View {
    let trail: ActivityTrail
    /// The column this draws in — the panel's 301 today, the only width the
    /// design ever drew this at (board 14 draws every trail specimen at the
    /// 301 column, per `06-states-and-settings.md`'s "Open questions #10").
    /// Every other number here is fixed by the design; only this moves.
    let width: CGFloat
    /// A `view_board` step's rendered crop, looked up by the id
    /// `BoardCropStore` filed it under. `nil` for any id the store never
    /// wrote — an old session, or a render that failed — and a missing crop
    /// draws the step's label alone. A broken-image box would be a worse
    /// answer than no picture at all.
    let crop: (UUID) -> Data?

    /// Whether the body is showing under the closed summary.
    ///
    /// Seeded once, from whether the turn had already finished the moment
    /// this view first appeared: a turn still running has no duration to
    /// summarise, so it opens with nothing to close. That is the only thing
    /// the initial value has to get right — `onChange` below is what
    /// handles a turn finishing *while this view stays on screen*, which a
    /// `@State` initial value cannot see because it only runs once.
    @State private var isExpanded: Bool

    init(trail: ActivityTrail, width: CGFloat, crop: @escaping (UUID) -> Data?) {
        self.trail = trail
        self.width = width
        self.crop = crop
        _isExpanded = State(initialValue: trail.duration == nil)
    }

    /// The closed row's text, or `nil` for a turn that never finished.
    ///
    /// Minutes are dropped below sixty seconds rather than shown as `0m 8s`,
    /// which is how every reader states a short duration.
    static func summaryLabel(for trail: ActivityTrail) -> String? {
        guard let duration = trail.duration else { return nil }
        let total = Int(duration.rounded())
        let minutes = total / 60
        let seconds = total % 60
        if minutes == 0 { return "Worked for \(seconds)s" }
        return "Worked for \(minutes)m \(seconds)s"
    }

    var body: some View {
        let summary = Self.summaryLabel(for: trail)

        VStack(alignment: .leading, spacing: 0) {
            if let summary {
                summaryRow(summary)
            }
            if isExpanded {
                openBody
                    .padding(.top, summary == nil ? 0 : DS.Space.s3)
            }
        }
        .frame(width: width, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
        // A `@State` initial value only fires on first appearance, so a
        // trail that was open while streaming needs this to notice the
        // live nil-to-value transition and close itself: board 14, "When
        // the turn ends it collapses to a single line."
        .onChange(of: trail.duration) { _, newValue in
            if newValue != nil { isExpanded = false }
        }
    }

    // MARK: - Closed / summary row

    /// `state/trail · closed` — and also the tappable header once a
    /// finished trail has been reopened. The design draws no separate
    /// "open, with its own header" specimen; this is the one row that
    /// exists in both states, so it is the row that stays on screen and
    /// just rotates. Board 14: *"The chevron points right when closed and
    /// down when open, which is why it is the existing `ui/chevron-down`
    /// under a rotation rather than a new right-facing glyph."*
    private func summaryRow(_ text: String) -> some View {
        Button {
            isExpanded.toggle()
        } label: {
            HStack(spacing: DS.Space.s1) {
                Text(text)
                    .textStyle(.trailLabel)
                    .foregroundStyle(DS.Color.inkSecondary)
                IconView(.uiChevronDown, size: Self.chevronSize)
                    .rotationEffect(.degrees(isExpanded ? 0 : -90))
            }
            .frame(height: DS.Leading.control, alignment: .center)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Open body

    /// `state/trail · open`: the hairline rule, its 12pt inset, and one row
    /// per item — reasoning bare, a step named with its icon.
    private var openBody: some View {
        VStack(alignment: .leading, spacing: DS.Space.s3) {
            ForEach(trail.items) { item in
                row(for: item)
            }
        }
        .padding(.leading, DS.Space.s3)
        // `--color-ink-tertiary`, not `--color-divider`: at roughly 1.06:1
        // against `--color-surface-panel` the divider colour does not
        // render, and this rule is the only thing grouping the trail —
        // which is the whole reason board 14 grants it the one
        // hairline-groups-content exception in the product. Drawn as a
        // full-height overlay rather than a leading child so its height
        // follows the VStack's own hugging height with nothing to keep in
        // sync.
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(DS.Color.inkTertiary)
                .frame(width: 1)
        }
    }

    @ViewBuilder
    private func row(for item: TrailItem) -> some View {
        switch item {
        case let .reasoning(_, text):
            Text(text)
                .textStyle(.trailReasoning)
                .foregroundStyle(DS.Color.inkSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case let .step(step):
            stepRow(step)
        }
    }

    /// A named tool call. The icon slot is fixed-width even though every
    /// step today has an icon — board 14: *"the lane is the point"* — a
    /// short label and a long one still start their icons on one vertical
    /// line, and an unrecognised tool name still reserves it empty rather
    /// than collapsing the row.
    private func stepRow(_ step: TrailStep) -> some View {
        HStack(alignment: .top, spacing: DS.Space.s2) {
            iconSlot(for: step.tool)
            VStack(alignment: .leading, spacing: DS.Space.s3) {
                Text(step.label)
                    .textStyle(.trailLabel)
                    .foregroundStyle(DS.Color.inkSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // Board 14's own tile, reused whole rather than re-derived:
                // `BoardViewThumbnail` already carries the hairline overlay
                // a crop needs against a panel two parts in 255 away from
                // its own fill, and the indent this table calls "24 onto
                // the label lane" falls out for free by nesting the tile
                // here, after the icon slot and its gap, rather than by
                // computing 16 + 8 anywhere. `onOpen: nil`: nothing here
                // makes a crop bigger, and a step with no crop simply
                // never reaches this branch — the missing-bytes fallback
                // inside `BoardViewThumbnail` is for a decode failure, not
                // for an id `BoardCropStore` never wrote.
                if let imageID = step.imageID, let data = crop(imageID) {
                    BoardViewThumbnail(view: BoardView(imageData: data, detail: step.label), onOpen: nil)
                }
            }
        }
    }

    /// A fixed 16 × 22 box regardless of whether the tool is one the design
    /// named. An unrecognised tool draws nothing inside it rather than a
    /// fallback glyph, but the slot itself never collapses — the lane is
    /// what keeps every row's label starting on the same vertical line.
    @ViewBuilder
    private func iconSlot(for tool: String) -> some View {
        ZStack {
            if let icon = Self.icon(for: tool) {
                IconView(icon, size: Self.iconWidth)
            }
        }
        .frame(width: Self.iconWidth, height: DS.Leading.control, alignment: .center)
    }

    /// TOOL NAME → ICON, from board 14 §04: `update_board` draws,
    /// `view_board` looks, `search_memory` and `recent_sessions` both
    /// search (one asset, two callers — the icon set does not distinguish
    /// what was searched), `set_workspace` plans, `remember` notes, and
    /// `record_evidence` reuses the evaluation check rather than a seventh
    /// glyph. Anything else is a tool the design never named.
    private static func icon(for tool: String) -> Icon? {
        switch tool {
        case "update_board": .toolPen
        case "view_board": .trailEye
        case "search_memory", "recent_sessions": .trailSearch
        case "set_workspace": .trailPlan
        case "remember": .trailNote
        case "record_evidence": .uiCheck
        default: nil
        }
    }

    private static let iconWidth: CGFloat = 16
    private static let chevronSize: CGFloat = 16

    // MARK: - Accessibility

    /// The tool calls, not the reasoning: reasoning is prose VoiceOver
    /// already reads a line at a time, but a step is a thing that needs
    /// naming as a count — the same reasoning `BoardViewsRow` names how
    /// many regions it drew rather than reading each thumbnail's caption
    /// as the group's own label.
    private var stepCount: Int {
        trail.items.reduce(into: 0) { count, item in
            if case .step = item { count += 1 }
        }
    }

    private var accessibilityLabel: String {
        switch stepCount {
        case 0: "What the tutor was thinking"
        case 1: "What the tutor did: one step"
        default: "What the tutor did: \(stepCount) steps"
        }
    }
}
