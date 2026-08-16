import CoreGraphics
import Foundation
import OSLog

/// The tutor-authored semantic layer on the whiteboard.
///
/// Learner handwriting stays a `PKDrawing`; this is a separate structured scene
/// of text and geometry that the model can revise by stable id. It is pure
/// Domain state: no UIKit, no SwiftUI, and no renderer. Coordinates are logical
/// board points with (0,0) at `PencilCanvasConfiguration.boardOrigin`,
/// +x right and +y down.
struct BoardScene: Codable, Hashable, Sendable {
    var elements: [BoardElement]

    static var empty: BoardScene { BoardScene(elements: []) }

    init(elements: [BoardElement]) {
        self.elements = elements
    }

    /// Decoding skips an element whose kind this build does not know, exactly
    /// as `BoardSceneUpdate` does. A scene persisted by a later build then
    /// restores everything this one can still draw, instead of restoring as
    /// nothing — and the session store reads it with `try?`, so "nothing" is
    /// what a single strange element would otherwise cost the whole board.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        elements = try container.decode([LenientElement].self, forKey: .elements).known
    }

    enum CodingKeys: String, CodingKey {
        case elements
    }

    /// Deterministic application of one batched update.
    ///
    /// Order is `replace-all` (if requested), deletes, then idempotent upserts.
    /// An existing id is replaced in place so the scene's z-order stays stable;
    /// a new id appends. A duplicate id inside one batch resolves to the last
    /// value, which keeps the operation idempotent rather than ambiguous.
    func applying(_ update: BoardSceneUpdate) -> BoardScene {
        var result = update.replaceAll ? [] : elements
        if !update.deletes.isEmpty {
            let deleted = Set(update.deletes)
            result.removeAll { deleted.contains($0.id) }
        }
        for element in update.upserts {
            if let index = result.firstIndex(where: { $0.id == element.id }) {
                result[index] = element
            } else {
                result.append(element)
            }
        }
        return BoardScene(elements: result)
    }

    func element(withID id: String) -> BoardElement? {
        elements.first { $0.id == id }
    }
}

/// The validated operation set the server sends in the `board_update` event.
///
/// This mirrors the actual SSE payload exactly: `upserts` and `deletes` are the
/// applied operations, and `replace_all` is a flag rather than a mode string.
struct BoardSceneUpdate: Codable, Equatable, Sendable {
    enum Mode: String, Codable, Sendable {
        case upsert
        case replaceAll = "replace_all"
    }

    var upserts: [BoardElement] = []
    var deletes: [String] = []
    var replaceAll: Bool = false

    init(upserts: [BoardElement] = [], deletes: [String] = [], replaceAll: Bool = false) {
        self.upserts = upserts
        self.deletes = deletes
        self.replaceAll = replaceAll
    }

    /// Source-compatible convenience for local callers that still think in
    /// the model tool's argument vocabulary. Encoding always emits the SSE
    /// payload vocabulary above.
    init(mode: Mode = .upsert, deleteIDs: [String] = [], elements: [BoardElement] = []) {
        self.init(
            upserts: elements,
            deletes: mode == .replaceAll ? [] : deleteIDs,
            replaceAll: mode == .replaceAll
        )
    }

    enum CodingKeys: String, CodingKey {
        case upserts
        case deletes
        case replaceAll = "replace_all"
    }

    /// Backward-compatible decode for the pre-hardening tool-argument shape
    /// (`mode`/`delete_ids`/`elements`), accepted only when no upsert payload
    /// keys are present. The production wire always uses the payload shape.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.upserts) || container.contains(.deletes) || container.contains(.replaceAll) {
            upserts = (try container.decodeIfPresent([LenientElement].self, forKey: .upserts) ?? []).known
            deletes = try container.decodeIfPresent([String].self, forKey: .deletes) ?? []
            replaceAll = try container.decodeIfPresent(Bool.self, forKey: .replaceAll) ?? false
            return
        }

        struct LegacyKeys: CodingKey {
            var stringValue: String
            init?(stringValue: String) { self.stringValue = stringValue }
            var intValue: Int? { nil }
            init?(intValue: Int) { nil }
        }
        let legacy = try decoder.container(keyedBy: LegacyKeys.self)
        func decode<T: Decodable>(_ type: T.Type, _ key: String) throws -> T? {
            guard let codingKey = LegacyKeys(stringValue: key) else { return nil }
            return try legacy.decodeIfPresent(T.self, forKey: codingKey)
        }
        let mode = try decode(String.self, "mode") ?? "upsert"
        upserts = (try decode([LenientElement].self, "elements") ?? []).known
        deletes = try decode([String].self, "delete_ids") ?? []
        replaceAll = mode == "replace_all"
    }
}

