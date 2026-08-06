import SwiftUI

/// The rail's spacing chain, as a value.
///
/// Board 02, verbatim: *"The rail is a fit-content column so adding or removing a tool
/// never requires re-measuring a fixed height. Its optical margins come from padding-block
/// 9 plus the 54pt slot centring its own 27–28pt glyph — do not 'simplify' this into a
/// single large padding value, which is the bug this rail already had once and which pushed
/// the top and bottom glyphs out of balance."*
///
/// Which is why `height` is summed from `chain` rather than stored: the total is the thing
/// that catches a drifted step, and a stored 627.5 would keep agreeing with itself after
/// someone edited a margin. The board records that this rail was already flattened to 617
/// once by a tool that quantises off-scale values onto the 4pt grid, so every fraction
/// here — 9, 3.5, 1.5, 11.5, 19.5, 27, 29 — is deliberate, and none of them is a token.
/// Board 01 rule 11 is the licence: *"Component internals are allowed off-grid."*
enum ToolRailMetrics {
    /// One child of the rail, with the vertical step that precedes it.
    struct Step: Equatable, Sendable {
        /// The design's own layer name, so a failing assertion names the child.
        let name: String
        /// The child's `margin-top`. The rail's own `gap` is **0** — in this design every
        /// vertical step is an explicit margin on one child, and collapsing them into a
        /// uniform stack spacing is exactly the regression the board warns about.
        let marginTop: CGFloat
        let height: CGFloat

        var extent: CGFloat { marginTop + height }
    }

    // MARK: - Frame

    static let width = DS.Container.rail
    static let cornerRadius = DS.Radius.xxl
    /// `padding-block: 9`, top and bottom. No token — 9 is intentional.
    static let paddingBlock: CGFloat = 9

    // MARK: - Tools

    /// Board 02: *"A tool slot is a fixed 54pt square that centres a 27–28pt glyph, so the
    /// touch target stays legal even though the glyph is small. That 54pt box is also what
    /// produces the rail's optical margins."*
    static let slot: CGFloat = 54
    static let toolsGap: CGFloat = 3.5

    /// `4 × 54 + 3 × 3.5 = 226.5`, counted off `BoardTool` rather than written down, so
    /// the arithmetic the board states is the arithmetic the rail runs.
    static var toolsHeight: CGFloat {
        let count = CGFloat(BoardTool.allCases.count)
        return count * slot + (count - 1) * toolsGap
    }

    // MARK: - Divider

    static let dividerWidth: CGFloat = 46
    /// **1.5, not 1 or 2.** A tree-summary read of "46 × 2" is rounding.
    static let dividerHeight: CGFloat = 1.5
    static let dividerMarginTop: CGFloat = 11.5

    // MARK: - Swatches

    /// Board 02: *"Five ink colours on a 54pt pitch — the same pitch as a tool slot — so the
    /// swatch column and the tool column read as one vertical rhythm even though the swatch
    /// itself is only 27pt. The circle is half the pitch; the other half is the tap target."*
    static let swatch: CGFloat = 27
    static let swatchGap: CGFloat = 27
    /// 27 dot + 27 gap. The gap is not decoration — see `PenSwatch`.
    static var swatchPitch: CGFloat { swatch + swatchGap }

    /// `5 × 27 + 4 × 27 = 243`, counted off `PenColor` for the same reason as `toolsHeight`.
    static var swatchesHeight: CGFloat {
        let count = CGFloat(PenColor.allCases.count)
        return count * swatch + (count - 1) * swatchGap
    }

    static let swatchesMarginTop: CGFloat = 19.5

    // MARK: - Thickness

    static let thicknessWidth: CGFloat = 36
    /// The height the chain reserves. `StrokeThickness.medium` is also 5pt, so the rail
    /// draws the board's own 36 × 5 bar in the default state — see `ThicknessIndicator`.
    static let thicknessHeight: CGFloat = 5
    /// Board 02: *"exactly half the height, so the caps are semicircles"* — derived, so a
    /// thicker bar keeps its semicircular caps for free.
    static var thicknessRadius: CGFloat { thicknessHeight / 2 }
    /// Board 02 prose says the bar is bracketed by "28pt and 20pt" margins; the build says
    /// 29 and 19.5, and the build is what the verified 627.5 total depends on.
    static let thicknessMarginTop: CGFloat = 29

