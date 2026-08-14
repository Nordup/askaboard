import XCTest
import ExtendedSwiftMath
import SwiftUI
import UIKit
@testable import MathTutor

final class StructuredChatTextTests: XCTestCase {
    func testInlineMathUsesRendererDelimiterWithoutChangingTeX() {
        let input = #"The constant \(k_B\) and temperature \(T\)."#

        XCTAssertEqual(
            TutorMathMarkdownAdapter.renderableMarkdown(input),
            #"The constant $k_B$ and temperature $T$."#
        )
    }

    func testDisplayMathKeepsFractionOverlineAndSubscripts() {
        let input = #"\[\overline{E_k}=\frac{3}{2}k_BT\]"#

        XCTAssertEqual(
            TutorMathMarkdownAdapter.renderableMarkdown(input),
            #"$$\overline{E_k}=\frac{3}{2}k_BT$$"#
        )
    }

    func testDegreeCommandsRemainTeXForTheMathRenderer() {
        let input = #"A \(1^\circ\mathrm{C}\) increase equals \(1\,\mathrm{K}\)."#

        XCTAssertEqual(
            TutorMathMarkdownAdapter.renderableMarkdown(input),
            #"A $1^\circ\mathrm{C}$ increase equals $1\text{ }\mathrm{K}$."#
        )
    }

    func testMarkdownOutsideMathIsUnchanged() {
        let input = #"**Answer:** \(x^2\)\n\n1. First\n2. Second"#

        XCTAssertEqual(
            TutorMathMarkdownAdapter.renderableMarkdown(input),
            #"**Answer:** $x^2$\n\n1. First\n2. Second"#
        )
    }

    func testSingleSoftBreakStaysVisibleBesideMath() {
        XCTAssertEqual(
            TutorMathMarkdownAdapter.renderableMarkdown("First line\n\\(x^2\\) next"),
            "First line  \n$x^2$ next"
        )
    }

    func testParagraphBreakIsNotChangedIntoHardBreakWhitespace() {
        XCTAssertEqual(
            TutorMathMarkdownAdapter.renderableMarkdown("First paragraph\n\nSecond paragraph"),
            "First paragraph\n\nSecond paragraph"
        )
    }

    func testInlineAndFencedCodeStayVerbatim() {
        let input = "Use `\\(k_B\\)` literally.\n\n```latex\n\\[\\frac{3}{2}\\]\n```\n\nRender \\(T+1\\)."
        let expected = "Use `\\(k_B\\)` literally.\n\n```latex\n\\[\\frac{3}{2}\\]\n```\n\nRender $T+1$."

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), expected)
    }

    func testIncompleteMathDuringStreamingIsNotHalfConverted() {
        let input = #"Energy is \(\frac{3}{2}"#

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), input)
    }

    func testIncompleteCodeDuringStreamingRemainsLiteral() {
        let input = #"Example: `\(k_B\) then \(T\)"#

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), input)
    }

    @MainActor
    func testInlineMathFitsInsideItsMathLabels() {
        let markdown = #"""
        \[\overline{E_k}=\frac{3}{2}k_BT\]

        where:

        - \(T\) is the absolute temperature in kelvins,
        - \(k_B\) is Boltzmann's constant,
        - \(\overline{E_k}\) means the average over all molecules.

        A \(1^\circ\mathrm{C}\) increase is also a \(1\,\mathrm{K}\) increase, so if the original temperature is \(T\), the new temperature is \(T+1\).
        """#
        let root = TutorMessageText(markdown: markdown)
            .frame(width: 360, alignment: .leading)
        let host = UIHostingController(rootView: root)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 360, height: 1_000))
        window.rootViewController = host
        window.makeKeyAndVisible()
        let fittingSize = host.sizeThatFits(in: CGSize(width: 360, height: 1_000))
        host.view.frame = CGRect(origin: .zero, size: fittingSize)
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.05))
        host.view.layoutIfNeeded()

        let mathLabels = descendants(of: host.view).filter {
            String(describing: type(of: $0)).contains("MTMathUILabel")
        }
        XCTAssertEqual(mathLabels.count, 8)
        for case let label as MTMathUILabel in mathLabels {
            guard let display = label.displayList else {
                XCTFail("Expected rendered inline math for \(label.latex ?? "unknown formula")")
                continue
            }

            let renderedHeight = display.ascent + display.descent
            XCTAssertGreaterThan(label.frame.width, 0)
            XCTAssertGreaterThan(label.frame.height, 0)
            XCTAssertLessThanOrEqual(
                renderedHeight,
                label.bounds.height + 0.5,
                "Inline \(label.latex ?? "formula") must not reflow taller than its clipping label"
            )
        }
    }

    @MainActor
    private func descendants(of view: UIView) -> [UIView] {
        view.subviews.flatMap { [$0] + descendants(of: $0) }
    }
}
