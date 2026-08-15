//
//  BoxedTests.swift
//
//  Parse-level and render-level unit tests for \boxed, added in this vendored
//  copy: the amsmath command that frames its argument with a rectangle.
//

import XCTest
@testable import ExtendedSwiftMath

final class BoxedTests: XCTestCase {

    private func build(_ latex: String, file: StaticString = #file, line: UInt = #line) -> MTMathList {
        var error: NSError? = nil
        let list = MTMathListBuilder.build(fromString: latex, error: &error)
        XCTAssertNil(error, "Unexpected parse error for \(latex): \(error?.localizedDescription ?? "")", file: file, line: line)
        return list ?? MTMathList()
    }

    private func render(_ latex: String, file: StaticString = #file, line: UInt = #line) -> MTMathListDisplay {
        let font = MTFontManager.fontManager.defaultFont
        let display = MTTypesetter.createLineForMathList(build(latex), font: font, style: .display)
        XCTAssertNotNil(display, "nil display for \(latex)", file: file, line: line)
        return display ?? MTMathListDisplay(withDisplays: [], range: NSRange(location: 0, length: 0))
    }

    // MARK: - Parsing

    func testBoxedParses() {
        let list = build("\\boxed{x}")
        XCTAssertEqual(list.atoms.count, 1)
        let boxed = list.atoms[0] as! MTBoxed
        XCTAssertEqual(boxed.type, .boxed)
        XCTAssertEqual(MTMathListBuilder.mathListToString(boxed.innerList), "x")
        XCTAssertEqual(MTMathListBuilder.mathListToString(list), "\\boxed{x}")
    }

    func testBoxedInsideExpression() {
        let list = build("y=\\boxed{42}")
        XCTAssertEqual(list.atoms.count, 3)
        XCTAssertEqual(list.atoms[2].type, .boxed)
        XCTAssertEqual(MTMathListBuilder.mathListToString(list), "y=\\boxed{42}")
    }

    func testBoxedSessionFormulaParses() {
        // The display block the tutor emitted on 2026-08-15, which rendered as
        // a blank band before \boxed existed.
        let list = build("\\boxed{\\overline{E_k}=\\frac{3}{2}k_{\\mathrm B}T}")
        XCTAssertEqual(list.atoms.count, 1)
        XCTAssertEqual(list.atoms[0].type, .boxed)
    }

    func testBoxedFinalizedCopyKeepsInnerList() {
        let finalized = build("\\boxed{x+1}").finalized
        let boxed = finalized.atoms[0] as! MTBoxed
        XCTAssertEqual(MTMathListBuilder.mathListToString(boxed.innerList), "x+1")
    }

    // MARK: - Rendering

    func testBoxedRendersLargerThanInner() {
        let plain = render("x")
        let boxed = render("\\boxed{x}")
        XCTAssertGreaterThan(boxed.width, plain.width)
        XCTAssertGreaterThan(boxed.ascent, plain.ascent)
        XCTAssertGreaterThan(boxed.descent, plain.descent)
    }

    func testBoxedSessionFormulaRenders() {
        let display = render("\\boxed{\\overline{E_k}=\\frac{3}{2}k_{\\mathrm B}T}")
        XCTAssertGreaterThan(display.width, 0)
        XCTAssertGreaterThan(display.ascent, 0)
    }
}
