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

    /// Which of the export's families a style is set in.
    ///
    /// This used to be a comment rather than a type: *"`--font-sans`, and the product has no
    /// other. `--font-doc` (Montserrat) and `--font-mono` (IBM Plex Mono) exist in the export
    /// for the documentation boards and must never reach a screen."* The settings redesign
    /// breaks half of that — `field/key` sets the masked API key in `--font-mono`, on the
    /// reasoning that a credential is not prose and its bullet run should mask at an even
    /// pitch. `--font-doc` is still documentation-only and has no case here.
    enum FontFamily: Sendable {
        /// `--font-sans` (Source Sans 3). Everything that is not a credential.
        case sans
        /// `--font-mono` (IBM Plex Mono in the design; see `DS.Font.uiFont` for what actually
        /// renders). Exactly one user: the stored API key.
        case mono
    }

    /// `--font-sans`, plus the one monospaced exception `FontFamily` documents.
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
        ///
        /// **`.mono` always takes the fallback path, and that is not an accident.** The
        /// design names IBM Plex Mono; `UIAppFonts` registers three files and all three are
        /// Source Sans 3, so there is no Plex to resolve. Asking for it by name would
        /// silently return the *proportional* system face and quietly lose the one property
        /// the design chose mono for — an even pitch under the bullet mask. The system's
        /// monospaced face keeps that property and is honest about not being Plex. Bundling
        /// `IBMPlexMono-Regular.otf` is the fix; until then this is the substitution, and it
        /// is the only place in the product where a family other than Source Sans 3 renders.
        static func uiFont(size: CGFloat, weight: FontWeight, family: FontFamily = .sans) -> UIFont {
            switch family {
            case .sans:
                UIFont(name: postScriptName(for: weight), size: size) ?? .systemFont(ofSize: size)
            case .mono:
                .monospacedSystemFont(ofSize: size, weight: uiWeight(for: weight))
            }
        }

        /// `FontWeight` is a design token; `UIFont.Weight` is what the system face needs.
        /// Only the monospaced path uses this — the sans path goes through PostScript names
        /// precisely so the system never synthesises a weight that was not drawn.
        static func uiWeight(for weight: FontWeight) -> UIFont.Weight {
            switch weight {
            case .regular: .regular
            case .medium: .medium
            case .semibold: .semibold
            }
        }

        /// `fixedSize`, not `size`: `Font.custom(_:size:)` scales with Dynamic Type, and
        /// board 09 specifies every position on every screen as an absolute constant. Type
        /// that grows would push content out of boxes whose heights are pinned to the
        /// point. Dynamic Type is listed as undesigned, so this is the honest reading.
        ///
        /// The monospaced branch takes `.system(size:weight:design:)` for the same reason it
        /// is fixed here — that initialiser does not scale — so both families stay pinned.
        static func font(size: CGFloat, weight: FontWeight, family: FontFamily = .sans) -> SwiftUI.Font {
            switch family {
            case .sans:
                .custom(postScriptName(for: weight), fixedSize: size)
            case .mono:
                .system(size: size, weight: swiftUIWeight(for: weight), design: .monospaced)
            }
        }

        static func swiftUIWeight(for weight: FontWeight) -> SwiftUI.Font.Weight {
            switch weight {
            case .regular: .regular
            case .medium: .medium
            case .semibold: .semibold
            }
        }
    }

    /// `--tracking-*`, in em — the unit the design states them in.
    enum Tracking {
        /// `--tracking-tight` −0.01em. Applied to `--text-title` and `--text-display`
        /// only: *"Large type needs the air taken out of it."*
        static let tight: CGFloat = -0.01
        /// Everything else on the type scale sets no tracking at all.
        static let normal: CGFloat = 0
        /// `--tracking-wide` 0.06em. It was documentation-only for as long as nothing in
        /// the product set an all-caps label; board 17's `RECENT` is the first, and a
        /// small-caps section head with no letter-spacing reads as a typo rather than as
        /// a heading. Paired with `.textCase(.uppercase)` at the call site and used
        /// nowhere else — see `SessionsDrawerMetrics.sectionLabel`.
        static let wide: CGFloat = 0.06
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
    /// Defaulted, because nine of the ten styles on the scale never set it. See
    /// `DS.FontFamily` for the one that does and why.
    let family: DS.FontFamily

    init(
        size: CGFloat,
        leading: CGFloat,
        weight: DS.FontWeight,
        tracking: CGFloat = DS.Tracking.normal,
        family: DS.FontFamily = .sans
    ) {
        self.size = size
        self.leading = leading
        self.weight = weight
        self.tracking = tracking
        self.family = family
    }
}

