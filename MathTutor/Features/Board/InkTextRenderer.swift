import CoreGraphics
import Foundation
import OSLog

/// The `ink_text` element, turned into ink.
///
/// The kind is deliberately **synchronous**. Its siblings that produce a bitmap
/// — `math_text`, `image`, `svg` — each own a store, an async render and a
/// `.boardSceneArtifactReady` notification, because a typesetter, a network
/// fetch and an SVG parser all take time the draw pass does not have. A glyph
/// table does not: the letterforms are compiled into the app, so laying a
/// string out and building its outline is arithmetic. There is nothing to wait
/// for, so this kind has no store, reports real bounds from the moment it
/// arrives, and draws on the first pass.
///
/// ## What makes it read as ink rather than as a plotter
///
/// Three things, in order of how much they matter:
///
/// 1. **The taper.** A stroked polyline has one width everywhere, which is
///    exactly what a pen does not do. Each centreline is given a filled
///    outline whose half-width follows the stroke: `endTaper` of full width at
///    the two tips, full width through the middle, with a slow pressure
///    modulation on top. That single change is most of the difference between
///    "handwriting" and "engineering stencil".
/// 2. **The smoothing.** The glyph table stores polylines; the corners are
///    rounded by the same quadratic-through-midpoints scheme the `freehand`
///    arm uses, so a hand-authored corner comes out as a hand's corner.
/// 3. **The jitter.** Each character is nudged and turned by a hair. It is
///    seeded from the element id and the character's index — never from a
///    random generator — so the same element draws the same pixels forever,
///    which is what keeps a board capture comparable with the one before it.
enum InkTextRenderer {

    /// The widest the pen ever gets, as a fraction of the cap height. A pen
    /// nib is roughly a fourteenth of a capital's height; wider fills in the
    /// counters of `a`, `e` and `8` at small sizes.
    static let maximumPenWidth: CGFloat = 1.0 / 14

    /// The width at a stroke's two tips, as a fraction of the widest. Not
    /// zero: a stroke that vanishes to a point reads as a leaf rather than as
    /// a pen leaving the paper.
    static let endTaper: CGFloat = 0.4

    /// How far a character is nudged, as a fraction of the cap height, on each
    /// axis independently.
    static let jitter: CGFloat = 0.02

    /// How far a character is turned, in degrees. Small enough to read as a
    /// hand rather than as a mistake.
    static let jitterRotation: CGFloat = 1.5

    /// How much the pen's pressure wanders along one stroke, as a fraction of
    /// the widest width.
    static let pressureDepth: CGFloat = 0.1

    /// What the metric box has to grow by to contain the ink, as a fraction of
    /// the cap height.
    ///
    /// Three terms, and this is the sum of their worst cases rounded up: half
    /// the widest pen (`maximumPenWidth / 2` = 0.036), the jitter's reach on
    /// one axis (`jitter` = 0.02), and how far `jitterRotation` can carry a
    /// point at the far corner of a glyph box (about 0.019). A glyph's own
    /// strokes never leave its declared box — `InkTextTests` sweeps the whole
    /// table to prove it — so those three are the only things that put ink
    /// outside the layout.
    static let inkPadding: CGFloat = 0.09

    /// The rectangle the ink occupies, in board points, or `.zero` when the
    /// element has nothing to draw.
    ///
    /// `.zero` for an empty string, for a string of nothing but spaces and
    /// line breaks, and for coordinates that are not finite. That is the same
    /// answer `math_text` gives before its artifact lands and an unparseable
    /// `path` gives forever: the scene union drops it, and
    /// `BoardSceneLayerView.isMountable` refuses to mount it.
    static func bounds(for element: InkTextElement) -> CGRect {
        guard element.x.isFinite, element.y.isFinite else { return .zero }
        let size = InkGlyphs.clampedSize(element.size)
        let layout = InkGlyphs.layout(text: element.text, size: size)
        guard !layout.isEmpty else { return .zero }
        let padding = size * inkPadding
        return CGRect(
            x: element.x - padding,
            y: element.y - padding,
            width: layout.size.width + padding * 2,
            height: layout.size.height + padding * 2
        )
    }

