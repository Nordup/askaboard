import CoreGraphics
import Foundation
import SwiftUI

/// Turns an SVG path `d` attribute into a SwiftUI `Path`.
///
/// The icon set is checked in as the design's own verbatim `d` strings — see
/// `design/icons.json` — so that the code can be diffed directly against the Paper
/// file rather than against someone's retyping of it. That choice concentrates all
/// of the risk here: a mis-parsed arc is not a subtle regression, it is a visibly
/// wrong glyph. So this stays a pure value transform with no view attached, which
/// makes the riskiest code in the icon system also the easiest to test.
///
/// Every command the icon set uses is supported in both absolute and relative
/// form: `M m L l H h V v C c S s Q q T t A a Z z`.
enum SVGPath {
    /// The parsed path, or an empty path when `d` is malformed.
    ///
    /// Malformed data yields nothing rather than a trap. This is called from a view
    /// body, where a crash would be the one outcome the caller could do nothing
    /// about; a typo in a design export should cost one missing glyph instead.
    static func path(from d: String) -> Path {
        (try? parsed(d)) ?? Path()
    }

    /// The same parse, but reporting why it failed.
    ///
    /// Kept separate so tests — and anyone diagnosing a bad export — can see the
    /// reason instead of an empty path that could mean anything.
    static func parsed(_ d: String) throws -> Path {
        var scanner = Scanner(source: Array(d.utf8))
        var builder = Builder()

        guard let first = scanner.takeCommand() else {
            // An empty `d` is a legal SVG no-op; anything else that opens with a
            // non-command is a typo.
            guard scanner.isAtEnd else { throw ParseError.unexpectedCharacter }
            return Path()
        }
        guard first == .moveToAbsolute || first == .moveToRelative else {
            throw ParseError.missingInitialMoveTo
        }

        var command: Command? = first
        while let active = command {
            try run(active, with: &scanner, into: &builder)
            command = scanner.takeCommand()
        }
        guard scanner.isAtEnd else { throw ParseError.unexpectedCharacter }
        return builder.path
    }

    enum ParseError: Error, Equatable {
        case missingInitialMoveTo
        case unexpectedCharacter
        case expectedNumber
        case expectedFlag
    }

    // MARK: - Commands

    /// One argument set of one command. The loop repeats while more numbers follow,
    /// which is how SVG's implicit repetition works: `M 0 0 1 1 2 2` is a moveto
    /// followed by two linetos, and every other command simply repeats itself.
    private static func run(
        _ command: Command,
        with scanner: inout Scanner,
        into builder: inout Builder
    ) throws {
        if command == .closePath {
            builder.close()
            return
        }

        var isFirstSet = true
        repeat {
            switch command {
            case .moveToAbsolute, .moveToRelative:
                let point = try scanner.point(relativeTo: command.isRelative ? builder.current : .zero)
                // Only the first pair of a moveto actually moves; the rest are
                // linetos, and they inherit the moveto's absolute/relative sense.
                if isFirstSet {
                    builder.move(to: point)
                } else {
                    builder.line(to: point)
                }

            case .lineToAbsolute, .lineToRelative:
                builder.line(to: try scanner.point(relativeTo: command.isRelative ? builder.current : .zero))

            case .horizontalAbsolute:
                builder.line(to: CGPoint(x: try scanner.number(), y: builder.current.y))

            case .horizontalRelative:
                builder.line(to: CGPoint(x: builder.current.x + (try scanner.number()), y: builder.current.y))

            case .verticalAbsolute:
                builder.line(to: CGPoint(x: builder.current.x, y: try scanner.number()))

            case .verticalRelative:
                builder.line(to: CGPoint(x: builder.current.x, y: builder.current.y + (try scanner.number())))

            case .cubicAbsolute, .cubicRelative:
                let origin = command.isRelative ? builder.current : .zero
                let control1 = try scanner.point(relativeTo: origin)
                let control2 = try scanner.point(relativeTo: origin)
                let end = try scanner.point(relativeTo: origin)
                builder.curve(to: end, control1: control1, control2: control2)

            case .smoothCubicAbsolute, .smoothCubicRelative:
                let origin = command.isRelative ? builder.current : .zero
                let control2 = try scanner.point(relativeTo: origin)
                let end = try scanner.point(relativeTo: origin)
                builder.curve(to: end, control1: builder.reflectedCubicControl, control2: control2)

            case .quadraticAbsolute, .quadraticRelative:
                let origin = command.isRelative ? builder.current : .zero
                let control = try scanner.point(relativeTo: origin)
                let end = try scanner.point(relativeTo: origin)
                builder.quadCurve(to: end, control: control)

            case .smoothQuadraticAbsolute, .smoothQuadraticRelative:
                let end = try scanner.point(relativeTo: command.isRelative ? builder.current : .zero)
                builder.quadCurve(to: end, control: builder.reflectedQuadControl)

            case .arcAbsolute, .arcRelative:
                let radiusX = try scanner.number()
                let radiusY = try scanner.number()
                let rotation = try scanner.number()
                // The flags are single characters, not numbers: `0 0 1-.88-.88`
                // is flag, flag, x, y — reading them as numbers would swallow the
                // `1` of a `11.5` that followed one.
                let largeArc = try scanner.flag()
                let sweep = try scanner.flag()
                let end = try scanner.point(relativeTo: command.isRelative ? builder.current : .zero)
                builder.arc(
                    to: end,
                    radiusX: radiusX,
                    radiusY: radiusY,
                    rotationDegrees: rotation,
                    largeArc: largeArc,
                    sweep: sweep
                )

            case .closePath:
                break
            }
            builder.finish(command)
            isFirstSet = false
        } while scanner.startsNumber()
    }

