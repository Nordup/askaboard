import PencilKit
import SwiftUI
import UIKit
import XCTest
@testable import MathTutor

final class BoardInkTests: XCTestCase {
    func testEveryRailSelectionMapsToItsPencilKitTool() throws {
        for color in PenColor.allCases {
            for thickness in StrokeThickness.allCases {
                let pen = try XCTUnwrap(
                    BoardInk.tool(for: .pen, color: color, thickness: thickness) as? PKInkingTool
                )
                XCTAssertEqual(pen.inkType, .pen)
                XCTAssertEqual(pen.width, thickness.pointWidth, accuracy: 0.0001)
                try assertComponents(of: pen.color, match: color, alpha: 1)

                let highlighter = try XCTUnwrap(
                    BoardInk.tool(for: .highlighter, color: color, thickness: thickness) as? PKInkingTool
                )
                XCTAssertEqual(highlighter.inkType, .marker)
                XCTAssertEqual(
                    highlighter.width,
                    thickness.pointWidth * BoardInk.highlighterWidthMultiple,
                    accuracy: 0.0001
                )
                // A highlighter carries the swatch's own hue and differs from the
                // pen only in alpha and width.
                try assertComponents(of: highlighter.color, match: color, alpha: BoardInk.highlighterAlpha)

                let eraser = try XCTUnwrap(
                    BoardInk.tool(for: .eraser, color: color, thickness: thickness) as? PKEraserTool
                )
                XCTAssertEqual(eraser.eraserType, .vector, "Erasing handwritten maths removes whole strokes")

                XCTAssertTrue(
                    BoardInk.tool(for: .lasso, color: color, thickness: thickness) is PKLassoTool,
                    "Lasso takes neither colour nor width"
                )
            }
        }
    }

    func testPenPaletteHexesSurviveTheRoundTripIntoUIColor() throws {
        // The design token's own digits, byte for byte. Any drift between the
        // swatch the student taps and the ink it arms shows up here.
        let expected: [(color: PenColor, red: Int, green: Int, blue: Int)] = [
            (.black, 10, 10, 10),
            (.violet, 96, 81, 220),
            (.blue, 1, 85, 251),
            (.green, 64, 163, 101),
            (.red, 227, 62, 56)
        ]
        XCTAssertEqual(expected.map(\.color), PenColor.allCases, "Every pen colour must be covered")

        for (color, red, green, blue) in expected {
            let components = try rgba(of: BoardInk.uiColor(for: color))
            XCTAssertEqual(components.red, CGFloat(red) / 255, accuracy: 1e-9, color.hex)
            XCTAssertEqual(components.green, CGFloat(green) / 255, accuracy: 1e-9, color.hex)
            XCTAssertEqual(components.blue, CGFloat(blue) / 255, accuracy: 1e-9, color.hex)
            XCTAssertEqual(components.alpha, 1, accuracy: 1e-9, color.hex)

            // The same digits back out of the colour as 8-bit values: the round
            // trip is exact, not merely close.
            XCTAssertEqual(Int((components.red * 255).rounded()), red, color.hex)
            XCTAssertEqual(Int((components.green * 255).rounded()), green, color.hex)
            XCTAssertEqual(Int((components.blue * 255).rounded()), blue, color.hex)
        }
    }

    func testThicknessReachesTheInkUnclamped() throws {
        for thickness in StrokeThickness.allCases {
            let pen = try XCTUnwrap(
                BoardInk.tool(for: .pen, color: .black, thickness: thickness) as? PKInkingTool
            )
            XCTAssertEqual(
                pen.width,
                thickness.pointWidth,
                accuracy: 0.0001,
                "PencilKit clamped \(thickness) on its way to the pen"
            )
            XCTAssertTrue(PKInkingTool.InkType.pen.validWidthRange.contains(thickness.pointWidth))

            let highlighter = try XCTUnwrap(
                BoardInk.tool(for: .highlighter, color: .black, thickness: thickness) as? PKInkingTool
            )
            let widened = thickness.pointWidth * BoardInk.highlighterWidthMultiple
            XCTAssertEqual(
                highlighter.width,
                widened,
                accuracy: 0.0001,
                "PencilKit clamped the widened \(thickness) highlighter"
            )
            XCTAssertTrue(
                PKInkingTool.InkType.marker.validWidthRange.contains(widened),
                "The highlighter multiple must keep every step inside marker's own range"
            )
        }
    }

    /// The board must never hand tool selection back to PencilKit. This is a
    /// structural guard rather than a behavioural one: a reinstated
    /// `PKToolPicker` would float its own palette over the rail, and nothing
    /// else in the suite would notice.
    @MainActor
    func testTheBoardOwnsItsToolAndCreatesNoToolPicker() throws {
        let capture = CanvasCapture()
        let board = PencilCanvasView(
            capture: capture,
            initialDrawingData: nil,
            tool: .pen,
            penColor: .red,
            thickness: .bold,
            onDrawingChange: { _ in },
            onUndo: { },
            onRedo: { }
        )

        assertNoToolPickerStored(by: board)
        assertNoToolPickerStored(by: PencilCanvasView.Coordinator(board))

        // Mounting for real is what proves the *app* armed the canvas: with the
        // picker gone, `canvas.tool` is PencilKit's default until the rail's
        // selection is applied.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768))
        window.rootViewController = UIHostingController(rootView: board)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()

        let canvas = try XCTUnwrap(capture.canvasView, "Mounting the board must attach a canvas to the capture")
        let inking = try XCTUnwrap(canvas.tool as? PKInkingTool)
        XCTAssertEqual(inking.inkType, .pen)
        XCTAssertEqual(inking.width, StrokeThickness.bold.pointWidth, accuracy: 0.0001)
        try assertComponents(of: inking.color, match: .red, alpha: 1)
    }

    private func assertNoToolPickerStored(
        by subject: Any,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for child in Mirror(reflecting: subject).children {
            let description = "\(child.label ?? "") \(type(of: child.value))"
            XCTAssertFalse(
                description.localizedCaseInsensitiveContains("toolpicker"),
                "\(type(of: subject)) is holding a tool picker again: \(description)",
                file: file,
                line: line
            )
        }
    }

    private func assertComponents(
        of color: UIColor,
        match penColor: PenColor,
        alpha: CGFloat,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let actual = try rgba(of: color, file: file, line: line)
        let expected = try rgba(of: BoardInk.uiColor(for: penColor), file: file, line: line)
        XCTAssertEqual(actual.red, expected.red, accuracy: 1e-6, penColor.hex, file: file, line: line)
        XCTAssertEqual(actual.green, expected.green, accuracy: 1e-6, penColor.hex, file: file, line: line)
        XCTAssertEqual(actual.blue, expected.blue, accuracy: 1e-6, penColor.hex, file: file, line: line)
        XCTAssertEqual(actual.alpha, alpha, accuracy: 1e-6, penColor.hex, file: file, line: line)
    }

    private func rgba(
        of color: UIColor,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> (red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        let components = color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            ? (red, green, blue, alpha)
            : nil
        return try XCTUnwrap(components, "\(color) is not an RGBA colour", file: file, line: line)
    }
}