    /// The filled outline of every stroke of every glyph, in board points.
    ///
    /// One path for the whole element, filled with the winding rule. Every
    /// outline is built in the same direction — the left side forward, the far
    /// cap, the right side backward, the near cap — so two strokes that cross
    /// (the two arms of an `x`, the slash through a `%`) reinforce each other
    /// instead of cancelling into a hole, and so does an outline that folds
    /// over itself at a tight corner.
    static func path(for element: InkTextElement) -> CGPath? {
        guard element.x.isFinite, element.y.isFinite else { return nil }
        let size = InkGlyphs.clampedSize(element.size)
        let layout = InkGlyphs.layout(text: element.text, size: size)
        guard !layout.isEmpty else { return nil }
        reportUnsupported(layout.unsupported)

        let halfWidth = size * maximumPenWidth / 2
        let path = CGMutablePath()
        for placement in layout.placements {
            let hand = Hand(id: element.id, index: placement.index, size: size)
            // The glyph turns about its own middle, so the nudge and the turn
            // stay independent: a rotation about a corner would move the glyph
            // as well as turn it.
            let centre = CGPoint(
                x: placement.origin.x + placement.glyph.advance * size / 2,
                y: placement.origin.y + size / 2
            )
            let transform = CGAffineTransform(
                translationX: element.x + hand.dx,
                y: element.y + hand.dy
            )
            .translatedBy(x: centre.x, y: centre.y)
            .rotated(by: hand.rotation)
            .translatedBy(x: -centre.x, y: -centre.y)

            for stroke in placement.glyph.strokes {
                let drawn = stroke.map { unit in
                    CGPoint(
                        x: placement.origin.x + unit.x * size,
                        y: placement.origin.y + unit.y * size
                    ).applying(transform)
                }
                append(
                    outlineOf: centreline(drawn, cornerRadius: cornerRadius * size),
                    halfWidth: halfWidth,
                    phase: hand.phase,
                    to: path
                )
            }
        }
        return path.isEmpty ? nil : path
    }

    // MARK: - The hand

    /// One character's share of the deterministic wobble.
    ///
    /// Seeded from the element id and the character's own index, hashed with
    /// FNV-1a. Never `SystemRandomNumberGenerator`: two renders of one element
    /// have to be the same pixels, or every board capture differs from the one
    /// before it for reasons that have nothing to do with what the tutor wrote.
    private struct Hand {
        let dx: CGFloat
        let dy: CGFloat
        /// Radians, clockwise in the board's y-down space.
        let rotation: CGFloat
        /// Where along the pressure wave this character's strokes start.
        let phase: CGFloat

        init(id: String, index: Int, size: CGFloat) {
            dx = InkTextRenderer.signedUnit(id, index &* 4)
                * InkTextRenderer.jitter * size
            dy = InkTextRenderer.signedUnit(id, index &* 4 &+ 1)
                * InkTextRenderer.jitter * size
            rotation = InkTextRenderer.signedUnit(id, index &* 4 &+ 2)
                * InkTextRenderer.jitterRotation * .pi / 180
            phase = InkTextRenderer.signedUnit(id, index &* 4 &+ 3) * .pi
        }
    }

    /// FNV-1a over the element id and one salt.
    private static func hash(_ id: String, _ salt: Int) -> UInt64 {
        let prime: UInt64 = 0x0000_0100_0000_01b3
        var value: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in id.utf8 {
            value = (value ^ UInt64(byte)) &* prime
        }
        var remaining = UInt64(bitPattern: Int64(salt))
        for _ in 0..<8 {
            value = (value ^ (remaining & 0xff)) &* prime
            remaining >>= 8
        }
        return value
    }

    /// A deterministic value in `-1...1`, from the top 53 bits of the hash.
    private static func signedUnit(_ id: String, _ salt: Int) -> CGFloat {
        let bits = hash(id, salt) >> 11
        return CGFloat(Double(bits) / Double(1 << 53) * 2 - 1)
    }

    /// How wide the pen is at `position` along a stroke, as a fraction of the
    /// widest it gets.
    ///
    /// `sin` raised to a power below one is the shape that matters: it holds
    /// the pen near full width across the body of the stroke and spends the
    /// taper in the last fraction at each end, which is what a nib does. The
    /// plain sine tapers everywhere at once and comes out as a lens.
    private static func pressure(at position: CGFloat, phase: CGFloat) -> CGFloat {
        // `sin` can return a hair below zero at the ends; a fractional power of
        // a negative number is `nan`, and a `nan` coordinate traps in Core
        // Animation, so the clamp is load-bearing rather than tidy.
        let arch = pow(max(0, sin(.pi * position)), 0.55)
        let wander = 1 + pressureDepth * sin(position * 4.7 + phase)
        return max(0.25, (endTaper + (1 - endTaper) * arch) * wander)
    }

    // MARK: - Geometry

