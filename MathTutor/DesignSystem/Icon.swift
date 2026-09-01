import CoreGraphics
import SwiftUI

/// The design's twenty-two product glyphs.
///
/// Raw values are the design's own names, so a case traces straight back to
/// `design/icons.json`, to `docs/design-system/04-icons.md` and
/// `06-states-and-settings.md`, and to the Paper boards without anyone maintaining a
/// translation table.
///
/// `os/wifi` and `os/battery` are absent on purpose: the board heads that section
/// "DO NOT SHIP" — they are stand-ins for iPadOS chrome that the system supplies at
/// runtime, and their geometry is explicitly not a house rule.
enum Icon: String, CaseIterable, Sendable {
    case toolPen = "tool/pen"
    case toolHighlighter = "tool/highlighter"
    case toolEraser = "tool/eraser"
    case toolLasso = "tool/lasso"
    case toolCenter = "tool/center"
    case controlDock = "control/dock"
    case controlFull = "control/full"
    case controlSettings = "control/settings"
    case uiSelectionMarker = "ui/selection-marker"
    case uiCheck = "ui/check"
    case uiCross = "ui/cross"
    case uiChevronDown = "ui/chevron-down"
    case uiRetry = "ui/retry"
    case composerVoice = "composer/voice"
    case composerSend = "composer/send"
    case composerDismiss = "composer/dismiss"
    case chipExplain = "chip/explain"
    case chipExample = "chip/example"
    case chipExercise = "chip/exercise"
    case chipConfused = "chip/confused"
    case boardHinge = "board/hinge"
    case uiPlus = "ui/plus"
    // The activity trail's step rows. `tool/pen` and `ui/check` already covered
    // two of the seven steps; these are the other four. All drawn on a 24
    // viewBox, and all rendered at 16 in a trail row — where the authored 2.0
    // scales to 1.33 and the call site compensates. See `04-icons.md` §07.
    case trailEye = "trail/eye"
    case trailSearch = "trail/search"
    case trailPlan = "trail/plan"
    case trailNote = "trail/note"
    case trailTerminal = "trail/terminal"
    case trailGlobe = "trail/globe"
    // The chat header's leading control — board 17's replacement for the gear that
    // used to sit there. Drawn inside `btn/sidebar-toggle` rather than as a specimen
    // on board 04, the same route `ui/chevron-down` and `ui/plus` took.
    case uiSidebarToggle = "ui/sidebar-toggle"
}

extension Icon {
    /// The glyph's geometry and metadata, as exported from the design.
    var glyph: IconGlyph { IconPaths.glyph(for: self) }

    /// The size a caller gets without asking for one: the size the design draws
    /// this glyph at in the product.
    var renderSize: CGFloat { glyph.renderSize }

    /// viewBox units per point at a given render width.
    ///
    /// Everything that is authored in viewBox units — dash lengths, above all —
    /// has to travel through this, or it silently stops matching the path it
    /// decorates the moment someone renders the glyph at another size.
    func scale(at size: CGFloat) -> CGFloat {
        guard glyph.viewBox.width > 0 else { return 1 }
        return size / glyph.viewBox.width
    }

    /// The glyph's dash pattern in points at `size`, or `nil` if it has none.
    ///
    /// At most one texture per glyph — the board names two and each has exactly one
    /// user.
    func dashPattern(at size: CGFloat) -> [CGFloat]? {
        guard let texture = glyph.elements.compactMap(\.dash).first else { return nil }
        return texture.pattern(scaledBy: scale(at: size))
    }
}

// MARK: - Glyph data

/// One glyph, exactly as the design draws it.
///
/// The stroke weight here is the port's single normalisation. Board 04's own
/// recommendation — "draw every product glyph on a 24 viewBox and render it at 24,
/// so the scale is always 1.0 and the stroke is always exactly 2.0, one number with
/// nothing to re-derive" — was rejected in Paper only because rescaling a 28 viewBox
/// there means redrawing every coordinate. Scaling a path in code is free, so the
/// port takes the advice: `strokeWidth` is in points and is applied *after* the
/// viewBox has been scaled into the render size, which makes it the effective
/// rendered weight at every size, with nothing per-size left to drift.
struct IconGlyph: Sendable {
    /// The design's own name, e.g. `tool/pen`.
    let name: String
    let viewBox: CGSize
    /// The size the product draws this glyph at, used when a caller asks for none.
    /// For the one non-square glyph this is the width; the height follows the
    /// aspect, because a non-square mark stretched into a square slot is wrong.
    let renderSize: CGFloat
    /// Every size the design draws it at. More than one is the drift the
    /// normalisation removes — `composer/send` needed 2.18 at 22pt and 1.85 at 26pt
    /// to hit the same 2.0.
    let productRenderSizes: [CGFloat]
    /// Effective stroke weight in points, at any render size. 2.0 everywhere except
    /// the board's two documented exceptions.
    let strokeWidth: CGFloat
    /// The design token the glyph binds, for provenance. The colour itself is the
    /// caller's — see `IconView`.
    let colorToken: String
    /// A defect in the design this glyph carries, if it has one.
    let designAnomaly: IconAnomaly?
    let elements: [IconElement]