    private enum Command: UInt8 {
        case moveToAbsolute = 0x4D            // M
        case moveToRelative = 0x6D            // m
        case lineToAbsolute = 0x4C            // L
        case lineToRelative = 0x6C            // l
        case horizontalAbsolute = 0x48        // H
        case horizontalRelative = 0x68        // h
        case verticalAbsolute = 0x56          // V
        case verticalRelative = 0x76          // v
        case cubicAbsolute = 0x43             // C
        case cubicRelative = 0x63             // c
        case smoothCubicAbsolute = 0x53       // S
        case smoothCubicRelative = 0x73       // s
        case quadraticAbsolute = 0x51         // Q
        case quadraticRelative = 0x71         // q
        case smoothQuadraticAbsolute = 0x54   // T
        case smoothQuadraticRelative = 0x74   // t
        case arcAbsolute = 0x41               // A
        case arcRelative = 0x61               // a
        case closePath = 0x5A                 // Z

        init?(byte: UInt8) {
            // `z` and `Z` are the same command; every other pair differs only in
            // absolute vs relative, which the raw value already encodes.
            self.init(rawValue: byte == 0x7A ? 0x5A : byte)
        }

        var isRelative: Bool { rawValue >= 0x61 }
    }

    // MARK: - Building

    /// Accumulates the path and the state SVG's stateful commands need: where we
    /// are, where the current subpath began, and the control points that `S` and
    /// `T` reflect.
    private struct Builder {
        private(set) var path = Path()
        private(set) var current = CGPoint.zero

        private var subpathStart = CGPoint.zero
        private var cubicControl: CGPoint?
        private var quadControl: CGPoint?
        /// A close leaves the current point at the subpath's start but ends the
        /// subpath, so anything drawn next needs its own `move` first.
        private var needsMove = true

        /// The reflection of the previous cubic's second control point — but only
        /// when the previous command actually was a cubic. After anything else the
        /// spec says the control point coincides with the current point, and
        /// reflecting a stale one is the classic way to bend a glyph.
        var reflectedCubicControl: CGPoint { reflect(cubicControl) }

        /// The same rule for quadratics.
        var reflectedQuadControl: CGPoint { reflect(quadControl) }

        private func reflect(_ control: CGPoint?) -> CGPoint {
            guard let control else { return current }
            return CGPoint(x: 2 * current.x - control.x, y: 2 * current.y - control.y)
        }

        mutating func move(to point: CGPoint) {
            path.move(to: point)
            current = point
            subpathStart = point
            needsMove = false
        }

        mutating func line(to point: CGPoint) {
            ensureOpen()
            path.addLine(to: point)
            current = point
        }

        mutating func curve(to end: CGPoint, control1: CGPoint, control2: CGPoint) {
            ensureOpen()
            path.addCurve(to: end, control1: control1, control2: control2)
            current = end
            cubicControl = control2
        }

        mutating func quadCurve(to end: CGPoint, control: CGPoint) {
            ensureOpen()
            path.addQuadCurve(to: end, control: control)
            current = end
            quadControl = control
        }

        mutating func arc(
            to end: CGPoint,
            radiusX: CGFloat,
            radiusY: CGFloat,
            rotationDegrees: CGFloat,
            largeArc: Bool,
            sweep: Bool
        ) {
            ensureOpen()
            EllipticalArc(
                start: current,
                end: end,
                radiusX: radiusX,
                radiusY: radiusY,
                rotationDegrees: rotationDegrees,
                largeArc: largeArc,
                sweep: sweep
            ).append(to: &path)
            current = end
        }

        mutating func close() {
            guard !needsMove else { return }
            path.closeSubpath()
            current = subpathStart
            needsMove = true
            cubicControl = nil
            quadControl = nil
        }