enum BoardRole: String, Codable, Sendable, CaseIterable {
    case content
    case hint
    case correction
    case emphasis
}

enum BoardTextAlignment: String, Codable, Sendable {
    case left
    case center
    case right
}

enum BoardElementKind: String, Codable, Sendable, CaseIterable {
    case text
    case line
    case arrow
    case rectangle
    case ellipse
    case circle
    case polygon
    case polyline
    case freehand
    case arc
    case angleMarker = "angle_marker"
    case path
    case mathText = "math_text"
    case image
    case svg
}

/// Style fields shared by every primitive; all are present on the wire.
struct BoardStyle: Codable, Hashable, Sendable {
    var role: BoardRole = .content
    var stroke: String = "#0A0A0A"
    var fill: String = "transparent"
    var strokeWidth: CGFloat = 4
    var opacity: CGFloat = 1
    var dash: [CGFloat] = []
    /// Clockwise rotation in degrees around the element's own centre.
    var rotation: CGFloat = 0

    enum CodingKeys: String, CodingKey {
        case role
        case stroke
        case fill
        case strokeWidth = "stroke_width"
        case opacity
        case dash
        case rotation
    }
}

struct TextElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .text
    var x: CGFloat
    var y: CGFloat
    var text: String
    var fontSize: CGFloat
    var alignment: BoardTextAlignment = .left
    /// Text box width in board points; 0 means natural width.
    var width: CGFloat = 0
    var style: BoardStyle = BoardStyle()

    enum CodingKeys: String, CodingKey {
        case id, kind, x, y, text, alignment, width, style
        case fontSize = "font_size"
    }
}

struct LineElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .line
    var x1: CGFloat
    var y1: CGFloat
    var x2: CGFloat
    var y2: CGFloat
    var style: BoardStyle = BoardStyle()
}

struct ArrowElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .arrow
    var x1: CGFloat
    var y1: CGFloat
    var x2: CGFloat
    var y2: CGFloat
    var headSize: CGFloat = 12
    var style: BoardStyle = BoardStyle()

    enum CodingKeys: String, CodingKey {
        case id, kind, x1, y1, x2, y2, style
        case headSize = "head_size"
    }
}

struct RectangleElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .rectangle
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat
    var style: BoardStyle = BoardStyle()
}

struct EllipseElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .ellipse
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat
    var style: BoardStyle = BoardStyle()
}

struct CircleElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .circle
    var cx: CGFloat
    var cy: CGFloat
    var radius: CGFloat
    var style: BoardStyle = BoardStyle()
}

struct PolygonElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .polygon
    var points: [BoardPoint]
    var style: BoardStyle = BoardStyle()
}

struct PolylineElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .polyline
    var points: [BoardPoint]
    var style: BoardStyle = BoardStyle()
}

struct FreehandElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .freehand
    var points: [BoardPoint]
    var style: BoardStyle = BoardStyle()
}

/// A logical board point encoded as `[x, y]`, matching the wire contract.
struct BoardPoint: Codable, Hashable, Sendable {
    var x: CGFloat
    var y: CGFloat

    init(x: CGFloat, y: CGFloat) {
        self.x = x
        self.y = y
    }

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        x = try container.decode(CGFloat.self)
        y = try container.decode(CGFloat.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.unkeyedContainer()
        try container.encode(x)
        try container.encode(y)
    }
}

