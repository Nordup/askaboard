import SwiftUI

/// Board 15a's session switcher: the open session's name in `Panel controls`,
/// and the menu it drops.
///
/// The name is not decoration. Before this existed the panel gave no signal at
/// all about *which* session was on screen, which was survivable while there
/// could only ever be one. The switcher is the reason there can be more than
/// one, so the label and the control are the same element.
enum SessionSwitcherMetrics {
    /// The header lane between `Layout controls` (78) and `btn/settings` (32) on
    /// the 301pt content row, less the 8pt the design leaves either side of the
    /// title so the three groups never touch.
    ///
    /// Derived, like every other width inside the panel — board 02: hard-coding
    /// 301 *"is a bug waiting for the first panel-width change"*, and this is one
    /// subtraction further along the same chain.
    static func titleMaxWidth(for contentWidth: CGFloat) -> CGFloat {
        let flanks = layoutControlsWidth + TutorPanelMetrics.controlButton + 2 * lane
        return max(0, contentWidth - flanks)
    }

    /// Where the title's lane starts, measured from the row's leading edge.
    ///
    /// The title is placed from the left rather than centred in the row, and the
    /// difference is not cosmetic: the flanks are 32 and 78, so a box centred in
    /// the row sits 23pt right of the lane between them and its leading edge —
    /// and its *tap target* — reaches back over `btn/settings`. A centred title
    /// would silently eat taps meant for the gear.
    ///
    /// The gear is the leading flank now, not the layout pair: the row mirrored
    /// with the shell, and this is the one number in it that names a side.
    static var titleLaneLeading: CGFloat { TutorPanelMetrics.controlButton + lane }

    /// `Layout controls`: two 32pt buttons on a 14pt gap.
    static var layoutControlsWidth: CGFloat {
        2 * TutorPanelMetrics.controlButton + TutorPanelMetrics.controlsGap
    }

    private static let lane = DS.Space.s2

    static let titleHeight = TutorPanelMetrics.controlsHeight
    static let titlePaddingInline: CGFloat = 10
    static let titleGap: CGFloat = 6

    /// The gap between the controls row and the menu hanging off it.
    static let menuTopGap = DS.Space.s2
    static let menuPadding = DS.Space.s2
    static let menuRowGap = DS.Space.s1
    static let rowHeight: CGFloat = 44
    static let rowPaddingInline = DS.Space.s3
    static let rowGap = DS.Space.s2
    static let newSessionGap: CGFloat = 10

    /// The trailing lane every row's meta text sits in, so "Open", "2h ago" and
    /// "Yesterday" share one right edge across rows of different title lengths.
    /// A fixed slot rather than a gap, for the reason every repeated row in this
    /// design system uses one.
    static let metaWidth: CGFloat = 78

    // MARK: - Type

    /// 17 / 22 at the weight the row's state asks for. The menu's rows are
    /// controls, not prose, so they take the control leading the composer's
    /// placeholder does rather than the 25 running text uses.
    static func rowTitle(current: Bool) -> TextStyle {
        TextStyle(size: DS.Size.body, leading: DS.Leading.control, weight: current ? .semibold : .medium)
    }

    static let newSessionLabel = TextStyle(
        size: DS.Size.body,
        leading: DS.Leading.control,
        weight: .semibold
    )

    /// 15 / 18. Semibold for the open session, whose meta is a state
    /// ("Open") rather than a measurement, and regular for the rest.
    ///
    /// **15, not the 13 board 15a was drawn at.** `--text-label` is the floor:
    /// *"The smallest size in the product — nothing goes below this."* The
    /// mockup has been corrected to match rather than the other way round.
    static func rowMeta(current: Bool) -> TextStyle {
        current ? .label : TextStyle(size: DS.Size.label, leading: DS.Leading.label, weight: .regular)
    }
}

/// `btn/session-title` — the open session's name, and the control that drops the
/// switcher.
struct SessionTitleButton: View {
    let title: String
    let isOpen: Bool
    let maxWidth: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: SessionSwitcherMetrics.titleGap) {
                Text(title)
                    .textStyle(.label)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                IconView(.uiChevronDown)
                    .rotationEffect(.degrees(isOpen ? 180 : 0))
            }
            .padding(.horizontal, SessionSwitcherMetrics.titlePaddingInline)
            .frame(maxWidth: maxWidth)
            .frame(height: SessionSwitcherMetrics.titleHeight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Session: \(title)")
        .accessibilityHint("Switch sessions, or start a new one")
    }
}

/// `menu/sessions` — the card that drops under the title.
///
/// Drawn on `.modal` rather than a shadow of its own: it is a surface floating
/// over the panel's own content, which is the one thing the product's fifth
/// elevation is for. Nothing here invents a sixth.
struct SessionMenu: View {
    let sessions: [SessionSummary]
    let currentID: UUID
    let width: CGFloat
    let onNew: () -> Void
    let onOpen: (UUID) -> Void

