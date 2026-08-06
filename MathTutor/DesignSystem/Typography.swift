import SwiftUI
import UIKit

extension DS {
    /// `--font-weight-*`, minus the 700 the export carries for its own documentation
    /// boards. Board 01: *"The heaviest weight the product uses"* is 600.
    enum FontWeight: Int, CaseIterable, Sendable {
        /// `--font-weight-regular` — body copy, message text, placeholders.
        case regular = 400
        /// `--font-weight-medium` — suggestion-chip labels.
        case medium = 500
        /// `--font-weight-semibold` — headings, status bar, the selection label.
        case semibold = 600
    }

    /// `--font-sans`, and the product has no other. `--font-doc` (Montserrat) and
    /// `--font-mono` (IBM Plex Mono) exist in the export for the documentation boards and
    /// must never reach a screen.
    enum Font {
        /// The name CoreText files all three weights under.
        ///
        /// The three files carry *different* legacy family names (name ID 1: "Source Sans
        /// 3", "Source Sans 3 Medium", "Source Sans 3 Semibold") but a common typographic
        /// family (name ID 16: "Source Sans 3"). CoreText prefers ID 16, so they resolve
        /// as one family with three members rather than three one-member families — which
        /// is the case that would have forced weight-suffixed family names here.
        static let family = "Source Sans 3"

        /// Lookups go through the PostScript name, not the family plus a weight. Asking
        /// for a family and leaning on `Font.Weight` lets the system synthesise a face
        /// that was never designed, and the product ships exactly three that were.
        static func postScriptName(for weight: FontWeight) -> String {
            switch weight {
            case .regular: "SourceSans3-Regular"
            case .medium: "SourceSans3-Medium"
            case .semibold: "SourceSans3-Semibold"
            }
        }

        /// The bundled file backing each weight, registered by `UIAppFonts`.
        static func resourceName(for weight: FontWeight) -> String {
            postScriptName(for: weight)
        }

        /// Makes sure the three faces are resolvable, and does nothing when they already
        /// are — which is the normal case, because `UIAppFonts` in the Info.plist registers
        /// them before any view loads. It exists for the paths where that does not run:
        /// a preview or a test host that does not copy the plist. Calling it twice is
        /// harmless; the second call takes the early return.
        static func register() {
            guard UIFont(name: postScriptName(for: .regular), size: 12) == nil else { return }
            for weight in FontWeight.allCases {
                guard
                    UIFont(name: postScriptName(for: weight), size: 12) == nil,
                    let url = Bundle.main.url(forResource: resourceName(for: weight), withExtension: "otf")
                else { continue }
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }

        /// The face the design asks for, or the system's at the same size if the bundle
        /// is missing it. Falling back rather than trapping keeps a missing font a visual
        /// bug in one place instead of a crash on launch.
        static func uiFont(size: CGFloat, weight: FontWeight) -> UIFont {
            UIFont(name: postScriptName(for: weight), size: size) ?? .systemFont(ofSize: size)
        }

        /// `fixedSize`, not `size`: `Font.custom(_:size:)` scales with Dynamic Type, and
        /// board 09 specifies every position on every screen as an absolute constant. Type
        /// that grows would push content out of boxes whose heights are pinned to the
        /// point. Dynamic Type is listed as undesigned, so this is the honest reading.
        static func font(size: CGFloat, weight: FontWeight) -> SwiftUI.Font {
            .custom(postScriptName(for: weight), fixedSize: size)
        }
    }

    /// `--tracking-*`, in em — the unit the design states them in. `--tracking-wide`
    /// (0.06em) is documentation-only and is deliberately absent.
    enum Tracking {
        /// `--tracking-tight` −0.01em. Applied to `--text-title` and `--text-display`
        /// only: *"Large type needs the air taken out of it."*
        static let tight: CGFloat = -0.01
        /// Everything else on the type scale sets no tracking at all.
        static let normal: CGFloat = 0
    }
}

/// One row of the design's type scale: a size, the line box it sits in, a weight, and
/// tracking in em.
///
/// The two derived values below are the whole reason this is a type rather than four
/// modifiers at each call site — both conversions are easy to get wrong, and getting
/// either wrong is invisible until the layout is compared against the board.
struct TextStyle: Equatable, Sendable {
    /// `--text-*`, in points.
    let size: CGFloat
    /// `--leading-*`. CSS `line-height`: the height of the whole line box, *including*
    /// the glyphs — not the space between lines.
    let leading: CGFloat
    let weight: DS.FontWeight
    /// In em, as the design expresses it. See `trackingPoints`.
    let tracking: CGFloat

    init(size: CGFloat, leading: CGFloat, weight: DS.FontWeight, tracking: CGFloat = DS.Tracking.normal) {
        self.size = size
        self.leading = leading
        self.weight = weight
        self.tracking = tracking
    }
}

extension TextStyle {
    var uiFont: UIFont { DS.Font.uiFont(size: size, weight: weight) }
    var font: SwiftUI.Font { DS.Font.font(size: size, weight: weight) }

    /// `.tracking()` takes points; the design states em. One em is the font size, so the
    /// conversion is a multiply — −0.01em at 40pt is −0.4pt. Passing the em value straight
    /// through would set −0.01pt, which is no tracking at all.
    var trackingPoints: CGFloat { tracking * size }