struct ArcElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .arc
    var cx: CGFloat
    var cy: CGFloat
    var radius: CGFloat
    var startAngle: CGFloat
    var endAngle: CGFloat
    var style: BoardStyle = BoardStyle()

    enum CodingKeys: String, CodingKey {
        case id, kind, cx, cy, radius, style
        case startAngle = "start_angle"
        case endAngle = "end_angle"
    }
}

struct AngleMarkerElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .angleMarker
    var vertexX: CGFloat
    var vertexY: CGFloat
    var ray1X: CGFloat
    var ray1Y: CGFloat
    var ray2X: CGFloat
    var ray2Y: CGFloat
    var radius: CGFloat = 40
    var rightAngle: Bool = false
    var style: BoardStyle = BoardStyle()

    enum CodingKeys: String, CodingKey {
        case id, kind, radius, style
        case vertexX = "vertex_x"
        case vertexY = "vertex_y"
        case ray1X = "ray1_x"
        case ray1Y = "ray1_y"
        case ray2X = "ray2_x"
        case ray2Y = "ray2_y"
        case rightAngle = "right_angle"
    }
}

/// How a path's overlapping subpaths fill, as SVG's `fill-rule` spells it.
enum PathFillRule: String, Codable, Sendable {
    case nonzero
    case evenodd
}

/// One SVG path: the curve and freeform primitive, still editable by id.
///
/// `d` carries absolute board points rather than a local viewbox, so a path
/// needs no frame and sits in the same space as every other element. That also
/// makes it the one geometry the server does not clamp — the numbers are
/// inside a string it never parses — so the renderer, not the schema, is what
/// keeps an unparseable or unbounded `d` from reaching a layer.
struct PathElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .path
    var d: String
    var fillRule: PathFillRule = .nonzero
    var style: BoardStyle = BoardStyle()

    enum CodingKeys: String, CodingKey {
        case id, kind, d, style
        case fillRule = "fill_rule"
    }
}

/// Mathematical notation, carried as LaTeX and typeset on the device.
///
/// This is the only element that puts notation on the board: notation spelled
/// out as plain text, or assembled from lines and glyphs, is unreadable and
/// cannot be revised by id. The server holds no opinion on the dialect and
/// passes `latex` through byte for byte, so what arrives here is whatever the
/// model wrote — including the `$…$` padding it adds despite instructions.
/// `BoardMathStore` is what strips that and typesets the rest.
///
/// `fontSize` is the notation's size in board points. The raster behind it is
/// taken at twice that, so a pinch to full zoom finds a bitmap that still has
/// pixels to show; `(x, y)` is the top-left of the typeset result at the
/// requested size, exactly as it is for `text`.
struct MathTextElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .mathText
    var x: CGFloat
    var y: CGFloat
    var latex: String
    var fontSize: CGFloat
    var style: BoardStyle = BoardStyle()

    enum CodingKeys: String, CodingKey {
        case id, kind, x, y, latex, style
        case fontSize = "font_size"
    }
}

/// A picture the server already holds, placed on the board by its key.
///
/// The bytes never travel in the scene. `blobId` names a blob a tool put in the
/// store — a photograph `fetch_image` downloaded, a chart the code interpreter
/// drew — and the device fetches it once from `GET /v1/blobs/{key}` and keeps
/// it on disk. That is what lets one picture sit in a scene the model rewrites
/// every turn without paying for it again, and it is why this element is a
/// string rather than a payload: the same scene is round-tripped into the
/// model's context on every turn.
///
/// The frame is the layout, not the picture's own pixel size: the bitmap is
/// drawn into `(x, y, width, height)` whatever shape it arrives in, and until
/// it arrives that rectangle is filled with a placeholder. So the frame is the
/// element's bounds from the moment the model places it, unlike `math_text`,
/// whose size only the typesetter knows. `BoardImageStore` is what turns the
/// key into the bitmap.
struct ImageElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .image
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat
    /// `sha256:` and 64 lowercase hexadecimal characters — the shape both
    /// `server/app/tutor/board_scene.py` and `GET /v1/blobs/{key}` insist on.
    /// Nothing here checks it; `BoardImageStore` does, before the string is
    /// ever allowed to name a file or a URL.
    var blobId: String
    var style: BoardStyle = BoardStyle()

    enum CodingKeys: String, CodingKey {
        case id, kind, x, y, width, height, style
        case blobId = "blob_id"
    }
}