        /// Clears the reflection state that `command` does not produce. Called
        /// after every argument set, so a `C` followed by an `L` followed by an `S`
        /// reflects nothing — which is exactly what the spec asks for.
        mutating func finish(_ command: Command) {
            switch command {
            case .cubicAbsolute, .cubicRelative, .smoothCubicAbsolute, .smoothCubicRelative:
                quadControl = nil
            case .quadraticAbsolute, .quadraticRelative, .smoothQuadraticAbsolute, .smoothQuadraticRelative:
                cubicControl = nil
            default:
                cubicControl = nil
                quadControl = nil
            }
        }

        private mutating func ensureOpen() {
            guard needsMove else { return }
            path.move(to: current)
            needsMove = false
        }
    }

    // MARK: - Scanning

    /// A byte scanner over the `d` string. Path data is ASCII by definition, so
    /// bytes are enough and they make the awkward rules — a number that ends
    /// because a `-` starts the next one — straightforward to express.
    private struct Scanner {
        let source: [UInt8]
        private var index = 0

        init(source: [UInt8]) { self.source = source }

        var isAtEnd: Bool { index >= source.count }

        mutating func takeCommand() -> Command? {
            skipSeparators()
            guard index < source.count, let command = Command(byte: source[index]) else { return nil }
            index += 1
            return command
        }

        /// Whether another argument set follows — the test for implicit repetition.
        mutating func startsNumber() -> Bool {
            skipSeparators()
            guard index < source.count else { return false }
            let byte = source[index]
            return byte == .plus || byte == .minus || byte == .dot || byte.isDigit
        }

        mutating func point(relativeTo origin: CGPoint) throws -> CGPoint {
            let x = try number()
            let y = try number()
            return CGPoint(x: origin.x + x, y: origin.y + y)
        }

        mutating func number() throws -> CGFloat {
            skipSeparators()
            let start = index

            if index < source.count, source[index] == .plus || source[index] == .minus { index += 1 }
            var digits = 0
            while index < source.count, source[index].isDigit { index += 1; digits += 1 }
            // Exactly one decimal point per number, which is what makes `.72.72`
            // two numbers rather than one malformed one.
            if index < source.count, source[index] == .dot {
                index += 1
                while index < source.count, source[index].isDigit { index += 1; digits += 1 }
            }
            guard digits > 0 else { throw ParseError.expectedNumber }

            // An `e` only belongs to this number if digits actually follow it.
            if index < source.count, source[index] == .lowerE || source[index] == .upperE {
                var lookahead = index + 1
                if lookahead < source.count, source[lookahead] == .plus || source[lookahead] == .minus {
                    lookahead += 1
                }
                if lookahead < source.count, source[lookahead].isDigit {
                    index = lookahead
                    while index < source.count, source[index].isDigit { index += 1 }
                }
            }

            var text = source[start..<index]
            // `Double("5.")` is nil, while SVG considers a trailing point legal.
            if text.last == .dot { text = text.dropLast() }
            guard let value = Double(String(decoding: text, as: UTF8.self)) else {
                throw ParseError.expectedNumber
            }
            return CGFloat(value)
        }

        /// An arc flag: a single `0` or `1`, never a wider number.
        mutating func flag() throws -> Bool {
            skipSeparators()
            guard index < source.count else { throw ParseError.expectedFlag }
            switch source[index] {
            case .digit0: index += 1; return false
            case .digit1: index += 1; return true
            default: throw ParseError.expectedFlag
            }
        }

        private mutating func skipSeparators() {
            while index < source.count, source[index] == .comma || source[index] <= 0x20 {
                index += 1
            }
        }
    }
}

// MARK: - Elliptical arc

/// One SVG elliptical arc segment, converted from the endpoint parameterisation the
/// `d` string uses to the centre parameterisation geometry needs.
///
/// This is SVG 1.1 appendix F.6 implemented as written, including the out-of-range
/// radius correction, because the icon set genuinely leans on the edges of it:
/// `composer/voice` asks for a chord of exactly `2r` twice, and `chip/exercise`'s
/// pencil arc is a hair inside one. Approximating by eye — a quadratic through the
/// midpoint, say — is visibly wrong on a 24pt glyph.
private struct EllipticalArc {
    let start: CGPoint
    let end: CGPoint
    let radiusX: CGFloat
    let radiusY: CGFloat
    let rotationDegrees: CGFloat
    let largeArc: Bool
    let sweep: Bool

