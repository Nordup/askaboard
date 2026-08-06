import CoreGraphics
import SwiftUI
import XCTest
@testable import MathTutor

/// The parser is the one place in the icon system where a bug is silent: a wrong
/// arc still draws *something*, and nobody notices until a glyph looks off on a
/// device. So it is tested against arithmetic that can be checked by hand rather
/// than against a snapshot of its own output.
final class SVGPathTests: XCTestCase {
    /// The tight box around the drawn curve, not around its control points.
    ///
    /// The distinction matters everywhere a Bézier is involved: the control points
    /// of an arc approximation sit well outside the arc, so the loose box would
    /// happily accept a wrong curve.
    private func bounds(_ path: Path) -> CGRect { path.cgPath.boundingBoxOfPath }

    private func assertBounds(
        _ path: Path,
        _ expected: CGRect,
        accuracy: CGFloat = 0.0001,
        _ message: String = "",
        line: UInt = #line
    ) {
        let actual = bounds(path)
        XCTAssertEqual(actual.minX, expected.minX, accuracy: accuracy, "minX \(message)", line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: accuracy, "minY \(message)", line: line)
        XCTAssertEqual(actual.width, expected.width, accuracy: accuracy, "width \(message)", line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: accuracy, "height \(message)", line: line)
    }

    /// Every on-curve point the path passes through — the segment joins an arc is
    /// split at, which is where an approximation drifts off its ellipse first.
    private func onCurvePoints(_ path: Path) -> [CGPoint] {
        var points: [CGPoint] = []
        path.forEach { element in
            switch element {
            case .move(let to): points.append(to)
            case .line(let to): points.append(to)
            case .quadCurve(let to, _): points.append(to)
            case .curve(let to, _, _): points.append(to)
            case .closeSubpath: break
            }
        }
        return points
    }

    // MARK: - Straight commands, absolute and relative

    func testMoveAndLineToDrawTheSameSquareAbsoluteOrRelative() {
        let absolute = SVGPath.path(from: "M0 0 L10 0 L10 10 L0 10 Z")
        let relative = SVGPath.path(from: "m0 0 l10 0 l0 10 l-10 0 z")

        assertBounds(absolute, CGRect(x: 0, y: 0, width: 10, height: 10))
        assertBounds(relative, CGRect(x: 0, y: 0, width: 10, height: 10))
        XCTAssertTrue(absolute.cgPath.contains(CGPoint(x: 5, y: 5)))
        XCTAssertFalse(absolute.cgPath.contains(CGPoint(x: 12, y: 5)))
        XCTAssertTrue(relative.cgPath.contains(CGPoint(x: 5, y: 5)))
        XCTAssertFalse(relative.cgPath.contains(CGPoint(x: -0.5, y: 5)))
    }

    func testHorizontalAndVerticalLinesAbsoluteOrRelative() {
        let absolute = SVGPath.path(from: "M2 2 H12 V12 H2 Z")
        let relative = SVGPath.path(from: "m2 2 h10 v10 h-10 z")

        assertBounds(absolute, CGRect(x: 2, y: 2, width: 10, height: 10))
        assertBounds(relative, CGRect(x: 2, y: 2, width: 10, height: 10))
        XCTAssertTrue(relative.cgPath.contains(CGPoint(x: 7, y: 7)))
        XCTAssertFalse(relative.cgPath.contains(CGPoint(x: 1.5, y: 7)))
    }

    /// `tool/center` is four subpaths in one `d`, so a parser that only ever opens
    /// one would quietly draw a single connected zigzag instead.
    func testRepeatedMoveToStartsANewSubpath() {
        let path = SVGPath.path(from: "M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3")

        assertBounds(path, CGRect(x: 1.8, y: 1.8, width: 20.4, height: 20.4))
        XCTAssertEqual(onCurvePoints(path).count, 8, "four subpaths of a move and a line")
    }

    /// A moveto followed by more coordinate pairs continues as a lineto — which is
    /// how `chip/example` opens both of its sparkles.
    func testImplicitLineToAfterMoveTo() {
        let absolute = SVGPath.path(from: "M0 0 10 0 10 10")
        let relative = SVGPath.path(from: "m0 0 10 0 0 10")

        assertBounds(absolute, CGRect(x: 0, y: 0, width: 10, height: 10))
        assertBounds(relative, CGRect(x: 0, y: 0, width: 10, height: 10))
        XCTAssertEqual(onCurvePoints(absolute).count, 3)
    }