/// A complete raw SVG document, preserved byte-for-byte and parsed locally on
/// the iPad by `BoardSVGStore`.
///
/// A figure normally has no frame. The document's `viewBox` is drawn one user
/// unit to one board point with its top-left corner at `(x, y)`, so the model
/// sizes the figure exactly once, in the markup, and it sits in the same space
/// as every other element. The SVG owns its internal styling, while the shared
/// `BoardStyle` still carries scene-level opacity and rotation.
struct SVGElement: Codable, Hashable, Sendable {
    var id: String
    var kind: BoardElementKind = .svg
    var x: CGFloat
    var y: CGFloat
    /// The box the whole document is scaled into, or `nil` for its own size.
    ///
    /// The legacy path, and the reason it survives: every scene persisted
    /// before the frameless contract carries one, and a restored board has to
    /// look the way the learner left it. See `frame`.
    var width: CGFloat?
    var height: CGFloat?
    var svg: String
    var style: BoardStyle = BoardStyle()

    /// The rectangle the whole document is scaled to fit inside, in board
    /// points, when the model asked for one.
    ///
    /// Both axes or neither. A length of 0 reaches this type as `nil` (see
    /// `WireElement`), so an element carrying one number is a half-frame the
    /// device could not fit anything into — the document's own size is the
    /// only sane reading of it, and that is what `nil` here produces.
    var frame: CGRect? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }
}

/// The discriminated primitive union, encoded exactly as the server sends it.
enum BoardElement: Codable, Hashable, Sendable {
    case text(TextElement)
    case line(LineElement)
    case arrow(ArrowElement)
    case rectangle(RectangleElement)
    case ellipse(EllipseElement)
    case circle(CircleElement)
    case polygon(PolygonElement)
    case polyline(PolylineElement)
    case freehand(FreehandElement)
    case arc(ArcElement)
    case angleMarker(AngleMarkerElement)
    case path(PathElement)
    case mathText(MathTextElement)
    case image(ImageElement)
    case svg(SVGElement)

    var id: String {
        switch self {
        case .text(let value): value.id
        case .line(let value): value.id
        case .arrow(let value): value.id
        case .rectangle(let value): value.id
        case .ellipse(let value): value.id
        case .circle(let value): value.id
        case .polygon(let value): value.id
        case .polyline(let value): value.id
        case .freehand(let value): value.id
        case .arc(let value): value.id
        case .angleMarker(let value): value.id
        case .path(let value): value.id
        case .mathText(let value): value.id
        case .image(let value): value.id
        case .svg(let value): value.id
        }
    }

    var kind: BoardElementKind {
        switch self {
        case .text: .text
        case .line: .line
        case .arrow: .arrow
        case .rectangle: .rectangle
        case .ellipse: .ellipse
        case .circle: .circle
        case .polygon: .polygon
        case .polyline: .polyline
        case .freehand: .freehand
        case .arc: .arc
        case .angleMarker: .angleMarker
        case .path: .path
        case .mathText: .mathText
        case .image: .image
        case .svg: .svg
        }
    }

    var style: BoardStyle {
        switch self {
        case .text(let value): value.style
        case .line(let value): value.style
        case .arrow(let value): value.style
        case .rectangle(let value): value.style
        case .ellipse(let value): value.style
        case .circle(let value): value.style
        case .polygon(let value): value.style
        case .polyline(let value): value.style
        case .freehand(let value): value.style
        case .arc(let value): value.style
        case .angleMarker(let value): value.style
        case .path(let value): value.style
        case .mathText(let value): value.style
        case .image(let value): value.style
        case .svg(let value): value.style
        }
    }

