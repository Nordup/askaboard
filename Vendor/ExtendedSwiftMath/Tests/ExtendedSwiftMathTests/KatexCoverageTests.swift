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

    func testSizeSwitchesAreNoOps() {
        XCTAssertGreaterThan(render("\\small x + \\Huge y \\notag").width, 0)
    }

    func testTagRendersLabel() {
        // The tag renders right of the formula: \qquad then "(label)".
        let tagged = render("x \\tag{1}")
        let plain = render("x")
        XCTAssertGreaterThan(tagged.width, plain.width)
        // Starred form omits the parentheses, so it is narrower.
        let starred = render("x \\tag*{1}")
        XCTAssertGreaterThan(starred.width, plain.width)
        XCTAssertLessThan(starred.width, tagged.width)

        // Structure and round-trip serialization.
        let list = build("x \\tag{12}")
        let tag = list.atoms[1] as! MTTag
        XCTAssertFalse(tag.starred)
        XCTAssertEqual(MTMathListBuilder.mathListToString(list), "x\\tag{12}")
        XCTAssertEqual(MTMathListBuilder.mathListToString(build("x \\tag*{A}")), "x\\tag*{A}")
    }

    func testNotNegatesNextAtom() {
        // Well-known pairs map to precomposed negated codepoints.
        let cases: [(String, String)] = [
            ("a \\not= b", "\u{2260}"),        // ≠
            ("a \\not\\in b", "\u{2209}"),     // ∉
            ("a \\not< b", "\u{226E}"),        // ≮
            ("a \\not> b", "\u{226F}"),        // ≯
            ("a \\not\\equiv b", "\u{2262}"),  // ≢
            ("A \\not\\subset B", "\u{2284}"), // ⊄
            ("a \\not\\leq b", "\u{2270}"),    // ≰
            ("A \\not\\subseteq B", "\u{2288}"), // ⊈
        ]
        for (latex, negated) in cases {
            let list = build(latex)
            XCTAssertEqual(list.atoms[1].nucleus, negated, latex)
            XCTAssertGreaterThan(render(latex).width, 0, latex)
        }
        // Unknown relations fall back to appending U+0338.
        let fallback = build("a \\not\\perp b")
        XCTAssertEqual(fallback.atoms[1].nucleus, "\u{27C2}\u{0338}")
        XCTAssertGreaterThan(render("a \\not\\perp b").width, 0)
    }

    func testVarGreekItalicCapitals() {
        // \varGamma family maps to Mathematical Italic Capital codepoints.
        let list = build("\\varGamma")
        XCTAssertEqual(list.atoms[0].nucleus, "\u{0001D6E4}")
        for name in ["varGamma", "varDelta", "varTheta", "varLambda", "varXi",
                     "varPi", "varSigma", "varUpsilon", "varPhi", "varPsi",
                     "varOmega"] {
            XCTAssertGreaterThan(render("\\" + name).width, 0, name)
        }
    }

    func testExactNegatedRelations() {
        // \ngeqq / \nleqq carry the exact combining form (base + U+0338).
        XCTAssertEqual(build("\\ngeqq").atoms[0].nucleus, "\u{2267}\u{0338}")
        XCTAssertEqual(build("\\nleqq").atoms[0].nucleus, "\u{2266}\u{0338}")
        for latex in ["a \\ngeqq b", "a \\nleqq b",
                      "A \\nsubseteqq B", "A \\nsupseteqq B"] {
            XCTAssertGreaterThan(render(latex).width, 0, latex)
        }
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
