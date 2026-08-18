import CoreGraphics
import CoreText
import Foundation
import UIKit

/// Tutor-authored prose rendered with Shantell Sans as vector outlines.
///
/// The old implementation plotted a hand-authored single-line alphabet and
/// tried to make it feel human with taper, rounded joins and jitter. Shantell
/// Sans already contains professionally drawn marker letterforms, so this
/// renderer deliberately adds no synthetic handwriting effects. Core Text
/// shapes the string, every outline glyph becomes a `CGPath`, and the scene
/// renderer fills that path with the element's `stroke` colour.
enum InkTextRenderer {
    /// Static upright Regular from the upstream Shantell Sans 1.011 release.
    /// A static face makes “default settings” literal: no variation dictionary,
    /// custom bounce, informality, spacing, slant or synthetic weight.
    static let fontPostScriptName = "ShantellSansNormal-Regular"
    static let fontFileName = "ShantellSans-Normal-Regular.otf"

    /// Small breathing room for antialiasing at a tile edge. This is not a
    /// stroke or design effect; it only keeps the last softened pixel mounted.
    static let inkPadding: CGFloat = 0.02

    private struct PictographRun {
        let line: CTLine
        let originX: CGFloat
        let baselineY: CGFloat
    }

    private struct Layout {
        let path: CGPath?
        let pictographs: [PictographRun]
        let bounds: CGRect
    }

    /// The real bundled face sized so its cap height, rather than its em, is
    /// the `size` the board schema promises.
    static func uiFont(forCapHeight rawCapHeight: CGFloat) -> UIFont? {
        let capHeight = InkGlyphs.clampedSize(rawCapHeight)
        guard let unit = UIFont(name: fontPostScriptName, size: 100), unit.capHeight > 0 else {
            return nil
        }
        return UIFont(name: fontPostScriptName, size: capHeight * 100 / unit.capHeight)
    }

    static func bounds(for element: InkTextElement) -> CGRect {
        layout(element).bounds
    }

    /// Filled Shantell Sans outlines in the board's y-down coordinate system.
    static func path(for element: InkTextElement) -> CGPath? {
        layout(element).path
    }

    /// Color emoji have bitmap glyphs and therefore no path for
    /// `CTFontCreatePathForGlyph` to return. They are the only second pass;
    /// ordinary letters, fallback scripts and symbols stay vector outlines.
    static func drawPictographs(of element: InkTextElement, in context: CGContext) {
        for picture in layout(element).pictographs {
            context.saveGState()
            context.textMatrix = .identity
            context.translateBy(x: picture.originX, y: picture.baselineY)
            context.scaleBy(x: 1, y: -1)
            context.textPosition = .zero
            CTLineDraw(picture.line, context)
            context.restoreGState()
        }
    }

    private static func layout(_ element: InkTextElement) -> Layout {
        guard element.x.isFinite, element.y.isFinite,
              let uiFont = uiFont(forCapHeight: element.size)
        else {
            return Layout(path: nil, pictographs: [], bounds: .zero)
        }

        let text = String(element.text.prefix(InkGlyphs.maximumCharacters))
        let lines = explicitLines(in: text)
        let ctFont = CTFontCreateWithName(uiFont.fontName as CFString, uiFont.pointSize, nil)
        let ascent = CTFontGetAscent(ctFont)
        let descent = CTFontGetDescent(ctFont)
        let leading = CTFontGetLeading(ctFont)
        let lineHeight = max(ascent + descent, ascent + descent + leading)

        let outlines = CGMutablePath()
        var pictographs: [PictographRun] = []
        var visibleBounds: CGRect?

        for (lineIndex, textLine) in lines.enumerated() {
            let attributed = NSAttributedString(
                string: textLine,
                attributes: [.font: uiFont]
            )
            let line = CTLineCreateWithAttributedString(attributed)
            let baselineY = element.y + ascent + CGFloat(lineIndex) * lineHeight

            for run in CTLineGetGlyphRuns(line) as! [CTRun] {
                guard let fontValue = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName]
                else { continue }
                let runFont = fontValue as! CTFont

                let count = CTRunGetGlyphCount(run)
                guard count > 0 else { continue }
                var glyphs = [CGGlyph](repeating: 0, count: count)
                var positions = [CGPoint](repeating: .zero, count: count)
                CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
                CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)

                if isColorEmoji(runFont) {
                    let range = CTRunGetStringRange(run)
                    if range.location != kCFNotFound, range.length > 0 {
                        let substring = attributed.attributedSubstring(
                            from: NSRange(location: range.location, length: range.length)
                        )
                        let runLine = CTLineCreateWithAttributedString(substring)
                        let offset = positions.map(\.x).min() ?? 0
                        pictographs.append(PictographRun(
                            line: runLine,
                            originX: element.x + offset,
                            baselineY: baselineY
                        ))
                    }
                }

                for index in 0..<count {
                    let glyph = glyphs[index]
                    let position = positions[index]
                    if let glyphPath = CTFontCreatePathForGlyph(runFont, glyph, nil) {
                        let transform = CGAffineTransform(
                            a: 1, b: 0, c: 0, d: -1,
                            tx: element.x + position.x,
                            ty: baselineY
                        )
                        outlines.addPath(glyphPath, transform: transform)
                        let box = glyphPath.boundingBoxOfPath.applying(transform)
                        if !box.isNull, !box.isEmpty {
                            visibleBounds = visibleBounds?.union(box) ?? box
                        }
                    } else if isColorEmoji(runFont) {
                        var oneGlyph = glyph
                        let box = CTFontGetBoundingRectsForGlyphs(
                            runFont, .default, &oneGlyph, nil, 1
                        )
                        let boardBox = CGRect(
                            x: element.x + position.x + box.minX,
                            y: baselineY - box.maxY,
                            width: box.width,
                            height: box.height
                        )
                        if !boardBox.isNull, !boardBox.isEmpty {
                            visibleBounds = visibleBounds?.union(boardBox) ?? boardBox
                        }
                    }
                }
            }
        }

        guard let visibleBounds else {
            return Layout(path: nil, pictographs: pictographs, bounds: .zero)
        }
        let padding = InkGlyphs.clampedSize(element.size) * inkPadding
        return Layout(
            path: outlines.isEmpty ? nil : outlines,
            pictographs: pictographs,
            bounds: visibleBounds.insetBy(dx: -padding, dy: -padding)
        )
    }

    private static func explicitLines(in text: String) -> [String] {
        var result: [String] = []
        var current = ""
        for character in text {
            if character.isNewline {
                result.append(current)
                current = ""
            } else {
                current.append(character)
            }
        }
        result.append(current)
        return result
    }

    private static func isColorEmoji(_ font: CTFont) -> Bool {
        let name = CTFontCopyPostScriptName(font) as String
        return name.localizedCaseInsensitiveContains("AppleColorEmoji")
    }
}