    private enum KindKey: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
        let wire = try WireElement(from: decoder)
        switch wire.kind {
        case .text:
            self = .text(TextElement(
                id: wire.id,
                kind: .text,
                x: wire.x ?? 0,
                y: wire.y ?? 0,
                text: wire.text ?? "",
                fontSize: wire.fontSize ?? 24,
                alignment: wire.alignment ?? .left,
                width: wire.width ?? 0,
                style: wire.style
            ))
        case .line:
            self = .line(LineElement(
                id: wire.id,
                kind: .line,
                x1: wire.x1 ?? 0,
                y1: wire.y1 ?? 0,
                x2: wire.x2 ?? 0,
                y2: wire.y2 ?? 0,
                style: wire.style
            ))
        case .arrow:
            self = .arrow(ArrowElement(
                id: wire.id,
                kind: .arrow,
                x1: wire.x1 ?? 0,
                y1: wire.y1 ?? 0,
                x2: wire.x2 ?? 0,
                y2: wire.y2 ?? 0,
                headSize: wire.headSize ?? 12,
                style: wire.style
            ))
        case .rectangle:
            self = .rectangle(RectangleElement(
                id: wire.id,
                kind: .rectangle,
                x: wire.x ?? 0,
                y: wire.y ?? 0,
                width: wire.width ?? 0,
                height: wire.height ?? 0,
                style: wire.style
            ))
        case .ellipse:
            self = .ellipse(EllipseElement(
                id: wire.id,
                kind: .ellipse,
                x: wire.x ?? 0,
                y: wire.y ?? 0,
                width: wire.width ?? 0,
                height: wire.height ?? 0,
                style: wire.style
            ))
        case .circle:
            self = .circle(CircleElement(
                id: wire.id,
                kind: .circle,
                cx: wire.cx ?? 0,
                cy: wire.cy ?? 0,
                radius: wire.radius ?? 0,
                style: wire.style
            ))
        case .polygon:
            self = .polygon(PolygonElement(
                id: wire.id,
                kind: .polygon,
                points: wire.points ?? [],
                style: wire.style
            ))
        case .polyline:
            self = .polyline(PolylineElement(
                id: wire.id,
                kind: .polyline,
                points: wire.points ?? [],
                style: wire.style
            ))
        case .freehand:
            self = .freehand(FreehandElement(
                id: wire.id,
                kind: .freehand,
                points: wire.points ?? [],
                style: wire.style
            ))
        case .arc:
            self = .arc(ArcElement(
                id: wire.id,
                kind: .arc,
                cx: wire.cx ?? 0,
                cy: wire.cy ?? 0,
                radius: wire.radius ?? 0,
                startAngle: wire.startAngle ?? 0,
                endAngle: wire.endAngle ?? 0,
                style: wire.style
            ))
        case .angleMarker:
            self = .angleMarker(AngleMarkerElement(
                id: wire.id,
                kind: .angleMarker,
                vertexX: wire.vertexX ?? 0,
                vertexY: wire.vertexY ?? 0,
                ray1X: wire.ray1X ?? 0,
                ray1Y: wire.ray1Y ?? 0,
                ray2X: wire.ray2X ?? 0,
                ray2Y: wire.ray2Y ?? 0,
                radius: wire.radius ?? 40,
                rightAngle: wire.rightAngle ?? false,
                style: wire.style
            ))
        case .path:
            self = .path(PathElement(
                id: wire.id,
                kind: .path,
                d: wire.d ?? "",
                fillRule: wire.fillRule ?? .nonzero,
                style: wire.style
            ))
        case .mathText:
            self = .mathText(MathTextElement(
                id: wire.id,
                kind: .mathText,
                x: wire.x ?? 0,
                y: wire.y ?? 0,
                latex: wire.latex ?? "",
                fontSize: wire.fontSize ?? 24,
                style: wire.style
            ))
        case .image:
            self = .image(ImageElement(
                id: wire.id,
                kind: .image,
                x: wire.x ?? 0,
                y: wire.y ?? 0,
                width: wire.width ?? 0,
                height: wire.height ?? 0,
                blobId: wire.blobId ?? "",
                style: wire.style
            ))
        case .svg:
            self = .svg(SVGElement(
                id: wire.id,
                kind: .svg,
                x: wire.x ?? 0,
                y: wire.y ?? 0,
                width: naturalWhenZero(wire.width),
                height: naturalWhenZero(wire.height),
                svg: wire.svg ?? "",
                style: wire.style
            ))
        }
    }

    func encode(to encoder: Encoder) throws {
        try WireElement(element: self).encode(to: encoder)
    }
}

