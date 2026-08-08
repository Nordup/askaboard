import UIKit
import XCTest
@testable import MathTutor

/// The dot grid, once it is a pattern the canvas paints rather than a SwiftUI
/// `Canvas` behind it. `DotGrid` records that the pitch is "not square, and not
/// 24", so it is exactly the sort of value a rasterization step rounds away.
@MainActor
final class BoardPaperTests: XCTestCase {
    func testTheTileIsAWholeNumberOfPixelsAtEveryScaleTheAppRunsAt() {
        for scale in [CGFloat(2), CGFloat(3)] {
            let cells = CGFloat(BoardPaper.cellsPerTile)
            let width = DotGrid.pitch.width * cells * scale
            let height = DotGrid.pitch.height * cells * scale
            XCTAssertEqual(width, width.rounded(), accuracy: 1e-9, "tile width at \(scale)x is \(width) px")
            XCTAssertEqual(height, height.rounded(), accuracy: 1e-9, "tile height at \(scale)x is \(height) px")
        }
    }

    func testTheTileCarriesTheDesignsPitch() throws {
        let tile = BoardPaper.tile(scale: 2)
        XCTAssertEqual(tile.size.width, DotGrid.pitch.width * CGFloat(BoardPaper.cellsPerTile), accuracy: 0.001)
        XCTAssertEqual(tile.size.height, DotGrid.pitch.height * CGFloat(BoardPaper.cellsPerTile), accuracy: 0.001)
        XCTAssertEqual(tile.scale, 2, "A tile at the wrong scale tiles at the wrong size")

        let spacing = try dotSpacing(in: tile)
        XCTAssertEqual(spacing.x, DotGrid.pitch.width, accuracy: 0.15, "column pitch")
        XCTAssertEqual(spacing.y, DotGrid.pitch.height, accuracy: 0.15, "row pitch")
        XCTAssertNotEqual(spacing.x, spacing.y, "The board's pitch is deliberately not square")
    }

    /// Measures the dot pitch in a rendered tile, in points.
    private func dotSpacing(in image: UIImage) throws -> (x: CGFloat, y: CGFloat) {
        let cg = try XCTUnwrap(image.cgImage)
        let width = cg.width, height = cg.height
        var pixels = [UInt8](repeating: 0, count: width * height)
        let context = try XCTUnwrap(CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))

        let brightest = pixels.max() ?? 255
        func centres(_ isDark: [Bool]) -> [Double] {
            var groups: [[Int]] = []
            for (index, dark) in isDark.enumerated() where dark {
                if var last = groups.last, let end = last.last, index - end <= 2 {
                    last.append(index); groups[groups.count - 1] = last
                } else {
                    groups.append([index])
                }
            }
            return groups.map { Double($0.reduce(0, +)) / Double($0.count) }
        }
        let columns = centres((0..<width).map { x in (0..<height).contains { pixels[$0 * width + x] < brightest - 1 } })
        let rows = centres((0..<height).map { y in (0..<width).contains { pixels[y * width + $0] < brightest - 1 } })
        XCTAssertEqual(columns.count, BoardPaper.cellsPerTile, "one dot column per cell")
        XCTAssertEqual(rows.count, BoardPaper.cellsPerTile, "one dot row per cell")

        let scale = Double(image.scale)
        return (
            x: CGFloat((columns[columns.count - 1] - columns[0]) / Double(columns.count - 1) / scale),
            y: CGFloat((rows[rows.count - 1] - rows[0]) / Double(rows.count - 1) / scale)
        )
    }
}
