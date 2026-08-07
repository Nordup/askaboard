import SwiftUI

/// `plan/panel` (board 12) and `plan/full-screen` (board 13) — the same seven-child column
/// at two scales.
///
/// **The plan is unboxed.** No fill, no radius, no shadow, no padding: it sits directly on
/// the panel like any tutor message, because *"the tutor is the voice of the panel, not a
/// participant in a chat log"*. Structure comes from the kicker, the headline, the numbered
/// lane and whitespace. A card here would make the tutor a third party in its own surface.
struct SessionPlanMetrics: Equatable, Sendable {
    let scale: ChatScale
    let width: CGFloat
    let kickerStyle: DS.TextStyle
    let titleTopMargin: CGFloat
    let titleStyle: DS.TextStyle
    let goalTopMargin: CGFloat
    let goalStyle: DS.TextStyle
    /// The goal is prose, not a lane row, so its wrap is a property of the column rather
    /// than of the data: two lines at 301, one at 740. Only `height(stepLines:outcomeLines:)`
    /// reads it — the view itself wraps for real.
    ///
    /// It stays the scale's measured wrap rather than a function of the column, for the same
    /// reason `height` takes its step and outcome line counts as arguments: a wrap can be
    /// measured or passed in, and this file does neither text layout nor guessing.
    let goalLines: Int
    let stepsTopMargin: CGFloat
    let stepGap: CGFloat
    let outcomesLabelTopMargin: CGFloat
    let outcomesLabelStyle: DS.TextStyle
    let outcomesTopMargin: CGFloat
    let outcomeGap: CGFloat
    let actionTopMargin: CGFloat
    let lane: PlanLaneMetrics
    let action: PrimaryButtonMetrics

    /// The board's own arithmetic, in flow order — `605` on board 12's wrap and `608` on
    /// board 13's. It takes the line counts because two of board 12's step rows and two of
    /// its outcome rows wrap, which is the only reason the panel's total is not as tidy as
    /// the full screen's.
    func height(stepLines: [Int], outcomeLines: [Int]) -> CGFloat {
        kickerStyle.leading
            + titleTopMargin + titleStyle.leading
            + goalTopMargin + goalStyle.leading * CGFloat(goalLines)
            + stepsTopMargin + lane.stackHeight(lines: stepLines, gap: stepGap)
            + outcomesLabelTopMargin + outcomesLabelStyle.leading
            + outcomesTopMargin + lane.stackHeight(lines: outcomeLines, gap: outcomeGap)
            + actionTopMargin + action.height
    }
}

extension SessionPlanMetrics {
    /// The plan in a column of `width`.
    ///
    /// Seven children, eight margins and six type styles, and **not one of them is a function
    /// of the column** — board 05's rule holds here as it does for the greeting, the chips and
    /// the composer: *"treat them as two variants, not one responsive view."* The plan's
    /// display headline does not drop to 26 because the screen got narrower. What the column
    /// moves is the block's own frame, the lane its rows are cut to, and the action's slot —
    /// which is the whole of `740 → 644` on a portrait iPad, and the reason this plan was the
    /// last thing on the surface still drawing 96 points wider than the thread around it.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        let column = max(0, width)
        switch scale {
        case .panel:
            return Self(
                scale: .panel,
                width: column,
                kickerStyle: .label,
                titleTopMargin: DS.Space.s2,
                titleStyle: .title,
                goalTopMargin: DS.Space.s3,
                goalStyle: .body,
                goalLines: 2,
                stepsTopMargin: DS.Space.s5,
                stepGap: DS.Space.s3,
                outcomesLabelTopMargin: DS.Space.s6,
                outcomesLabelStyle: .label,
                outcomesTopMargin: DS.Space.s3,
                outcomeGap: DS.Space.s2,
                actionTopMargin: DS.Space.s6,
                lane: .for(.panel, width: column),
                action: .for(.panel, width: column)
            )
        case .fullScreen:
            return Self(
                scale: .fullScreen,
                width: column,
                // 17 / 25 · 600, where the panel's kicker is 15 / 18 · 600. Board 13 states
                // this step here and nowhere else, so it is named rather than spelled out —
                // see `DS.TextStyle.labelFullScreen`, which the selection card also takes.
                kickerStyle: .labelFullScreen,
                titleTopMargin: DS.Space.s2,
                titleStyle: .display,
                goalTopMargin: DS.Space.s4,
                goalStyle: .lead,
                goalLines: 1,
                stepsTopMargin: DS.Space.s10,
                stepGap: DS.Space.s5,
                outcomesLabelTopMargin: DS.Space.s10,
                outcomesLabelStyle: TextStyle(size: DS.Size.body, leading: DS.Leading.body, weight: .semibold),
                outcomesTopMargin: DS.Space.s5,
                outcomeGap: DS.Space.s3,
                actionTopMargin: DS.Space.s10,
                lane: .for(.fullScreen, width: column),
                action: .for(.fullScreen, width: column)
            )
        }
    }

    /// Board 12, `plan/panel` 301 × 605.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }

    /// Board 13, `plan/full-screen` 740 × 608. *"Every row is a single line at this width,
    /// which is why the numbers are so much tidier than the panel's."*
    static var fullScreen: Self { .for(.fullScreen, width: DS.Container.column) }

    static func `for`(_ scale: ChatScale) -> Self { .for(scale, width: scale.contentWidth) }
}

