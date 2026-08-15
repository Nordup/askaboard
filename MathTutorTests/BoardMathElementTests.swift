import CoreGraphics
import UIKit
import XCTest
@testable import MathTutor

/// The `math_text` primitive — one LaTeX fragment, typeset on the device — and
/// the store that turns it into a bitmap.
///
/// Three rules can only be proven here. The wire element is flat: `latex` and
/// `font_size` sit beside `x` and `y` on the element rather than under a
/// `style` object, and `font_size` is snake_case; camel-casing it would decode
/// to a silent default and put notation on the board at the wrong size with
/// nothing failing anywhere to say so. Typesetting fails closed: a fragment the
/// engine cannot parse produces no artifact rather than a blank tile that the
/// model reads back as drawn. And the fragment is delimited or not by the
/// model's whim — the server passes `latex` through untouched — so a padded
/// `$…$` has to typeset exactly as the bare body does.
@MainActor
final class BoardMathElementTests: XCTestCase {

    // MARK: - The wire element

    func testDecodesFromTheFlatWireElement() throws {
        // The exact field set `server/tests/test_board.py` pins for math_text
        // in `test_the_new_kinds_reach_the_device_as_one_flat_element`:
        // id, kind, x, y, latex, font_size, and the seven style keys beside them.
        let json = """
        {"id":"m1","kind":"math_text","x":10,"y":20,"latex":"\\\\frac{a}{b}","font_size":24,
         "role":"hint","stroke":"#0155FB","fill":"#FFE3E3","stroke_width":6,
         "opacity":0.5,"dash":[6,4],"rotation":15}
        """
        let element = try JSONDecoder().decode(BoardElement.self, from: Data(json.utf8))

        guard case .mathText(let math) = element else { return XCTFail("expected a math_text element") }
        XCTAssertEqual(math.id, "m1")
        XCTAssertEqual(math.kind, .mathText)
        XCTAssertEqual(math.x, 10)
        XCTAssertEqual(math.y, 20)
        XCTAssertEqual(math.latex, #"\frac{a}{b}"#, "LaTeX reaches the device untouched")
        XCTAssertEqual(math.fontSize, 24)
        XCTAssertEqual(math.style.role, .hint)
        XCTAssertEqual(math.style.stroke, "#0155FB")
        XCTAssertEqual(math.style.fill, "#FFE3E3")
        XCTAssertEqual(math.style.strokeWidth, 6)
        XCTAssertEqual(math.style.opacity, 0.5)
        XCTAssertEqual(math.style.dash, [6, 4])
        XCTAssertEqual(math.style.rotation, 15)
    }

    func testEncodesFlatBesideTheStyleFields() throws {
        let element = BoardElement.mathText(MathTextElement(
            id: "m3",
            x: 5,
            y: 6,
            latex: #"x^2"#,
            fontSize: 32
        ))

        let data = try JSONEncoder().encode(element)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "math_text")
        XCTAssertEqual(json["latex"] as? String, "x^2")
        XCTAssertEqual(json["font_size"] as? Double, 32)
        XCTAssertNil(json["fontSize"], "the wire key is snake_case")
        XCTAssertEqual(json["stroke_width"] as? Double, 4, "style rides beside the geometry")
        XCTAssertNil(json["style"], "the wire element is flat, never nested")
        XCTAssertEqual(try JSONDecoder().decode(BoardElement.self, from: data), element)
    }

    func testAnUnknownKindBesideMathTextCostsOnlyItsOwnElement() throws {
        let json = """
        {"upserts":[
          {"id":"m1","kind":"math_text","x":0,"y":0,"latex":"x","font_size":24,
           "role":"content","stroke":"#0A0A0A","fill":"transparent",
           "stroke_width":4,"opacity":1,"dash":[],"rotation":0},
          {"id":"h1","kind":"hologram","depth":3}
        ],"deletes":[],"replace_all":false}
        """
        let update = try JSONDecoder().decode(BoardSceneUpdate.self, from: Data(json.utf8))

        XCTAssertEqual(update.upserts.map(\.id), ["m1"])
    }

    // MARK: - Typesetting

