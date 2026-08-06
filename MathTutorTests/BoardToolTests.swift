import Foundation
import XCTest
@testable import MathTutor

final class BoardToolTests: XCTestCase {
    func testBoardToolRoundTripsThroughItsRawValueAndJSON() throws {
        XCTAssertEqual(BoardTool.allCases, [.pen, .highlighter, .eraser, .lasso])
        XCTAssertEqual(BoardTool.defaultValue, .pen)

        for tool in BoardTool.allCases {
            XCTAssertEqual(BoardTool(rawValue: tool.rawValue), tool)
            XCTAssertEqual(tool.id, tool.rawValue)
            let data = try JSONEncoder().encode(tool)
            XCTAssertEqual(try JSONDecoder().decode(BoardTool.self, from: data), tool)
        }

        XCTAssertNil(BoardTool(rawValue: "marker"))
    }

    func testPenColorRawValuesAreTheDesignTokenHexes() {
        // The raw value is the token, so this is the drift check between the
        // foundations board's palette and the ink the rail actually arms.
        XCTAssertEqual(
            PenColor.allCases.map(\.hex),
            ["#0A0A0A", "#6051DC", "#0155FB", "#40A365", "#E33E38"]
        )
        XCTAssertEqual(PenColor.defaultValue, .black)

        // Same hex as --color-brand, and that is a coincidence the design says
        // not to depend on. Asserting the literal here means a future brand
        // change cannot quietly drag the pen palette along with it.
        XCTAssertEqual(PenColor.violet.hex, "#6051DC")
    }

    func testPenColorRoundTripsThroughItsRawValueAndJSON() throws {
        for color in PenColor.allCases {
            XCTAssertEqual(PenColor(rawValue: color.rawValue), color)
            XCTAssertEqual(color.id, color.rawValue)
            let data = try JSONEncoder().encode(color)
            XCTAssertEqual(try JSONDecoder().decode(PenColor.self, from: data), color)
        }

        XCTAssertNil(PenColor(rawValue: "#6051dc"), "Token hexes are upper-case; a lower-case string is not one")
        XCTAssertNil(PenColor(rawValue: "6051DC"), "The # prefix is part of the token")
    }

    func testStrokeThicknessStepsAreOrderedAndInkableByPencilKit() throws {
        XCTAssertEqual(StrokeThickness.allCases, [.fine, .medium, .bold])
        XCTAssertEqual(StrokeThickness.defaultValue, .medium)

        // The design pins exactly one of these: its indicator bar is 5pt tall.
        XCTAssertEqual(StrokeThickness.medium.pointWidth, 5, accuracy: 0.001)

        let widths = StrokeThickness.allCases.map(\.pointWidth)
        XCTAssertEqual(widths, widths.sorted())
        for width in widths {
            XCTAssertGreaterThanOrEqual(width, 1, "PKInkingTool clamps a pen narrower than 1pt")
            XCTAssertLessThanOrEqual(width, 20, "PKInkingTool clamps a pen wider than 20pt")
        }

        for thickness in StrokeThickness.allCases {
            XCTAssertEqual(StrokeThickness(rawValue: thickness.rawValue), thickness)
            let data = try JSONEncoder().encode(thickness)
            XCTAssertEqual(try JSONDecoder().decode(StrokeThickness.self, from: data), thickness)
        }
    }
}
