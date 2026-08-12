import SwiftUI

/// The greeting, at both scales.
///
/// Board 03: *"The same block restated for a 301pt column and a 740pt one. It is not a
/// linear scale: the title jumps 26 → 40 while the body only goes 17 → 21, so the headline
/// gains most of the extra room and the supporting line stays at a comfortable reading
/// size."*
///
/// **All vertical rhythm is explicit margins.** *"These blocks use explicit margins, not
/// gaps and not spacer rectangles. `gap` is `none` on both."* So every step below is a
/// `margin-top` on one child, and `totalHeight` adds them in flow order — which is what
/// makes 522 and 268 fall out of the parts instead of being asserted as bare totals.
struct GreetingMetrics: Equatable, Sendable {
    let width: CGFloat
    /// `Orb · hero`, full-screen only. The panel's start state has no orb inside it — the
    /// panel orb is a sibling above the block, 120pt clear of it.
    let orbSize: CGSize?
    let titleTopMargin: CGFloat
    let titleHeight: CGFloat
    let titleStyle: DS.TextStyle
    let subtitleTopMargin: CGFloat
    /// Capped at 277 in the panel *"to force the 2-line wrap"*; unconstrained full-screen.
    let subtitleWidth: CGFloat
    let subtitleHeight: CGFloat
    let subtitleStyle: DS.TextStyle
    /// The panel greeting owns its suggestion stack; screen 07 places the grid as a
    /// separate region 174pt further down, so the full-screen block ends at the subtitle.
    let suggestionsTopMargin: CGFloat?
    let suggestionsHeight: CGFloat?
    /// *"lifts the block off the composer"* — declared in the spec table for the live
    /// screen, and screen 05 measures the block at 522 with it included.
    let bottomPadding: CGFloat

    /// Panel: 34 + 10 + 48 + 32 + 278 + 120 = 522. Full-screen: 142 + 34 + 48 + 14 + 30 = 268.
    var totalHeight: CGFloat {
        (orbSize?.height ?? 0)
            + titleTopMargin + titleHeight
            + subtitleTopMargin + subtitleHeight
            + (suggestionsTopMargin ?? 0) + (suggestionsHeight ?? 0)
            + bottomPadding
    }
}

extension GreetingMetrics {
    /// The block in a column of `width`.
    ///
    /// Screen 05's `Start state` is 301 × 522 and screen 07's `Greeting block` is 740 × 268;
    /// both totals are made of type leadings and margins, none of which is a function of the
    /// column, so a narrower column moves two things and only two: the width the centred
    /// children are centred in, and the subtitle's measure.
    ///
    /// The 10pt title→subtitle margin in the panel is screen 05's measurement. Board 03's own
    /// specimen of the same block says 12; 10 is the one that makes the screen's 522 close,
    /// and the screen is the thing being built.
    ///
    /// Board 03 measures its full-screen specimen at 264 with 32 / 12 margins and notes the
    /// spec row says "1376 × 268 in situ" — 4pt unexplained. Screen 07 resolves it: the live
    /// margins are 34 and 14, and `142 + 34 + 48 + 14 + 30 = 268`. That block is drawn 1376
    /// wide with centred children in the file, overhanging the screen by 34. Board 09: *"In
    /// Swift, implement this as content centred in the region x ∈ [68, 1376], not as a
    /// 1376-wide box offset by 34."* So the block is its column wide and the feature centres
    /// it.
    static func `for`(_ scale: ChatScale, width: CGFloat) -> Self {
        let column = max(0, width)
        switch scale {
        case .panel:
            return Self(
                width: column,
                orbSize: nil,
                titleTopMargin: 0,
                titleHeight: DS.Leading.title,
                titleStyle: .title,
                subtitleTopMargin: 10,
                // 277 is a measure, capped *"to force the 2-line wrap"* — 24pt narrower than
                // the column it sits in. A column narrower than 277 forces the wrap by
                // itself, so all the cap has left to do there is stop exceeding its column.
                subtitleWidth: min(277, column),
                subtitleHeight: 2 * DS.Leading.snug,
                subtitleStyle: .bodyCentred,
                suggestionsTopMargin: DS.Space.s8,
                suggestionsHeight: SuggestionChipMetrics.for(.panel, width: column).containerHeight,
                bottomPadding: 120
            )
        case .fullScreen:
            return Self(
                width: column,
                orbSize: CGSize(width: 150, height: 142),
                titleTopMargin: 34,
                titleHeight: DS.Leading.display,
                titleStyle: .display,
                subtitleTopMargin: 14,
                // Unconstrained, which at this scale means the column: the panel's cap exists
                // to force a wrap the reading column's one line does not need.
                subtitleWidth: column,
                subtitleHeight: DS.Leading.lead,
                subtitleStyle: .lead,
                // Screen 07 places the chip grid as its own region 174pt further down, so the
                // full-screen block ends at the subtitle.
                suggestionsTopMargin: nil,
                suggestionsHeight: nil,
                bottomPadding: 0
            )
        }
    }