/// Board 12 / 13 literal copy. Only the kicker, the outcomes label and the CTA are fixed —
/// the title, goal, steps and outcomes are the session's own.
enum SessionPlanCopy {
    static let kicker = "Session plan"
    static let outcomesLabel = "What success looks like"
    static let action = "Start on the board"
}

/// The agreed plan for the session, as a flow child of the thread.
///
/// It is a message, not a modal and not a panel takeover — subject to the same 22pt message
/// gap and the same scroll fade as anything else the tutor says.
///
/// `plan.currentStep` is deliberately not drawn. The boards number the steps 1…4 plainly and
/// specify no completed, current or upcoming state for a step, and the one obvious way to
/// add one — a check where the digit is — would both invent a state and be the exact leak
/// `PlanLaneMetrics.markTint` guards against: *"a finished plan step is done, not correct."*
struct SessionPlanView: View {
    let plan: SessionPlan
    let scale: ChatScale
    /// The column the plan is told in, because the plan is one of the thread's children and
    /// not a surface of its own — board 13's block was measured at 740 and is 740 only where
    /// the thread is. `nil` takes the column the design drew, which is what a preview wants.
    var width: CGFloat?
    let onStart: () -> Void

    private var column: CGFloat { width ?? scale.contentWidth }
    private var metrics: SessionPlanMetrics { .for(scale, width: column) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: SessionPlanCopy.kicker)
                .textStyle(metrics.kickerStyle)
                .foregroundStyle(DS.Color.inkSecondary)

            Text(verbatim: plan.title)
                .textStyle(metrics.titleStyle)
                .foregroundStyle(DS.Color.ink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: metrics.width, alignment: .leading)
                .padding(.top, metrics.titleTopMargin)

            Text(verbatim: plan.goal)
                .textStyle(metrics.goalStyle)
                .foregroundStyle(DS.Color.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: metrics.width, alignment: .leading)
                .padding(.top, metrics.goalTopMargin)

            steps.padding(.top, metrics.stepsTopMargin)

            Text(verbatim: SessionPlanCopy.outcomesLabel)
                .textStyle(metrics.outcomesLabelStyle)
                .foregroundStyle(DS.Color.inkSecondary)
                .padding(.top, metrics.outcomesLabelTopMargin)

            outcomes.padding(.top, metrics.outcomesTopMargin)

            PrimaryButton(
                title: SessionPlanCopy.action,
                scale: scale,
                // The button is laid out in the same column the plan is, so the one the
                // metrics measured and the one the panel button fills cannot drift apart.
                width: column,
                action: onStart
            )
            .padding(.top, metrics.actionTopMargin)
            // `align-self: flex-start` at full screen — the button hugs its label and does
            // not stretch to the column.
            .frame(width: metrics.width, alignment: .leading)
        }
        .frame(width: metrics.width, alignment: .topLeading)
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: metrics.stepGap) {
            ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                PlanStepRow(number: index + 1, text: step, metrics: metrics.lane)
            }
        }
    }

    private var outcomes: some View {
        VStack(alignment: .leading, spacing: metrics.outcomeGap) {
            ForEach(Array(plan.outcomes.enumerated()), id: \.offset) { _, outcome in
                PlanOutcomeRow(text: outcome, metrics: metrics.lane)
            }
        }
    }
}

#if DEBUG
#Preview("Session plan · panel") {
    SessionPlanView(plan: .radicalEquation, scale: .panel, onStart: {})
        .padding(44)
        .background(DS.Color.surfacePanel)
}

#Preview("Session plan · full screen") {
    SessionPlanView(plan: .radicalEquation, scale: .fullScreen, onStart: {})
        .padding(44)
        .background(DS.Color.surface)
}
#endif
