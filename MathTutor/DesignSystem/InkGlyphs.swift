import CoreGraphics
import Foundation

/// One character of the board's handwriting: what the pen draws, and how far
/// the pen moves afterwards.
///
/// The strokes are pen-down polylines, not outlines. Width is not part of a
/// glyph — `InkTextRenderer` gives the centreline a tapered body at draw time,
/// and `E2ESeedFixture` hands the same centreline to a `PKInk` pen. One shape,
/// two pens.
struct InkGlyph: Hashable, Sendable {
    /// How far the pen travels right after this glyph, in cap heights.
    let advance: CGFloat
    /// Pen-down polylines in the unit box `InkGlyphs` describes. An empty list
    /// is a space: the pen moves and draws nothing.
    let strokes: [[CGPoint]]
}

/// The app's own handwriting, and the cursor that lays it out.
///
/// Models write text well and letterform geometry badly, so the app owns the
/// letters: the model sends a string and this table decides what a `q` looks
/// like. The table is hand-authored rather than lifted from a vector font
/// because a stroke font is what handwriting *is* — a pen path with a start and
/// an end — while an outline font is a filled region with no pen in it, and
/// nothing downstream (the taper, the pressure, the PencilKit pen) can be
/// recovered from a filled region.
///
/// ## The unit box
///
/// Every glyph is authored in a box measured in *cap heights*, with x to the
/// right and y **down**, matching the board's own coordinate system:
///
/// ```
///   y = -0.06   overshoot — as high as anything reaches: ( ) and /
///   y =  0.00   the cap line: the top of A–Z, of b d f h k l, and of 0–9
///   y =  0.30   the x-height line: the top of the lowercase body
///   y =  1.00   the baseline
///   y =  1.28   the descender line: the bottom of g j p q y and of a comma
/// ```
///
/// So one cap height is one unit, and `size` in an `ink_text` element is that
/// cap height in board points. A glyph's x runs from 0 to its own `advance`.
/// `InkTextTests` sweeps every glyph against that box, because a stroke that
/// leaves it is ink outside the bounds the renderer reports — which is a
/// clipped tile on the board, not a cosmetic problem.
///
/// ## What this type is not
///
/// It is not a font and it is not notation. Notation belongs to `math_text`,
/// which typesets LaTeX properly; this is a teacher's handwriting for hints,
/// encouragement and margin notes. The character set is therefore prose plus
/// the operators that turn up inside prose, not a mathematical alphabet.
enum InkGlyphs {

    // MARK: - Metrics

    /// The top of a lowercase body, as a y in the unit box.
    static let xHeight: CGFloat = 0.30
    /// The baseline, as a y in the unit box. One cap height below the cap line.
    static let baseline: CGFloat = 1
    /// The highest a glyph may reach.
    ///
    /// A bracket and a slash are taller than the capitals they stand beside —
    /// that is what a hand does with them, and it is the whole of what this
    /// line is for. The round capitals of this alphabet are *not* drawn above
    /// the cap line: `O`, `C`, `S` and `0` all start at 0.02, so the optical
    /// overshoot a typeface would give them is not part of this hand. The line
    /// still bounds the box the bounds arm measures, so widening it later costs
    /// nothing but a re-sweep.
    static let overshoot: CGFloat = -0.06
    /// The lowest a glyph may reach — the tail of a `g`, `j`, `p`, `q` or `y`.
    static let descender: CGFloat = 1.28
    /// Tracking between two glyphs, in cap heights.
    static let letterSpacing: CGFloat = 0.06
    /// Baseline to baseline, in cap heights. Wide enough that a descender on
    /// one line clears the cap line of the next.
    static let lineHeight: CGFloat = 1.62
    /// The width of a space, in cap heights.
    static let spaceAdvance: CGFloat = 0.34

