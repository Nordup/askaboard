// MarkdownRenderer.swift
// MarkdownExtendedView
//
// Copyright (c) 2025 Christian C. Berclaz
// Licensed under MIT License

import SwiftUI
import Markdown

/// Renders a parsed Markdown document to SwiftUI views.
struct MarkdownRenderer: View {

    let document: Document
    let theme: MarkdownTheme
    let baseURL: URL?

    @Environment(\.markdownFeatures) private var features
    @Environment(\.markdownLinkHandler) private var linkHandler

    var body: some View {
        VStack(alignment: .leading, spacing: theme.paragraphSpacing) {
            ForEach(Array(document.children.enumerated()), id: \.offset) { _, child in
                renderBlock(child)
            }
        }
    }

    /// Whether clickable links are enabled.
    private var linksEnabled: Bool {
        features.contains(.links)
    }

    /// Whether syntax highlighting is enabled.
    private var syntaxHighlightingEnabled: Bool {
        features.contains(.syntaxHighlighting)
    }

    /// Whether Mermaid diagram rendering is enabled.
    private var mermaidEnabled: Bool {
        features.contains(.mermaid)
    }

    // MARK: - Block Rendering

    private func renderBlock(_ markup: any Markup) -> AnyView {
        if let heading = markup as? Heading {
            return AnyView(renderHeading(heading))
        } else if let paragraph = markup as? Paragraph {
            return AnyView(renderParagraph(paragraph))
        } else if let codeBlock = markup as? CodeBlock {
            return AnyView(renderCodeBlock(codeBlock))
        } else if let blockQuote = markup as? BlockQuote {
            return AnyView(renderBlockQuote(blockQuote))
        } else if let orderedList = markup as? OrderedList {
            return AnyView(renderOrderedList(orderedList))
        } else if let unorderedList = markup as? UnorderedList {
            return AnyView(renderUnorderedList(unorderedList))
        } else if let table = markup as? Markdown.Table {
            return AnyView(renderTable(table))
        } else if markup is ThematicBreak {
            return AnyView(Divider().padding(.vertical, 8))
        } else if let htmlBlock = markup as? HTMLBlock {
            return AnyView(
                SwiftUI.Text(htmlBlock.rawHTML)
                    .font(theme.codeFont)
                    .foregroundColor(theme.secondaryTextColor)
            )
        } else {
            return AnyView(EmptyView())
        }
    }

    // MARK: - Heading

    @ViewBuilder
    private func renderHeading(_ heading: Heading) -> some View {
        renderInlineChildren(heading)
            .font(theme.headingFont(level: heading.level))
            .foregroundColor(theme.textColor)
            .padding(.top, heading.level == 1 ? 16 : 8)
            .padding(.bottom, 4)
    }

    // MARK: - Paragraph

    @ViewBuilder
    private func renderParagraph(_ paragraph: Paragraph) -> some View {
        // Check if this paragraph contains only a display LaTeX block
        let plainText = paragraph.plainText
        if plainText.hasPrefix("$$") && plainText.hasSuffix("$$") {
            // This is a display LaTeX block
            let latex = String(plainText.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespacesAndNewlines)
            LaTeXView(latex: latex, isBlock: true, theme: theme)
        } else {
            renderInlineChildren(paragraph)
                .font(theme.bodyFont)
                .foregroundColor(theme.textColor)
        }
    }

    // MARK: - Code Block

    @ViewBuilder
    private func renderCodeBlock(_ codeBlock: CodeBlock) -> some View {
        if codeBlock.language == "mermaid" {
            renderMermaidBlock(codeBlock)
        } else {
            renderRegularCodeBlock(codeBlock)
        }
    }

    @ViewBuilder
    private func renderMermaidBlock(_ codeBlock: CodeBlock) -> some View {
        if mermaidEnabled {
            MermaidView(code: codeBlock.code, theme: theme)
        } else {
            MermaidPlaceholderView(code: codeBlock.code, theme: theme)
        }
    }

