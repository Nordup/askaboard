#if DEBUG
import Foundation
import PencilKit

/// A deterministic, vector-only PencilKit fixture for simulator/device E2E runs.
/// It is intentionally compiled out of release builds and is only applied by the
/// `--e2e-seed-radical-attempt` launch argument in `TutorStore`.
enum E2ESeedFixture {
    static let launchArgument = "--e2e-seed-radical-attempt"

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