    /// The size range the server's schema allows, restated here because a
    /// persisted scene reaches this code without passing through the server
    /// again. Out-of-range sizes are clamped rather than refused: a note at the
    /// wrong size is still a readable note.
    static let minimumSize: CGFloat = 8
    static let maximumSize: CGFloat = 256

    /// The character budget the server's `MAX_INK_TEXT_CHARS` enforces, kept
    /// here for the same reason as the size range. Every glyph costs real
    /// geometry — a smoothed centreline, an offset outline on both sides — so
    /// this is what bounds the work one element can ask for.
    static let maximumCharacters = 400

    /// What a character with no glyph is drawn as. An underscore is visible,
    /// obviously not a letter, and takes exactly the space the missing glyph
    /// would have taken, so the rest of the line still reads.
    static let fallbackCharacter: Character = "_"

    static func clampedSize(_ size: CGFloat) -> CGFloat {
        guard size.isFinite else { return minimumSize }
        return min(maximumSize, max(minimumSize, size))
    }

    // MARK: - The table

    /// Every character this build can write, including the space.
    static let glyphs: [Character: InkGlyph] = lowercase
        .merging(uppercase) { first, _ in first }
        .merging(digits) { first, _ in first }
        .merging(symbols) { first, _ in first }

    /// The glyph for a character, after the substitutions `canonical` makes.
    /// `nil` means nothing in this table can draw it.
    static func glyph(for character: Character) -> InkGlyph? {
        glyphs[canonical(character)]
    }

    /// The string as the table will actually be asked to write it.
    ///
    /// A model writes in a typographic register — every prompt it has ever read
    /// is full of em dashes, curly quotes and ellipses — and none of those has
    /// its own hand-drawn letterform here. Without this pass they would each
    /// come out as the placeholder underscore, which is how a warm margin note
    /// turns into `Nice work _ keep going!`. Each one has an obvious equivalent
    /// the table already draws, so substituting is strictly better than drawing
    /// the placeholder at it.
    ///
    /// A pass over the string rather than over each character, because one of
    /// the substitutions is not one-for-one: an ellipsis is three full stops.
    /// It runs *after* the character budget is taken, so the budget still
    /// counts what the model actually wrote.
    ///
    /// What it deliberately does not do is guess. `*` stays unwritable rather
    /// than becoming `×`, because a model writing `**Nice!**` means emphasis
    /// and not multiplication, and a substitution that is right half the time
    /// is worse than a placeholder that says so in the log.
    static func normalized(_ text: String) -> String {
        var result = ""
        result.reserveCapacity(text.count)
        for character in text {
            if character == "\u{2026}" {
                result += "..."
            } else {
                result.append(canonical(character))
            }
        }
        return result
    }

    /// The character a glyph is looked up under: the one-for-one half of
    /// `normalized`, and the guard for anything that reaches `glyph(for:)`
    /// without having gone through it.
    static func canonical(_ character: Character) -> Character {
        switch character {
        // Curly single quotes, and the modifier letter apostrophe a few
        // keyboards produce.
        case "\u{2018}", "\u{2019}", "\u{201A}", "\u{02BC}": "'"
        // Curly double quotes, including the low one.
        case "\u{201C}", "\u{201D}", "\u{201E}": "\""
        // Em, en, figure and horizontal-bar dashes. The mathematical minus at
        // U+2212 keeps its own letterform — it is a wider stroke, and it is
        // what the seeded attempt is written with.
        case "\u{2013}", "\u{2014}", "\u{2012}", "\u{2015}": "-"
        // Every space that is not the space: non-breaking, narrow no-break,
        // thin, en, em, and the tab.
        case "\u{00A0}", "\u{202F}", "\u{2009}", "\u{2002}", "\u{2003}", "\t": " "
        // The two unambiguous multiplication marks. Not `*` — see `normalized`.
        case "\u{2217}", "\u{22C5}": "\u{00D7}"
        default: character
        }
    }

    // MARK: - Layout