    /// The line box the font draws for itself: ascent + |descent| + line gap. Measured off
    /// the real `UIFont` rather than assumed, because it is a property of the face — swap
    /// the typeface and every number derived from it changes. Source Sans 3 has a 1000/1000
    /// ascent, a 326/1000 descent and no line gap, so it comes out at 1.326 × size.
    var naturalLineHeight: CGFloat { uiFont.lineHeight }

    /// SwiftUI's `.lineSpacing` is extra space *between* lines, so the design's total line
    /// box has to have the font's own height taken out of it first.
    ///
    /// Clamped at 0, and it bites: five of the ten styles ask for a line box *tighter* than
    /// Source Sans 3 draws — `display` (48 wanted, 53.04 drawn), `title` (34 / 34.48),
    /// `chipFullScreen` (24 / 26.52), `bodyControl` (22 / 22.54) and `label` (18 / 19.89).
    /// SwiftUI cannot compress a line, so those get 0 here and `lineBoxCompensation`
    /// absorbs the overhang instead. All five are single-line by design — headline,
    /// chip label, control text, status bar — which is why the design could specify them
    /// that tight in the first place.
    var lineSpacing: CGFloat { max(0, leading - naturalLineHeight) }

    /// Vertical padding that makes a rendered `Text` occupy the design's line box rather
    /// than the font's.
    ///
    /// A `Text` lays out at `n × naturalLineHeight + (n − 1) × lineSpacing`, which for the
    /// styles that do not clamp is `naturalLineHeight + (n − 1) × leading` — one line's
    /// worth of overshoot or undershoot regardless of how many lines there are. Half of
    /// that difference on each edge cancels it, and the result is exact for a single line
    /// and correct to that same constant for a wrapped paragraph. Negative when the font
    /// draws taller than the design's leading, which is what makes the five clamped styles
    /// centre correctly inside the fixed-height containers board 09 specifies.
    var lineBoxCompensation: CGFloat { (leading - naturalLineHeight) / 2 }
}

// MARK: - The type scale

extension TextStyle {
    /// Greeting headline at full-screen scale. The largest type in the product; appears
    /// exactly once per screen.
    static let display = TextStyle(
        size: DS.Size.display, leading: DS.Leading.display, weight: .semibold, tracking: DS.Tracking.tight
    )

    /// Greeting headline at panel scale, in the 337pt column.
    static let title = TextStyle(
        size: DS.Size.title, leading: DS.Leading.title, weight: .semibold, tracking: DS.Tracking.tight
    )

    /// Lead paragraph and composer placeholder at full-screen scale. Pairs with `display`.
    static let lead = TextStyle(size: DS.Size.lead, leading: DS.Leading.lead, weight: .regular)

    /// Suggestion-chip label at full-screen scale, where the reading column is 740 wide.
    static let chipFullScreen = TextStyle(
        size: DS.Size.bodyLarge, leading: DS.Leading.snug, weight: .medium
    )

    /// Running body text — message bubbles and any wrapped paragraph.
    static let body = TextStyle(size: DS.Size.body, leading: DS.Leading.body, weight: .regular)

    /// Short centred body copy.
    ///
    /// Board 01 flags the 24-vs-25 split as unresolved: *"the panel greeting's body copy
    /// sits at 24 while message text sits at 25, and there is no design reason for the
    /// difference — it is left as measured rather than silently corrected here."* Both are
    /// carried here as separate styles rather than reconciled, so whichever way the
    /// designer settles it is a one-line change with a name attached.
    static let bodyCentred = TextStyle(size: DS.Size.body, leading: DS.Leading.snug, weight: .regular)

    /// Single-line text inside a control — the composer placeholder at panel scale.
    /// Tighter than `body` because it is optically centred and never wraps.
    static let bodyControl = TextStyle(size: DS.Size.body, leading: DS.Leading.control, weight: .regular)

    /// Suggestion-chip label at panel scale.
    static let chipPanel = TextStyle(size: DS.Size.body, leading: DS.Leading.snug, weight: .medium)

    /// The "Selection" attachment label and small meta. The smallest size in the
    /// product — nothing goes below this.
    static let label = TextStyle(size: DS.Size.label, leading: DS.Leading.label, weight: .semibold)

    /// Status bar: 15px text in a 20px band.
    static let statusBar = TextStyle(size: DS.Size.label, leading: DS.Leading.tight, weight: .semibold)

    /// Every style the design specifies, for tests and for a specimen screen.
    static let scale: [TextStyle] = [
        display, title, lead, chipFullScreen, body, bodyCentred, bodyControl, chipPanel, label, statusBar,
    ]
}

extension DS {
    /// So a component can spell it `DS.TextStyle` without the leading-dot form losing its
    /// inference at the call site.
    typealias TextStyle = MathTutor.TextStyle
}

// MARK: - Applying a style

extension Text {
    /// Font, tracking, leading and the line-box compensation, in one call.
    func textStyle(_ style: TextStyle) -> some View {
        font(style.font)
            .tracking(style.trackingPoints)
            .lineSpacing(style.lineSpacing)
            .padding(.vertical, style.lineBoxCompensation)
    }
}

extension View {
    /// The container form: sets the same four things through the environment so a stack of
    /// `Text` children inherits them. Prefer the `Text` form for a single string — this one
    /// pads the container once, not each line of each child.
    func textStyle(_ style: TextStyle) -> some View {
        font(style.font)
            .tracking(style.trackingPoints)
            .lineSpacing(style.lineSpacing)
    }
}
