import SwiftUI

/// The fixed square that makes a small glyph a legal tap target and sets the rail's
/// vertical rhythm.
///
/// The board documents exactly two states, `default` and `selected`, and no third: there
/// is no pressed, hover, focus or disabled variant anywhere on artboard 02.
struct ToolSlot: View {
    let tool: BoardTool
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            IconView(Self.icon(for: tool), tint: isSelected ? DS.Color.brand : DS.Color.icon)
                .frame(width: ToolRailMetrics.slot, height: ToolRailMetrics.slot)
                .background {
                    if isSelected {
                        RoundedRectangle(cornerRadius: DS.Radius.lg).fill(DS.Color.brandTint)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Self.label(for: tool))
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    /// Kept `fileprivate` rather than exposed as `BoardTool.icon`: Domain deliberately owns
    /// no view types, and a public extension here would be the obvious place for a second
    /// one to collide with.
    fileprivate static func icon(for tool: BoardTool) -> Icon {
        switch tool {
        case .pen: .toolPen
        case .highlighter: .toolHighlighter
        case .eraser: .toolEraser
        case .lasso: .toolLasso
        }
    }

    /// **Not from the design.** Board 05 open question 17 records that no VoiceOver labels
    /// are given for any icon-only control, so these name the tool the glyph draws.
    fileprivate static func label(for tool: BoardTool) -> String {
        switch tool {
        case .pen: "Pen"
        case .highlighter: "Highlighter"
        case .eraser: "Eraser"
        case .lasso: "Lasso select"
        }
    }
}

/// One of the five ink colours.
///
/// The board draws no selected state for a swatch and specifies none, so this one does not
/// invent a ring or a tint: what tells you which ink is armed is the thickness bar below,
/// which the board describes as a sample of the current stroke. The selection is still
/// carried for VoiceOver, where a missing "selected" trait is a real defect rather than a
/// stylistic one.
struct PenSwatch: View {
    let color: PenColor
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(Self.fill(for: color))
                .frame(width: ToolRailMetrics.swatch, height: ToolRailMetrics.swatch)
                .expandedTapTarget(ToolRailMetrics.swatchPitch, over: ToolRailMetrics.swatch)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Self.label(for: color))
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    fileprivate static func fill(for color: PenColor) -> Color {
        switch color {
        case .black: DS.Color.penBlack
        case .violet: DS.Color.penViolet
        case .blue: DS.Color.penBlue
        case .green: DS.Color.penGreen
        case .red: DS.Color.penRed
        }
    }

    /// **Not from the design** — see `ToolSlot.label(for:)`.
    fileprivate static func label(for color: PenColor) -> String {
        switch color {
        case .black: "Black ink"
        case .violet: "Violet ink"
        case .blue: "Blue ink"
        case .green: "Green ink"
        case .red: "Red ink"
        }
    }
}

/// The passive sample of the current stroke.
///
/// Board 02: *"A single fully-rounded bar that samples the stroke weight rather than
/// showing a slider — one mark instead of a control cluster."*
///
/// The board draws exactly one specimen, 36 × 5 filled `--color-pen-black`, which is the
/// rail in its default state — `StrokeThickness.medium` is 5pt and `PenColor.black` is the
/// default ink — so driving both from the live selection renders the board's own bar
/// unchanged until the student picks something else. **What the design does not state is
/// what a fine or bold bar looks like**, so this takes the obvious reading of "samples the
/// stroke": the bar is as tall as the ink is wide.
///
/// The row it sits in stays 5pt regardless, because that 5 is a term in the rail's 627.5
/// chain. A bold 10pt bar therefore overhangs its row by 2.5pt into the 29 / 19.5 margins
/// on either side, which have room to spare and no geometry riding on them.
struct ThicknessIndicator: View {
    let thickness: StrokeThickness
    let color: PenColor

    var body: some View {
        Color.clear
            .frame(width: ToolRailMetrics.thicknessWidth, height: ToolRailMetrics.thicknessHeight)
            .overlay {
                Capsule()
                    .fill(PenSwatch.fill(for: color))
                    .frame(width: ToolRailMetrics.thicknessWidth, height: thickness.pointWidth)
            }
            .accessibilityElement()
            .accessibilityLabel("Stroke thickness")
            .accessibilityValue(Self.label(for: thickness))
    }

    /// **Not from the design** — see `ToolSlot.label(for:)`.
    private static func label(for thickness: StrokeThickness) -> String {
        switch thickness {
        case .fine: "Fine"
        case .medium: "Medium"
        case .bold: "Bold"
        }
    }
}

extension View {
    /// Grows the tappable area to `pitch` square around a `drawn`-point mark, without
    /// changing what the layout sees.
    ///
    /// Board 02, on the swatches: *"the swatch is 27, but the effective hit area is the
    /// full 54pt pitch. The 27pt gap **is** the other half of the target."* Saying that in
    /// SwiftUI with a plain `.frame(54)` would add 27pt to the Swatches block and take the
    /// rail off 627.5, so the frame is given back as negative padding: the mark keeps its
    /// drawn size in layout and hit-tests at the pitch. Consecutive marks on the pitch then
    /// tile edge to edge with neither a gap nor an overlap.
    func expandedTapTarget(_ pitch: CGFloat, over drawn: CGFloat) -> some View {
        frame(width: pitch, height: pitch)
            .contentShape(Rectangle())
            .padding(-(pitch - drawn) / 2)
    }
}