    /// One glyph, placed.
    struct PlacedGlyph: Hashable, Sendable {
        let glyph: InkGlyph
        /// The glyph's own origin — the pen's x and the line's cap line y — in
        /// board points, relative to the element's top-left corner. A unit
        /// point `u` of the glyph lands at `origin + u * size`.
        let origin: CGPoint
        /// The character's offset in the laid-out text. This is what seeds the
        /// per-character jitter, so it must stay the character's position and
        /// not the placement's: a line break has no glyph but still moves it.
        let index: Int
    }

    /// A laid-out string: where every glyph goes, and how large the whole is.
    struct Layout: Hashable, Sendable {
        let placements: [PlacedGlyph]
        /// The metric box in board points, measured from the element's `(x, y)`.
        /// It is the *line* box, not the inked box — the full ascender-to-
        /// descender band of every line, whether or not this particular text
        /// has an ascender or a descender in it, exactly as a text box is.
        let size: CGSize
        /// The codepoints this table had no glyph for, sorted and unique. The
        /// renderer logs these; layout itself stays silent, because the bounds
        /// arm lays the same text out on every reconcile.
        let unsupported: [UInt32]

        /// Nothing to draw: no text, only spaces, or only line breaks.
        var isEmpty: Bool { placements.isEmpty }
    }

    /// Lays a string out at a cap height of `size` board points.
    ///
    /// The origin of the returned coordinates is the element's top-left corner:
    /// local y 0 is the top of the first line's band, which sits `-overshoot`
    /// above that line's cap line. So an element's `y` is the top edge of the
    /// text, the same promise `text` makes.
    static func layout(text: String, size rawSize: CGFloat) -> Layout {
        let size = clampedSize(rawSize)
        let capInset = -overshoot * size
        var placements: [PlacedGlyph] = []
        var unsupported: Set<UInt32> = []
        var widest: CGFloat = 0
        var pen: CGFloat = 0
        var lineIndex = 0
        var index = 0

        for character in normalized(String(text.prefix(maximumCharacters))) {
            defer { index += 1 }
            if character.isNewline {
                widest = max(widest, max(0, pen - letterSpacing * size))
                pen = 0
                lineIndex += 1
                continue
            }
            let resolved: InkGlyph
            if let known = glyph(for: character) {
                resolved = known
            } else {
                unsupported.insert(character.unicodeScalars.first?.value ?? 0)
                resolved = glyphs[fallbackCharacter] ?? InkGlyph(advance: spaceAdvance, strokes: [])
            }
            if !resolved.strokes.isEmpty {
                placements.append(PlacedGlyph(
                    glyph: resolved,
                    origin: CGPoint(
                        x: pen,
                        y: capInset + CGFloat(lineIndex) * lineHeight * size
                    ),
                    index: index
                ))
            }
            pen += (resolved.advance + letterSpacing) * size
        }
        widest = max(widest, max(0, pen - letterSpacing * size))

        let height = capInset
            + CGFloat(lineIndex) * lineHeight * size
            + descender * size
        return Layout(
            placements: placements,
            size: CGSize(width: widest, height: height),
            unsupported: unsupported.sorted()
        )
    }

    /// The laid-out centrelines of a string, in board points.
    ///
    /// The plain pen path, with no smoothing, no taper and no jitter — what a
    /// pen that already has its own character wants. `E2ESeedFixture` hands
    /// these straight to `PKInk`, which is how the seeded learner attempt and
    /// the tutor's own `ink_text` come out of one table instead of two.
    static func strokes(text: String, origin: CGPoint, size: CGFloat) -> [[CGPoint]] {
        let scale = clampedSize(size)
        return layout(text: text, size: scale).placements.flatMap { placement in
            placement.glyph.strokes.map { stroke in
                stroke.map { point in
                    CGPoint(
                        x: origin.x + placement.origin.x + point.x * scale,
                        y: origin.y + placement.origin.y + point.y * scale
                    )
                }
            }
        }
    }

    // MARK: - Glyph data