    @ViewBuilder
    private func renderRegularCodeBlock(_ codeBlock: CodeBlock) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            if syntaxHighlightingEnabled && codeBlock.language != nil {
                HighlightedCodeView(
                    code: codeBlock.code,
                    language: codeBlock.language,
                    theme: theme
                )
            } else {
                Text(codeBlock.code.trimmingCharacters(in: .newlines))
                    .font(theme.codeBlockFont)
                    .foregroundColor(theme.textColor)
            }
        }
        .padding(theme.codeBlockPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.codeBackgroundColor)
        .cornerRadius(8)
    }

    // MARK: - Block Quote

    @ViewBuilder
    private func renderBlockQuote(_ blockQuote: BlockQuote) -> some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(theme.blockQuoteBorderColor)
                .frame(width: 4)

            VStack(alignment: .leading, spacing: theme.paragraphSpacing / 2) {
                ForEach(Array(blockQuote.children.enumerated()), id: \.offset) { _, child in
                    renderBlock(child)
                }
            }
            .padding(.leading, 12)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Lists

    /// Bullet styles for different nesting levels in unordered lists.
    private static let bulletStyles = ["•", "◦", "▪", "▸"]

    /// Returns the bullet character for a given nesting depth.
    private func bulletForDepth(_ depth: Int) -> String {
        Self.bulletStyles[depth % Self.bulletStyles.count]
    }

    @ViewBuilder
    private func renderOrderedList(_ list: OrderedList, depth: Int = 0) -> some View {
        VStack(alignment: .leading, spacing: theme.listItemSpacing) {
            ForEach(Array(list.listItems.enumerated()), id: \.offset) { index, item in
                renderListItem(item, bullet: "\(index + Int(list.startIndex)).", depth: depth)
            }
        }
        .padding(.leading, depth > 0 ? theme.indentation : 0)
    }

    @ViewBuilder
    private func renderUnorderedList(_ list: UnorderedList, depth: Int = 0) -> some View {
        VStack(alignment: .leading, spacing: theme.listItemSpacing) {
            ForEach(Array(list.listItems.enumerated()), id: \.offset) { _, item in
                if item.checkbox != nil {
                    renderTaskListItem(item, depth: depth)
                } else {
                    renderListItem(item, bullet: bulletForDepth(depth), depth: depth)
                }
            }
        }
        .padding(.leading, depth > 0 ? theme.indentation : 0)
    }

    @ViewBuilder
    private func renderListItem(_ item: ListItem, bullet: String, depth: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(bullet)
                .font(theme.bodyFont)
                .foregroundColor(theme.textColor)
                .frame(width: 20, alignment: .trailing)

            VStack(alignment: .leading, spacing: theme.listItemSpacing) {
                ForEach(Array(item.children.enumerated()), id: \.offset) { _, child in
                    renderListChildBlock(child, depth: depth)
                }
            }
        }
    }

    @ViewBuilder
    private func renderTaskListItem(_ item: ListItem, depth: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: item.checkbox?.isChecked == true ? "checkmark.square.fill" : "square")
                .font(theme.bodyFont)
                .foregroundColor(item.checkbox?.isChecked == true ? theme.linkColor : theme.secondaryTextColor)
                .frame(width: 20, alignment: .trailing)

            VStack(alignment: .leading, spacing: theme.listItemSpacing) {
                ForEach(Array(item.children.enumerated()), id: \.offset) { _, child in
                    renderListChildBlock(child, depth: depth)
                }
            }
        }
    }

    /// Renders a child block within a list item, handling nested lists specially.
    private func renderListChildBlock(_ markup: any Markup, depth: Int) -> AnyView {
        if let nestedOrdered = markup as? OrderedList {
            return AnyView(renderOrderedList(nestedOrdered, depth: depth + 1))
        } else if let nestedUnordered = markup as? UnorderedList {
            return AnyView(renderUnorderedList(nestedUnordered, depth: depth + 1))
        } else {
            return renderBlock(markup)
        }
    }

    // MARK: - Table

    @ViewBuilder
    private func renderTable(_ table: Markdown.Table) -> some View {
        let cellArrays = extractTableCells(from: table)

        VStack(spacing: 0) {
            // Header row
            if !cellArrays.header.isEmpty {
                renderTableCellRow(cells: cellArrays.header, isHeader: true)
            }

            // Body rows
            ForEach(Array(cellArrays.body.enumerated()), id: \.offset) { _, rowCells in
                renderTableCellRow(cells: rowCells, isHeader: false)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 4)
                .stroke(theme.tableBorderColor, lineWidth: 1)
        )
        .cornerRadius(4)
    }

    /// Extracts cells from a table into arrays for easier SwiftUI rendering.
    private func extractTableCells(from table: Markdown.Table) -> (header: [Markdown.Table.Cell], body: [[Markdown.Table.Cell]]) {
        let header: [Markdown.Table.Cell] = Array(table.head.cells)
        let body: [[Markdown.Table.Cell]] = table.body.rows.map { Array($0.cells) }
        return (header, body)
    }

    @ViewBuilder
    private func renderTableCellRow(cells: [Markdown.Table.Cell], isHeader: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                renderInlineChildren(cell)
                    .font(isHeader ? theme.bodyFont.bold() : theme.bodyFont)
                    .foregroundColor(theme.textColor)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(isHeader ? theme.tableHeaderBackgroundColor : Color.clear)

                if index < cells.count - 1 {
                    Divider()
                }
            }
        }
        .overlay(
            Rectangle()
                .stroke(theme.tableBorderColor, lineWidth: 0.5)
        )
    }

    // MARK: - Inline Rendering

    @ViewBuilder
    private func renderInlineChildren(_ parent: any Markup) -> some View {
        let inlineText = buildInlineText(from: parent)
        inlineText
    }

    /// Builds a Text view from inline children, handling LaTeX segments and links.
    private func buildInlineText(from parent: any Markup) -> some View {
        let plainText = extractPlainText(from: parent)

        // Check if text contains LaTeX
        if LaTeXPreprocessor.containsLaTeX(plainText) {
            return AnyView(renderTextWithLaTeX(parent))
        }

        // Check if links are enabled and content contains links
        if linksEnabled && containsLinks(parent) {
            return AnyView(renderTextWithLinks(parent))
        }

        // Check if images are enabled and content contains images
        if imagesEnabled && containsImages(parent) {
            return AnyView(renderTextWithImages(parent))
        }

        return AnyView(buildAttributedText(from: parent))
    }

    /// Whether image loading is enabled.
    private var imagesEnabled: Bool {
        features.contains(.images)
    }

    /// Checks if the markup contains any Link nodes.
    private func containsLinks(_ parent: any Markup) -> Bool {
        for child in parent.children {
            if child is Markdown.Link { return true }
            if containsLinks(child) { return true }
        }
        return false
    }

    /// Checks if the markup contains any Image nodes.
    private func containsImages(_ parent: any Markup) -> Bool {
        for child in parent.children {
            if child is Markdown.Image { return true }
            if containsImages(child) { return true }
        }
        return false
    }

    /// Renders text with images using flow layout.
    @ViewBuilder
    private func renderTextWithImages(_ parent: any Markup) -> some View {
        FlowLayout(spacing: 0) {
            ForEach(Array(parent.children.enumerated()), id: \.offset) { _, child in
                renderInlineElementAsView(child)
            }
        }
    }

    /// Renders text with clickable links using flow layout.
    @ViewBuilder
    private func renderTextWithLinks(_ parent: any Markup) -> some View {
        FlowLayout(spacing: 0) {
            ForEach(Array(parent.children.enumerated()), id: \.offset) { _, child in
                renderInlineElementAsView(child)
            }
        }
    }

    /// Renders an inline element as a View (for use in flow layout with links).
    @ViewBuilder
    private func renderInlineElementAsView(_ element: any Markup) -> some View {
        switch element {
        case let text as Markdown.Text:
            SwiftUI.Text(text.string)
                .font(theme.bodyFont)
                .foregroundColor(theme.textColor)

        case let strong as Strong:
            renderStrongAsView(strong)

        case let emphasis as Emphasis:
            renderEmphasisAsView(emphasis)

        case let link as Markdown.Link:
            TappableLinkView(
                link: link,
                theme: theme,
                linkHandler: linkHandler,
                baseURL: baseURL
            )

        case let code as InlineCode:
            SwiftUI.Text(code.code)
                .font(theme.codeFont)
                .foregroundColor(theme.textColor)

        case _ as SoftBreak:
            SwiftUI.Text(" ")
                .font(theme.bodyFont)
                .foregroundColor(theme.textColor)

        case _ as LineBreak:
            SwiftUI.Text("\n")
                .font(theme.bodyFont)
                .foregroundColor(theme.textColor)

        case let image as Markdown.Image:
            MarkdownImageView(
                image: image,
                theme: theme,
                baseURL: baseURL
            )

        default:
            if let plainText = element as? any PlainTextConvertibleMarkup {
                SwiftUI.Text(plainText.plainText)
                    .font(theme.bodyFont)
                    .foregroundColor(theme.textColor)
            }
        }
    }

    /// Helper for rendering Strong in flow layout (simplified to avoid type inference issues).
    @ViewBuilder
    private func renderStrongAsView(_ strong: Strong) -> some View {
        // Simplified: render plain text with bold styling
        SwiftUI.Text(extractPlainText(from: strong))
            .bold()
            .font(theme.bodyFont)
            .foregroundColor(theme.textColor)
    }

    /// Helper for rendering Emphasis in flow layout (simplified to avoid type inference issues).
    @ViewBuilder
    private func renderEmphasisAsView(_ emphasis: Emphasis) -> some View {
        // Simplified: render plain text with italic styling
        SwiftUI.Text(extractPlainText(from: emphasis))
            .italic()
            .font(theme.bodyFont)
            .foregroundColor(theme.textColor)
    }

    /// Renders text that may contain inline LaTeX.
    @ViewBuilder
    private func renderTextWithLaTeX(_ parent: any Markup) -> some View {
        let plainText = extractPlainText(from: parent)
        let fragments = Self.inlineLaTeXFragments(from: plainText)

        // Prose is broken into word-sized fragments so FlowLayout wraps mixed
        // text and math at the same word boundaries as ordinary SwiftUI text,
        // while every formula stays atomic.
        FlowLayout(spacing: 0, breaks: fragments.map(\.forcesLineBreak)) {
            ForEach(Array(fragments.enumerated()), id: \.offset) { item in
                renderFragment(item.element)
            }
        }
    }

    /// Renders a single LaTeX flow fragment.
    @ViewBuilder
    private func renderFragment(_ fragment: InlineLaTeXFragment) -> some View {
        switch fragment {
        case .text(let text):
            SwiftUI.Text(text)
                .font(theme.bodyFont)
                .foregroundColor(theme.textColor)

        case .breakLine:
            // Zero-width, invisible item whose measured height gives FlowLayout
            // the body line height needed for blank lines between hard breaks.
            SwiftUI.Text(" ")
                .font(theme.bodyFont)
                .foregroundColor(theme.textColor)
                .frame(width: 0)

        case .latex(let latex, let isBlock):
            LaTeXView(latex: latex, isBlock: isBlock, theme: theme)
        }
    }

    /// A word-, break-, or formula-sized item for LaTeX paragraph flow.
    private enum InlineLaTeXFragment: Equatable {
        case text(String)
        case breakLine
        case latex(String, isBlock: Bool)

        /// Whether the fragment must start a new flow line.
        var forcesLineBreak: Bool {
            if case .breakLine = self { return true }
            return false
        }
    }

    /// Splits a paragraph's plain text into flow fragments.
    ///
    /// Text segments are expanded to word-sized items with their following
    /// whitespace attached. A token can then wrap as a unit like a normal text
    /// word, and a wrapped line never starts with a stray space. Explicit
    /// newlines become break fragments so hard line breaks survive flow layout.
    private static func inlineLaTeXFragments(from plainText: String) -> [InlineLaTeXFragment] {
        var fragments: [InlineLaTeXFragment] = []
        for segment in LaTeXPreprocessor.extractSegments(from: plainText) {
            switch segment {
            case .text(let text):
                fragments.append(contentsOf: wordFragments(from: text))
            case .latex(let latex, let isBlock):
                fragments.append(.latex(latex, isBlock: isBlock))
            }
        }
        return fragments
    }

    private static func wordFragments(from text: String) -> [InlineLaTeXFragment] {
        var fragments: [InlineLaTeXFragment] = []
        var scan = text.startIndex
        while scan < text.endIndex {
            if text[scan] == "\n" {
                fragments.append(.breakLine)
                scan = text.index(after: scan)
                continue
            }
            let lineEnd = text[scan...].firstIndex(of: "\n") ?? text.endIndex
            fragments.append(contentsOf: wordFragments(in: text[scan..<lineEnd]))
            scan = lineEnd
        }
        return fragments
    }

    private static func wordFragments(in line: Substring) -> [InlineLaTeXFragment] {
        guard !line.isEmpty else { return [] }
        var fragments: [InlineLaTeXFragment] = []
        var scan = line.startIndex

        while scan < line.endIndex, line[scan].isWhitespace {
            scan = line.index(after: scan)
        }
        let leadingWhitespace = line[..<scan]

        if scan == line.endIndex {
            // Whitespace-only run between formulas: keep it as an item so the
            // spacing the author typed survives flow layout.
            return [.text(String(line))]
        }

        while scan < line.endIndex {
            let wordStart = scan
            while scan < line.endIndex, !line[scan].isWhitespace {
                scan = line.index(after: scan)
            }
            let wordEnd = scan
            while scan < line.endIndex, line[scan].isWhitespace {
                scan = line.index(after: scan)
            }
            guard wordStart < wordEnd else { break }

            let trailingWhitespace = line[wordEnd..<scan]
            if fragments.isEmpty {
                let token = String(leadingWhitespace) + line[wordStart..<wordEnd] + trailingWhitespace
                fragments.append(.text(token))
            } else {
                let token = String(line[wordStart..<wordEnd]) + trailingWhitespace
                fragments.append(.text(token))
            }
        }
        return fragments
    }

    /// Builds attributed text for inline content without LaTeX.
    private func buildAttributedText(from parent: any Markup) -> SwiftUI.Text {
        var result = SwiftUI.Text("")
        for child in parent.children {
            result = result + renderInlineElement(child)
        }
        return result
    }

    /// Renders a single inline element to Text.
    private func renderInlineElement(_ element: any Markup) -> SwiftUI.Text {
        switch element {
        case let text as Markdown.Text:
            return SwiftUI.Text(text.string)

        case let strong as Strong:
            let inner = buildTextFromChildren(strong)
            return inner.bold()

        case let emphasis as Emphasis:
            let inner = buildTextFromChildren(emphasis)
            return inner.italic()

        case let strikethrough as Strikethrough:
            let inner = buildTextFromChildren(strikethrough)
            return inner.strikethrough()

        case let code as InlineCode:
            return SwiftUI.Text(code.code)
                .font(theme.codeFont)

        case let link as Markdown.Link:
            let inner = buildTextFromChildren(link)
            return inner.foregroundColor(theme.linkColor)

        case _ as SoftBreak:
            return SwiftUI.Text(" ")

        case _ as LineBreak:
            return SwiftUI.Text("\n")

        case let image as Markdown.Image:
            // Display alt text for images (actual image loading would need AsyncImage)
            return SwiftUI.Text("[\(image.plainText)]")
                .foregroundColor(theme.secondaryTextColor)

        default:
            // For any other inline elements, try to extract plain text
            if let plainText = element as? any PlainTextConvertibleMarkup {
                return SwiftUI.Text(plainText.plainText)
            }
            return SwiftUI.Text("")
        }
    }

    /// Builds Text from children of a markup element.
    private func buildTextFromChildren(_ parent: any Markup) -> SwiftUI.Text {
        parent.children.reduce(SwiftUI.Text("")) { result, child in
            result + renderInlineElement(child)
        }
    }

    /// Extracts plain text from markup for LaTeX detection.
    private func extractPlainText(from markup: any Markup) -> String {
        if let plainText = markup as? any PlainTextConvertibleMarkup {
            return plainText.plainText
        }
        return markup.children.map { extractPlainText(from: $0) }.joined()
    }
}

