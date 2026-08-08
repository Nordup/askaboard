import CoreGraphics
import Foundation

/// The tutor-authored semantic layer on the whiteboard.
///
/// Learner handwriting stays a `PKDrawing`; this is a separate structured scene
/// of text and geometry that the model can revise by stable id. It is pure
/// Domain state: no UIKit, no SwiftUI, and no renderer. Coordinates are logical
/// board points with (0,0) at `PencilCanvasConfiguration.boardOrigin`,
/// +x right and +y down.
struct BoardScene: Codable, Equatable, Sendable {
    var elements: [BoardElement]

    static var empty: BoardScene { BoardScene(elements: []) }

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
            upserts = try container.decodeIfPresent([BoardElement].self, forKey: .upserts) ?? []
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
        upserts = try decode([BoardElement].self, "elements") ?? []
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
}

/// Style fields shared by every primitive; all are present on the wire.
struct BoardStyle: Codable, Equatable, Sendable {
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

struct TextElement: Codable, Equatable, Sendable {
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

struct LineElement: Codable, Equatable, Sendable {
    var id: String
    var kind: BoardElementKind = .line
    var x1: CGFloat
    var y1: CGFloat
    var x2: CGFloat
    var y2: CGFloat
    var style: BoardStyle = BoardStyle()
}

struct ArrowElement: Codable, Equatable, Sendable {
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

struct RectangleElement: Codable, Equatable, Sendable {
    var id: String
    var kind: BoardElementKind = .rectangle
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat
    var style: BoardStyle = BoardStyle()
}

struct EllipseElement: Codable, Equatable, Sendable {
    var id: String
    var kind: BoardElementKind = .ellipse
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat
    var style: BoardStyle = BoardStyle()
}

struct CircleElement: Codable, Equatable, Sendable {
    var id: String
    var kind: BoardElementKind = .circle
    var cx: CGFloat
    var cy: CGFloat
    var radius: CGFloat
    var style: BoardStyle = BoardStyle()
}

struct PolygonElement: Codable, Equatable, Sendable {
    var id: String
    var kind: BoardElementKind = .polygon
    var points: [BoardPoint]
    var style: BoardStyle = BoardStyle()
}

struct PolylineElement: Codable, Equatable, Sendable {
    var id: String
    var kind: BoardElementKind = .polyline
    var points: [BoardPoint]
    var style: BoardStyle = BoardStyle()
}

struct FreehandElement: Codable, Equatable, Sendable {
    var id: String
    var kind: BoardElementKind = .freehand
    var points: [BoardPoint]
    var style: BoardStyle = BoardStyle()
}

/// A logical board point encoded as `[x, y]`, matching the wire contract.
struct BoardPoint: Codable, Equatable, Sendable {
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

struct ArcElement: Codable, Equatable, Sendable {
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

struct AngleMarkerElement: Codable, Equatable, Sendable {
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

/// The discriminated primitive union, encoded exactly as the server sends it.
enum BoardElement: Codable, Equatable, Sendable {
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
        }
    }

    func encode(to encoder: Encoder) throws {
        try WireElement(element: self).encode(to: encoder)
    }
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

    enum CodingKeys: String, CodingKey {
        case id, kind, x, y, text, width, height, points
        case x1, y1, x2, y2, cx, cy, radius
        case role, stroke, fill, opacity, dash, rotation
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
    }
}