    /// How many rows the menu shows.
    ///
    /// The design was drawn for a handful and the list has no scroller, so this
    /// is the floor under that assumption rather than a preference: a learner on
    /// their thirtieth session gets the six most recent and a menu that still
    /// fits the panel. See `docs/TODO.md` — the list needs a real answer before
    /// it needs a bigger number here.
    static let visibleRows = 6

    /// The six most recent, plus the open session if it is not among them.
    ///
    /// Rows are ordered by when a session was last modified and the open one
    /// gets no special place, so once you have seven sessions and go back to an
    /// old one, the session you are *in* can fall past the window. A switcher
    /// that omits the current session is worse than one row too long, so it is
    /// appended rather than dropped.
    private var rows: [SessionSummary] {
        let visible = Array(sessions.prefix(Self.visibleRows))
        guard !visible.contains(where: { $0.id == currentID }),
              let current = sessions.first(where: { $0.id == currentID })
        else { return visible }
        return visible + [current]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SessionSwitcherMetrics.menuRowGap) {
            newSessionRow
            Rectangle()
                .fill(DS.Color.divider)
                .frame(height: 1)
                .padding(.horizontal, SessionSwitcherMetrics.rowPaddingInline)
            ForEach(rows) { summary in
                row(summary)
            }
        }
        .padding(SessionSwitcherMetrics.menuPadding)
        .frame(width: width, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.lg).fill(DS.Color.surface)
        )
        .elevation(.modal)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sessions")
    }

    private var newSessionRow: some View {
        Button(action: onNew) {
            HStack(spacing: SessionSwitcherMetrics.newSessionGap) {
                IconView(.uiPlus, tint: DS.Color.brand)
                Text("New session")
                    .textStyle(SessionSwitcherMetrics.newSessionLabel)
                    .foregroundStyle(DS.Color.brand)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, SessionSwitcherMetrics.rowPaddingInline)
            .frame(height: SessionSwitcherMetrics.rowHeight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New session")
    }

    private func row(_ summary: SessionSummary) -> some View {
        let isCurrent = summary.id == currentID
        let meta = isCurrent ? "Open" : Self.relativeAge(of: summary.lastSavedAt)
        return Button { onOpen(summary.id) } label: {
            HStack(spacing: SessionSwitcherMetrics.rowGap) {
                Text(summary.title)
                    .textStyle(SessionSwitcherMetrics.rowTitle(current: isCurrent))
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                Text(meta)
                    .textStyle(SessionSwitcherMetrics.rowMeta(current: isCurrent))
                    .foregroundStyle(isCurrent ? DS.Color.brand : DS.Color.inkTertiary)
                    .lineLimit(1)
                    .frame(width: SessionSwitcherMetrics.metaWidth, alignment: .trailing)
            }
            .padding(.horizontal, SessionSwitcherMetrics.rowPaddingInline)
            .frame(height: SessionSwitcherMetrics.rowHeight)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.sm)
                    .fill(isCurrent ? DS.Color.brandTintSoft : Color.clear)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(summary.title)
        .accessibilityValue(meta)
    }

    /// How long ago a session was last written, in the switcher's own words.
    ///
    /// Hand-rolled rather than `RelativeDateTimeFormatter` because the row has a
    /// 78pt lane: the formatter says "1 hour ago" where this says "1h ago", and
    /// "Yesterday" is the one case worth spelling out because a learner reads it
    /// as a different kind of fact than a count of hours.
    static func relativeAge(of date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        let seconds = now.timeIntervalSince(date)
        // A clock that moved backwards, or a session saved in the same instant
        // it is being drawn. Neither is worth a negative age.
        guard seconds >= 60 else { return "Now" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes)m ago" }
        if calendar.isDateInToday(date) { return "\(minutes / 60)h ago" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let days = calendar.dateComponents([.day], from: date, to: now).day ?? 0
        if days < 7 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}

#if DEBUG
#Preview("Session switcher") {
    let now = Date.now
    let current = UUID()
    return VStack(alignment: .leading, spacing: DS.Space.s2) {
        SessionTitleButton(
            title: "Vectors in 2D",
            isOpen: true,
            maxWidth: SessionSwitcherMetrics.titleMaxWidth(for: TutorPanelMetrics.contentWidth),
            action: {}
        )
        SessionMenu(
            sessions: [
                SessionSummary(id: current, title: "Vectors in 2D", lastSavedAt: now, messageCount: 8),
                SessionSummary(id: UUID(), title: "Radical equations", lastSavedAt: now.addingTimeInterval(-7_200), messageCount: 14),
                SessionSummary(id: UUID(), title: "Trig identities", lastSavedAt: now.addingTimeInterval(-93_600), messageCount: 6),
                SessionSummary(id: UUID(), title: "Quadratics", lastSavedAt: now.addingTimeInterval(-300_000), messageCount: 21)
            ],
            currentID: current,
            width: TutorPanelMetrics.contentWidth,
            onNew: {},
            onOpen: { _ in }
        )
    }
    .padding(44)
    .background(DS.Color.surfacePanel)
}
#endif