extension TextStyle {
    var uiFont: UIFont { DS.Font.uiFont(size: size, weight: weight, family: family) }
    var font: SwiftUI.Font { DS.Font.font(size: size, weight: weight, family: family) }

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

    /// What a second line costs: the font's own box plus whatever `lineSpacing` puts between
    /// lines. Equal to `leading` for the five styles the face fits inside, and equal to
    /// `naturalLineHeight` for the five that clamp — SwiftUI cannot compress a line, so a
    /// wrapped `bodyControl` paragraph advances 22.54 where the design asked for 22.
    ///
    /// The height of `n` lines is therefore `naturalLineHeight + (n − 1) × lineAdvance`, which
    /// is the same expression `lineBoxCompensation` is derived from — this one names the term
    /// that a growing control needs on its own.
    var lineAdvance: CGFloat { naturalLineHeight + lineSpacing }

    /// What `lines` lines of this style lay out at: the first line's own box, and an advance for
    /// each line after it. `n × naturalLineHeight + (n − 1) × lineSpacing`, rearranged — which is
    /// one advance short of `n × lineAdvance`, because the spacing sits *between* lines and
    /// there is none under the last one.
    func height(lines: Int) -> CGFloat {
        guard lines > 0 else { return 0 }
        return naturalLineHeight + CGFloat(lines - 1) * lineAdvance
    }

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

    /// A trail step's own label, and the closed summary row's `Worked for 1m 15s` — board
    /// 14 §04, the activity trail. `--text-label` 15 pairs with `--leading-control` 22
    /// rather than `label`'s own `--leading-label` 18: every other 15pt run in the product
    /// is a tight single-line label, and a step's own label is the first one that wraps.
    /// The step label and the closed summary are typographically identical, so this is the
    /// one name for both rather than two names for one value.
    static let trailLabel = TextStyle(size: DS.Size.label, leading: DS.Leading.control, weight: .semibold)

    /// The trail's reasoning paragraph — the same 15/22 line box as `trailLabel`, dropped to
    /// 400 weight. Board 14: *"weight, not colour, separates reasoning from steps."*
    static let trailReasoning = TextStyle(size: DS.Size.label, leading: DS.Leading.control, weight: .regular)

    /// The same small semibold label on the reading column — 17 / 25 where the panel's is
    /// 15 / 18.
    ///
    /// **Extrapolated, and only once.** Board 13 states this step exactly once, for the
    /// session plan's kicker: *"17 / 25 · 600, where the panel's kicker is 15 / 18 · 600."*
    /// Every other small label that has to cross to the wide surface takes the same step by
    /// referring to this rather than by restating the numbers — which is why it is here and
    /// not inline in the two places that need it.
    ///
    /// Not in `scale`: that list is the styles the design *specifies*, and this is the one
    /// the design implies.
    static let labelFullScreen = TextStyle(
        size: DS.Size.body,
        leading: DS.Leading.body,
        weight: .semibold
    )

    /// `--text-body-lg` 20 / 24 · 600 — one step above `labelFullScreen`, for a label that
    /// has to hold its own beside 21pt body copy rather than sit quietly under it.
    ///
    /// The settings row's full-screen label is drawn at exactly this, so it is a size the
    /// wide surface already carries rather than a new one.
    static let labelLarge = TextStyle(
        size: DS.Size.bodyLarge,
        leading: DS.Leading.snug,
        weight: .semibold
    )

    /// Every style the design specifies, for tests and for a specimen screen.
    static let scale: [TextStyle] = [
        display, title, lead, chipFullScreen, body, bodyCentred, bodyControl, chipPanel, label,
        trailLabel, trailReasoning,
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