    /// How far back from a vertex the pen starts to turn, in cap heights.
    ///
    /// This is the one number that decides whether the writing looks like a
    /// hand or like a machine, and it is why the `freehand` arm's smoothing is
    /// not reused verbatim. That scheme runs a quadratic through the *midpoint*
    /// of every segment, which is a constant-*fraction* rounding: it is right
    /// for a sampled finger path, where the vertices are dense and none of them
    /// is meant, and wrong for a letter, where the vertices are few and every
    /// one of them is meant. Under it the apex of an `A` — one vertex between
    /// two full-height strokes — is pulled a quarter of the way down the
    /// letter, and `M`, `V`, `W`, `Z`, `4`, `7` and the radical sign all lose
    /// their corners the same way.
    ///
    /// A constant *distance* fixes both cases with one rule. On a curve, where
    /// the authored points are a tenth of a cap height apart, the cut is capped
    /// by the segments themselves and the result is the midpoint scheme again —
    /// smooth. On a corner between two long strokes it is this radius and no
    /// more, so the corner stays where it was authored and merely stops being
    /// infinitely sharp, which is exactly what a pen does.
    static let cornerRadius: CGFloat = 0.09

    /// The glyph's polyline, with its corners rounded, resampled into points.
    ///
    /// The outline needs samples and tangents, which a `CGPath` will not give
    /// back, so the shape is evaluated here rather than drawn.
    static func centreline(_ points: [CGPoint], cornerRadius radius: CGFloat) -> [CGPoint] {
        guard let first = points.first else { return [] }
        guard points.count > 1 else { return [first] }
        var samples: [CGPoint] = [first]
        guard points.count > 2 else {
            append(lineFrom: first, to: points[1], into: &samples)
            return samples
        }
        var current = first
        for index in 1..<(points.count - 1) {
            let vertex = points[index]
            let (incoming, incomingLength) = direction(from: points[index - 1], to: vertex)
            let (outgoing, outgoingLength) = direction(from: vertex, to: points[index + 1])
            // Never more than a segment can spare on either side, or two
            // neighbouring corners would eat each other.
            let cut = min(radius, incomingLength * 0.45, outgoingLength * 0.45)
            let start = CGPoint(x: vertex.x - incoming.x * cut, y: vertex.y - incoming.y * cut)
            let end = CGPoint(x: vertex.x + outgoing.x * cut, y: vertex.y + outgoing.y * cut)
            append(lineFrom: current, to: start, into: &samples)
            append(quadFrom: start, control: vertex, to: end, into: &samples)
            current = end
        }
        append(lineFrom: current, to: points[points.count - 1], into: &samples)
        return samples
    }

    private static func direction(from start: CGPoint, to end: CGPoint) -> (CGPoint, CGFloat) {
        let delta = CGPoint(x: end.x - start.x, y: end.y - start.y)
        let length = hypot(delta.x, delta.y)
        guard length > 1e-9 else { return (.zero, 0) }
        return (CGPoint(x: delta.x / length, y: delta.y / length), length)
    }

    private static func append(
        quadFrom start: CGPoint,
        control: CGPoint,
        to end: CGPoint,
        into samples: inout [CGPoint]
    ) {
        let span = hypot(control.x - start.x, control.y - start.y)
            + hypot(end.x - control.x, end.y - control.y)
        guard span > 1e-9 else { return }
        let steps = min(16, max(3, Int(span / 1.5)))
        for step in 1...steps {
            let t = CGFloat(step) / CGFloat(steps)
            let u = 1 - t
            samples.append(CGPoint(
                x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
                y: u * u * start.y + 2 * u * t * control.y + t * t * end.y
            ))
        }
    }

    private static func append(lineFrom start: CGPoint, to end: CGPoint, into samples: inout [CGPoint]) {
        let steps = min(24, max(2, Int(hypot(end.x - start.x, end.y - start.y) / 1.5)))
        for step in 1...steps {
            let t = CGFloat(step) / CGFloat(steps)
            samples.append(CGPoint(
                x: start.x + (end.x - start.x) * t,
                y: start.y + (end.y - start.y) * t
            ))
        }
    }

    /// How many segments a round cap is drawn with.
    private static let capSegments = 8

