#if DEBUG
import SwiftUI

/// Every shell component, in every state the design documents, at true size.
///
/// This exists to be compared against the Paper boards, so each specimen is captioned with
/// the layer name the board uses and the size the board states — a specimen that has drifted
/// should be findable by reading the caption and measuring the thing under it, without
/// anyone having to open the code first.
///
/// It is deliberately not wired into the app. Navigation belongs to the feature layer, and a
/// gallery that shipped would be a second place where component state has to be maintained.
struct ShellGallery: View {
    @State private var tool: BoardTool = .pen
    @State private var penColor: PenColor = .black
    @State private var thickness: StrokeThickness = .medium

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 56) {
                statusBarSection
                toolRailSection
                railPartsSection
                panelSection
                dockSection
                orbSection
                canvasSection
                peekSection
            }
            .padding(44)
        }
        .background(DS.Color.surfaceScreen)
    }

    // MARK: - Sections

    /// Not shipped — kept here because the reference PNGs were exported with it. The caption
    /// says so, so nobody reads the specimen as a component the product draws.
    private var statusBarSection: some View {
        Specimen(
            "Status bar · fixture only",
            size: "1376 × 24 at y 16 · iPadOS draws the real one on device"
        ) {
            StatusBar(width: DS.Container.screen)
        }
    }

    private var toolRailSection: some View {
        Section("Tool rail") {
            HStack(alignment: .top, spacing: 44) {
                Specimen("Tool rail · live", size: "72 × \(Self.number(ToolRailMetrics.height))") {
                    ToolRail(
                        bandHeight: Self.railBand,
                        selectedTool: tool,
                        selectedColor: penColor,
                        thickness: thickness,
                        onSelectTool: { tool = $0 },
                        onSelectColor: { penColor = $0 },
                        onCentreOnWork: { thickness = Self.next(after: thickness) }
                    )
                }
                Specimen("Tool rail · eraser, red, bold", size: "72 × \(Self.number(ToolRailMetrics.height))") {
                    ToolRail(
                        bandHeight: Self.railBand,
                        selectedTool: .eraser,
                        selectedColor: .red,
                        thickness: .bold,
                        onSelectTool: { _ in },
                        onSelectColor: { _ in },
                        onCentreOnWork: {}
                    )
                }
                // The one state a device can produce that no board draws, so it is the one
                // worth having a specimen of.
                Specimen(
                    "Tool rail · band too short",
                    size: "72 × \(Self.number(Self.shortBand)) · chain unchanged, scrolls"
                ) {
                    ToolRail(
                        bandHeight: Self.shortBand,
                        selectedTool: tool,
                        selectedColor: penColor,
                        thickness: thickness,
                        onSelectTool: { tool = $0 },
                        onSelectColor: { penColor = $0 },
                        onCentreOnWork: {}
                    )
                }
                VStack(alignment: .leading, spacing: 20) {
                    Caption("Chain · gap 0, every step a child's margin-top")
                    ForEach(ToolRailMetrics.chain, id: \.name) { step in
                        Caption("\(step.name)  mt \(Self.number(step.marginTop))  h \(Self.number(step.height))")
                    }
                    Caption("padding-block 9 × 2  →  total \(Self.number(ToolRailMetrics.height))")
                    Caption("optical margins \(Self.number(ToolRailMetrics.topOpticalMargin)) top / \(Self.number(ToolRailMetrics.bottomOpticalMargin)) bottom")
                }
            }
        }
    }

    /// A band the rail comfortably fits, so the two live specimens are the designed rail.
    private static let railBand = ToolRailMetrics.height
    /// Shorter than the chain by enough to be obviously so.
    private static let shortBand: CGFloat = 400

    private var railPartsSection: some View {
        Section("Tool rail parts") {
            VStack(alignment: .leading, spacing: 36) {
                Specimen("Tool slot · selected", size: "54 × 54 · radius 14 · brand tint") {
                    HStack(spacing: ToolRailMetrics.toolsGap) {
                        ForEach(BoardTool.allCases) { tool in
                            ToolSlot(tool: tool, isSelected: true) {}
                        }
                    }
                }
                Specimen("Tool slot · default", size: "54 × 54 · no background") {
                    HStack(spacing: ToolRailMetrics.toolsGap) {
                        ForEach(BoardTool.allCases) { tool in
                            ToolSlot(tool: tool, isSelected: false) {}
                        }
                    }
                }
                Specimen("Pen swatches", size: "27 dot on a 54 pitch · 54 × 54 tap target") {
                    HStack(spacing: ToolRailMetrics.swatchGap) {
                        ForEach(PenColor.allCases) { color in
                            PenSwatch(color: color, isSelected: color == penColor) { penColor = color }
                        }
                    }
                }
                Specimen("Stroke thickness", size: "36 × 5 row · bar is the live stroke") {
                    HStack(spacing: 32) {
                        ForEach(StrokeThickness.allCases) { thickness in
                            ThicknessIndicator(thickness: thickness, color: penColor)
                        }
                    }
                }
            }
        }
    }

    private var panelSection: some View {
        Section("Tutor panel") {
            HStack(alignment: .top, spacing: 44) {
                Specimen(
                    "Tutor panel shell",
                    size: "337 × band · radius 28 · content column \(Self.number(TutorPanelMetrics.contentWidth))"
                ) {
                    TutorPanelShell(size: CGSize(width: TutorPanelMetrics.width, height: 600)) {
                        VStack(spacing: 0) {
                            PanelControls(onDock: {}, onFullScreen: {})
                            Orb(.panel).padding(.top, 120)
                            contentWidthMarker.padding(.top, 40)
                            Spacer(minLength: 0)
                        }
                    }
                }
                Specimen("Panel controls", size: "301 × 32 · gap 14 · two 32 × 32, no fill") {
                    PanelControls(onDock: {}, onFullScreen: {})
                }
            }
        }
    }

    private var dockSection: some View {
        Specimen("Tutor dock · collapsed", size: "132 × 64 · 52 pill + gap 16 + 64 orb") {
            CollapsedDock(onSelect: {}, onOpenTutor: {})
        }
    }

    private var orbSection: some View {
        Section("Orb") {
            HStack(alignment: .center, spacing: 140) {
                ForEach(OrbSize.allCases, id: \.self) { size in
                    let metrics = size.metrics
                    Specimen(
                        "Orb · \(size.rawValue)",
                        size: "\(Self.number(metrics.frame.width)) × \(Self.number(metrics.frame.height))"
                            + (metrics.smileOrigin == nil ? "" : " · with smile")
                    ) {
                        Orb(size).padding(60)
                    }
                }
            }
        }
    }

    private var canvasSection: some View {
        Section("Whiteboard") {
            VStack(alignment: .leading, spacing: 36) {
                Specimen(
                    "Whiteboard canvas",
                    size: "width from the layout, height the content band · shown 520 × 300"
                ) {
                    WhiteboardSurface(width: 520, height: 300) { Color.clear }
                }
                Specimen("Dot grid", size: "pitch 23.9 × 24.5 · dot r 1.4 · #F1F1F1") {
                    DotGrid()
                        .frame(width: 520, height: 120)
                        .background(DS.Color.surfaceCanvas)
                }
            }
        }
    }

    private var peekSection: some View {
        Section("Board peek") {
            HStack(alignment: .top, spacing: 44) {
                Specimen("Board peek · as drawn", size: "68 × 936 at x 0 · real shadow, duplicate path deleted") {
                    BoardPeek(height: BoardPeekMetrics.referenceHeight, onTap: {})
                }
                // The tab and both fillets have to come out identical to the specimen beside
                // it: only the strip between them is allowed to shorten.
                Specimen("Board peek · short band", size: "68 × \(Self.number(Self.shortBand)) · arcs unscaled") {
                    BoardPeek(height: Self.shortBand, onTap: {})
                }
            }
        }
    }

    // MARK: - Chrome

    private var contentWidthMarker: some View {
        RoundedRectangle(cornerRadius: DS.Radius.lg)
            .fill(DS.Color.brandTintSoft)
            .frame(width: TutorPanelMetrics.contentWidth, height: 120)
            .overlay {
                Text("\(Self.number(TutorPanelMetrics.contentWidth)) content column")
                    .textStyle(.label)
                    .foregroundStyle(DS.Color.brand)
            }
    }

    private struct Section<Content: View>: View {
        let title: String
        @ViewBuilder let content: Content

        init(_ title: String, @ViewBuilder content: () -> Content) {
            self.title = title
            self.content = content()
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 20) {
                Text(title).textStyle(.title).foregroundStyle(DS.Color.ink)
                content
            }
        }
    }

    private struct Specimen<Content: View>: View {
        let name: String
        let size: String
        @ViewBuilder let content: Content

        init(_ name: String, size: String, @ViewBuilder content: () -> Content) {
            self.name = name
            self.size = size
            self.content = content()
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 12) {
                Text(name).textStyle(.label).foregroundStyle(DS.Color.ink)
                Caption(size)
                content
            }
        }
    }

    private struct Caption: View {
        let text: String

        init(_ text: String) { self.text = text }

        var body: some View {
            Text(text).textStyle(.label).foregroundStyle(DS.Color.inkTertiary)
        }
    }

    /// Captions carry the real metrics, so `627.5` has to survive being printed while `54`
    /// must not become `54.0` — otherwise every caption reads as a suspiciously precise
    /// number and the fractional ones stop standing out.
    private static func number(_ value: CGFloat) -> String {
        value == value.rounded() ? String(Int(value)) : String(format: "%g", value)
    }

    private static func next(after thickness: StrokeThickness) -> StrokeThickness {
        let all = StrokeThickness.allCases
        guard let index = all.firstIndex(of: thickness) else { return .defaultValue }
        return all[(index + 1) % all.count]
    }
}

#Preview("Shell gallery") {
    ShellGallery()
}
#endif