    /// A glyph from an advance and one flat list of coordinates per stroke.
    ///
    /// Flat `[CGFloat]` literals rather than nested `CGPoint` ones: the table
    /// is eighty-seven glyphs and the type checker charges by the literal.
    private static func glyph(_ advance: CGFloat, _ strokes: [CGFloat]...) -> InkGlyph {
        InkGlyph(advance: advance, strokes: strokes.map(pen))
    }

    private static func pen(_ values: [CGFloat]) -> [CGPoint] {
        assert(values.count >= 4, "a stroke is two points or more")
        assert(values.count % 2 == 0, "a stroke is an even number of coordinates")
        return stride(from: 0, to: values.count - 1, by: 2).map {
            CGPoint(x: values[$0], y: values[$0 + 1])
        }
    }

    private static let lowercase: [Character: InkGlyph] = [
        "a": glyph(0.78,
                   [0.60, 0.42, 0.46, 0.29, 0.22, 0.30, 0.07, 0.48, 0.06, 0.78, 0.19, 0.98, 0.44, 1.00, 0.60, 0.86],
                   [0.60, 0.30, 0.60, 0.88, 0.72, 1.00]),
        "b": glyph(0.74,
                   [0.06, 0.00, 0.06, 1.00],
                   [0.06, 0.60, 0.20, 0.45, 0.44, 0.44, 0.60, 0.58, 0.62, 0.80, 0.50, 0.98, 0.24, 1.02, 0.06, 0.90]),
        "c": glyph(0.70,
                   [0.62, 0.42, 0.46, 0.29, 0.20, 0.32, 0.06, 0.52, 0.06, 0.80, 0.20, 0.99, 0.46, 1.02, 0.64, 0.90]),
        "d": glyph(0.78,
                   [0.64, 0.42, 0.48, 0.29, 0.22, 0.30, 0.07, 0.48, 0.06, 0.78, 0.19, 0.98, 0.44, 1.00, 0.64, 0.86],
                   [0.64, 0.00, 0.64, 0.88, 0.76, 1.00]),
        "e": glyph(0.70,
                   [0.08, 0.68, 0.60, 0.64, 0.56, 0.42, 0.34, 0.28, 0.14, 0.38, 0.06, 0.64, 0.14, 0.90, 0.36, 1.02, 0.62, 0.92]),
        // The advance clears the hook, which reaches to 0.60 — the letterform
        // that overhangs its own width furthest, and the one glyph that broke
        // the box sweep when the advance was set from the crossbar instead.
        "f": glyph(0.62,
                   [0.60, 0.14, 0.50, 0.01, 0.34, 0.02, 0.27, 0.20, 0.27, 1.00],
                   [0.04, 0.36, 0.54, 0.34]),
        "g": glyph(0.76,
                   [0.60, 0.42, 0.46, 0.29, 0.22, 0.30, 0.07, 0.48, 0.06, 0.76, 0.19, 0.96, 0.44, 0.98, 0.60, 0.84],
                   [0.60, 0.30, 0.60, 1.06, 0.50, 1.24, 0.26, 1.28, 0.08, 1.20]),
        "h": glyph(0.72,
                   [0.06, 0.00, 0.06, 1.00],
                   [0.06, 0.52, 0.22, 0.32, 0.46, 0.31, 0.60, 0.48, 0.60, 1.00]),
        "i": glyph(0.34,
                   [0.16, 0.32, 0.15, 1.00],
                   [0.16, 0.08, 0.17, 0.14]),
        "j": glyph(0.40,
                   [0.34, 0.32, 0.34, 1.06, 0.26, 1.24, 0.08, 1.27],
                   [0.35, 0.08, 0.36, 0.14]),
        "k": glyph(0.68,
                   [0.06, 0.00, 0.06, 1.00],
                   [0.58, 0.34, 0.08, 0.74],
                   [0.24, 0.60, 0.60, 1.00]),
        "l": glyph(0.34,
                   [0.12, 0.00, 0.12, 0.88, 0.26, 1.00]),
        "m": glyph(1.00,
                   [0.04, 0.32, 0.04, 1.00],
                   [0.04, 0.50, 0.16, 0.32, 0.34, 0.31, 0.44, 0.48, 0.44, 1.00],
                   [0.44, 0.50, 0.58, 0.32, 0.76, 0.31, 0.88, 0.48, 0.88, 1.00]),
        "n": glyph(0.70,
                   [0.06, 0.32, 0.06, 1.00],
                   [0.06, 0.50, 0.20, 0.32, 0.44, 0.31, 0.58, 0.48, 0.58, 1.00]),
        "o": glyph(0.72,
                   [0.36, 0.29, 0.15, 0.38, 0.06, 0.62, 0.12, 0.88, 0.32, 1.01, 0.55, 0.94, 0.63, 0.70, 0.58, 0.43, 0.38, 0.29]),
        "p": glyph(0.74,
                   [0.06, 0.32, 0.06, 1.28],
                   [0.06, 0.48, 0.22, 0.32, 0.46, 0.32, 0.60, 0.48, 0.61, 0.78, 0.46, 0.96, 0.22, 0.98, 0.06, 0.88]),
        "q": glyph(0.76,
                   [0.60, 0.42, 0.46, 0.30, 0.22, 0.31, 0.07, 0.50, 0.06, 0.79, 0.19, 0.97, 0.44, 0.99, 0.60, 0.86],
                   [0.60, 0.30, 0.60, 1.28, 0.74, 1.20]),
        "r": glyph(0.50,
                   [0.08, 0.32, 0.08, 1.00],
                   [0.08, 0.50, 0.24, 0.33, 0.48, 0.32]),
        "s": glyph(0.62,
                   [0.56, 0.40, 0.42, 0.29, 0.18, 0.31, 0.08, 0.44, 0.18, 0.58, 0.44, 0.68, 0.54, 0.82, 0.44, 0.98, 0.20, 1.02, 0.06, 0.92]),
        "t": glyph(0.54,
                   [0.28, 0.08, 0.28, 0.86, 0.42, 1.00, 0.54, 0.92],
                   [0.04, 0.36, 0.52, 0.34]),
        "u": glyph(0.70,
                   [0.06, 0.32, 0.06, 0.84, 0.20, 1.00, 0.44, 0.98, 0.58, 0.80],
                   [0.58, 0.32, 0.58, 1.00]),
        "v": glyph(0.68,
                   [0.04, 0.32, 0.34, 1.00, 0.64, 0.32]),
        "w": glyph(0.90,
                   [0.04, 0.32, 0.24, 1.00, 0.44, 0.46, 0.64, 1.00, 0.84, 0.32]),
        "x": glyph(0.66,
                   [0.06, 0.32, 0.60, 1.00],
                   [0.60, 0.32, 0.06, 1.00]),
        "y": glyph(0.66,
                   [0.04, 0.32, 0.32, 0.96],
                   [0.62, 0.32, 0.30, 1.06, 0.18, 1.24, 0.02, 1.26]),
        "z": glyph(0.68,
                   [0.06, 0.34, 0.58, 0.32, 0.08, 0.99, 0.62, 0.97]),
    ]