    /// After a close, relative commands measure from where the subpath began, not
    /// from where its last segment ended.
    func testClosePathReturnsToTheSubpathStart() {
        let path = SVGPath.path(from: "M5 5 l5 0 l0 5 z l-5 0")

        assertBounds(path, CGRect(x: 0, y: 5, width: 10, height: 5))
    }

    // MARK: - Curves

    func testCubicCurveAbsoluteAndRelative() {
        let absolute = SVGPath.path(from: "M0 0 C0 10 10 10 10 0")
        let relative = SVGPath.path(from: "m0 0 c0 10 10 10 10 0")

        // A symmetric cubic with both controls at y=10 peaks at three quarters of
        // that, so the tight box is 7.5 tall and the loose one would be 10.
        assertBounds(absolute, CGRect(x: 0, y: 0, width: 10, height: 7.5))
        assertBounds(relative, CGRect(x: 0, y: 0, width: 10, height: 7.5))
    }

    func testSmoothCubicReflectsThePreviousControlPoint() {
        let absolute = SVGPath.path(from: "M0 0 C0 10 10 10 10 0 S20 -10 20 0")
        let relative = SVGPath.path(from: "m0 0 c0 10 10 10 10 0 s10-10 10 0")

        // The reflection of (10,10) about (10,0) is (10,-10), so the second curve
        // mirrors the first: 7.5 above the axis and 7.5 below it.
        assertBounds(absolute, CGRect(x: 0, y: -7.5, width: 20, height: 15))
        assertBounds(relative, CGRect(x: 0, y: -7.5, width: 20, height: 15))
    }

    func testQuadraticCurveAbsoluteAndRelative() {
        let absolute = SVGPath.path(from: "M0 0 Q5 10 10 0")
        let relative = SVGPath.path(from: "m0 0 q5 10 10 0")

        assertBounds(absolute, CGRect(x: 0, y: 0, width: 10, height: 5))
        assertBounds(relative, CGRect(x: 0, y: 0, width: 10, height: 5))
    }

    func testSmoothQuadraticReflectsThePreviousControlPoint() {
        let absolute = SVGPath.path(from: "M0 0 Q5 10 10 0 T20 0")
        let relative = SVGPath.path(from: "m0 0 q5 10 10 0 t10 0")

        assertBounds(absolute, CGRect(x: 0, y: -5, width: 20, height: 10))
        assertBounds(relative, CGRect(x: 0, y: -5, width: 20, height: 10))
    }

    /// The rule that is easiest to get wrong: `S` and `T` reflect only when the
    /// command before them was a curve of the compatible kind. After anything else
    /// the control point *is* the current point, and a parser that keeps reflecting
    /// a stale control bends the glyph.
    func testSmoothCubicDoesNotReflectAcrossAnInterveningLine() {
        let path = SVGPath.path(from: "M0 0 C0 10 10 10 10 0 L15 0 S20 -10 20 0")

        // With the control at the current point the dip is 30·(1-t)t² at t=2/3, so
        // 4.444. Wrongly reflecting the earlier (10,10) would double the controls
        // and dip to 7.5.
        assertBounds(path, CGRect(x: 0, y: -4.4444, width: 20, height: 11.9444), accuracy: 0.001)
    }

    func testSmoothQuadraticDoesNotReflectAcrossAnInterveningLine() {
        let path = SVGPath.path(from: "M0 0 Q5 10 10 0 L15 0 T20 0")

        // The control coincides with (15,0), so the T degenerates to a straight
        // line and the path never leaves y ≤ 0 after the Q. A stale reflection
        // would bulge to x ≈ 21.25 and y = -2.5.
        assertBounds(path, CGRect(x: 0, y: 0, width: 20, height: 5))
    }

    /// A `Q` before an `S` is not a compatible previous command, and vice versa.
    func testSmoothCommandsIgnoreTheOtherCurveKind() {
        let path = SVGPath.path(from: "M0 0 Q5 10 10 0 S20 -10 20 0")

        assertBounds(path, CGRect(x: 0, y: -4.4444, width: 20, height: 9.4444), accuracy: 0.001)
    }

    // MARK: - Elliptical arcs

