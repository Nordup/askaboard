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

    func testBracketDisplayBlockWithSetextEqualsLineStaysOneMathSpan() {
        // The failing message of 2026-08-15 (turn 792b04a0...): \[ \] content
        // across several lines with a bare "=" line. If interior newlines
        // survive into the emitted $$ block, CommonMark reads the "=" line as
        // a setext-heading underline, splits the block, and the app shows raw
        // LaTeX source instead of math.
        let input = "### Your first calculation\n\n\\[\nm_{\\mathrm{O_2}}\n=\n\\frac{0.03200}{6.022\\times10^{23}}\\ \\mathrm{kg}.\n\\]\n\nCalculate that value first."
        let expected = "### Your first calculation\n\n$$ m_{\\mathrm{O_2}} = \\frac{0.03200}{6.022\\times10^{23}}\\ \\mathrm{kg}. $$\n\nCalculate that value first."

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), expected)
    }

    func testPaddedInlineDollarSpanIsTrimmedForTheRenderer() {
        // The failing message of 2026-08-15: "$ \mathrm{J} $" with padding.
        // The renderer's currency guard rejects spans that start or end with
        // whitespace, so the padded span showed as raw source.
        let input = #"A joule, symbol $ \mathrm{J} $, measures energy."#

        XCTAssertEqual(
            TutorMathMarkdownAdapter.renderableMarkdown(input),
            #"A joule, symbol $\mathrm{J}$, measures energy."#
        )
    }

    func testUnpaddedInlineDollarSpanPassesThroughUnchanged() {
        let input = #"Energy $E_k$ grows."#

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), input)
    }

    func testCurrencyStaysProse() {
        for input in [
            "It costs $5 and $8 total.",
            "Save $ 20 on the bundle price today.",
            "A lone $ sign stays.",
        ] {
            XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), input)
        }
    }

    func testPaddedDollarSpanCutByStreamingStaysLiteral() {
        let input = #"symbol $ \mathrm{J"#

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), input)
    }

    func testDollarDisplayBlockSurvivesItsOwnNewlines() {
        // The failing message of 2026-08-15: the tutor emitted a $$ block with
        // the TeX on its own lines. Newlines inside must not become hard
        // breaks, or the block splits into paragraphs and shows raw source.
        let input = "Your first calculation\n\n$$\nm_{\\mathrm{O_2}} = \\frac{0.03200}{6.022\\times10^{23}}\\ \\mathrm{kg}.\n$$\n\nCalculate that value first."
        let expected = "Your first calculation\n\n$$ m_{\\mathrm{O_2}} = \\frac{0.03200}{6.022\\times10^{23}}\\ \\mathrm{kg}. $$\n\nCalculate that value first."

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), expected)
    }

    func testSingleLineDollarBlockPassesThroughUnchanged() {
        let input = #"$$E = mc^2$$ done."#

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), input)
    }

    func testDollarBlockThinSpaceIsNormalizedLikeBracketMath() {
        let input = "$$1\\,\\mathrm{K}$$"

        XCTAssertEqual(
            TutorMathMarkdownAdapter.renderableMarkdown(input),
            "$$1\\text{ }\\mathrm{K}$$"
        )
    }

    func testIncompleteDollarBlockDuringStreamingStaysLiteral() {
        let input = "Value:\n\n$$\nm = \\frac{M}{N_A}"

        XCTAssertEqual(
            TutorMathMarkdownAdapter.renderableMarkdown(input),
            "Value:\n\n$$\nm = \\frac{M}{N_A}"
        )
    }

    func testIncompleteMathDuringStreamingIsNotHalfConverted() {
        let input = #"Energy is \(\frac{3}{2}"#

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), input)
    }

    func testMathCutOnTheCloserBackslashDuringStreamingStaysLiteral() {
        // A streamed chunk can end on the backslash of a closer whose
        // bracket has not arrived yet.
        let input = #"Energy is \(\frac{3}{2}k_BT\"#

        XCTAssertEqual(TutorMathMarkdownAdapter.renderableMarkdown(input), input)
    }

    func testEveryStreamingPrefixRendersWithoutTrapping() {
        // Deltas can cut a reply at any character, and the adapter runs on
        // every delta. Every prefix must render, not only the whole reply.
        let reply = "**Mean energy.** Inline \\(\\overline{E_k}=\\frac{3}{2}k_BT\\), display\n\\[v=\\sqrt{\\frac{3k_BT}{m}}\\\\ \\text{per mole}\\]\nkeep `\\(k_B\\)` literal, fence\n```latex\n\\[x\\]\n```\nand close \\(T+1\\)."

        for end in reply.indices {
            _ = TutorMathMarkdownAdapter.renderableMarkdown(String(reply[..<end]))
        }
        _ = TutorMathMarkdownAdapter.renderableMarkdown(reply)
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
    func testInlineMathParagraphReflowsWhenAvailableWidthShrinks() {
        let markdown = #"The average translational kinetic energy per molecule depends on \(k_B\), the Boltzmann constant, and the absolute temperature of the gas."#

        func fittingSize(width: CGFloat) -> CGSize {
            let host = UIHostingController(
                rootView: TutorMessageText(markdown: markdown)
                    .fixedSize(horizontal: false, vertical: true)
            )
            return host.sizeThatFits(in: CGSize(width: width, height: 1_000))
        }

        let wide = fittingSize(width: 360)
        let narrow = fittingSize(width: 220)

        XCTAssertLessThanOrEqual(narrow.width, 220.5)
        XCTAssertGreaterThan(
            narrow.height,
            wide.height,
            "Mixed prose and inline math must create more wrapped lines as the dock narrows"
        )
    }

    @MainActor
    private func descendants(of view: UIView) -> [UIView] {
        view.subviews.flatMap { [$0] + descendants(of: $0) }
    }
}