/// One element as it decodes inside an array, tolerating a kind this build
/// does not know.
///
/// The server can add a primitive at any time, and a build already on a device
/// cannot be updated to match it. Throwing here would fail the whole array, so
/// one unrecognised element would take every element beside it with it — and
/// `TutorEvent.decode(from:)` reads the `board_update` envelope with `try?`,
/// which turns that into a board that silently stops changing. Skipping the
/// one element costs exactly what this build cannot draw, and is the same rule
/// that event already applies to whole event types it does not recognise.
///
/// Only an unknown `kind` is tolerated. A known kind carrying a malformed
/// field is a broken contract rather than version skew, and still throws.
private struct LenientElement: Decodable {
    let element: BoardElement?

    private enum CodingKeys: String, CodingKey { case kind }

    /// Skipping is silent everywhere else: no throw, no event, and a board that
    /// simply lacks an object the server believes it drew. So the skip says so
    /// once, naming the kind — which is the one thing that tells version skew
    /// (a primitive this build predates) from a server bug (a kind nothing has
    /// ever defined), and the one thing a fix needs.
    ///
    /// The kind string and nothing else. It is a wire enum case chosen by the
    /// server, not learner content, so it is safe to log in a release build;
    /// every coordinate, every label and every fragment of the learner's work
    /// stays out of it. `.public` for the same reason — an interpolation left
    /// private redacts to `<private>` on device and records nothing at all.
    private static let log = Logger(subsystem: "com.nordup.MathTutor", category: "board-scene")

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        guard BoardElementKind(rawValue: kind) != nil else {
            Self.log.error(
                "board element skipped: this build has no kind \(kind, privacy: .public)"
            )
            element = nil
            return
        }
        element = try BoardElement(from: decoder)
    }
}

private extension Array where Element == LenientElement {
    /// The elements this build understands, in wire order.
    var known: [BoardElement] { compactMap(\.element) }
}

/// The wire's "no frame" convention, read as one length.
///
/// The server's `svg` schema is strict, so every property in it is required
/// and the model cannot leave a frame out; 0 is what it writes for "draw the
/// document at the size its own `viewBox` gives it". `SVGElement` says that as
/// `nil`, and this is the one place the two spellings meet. A missing key
/// reads the same way, which is what a scene written by a build older than the
/// frame produces.
private func naturalWhenZero(_ value: CGFloat?) -> CGFloat? {
    guard let value, value > 0 else { return nil }
    return value
}

/// The flat wire shape every element arrives as: primitive geometry plus the
/// shared style keys, all in one object. `BoardElement` translates through
/// this so the public API stays a discriminated union while the JSON stays
/// exactly what the server schema defines.
private struct WireElement: Codable {
    var id: String
    var kind: BoardElementKind
    var style: BoardStyle

    var x: CGFloat?
    var y: CGFloat?
    var text: String?
    var fontSize: CGFloat?
    var alignment: BoardTextAlignment?
    var width: CGFloat?
    var height: CGFloat?

    var x1: CGFloat?
    var y1: CGFloat?
    var x2: CGFloat?
    var y2: CGFloat?
    var headSize: CGFloat?

    var cx: CGFloat?
    var cy: CGFloat?
    var radius: CGFloat?

    var points: [BoardPoint]?
    var startAngle: CGFloat?
    var endAngle: CGFloat?

    var vertexX: CGFloat?
    var vertexY: CGFloat?
    var ray1X: CGFloat?
    var ray1Y: CGFloat?
    var ray2X: CGFloat?
    var ray2Y: CGFloat?
    var rightAngle: Bool?
    var svg: String?

    var d: String?
    var fillRule: PathFillRule?

    var latex: String?

