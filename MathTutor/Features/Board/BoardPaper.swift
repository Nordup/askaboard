import SwiftUI
import UIKit

/// The board's paper — `--color-surface-canvas` and the dot grid — as one opaque
/// pattern that `PKCanvasView` paints as its own background.
///
/// **Why the grid moved into the canvas.** PencilKit renders the stroke under the
/// pencil through a separate, high-frequency path so the ink keeps up with the
/// tip. That path needs the canvas to be a plain opaque layer it can present. A
/// canvas with `isOpaque = false` over a `--color-surface-canvas` fill and a
/// SwiftUI `Canvas` full of dots is not one: every frame of every stroke has to be
/// blended back over two layers underneath it, so the wet ink falls back to
/// arriving with the ordinary Core Animation commits — which is what a stroke
/// landing in visible segments rather than tracking the tip looks like.
///
/// Giving the canvas the paper is what makes it opaque, and there is nothing left
/// underneath it to blend with. `DotGrid` stays as the design system's own
/// drawing of the grid; this is the same grid, at the same pitch, in the form
/// UIKit can hand to a layer.
enum BoardPaper {
    /// How many grid cells one tile carries.
    ///
    /// **Ten, so the tile is a whole number of pixels.** The design's pitch is
    /// 23.9 × 24.5 — `DotGrid` records that it is "not square, and not 24" — and
    /// one cell is 47.8 × 49 px at 2x, so a one-cell tile would have to round its
    /// width to 48 and drift the columns by 0.1pt each. Ten cells is 239 × 245pt,
    /// which is whole at 2x (478 × 490) and at 3x (717 × 735), so the pitch the
    /// board specifies is the pitch that ships.
    static let cellsPerTile = 10

    /// The pattern colour to give `PKCanvasView.backgroundColor`, rendered at the
    /// canvas's own display scale so the dots are as crisp as the screen allows.
    @MainActor
    static func background(scale: CGFloat) -> UIColor {
        UIColor(patternImage: tile(scale: scale))
    }

    /// Rendered once per scale. `configure` runs on every viewport change —
    /// rotation, Split View — and re-rasterizing a 478 × 490 tile each time would
    /// be work done for a picture that cannot have changed.
    @MainActor
    private static var tiles: [CGFloat: UIImage] = [:]

    @MainActor
    static func tile(scale: CGFloat) -> UIImage {
        if let cached = tiles[scale] { return cached }
        let rendered = renderTile(scale: scale)
        tiles[scale] = rendered
        return rendered
    }

    private static func renderTile(scale: CGFloat) -> UIImage {
        let cells = CGFloat(cellsPerTile)
        let size = CGSize(width: DotGrid.pitch.width * cells, height: DotGrid.pitch.height * cells)
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        // The whole point: a tile with no transparency in it, so the canvas that
        // paints it can declare itself opaque.
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor(DS.Color.surfaceCanvas).setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor(DotGrid.dotColor).setFill()
            // Top-left anchored, exactly as `DotGrid` places its ellipses, so the
            // two drawings of the same grid land on the same points.
            let diameter = DotGrid.dotRadius * 2
            for row in 0..<cellsPerTile {
                for column in 0..<cellsPerTile {
                    context.cgContext.fillEllipse(
                        in: CGRect(
                            x: CGFloat(column) * DotGrid.pitch.width,
                            y: CGFloat(row) * DotGrid.pitch.height,
                            width: diameter,
                            height: diameter
                        )
                    )
                }
            }
        }
    }
}
