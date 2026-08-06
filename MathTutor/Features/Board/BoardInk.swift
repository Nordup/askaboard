import PencilKit
import UIKit

/// Turns the rail's `(BoardTool, PenColor, StrokeThickness)` selection into the
/// one `PKTool` the canvas draws with.
///
/// The app owns tool selection now that `PKToolPicker` is gone, so this mapping
/// is the whole contract between the rail and PencilKit. It is a caseless enum
/// of pure functions on purpose: no canvas, no window, and no first responder
/// are needed to assert what a rail selection actually inks.
enum BoardInk {
    /// **Not from the design.** The design draws a highlighter glyph and says
    /// nothing about its ink.
    ///
    /// A highlighter has to leave the work underneath readable — that is the
    /// entire point of highlighting a line of maths rather than writing over it.
    /// The alpha has to be applied here because it exists nowhere else: the five
    /// swatch tokens are opaque, and `.marker` paints at whatever alpha its
    /// colour carries, so a highlighter built straight from a swatch would bury
    /// the working it was drawn over. At 0.3 the ink underneath keeps 70% of its
    /// own contrast — black handwriting stays plainly black — while the band is
    /// still unambiguous against the board's white paper.
    static let highlighterAlpha: CGFloat = 0.3

    /// **Not from the design**, for the same reason as `highlighterAlpha`.
    ///
    /// A highlighter at the pen's width is not a highlighter — it is a pale pen.
    /// The band has to be wide enough to cover a written line, so it scales with
    /// the same thickness step the pen uses rather than being a fixed width:
    /// a student who picked a fine pen is writing small and wants a fine band.
    /// 4x puts the three steps at 10 / 20 / 40pt against handwriting whose
    /// x-height is on the order of 50pt, and keeps every step inside
    /// `.marker`'s valid width range so nothing is silently clamped.
    static let highlighterWidthMultiple: CGFloat = 4

    static func tool(
        for tool: BoardTool,
        color: PenColor,
        thickness: StrokeThickness
    ) -> PKTool {
        switch tool {
        case .pen:
            PKInkingTool(.pen, color: uiColor(for: color), width: thickness.pointWidth)
        case .highlighter:
            PKInkingTool(
                .marker,
                color: uiColor(for: color).withAlphaComponent(highlighterAlpha),
                width: thickness.pointWidth * highlighterWidthMultiple
            )
        case .eraser:
            // **Not from the design**, which names the tool and draws its glyph
            // but does not choose an eraser model.
            //
            // Vector, because a student erasing handwritten maths wants a wrong
            // term gone, not scrubbed: one touch removes the whole stroke and
            // never leaves the half-letters and crumbs that pixel erasing does.
            // It also keeps board evaluation honest. Bitmap erasing masks a
            // stroke instead of removing it, and `CanvasCapture` derives the
            // evaluated region from `PKStroke.renderBounds` and the centroid of
            // the stroke centers — so ink the student believes they erased would
            // go on dragging the crop toward wherever it used to be.
            PKEraserTool(.vector)
        case .lasso:
            // **Not from the design.** `PKLassoTool()` takes no parameters, and
            // it needs none: selecting strokes then brings up UIKit's own edit
            // menu (cut, copy, paste, duplicate, delete) straight from
            // PencilKit, which is why the canvas keeps its first-responder
            // handling in `BoardCanvas`. What the design does not give it is any
            // way to hand a selection to the tutor — that is `btn/select`, a
            // separate control with its own attachment chip — nor any drawn
            // state for "something is selected". Those would be new UI, so the
            // rail's lasso is exactly PencilKit's selection and nothing more.
            PKLassoTool()
        }
    }

    /// The pen palette's token hex as an exact 8-bit sRGB colour.
    ///
    /// Parsed from `PenColor.hex` rather than switched over the five cases: the
    /// raw value *is* the design token, and re-typing its components here is how
    /// a swatch and the ink it arms would quietly drift apart.
    static func uiColor(for color: PenColor) -> UIColor {
        let digits = color.hex.dropFirst()
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else {
            // Unreachable: `PenColor`'s raw values are six-digit `#RRGGBB`
            // tokens, and a test walks all five. Trapping keeps a malformed new
            // case from shipping as a silently wrong colour.
            preconditionFailure("PenColor.hex must be a six-digit #RRGGBB token: \(color.hex)")
        }
        return UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }
}