    var blobId: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, x, y, text, width, height, points, svg, d, latex
        case x1, y1, x2, y2, cx, cy, radius
        case role, stroke, fill, opacity, dash, rotation
        case fillRule = "fill_rule"
        case blobId = "blob_id"
        case fontSize = "font_size"
        case alignment
        case headSize = "head_size"
        case startAngle = "start_angle"
        case endAngle = "end_angle"
        case vertexX = "vertex_x"
        case vertexY = "vertex_y"
        case ray1X = "ray1_x"
        case ray1Y = "ray1_y"
        case ray2X = "ray2_x"
        case ray2Y = "ray2_y"
        case rightAngle = "right_angle"
        case strokeWidth = "stroke_width"
    }

    init(element: BoardElement) {
        id = element.id
        kind = element.kind
        style = element.style
        switch element {
        case .text(let value):
            x = value.x; y = value.y; text = value.text
            fontSize = value.fontSize; alignment = value.alignment; width = value.width
        case .line(let value):
            x1 = value.x1; y1 = value.y1; x2 = value.x2; y2 = value.y2
        case .arrow(let value):
            x1 = value.x1; y1 = value.y1; x2 = value.x2; y2 = value.y2
            headSize = value.headSize
        case .rectangle(let value):
            x = value.x; y = value.y; width = value.width; height = value.height
        case .ellipse(let value):
            x = value.x; y = value.y; width = value.width; height = value.height
        case .circle(let value):
            cx = value.cx; cy = value.cy; radius = value.radius
        case .polygon(let value):
            points = value.points
        case .polyline(let value):
            points = value.points
        case .freehand(let value):
            points = value.points
        case .arc(let value):
            cx = value.cx; cy = value.cy; radius = value.radius
            startAngle = value.startAngle; endAngle = value.endAngle
        case .angleMarker(let value):
            vertexX = value.vertexX; vertexY = value.vertexY
            ray1X = value.ray1X; ray1Y = value.ray1Y
            ray2X = value.ray2X; ray2Y = value.ray2Y
            radius = value.radius; rightAngle = value.rightAngle
        case .path(let value):
            d = value.d; fillRule = value.fillRule
        case .mathText(let value):
            x = value.x; y = value.y
            latex = value.latex; fontSize = value.fontSize
        case .image(let value):
            x = value.x; y = value.y; width = value.width; height = value.height
            blobId = value.blobId
        case .svg(let value):
            x = value.x; y = value.y
            // 0 rather than an absent key. The server's `svg` schema is
            // strict, which means every property is required, and a scene this
            // device sends back has to survive being read by it. Nothing is
            // lost: 0 decodes to `nil` again on the way in.
            width = value.width ?? 0; height = value.height ?? 0
            svg = value.svg
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(BoardElementKind.self, forKey: .kind)
        style = BoardStyle(
            role: try container.decodeIfPresent(BoardRole.self, forKey: .role) ?? .content,
            stroke: try container.decodeIfPresent(String.self, forKey: .stroke) ?? "#0A0A0A",
            fill: try container.decodeIfPresent(String.self, forKey: .fill) ?? "transparent",
            strokeWidth: try container.decodeIfPresent(CGFloat.self, forKey: .strokeWidth) ?? 4,
            opacity: try container.decodeIfPresent(CGFloat.self, forKey: .opacity) ?? 1,
            dash: try container.decodeIfPresent([CGFloat].self, forKey: .dash) ?? [],
            rotation: try container.decodeIfPresent(CGFloat.self, forKey: .rotation) ?? 0
        )
        x = try container.decodeIfPresent(CGFloat.self, forKey: .x)
        y = try container.decodeIfPresent(CGFloat.self, forKey: .y)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        fontSize = try container.decodeIfPresent(CGFloat.self, forKey: .fontSize)
        alignment = try container.decodeIfPresent(BoardTextAlignment.self, forKey: .alignment)
        width = try container.decodeIfPresent(CGFloat.self, forKey: .width)
        height = try container.decodeIfPresent(CGFloat.self, forKey: .height)
        x1 = try container.decodeIfPresent(CGFloat.self, forKey: .x1)
        y1 = try container.decodeIfPresent(CGFloat.self, forKey: .y1)
        x2 = try container.decodeIfPresent(CGFloat.self, forKey: .x2)
        y2 = try container.decodeIfPresent(CGFloat.self, forKey: .y2)
        headSize = try container.decodeIfPresent(CGFloat.self, forKey: .headSize)
        cx = try container.decodeIfPresent(CGFloat.self, forKey: .cx)
        cy = try container.decodeIfPresent(CGFloat.self, forKey: .cy)
        radius = try container.decodeIfPresent(CGFloat.self, forKey: .radius)
        points = try container.decodeIfPresent([BoardPoint].self, forKey: .points)
        startAngle = try container.decodeIfPresent(CGFloat.self, forKey: .startAngle)
        endAngle = try container.decodeIfPresent(CGFloat.self, forKey: .endAngle)
        vertexX = try container.decodeIfPresent(CGFloat.self, forKey: .vertexX)
        vertexY = try container.decodeIfPresent(CGFloat.self, forKey: .vertexY)
        ray1X = try container.decodeIfPresent(CGFloat.self, forKey: .ray1X)
        ray1Y = try container.decodeIfPresent(CGFloat.self, forKey: .ray1Y)
        ray2X = try container.decodeIfPresent(CGFloat.self, forKey: .ray2X)
        ray2Y = try container.decodeIfPresent(CGFloat.self, forKey: .ray2Y)
        rightAngle = try container.decodeIfPresent(Bool.self, forKey: .rightAngle)
        svg = try container.decodeIfPresent(String.self, forKey: .svg)
        d = try container.decodeIfPresent(String.self, forKey: .d)
        fillRule = try container.decodeIfPresent(PathFillRule.self, forKey: .fillRule)
        latex = try container.decodeIfPresent(String.self, forKey: .latex)
        blobId = try container.decodeIfPresent(String.self, forKey: .blobId)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encode(style.role, forKey: .role)
        try container.encode(style.stroke, forKey: .stroke)
        try container.encode(style.fill, forKey: .fill)
        try container.encode(style.strokeWidth, forKey: .strokeWidth)
        try container.encode(style.opacity, forKey: .opacity)
        try container.encode(style.dash, forKey: .dash)
        try container.encode(style.rotation, forKey: .rotation)
        if let x { try container.encode(x, forKey: .x) }
        if let y { try container.encode(y, forKey: .y) }
        if let text { try container.encode(text, forKey: .text) }
        if let fontSize { try container.encode(fontSize, forKey: .fontSize) }
        if let alignment { try container.encode(alignment, forKey: .alignment) }
        if let width { try container.encode(width, forKey: .width) }
        if let height { try container.encode(height, forKey: .height) }
        if let x1 { try container.encode(x1, forKey: .x1) }
        if let y1 { try container.encode(y1, forKey: .y1) }
        if let x2 { try container.encode(x2, forKey: .x2) }
        if let y2 { try container.encode(y2, forKey: .y2) }
        if let headSize { try container.encode(headSize, forKey: .headSize) }
        if let cx { try container.encode(cx, forKey: .cx) }
        if let cy { try container.encode(cy, forKey: .cy) }
        if let radius { try container.encode(radius, forKey: .radius) }
        if let points { try container.encode(points, forKey: .points) }
        if let startAngle { try container.encode(startAngle, forKey: .startAngle) }
        if let endAngle { try container.encode(endAngle, forKey: .endAngle) }
        if let vertexX { try container.encode(vertexX, forKey: .vertexX) }
        if let vertexY { try container.encode(vertexY, forKey: .vertexY) }
        if let ray1X { try container.encode(ray1X, forKey: .ray1X) }
        if let ray1Y { try container.encode(ray1Y, forKey: .ray1Y) }
        if let ray2X { try container.encode(ray2X, forKey: .ray2X) }
        if let ray2Y { try container.encode(ray2Y, forKey: .ray2Y) }
        if let rightAngle { try container.encode(rightAngle, forKey: .rightAngle) }
        if let svg { try container.encode(svg, forKey: .svg) }
        if let d { try container.encode(d, forKey: .d) }
        if let fillRule { try container.encode(fillRule, forKey: .fillRule) }
        if let latex { try container.encode(latex, forKey: .latex) }
        if let blobId { try container.encode(blobId, forKey: .blobId) }
    }
}
