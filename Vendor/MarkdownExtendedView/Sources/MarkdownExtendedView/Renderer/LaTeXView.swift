// LaTeXView.swift
// MarkdownExtendedView
//
// Copyright (c) 2025 Christian C. Berclaz
// Licensed under MIT License

import SwiftUI
import ExtendedSwiftMath

/// A view that renders LaTeX equations using SwiftMath.
struct LaTeXView: View {

    let latex: String
    let isBlock: Bool
    let theme: MarkdownTheme

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if isBlock {
            // Display/block math - centered, larger
            HStack {
                Spacer()
                mathView
                    .padding(.vertical, 12)
                Spacer()
            }
        } else {
            // Inline math - flows with text
            mathView
        }
    }

    @ViewBuilder
    private var mathView: some View {
        MathView(latex: latex)
            .font(fontSize: isBlock ? 21 : 17)
            .labelMode(isBlock ? .display : .text)
            .foregroundColor(textColor)
    }

    private var textColor: MTColor {
        #if os(iOS)
        return colorScheme == .dark ? .white : .black
        #elseif os(macOS)
        return colorScheme == .dark ? .white : .black
        #endif
    }
}

// MARK: - MathView (SwiftMath Wrapper)

/// A SwiftUI wrapper for SwiftMath's MTMathUILabel.
struct MathView {

    let latex: String

    fileprivate var fontSize: CGFloat = 17
    fileprivate var textColor: MTColor = .black
    fileprivate var textAlignment: MTTextAlignment = .left
    fileprivate var mode: MTMathUILabelMode = .text

    init(latex: String) {
        self.latex = latex
    }

    // MARK: - Modifiers

    func font(fontSize: CGFloat) -> MathView {
        var view = self
        view.fontSize = fontSize
        return view
    }

    func foregroundColor(_ color: MTColor) -> MathView {
        var view = self
        view.textColor = color
        return view
    }

    func textAlignment(_ alignment: MTTextAlignment) -> MathView {
        var view = self
        view.textAlignment = alignment
        return view
    }

    func labelMode(_ mode: MTMathUILabelMode) -> MathView {
        var view = self
        view.mode = mode
        return view
    }
}

#if os(iOS)
extension MathView: UIViewRepresentable {
    func makeUIView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        label.setContentHuggingPriority(.required, for: .vertical)
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        label.latex = latex
        label.fontSize = fontSize
        label.textColor = textColor
        label.textAlignment = textAlignment
        label.labelMode = mode
        label.backgroundColor = .clear
        return label
    }

    func updateUIView(_ uiView: MTMathUILabel, context: Context) {
        uiView.latex = latex
        uiView.fontSize = fontSize
        uiView.textColor = textColor
        uiView.textAlignment = textAlignment
        uiView.labelMode = mode
        uiView.invalidateIntrinsicContentSize()
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: MTMathUILabel,
        context: Context
    ) -> CGSize? {
        let naturalSize = uiView.sizeThatFits(.zero)
        guard naturalSize.width.isFinite, naturalSize.height.isFinite,
              naturalSize.width > 0, naturalSize.height > 0 else {
            return nil
        }

        if mode == .text {
            // ExtendedSwiftMath re-typesets using the UIView's rounded bounds
            // width. A scripted atom such as k_B can then wrap after SwiftUI
            // measured it, making its display taller than the frame and clipping
            // almost the entire glyph. Keep inline formulas unwrapped and leave
            // one point of rounding tolerance; FlowLayout wraps between segments.
            let safeWidth = ceil(naturalSize.width) + 1
            // This is a layout ceiling, not the returned view width. A generous
            // ceiling prevents the math engine from wrapping inside an inline
            // segment while SwiftUI still receives the compact natural width.
            uiView.preferredMaxLayoutWidth = 10_000
            let fitted = uiView.sizeThatFits(.zero)
            return CGSize(
                width: safeWidth,
                height: ceil(max(naturalSize.height, fitted.height))
            )
        }

        if let proposedWidth = proposal.width,
           proposedWidth.isFinite, proposedWidth > 0 {
            uiView.preferredMaxLayoutWidth = proposedWidth
            return uiView.sizeThatFits(
                CGSize(width: proposedWidth, height: .greatestFiniteMagnitude)
            )
        }

        uiView.preferredMaxLayoutWidth = 10_000
        return CGSize(width: ceil(naturalSize.width), height: ceil(naturalSize.height))
    }
}
#elseif os(macOS)
extension MathView: NSViewRepresentable {
    func makeNSView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        label.latex = latex
        label.fontSize = fontSize
        label.textColor = textColor
        label.textAlignment = textAlignment
        label.labelMode = mode
        // Note: backgroundColor not accessible on macOS, view is transparent by default
        return label
    }

    func updateNSView(_ nsView: MTMathUILabel, context: Context) {
        nsView.latex = latex
        nsView.fontSize = fontSize
        nsView.textColor = textColor
        nsView.textAlignment = textAlignment
        nsView.labelMode = mode
        nsView.invalidateIntrinsicContentSize()
    }
}
#endif

// MARK: - Preview

#if DEBUG
struct LaTeXView_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: 20) {
            Text("Inline LaTeX:")
            HStack {
                Text("The formula")
                LaTeXView(latex: "E = mc^2", isBlock: false, theme: .default)
                Text("is famous.")
            }

            Divider()

            Text("Block LaTeX:")
            LaTeXView(
                latex: "x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}",
                isBlock: true,
                theme: .default
            )
        }
        .padding()
    }
}
#endif