    /// Screen 05's `Start state`, 301 × 522, and screen 07's `Greeting block`, 740 × 268.
    static var panel: Self { .for(.panel, width: DS.Container.panelContent) }
    static var fullScreen: Self { .for(.fullScreen, width: DS.Container.column) }

    static func `for`(_ scale: ChatScale) -> Self { .for(scale, width: scale.contentWidth) }
}

// MARK: - The block

/// Identical strings on screens 05 and 07 — *"One data source, two size variants."*
enum GreetingCopy {
    static let title = "Hi! I'm your AI Tutor"
    static let subtitle = "I'm here to help you learn, practice and achieve your goals."
}

struct GreetingBlock<Orb: View>: View {
    var scale: ChatScale = .panel
    /// The column the block fills and centres its children in.
    var width: CGFloat?
    var onSelectSuggestion: (Suggestion) -> Void = { _ in }
    /// True while the docked ↔ full-screen flight is carrying the title, the subtitle and
    /// the chip stack as its own travelling copies — this block's children hold their slots
    /// at opacity 0 so nothing reflows and nothing is unmounted. See `PresentationFlightLayer`.
    var hidesContentForFlight = false
    /// The hero orb's slot. The orb belongs to the shell, so the block reserves its
    /// 150 × 142 and leaves the drawing to whoever passes one in — the reservation is what
    /// keeps the block 268 tall either way.
    @ViewBuilder var orb: () -> Orb

    private var column: CGFloat { width ?? scale.contentWidth }
    private var metrics: GreetingMetrics { .for(scale, width: column) }

    var body: some View {
        VStack(spacing: 0) {
            if let orbSize = metrics.orbSize {
                orb().frame(width: orbSize.width, height: orbSize.height)
            }

            Text(verbatim: GreetingCopy.title)
                .textStyle(metrics.titleStyle)
                .foregroundStyle(DS.Color.ink)
                .multilineTextAlignment(.center)
                .opacity(hidesContentForFlight ? 0 : 1)
                .frame(width: metrics.width, height: metrics.titleHeight)
                .padding(.top, metrics.titleTopMargin)

            Text(verbatim: GreetingCopy.subtitle)
                .textStyle(metrics.subtitleStyle)
                .foregroundStyle(DS.Color.inkSecondary)
                .multilineTextAlignment(.center)
                .opacity(hidesContentForFlight ? 0 : 1)
                .frame(width: metrics.subtitleWidth, height: metrics.subtitleHeight)
                .padding(.top, metrics.subtitleTopMargin)

            if let suggestionsTopMargin = metrics.suggestionsTopMargin {
                SuggestionList(scale: scale, width: column, onSelect: onSelectSuggestion)
                    .opacity(hidesContentForFlight ? 0 : 1)
                    .padding(.top, suggestionsTopMargin)
            }
        }
        .padding(.bottom, metrics.bottomPadding)
        .frame(width: metrics.width, alignment: .top)
    }
}

extension GreetingBlock where Orb == EmptyView {
    init(
        scale: ChatScale = .panel,
        width: CGFloat? = nil,
        onSelectSuggestion: @escaping (Suggestion) -> Void = { _ in },
        hidesContentForFlight: Bool = false
    ) {
        self.init(
            scale: scale,
            width: width,
            onSelectSuggestion: onSelectSuggestion,
            hidesContentForFlight: hidesContentForFlight
        ) { EmptyView() }
    }
}