    func append(to path: inout Path) {
        // F.6.2: identical endpoints mean the segment is omitted entirely, and a
        // zero radius degenerates to a straight line.
        guard start != end else { return }
        let rx0 = abs(radiusX)
        let ry0 = abs(radiusY)
        guard rx0 > 0, ry0 > 0 else {
            path.addLine(to: end)
            return
        }

        let phi = rotationDegrees * .pi / 180
        let cosPhi = cos(phi)
        let sinPhi = sin(phi)

        // F.6.5.1 — the endpoints in the ellipse's own frame.
        let dx = (start.x - end.x) / 2
        let dy = (start.y - end.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy
        let y1 = -sinPhi * dx + cosPhi * dy

        // F.6.6.2 — radii too small to reach both endpoints are scaled up until
        // they exactly do. Without this the square root below goes imaginary and
        // the segment disappears.
        var rx = rx0
        var ry = ry0
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            let correction = sqrt(lambda)
            rx *= correction
            ry *= correction
        }

        // F.6.5.2 — the centre, in the ellipse's frame. The sign is what the
        // large-arc and sweep flags actually select: they pick which of the two
        // circles through both endpoints, and which way round it, to travel.
        let rxSquared = rx * rx
        let rySquared = ry * ry
        let numerator = max(0, rxSquared * rySquared - rxSquared * y1 * y1 - rySquared * x1 * x1)
        let denominator = rxSquared * y1 * y1 + rySquared * x1 * x1
        let factor = (largeArc == sweep ? -1 : 1) * sqrt(numerator / denominator)
        let cx1 = factor * rx * y1 / ry
        let cy1 = -factor * ry * x1 / rx

        // F.6.5.3 — back to user space.
        let center = CGPoint(
            x: cosPhi * cx1 - sinPhi * cy1 + (start.x + end.x) / 2,
            y: sinPhi * cx1 + cosPhi * cy1 + (start.y + end.y) / 2
        )

        // F.6.5.5 / F.6.5.6 — start angle and swept angle.
        let startVector = CGPoint(x: (x1 - cx1) / rx, y: (y1 - cy1) / ry)
        let endVector = CGPoint(x: (-x1 - cx1) / rx, y: (-y1 - cy1) / ry)
        let startAngle = atan2(startVector.y, startVector.x)
        var delta = atan2(endVector.y, endVector.x) - startAngle
        if !sweep, delta > 0 {
            delta -= 2 * .pi
        } else if sweep, delta < 0 {
            delta += 2 * .pi
        }

        // A cubic can only follow a circular arc so far before the error shows.
        // Capping each segment at 90° keeps the radial error near one part in
        // 10,000 of the radius — invisible at any size a glyph is drawn.
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        // The classic tangent-matching magic number: it makes the cubic touch the
        // ellipse at both ends with the right slope, not merely pass near it.
        let alpha = 4.0 / 3.0 * tan(step / 4)

        var angle = startAngle
        for _ in 0..<segments {
            let next = angle + step
            let from = point(at: angle, center: center, rx: rx, ry: ry, cosPhi: cosPhi, sinPhi: sinPhi)
            let to = point(at: next, center: center, rx: rx, ry: ry, cosPhi: cosPhi, sinPhi: sinPhi)
            let fromSlope = derivative(at: angle, rx: rx, ry: ry, cosPhi: cosPhi, sinPhi: sinPhi)
            let toSlope = derivative(at: next, rx: rx, ry: ry, cosPhi: cosPhi, sinPhi: sinPhi)
            path.addCurve(
                to: to,
                control1: CGPoint(x: from.x + alpha * fromSlope.x, y: from.y + alpha * fromSlope.y),
                control2: CGPoint(x: to.x - alpha * toSlope.x, y: to.y - alpha * toSlope.y)
            )
            angle = next
        }
    }

    private func point(
        at angle: CGFloat,
        center: CGPoint,
        rx: CGFloat,
        ry: CGFloat,
        cosPhi: CGFloat,
        sinPhi: CGFloat
    ) -> CGPoint {
        let x = rx * cos(angle)
        let y = ry * sin(angle)
        return CGPoint(x: center.x + cosPhi * x - sinPhi * y, y: center.y + sinPhi * x + cosPhi * y)
    }

    private func derivative(
        at angle: CGFloat,
        rx: CGFloat,
        ry: CGFloat,
        cosPhi: CGFloat,
        sinPhi: CGFloat
    ) -> CGPoint {
        let x = -rx * sin(angle)
        let y = ry * cos(angle)
        return CGPoint(x: cosPhi * x - sinPhi * y, y: sinPhi * x + cosPhi * y)
    }
}

// MARK: - Byte literals

private extension UInt8 {
    static let comma = UInt8(ascii: ",")
    static let plus = UInt8(ascii: "+")
    static let minus = UInt8(ascii: "-")
    static let dot = UInt8(ascii: ".")
    // Not `zero`/`one`: UInt8 already has an `AdditiveArithmetic.zero`, and
    // shadowing it here would be a trap for whoever reads this next.
    static let digit0 = UInt8(ascii: "0")
    static let digit1 = UInt8(ascii: "1")
    static let digit9 = UInt8(ascii: "9")
    static let lowerE = UInt8(ascii: "e")
    static let upperE = UInt8(ascii: "E")

    var isDigit: Bool { self >= .digit0 && self <= .digit9 }
}