    // MARK: - Centre-on-work

    static let centreMarginTop: CGFloat = 19.5

    // MARK: - The chain

    /// Top to bottom, the exact chain the board states:
    /// `Tools 226.5 → mt 11.5 → Divider 1.5 → mt 19.5 → Swatches 243 → mt 29 →`
    /// `Thickness 5 → mt 19.5 → centre 54`.
    static var chain: [Step] {
        [
            Step(name: "Tools", marginTop: 0, height: toolsHeight),
            Step(name: "Divider", marginTop: dividerMarginTop, height: dividerHeight),
            Step(name: "Swatches", marginTop: swatchesMarginTop, height: swatchesHeight),
            Step(name: "Thickness", marginTop: thicknessMarginTop, height: thicknessHeight),
            Step(name: "tool/center", marginTop: centreMarginTop, height: slot),
        ]
    }

    /// **627.5.** Board 02: *"if a Swift port ever measures the rail at 617, it copied the
    /// corrupted state."*
    static var height: CGFloat {
        2 * paddingBlock + chain.reduce(0) { $0 + $1.extent }
    }

    // MARK: - Fitting the rail into a band it may be taller than

    /// What the rail does with the band it is given.
    ///
    /// The chain above is fixed by design and stays fixed: 627.5 fits the content band of
    /// every full-screen iPad — the shortest, a 768pt iPad 6 in landscape, leaves 672 — but a
    /// Split View or a short Stage Manager window can be under it, and something has to
    /// happen that is not a column with its bottom cut off.
    ///
    /// The three alternatives were all worse. Scaling the rail down breaks the 44pt tap
    /// minimum the 54pt slot exists to guarantee, and quantising a hand-tuned chain onto a
    /// scale factor is the same class of change as the 617 regression. Dropping children
    /// invents a priority order the design does not state — nothing says the centre control
    /// matters less than the eraser. Shrinking the margins re-tunes margins the board says
    /// twice not to re-tune.
    ///
    /// Scrolling costs nothing designed: every value stays, every tool stays reachable, every
    /// tap target stays legal, and the rail still reads as one surface because the card is the
    /// scroll frame rather than the content. It also costs nothing at any size that fits — the
    /// rail is only wrapped in a scroll view when it has to be.
    enum Fit: Equatable, Sendable {
        /// The band is at least 627.5: the rail is `fit-content`, exactly as designed.
        case fitContent
        /// The band is shorter than the chain: the rail fills the band and the chain scrolls
        /// inside it, unchanged.
        case scrolls
    }

    static func fit(inBandOfHeight bandHeight: CGFloat) -> Fit {
        bandHeight >= height ? .fitContent : .scrolls
    }

    /// The rail's outer height in a band of the given height — its own 627.5 when it fits,
    /// the band when it does not, and never negative.
    static func renderedHeight(inBandOfHeight bandHeight: CGFloat) -> CGFloat {
        min(height, max(0, bandHeight))
    }

    /// The board states these as the rail's real margins — `22 top / 23 bottom · = 9
    /// padding + 13/14 slot centring` — and they are the reason the 54pt slot cannot be
    /// shrunk to fit its glyph. Carried so a change to `slot` or `paddingBlock` has to
    /// answer for them.
    static var topOpticalMargin: CGFloat { paddingBlock + (slot - Icon.toolPen.renderSize) / 2 }
    static var bottomOpticalMargin: CGFloat { paddingBlock + (slot - Icon.toolCenter.renderSize) / 2 }
}

/// The persistent left-edge surface: tool selection, pen colour, stroke weight, and the
/// centre-on-work control.
///
/// Selection is passed in and reported back rather than bound, so the rail has no opinion
/// about where the state lives and a specimen can be rendered from constants.
///
/// `bandHeight` is the only geometry the rail takes, and it is a *limit*, not a size: the
/// design's height is `fit-content` and stays `fit-content` wherever the chain fits. See
/// `ToolRailMetrics.Fit` for what happens where it does not.
struct ToolRail: View {
    private let bandHeight: CGFloat
    private let selectedTool: BoardTool
    private let selectedColor: PenColor
    private let thickness: StrokeThickness
    private let onSelectTool: (BoardTool) -> Void
    private let onSelectColor: (PenColor) -> Void
    private let onCentreOnWork: () -> Void

