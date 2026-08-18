import Combine
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

    /// The board must not show PencilKit's empty-text menu ("Select All |
    /// Insert Space") on a tap. Both responder-chain gates
    /// (`canPerformAction` and `target(forAction:)`) are pinned in one place.
    ///
    /// The lasso's cut/copy/paste/duplicate/delete menu is presented by
    /// PencilKit itself and never routes through this canvas's responder chain,
    /// so the meaningful preservation contract is that a non-empty-text action
    /// answers exactly like a stock `PKCanvasView` in the same environment.
    /// The subclass must not veto or re-target anything else.
    @MainActor
    func testBoardCanvasSuppressesEmptyTextActionsButKeepsLassoEditActions() {
        let canvas = BoardCanvasView(frame: CGRect(x: 0, y: 0, width: 1_024, height: 768)).pencilCanvas
        let stock = PKCanvasView(frame: canvas.frame)

        XCTAssertTrue(
            canvas is BoardPencilCanvasView,
            "The board's default canvas must install the popup-suppressing subclass"
        )
        XCTAssertFalse(
            canvas.canPerformAction(#selector(UIResponder.selectAll(_:)), withSender: nil),
            "A tap must not offer Select All on an empty board"
        )
        XCTAssertNil(
            canvas.target(forAction: #selector(UIResponder.selectAll(_:)), withSender: nil),
            "Select All must have no responder target on an empty board"
        )
        XCTAssertFalse(
            canvas.canPerformAction(#selector(UIKeyInput.insertText(_:)), withSender: nil),
            "A tap must not offer Insert Space on a drawing board"
        )
        XCTAssertNil(
            canvas.target(forAction: #selector(UIKeyInput.insertText(_:)), withSender: nil),
            "Insert Space must have no responder target on a drawing board"
        )

        for action in [
            #selector(UIResponder.cut(_:)),
            #selector(UIResponder.copy(_:)),
            #selector(UIResponder.paste(_:)),
            #selector(UIResponder.delete(_:)),
            #selector(UIResponder.duplicate(_:))
        ] {
            XCTAssertEqual(
                canvas.canPerformAction(action, withSender: nil),
                stock.canPerformAction(action, withSender: nil),
                "Lasso edit action \(action) must keep the stock canvas answer"
            )
            XCTAssertEqual(
                canvas.target(forAction: action, withSender: nil) != nil,
                stock.target(forAction: action, withSender: nil) != nil,
                "Lasso edit action \(action) must keep the stock responder target"
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

/// `CanvasCapture.hasInk` — what `btn/select` in the collapsed dock is gated on.
///
/// It used to be a computed property reading through a `weak` canvas reference,
/// which meant SwiftUI had nothing to observe: the dock could not redraw when the
/// first stroke landed, so the control it gates could not report anything either.
@MainActor
final class CanvasCaptureInkStateTests: XCTestCase {
    func testAnEmptyBoardHasNoInk() {
        let capture = CanvasCapture()
        let canvas = PKCanvasView()
        capture.canvasView = canvas

        capture.refreshHasInk()

        XCTAssertFalse(capture.hasInk, "An empty board has nothing for btn/select to attach")
    }

    func testInkIsReportedOnceTheBoardIsWrittenOn() {
        let capture = CanvasCapture()
        let canvas = PKCanvasView()
        capture.canvasView = canvas
        capture.refreshHasInk()

        canvas.drawing = Self.oneStroke
        capture.refreshHasInk()

        XCTAssertTrue(capture.hasInk)
    }

    func testClearingTheBoardReportsItself() {
        let capture = CanvasCapture()
        let canvas = PKCanvasView()
        capture.canvasView = canvas
        canvas.drawing = Self.oneStroke
        capture.refreshHasInk()
        XCTAssertTrue(capture.hasInk)

        // Assigning `drawing` bypasses `PKCanvasViewDelegate`, so `clear()` is the
        // one emptying that has to report itself.
        capture.clear()

        XCTAssertFalse(capture.hasInk)
    }

    /// The publish is what the dock observes, and it must not fire per stroke:
    /// `CanvasCapture` is a `@StateObject` on `BoardScreen`, so a publish there is
    /// a re-render of the whole screen.
    func testOnlyAChangeOfTheAnswerPublishes() {
        let capture = CanvasCapture()
        let canvas = PKCanvasView()
        capture.canvasView = canvas
        canvas.drawing = Self.oneStroke

        var publishes = 0
        let subscription = capture.objectWillChange.sink { _ in publishes += 1 }
        defer { subscription.cancel() }

        capture.refreshHasInk()
        capture.refreshHasInk()
        capture.refreshHasInk()

        XCTAssertEqual(publishes, 1, "Only the empty → written transition is news")
    }

    private static var oneStroke: PKDrawing {
        let points = (0..<8).map { step in
            PKStrokePoint(
                location: CGPoint(x: 100, y: 100 + Double(step) * 8),
                timeOffset: Double(step) * 0.008,
                size: CGSize(width: 5, height: 5),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        return PKDrawing(strokes: [
            PKStroke(
                ink: PKInk(.pen, color: .black),
                path: PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: 0))
            )
        ])
    }
}
