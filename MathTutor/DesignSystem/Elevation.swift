import SwiftUI

/// The product's whole separation vocabulary. Board 01: *"Surfaces separate by shadow
/// alone — there is not one border left in the product. Three levels and nothing else:
/// the canvas gets a single soft shadow, panels and controls get two, a wide soft one for
/// the lift and a tight one for the contact edge."*
///
/// Hand-carried rather than generated, and it has to be: Paper has no shadow token type,
/// so this scale exists only as prose and specimens on the Foundations board. The board's
/// caption for each level is quoted verbatim below so the values can be checked against
/// the design without opening Paper.
///
/// ```
/// 01 Canvas   #14143209  0  2   6
/// 02 Panel    #1414320E  0  3  10   +  #1414320A  0  1  3
/// 03 Control  #1414320D  0  2   6   +  #14143208  0  1  2
/// ```
///
/// No layer in any level has a spread and every x offset is 0, so a layer is fully
/// described by an alpha, a y offset and a blur.
enum Elevation: CaseIterable, Sendable {
    /// *"0 2 6 · 0.035 — The board. Barely lifted — it is the ground."*
    case canvas
    /// *"0 3 10 · 0.055 + 0 1 3 · 0.04 — Tool rail, tutor panel. Floats over the board."*
    case panel
    /// *"0 2 6 · 0.05 + 0 1 2 · 0.03 — Buttons, chips, the floating dock."*
    ///
    /// Also the composer field. Board 01: *"The composer is raised, not recessed. An
    /// inward rim shadow was tried and rejected — it read as a hole rather than a control."*
    case control
}

extension Elevation {
    /// One `box-shadow` layer off the board, in the design's own units.
    struct Layer: Equatable, Sendable {
        /// The board states these as decimals next to the 8-digit hex it measured them
        /// from; the two disagree in the third decimal place (`0x09`/255 is 0.0353, the
        /// board says 0.035) and the decimal is the design's stated intent.
        let alpha: Double
        let y: CGFloat
        /// CSS blur, carried unconverted so it can be diffed against the board.
        let blur: CGFloat

        /// Every shadow in the product is `--color-shadow` at one of five alphas. The hue
        /// is never a fill.
        var color: SwiftUI.Color { DS.Color.shadow.opacity(alpha) }

        /// The one conversion, and the one that is usually got wrong: CSS `blur` is the
        /// full width of the Gaussian, SwiftUI's `.shadow(radius:)` is half of it. Port a
        /// blur straight across and every surface in the product reads twice as soft as
        /// the design draws it.
        var shadowRadius: CGFloat { blur / 2 }
    }

    /// `#14143209 0 2 6`
    static let canvasLift = Layer(alpha: 0.035, y: 2, blur: 6)
    /// `#1414320E 0 3 10`
    static let panelLift = Layer(alpha: 0.055, y: 3, blur: 10)
    /// `#1414320A 0 1 3`
    static let panelContact = Layer(alpha: 0.04, y: 1, blur: 3)
    /// `#1414320D 0 2 6`
    static let controlLift = Layer(alpha: 0.05, y: 2, blur: 6)
    /// `#14143208 0 1 2`
    static let controlContact = Layer(alpha: 0.03, y: 1, blur: 2)

    /// Outer lift first, contact edge second — the order the board lists them in.
    var layers: [Layer] {
        switch self {
        case .canvas: [Self.canvasLift]
        case .panel: [Self.panelLift, Self.panelContact]
        case .control: [Self.controlLift, Self.controlContact]
        }
    }
}

extension View {
    /// Applies an elevation level to this view.
    ///
    /// CSS paints every layer of a `box-shadow` from the same box, whereas chained SwiftUI
    /// shadows take the previous result as their source — so here the contact edge also
    /// casts a shadow of the outer lift. At these alphas (0.055 at the very darkest, over
    /// near-white surfaces) that second-order pass is below the display's resolution, and
    /// keeping the modifiers chained keeps the board's layer order legible in the code.
    @ViewBuilder
    func elevation(_ level: Elevation) -> some View {
        switch level {
        case .canvas:
            shadow(Elevation.canvasLift)
        case .panel:
            shadow(Elevation.panelLift).shadow(Elevation.panelContact)
        case .control:
            shadow(Elevation.controlLift).shadow(Elevation.controlContact)
        }
    }

    fileprivate func shadow(_ layer: Elevation.Layer) -> some View {
        shadow(color: layer.color, radius: layer.shadowRadius, x: 0, y: layer.y)
    }
}