    init(
        name: String,
        viewBox: CGSize,
        renderSize: CGFloat,
        productRenderSizes: [CGFloat],
        strokeWidth: CGFloat,
        colorToken: String,
        designAnomaly: IconAnomaly? = nil,
        elements: [IconElement]
    ) {
        self.name = name
        self.viewBox = viewBox
        self.renderSize = renderSize
        self.productRenderSizes = productRenderSizes
        self.strokeWidth = strokeWidth
        self.colorToken = colorToken
        self.designAnomaly = designAnomaly
        self.elements = elements
    }
}

/// Something the design gets wrong, written down instead of quietly fixed.
///
/// The port renders the normalised weight like every other glyph, so this record is
/// not read at draw time. It exists so the defect is a fact in the codebase that a
/// test can pin: when the design is corrected upstream, the pinned value fails and
/// someone deletes this rather than never noticing the change.
struct IconAnomaly: Sendable, Equatable {
    /// Which instance of the glyph is off — a glyph drawn at two sizes can be right
    /// at one of them.
    let instance: String
    let renderSize: CGFloat
    let designStrokeWidth: CGFloat
    /// What that instance actually renders: `designStrokeWidth × (renderSize ÷ viewBox)`.
    let effectiveStrokeWidth: CGFloat
    let note: String
}

/// One drawn element of a glyph, in viewBox coordinates and in document order.
///
/// Caps, joins and fills are per element rather than per glyph because the design
/// genuinely varies them inside a single mark: `composer/voice` rounds the joins on
/// its capsule and the caps on its cradle, and `chip/confused` fills its question-mark
/// dot while stroking everything around it.
struct IconElement: Sendable {
    enum Geometry: Sendable {
        /// The design's verbatim `d` attribute.
        case path(String)
        case rect(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, cornerRadius: CGFloat)
        case circle(centerX: CGFloat, centerY: CGFloat, radius: CGFloat)
    }

    let geometry: Geometry
    let isFilled: Bool
    let isStroked: Bool
    let lineCap: CGLineCap
    let lineJoin: CGLineJoin
    let dash: IconDashTexture?
    /// The design's own `stroke-width` attribute. Kept for provenance and for
    /// diffing against the Paper markup; the rendered weight comes from
    /// `IconGlyph.strokeWidth`, which is the normalised one.
    let designStrokeWidth: CGFloat?

    /// The element in viewBox coordinates.
    var path: Path {
        switch geometry {
        case .path(let d):
            SVGPath.path(from: d)
        case .rect(let x, let y, let width, let height, let cornerRadius):
            // SVG's `rx` is a circular corner, which is also SwiftUI's default. The
            // one thing that does not carry over is where the outline starts, so a
            // dashed rect's phase can sit differently than in the browser; the
            // design declares no dash offset, so there is nothing to preserve.
            Path(
                roundedRect: CGRect(x: x, y: y, width: width, height: height),
                cornerRadius: cornerRadius,
                style: .circular
            )
        case .circle(let centerX, let centerY, let radius):
            Path(
                ellipseIn: CGRect(
                    x: centerX - radius,
                    y: centerY - radius,
                    width: radius * 2,
                    height: radius * 2
                )
            )
        }
    }
}

/// The two dash textures the board names.
///
/// It keeps both rather than unifying them because "a tool and a state are different
/// marks, and 4.6/3.9 on a r9.7 circle would read as four arcs, not dots".
enum IconDashTexture: Sendable, Equatable {
    /// `dash/dotted` — 0.1 on a 4.3 gap. `tool/lasso` only. The round cap is
    /// load-bearing: it is what turns a 0.1 dash into a dot roughly one stroke-width
    /// across, and it is why the lasso keeps a 2.7 weight the rest of the set does not.
    case dotted
    /// `dash/marching` — 4.6 on a 3.9 gap. `ui/selection-marker` only. Butt caps,
    /// which is what makes the segments read as clean marching ants.
    case marching

