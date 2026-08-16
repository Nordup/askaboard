import CoreGraphics
import PencilKit
import UIKit
import XCTest
@testable import MathTutor

/// The `ink_text` primitive — one string, drawn as the app's own handwriting —
/// and the glyph table underneath it.
///
/// Four rules can only be proven here. The wire element is flat: `text` and
/// `size` sit beside `x` and `y` rather than under a `style` object, and a
/// missing `size` decodes to a default rather than to zero, which would put a
/// note on the board with no letters in it and nothing failing to say so. The
/// pen tapers, which is the whole difference between ink and a plotter, and a
/// stroked line cannot be told from a filled outline except by measuring what
/// reached the pixels. Every render of one element is the same render, because
/// a board capture that differs from the one before it for reasons unrelated to
/// what the tutor wrote is worse than no capture. And every glyph stays inside
/// the box the layout measured it by, because ink outside that box is ink
/// outside the tile the layer view mounts — a clipped letter, not a cosmetic
/// problem.
@MainActor
final class InkTextTests: XCTestCase {

    // MARK: - The wire element

    func testDecodesFromTheFlatWireElement() throws {
        // The field set `server/app/tutor/board_scene.py` defines for
        // `ink_text`: id, kind, x, y, text, size, and the seven style keys
        // beside them.
        let json = """
        {"id":"n1","kind":"ink_text","x":10,"y":20,"text":"Nice work!","size":28,
         "role":"hint","stroke":"#0155FB","fill":"#FFE3E3","stroke_width":6,
         "opacity":0.5,"dash":[6,4],"rotation":15}
        """
        let element = try JSONDecoder().decode(BoardElement.self, from: Data(json.utf8))

        guard case .inkText(let ink) = element else { return XCTFail("expected an ink_text element") }
        XCTAssertEqual(ink.id, "n1")
        XCTAssertEqual(ink.kind, .inkText)
        XCTAssertEqual(ink.x, 10)
        XCTAssertEqual(ink.y, 20)
        XCTAssertEqual(ink.text, "Nice work!")
        XCTAssertEqual(ink.size, 28)
        XCTAssertEqual(ink.style.role, .hint)
        XCTAssertEqual(ink.style.stroke, "#0155FB")
        XCTAssertEqual(ink.style.fill, "#FFE3E3")
        XCTAssertEqual(ink.style.strokeWidth, 6)
        XCTAssertEqual(ink.style.opacity, 0.5)
        XCTAssertEqual(ink.style.dash, [6, 4])
        XCTAssertEqual(ink.style.rotation, 15)
    }

    func testAnAbsentSizeIsTheDefaultCapHeight() throws {
        let json = #"{"id":"n2","kind":"ink_text","x":0,"y":0,"text":"hi"}"#
        let element = try JSONDecoder().decode(BoardElement.self, from: Data(json.utf8))

        guard case .inkText(let ink) = element else { return XCTFail("expected an ink_text element") }
        XCTAssertEqual(ink.size, 24, "a note with no size still has letters in it")
    }

