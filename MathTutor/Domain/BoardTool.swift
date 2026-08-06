import Foundation

/// The four tools the design's rail offers.
///
/// These are domain values rather than PencilKit types so rail state can be
/// asserted without a canvas and the Domain layer keeps no UI dependency. The
/// board feature owns the mapping onto `PKInkingTool` / `PKEraserTool` /
/// `PKLassoTool` at the point where it configures `canvas.tool`.
enum BoardTool: String, CaseIterable, Codable, Identifiable, Sendable {
    case pen
    case highlighter
    case eraser
    case lasso

    static let defaultValue: BoardTool = .pen

    var id: String { rawValue }
}

/// The five pen inks, keyed by their design-token hex.
///
/// The raw value is the token's own hex so a swatch and the ink it arms cannot
/// drift apart, and so a mismatch against the foundations board is a one-line
/// test rather than a visual inspection. The design-system layer owns the
/// mapping to `DS.Color.pen*`; holding a SwiftUI `Color` here is what would
/// make the palette untestable and drag UI into Domain.
///
/// `--color-pen-violet` and `--color-brand` share `#6051DC` **by coincidence**.
/// The foundations board states this outright and adds "do not alias them": the
/// brand violet can be re-picked without the pen palette following it.
enum PenColor: String, CaseIterable, Codable, Identifiable, Sendable {
    case black = "#0A0A0A"
    case violet = "#6051DC"
    case blue = "#0155FB"
    case green = "#40A365"
    case red = "#E33E38"

    /// Swatch 1, and the fill the design gives the thickness indicator.
    static let defaultValue: PenColor = .black

    var id: String { rawValue }

    /// The token hex exactly as the foundations board writes it: `#`-prefixed,
    /// upper-case, six digits.
    var hex: String { rawValue }
}

/// Stroke widths in points.
///
/// **These three values are not from the design.** The rail shows one passive
/// 36 × 5 indicator and specifies neither the available widths nor how the
/// student picks between them, so this is a decision rather than a
/// transcription, and it is kept as small as a control can be.
///
/// `medium` is 5 because that is the only width the design does pin down — the
/// indicator bar is 5pt tall — and it is also PencilKit's default pen width, so
/// an untouched board inks exactly what the rail draws. `fine` and `bold` halve
/// and double it: a smaller ratio reads as the same pen with jitter rather than
/// a different one, and all three stay inside PencilKit's 1–20pt valid range
/// for `.pen`, so nothing has to be clamped on its way to the canvas.
enum StrokeThickness: String, CaseIterable, Codable, Identifiable, Sendable {
    case fine
    case medium
    case bold

    static let defaultValue: StrokeThickness = .medium

    var id: String { rawValue }

    /// Doubles as the height of the rail's indicator bar, whose 2.5pt radius the
    /// design derives as exactly half its height so the caps stay semicircular.
    var pointWidth: CGFloat {
        switch self {
        case .fine: 2.5
        case .medium: 5
        case .bold: 10
        }
    }
}
