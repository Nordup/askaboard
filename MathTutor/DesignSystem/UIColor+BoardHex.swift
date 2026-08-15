import UIKit

extension UIColor {
    /// The one reading of a `BoardStyle` colour string.
    ///
    /// Board colours arrive from the server as opaque `#RRGGBB` and nothing
    /// else: no shorthand, no alpha channel, no named colour. Anything that is
    /// not exactly that returns `nil`, and every caller substitutes its own
    /// sensible colour rather than guessing at the string — `stroke` falls back
    /// to black, `fill` to clear.
    ///
    /// This lives beside the design system rather than inside the renderer
    /// because two board subsystems now read the same field: the Core Graphics
    /// renderer for stroke and fill, and `BoardMathStore` for the colour it
    /// typesets notation in.
    convenience init?(hex: String) {
        let value = hex.trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix("#"), value.count == 7,
              let digits = UInt32(value.dropFirst(), radix: 16)
        else { return nil }
        self.init(
            red: CGFloat((digits >> 16) & 0xFF) / 255,
            green: CGFloat((digits >> 8) & 0xFF) / 255,
            blue: CGFloat(digits & 0xFF) / 255,
            alpha: 1
        )
    }
}