    func testEncodesFlatBesideTheStyleFields() throws {
        let element = BoardElement.inkText(InkTextElement(
            id: "n3", x: 5, y: 6, text: "Try again", size: 32
        ))

        let data = try JSONEncoder().encode(element)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "ink_text")
        XCTAssertEqual(json["text"] as? String, "Try again")
        XCTAssertEqual(json["size"] as? Double, 32)
        XCTAssertEqual(json["stroke_width"] as? Double, 4, "style rides beside the geometry")
        XCTAssertNil(json["style"], "the wire element is flat, never nested")
        XCTAssertEqual(try JSONDecoder().decode(BoardElement.self, from: data), element)
    }

    func testAnUnknownKindBesideInkTextCostsOnlyItsOwnElement() throws {
        let json = """
        {"upserts":[
          {"id":"n1","kind":"ink_text","x":0,"y":0,"text":"ok","size":24,
           "role":"content","stroke":"#0A0A0A","fill":"transparent",
           "stroke_width":4,"opacity":1,"dash":[],"rotation":0},
          {"id":"h1","kind":"hologram","depth":3}
        ],"deletes":[],"replace_all":false}
        """
        let update = try JSONDecoder().decode(BoardSceneUpdate.self, from: Data(json.utf8))

        XCTAssertEqual(update.upserts.map(\.id), ["n1"])
    }

    // MARK: - The glyph table

    /// Every glyph draws inside the box the layout measures it by.
    ///
    /// This is the invariant the bounds arm rests on. `InkTextRenderer.bounds`
    /// reports the layout's metric box plus a fixed ink padding, and it never
    /// looks at the strokes; if a stroke leaves its glyph's box the tile the
    /// layer view mounts is too small and the letter is clipped on the board.
    /// A sweep is the only way to know, because nothing in the table's shape
    /// enforces it.
    func testEveryGlyphStaysInsideItsDeclaredBox() {
        for (character, glyph) in InkGlyphs.glyphs {
            XCTAssertGreaterThan(glyph.advance, 0, "\(character) has no width")
            for stroke in glyph.strokes {
                XCTAssertGreaterThanOrEqual(stroke.count, 2, "\(character) has a stroke of one point")
                for point in stroke {
                    XCTAssertGreaterThanOrEqual(point.x, 0, "\(character) reaches left of its box")
                    XCTAssertLessThanOrEqual(point.x, glyph.advance, "\(character) reaches past its advance")
                    XCTAssertGreaterThanOrEqual(
                        point.y, InkGlyphs.overshoot, "\(character) reaches above the overshoot line"
                    )
                    XCTAssertLessThanOrEqual(
                        point.y, InkGlyphs.descender, "\(character) reaches below the descender line"
                    )
                }
            }
        }
    }

    /// The coverage the plan asks for, stated as the set itself rather than as
    /// a count, so adding a glyph never quietly satisfies a missing one.
    func testTheTableCoversLettersDigitsAndTheWritingPunctuation() {
        let letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        let punctuation = " .,!?'\"()+-=×÷/:;→✓✗%_\u{2212}"
        for character in letters + punctuation {
            XCTAssertNotNil(InkGlyphs.glyph(for: character), "no glyph for \(character)")
        }
        // The space is the one covered character that draws nothing.
        XCTAssertEqual(InkGlyphs.glyphs[" "]?.strokes.count, 0)
    }

    /// Prose arrives in a typographic register the table has no separate
    /// letterforms for. Each mark has an obvious hand-drawn equivalent already
    /// in the table, and substituting beats drawing the placeholder at it — a
    /// warm margin note whose em dashes came out as underscores reads as a bug.
    func testTypographicPunctuationIsNormalisedRatherThanMissed() {
        XCTAssertEqual(InkGlyphs.canonical("\u{2019}"), "'")
        XCTAssertEqual(InkGlyphs.canonical("\u{2018}"), "'")
        XCTAssertEqual(InkGlyphs.canonical("\u{201C}"), "\"")
        XCTAssertEqual(InkGlyphs.canonical("\u{201D}"), "\"")
        XCTAssertEqual(InkGlyphs.canonical("\u{2014}"), "-", "em dash")
        XCTAssertEqual(InkGlyphs.canonical("\u{2013}"), "-", "en dash")
        XCTAssertEqual(InkGlyphs.canonical("\u{00A0}"), " ", "non-breaking space")
        XCTAssertEqual(InkGlyphs.canonical("q"), "q")

        XCTAssertEqual(
            InkGlyphs.normalized("Nice\u{2026}"), "Nice...",
            "an ellipsis is three full stops, which is why this is a string pass"
        )

        // The register the model actually writes in, end to end.
        let register = "Almost \u{2014} you\u{2019}re close\u{2026} try \u{201C}halves\u{201D}\u{00A0}next\u{2013}step!"
        let layout = InkGlyphs.layout(text: register, size: 24)
        XCTAssertTrue(
            layout.unsupported.isEmpty,
            "no placeholder may appear in ordinary model prose; got \(layout.unsupported)"
        )
    }

    /// `*` stays unwritable on purpose. A model writing `**Nice!**` means
    /// emphasis, not multiplication, so the guess would be wrong as often as it
    /// was right — and a placeholder that logs its codepoint is honest where a
    /// wrong substitution is not.
    func testTheAsteriskIsNotGuessedAtAsAMultiplicationSign() {
        XCTAssertEqual(InkGlyphs.canonical("*"), "*")
        XCTAssertNil(InkGlyphs.glyph(for: "*"))
        XCTAssertEqual(InkGlyphs.layout(text: "3*4", size: 24).unsupported, [0x2A])
    }

    // MARK: - Layout and bounds

    func testBoundsAreAnchoredAtTheElementOriginAndCarryTheBoardOrigin() {
        let element = InkTextElement(id: "b", x: 40, y: 60, text: "hi", size: 24)
        let padding = 24 * InkTextRenderer.inkPadding

        let local = InkTextRenderer.bounds(for: element)
        XCTAssertEqual(local.minX, 40 - padding, accuracy: 0.01)
        XCTAssertEqual(local.minY, 60 - padding, accuracy: 0.01)

        let placed = BoardSceneRenderer.bounds(
            of: .inkText(element),
            boardOrigin: CGPoint(x: 1_000, y: 500)
        )
        XCTAssertEqual(placed.minX, 1_040 - padding, accuracy: 0.01)
        XCTAssertEqual(placed.minY, 560 - padding, accuracy: 0.01)
    }

    func testASecondLineAddsExactlyOneLineHeight() {
        let one = InkTextElement(id: "one", x: 0, y: 0, text: "keep going", size: 20)
        var two = one
        two.text = "keep\ngoing"

        let single = InkTextRenderer.bounds(for: one)
        let double = InkTextRenderer.bounds(for: two)

        XCTAssertEqual(
            double.height - single.height,
            InkGlyphs.lineHeight * 20,
            accuracy: 0.01
        )
        XCTAssertLessThan(double.width, single.width, "the broken line is narrower")
    }

    func testTextWithNothingToDrawHasNoBoundsAtAll() {
        // Rotation is on, because rotating a null rectangle is how a `nan`
        // frame would reach Core Animation.
        for text in ["", "   ", "\n\n", " \n \n "] {
            var element = InkTextElement(id: "empty", x: 40, y: 60, text: text, size: 24)
            element.style.rotation = 30

            XCTAssertEqual(
                BoardSceneRenderer.bounds(of: .inkText(element), boardOrigin: .zero),
                .zero,
                "\(text.debugDescription) should mount nothing"
            )
            XCTAssertNil(InkTextRenderer.path(for: element))
        }
    }

    func testACoordinateThatIsNotFiniteStaysBounded() {
        var element = InkTextElement(id: "wild", x: .infinity, y: 0, text: "hi", size: 24)
        element.style.rotation = 30

        let bounds = BoardSceneRenderer.bounds(of: .inkText(element), boardOrigin: .zero)
        XCTAssertTrue(bounds.minX.isFinite && bounds.minY.isFinite, "\(bounds)")
        XCTAssertTrue(bounds.width.isFinite && bounds.height.isFinite, "\(bounds)")
    }

    func testASizeOutsideTheSchemaRangeIsClampedRatherThanRefused() {
        let tiny = InkTextElement(id: "t", x: 0, y: 0, text: "x", size: 0)
        let huge = InkTextElement(id: "h", x: 0, y: 0, text: "x", size: 10_000)
        let floored = InkTextElement(id: "t", x: 0, y: 0, text: "x", size: InkGlyphs.minimumSize)
        let capped = InkTextElement(id: "h", x: 0, y: 0, text: "x", size: InkGlyphs.maximumSize)

        XCTAssertEqual(InkTextRenderer.bounds(for: tiny), InkTextRenderer.bounds(for: floored))
        XCTAssertEqual(InkTextRenderer.bounds(for: huge), InkTextRenderer.bounds(for: capped))
    }

    func testTextPastTheServerBudgetIsDropped() {
        let long = String(repeating: "m", count: InkGlyphs.maximumCharacters + 40)
        let exact = String(repeating: "m", count: InkGlyphs.maximumCharacters)

        XCTAssertEqual(
            InkGlyphs.layout(text: long, size: 24).placements.count,
            InkGlyphs.layout(text: exact, size: 24).placements.count
        )
    }

    // MARK: - Characters the table cannot write

    func testACharacterWithNoGlyphDrawsThePlaceholderAndSaysSo() throws {
        XCTAssertNil(InkGlyphs.glyph(for: "\u{2603}"), "the snowman is not in the table")

        let layout = InkGlyphs.layout(text: "a\u{2603}b", size: 24)

        XCTAssertEqual(layout.placements.count, 3, "the placeholder takes the missing glyph's place")
        let underscore = try XCTUnwrap(InkGlyphs.glyphs[InkGlyphs.fallbackCharacter])
        XCTAssertEqual(
            layout.placements[1].glyph, underscore,
            "and the placeholder is the underscore"
        )
        XCTAssertEqual(layout.unsupported, [0x2603], "the codepoint is what a fix needs")

        // And it draws, rather than crashing or vanishing.
        let element = InkTextElement(id: "snow", x: 0, y: 0, text: "a\u{2603}b", size: 24)
        XCTAssertNotNil(InkTextRenderer.path(for: element))
        XCTAssertFalse(InkTextRenderer.bounds(for: element).isEmpty)
    }

    // MARK: - Drawing

    /// A full pangram and the ten digits, at the size the plan names.
    ///
    /// A pixel test cannot read, so it asserts the three things that go wrong
    /// when a glyph table breaks: nothing is drawn at all, ink escapes the
    /// rectangle the bounds arm promised, or the letters collapse into a blot.
    /// Legibility itself was checked by eye against a rendered specimen sheet;
    /// this keeps it from silently regressing.
    func testThePangramAndTheDigitsReachTheCanvasInsideTheirBounds() throws {
        let element = InkTextElement(
            id: "pangram", x: 0, y: 0,
            text: "The quick brown fox jumps over the lazy dog 0123456789",
            size: 24
        )
        XCTAssertTrue(
            InkGlyphs.layout(text: element.text, size: 24).unsupported.isEmpty,
            "every character of the pangram has a glyph"
        )

        let bounds = InkTextRenderer.bounds(for: element)
        let margin: CGFloat = 10
        let raster = try render(
            .inkText(element),
            in: bounds.insetBy(dx: -margin, dy: -margin)
        )

        let inked = raster.inkedColumns()
        XCTAssertFalse(inked.isEmpty, "the handwriting must reach the drawing context")

        // The margin is the bounds arm's promise, so no ink may land in it —
        // give or take the pixel or two that antialiasing bleeds past the
        // geometry. The rendered rectangle is the bounds inset by the same
        // margin on every side, so the vertical mirror the read-back applies
        // leaves this check unchanged.
        let edge = margin * raster.scale - 2
        XCTAssertGreaterThan(edge, 0)
        XCTAssertGreaterThanOrEqual(
            CGFloat(inked.first ?? 0), edge,
            "ink escaped the left edge of the reported bounds"
        )
        XCTAssertLessThanOrEqual(
            CGFloat(inked.last ?? raster.width), CGFloat(raster.width) - edge,
            "ink escaped the right edge of the reported bounds"
        )
        let rows = raster.rowsWithInk()
        XCTAssertGreaterThanOrEqual(
            CGFloat(rows.first ?? 0), edge,
            "ink escaped the top of the reported bounds"
        )
        XCTAssertLessThanOrEqual(
            CGFloat(rows.last ?? raster.height), CGFloat(raster.height) - edge,
            "ink escaped the bottom of the reported bounds"
        )

        // The writing fills its line rather than trailing off, and it is
        // writing rather than a blot.
        let span = CGFloat((inked.last ?? 0) - (inked.first ?? 0))
        XCTAssertGreaterThan(span / CGFloat(raster.width), 0.9)
        let density = CGFloat(raster.inkCount) / CGFloat(raster.width * raster.height)
        XCTAssertGreaterThan(density, 0.02, "too little ink to be letters")
        XCTAssertLessThan(density, 0.3, "too much ink to be letters")
    }

    /// The taper, measured.
    ///
    /// One long horizontal stroke, rendered large. A stroked line would be the
    /// same number of pixels tall in every column of its body; a tapered pen is
    /// not, and the difference is what separates ink from a plotter. The two
    /// round caps are excluded — they narrow at the tips whether or not the
    /// body tapers, so including them would let a uniform pen pass.
    func testThePenTapersRatherThanDrawingAConstantWidth() throws {
        let element = InkTextElement(id: "taper", x: 0, y: 0, text: "-", size: 200)
        let raster = try render(.inkText(element), in: InkTextRenderer.bounds(for: element))

        let heights = raster.columnInkHeights()
        let inked = raster.inkedColumns()
        let first = try XCTUnwrap(inked.first)
        let last = try XCTUnwrap(inked.last)
        let span = last - first
        XCTAssertGreaterThan(span, 40, "the stroke has to be long enough to measure")

        // The body: the inked span with the cap at each end trimmed off.
        let body = (first + span / 12)...(last - span / 12)
        let widest = body.map { heights[$0] }.max() ?? 0
        let narrowest = body.map { heights[$0] }.min() ?? 0

        XCTAssertGreaterThan(narrowest, 0)
        XCTAssertGreaterThan(
            CGFloat(widest) / CGFloat(narrowest), 1.3,
            "the pen's body is \(narrowest)…\(widest) px — that is a constant width, not a taper"
        )
    }

    /// Two renders of one element are the same bytes, and two elements that
    /// differ only by id are not.
    ///
    /// The second half is what proves the wobble is really seeded: identical
    /// output for two ids would mean the jitter had been optimised away, and
    /// identical output could otherwise be mistaken for correctness.
    func testTheSameElementAlwaysDrawsTheSamePixels() throws {
        let element = InkTextElement(id: "steady", x: 0, y: 0, text: "Nice work", size: 40)
        var renamed = element
        renamed.id = "steady-2"
        let rect = InkTextRenderer.bounds(for: element).insetBy(dx: -6, dy: -6)

        let first = try XCTUnwrap(BoardSceneRenderer.renderPNG(
            scene: BoardScene(elements: [.inkText(element)]),
            drawingRect: rect,
            boardOrigin: .zero
        ))
        let second = try XCTUnwrap(BoardSceneRenderer.renderPNG(
            scene: BoardScene(elements: [.inkText(element)]),
            drawingRect: rect,
            boardOrigin: .zero
        ))
        let other = try XCTUnwrap(BoardSceneRenderer.renderPNG(
            scene: BoardScene(elements: [.inkText(renamed)]),
            drawingRect: rect,
            boardOrigin: .zero
        ))

        XCTAssertEqual(first, second, "one element, one render, forever")
        XCTAssertNotEqual(first, other, "the hand is seeded by the element id")
    }

    /// `stroke` is the ink. It is the field every other kind draws its outline
    /// with, and this kind fills its glyphs with it — which is only visible in
    /// pixels, because the draw arm sets the fill colour itself rather than
    /// taking the one `style.fill` put there.
    func testTheInkTakesItsColourFromStrokeAndNotFromFill() throws {
        let element = InkTextElement(
            id: "red", x: 0, y: 0, text: "8", size: 120,
            style: BoardStyle(
                role: .correction, stroke: "#E33E38", fill: "#0155FB",
                strokeWidth: 1, opacity: 1, dash: [12, 6], rotation: 0
            )
        )
        let raster = try render(.inkText(element), in: InkTextRenderer.bounds(for: element))

        var reds = 0
        var blues = 0
        for index in stride(from: 0, to: raster.bytes.count, by: 4) {
            let red = Int(raster.bytes[index])
            let green = Int(raster.bytes[index + 1])
            let blue = Int(raster.bytes[index + 2])
            if red - blue > 60, red - green > 60 { reds += 1 }
            if blue - red > 60 { blues += 1 }
        }
        XCTAssertGreaterThan(reds, 100, "the glyphs are drawn in the stroke colour")
        XCTAssertEqual(blues, 0, "fill is not a colour this kind paints with")
    }

    // MARK: - The seed fixture

    func testFixtureCoversTheInkTextKind() throws {
        let notes = E2ESeedFixture.scene().elements.compactMap { element -> InkTextElement? in
            if case .inkText(let value) = element { return value }
            return nil
        }

        XCTAssertEqual(notes.count, 1)
        let note = try XCTUnwrap(notes.first)
        XCTAssertFalse(note.text.isEmpty)
        XCTAssertTrue(
            InkGlyphs.layout(text: note.text, size: note.size).unsupported.isEmpty,
            "the fixture must not be written in characters the table cannot draw"
        )
    }

    /// The seeded learner attempt is written with the same table the tutor's
    /// own handwriting uses. That is the point of lifting the glyphs out of the
    /// fixture: a letterform fixed for one is fixed for both.
    func testTheSeededAttemptIsWrittenWithTheSharedTable() throws {
        let strokes = InkGlyphs.strokes(
            text: "0 = (x \u{2212} 4)(x + 1)",
            origin: CGPoint(x: 84, y: 410),
            size: 46
        )

        XCTAssertGreaterThan(strokes.count, 8)
        XCTAssertTrue(strokes.allSatisfy { $0.count >= 2 })
        // Laid out left to right from the origin, on one line.
        let allPoints = strokes.flatMap { $0 }
        XCTAssertGreaterThanOrEqual(allPoints.map(\.x).min() ?? 0, 84)
        XCTAssertGreaterThan(allPoints.map(\.y).min() ?? 0, 410 - 0.01)
        XCTAssertLessThan(allPoints.map(\.y).max() ?? 0, 410 + 46 * InkGlyphs.descender + 1)

        XCTAssertFalse(E2ESeedFixture.drawing().strokes.isEmpty)
    }

    // MARK: - Rasterizing helpers

    private struct Raster {
        let width: Int
        let height: Int
        let scale: CGFloat
        let bytes: [UInt8]

        func isInk(x: Int, y: Int) -> Bool {
            let index = (y * width + x) * 4
            return bytes[index] < 200 || bytes[index + 1] < 200 || bytes[index + 2] < 200
        }

        var inkCount: Int {
            var count = 0
            for y in 0..<height {
                for x in 0..<width where isInk(x: x, y: y) { count += 1 }
            }
            return count
        }

        /// How many pixels of ink each column holds.
        func columnInkHeights() -> [Int] {
            (0..<width).map { x in
                (0..<height).reduce(0) { $0 + (isInk(x: x, y: $1) ? 1 : 0) }
            }
        }

        func inkedColumns() -> [Int] {
            let heights = columnInkHeights()
            return (0..<width).filter { heights[$0] > 0 }
        }

        func rowsWithInk() -> [Int] {
            (0..<height).filter { y in (0..<width).contains { isInk(x: $0, y: y) } }
        }
    }

    /// One element, rendered onto white and read back as RGBA bytes.
    ///
    /// `renderPNG` fills the canvas white first, so any pixel that is not white
    /// is ink the renderer put there. The bitmap comes back vertically mirrored
    /// — drawing a `UIImage` into a bitmap context flips it — which no
    /// measurement here depends on: every one of them is symmetric in y.
    private func render(_ element: BoardElement, in rect: CGRect) throws -> Raster {
        let data = try XCTUnwrap(BoardSceneRenderer.renderPNG(
            scene: BoardScene(elements: [element]),
            drawingRect: rect,
            boardOrigin: .zero
        ))
        let cgImage = try XCTUnwrap(UIImage(data: data)?.cgImage)
        let width = cgImage.width
        let height = cgImage.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        return Raster(
            width: width,
            height: height,
            scale: CGFloat(width) / rect.width,
            bytes: pixels
        )
    }
}
