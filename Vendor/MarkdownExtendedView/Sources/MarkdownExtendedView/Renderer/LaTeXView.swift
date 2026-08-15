// LaTeXView.swift
// MarkdownExtendedView
//
// Copyright (c) 2025 Christian C. Berclaz
// Licensed under MIT License

import SwiftUI
import ExtendedSwiftMath
import ObjectiveC

/// Answers whether SwiftMath can parse a LaTeX string, with a cache: the
/// check runs from view bodies, which SwiftUI re-evaluates on layout passes.
enum LaTeXRenderability {
    private static let cache = NSCache<NSString, NSNumber>()

    static func isRenderable(_ latex: String) -> Bool {
        if let cached = cache.object(forKey: latex as NSString) {
            return cached.boolValue
        }
        var error: NSError? = nil
        _ = MTMathListBuilder.build(fromString: latex, error: &error)
        let renderable = error == nil
        cache.setObject(NSNumber(value: renderable), forKey: latex as NSString)
        return renderable
    }
}

/// A view that renders LaTeX equations using SwiftMath.
struct LaTeXView: View {

    let latex: String
    let isBlock: Bool
    let theme: MarkdownTheme

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if !LaTeXRenderability.isRenderable(latex) {
            // A formula the math parser rejects must degrade to its visible
            // source, never to blank space: MTMathUILabel reports no size for
            // an unparseable list, and the collapsed view would swallow the
            // formula entirely (an unsupported command erased a whole reply
            // block on 2026-08-15 before this fallback existed).
            Text(latex)
                .font(.system(size: isBlock ? 15 : 14, design: .monospaced))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.leading)
                .padding(.vertical, isBlock ? 8 : 0)
        } else if isBlock {
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

private var mathMeasurementCacheKey: UInt8 = 0

/// A memoized `sizeThatFits` for `MTMathUILabel`.
///
/// ExtendedSwiftMath re-typesets on every `sizeThatFits` call, and every one of
/// its setters — including a no-op assignment — parses or invalidates the label.
/// SwiftUI measures a representable repeatedly (the flow layout asks every
/// segment during both sizing and placement, and re-runs that on layout
/// passes), so an unchanged formula should answer from a cache instead of
/// paying the typesetter every time. `MTMathUILabel` is not `open`, so the
/// cache rides on the label itself through associated storage rather than a
/// subclass.
extension MTMathUILabel {

    private struct MeasurementKey: Hashable {
        let maxLayoutWidth: CGFloat
        let proposalWidth: CGFloat?
        let proposalHeight: CGFloat?
    }

    private var measurementCache: [MeasurementKey: CGSize]? {
        get {
            objc_getAssociatedObject(self, &mathMeasurementCacheKey) as? [MeasurementKey: CGSize]
        }
        set {
            objc_setAssociatedObject(
                self,
                &mathMeasurementCacheKey,
                newValue,
                .OBJC_ASSOCIATION_RETAIN_NONATOMIC
            )
        }
    }

    /// The label's render inputs changed; drop every cached measurement.
    func invalidateMeasurements() {
        measurementCache = nil
    }

    /// Assigns the wrap ceiling only when it actually changed.
    ///
    /// The dependency's setter discards the cached display list and invalidates
    /// layout even when the value is unchanged, and SwiftUI re-invokes sizing on
    /// layout passes, so an unconditional assignment would re-typeset and
    /// re-invalidate on every pass.
    func setPreferredMaxLayoutWidthIfChanged(_ width: CGFloat) {
        guard preferredMaxLayoutWidth != width else { return }
        preferredMaxLayoutWidth = width
        invalidateMeasurements()
    }

    /// Memoized measurement for the current render configuration.
    ///
    /// The key covers the proposal plus the wrap ceiling the dependency's
    /// `sizeThatFits` consults; `invalidateMeasurements` clears the cache
    /// whenever `apply(to:)` changes a render input.
    func measuredSize(_ proposal: CGSize) -> CGSize {
        let key = MeasurementKey(
            maxLayoutWidth: preferredMaxLayoutWidth,
            proposalWidth: proposal.width.isFinite ? proposal.width : nil,
            proposalHeight: proposal.height.isFinite ? proposal.height : nil
        )
        if let cached = measurementCache?[key] {
            return cached
        }
        let size = sizeThatFits(proposal)
        var cache = measurementCache ?? [:]
        cache[key] = size
        measurementCache = cache
        return size
    }
}

#if os(iOS)
extension MathView: UIViewRepresentable {
    func makeUIView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        label.setContentHuggingPriority(.required, for: .vertical)
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        label.backgroundColor = .clear
        apply(to: label)
        return label
    }

    func updateUIView(_ label: MTMathUILabel, context: Context) {
        apply(to: label)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: MTMathUILabel,
        context: Context
    ) -> CGSize? {
        if mode == .text {
            // Inline math never wraps inside a segment — FlowLayout wraps whole
            // segments. Pin the unwrapped ceiling up front (guarded, so an
            // unchanged label is not re-typeset) and measure once: the previous
            // implementation measured before *and* after assigning the ceiling,
            // paying the typesetter twice for the same unwrapped size.
            uiView.setPreferredMaxLayoutWidthIfChanged(10_000)
            let naturalSize = uiView.measuredSize(.zero)
            guard naturalSize.width.isFinite, naturalSize.height.isFinite,
                  naturalSize.width > 0, naturalSize.height > 0 else {
                return nil
            }
            // ExtendedSwiftMath re-typesets using the UIView's rounded bounds
            // width. A scripted atom such as k_B can then wrap after SwiftUI
            // measured it, making its display taller than the frame and clipping
            // almost the entire glyph. Keep inline formulas unwrapped and leave
            // one point of rounding tolerance; FlowLayout wraps between segments.
            return CGSize(
                width: ceil(naturalSize.width) + 1,
                height: ceil(naturalSize.height)
            )
        }

        if let proposedWidth = proposal.width,
           proposedWidth.isFinite, proposedWidth > 0 {
            uiView.setPreferredMaxLayoutWidthIfChanged(proposedWidth)
            let fitted = uiView.measuredSize(
                CGSize(width: proposedWidth, height: .greatestFiniteMagnitude)
            )
            guard fitted.width.isFinite, fitted.height.isFinite,
                  fitted.width > 0, fitted.height > 0 else {
                return nil
            }
            return fitted
        }

        uiView.setPreferredMaxLayoutWidthIfChanged(10_000)
        let naturalSize = uiView.measuredSize(.zero)
        guard naturalSize.width.isFinite, naturalSize.height.isFinite,
              naturalSize.width > 0, naturalSize.height > 0 else {
            return nil
        }
        return CGSize(width: ceil(naturalSize.width), height: ceil(naturalSize.height))
    }
}
#elseif os(macOS)
extension MathView: NSViewRepresentable {
    func makeNSView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        // Note: backgroundColor not accessible on macOS, view is transparent by default
        apply(to: label)
        return label
    }

    func updateNSView(_ label: MTMathUILabel, context: Context) {
        apply(to: label)
    }
}
#endif

