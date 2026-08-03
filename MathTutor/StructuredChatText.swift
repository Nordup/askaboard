import Foundation
import MarkdownUI
import SwiftUI

/// The one assistant-message renderer shared by the full transcript, compact
/// floating transcript, and transient evaluation feedback card. MarkdownUI
/// handles GitHub-Flavored Markdown, while its soft-break mode keeps deliberate
/// single newlines visible in chat replies.
struct TutorStructuredText: View {
    let markdown: String

    init(_ markdown: String) {
        self.markdown = markdown
    }

    var body: some View {
        Markdown(markdown)
            .markdownSoftBreakMode(.lineBreak)
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