    /// Adds one stroke's tapered body to `path`, as a single closed subpath.
    private static func append(
        outlineOf samples: [CGPoint],
        halfWidth: CGFloat,
        phase: CGFloat,
        to path: CGMutablePath
    ) {
        let points = deduplicated(samples)
        guard let first = points.first, halfWidth > 0 else { return }
        guard points.count > 1 else {
            appendDot(at: first, radius: halfWidth, to: path)
            return
        }

        var travelled: [CGFloat] = [0]
        travelled.reserveCapacity(points.count)
        for index in 1..<points.count {
            let step = hypot(
                points[index].x - points[index - 1].x,
                points[index].y - points[index - 1].y
            )
            travelled.append(travelled[index - 1] + step)
        }
        let total = travelled[points.count - 1]
        // A stroke no longer than the pen is wide is a dot — the tittle of an
        // `i`, a full stop, the two dots of a division sign. Tapering one
        // leaves a lens where a round mark belongs, so it keeps full width and
        // the two caps close into a circle.
        let isDot = total <= halfWidth * 1.6

        var tangents: [CGPoint] = []
        var widths: [CGFloat] = []
        tangents.reserveCapacity(points.count)
        widths.reserveCapacity(points.count)
        for index in points.indices {
            let previous = points[max(0, index - 1)]
            let next = points[min(points.count - 1, index + 1)]
            let delta = CGPoint(x: next.x - previous.x, y: next.y - previous.y)
            let length = hypot(delta.x, delta.y)
            tangents.append(
                length > 1e-9
                    ? CGPoint(x: delta.x / length, y: delta.y / length)
                    : CGPoint(x: 1, y: 0)
            )
            let position = total > 0 ? travelled[index] / total : 0
            widths.append(isDot ? halfWidth : halfWidth * pressure(at: position, phase: phase))
        }

        func normal(_ index: Int) -> CGPoint {
            CGPoint(x: -tangents[index].y, y: tangents[index].x)
        }
        func side(_ index: Int, _ sign: CGFloat) -> CGPoint {
            let offset = normal(index)
            return CGPoint(
                x: points[index].x + offset.x * widths[index] * sign,
                y: points[index].y + offset.y * widths[index] * sign
            )
        }

        let last = points.count - 1
        path.move(to: side(0, 1))
        for index in 1...last {
            path.addLine(to: side(index, 1))
        }
        appendCap(
            around: points[last],
            normal: normal(last),
            tangent: tangents[last],
            radius: widths[last],
            forward: true,
            to: path
        )
        path.addLine(to: side(last, -1))
        for index in stride(from: last - 1, through: 0, by: -1) {
            path.addLine(to: side(index, -1))
        }
        appendCap(
            around: points[0],
            normal: normal(0),
            tangent: tangents[0],
            radius: widths[0],
            forward: false,
            to: path
        )
        path.closeSubpath()
    }

    /// Half a circle, from one side of the stroke to the other, around the
    /// point the stroke ends at.
    ///
    /// Written as samples rather than as `addArc` on purpose: the sweep has to
    /// leave from the side the outline just walked and arrive at the side it is
    /// about to walk back along, and that is a statement about the stroke's own
    /// normal, not about the clockwise sense of the current transform.
    private static func appendCap(
        around point: CGPoint,
        normal: CGPoint,
        tangent: CGPoint,
        radius: CGFloat,
        forward: Bool,
        to path: CGMutablePath
    ) {
        let sign: CGFloat = forward ? 1 : -1
        for step in 1..<capSegments {
            let angle = CGFloat(step) / CGFloat(capSegments) * .pi
            path.addLine(to: CGPoint(
                x: point.x + radius * (cos(angle) * normal.x + sin(angle) * tangent.x) * sign,
                y: point.y + radius * (cos(angle) * normal.y + sin(angle) * tangent.y) * sign
            ))
        }
    }

    /// A round mark, built out of the same two caps so that its winding matches
    /// every other subpath in the element.
    private static func appendDot(at point: CGPoint, radius: CGFloat, to path: CGMutablePath) {
        let normal = CGPoint(x: 0, y: 1)
        let tangent = CGPoint(x: 1, y: 0)
        path.move(to: CGPoint(x: point.x, y: point.y + radius))
        appendCap(around: point, normal: normal, tangent: tangent, radius: radius, forward: true, to: path)
        path.addLine(to: CGPoint(x: point.x, y: point.y - radius))
        appendCap(around: point, normal: normal, tangent: tangent, radius: radius, forward: false, to: path)
        path.closeSubpath()
    }

    /// Drops samples that land on the one before them. Two identical points
    /// give a zero-length tangent, and a zero-length tangent gives a normal
    /// that cannot offset anything.
    private static func deduplicated(_ points: [CGPoint]) -> [CGPoint] {
        var result: [CGPoint] = []
        result.reserveCapacity(points.count)
        for point in points {
            if let previous = result.last,
               abs(previous.x - point.x) < 1e-6, abs(previous.y - point.y) < 1e-6 {
                continue
            }
            result.append(point)
        }
        return result
    }

    // MARK: - Characters this build cannot write

    /// The codepoints, and nothing else.
    ///
    /// It is the same trade `BoardScene` makes when it skips an element of a
    /// kind this build does not know: the skip has to say so once, naming the
    /// one thing a fix needs. Here that is which glyph is missing from the
    /// table. A bare codepoint carries no sentence, no name and no working, so
    /// `.public` — an interpolation left private records nothing at all on
    /// device, which would make the log useless for the only job it has.
    private static let logger = Logger(subsystem: "com.nordup.MathTutor", category: "ink-text")

    private static func reportUnsupported(_ scalars: [UInt32]) {
        guard !scalars.isEmpty else { return }
        let names = scalars.map { String(format: "U+%04X", $0) }.joined(separator: " ")
        logger.error("ink_text has no glyph for \(names, privacy: .public); drew the placeholder")
    }
}