private extension MathView {
    /// Applies render inputs only when they actually changed.
    ///
    /// Every `MTMathUILabel` setter — `latex` included — parses or invalidates
    /// the label even for a no-op assignment, and SwiftUI calls `updateUIView`
    /// whenever it re-renders the representable. Guarding each property is what
    /// stops a re-render from turning into a re-typeset of every visible
    /// formula, which is the hot path when a layout pass re-measures the thread.
    func apply(to label: MTMathUILabel) {
        var changed = false
        if label.latex != latex {
            label.latex = latex
            changed = true
        }
        if abs(label.fontSize - fontSize) > 0.001 {
            label.fontSize = fontSize
            changed = true
        }
        if label.textColor != textColor {
            label.textColor = textColor
            changed = true
        }
        if label.textAlignment.rawValue != textAlignment.rawValue {
            label.textAlignment = textAlignment
            changed = true
        }
        if !Self.sameMode(label.labelMode, mode) {
            label.labelMode = mode
            changed = true
        }
        if changed {
            label.invalidateMeasurements()
        }
    }

    /// `MTMathUILabelMode` is a plain enum without declared `Equatable`
    /// conformance; compare structurally so the guard never relies on it.
    static func sameMode(_ lhs: MTMathUILabelMode, _ rhs: MTMathUILabelMode) -> Bool {
        switch (lhs, rhs) {
        case (.display, .display), (.text, .text):
            return true
        case (_, _):
            return false
        }
    }
}

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