    func testQuarterCircleArcMatchesTheCircleQuadrant() {
        let arc = SVGPath.path(from: "M10 0 A10 10 0 0 1 0 10")
        let quadrant = Path(ellipseIn: CGRect(x: -10, y: -10, width: 20, height: 20))
            .cgPath
            .boundingBoxOfPath
            .intersection(CGRect(x: 0, y: 0, width: 10, height: 10))

        // A cubic approximation of a 90° arc is off by about 2.7 parts in 10,000 of
        // the radius, so 0.01 on r=10 is a real assertion and not a rounding excuse.
        assertBounds(arc, quadrant, accuracy: 0.01)
        assertBounds(SVGPath.path(from: "m10 0 a10 10 0 0 1-10 10"), quadrant, accuracy: 0.01)
    }

    /// Every point the arc is split at must land on the ellipse itself. This is the
    /// assertion a bounding box cannot make: a wrong sweep or a sloppy segment
    /// count can still produce the right box.
    func testArcSegmentJoinsLandOnTheCircle() {
        // 270° — three segments, so there are two interior joins to check.
        let path = SVGPath.path(from: "M10 0 A10 10 0 1 1 0 10")
        let center = CGPoint(x: 10, y: 10)

        let points = onCurvePoints(path)
        XCTAssertEqual(points.count, 4, "a move plus three ≤90° cubic segments")
        for point in points {
            XCTAssertEqual(hypot(point.x - center.x, point.y - center.y), 10, accuracy: 0.0001)
        }
    }

    func testArcFlagsSelectTheFourDistinctArcs() {
        // Same endpoints and radius every time; only the flags differ. Two of the
        // four share a bounding box, so those are told apart by which side of the
        // chord the arc bulges to.
        let shortClockwise = SVGPath.path(from: "M10 0 A10 10 0 0 1 0 10")
        let shortCounter = SVGPath.path(from: "M10 0 A10 10 0 0 0 0 10")
        let longClockwise = SVGPath.path(from: "M10 0 A10 10 0 1 1 0 10")
        let longCounter = SVGPath.path(from: "M10 0 A10 10 0 1 0 0 10")

        assertBounds(shortClockwise, CGRect(x: 0, y: 0, width: 10, height: 10), accuracy: 0.01)
        assertBounds(shortCounter, CGRect(x: 0, y: 0, width: 10, height: 10), accuracy: 0.01)
        assertBounds(longClockwise, CGRect(x: 0, y: 0, width: 20, height: 20), accuracy: 0.01)
        assertBounds(longCounter, CGRect(x: -10, y: -10, width: 20, height: 20), accuracy: 0.01)

        // The short arcs curve away from each other: one bulges past the chord,
        // the other cuts inside it.
        XCTAssertTrue(shortClockwise.cgPath.contains(CGPoint(x: 6, y: 6)))
        XCTAssertFalse(shortClockwise.cgPath.contains(CGPoint(x: 4, y: 4)))
        XCTAssertTrue(shortCounter.cgPath.contains(CGPoint(x: 4, y: 4)))
        XCTAssertFalse(shortCounter.cgPath.contains(CGPoint(x: 6, y: 6)))
    }

    /// Radii too small to reach both endpoints are scaled up until they exactly do
    /// (SVG 1.1 F.6.6.2). Without the correction the centre calculation takes the
    /// square root of a negative number and the segment vanishes.
    func testRadiiTooSmallAreScaledUpUntilTheArcFits() {
        let path = SVGPath.path(from: "M0 0 A1 1 0 0 1 10 0")

        // r=1 cannot span a chord of 10, so both radii scale by √25 = 5 and the
        // arc becomes a semicircle of radius 5 hanging below the chord.
        assertBounds(path, CGRect(x: 0, y: -5, width: 10, height: 5), accuracy: 0.01)
    }

    func testArcWithZeroRadiusDegeneratesToALine() {
        let path = SVGPath.path(from: "M0 0 A0 0 0 0 1 10 10")

        assertBounds(path, CGRect(x: 0, y: 0, width: 10, height: 10))
        XCTAssertEqual(onCurvePoints(path).count, 2, "a move and a line, no curve")
    }

    func testArcWithIdenticalEndpointsIsOmitted() {
        let path = SVGPath.path(from: "M5 5 A10 10 0 1 1 5 5")

        // The spec says an arc whose endpoints coincide is dropped entirely — not
        // drawn as a full circle.
        XCTAssertEqual(onCurvePoints(path), [CGPoint(x: 5, y: 5)])
    }

    func testRotatedEllipticalArcHonoursItsXAxisRotation() {
        let unrotated = SVGPath.path(from: "M0 0 A10 5 0 0 1 20 0")
        let rotated = SVGPath.path(from: "M0 0 A10 5 90 0 1 0 20")

        // Same ellipse, turned a quarter turn: the box turns with it.
        assertBounds(unrotated, CGRect(x: 0, y: -5, width: 20, height: 5), accuracy: 0.01)
        assertBounds(rotated, CGRect(x: 0, y: 0, width: 5, height: 20), accuracy: 0.01)
    }

