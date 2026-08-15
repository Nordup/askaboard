import CoreGraphics
import UIKit
import XCTest
@testable import MathTutor

/// The `path` primitive — one SVG path string in absolute board points — and
/// the forward compatibility of the element array that carries it.
///
/// Three rules can only be proven here. The wire element is flat: `fill_rule`
/// and every style field sit beside `d` on the element rather than under a
/// `style` object, and a mismatch decodes to silent defaults instead of an
/// error. `d` is the one geometry the server does not clamp — the numbers live
/// inside a string it never parses — so an unparseable or unbounded `d` has to
/// land as "nothing to draw" rather than as an infinite tile. And an element
/// naming a kind this build has never heard of costs one element, not the
/// whole update.
@MainActor
final class BoardPathElementTests: XCTestCase {

    // MARK: - The wire element

    func testDecodesFromTheFlatWireElement() throws {
        // The exact field set `server/tests/test_board.py` pins for a path:
        // id, kind, d, fill_rule, and the seven style keys beside them.
        let json = """
        {"id":"p1","kind":"path","d":"M0 0 L30 30","fill_rule":"evenodd",
         "role":"hint","stroke":"#0155FB","fill":"#FFE3E3","stroke_width":6,
         "opacity":0.5,"dash":[6,4],"rotation":15}
        """
        let element = try JSONDecoder().decode(BoardElement.self, from: Data(json.utf8))

        guard case .path(let path) = element else { return XCTFail("expected a path element") }
        XCTAssertEqual(path.id, "p1")
        XCTAssertEqual(path.kind, .path)
        XCTAssertEqual(path.d, "M0 0 L30 30")
        XCTAssertEqual(path.fillRule, .evenodd)
        XCTAssertEqual(path.style.role, .hint)
        XCTAssertEqual(path.style.stroke, "#0155FB")
        XCTAssertEqual(path.style.fill, "#FFE3E3")
        XCTAssertEqual(path.style.strokeWidth, 6)
        XCTAssertEqual(path.style.opacity, 0.5)
        XCTAssertEqual(path.style.dash, [6, 4])
        XCTAssertEqual(path.style.rotation, 15)
    }

    func testAnAbsentFillRuleIsNonzero() throws {
        let json = #"{"id":"p2","kind":"path","d":"M0 0 L10 0"}"#
        let element = try JSONDecoder().decode(BoardElement.self, from: Data(json.utf8))

        guard case .path(let path) = element else { return XCTFail("expected a path element") }
        XCTAssertEqual(path.fillRule, .nonzero)
    }

