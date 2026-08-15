import XCTest
@testable import MathTutor

/// The scene model is `Hashable` so the renderer can key its raster caches on
/// `element.hashValue`. Two rules make that key correct: equal elements must
/// hash the same, and a content change must break equality.
final class BoardSceneHashTests: XCTestCase {
    func testEqualElementsHashEqually() {
        let a = BoardElement.line(LineElement(id: "l1", x1: 0, y1: 0, x2: 10, y2: 10))
        let b = BoardElement.line(LineElement(id: "l1", x1: 0, y1: 0, x2: 10, y2: 10))
        XCTAssertEqual(a.hashValue, b.hashValue)
    }

    func testContentChangeChangesEquality() {
        let a = BoardElement.svg(SVGElement(id: "s", x: 0, y: 0, width: 10, height: 10, svg: "<svg/>"))
        let b = BoardElement.svg(SVGElement(id: "s", x: 0, y: 0, width: 10, height: 10, svg: "<svg><g/></svg>"))
        XCTAssertNotEqual(a, b)
    }
}