    func testRenderTypesetsAFractionTallerThanItsFontSize() async {
        let element = MathTextElement(id: "m", x: 0, y: 0, latex: #"\frac{1}{2}"#, fontSize: 24)

        let artifact = await BoardMathStore.shared.render(element: element)

        XCTAssertNotNil(artifact?.image)
        // The raster is taken at twice the requested size, and a fraction is
        // taller than its own font size, so this holds twice over.
        XCTAssertGreaterThan(artifact?.size.height ?? 0, 24)
        XCTAssertGreaterThan(artifact?.size.width ?? 0, 0)
    }

    func testMalformedLatexFailsClosed() async {
        let element = MathTextElement(id: "m2", x: 0, y: 0, latex: #"\frac{1}"#, fontSize: 24)

        let artifact = await BoardMathStore.shared.render(element: element)

        XCTAssertNil(artifact, "an unparseable fragment must produce no artifact at all")
        XCTAssertNil(BoardMathStore.shared.artifact(for: element))
    }

    func testAReadyArtifactAnnouncesItself() async {
        let element = MathTextElement(id: "m-notify", x: 0, y: 0, latex: #"\sqrt{5}"#, fontSize: 21)
        let announced = expectation(forNotification: .boardSceneArtifactReady, object: nil)

        let artifact = await BoardMathStore.shared.render(element: element)

        XCTAssertNotNil(artifact)
        await fulfillment(of: [announced], timeout: 2)
    }

    // MARK: - Delimiters the model pads the fragment with

    /// The server hands `latex` to the device byte for byte, and the model
    /// writes `$…$` despite instructions — the same padding the chat pipeline
    /// had to trim (commits `558b649`, `79d500a`). One outer pair comes off,
    /// with the whitespace around it, in either direction.
    func testOneOuterDelimiterPairIsTrimmedBeforeTypesetting() {
        let cases: [(String, String)] = [
            ("$x$", "x"),
            (#"$$\frac{1}{2}$$"#, #"\frac{1}{2}"#),
            (#"\(x\)"#, "x"),
            (#"\[x\]"#, "x"),
            ("$ \\mathrm{J} $", #"\mathrm{J}"#),
            ("  $$ x + 1 $$  ", "x + 1"),
        ]
        for (padded, bare) in cases {
            XCTAssertEqual(BoardMathStore.typesettableLatex(padded), bare, padded)
        }
    }

    func testAnUndelimitedFragmentIsLeftExactlyAsWritten() {
        for bare in [#"\frac{1}{2}"#, "x^2 + 1", #"\alpha"#] {
            XCTAssertEqual(BoardMathStore.typesettableLatex(bare), bare)
        }
    }

    func testALoneDollarIsNotAPairAndIsLeftAlone() {
        // One `$` opens nothing. Dropping it as a delimiter would silently
        // delete a character of the fragment.
        XCTAssertEqual(BoardMathStore.typesettableLatex("$"), "$")
        XCTAssertEqual(BoardMathStore.typesettableLatex("$$"), "$$")
        XCTAssertEqual(BoardMathStore.typesettableLatex(#"\("#), #"\("#)
    }

    func testAPaddedFragmentTypesetsExactlyAsTheBareOneDoes() async {
        let padded = MathTextElement(id: "p", x: 0, y: 0, latex: #"$$\sqrt{3}$$"#, fontSize: 26)
        let bare = MathTextElement(id: "b", x: 0, y: 0, latex: #"\sqrt{3}"#, fontSize: 26)

        let paddedArtifact = await BoardMathStore.shared.render(element: padded)
        let bareArtifact = await BoardMathStore.shared.render(element: bare)

        XCTAssertNotNil(paddedArtifact)
        XCTAssertEqual(paddedArtifact?.size, bareArtifact?.size)
        XCTAssertEqual(
            BoardMathStore.cacheKey(for: padded),
            BoardMathStore.cacheKey(for: bare),
            "padded and bare are the same notation, and share one bitmap"
        )
    }

    // MARK: - Bounds

    func testBoundsAreNothingUntilTheArtifactLands() {
        var element = MathTextElement(id: "unrendered", x: 40, y: 60, latex: #"\theta_{0}"#, fontSize: 17)
        // Rotation is on, because rotating a null rectangle is how a `nan`
        // frame would reach Core Animation.
        element.style.rotation = 30

        let bounds = BoardSceneRenderer.bounds(of: .mathText(element), boardOrigin: .zero)

        XCTAssertEqual(bounds, .zero, "nothing typeset yet means nothing to mount")
    }

    func testBoundsAreTheRasterAtHalfSizeOnceTheArtifactLands() async throws {
        let element = MathTextElement(id: "m4", x: 40, y: 60, latex: #"\int_0^1 x\,dx"#, fontSize: 22)
        let rendered = await BoardMathStore.shared.render(element: element)
        let artifact = try XCTUnwrap(rendered)

        let bounds = BoardSceneRenderer.bounds(
            of: .mathText(element),
            boardOrigin: CGPoint(x: 1_000, y: 500)
        )

        XCTAssertEqual(bounds.minX, 1_040, accuracy: 0.01)
        XCTAssertEqual(bounds.minY, 560, accuracy: 0.01)
        XCTAssertEqual(bounds.width, artifact.size.width / 2, accuracy: 0.01)
        XCTAssertEqual(bounds.height, artifact.size.height / 2, accuracy: 0.01)
    }

    // MARK: - Drawing

    func testTheTypesetNotationActuallyReachesTheCanvas() async throws {
        let element = MathTextElement(
            id: "drawn",
            x: 0,
            y: 0,
            latex: #"\frac{F}{m}"#,
            fontSize: 40,
            style: BoardStyle(
                role: .content,
                stroke: "#E33E38",
                fill: "transparent",
                strokeWidth: 1,
                opacity: 1,
                dash: [],
                rotation: 0
            )
        )
        let rendered = await BoardMathStore.shared.render(element: element)
        let artifact = try XCTUnwrap(rendered)
        let scene = BoardScene(elements: [.mathText(element)])
        let rect = CGRect(
            x: -10,
            y: -10,
            width: artifact.size.width / 2 + 20,
            height: artifact.size.height / 2 + 20
        )

        let data = try XCTUnwrap(BoardSceneRenderer.renderPNG(
            scene: scene,
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

        // The canvas is filled white before the scene draws, so any pixel that
        // is not white is ink the typesetter put there.
        let inked = stride(from: 0, to: pixels.count, by: 4).contains { index in
            pixels[index] < 200 || pixels[index + 1] < 200 || pixels[index + 2] < 200
        }
        XCTAssertTrue(inked, "the typeset bitmap must reach the drawing context")
    }

    // MARK: - The seed fixture

    func testFixtureCoversTheMathTextKind() throws {
        let notation = E2ESeedFixture.scene().elements.compactMap { element -> MathTextElement? in
            if case .mathText(let value) = element { return value }
            return nil
        }

        XCTAssertEqual(notation.count, 1)
        XCTAssertFalse(try XCTUnwrap(notation.first).latex.isEmpty)
    }
}