    private static let uppercase: [Character: InkGlyph] = [
        "A": glyph(0.78,
                   [0.04, 1.00, 0.36, 0.00, 0.68, 1.00],
                   [0.14, 0.70, 0.58, 0.68]),
        "B": glyph(0.76,
                   [0.08, 0.00, 0.08, 1.00],
                   [0.08, 0.02, 0.44, 0.02, 0.60, 0.16, 0.56, 0.36, 0.38, 0.48, 0.08, 0.48],
                   [0.08, 0.48, 0.48, 0.48, 0.66, 0.64, 0.62, 0.86, 0.42, 0.99, 0.08, 0.99]),
        "C": glyph(0.76,
                   [0.70, 0.18, 0.54, 0.02, 0.28, 0.02, 0.09, 0.22, 0.06, 0.56, 0.16, 0.88, 0.40, 1.02, 0.68, 0.92]),
        "D": glyph(0.78,
                   [0.08, 0.00, 0.08, 1.00],
                   [0.08, 0.02, 0.40, 0.02, 0.62, 0.20, 0.66, 0.52, 0.56, 0.84, 0.34, 0.99, 0.08, 0.99]),
        "E": glyph(0.70,
                   [0.62, 0.02, 0.08, 0.03, 0.08, 1.00, 0.62, 0.98],
                   [0.08, 0.50, 0.48, 0.48]),
        "F": glyph(0.68,
                   [0.62, 0.02, 0.08, 0.03, 0.08, 1.00],
                   [0.08, 0.50, 0.48, 0.48]),
        "G": glyph(0.80,
                   [0.70, 0.18, 0.54, 0.02, 0.28, 0.02, 0.09, 0.22, 0.06, 0.56, 0.16, 0.88, 0.42, 1.02, 0.68, 0.88, 0.70, 0.60, 0.46, 0.60]),
        "H": glyph(0.74,
                   [0.06, 0.00, 0.06, 1.00],
                   [0.66, 0.00, 0.66, 1.00],
                   [0.06, 0.50, 0.66, 0.48]),
        "I": glyph(0.44,
                   [0.22, 0.02, 0.22, 1.00],
                   [0.06, 0.03, 0.38, 0.01],
                   [0.06, 1.00, 0.38, 0.98]),
        "J": glyph(0.62,
                   [0.56, 0.02, 0.56, 0.80, 0.44, 0.99, 0.20, 1.01, 0.06, 0.86]),
        "K": glyph(0.76,
                   [0.08, 0.00, 0.08, 1.00],
                   [0.66, 0.02, 0.10, 0.56],
                   [0.28, 0.42, 0.70, 1.00]),
        "L": glyph(0.66,
                   [0.08, 0.02, 0.08, 0.99, 0.62, 0.97]),
        "M": glyph(0.86,
                   [0.04, 1.00, 0.06, 0.02, 0.40, 0.72, 0.74, 0.02, 0.76, 1.00]),
        "N": glyph(0.76,
                   [0.06, 1.00, 0.06, 0.02, 0.66, 0.98, 0.66, 0.02]),
        "O": glyph(0.82,
                   [0.40, 0.02, 0.17, 0.14, 0.06, 0.44, 0.10, 0.78, 0.30, 0.99, 0.56, 0.97, 0.71, 0.72, 0.71, 0.36, 0.56, 0.10, 0.40, 0.02]),
        "P": glyph(0.72,
                   [0.08, 0.00, 0.08, 1.00],
                   [0.08, 0.02, 0.46, 0.02, 0.64, 0.18, 0.60, 0.42, 0.40, 0.54, 0.08, 0.54]),
        "Q": glyph(0.82,
                   [0.40, 0.02, 0.17, 0.14, 0.06, 0.44, 0.10, 0.78, 0.30, 0.99, 0.56, 0.97, 0.71, 0.72, 0.71, 0.36, 0.56, 0.10, 0.40, 0.02],
                   [0.46, 0.74, 0.78, 1.08]),
        "R": glyph(0.76,
                   [0.08, 0.00, 0.08, 1.00],
                   [0.08, 0.02, 0.46, 0.02, 0.62, 0.18, 0.58, 0.42, 0.38, 0.54, 0.08, 0.54],
                   [0.34, 0.54, 0.70, 1.00]),
        "S": glyph(0.72,
                   [0.66, 0.14, 0.50, 0.02, 0.24, 0.03, 0.10, 0.18, 0.16, 0.38, 0.44, 0.52, 0.64, 0.68, 0.60, 0.88, 0.38, 1.01, 0.08, 0.92]),
        "T": glyph(0.70,
                   [0.04, 0.03, 0.66, 0.01],
                   [0.35, 0.02, 0.35, 1.00]),
        "U": glyph(0.74,
                   [0.06, 0.02, 0.06, 0.74, 0.20, 0.96, 0.46, 0.99, 0.64, 0.82, 0.64, 0.02]),
        "V": glyph(0.72,
                   [0.04, 0.02, 0.36, 1.00, 0.68, 0.02]),
        "W": glyph(0.92,
                   [0.03, 0.02, 0.22, 1.00, 0.44, 0.30, 0.66, 1.00, 0.86, 0.02]),
        "X": glyph(0.74,
                   [0.06, 0.02, 0.66, 1.00],
                   [0.66, 0.02, 0.06, 1.00]),
        "Y": glyph(0.74,
                   [0.05, 0.02, 0.36, 0.52, 0.67, 0.02],
                   [0.36, 0.52, 0.36, 1.00]),
        "Z": glyph(0.76,
                   [0.06, 0.03, 0.66, 0.02, 0.08, 0.99, 0.68, 0.97]),
    ]

