#if DEBUG
import Foundation
import PencilKit

/// A deterministic, vector-only PencilKit fixture for simulator/device E2E runs.
/// It is intentionally compiled out of release builds and is only applied by the
/// `--e2e-seed-radical-attempt` launch argument in `TutorStore`.
enum E2ESeedFixture {
    static let launchArgument = "--e2e-seed-radical-attempt"
    /// Seeds the semantic tutor scene instead of (or alongside) PencilKit ink,
    /// so Luna can inspect every primitive without a live API.
    static let sceneLaunchArgument = "--e2e-seed-tutor-scene"

    private struct Glyph {
        let width: CGFloat
        let strokes: [[CGPoint]]
    }

    private static let glyphs: [Character: Glyph] = [
        "0": Glyph(width: 42, strokes: [[CGPoint(x: 0.5, y: 0), CGPoint(x: 0.15, y: 0.14), CGPoint(x: 0, y: 0.5), CGPoint(x: 0.15, y: 0.86), CGPoint(x: 0.5, y: 1), CGPoint(x: 0.85, y: 0.86), CGPoint(x: 1, y: 0.5), CGPoint(x: 0.85, y: 0.14), CGPoint(x: 0.5, y: 0)]]),
        "1": Glyph(width: 32, strokes: [[CGPoint(x: 0.18, y: 0.2), CGPoint(x: 0.5, y: 0), CGPoint(x: 0.5, y: 1)], [CGPoint(x: 0.15, y: 1), CGPoint(x: 0.85, y: 1)]]),
        "2": Glyph(width: 42, strokes: [[CGPoint(x: 0.08, y: 0.18), CGPoint(x: 0.25, y: 0.02), CGPoint(x: 0.7, y: 0), CGPoint(x: 0.98, y: 0.2), CGPoint(x: 0.88, y: 0.42), CGPoint(x: 0.08, y: 1), CGPoint(x: 0.98, y: 1)]]),
        "3": Glyph(width: 42, strokes: [[CGPoint(x: 0.08, y: 0.08), CGPoint(x: 0.85, y: 0.08), CGPoint(x: 0.52, y: 0.48), CGPoint(x: 0.8, y: 0.48), CGPoint(x: 0.98, y: 0.68), CGPoint(x: 0.82, y: 0.98), CGPoint(x: 0.08, y: 0.98)]]),
        "4": Glyph(width: 42, strokes: [[CGPoint(x: 0.72, y: 0), CGPoint(x: 0.72, y: 1)], [CGPoint(x: 0.04, y: 0.64), CGPoint(x: 0.98, y: 0.64)], [CGPoint(x: 0.04, y: 0.64), CGPoint(x: 0.62, y: 0)]]),
        "5": Glyph(width: 42, strokes: [[CGPoint(x: 0.92, y: 0.04), CGPoint(x: 0.12, y: 0.04), CGPoint(x: 0.08, y: 0.48), CGPoint(x: 0.72, y: 0.48), CGPoint(x: 0.96, y: 0.7), CGPoint(x: 0.78, y: 0.98), CGPoint(x: 0.08, y: 0.98)]]),
        "x": Glyph(width: 42, strokes: [[CGPoint(x: 0.08, y: 0.1), CGPoint(x: 0.92, y: 0.9)], [CGPoint(x: 0.92, y: 0.1), CGPoint(x: 0.08, y: 0.9)]]),
        "o": Glyph(width: 42, strokes: [[CGPoint(x: 0.5, y: 0.08), CGPoint(x: 0.16, y: 0.2), CGPoint(x: 0.06, y: 0.52), CGPoint(x: 0.2, y: 0.88), CGPoint(x: 0.56, y: 0.96), CGPoint(x: 0.88, y: 0.78), CGPoint(x: 0.94, y: 0.42), CGPoint(x: 0.78, y: 0.12), CGPoint(x: 0.5, y: 0.08)]]),
        "r": Glyph(width: 36, strokes: [[CGPoint(x: 0.1, y: 0.04), CGPoint(x: 0.1, y: 1)], [CGPoint(x: 0.1, y: 0.24), CGPoint(x: 0.38, y: 0.08), CGPoint(x: 0.82, y: 0.18)]]),
        "+": Glyph(width: 38, strokes: [[CGPoint(x: 0.5, y: 0.08), CGPoint(x: 0.5, y: 0.92)], [CGPoint(x: 0.08, y: 0.5), CGPoint(x: 0.92, y: 0.5)]]),
        "−": Glyph(width: 38, strokes: [[CGPoint(x: 0.08, y: 0.5), CGPoint(x: 0.92, y: 0.5)]]),
        "=": Glyph(width: 42, strokes: [[CGPoint(x: 0.08, y: 0.35), CGPoint(x: 0.92, y: 0.35)], [CGPoint(x: 0.08, y: 0.68), CGPoint(x: 0.92, y: 0.68)]]),
        "(": Glyph(width: 24, strokes: [[CGPoint(x: 0.86, y: 0), CGPoint(x: 0.35, y: 0.5), CGPoint(x: 0.86, y: 1)]]),
        ")": Glyph(width: 24, strokes: [[CGPoint(x: 0.14, y: 0), CGPoint(x: 0.65, y: 0.5), CGPoint(x: 0.14, y: 1)]]),
        "√": Glyph(width: 62, strokes: [[CGPoint(x: 0.02, y: 0.48), CGPoint(x: 0.2, y: 0.78), CGPoint(x: 0.39, y: 0.06)], [CGPoint(x: 0.39, y: 0.06), CGPoint(x: 0.98, y: 0.06)] ]),
        "²": Glyph(width: 30, strokes: [[CGPoint(x: 0.06, y: 0.28), CGPoint(x: 0.2, y: 0.04), CGPoint(x: 0.62, y: 0.04), CGPoint(x: 0.9, y: 0.26), CGPoint(x: 0.06, y: 0.94), CGPoint(x: 0.94, y: 0.94)]])
    ]