    // MARK: - Number syntax

    /// `10-5` is two numbers: a minus sign ends the number before it rather than
    /// asking to be a separator. `.72.72` is the same trap with a decimal point,
    /// and `tool/pen` contains exactly that.
    func testNegativeAndDecimalNumbersNeedNoSeparator() {
        assertBounds(SVGPath.path(from: "M0 0 L10-5"), CGRect(x: 0, y: -5, width: 10, height: 5))
        assertBounds(
            SVGPath.path(from: "M0 0 l.72.72"),
            CGRect(x: 0, y: 0, width: 0.72, height: 0.72)
        )
        // tool/pen's tail, verbatim — `a.72.72` is two radii, not one number, and
        // `l1.71-6.54` is two coordinates. Expected box computed from the spec's
        // own arc arithmetic rather than from this parser's output.
        assertBounds(
            SVGPath.path(from: "M5.86 18.14l5 5-6.53 1.72a.72.72 0 0 1-.88-.88l1.71-6.54Z"),
            CGRect(x: 3.42613, y: 17.44, width: 7.43387, height: 7.44387),
            accuracy: 0.001
        )
    }

    func testScientificNotationAndMixedSeparators() {
        assertBounds(SVGPath.path(from: "M0,0 L1e1,5E0"), CGRect(x: 0, y: 0, width: 10, height: 5))
        assertBounds(SVGPath.path(from: "M 0 , 0 L 10 , 10"), CGRect(x: 0, y: 0, width: 10, height: 10))
        assertBounds(SVGPath.path(from: "M0 0L+10+10"), CGRect(x: 0, y: 0, width: 10, height: 10))
        // An `e` with no digits after it is not part of the number.
        assertBounds(SVGPath.path(from: "M0 0 L1e1 1e1"), CGRect(x: 0, y: 0, width: 10, height: 10))
    }

    /// Arc flags are single characters, not numbers. `0 0 1-.88-.88` is flag, flag,
    /// x, y — and a parser that scans them as numbers would swallow the leading 1
    /// of a coordinate written without a space.
    func testArcFlagsAreSingleCharacters() {
        let spaced = SVGPath.path(from: "M0 0 A5 5 0 0 1 10 0")
        let tight = SVGPath.path(from: "M0 0 A5 5 0 0 110 0")

        assertBounds(tight, bounds(spaced), accuracy: 0.0001)
    }

    // MARK: - Malformed input

    func testMalformedInputYieldsAnEmptyPathRatherThanATrap() {
        let broken = [
            "not a path at all",
            "L10 10",              // no initial moveto
            "M",                   // command with no arguments
            "M 10",                // half a coordinate pair
            "M0 0 C0 10 10 10",    // an incomplete cubic
            "M0 0 A10 10 0 2 1 10 0", // 2 is not a flag
            "M0 0 A10 10 0 0",     // arc cut short
            "M0 0 L10 10 &",       // trailing junk
            "M0 0 L..5 3"          // not a number
        ]

        for text in broken {
            XCTAssertTrue(
                SVGPath.path(from: text).isEmpty,
                "expected an empty path for \(text.debugDescription)"
            )
        }
    }

    func testEmptyPathDataIsALegalNoOp() {
        XCTAssertTrue(SVGPath.path(from: "").isEmpty)
        XCTAssertTrue(SVGPath.path(from: "   ").isEmpty)
        XCTAssertNoThrow(try SVGPath.parsed(""))
    }

    func testParseErrorsSayWhatWentWrong() {
        XCTAssertThrowsError(try SVGPath.parsed("L10 10")) { error in
            XCTAssertEqual(error as? SVGPath.ParseError, .missingInitialMoveTo)
        }
        XCTAssertThrowsError(try SVGPath.parsed("M 10")) { error in
            XCTAssertEqual(error as? SVGPath.ParseError, .expectedNumber)
        }
        XCTAssertThrowsError(try SVGPath.parsed("M0 0 A10 10 0 7 1 10 0")) { error in
            XCTAssertEqual(error as? SVGPath.ParseError, .expectedFlag)
        }
        XCTAssertThrowsError(try SVGPath.parsed("M0 0 L10 10 &")) { error in
            XCTAssertEqual(error as? SVGPath.ParseError, .unexpectedCharacter)
        }
    }
}