    private static let digits: [Character: InkGlyph] = [
        "0": glyph(0.72,
                   [0.36, 0.02, 0.15, 0.16, 0.06, 0.48, 0.12, 0.82, 0.32, 0.99, 0.53, 0.90, 0.62, 0.58, 0.57, 0.20, 0.38, 0.02]),
        "1": glyph(0.44,
                   [0.08, 0.22, 0.32, 0.02, 0.32, 1.00]),
        "2": glyph(0.72,
                   [0.08, 0.20, 0.22, 0.03, 0.48, 0.02, 0.64, 0.18, 0.58, 0.40, 0.08, 0.98, 0.66, 0.96]),
        "3": glyph(0.70,
                   [0.08, 0.12, 0.28, 0.01, 0.54, 0.06, 0.58, 0.26, 0.36, 0.44, 0.58, 0.54, 0.66, 0.76, 0.50, 0.98, 0.20, 1.00, 0.06, 0.88]),
        "4": glyph(0.74,
                   [0.52, 0.04, 0.04, 0.70, 0.66, 0.68],
                   [0.52, 0.02, 0.52, 1.00]),
        "5": glyph(0.70,
                   [0.62, 0.03, 0.16, 0.04, 0.10, 0.44, 0.34, 0.36, 0.56, 0.44, 0.64, 0.68, 0.52, 0.94, 0.24, 1.01, 0.06, 0.90]),
        "6": glyph(0.70,
                   [0.58, 0.04, 0.32, 0.06, 0.14, 0.28, 0.08, 0.62, 0.16, 0.90, 0.38, 1.01, 0.58, 0.90, 0.60, 0.68, 0.44, 0.56, 0.20, 0.58, 0.09, 0.70]),
        "7": glyph(0.68,
                   [0.06, 0.04, 0.66, 0.02, 0.30, 1.00]),
        "8": glyph(0.72,
                   [0.36, 0.02, 0.16, 0.10, 0.14, 0.30, 0.36, 0.46, 0.58, 0.60, 0.58, 0.86, 0.36, 1.00, 0.14, 0.88, 0.14, 0.64, 0.36, 0.46, 0.56, 0.32, 0.56, 0.12, 0.36, 0.02]),
        "9": glyph(0.70,
                   [0.60, 0.30, 0.50, 0.10, 0.28, 0.04, 0.10, 0.16, 0.08, 0.38, 0.24, 0.52, 0.48, 0.50, 0.60, 0.36, 0.60, 0.66, 0.50, 0.94, 0.24, 1.01, 0.08, 0.94]),
    ]