    private static let lines = [
        "√(x + 5) = x − 1",
        "x + 5 = (x − 1)²",
        "x + 5 = x² − 2x + 1",
        "0 = x² − 3x − 4",
        "0 = (x − 4)(x + 1)",
        "x = 4 or x = −1"
    ]

    static func drawing() -> PKDrawing {
        let ink = PKInk(.pen, color: .black)
        let strokes = lines.enumerated().flatMap { lineIndex, line in
            // Keep every line below the exercise card/top bar and above the
            // board's bottom controls so the seeded attempt is fully visible on
            // an iPad board.
            makeLine(line, origin: CGPoint(x: 84, y: 410 + CGFloat(lineIndex) * 60), ink: ink)
        }
        return PKDrawing(strokes: strokes)
    }

    static func drawingData() -> Data { drawing().dataRepresentation() }

    static func seedSession(_ session: inout LearningSession) {
        session.plan = .radicalEquation
        session.exercise = .radicalEquation
        session.drawingData = drawingData()
        session.lastSavedAt = .now
    }

    static func scene() -> BoardScene {
        let triangleStroke = BoardStyle(
            role: .content, stroke: "#0155FB", fill: "#E3EEFF",
            strokeWidth: 4, opacity: 1, dash: [], rotation: 0
        )
        let labelStyle = BoardStyle(
            role: .content, stroke: "#0A0A0A", fill: "transparent",
            strokeWidth: 1, opacity: 1, dash: [], rotation: 0
        )
        let hintStyle = BoardStyle(
            role: .hint, stroke: "#40A365", fill: "transparent",
            strokeWidth: 3, opacity: 1, dash: [8, 6], rotation: 0
        )
        let correctionStyle = BoardStyle(
            role: .correction, stroke: "#E33E38", fill: "transparent",
            strokeWidth: 3, opacity: 1, dash: [10, 6], rotation: 0
        )
        let emphasisStyle = BoardStyle(
            role: .emphasis, stroke: "#6051DC", fill: "transparent",
            strokeWidth: 6, opacity: 1, dash: [], rotation: 0
        )
        let circleFill = BoardStyle(
            role: .content, stroke: "#40A365", fill: "#E7F6EC",
            strokeWidth: 4, opacity: 1, dash: [], rotation: 0
        )

        return BoardScene(elements: [
            .text(TextElement(
                id: "exercise", x: -285, y: -325,
                text: "Exercise: find ∠A, then resolve F into components.",
                fontSize: 18, alignment: .center, width: 570, style: labelStyle
            )),
            .freehand(FreehandElement(
                id: "title-underline",
                points: [
                    BoardPoint(x: -220, y: -285), BoardPoint(x: -105, y: -290),
                    BoardPoint(x: 10, y: -284), BoardPoint(x: 125, y: -289),
                    BoardPoint(x: 220, y: -285),
                ],
                style: hintStyle
            )),
            .polygon(PolygonElement(
                id: "triangle",
                points: [
                    BoardPoint(x: -285, y: -105),
                    BoardPoint(x: -65, y: -105),
                    BoardPoint(x: -175, y: 165),
                ],
                style: triangleStroke
            )),
            .line(LineElement(
                id: "altitude", x1: -175, y1: -105, x2: -175, y2: 165,
                style: BoardStyle(
                    role: .hint, stroke: "#40A365", fill: "transparent",
                    strokeWidth: 2, opacity: 1, dash: [7, 5], rotation: 0
                )
            )),
            .angleMarker(AngleMarkerElement(
                id: "angle-a", vertexX: -285, vertexY: -105,
                ray1X: -65, ray1Y: -105, ray2X: -175, ray2Y: 165,
                radius: 38, rightAngle: false,
                style: BoardStyle(
                    role: .content, stroke: "#E33E38", fill: "transparent",
                    strokeWidth: 4, opacity: 1, dash: [], rotation: 0
                )
            )),
            .text(TextElement(
                id: "label-a", x: -310, y: -145, text: "A",
                fontSize: 22, alignment: .center, width: 36, style: labelStyle
            )),
            .text(TextElement(
                id: "label-b", x: -80, y: -145, text: "B",
                fontSize: 22, alignment: .center, width: 36, style: labelStyle
            )),
            .text(TextElement(
                id: "label-c", x: -193, y: 170, text: "C",
                fontSize: 22, alignment: .center, width: 36, style: labelStyle
            )),
            .circle(CircleElement(
                id: "circle", cx: 35, cy: -70, radius: 66, style: circleFill
            )),
            .arrow(ArrowElement(
                id: "radius", x1: 35, y1: -70, x2: 85, y2: -28,
                headSize: 11, style: labelStyle
            )),
            .text(TextElement(
                id: "radius-label", x: 58, y: -68, text: "r",
                fontSize: 20, alignment: .left, width: 28, style: labelStyle
            )),
            .arc(ArcElement(
                id: "sweep", cx: 225, cy: -70, radius: 48,
                startAngle: 20, endAngle: 300,
                style: BoardStyle(
                    role: .emphasis, stroke: "#6051DC", fill: "transparent",
                    strokeWidth: 5, opacity: 1, dash: [9, 5], rotation: 0
                )
            )),
            .polyline(PolylineElement(
                id: "components",
                points: [
                    BoardPoint(x: -35, y: 170), BoardPoint(x: -35, y: 45),
                    BoardPoint(x: 75, y: 45),
                ],
                style: hintStyle
            )),
            .arrow(ArrowElement(
                id: "force", x1: -35, y1: 170, x2: 75, y2: 45,
                headSize: 15, style: emphasisStyle
            )),
            .text(TextElement(
                id: "force-label", x: 45, y: 132, text: "F = 60 N",
                fontSize: 19, alignment: .left, width: 120, style: emphasisStyle
            )),
            .rectangle(RectangleElement(
                id: "hint-box", x: -300, y: 225, width: 260, height: 82,
                style: BoardStyle(
                    role: .hint, stroke: "#40A365", fill: "#E7F6EC",
                    strokeWidth: 3, opacity: 1, dash: [8, 5], rotation: 0
                )
            )),
            .text(TextElement(
                id: "hint", x: -284, y: 242,
                text: "Hint: label known angles first.",
                fontSize: 16, alignment: .left, width: 228, style: hintStyle
            )),
            .ellipse(EllipseElement(
                id: "correction-ring", x: -5, y: 220, width: 300, height: 85,
                style: correctionStyle
            )),
            .text(TextElement(
                id: "correction", x: 15, y: 242,
                text: "Check: split F horizontally and vertically.",
                fontSize: 15, alignment: .center, width: 260, style: correctionStyle
            )),
        ])
    }

