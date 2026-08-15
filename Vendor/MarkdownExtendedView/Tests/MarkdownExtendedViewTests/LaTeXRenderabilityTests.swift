//
//  LaTeXRenderabilityTests.swift
//
//  The raw-TeX fallback's decision: a formula the math parser rejects must be
//  reported unrenderable so LaTeXView shows its source instead of blank space.
//

import XCTest
@testable import MarkdownExtendedView

final class LaTeXRenderabilityTests: XCTestCase {

    func testSupportedFormulasAreRenderable() {
        for latex in [
            "E = mc^2",
            "\\boxed{\\overline{E_k}=\\frac{3}{2}k_{\\mathrm B}T}",
            "\\begin{align} a &= b \\\\ c &= d \\end{align}",
            "x \\coloneqq \\underbrace{a+b}_{\\text{sum}}",
        ] {
            XCTAssertTrue(LaTeXRenderability.isRenderable(latex), latex)
        }
    }

    func testUnsupportedCommandsAreNotRenderable() {
        for latex in [
            "\\def\\x{1} \\x",
            "\\href{https://example.com}{link}",
            "\\begin{CD} A @>>> B \\end{CD}",
            "\\notarealcommand{x}",
        ] {
            XCTAssertFalse(LaTeXRenderability.isRenderable(latex), latex)
        }
    }

    func testCachedAnswerIsStable() {
        let latex = "\\notarealcommand{y}"
        XCTAssertFalse(LaTeXRenderability.isRenderable(latex))
        XCTAssertFalse(LaTeXRenderability.isRenderable(latex))
        XCTAssertTrue(LaTeXRenderability.isRenderable("a+b"))
        XCTAssertTrue(LaTeXRenderability.isRenderable("a+b"))
    }
}
