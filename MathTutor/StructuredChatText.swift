import Foundation
import MarkdownExtendedView
import SwiftUI

/// Display-boundary adapter that translates ChatGPT-style math delimiters into
/// the `$...$` / `$$...$$` syntax MarkdownExtendedView renders. Stored messages
/// keep the original TeX; only the string handed to the renderer changes.
/// Inline and fenced code spans pass through exactly.
enum TutorMathMarkdownAdapter {
    static func renderableMarkdown(_ markdown: String) -> String {
        var result = ""
        var remaining = Substring(markdown)

        while let runStart = remaining.firstIndex(of: "`") {
            result += adaptedText(String(remaining[..<runStart]))
            let runLength = remaining[runStart...].prefix { $0 == "`" }.count
            let runEnd = remaining.index(runStart, offsetBy: runLength)
            let afterOpen = remaining[runEnd...]

            if let closeEnd = closingRunEnd(in: afterOpen, length: runLength) {
                result += remaining[runStart..<closeEnd]
                remaining = remaining[closeEnd...]
            } else {
                result += remaining[runStart...]
                remaining = Substring()
            }
        }

        result += adaptedText(String(remaining))
        return result
    }

    private static func closingRunEnd(in content: Substring, length: Int) -> Substring.Index? {
        var index = content.startIndex
        while index < content.endIndex {
            guard content[index] == "`" else {
                index = content.index(after: index)
                continue
            }

            var runEnd = content.index(after: index)
            while runEnd < content.endIndex, content[runEnd] == "`" {
                runEnd = content.index(after: runEnd)
            }
            if content[index..<runEnd].count == length {
                return runEnd
            }
            index = runEnd
        }
        return nil
    }

    private static func adaptedText(_ text: String) -> String {
        var result = ""
        var remaining = Substring(text)
        var previousWasNewline = false

        while !remaining.isEmpty {
            if remaining.hasPrefix("\\(") || remaining.hasPrefix("\\[") {
                let isDisplay = remaining.hasPrefix("\\[")
                let contentStart = remaining.index(remaining.startIndex, offsetBy: 2)
                if let close = mathCloser(
                    in: remaining,
                    after: contentStart,
                    closer: isDisplay ? "]" : ")"
                ) {
                    let math = rendererCompatibleMath(
                        String(remaining[contentStart..<close.start])
                    )
                    result += isDisplay ? "$$" : "$"
                    result += math
                    result += isDisplay ? "$$" : "$"
                    remaining = remaining[close.end...]
                    previousWasNewline = false
                    continue
                }

                // Streaming replies can cut a delimiter before its closer; keep
                // the unfinished tail literal instead of manufacturing half of
                // a dollar-delimited math span.
                result += remaining
                break
            }

            if remaining.first == "\n" {
                // The previous renderer showed intentional single newlines.
                // MarkdownExtendedView follows CommonMark and collapses them,
                // so make only lone plain-text newlines hard breaks.
                let next = remaining.dropFirst().first
                let isBlankLineBoundary = previousWasNewline || next == "\n" || next == nil
                result += isBlankLineBoundary ? "\n" : "  \n"
                remaining = remaining.dropFirst()
                previousWasNewline = true
                continue
            }

            result.append(remaining.removeFirst())
            previousWasNewline = false
        }

        return result
    }

    /// ExtendedSwiftMath 2.1.3 parses TeX's thin-space `\,` inconsistently in
    /// inline text. A one-space `\text{ }` group remains typographic
    /// whitespace, so normalize only at the display boundary.
    private static func rendererCompatibleMath(_ math: String) -> String {
        math.replacingOccurrences(of: "\\,", with: "\\text{ }")
    }

    private static func mathCloser(
        in text: Substring,
        after start: Substring.Index,
        closer: Character
    ) -> (start: Substring.Index, end: Substring.Index)? {
        var index = start
        while index < text.endIndex {
            if text[index] == "\\" {
                let next = text.index(after: index)
                if next < text.endIndex, text[next] == closer {
                    return (index, text.index(after: next))
                }
                index = text.index(after: next)
            } else {
                index = text.index(after: index)
            }
        }
        return nil
    }

}

/// The one assistant-message renderer shared by the full transcript, compact
/// floating transcript, and transient evaluation feedback card.
/// MarkdownExtendedView handles GitHub-Flavored Markdown and LaTeX; the adapter
/// keeps stored replies in ChatGPT's \( ... \) / \[ ... \] form until this
/// display boundary.
struct TutorStructuredText: View {
    let markdown: String

    init(_ markdown: String) {
        self.markdown = markdown
    }

    var body: some View {
        MarkdownView(TutorMathMarkdownAdapter.renderableMarkdown(markdown))
            .textSelection(.enabled)
    }
}

/// Learner messages are user-authored data, not Markdown. Rendering them with
/// `Text(verbatim:)` preserves literal punctuation, whitespace, and newlines.
struct LearnerLiteralText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(verbatim: text)
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
    }
}