    func testEncodesFlatBesideTheStyleFields() throws {
        let element = BoardElement.path(PathElement(
            id: "p3",
            d: "M0 0 L10 10",
            fillRule: .evenodd
        ))

        let data = try JSONEncoder().encode(element)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "path")
        XCTAssertEqual(json["d"] as? String, "M0 0 L10 10")
        XCTAssertEqual(json["fill_rule"] as? String, "evenodd")
        XCTAssertEqual(json["stroke_width"] as? Double, 4, "style rides beside the geometry")
        XCTAssertNil(json["style"], "the wire element is flat, never nested")
        XCTAssertEqual(try JSONDecoder().decode(BoardElement.self, from: data), element)
    }

    // MARK: - Bounds

    func testBoundsAreThePathBoundingBoxPlusTheStrokeInset() {
        var path = PathElement(id: "p", d: "M10 20 L110 20 L110 220 Z")
        path.style.strokeWidth = 4

        let bounds = BoardSceneRenderer.bounds(of: .path(path), boardOrigin: .zero)
        XCTAssertEqual(bounds.minX, 8, accuracy: 0.01)
        XCTAssertEqual(bounds.minY, 18, accuracy: 0.01)
        XCTAssertEqual(bounds.maxX, 112, accuracy: 0.01)
        XCTAssertEqual(bounds.maxY, 222, accuracy: 0.01)

        let offset = BoardSceneRenderer.bounds(
            of: .path(path),
            boardOrigin: CGPoint(x: 1_000, y: 500)
        )
        XCTAssertEqual(offset.minX, 1_008, accuracy: 0.01)
        XCTAssertEqual(offset.minY, 518, accuracy: 0.01)
    }

    func testUnparseablePathDataHasNoBoundsAtAll() {
        // An empty `d`, a `d` that opens on something that is not a command,
        // and a `d` that never moves first: all three parse to an empty path.
        // Rotation is on, because rotating a null rectangle is how a `nan`
        // frame would reach Core Animation.
        for data in ["", "banana", "L10 10"] {
            var path = PathElement(id: "p", d: data)
            path.style.rotation = 30
            let bounds = BoardSceneRenderer.bounds(of: .path(path), boardOrigin: .zero)
            XCTAssertEqual(bounds, .zero, "\(data.isEmpty ? "an empty d" : data) should mount nothing")
        }
    }

    func testACoordinateTooLargeForADoubleStaysBounded() {
        // Whether the scanner rejects the exponent or overflows to infinity,
        // what must never escape is a rectangle the cull and Core Animation
        // cannot reason about.
        var path = PathElement(id: "p", d: "M0 0 L1e400 1")
        path.style.rotation = 30

        let bounds = BoardSceneRenderer.bounds(of: .path(path), boardOrigin: .zero)
        XCTAssertTrue(bounds.minX.isFinite && bounds.minY.isFinite, "\(bounds)")
        XCTAssertTrue(bounds.width.isFinite && bounds.height.isFinite, "\(bounds)")
    }

    func testADegenerateElementNeverStretchesTheSceneBounds() {
        // A degenerate element's own rectangle sits at the drawing origin, and
        // the board origin is 25,000 points away from there. Unioning even a
        // zero-area one would size `CanvasCapture` to that whole span and
        // shrink the learner's real work to a few pixels.
        let origin = PencilCanvasConfiguration.boardOrigin
        let line = BoardElement.line(LineElement(id: "l", x1: 0, y1: 0, x2: 100, y2: 40))
        let alone = BoardSceneRenderer.bounds(
            of: BoardScene(elements: [line]),
            boardOrigin: origin
        )

        let crowded = BoardSceneRenderer.bounds(
            of: BoardScene(elements: [
                line,
                .path(PathElement(id: "unparseable", d: "garbage")),
                .polygon(PolygonElement(id: "pointless", points: [])),
            ]),
            boardOrigin: origin
        )

        XCTAssertNotNil(alone)
        XCTAssertEqual(crowded, alone, "nothing to draw must contribute nothing to the bounds")
    }

    // MARK: - Drawing

    func testTheFillRuleDecidesWhetherAnInnerSubpathIsAHole() throws {
        let nonzero = try centreOfNestedSquares(fillRule: .nonzero)
        let evenodd = try centreOfNestedSquares(fillRule: .evenodd)

        XCTAssertGreaterThan(
            Int(nonzero[0]) - Int(nonzero[2]),
            40,
            "nonzero fills the inner square with the red fill"
        )
        XCTAssertGreaterThan(Int(evenodd[0]), 250, "evenodd leaves the inner square white")
        XCTAssertGreaterThan(Int(evenodd[2]), 250, "evenodd leaves the inner square white")
    }

    /// The centre pixel of two nested squares drawn as one path.
    ///
    /// Both squares are wound the same way, so the inner one is filled under
    /// `nonzero` and is a hole under `evenodd`; its centre is the pixel that
    /// tells the two apart. That centre is also the centre of the rendered
    /// rectangle, so the sample survives the vertical flip that drawing a
    /// `UIImage` into a bitmap context applies.
    private func centreOfNestedSquares(fillRule: PathFillRule) throws -> [UInt8] {
        let scene = BoardScene(elements: [
            .path(PathElement(
                id: "nested",
                d: "M0 0 L100 0 L100 100 L0 100 Z M25 25 L75 25 L75 75 L25 75 Z",
                fillRule: fillRule,
                style: BoardStyle(
                    role: .content,
                    stroke: "#0A0A0A",
                    fill: "#E33E38",
                    strokeWidth: 4,
                    opacity: 1,
                    dash: [],
                    rotation: 0
                )
            ))
        ])
        let data = try XCTUnwrap(BoardSceneRenderer.renderPNG(
            scene: scene,
            drawingRect: CGRect(x: -20, y: -20, width: 140, height: 140),
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
        let centre = ((height / 2) * width + width / 2) * 4
        return Array(pixels[centre..<(centre + 3)])
    }

    // MARK: - Kinds this build does not know

    func testAnUnknownKindLosesOnlyItsOwnElement() throws {
        let json = """
        {"upserts":[
          {"id":"p1","kind":"path","d":"M0 0 L30 30","fill_rule":"nonzero",
           "role":"content","stroke":"#0A0A0A","fill":"transparent",
           "stroke_width":4,"opacity":1,"dash":[],"rotation":0},
          {"id":"h1","kind":"hologram","depth":3,
           "role":"content","stroke":"#0A0A0A","fill":"transparent",
           "stroke_width":4,"opacity":1,"dash":[],"rotation":0}
        ],"deletes":["gone"],"replace_all":false}
        """
        let update = try JSONDecoder().decode(BoardSceneUpdate.self, from: Data(json.utf8))

        XCTAssertEqual(update.upserts.map(\.id), ["p1"])
        XCTAssertEqual(update.deletes, ["gone"], "the rest of the update still applies")
        XCTAssertFalse(update.replaceAll)
    }

    func testAnUnknownKindDoesNotDropTheWholeBoardUpdateEvent() {
        let line = #"data: {"type":"board_update","payload":{"upserts":[{"id":"h1","kind":"hologram"},{"id":"l1","kind":"line","x1":0,"y1":0,"x2":10,"y2":10}],"deletes":[],"replace_all":false}}"#

        guard case .boardUpdate(let update)? = TutorEvent.decode(from: line) else {
            return XCTFail("one unknown kind must not cost the event")
        }
        XCTAssertEqual(update.upserts.map(\.id), ["l1"])
    }

    func testAPersistedSceneKeepsTheKindsThisBuildStillKnows() throws {
        let json = """
        {"elements":[{"id":"h1","kind":"hologram"},
                     {"id":"p1","kind":"path","d":"M0 0 L1 1","fill_rule":"evenodd"}]}
        """
        let scene = try JSONDecoder().decode(BoardScene.self, from: Data(json.utf8))

        XCTAssertEqual(scene.elements.map(\.id), ["p1"])
    }

    func testAKnownKindWithAMalformedFieldStillFailsTheDecode() {
        let json = #"{"upserts":[{"id":"l1","kind":"line","x1":"over there"}],"deletes":[],"replace_all":false}"#

        XCTAssertThrowsError(
            try JSONDecoder().decode(BoardSceneUpdate.self, from: Data(json.utf8)),
            "leniency covers unknown kinds only, never a broken contract"
        )
    }
}