    init(
        bandHeight: CGFloat,
        selectedTool: BoardTool,
        selectedColor: PenColor,
        thickness: StrokeThickness,
        onSelectTool: @escaping (BoardTool) -> Void,
        onSelectColor: @escaping (PenColor) -> Void,
        onCentreOnWork: @escaping () -> Void
    ) {
        self.bandHeight = bandHeight
        self.selectedTool = selectedTool
        self.selectedColor = selectedColor
        self.thickness = thickness
        self.onSelectTool = onSelectTool
        self.onSelectColor = onSelectColor
        self.onCentreOnWork = onCentreOnWork
    }

    var body: some View {
        Group {
            switch ToolRailMetrics.fit(inBandOfHeight: bandHeight) {
            case .fitContent:
                // No explicit height: the design's height is `fit-content`, so letting the
                // chain measure itself is what keeps 627.5 true rather than merely asserted.
                column
            case .scrolls:
                ScrollView(.vertical) { column }
                    // The chain inside is untouched — only how much of it is on screen at
                    // once changes. The default indicator is left on: it is the only thing
                    // that says there is more rail below, and the design has no affordance
                    // for a state it never drew.
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(height: ToolRailMetrics.renderedHeight(inBandOfHeight: bandHeight))
            }
        }
        .frame(width: ToolRailMetrics.width)
        .background(
            // Circular corners, not `.continuous`: the design's radius is a CSS
            // `border-radius`, which is a circular arc. A squircle is an iOS convention the
            // board did not draw.
            RoundedRectangle(cornerRadius: ToolRailMetrics.cornerRadius)
                .fill(DS.Color.surfacePanel)
        )
        // The card clips its own corners; the shadow is applied after so it stays the card's
        // silhouette. Both sit outside the scroll view, so the surface never scrolls — only
        // the chain does.
        .clipShape(RoundedRectangle(cornerRadius: ToolRailMetrics.cornerRadius))
        .elevation(.panel)
    }

    /// The chain itself, identical in both fits.
    ///
    /// `spacing: 0` is the design's `gap: 0`, and the `.padding(.top:)` on each child below is
    /// that child's `margin-top`. The one-to-one correspondence is the point: the chain in
    /// `ToolRailMetrics` and the chain in this stack are the same list.
    private var column: some View {
        VStack(spacing: 0) {
            tools
            divider.padding(.top, ToolRailMetrics.dividerMarginTop)
            swatches.padding(.top, ToolRailMetrics.swatchesMarginTop)
            thicknessIndicator.padding(.top, ToolRailMetrics.thicknessMarginTop)
            centreOnWorkSlot.padding(.top, ToolRailMetrics.centreMarginTop)
        }
        .padding(.vertical, ToolRailMetrics.paddingBlock)
    }

    private var tools: some View {
        VStack(spacing: ToolRailMetrics.toolsGap) {
            ForEach(BoardTool.allCases) { tool in
                ToolSlot(tool: tool, isSelected: tool == selectedTool) { onSelectTool(tool) }
            }
        }
    }

    /// Board 01 rule 1: this hairline is the only border left anywhere in the product.
    private var divider: some View {
        Rectangle()
            .fill(DS.Color.divider)
            .frame(width: ToolRailMetrics.dividerWidth, height: ToolRailMetrics.dividerHeight)
            .accessibilityHidden(true)
    }

    private var swatches: some View {
        VStack(spacing: ToolRailMetrics.swatchGap) {
            ForEach(PenColor.allCases) { color in
                PenSwatch(color: color, isSelected: color == selectedColor) { onSelectColor(color) }
            }
        }
    }

    private var thicknessIndicator: some View {
        ThicknessIndicator(thickness: thickness, color: selectedColor)
    }

    private var centreOnWorkSlot: some View {
        Button(action: onCentreOnWork) {
            IconView(.toolCenter)
                .frame(width: ToolRailMetrics.slot, height: ToolRailMetrics.slot)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Center on work")
    }
}

#if DEBUG
#Preview("Tool rail") {
    ToolRail(
        bandHeight: ToolRailMetrics.height,
        selectedTool: .pen,
        selectedColor: .black,
        thickness: .medium,
        onSelectTool: { _ in },
        onSelectColor: { _ in },
        onCentreOnWork: {}
    )
    .padding(44)
    .background(DS.Color.surfaceScreen)
}
#endif