    static func seedScene(_ session: inout LearningSession) {
        session.boardScene = scene()
        session.lastSavedAt = .now
    }

    private static func makeLine(_ line: String, origin: CGPoint, ink: PKInk) -> [PKStroke] {
        let baselineHeight: CGFloat = 52
        var cursor = origin.x
        var result: [PKStroke] = []
        for character in line {
            if character == " " {
                cursor += 24
                continue
            }
            guard let glyph = glyphs[character] else {
                cursor += 30
                continue
            }
            let isSuperscript = character == "²"
            let scale = isSuperscript ? CGSize(width: 0.62, height: 0.62) : CGSize(width: 1, height: 1)
            let yOffset = isSuperscript ? -18 : 0
            for template in glyph.strokes {
                let points = template.map { point in
                    CGPoint(
                        x: cursor + point.x * glyph.width * scale.width,
                        y: origin.y + CGFloat(yOffset) + point.y * baselineHeight * scale.height
                    )
                }
                result.append(makeStroke(points, ink: ink))
            }
            cursor += glyph.width * scale.width + 8
        }
        return result
    }

    private static func makeStroke(_ points: [CGPoint], ink: PKInk) -> PKStroke {
        let controlPoints = points.enumerated().map { index, point in
            PKStrokePoint(
                location: point,
                timeOffset: Double(index) * 0.02,
                size: CGSize(width: 5, height: 5),
                opacity: 1,
                force: 1,
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        let path = PKStrokePath(controlPoints: controlPoints, creationDate: Date(timeIntervalSinceReferenceDate: 0))
        return PKStroke(ink: ink, path: path, transform: .identity, mask: nil, randomSeed: 7)
    }
}
#endif
