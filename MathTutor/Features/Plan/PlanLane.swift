import SwiftUI

/// The numbered lane — one primitive with a parameterised leading slot.
///
/// Board 14 says it outright: *"Lane: 22 slot + 14 gap + 265 text — identical to
/// `plan/outcome`, so the two align."* Three things ride it — a plan's steps, a plan's
/// outcomes, and an evaluation's findings — and the point of the shared geometry is that a
/// digit, a check and a cross all land on the same left edge.
///
/// The slot's height is the whole trick: it is one text line box, so the mark sits on the
/// first line of its row and a wrapped row stays top-aligned instead of centring against
/// two lines.
struct PlanLaneMetrics: Equatable, Sendable {
    /// 22 in the panel, 24 full screen.
    let slotWidth: CGFloat
    /// The line box the mark sits on: 25 (`--leading-body`) in the panel, 24
    /// (`--leading-snug`) full screen — each one its row's own leading.
    let slotHeight: CGFloat
    let gap: CGFloat
    let textWidth: CGFloat
    let textStyle: DS.TextStyle
    /// The digit. It steps 15 → 17 while the text steps 17 → 20, so **the number stays
    /// quieter than the text it labels at both scales.**
    let numberStyle: DS.TextStyle
    /// `ui/check`'s render size.
    let markSize: CGFloat

    /// `22 + 14 + 265 = 301` · `24 + 16 + 700 = 740` — the lane is exactly its column, at
    /// every column: `textWidth` is the column minus the slot and the gap, so adding them
    /// back gives the column. (Only a column too narrow to hold the slot and the gap at all
    /// breaks it, where the clamped text lane leaves the row its `slotWidth + gap` minimum
    /// rather than a negative frame.)
    var width: CGFloat { slotWidth + gap + textWidth }

    /// A row's height for a given wrap. Panel rows 1 and 3 of the board's steps are two
    /// lines; every full-screen row is one.
    func rowHeight(lines: Int) -> CGFloat { textStyle.leading * CGFloat(lines) }

    /// A stack of rows plus the gaps between them.
    func stackHeight(lines: [Int], gap: CGFloat) -> CGFloat {
        guard !lines.isEmpty else { return 0 }
        return lines.reduce(0) { $0 + rowHeight(lines: $1) } + gap * CGFloat(lines.count - 1)
    }
}

extension PlanLaneMetrics {
    /// The lane in a column of `width`.
    ///
    /// The slot, the gap, the two type styles and the mark are the scale's discrete treatment
    /// and hold still at every column — a lane in a 644pt reading column is still board 13's
    /// lane, not board 12's. **The text is the only child with give in it**, which is the same
    /// thing `flex-grow: 1` says about the composer's placeholder and the reason the boards'
    /// own arithmetic survives a narrower column: `22 + 14 + 265` and `24 + 16 + 700` are that
    /// subtraction run at 301 and 740.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        let column = max(0, width)
        switch scale {
        case .panel:
            let slotWidth: CGFloat = 22
            // 14, un-tokenised. It is the same 14 the panel-controls row and the chip's
            // icon→label gap already use, and Foundations rule 11 leaves component internals
            // off the token set.
            let gap: CGFloat = 14
            return Self(
                slotWidth: slotWidth,
                // Not a free 25 — it is the body leading, which is why the digit lines up with
                // the first line of its row.
                slotHeight: DS.Leading.body,
                gap: gap,
                textWidth: max(0, column - slotWidth - gap),
                textStyle: .body,
                numberStyle: TextStyle(size: DS.Size.label, leading: DS.Leading.body, weight: .semibold),
                markSize: 22
            )
        case .fullScreen:
            let slotWidth: CGFloat = 24
            let gap = DS.Space.s4
            return Self(
                slotWidth: slotWidth,
                slotHeight: DS.Leading.snug,
                gap: gap,
                textWidth: max(0, column - slotWidth - gap),
                textStyle: TextStyle(size: DS.Size.bodyLarge, leading: DS.Leading.snug, weight: .regular),
                numberStyle: TextStyle(size: DS.Size.body, leading: DS.Leading.snug, weight: .semibold),
                markSize: 24
            )
        }
    }

    /// Board 12's own column, and board 14's evaluation findings.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }

    /// Board 13's own column.
    static var fullScreen: Self { .for(.fullScreen, width: DS.Container.column) }

    static func `for`(_ scale: ChatScale) -> Self { .for(scale, width: scale.contentWidth) }

    /// **`--color-icon`, and deliberately not `--color-correct`.**
    ///
    /// `DS.Color.correct` exists now, and this is the most likely place for it to leak,
    /// because the plan's lane shares its geometry with the evaluation findings that *do*
    /// take it. Its own token description draws the line: *"NOT for completion or progress
    /// (a finished plan step is done, not correct)."* A plan outcome is something the
    /// student has not done yet; a check beside it is a bullet, not a verdict.
    static let markTint = DS.Color.icon
}

/// One row: a fixed leading slot, a gap, and the text.
struct PlanLaneRow<Leading: View>: View {
    let text: String
    var metrics: PlanLaneMetrics = .panel
    @ViewBuilder var leading: () -> Leading

    var body: some View {
        HStack(alignment: .top, spacing: metrics.gap) {
            leading()
                .frame(width: metrics.slotWidth, height: metrics.slotHeight)

            Text(verbatim: text)
                .textStyle(metrics.textStyle)
                .foregroundStyle(DS.Color.ink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: metrics.textWidth, alignment: .leading)
        }
        .frame(width: metrics.width, alignment: .topLeading)
    }
}

/// `plan/step` — the leading slot holds a digit.
struct PlanStepRow: View {
    let number: Int
    let text: String
    var metrics: PlanLaneMetrics = .panel

    var body: some View {
        PlanLaneRow(text: text, metrics: metrics) {
            Text(verbatim: "\(number)")
                .textStyle(metrics.numberStyle)
                .foregroundStyle(DS.Color.inkSecondary)
        }
        // The digit is content, not decoration — VoiceOver reads "1, Draw axes…" as one row.
        .accessibilityElement(children: .combine)
    }
}

/// `plan/outcome` — the leading slot holds `ui/check`.
struct PlanOutcomeRow: View {
    let text: String
    var metrics: PlanLaneMetrics = .panel

    var body: some View {
        PlanLaneRow(text: text, metrics: metrics) {
            IconView(.uiCheck, size: metrics.markSize, tint: PlanLaneMetrics.markTint)
        }
        // The check is the list's bullet. Reading it out would add a word the sighted
        // reader does not get — the "What success looks like" label above already says what
        // the rows are.
        .accessibilityElement(children: .combine)
    }
}