    /// The pattern as the design declares it — in viewBox units, not points.
    var viewBoxPattern: [CGFloat] {
        switch self {
        case .dotted: [0.1, 4.3]
        case .marching: [4.6, 3.9]
        }
    }

    /// The pattern in points, for a path scaled by `scale`.
    ///
    /// Dash lengths are measured along the *scaled* path, so they have to be scaled
    /// with it. Copying `0.1 4.3` straight into a `StrokeStyle` is correct at the
    /// one size the design authored and wrong at every other.
    func pattern(scaledBy scale: CGFloat) -> [CGFloat] {
        viewBoxPattern.map { $0 * scale }
    }
}

// MARK: - Rendering

/// One element of a glyph, scaled from its viewBox into the given rect.
///
/// Uniform scale and centred, which is SVG's default `preserveAspectRatio` of
/// `xMidYMid meet` — the same contract the design was drawn under, and the reason
/// `board/hinge` may never be stretched to fill a square.
struct IconElementShape: Shape {
    let element: IconElement
    let viewBox: CGSize

    func path(in rect: CGRect) -> Path {
        guard viewBox.width > 0, viewBox.height > 0 else { return Path() }
        let scale = min(rect.width / viewBox.width, rect.height / viewBox.height)
        guard scale > 0, scale.isFinite else { return Path() }
        let transform = CGAffineTransform(
            translationX: rect.minX + (rect.width - viewBox.width * scale) / 2,
            y: rect.minY + (rect.height - viewBox.height * scale) / 2
        )
        .scaledBy(x: scale, y: scale)
        return element.path.applying(transform)
    }
}

/// A design-system glyph, drawn at a design-system weight.
///
/// `ui/selection-marker` is deliberately one case and not two: it is a single asset
/// in two colour states — brand when a board selection is live, icon grey when the
/// dock's select control is idle — and the design file's own grey/violet mismatch
/// happened precisely because someone copy-pasted it instead of injecting the colour.
struct IconView: View {
    private let icon: Icon
    private let size: CGFloat?
    private let tint: Color

    init(_ icon: Icon, size: CGFloat? = nil, tint: Color = DS.Color.icon) {
        self.icon = icon
        self.size = size
        self.tint = tint
    }

    var body: some View {
        let glyph = icon.glyph
        let width = size ?? glyph.renderSize
        let height = width * glyph.viewBox.height / glyph.viewBox.width
        // Dash lengths are authored in viewBox units, so they scale with the path
        // while the stroke weight deliberately does not.
        let scale = icon.scale(at: width)

        ZStack {
            ForEach(Array(glyph.elements.enumerated()), id: \.offset) { _, element in
                let shape = IconElementShape(element: element, viewBox: glyph.viewBox)
                if element.isFilled {
                    shape.fill(resolvedTint)
                }
                if element.isStroked {
                    shape.stroke(
                        resolvedTint,
                        style: StrokeStyle(
                            lineWidth: glyph.strokeWidth,
                            lineCap: element.lineCap,
                            lineJoin: element.lineJoin,
                            dash: element.dash?.pattern(scaledBy: scale) ?? []
                        )
                    )
                }
            }
        }
        .frame(width: width, height: height)
        // An SVG viewport clips, and one glyph needs it to: `tool/pen`'s cap arc
        // reaches x=28.28 on a 28 viewBox, so the browser hides a 0.28pt sliver of
        // it. Clipping here renders what the design renders rather than what its
        // coordinates say.
        .clipped()
    }

    /// `composer/send` is the set's one untokenised colour — a literal `#FFFFFF`,
    /// because it only ever rides the filled brand send button. `DS.Color.surface` is
    /// that same white as a token. Substituting it here rather than leaving it to
    /// the caller means the arrow cannot be handed the default icon grey and lost
    /// against the violet underneath it.
    private var resolvedTint: Color {
        icon == .composerSend ? DS.Color.surface : tint
    }
}

#Preview("Icons") {
    LazyVGrid(columns: Array(repeating: GridItem(.fixed(64), spacing: 16), count: 6), spacing: 16) {
        ForEach(Icon.allCases, id: \.self) { icon in
            IconView(icon, tint: icon.glyph.colorToken.contains("brand") ? DS.Color.brand : DS.Color.icon)
                .frame(width: 64, height: 64)
                .background(icon == .composerSend ? DS.Color.brand : DS.Color.surfaceScreen)
                .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
    .padding(32)
}