// MARK: - Flow Layout

/// A simple flow layout for mixed text and views.
struct FlowLayout: Layout {
    var spacing: CGFloat = 0
    /// Per-subview flags marking explicit hard line breaks (e.g. markdown `\\`).
    var breaks: [Bool] = []

    func makeCache(subviews: Subviews) -> Cache {
        Cache()
    }

    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        // Content may have changed since the last pass (streaming text, edits),
        // so refresh the measurement sweep up front — SwiftUI runs this before
        // sizing and placement. Both methods below then reuse this pass's
        // measurements instead of each measuring every segment again.
        cache.measure(subviews: subviews)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let result = cache.layout(
            proposalWidth: proposal.width,
            subviews: subviews,
            spacing: spacing,
            breaks: breaks
        )
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let result = cache.layout(
            proposalWidth: proposal.width,
            subviews: subviews,
            spacing: spacing,
            breaks: breaks
        )

        for (index, subview) in subviews.enumerated() {
            if index < result.positions.count {
                let position = result.positions[index]
                subview.place(at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y), proposal: .unspecified)
            }
        }
    }

    /// Measured geometry reused across `sizeThatFits` and `placeSubviews`.
    ///
    /// `Layout` keeps one cache per layout instance across passes. `updateCache`
    /// refreshes the per-subview measurements whenever SwiftUI re-runs the
    /// layout, so the cached layout cannot outlive changed content; within a
    /// pass, both sizing and placement reuse the same measurements and the same
    /// computed positions rather than measuring every segment twice.
    struct Cache {
        /// Measured size of each subview, in order.
        private(set) var subviewSizes: [CGSize] = []
        /// The proposal width the computed layout was built for.
        private var computedProposalWidth: CGFloat?
        /// The break flags the computed layout was built for.
        private var computedBreaks: [Bool]?
        /// Whether `computed` holds a real layout for `computedProposalWidth`.
        ///
        /// The proposal width may legitimately be `nil` (unbounded first
        /// proposal), so the width alone cannot distinguish "computed for nil"
        /// from "never computed". Without this flag a first unbounded layout
        /// would return the placeholder `.zero` result instead of computing.
        private var hasComputedLayout = false
        /// The last computed layout.
        private var computed: (size: CGSize, positions: [CGPoint]) = (.zero, [])

        mutating func measure(subviews: Layout.Subviews) {
            subviewSizes = subviews.map { $0.sizeThatFits(.unspecified) }
            // The computed layout is rebuilt for the incoming proposal.
            computedProposalWidth = nil
            computedBreaks = nil
            hasComputedLayout = false
        }

        mutating func layout(
            proposalWidth: CGFloat?,
            subviews: Layout.Subviews,
            spacing: CGFloat,
            breaks: [Bool]
        ) -> (size: CGSize, positions: [CGPoint]) {
            // Defensive refresh for layout engines that do not call
            // `updateCache` before the first pass.
            if subviewSizes.count != subviews.count {
                measure(subviews: subviews)
            }
            if hasComputedLayout, proposalWidth == computedProposalWidth, breaks == computedBreaks {
                return computed
            }
            computedProposalWidth = proposalWidth
            computedBreaks = breaks
            hasComputedLayout = true
            computed = Self.computeLayout(
                proposalWidth: proposalWidth,
                sizes: subviewSizes,
                breaks: breaks,
                spacing: spacing
            )
            return computed
        }

        private static func computeLayout(
            proposalWidth: CGFloat?,
            sizes: [CGSize],
            breaks: [Bool],
            spacing: CGFloat
        ) -> (size: CGSize, positions: [CGPoint]) {
            let maxWidth = proposalWidth ?? .infinity
            var positions: [CGPoint] = []
            var lineIndexes: [Int] = []
            var lineHeights: [CGFloat] = [0]
            var currentX: CGFloat = 0
            var currentY: CGFloat = 0
            var lineHeight: CGFloat = 0
            var lineIndex = 0
            var totalHeight: CGFloat = 0
            var totalWidth: CGFloat = 0

            for (index, size) in sizes.enumerated() {
                let isBreak = breaks.indices.contains(index) && breaks[index]

                if isBreak {
                    if index == sizes.count - 1 {
                        // A trailing hard break closes the line without adding
                        // a blank line, matching Text's behavior for a trailing
                        // newline.
                        positions.append(CGPoint(x: currentX, y: currentY))
                        lineIndexes.append(lineIndex)
                        continue
                    }

                    if currentX == 0 {
                        // Leading or consecutive break: size the empty line with
                        // the break item's measured height.
                        currentY += size.height + spacing
                    } else {
                        currentY += lineHeight + spacing
                    }
                    currentX = 0
                    lineHeight = 0
                    lineIndex += 1
                    lineHeights.append(0)
                    positions.append(CGPoint(x: 0, y: currentY))
                    lineIndexes.append(lineIndex)
                    continue
                }

                if currentX + size.width > maxWidth && currentX > 0 {
                    // Move to next line
                    currentX = 0
                    currentY += lineHeight + spacing
                    lineHeight = 0
                    lineIndex += 1
                    lineHeights.append(0)
                }

                positions.append(CGPoint(x: currentX, y: currentY))
                lineIndexes.append(lineIndex)

                currentX += size.width + spacing
                lineHeight = max(lineHeight, size.height)
                lineHeights[lineIndex] = lineHeight
                totalWidth = max(totalWidth, currentX)
            }

            totalHeight = currentY + lineHeight

            // Text has a taller line box than most inline formulas. Center each
            // segment inside its line instead of pinning formulas to the top edge.
            // This closely follows the visual baseline without changing block math.
            for index in positions.indices {
                if breaks.indices.contains(index), breaks[index] { continue }
                let itemLineHeight = lineHeights[lineIndexes[index]]
                positions[index].y += (itemLineHeight - sizes[index].height) / 2
            }

            return (CGSize(width: totalWidth, height: totalHeight), positions)
        }
    }
}
