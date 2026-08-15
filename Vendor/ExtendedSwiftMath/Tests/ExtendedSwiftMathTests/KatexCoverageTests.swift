//
//  KatexCoverageTests.swift
//
//  Regression tests for the KaTeX-coverage batch added in this vendored copy:
//  symbol table entries generated from KaTeX's symbols.ts plus structural
//  commands (\dbinom, \sout, \phantom family, \tag, x-arrows, braces, \kern).
//

import XCTest
@testable import ExtendedSwiftMath

final class KatexCoverageTests: XCTestCase {

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

    // MARK: - Symbols and aliases

    func testGeneratedSymbolBatchParsesAndRenders() {
        // One representative per group of the generated table.
        for latex in ["a\\lessdot b", "\\lVert x\\rVert", "a\\therefore b",
                      "\\rightleftharpoons", "\\blacksquare", "\\checkmark",
                      "60\\textdegree", "\\lparen x\\rparen"] {
            XCTAssertGreaterThan(render(latex).width, 0, latex)
        }
    }

    func testAliasesResolve() {
        for latex in ["\\isin", "\\Reals", "\\dots", "\\dotsb", "\\larr",
                      "\\rArr", "\\infin", "\\plusmn", "\\varliminf_{n}",
                      "\\varGamma", "\\Alpha\\Beta"] {
            XCTAssertGreaterThan(render(latex).width, 0, latex)
        }
    }

    func testColonFamilyAndOperators() {
        XCTAssertGreaterThan(render("x\\coloneqq 5").width, 0)
        XCTAssertGreaterThan(render("\\argmax_{x} f(x)").width, 0)
        XCTAssertGreaterThan(render("\\tg x + \\ctg x").width, 0)
        XCTAssertGreaterThan(render("a \\thinspace b \\negthickspace c").width, 0)
    }

    // MARK: - Structural commands

    func testDbinomTbinom() {
        // The library serializes all binomials in \choose form.
        let list = build("\\dbinom{n}{k}\\tbinom{n}{k}")
        XCTAssertEqual(MTMathListBuilder.mathListToString(list),
                       "{\\displaystyle n \\choose \\displaystyle k}{\\textstyle n \\choose \\textstyle k}")
        XCTAssertGreaterThan(render("\\dbinom{n}{k}").width, 0)
    }

    func testSout() {
        let list = build("\\sout{x+1}")
        let cancel = list.atoms[0] as! MTCancel
        XCTAssertEqual(cancel.cancelType, .horizontal)
        XCTAssertEqual(MTMathListBuilder.mathListToString(list), "\\sout{x+1}")
        XCTAssertGreaterThan(render("\\sout{abc}").width, 0)
    }

    func testPhantomFamily() {
        let phantom = render("\\phantom{xyz}")
        let plain = render("xyz")
        XCTAssertEqual(phantom.width, plain.width, accuracy: 0.5)
        XCTAssertEqual(phantom.ascent, plain.ascent, accuracy: 0.5)

        let hphantom = render("\\hphantom{xyz}")
        XCTAssertEqual(hphantom.width, plain.width, accuracy: 0.5)
        XCTAssertEqual(hphantom.ascent, 0, accuracy: 0.5)

        let vphantom = render("\\vphantom{xyz}")
        XCTAssertEqual(vphantom.width, 0, accuracy: 0.5)
        XCTAssertEqual(vphantom.ascent, plain.ascent, accuracy: 0.5)

        XCTAssertEqual(MTMathListBuilder.mathListToString(build("\\smash{y}")), "\\smash{y}")
    }

    func testTagAndSizeSwitchesAreNoOps() {
        XCTAssertGreaterThan(render("x^2 \\tag{1}").width, 0)
        XCTAssertGreaterThan(render("\\small x + \\Huge y \\notag").width, 0)
    }

    func testKernFamily() {
        XCTAssertGreaterThan(render("a\\kern5pt b").width, render("ab").width)
        XCTAssertGreaterThan(render("a\\mkern18mu b").width, render("ab").width)
        XCTAssertGreaterThan(render("a\\hspace{1em}b").width, render("ab").width)
    }

    func testExtendedArrows() {
        let list = build("A \\xmapsto{f} B")
        XCTAssertEqual(MTMathListBuilder.mathListToString(list), "A\\xmapsto{f}B")
        XCTAssertGreaterThan(render("A \\xhookrightarrow[g]{f} B").width, 0)
        XCTAssertGreaterThan(render("a \\xlongequal{\\text{def}} b").width, 0)
    }

    func testBraces() {
        let list = build("\\underbrace{a+b}_{\\text{sum}}")
        let ou = list.atoms[0] as! MTOverUnder
        XCTAssertEqual(ou.braceCommand, "underbrace")
        let display = render("\\underbrace{a+b}_{\\text{sum}}")
        XCTAssertGreaterThan(display.descent, render("a+b").descent)
        XCTAssertGreaterThan(render("\\overbrace{x+y}^{n}").ascent, render("x+y").ascent)
    }

    func testMathopFlattening() {
        XCTAssertGreaterThan(render("\\mathop{argsup}_{x} f").width, 0)
        XCTAssertGreaterThan(render("a \\mathrel{R} b").width, 0)
    }

    func testMathringAndDddot() {
        XCTAssertGreaterThan(render("\\mathring{A}").width, 0)
        XCTAssertGreaterThan(render("\\dddot{x}").width, 0)
    }

    func testEnvironments() {
        XCTAssertGreaterThan(render("\\begin{array}{c|r} 1 & 22 \\\\ 333 & 4 \\end{array}").width, 0)
        XCTAssertGreaterThan(render("\\begin{align} a &= b \\\\ c &= d \\end{align}").width, 0)
        XCTAssertGreaterThan(render("\\begin{align*} a &= b \\end{align*}").width, 0)
        XCTAssertGreaterThan(render("\\begin{alignedat}{2} a &= b \\\\ c &= d \\end{alignedat}").width, 0)
        XCTAssertGreaterThan(render("\\begin{gather} a+b \\\\ c+d \\end{gather}").width, 0)
        XCTAssertGreaterThan(render("\\begin{dcases} \\frac{1}{2} & x>0 \\\\ 0 & x\\le 0 \\end{dcases}").width, 0)
        XCTAssertGreaterThan(render("\\begin{rcases} a & x \\\\ b & y \\end{rcases}").width, 0)
        XCTAssertGreaterThan(render("\\begin{equation} E = mc^2 \\end{equation}").width, 0)
    }

    func testBraketSetFamily() {
        XCTAssertGreaterThan(render("\\Bra{\\phi}\\Ket{\\psi}").width, 0)
        XCTAssertGreaterThan(render("\\Set{x | x > 0}").width, 0)
    }
}