    private static let symbols: [Character: InkGlyph] = [
        " ": InkGlyph(advance: spaceAdvance, strokes: []),
        ".": glyph(0.30,
                   [0.14, 0.94, 0.15, 1.00]),
        ",": glyph(0.30,
                   [0.18, 0.94, 0.14, 1.06, 0.06, 1.16]),
        "!": glyph(0.34,
                   [0.16, 0.02, 0.14, 0.68],
                   [0.13, 0.94, 0.14, 1.00]),
        "?": glyph(0.62,
                   [0.06, 0.18, 0.18, 0.02, 0.42, 0.02, 0.54, 0.18, 0.46, 0.38, 0.30, 0.50, 0.28, 0.68],
                   [0.27, 0.94, 0.28, 1.00]),
        "'": glyph(0.28,
                   [0.14, 0.04, 0.10, 0.28]),
        "\"": glyph(0.42,
                    [0.12, 0.04, 0.08, 0.28],
                    [0.30, 0.04, 0.26, 0.28]),
        "(": glyph(0.40,
                   [0.36, -0.06, 0.14, 0.30, 0.14, 0.80, 0.36, 1.16]),
        ")": glyph(0.40,
                   [0.06, -0.06, 0.28, 0.30, 0.28, 0.80, 0.06, 1.16]),
        "+": glyph(0.74,
                   [0.37, 0.28, 0.37, 0.86],
                   [0.06, 0.58, 0.68, 0.56]),
        "-": glyph(0.62,
                   [0.06, 0.58, 0.56, 0.56]),
        "\u{2212}": glyph(0.74,
                          [0.06, 0.58, 0.68, 0.56]),
        "=": glyph(0.74,
                   [0.06, 0.44, 0.68, 0.42],
                   [0.06, 0.72, 0.68, 0.70]),
        "\u{00D7}": glyph(0.70,
                          [0.10, 0.34, 0.60, 0.82],
                          [0.60, 0.34, 0.10, 0.82]),
        "\u{00F7}": glyph(0.74,
                          [0.06, 0.58, 0.68, 0.56],
                          [0.36, 0.32, 0.37, 0.38],
                          [0.36, 0.78, 0.37, 0.84]),
        "/": glyph(0.56,
                   [0.06, 1.04, 0.50, -0.04]),
        ":": glyph(0.30,
                   [0.14, 0.42, 0.15, 0.48],
                   [0.13, 0.94, 0.14, 1.00]),
        ";": glyph(0.30,
                   [0.16, 0.42, 0.17, 0.48],
                   [0.18, 0.94, 0.14, 1.06, 0.06, 1.16]),
        "\u{2192}": glyph(1.00,
                          [0.04, 0.60, 0.90, 0.58],
                          [0.68, 0.38, 0.92, 0.58, 0.68, 0.78]),
        "\u{2713}": glyph(0.80,
                          [0.06, 0.60, 0.28, 0.94, 0.72, 0.08]),
        "\u{2717}": glyph(0.78,
                          [0.08, 0.14, 0.68, 0.92],
                          [0.68, 0.14, 0.08, 0.92]),
        "%": glyph(0.88,
                   [0.66, 0.06, 0.12, 0.98],
                   [0.20, 0.06, 0.09, 0.14, 0.11, 0.28, 0.24, 0.32, 0.32, 0.22, 0.28, 0.09, 0.20, 0.06],
                   [0.62, 0.72, 0.51, 0.80, 0.53, 0.94, 0.66, 0.98, 0.74, 0.88, 0.70, 0.75, 0.62, 0.72]),
        "_": glyph(0.68,
                   [0.04, 1.16, 0.62, 1.14]),
        // The two the seeded learner attempt in `E2ESeedFixture` writes and
        // prose does not: a radical sign, and a squared exponent authored small
        // and high rather than scaled at layout time.
        "\u{221A}": glyph(1.06,
                          [0.02, 0.62, 0.20, 0.88, 0.38, 0.02, 1.00, 0.02]),
        "\u{00B2}": glyph(0.52,
                          [0.06, 0.26, 0.14, 0.14, 0.32, 0.14, 0.42, 0.26, 0.06, 0.56, 0.44, 0.55]),
    ]
}
