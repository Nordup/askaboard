"""Practical logical bounding boxes for the board's known scene elements.

The spatial overlap gate (`loop._BoardGate`) needs to know, at the moment a
mutation streams, where the content a model is about to place will land. The
device's renderer computes exact bounds on its side (`BoardSceneRenderer`),
but this service holds only the scene JSON, so this module recomputes a
practical *logical* box per element here. "Logical" means board points with
(0,0) at the board centre, +x right and +y down — the coordinate system the
scene string itself uses, so a box from this module can be compared directly
against `learner_ink_logical_bounds` without any origin translation.

It deliberately does not chase pixel-perfect geometry. The gate only blocks
material stacking of large framed content, so a conservative axis-aligned box
that is at least as large as the element is the safe direction to err: it can
refuse something a human reviewer might have allowed, but it never lets a
placement slide under the check.
"""

from __future__ import annotations

import json
import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass


@dataclass(frozen=True)
class LogicalBox:
    """An axis-aligned rectangle in logical board points."""

    x: float
    y: float
    width: float
    height: float

    @property
    def min_x(self) -> float:
        return self.x

    @property
    def min_y(self) -> float:
        return self.y

    @property
    def max_x(self) -> float:
        return self.x + self.width

    @property
    def max_y(self) -> float:
        return self.y + self.height

    def area(self) -> float:
        return max(0.0, self.width) * max(0.0, self.height)

    def intersects(self, other: "LogicalBox") -> bool:
        return (
            self.min_x < other.max_x and other.min_x < self.max_x
            and self.min_y < other.max_y and other.min_y < self.max_y
        )

    def intersection_area(self, other: "LogicalBox") -> float:
        if not self.intersects(other):
            return 0.0
        width = min(self.max_x, other.max_x) - max(self.min_x, other.min_x)
        height = min(self.max_y, other.max_y) - max(self.min_y, other.min_y)
        return max(0.0, width) * max(0.0, height)


#: The element kinds this module treats as large framed content. A placement
#: of one of these that overlaps an existing tutor block or the learner's ink
#: by at least a quarter of the smaller box is hard-blocked by the overlap
#: gate. Annotation-ish kinds (line, arrow, path, text, ink_text, math_text,
#: angle markers, small arcs and freehand/polyline marks) are deliberately
#: *not* here: a label over a diagram is an ordinary correction, and a human
#: review handles those rather than a hard block.
FRAMED_KINDS = frozenset({
    "image", "svg", "rectangle", "ellipse", "circle", "polygon",
})

#: Shantell Sans Regular metrics per em, measured from the font both clients
#: bundle: cap height, ascent + descent (the line pitch), and a slightly
#: generous mean advance for prose. An `ink_text` box is estimated from these,
#: so it matches what the device draws rather than a generic sans guess.
INK_CAP_HEIGHT = 0.709
INK_LINE_HEIGHT = 1.34
INK_ADVANCE = 0.52

#: Mean advance of the clients' system sans for typeset `text`, per em.
TEXT_ADVANCE = 0.56

#: Kinds whose box here is a placeholder rather than an estimate of the drawn
#: extent (typeset LaTeX's width cannot be known without typesetting it), so
#: they are not held to the visible-board rule.
UNMEASURED_KINDS = frozenset({"math_text"})

#: How far, in board points, an estimated box may cross the visible edge
#: before a placement is refused. Absorbs estimate noise, not real overflow.
VISIBLE_EDGE_TOLERANCE = 4.0

#: The conservative threshold: a new framed block must overlap an existing
#: tutor block or the learner's ink by at least this fraction of the *smaller*
#: box before it is hard-blocked. 25% keeps ordinary near-misses and labels
#: clear while still catching an image dropped on top of an existing figure.
OVERLAP_THRESHOLD = 0.25


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and value == value  # not NaN


def _number(data: dict, key: str, fallback: float = 0.0) -> float:
    value = data.get(key)
    if isinstance(value, bool) or not _finite(value):
        return fallback
    return float(value)


_LENGTH_RE = re.compile(r"^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*(?:px|pt|pc|mm|cm|in)?\s*$")


def _length(value: object) -> float | None:
    """A CSS-ish length from an SVG attribute, dropping any unit suffix."""
    if not isinstance(value, str):
        return None
    match = _LENGTH_RE.match(value)
    if not match:
        return None
    return float(match.group(1))


def _box(x: float, y: float, width: float, height: float) -> LogicalBox | None:
    if width is None or height is None:
        return None
    width = float(width)
    height = float(height)
    if not _finite(width) or not _finite(height):
        return None
    if width <= 0 or height <= 0:
        return None
    return LogicalBox(x=float(x), y=float(y), width=width, height=height)


def _parse_points(data: dict) -> list[tuple[float, float]]:
    points = data.get("points")
    if not isinstance(points, list):
        return []
    parsed: list[tuple[float, float]] = []
    for point in points:
        if (
            isinstance(point, (list, tuple)) and len(point) == 2
            and _finite(point[0]) and _finite(point[1])
        ):
            parsed.append((float(point[0]), float(point[1])))
    return parsed


def _points_box(points: list[tuple[float, float]]) -> LogicalBox | None:
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    if width <= 0 or height <= 0:
        return None
    return LogicalBox(
        x=min(xs), y=min(ys), width=width, height=height,
    )


_NUMBER_TOKEN = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
_VIEWBOX_RE = re.compile(
    r"^\s*(" + _NUMBER_TOKEN + r")\s*[, ]\s*(" + _NUMBER_TOKEN
    + r")\s*[, ]\s*(" + _NUMBER_TOKEN + r")\s*[, ]\s*("
    + _NUMBER_TOKEN + r")\s*$"
)


def _svg_document_box(root: dict) -> LogicalBox | None:
    """The document's declared size, read safely from an svg element's markup.

    Mirrors the device rendering model: a positive frame is scaled into, and a
    frameless document draws at its own size (the `viewBox` when present, else
    `width`/`height`, else the drop of whatever is unparseable). Reading markup
    with the stdlib XML parser keeps the geometry pass free of external
    entities and scripts; a document that does not parse simply yields no box
    rather than spending the rest of the turn on it.
    """
    width = _number(root, "width")
    height = _number(root, "height")
    if width > 0 and height > 0:
        return _box(_number(root, "x"), _number(root, "y"), width, height)

    svg = root.get("svg")
    if not isinstance(svg, str) or not svg.strip():
        return None
    try:
        element = ET.fromstring(svg)
    except ET.ParseError:
        return None

    view_box = (element.get("viewBox") or element.get("viewbox") or "").strip()
    if view_box:
        match = _VIEWBOX_RE.match(view_box)
        if match:
            values = [float(part) for part in match.groups()]
            # viewBox is min-x min-y width height, and the document is drawn
            # with its top-left at (x, y).
            return _box(
                _number(root, "x", 0.0) - values[0],
                _number(root, "y", 0.0) - values[1],
                values[2],
                values[3],
            )

    attr_width = element.get("width")
    attr_height = element.get("height")
    if attr_width is not None and attr_height is not None:
        parsed_width = _length(attr_width)
        parsed_height = _length(attr_height)
        if parsed_width is None or parsed_height is None:
            return None
        if parsed_width <= 0 or parsed_height <= 0:
            return None
        return _box(
            _number(root, "x", 0.0),
            _number(root, "y", 0.0),
            parsed_width,
            parsed_height,
        )
    return None


def element_logical_bounds(element: dict) -> LogicalBox | None:
    """The practical logical box for one scene element, or None when none can
    be computed (zero-area, unparseable, or an annotation kind without useful
    bounds). The None answer is a *non-answer*: it means "no geometry to
    block on", and the gate treats it as fitting anywhere."""
    kind = element.get("kind")
    if kind == "image":
        return _box(
            _number(element, "x"), _number(element, "y"),
            _number(element, "width"), _number(element, "height"),
        )
    if kind == "rectangle" or kind == "ellipse":
        return _box(
            _number(element, "x"), _number(element, "y"),
            _number(element, "width"), _number(element, "height"),
        )
    if kind == "circle":
        radius = _number(element, "radius")
        if radius <= 0:
            return None
        return _box(
            _number(element, "cx") - radius,
            _number(element, "cy") - radius,
            radius * 2,
            radius * 2,
        )
    if kind == "polygon":
        return _points_box(_parse_points(element))
    if kind == "svg":
        return _svg_document_box(element)
    # Annotation and text-like kinds get practical bounds when feasible, so the
    # prompt's "inspect the full board" guidance can speak to them, but they
    # are never hard-blocked on their own. Returning None here is the safe
    # conservative choice for the gate: no geometry means no block.
    if kind == "text":
        size = max(8.0, _number(element, "font_size"))
        text = element.get("text")
        lines = text.split("\n") if isinstance(text, str) and text else [""]
        width = _number(element, "width")
        if width > 0:
            # Both clients wrap at `width`; count the wrapped lines.
            count = sum(
                max(1, math.ceil(len(line) * size * TEXT_ADVANCE / width))
                for line in lines
            )
        else:
            count = len(lines)
            width = size * TEXT_ADVANCE * max(1, max(len(line) for line in lines))
        return _box(_number(element, "x"), _number(element, "y"),
                    width, size * (0.3 + 1.2 * count))
    if kind == "line" or kind == "arrow":
        return _box(
            min(_number(element, "x1"), _number(element, "x2")),
            min(_number(element, "y1"), _number(element, "y2")),
            abs(_number(element, "x2") - _number(element, "x1")),
            abs(_number(element, "y2") - _number(element, "y1")),
        )
    if kind == "polyline" or kind == "freehand":
        return _points_box(_parse_points(element))
    if kind == "ink_text":
        size = _number(element, "size")
        if size <= 0:
            return None
        text = element.get("text")
        if not isinstance(text, str) or not text:
            return None
        # `size` is the cap height; both clients scale Shantell Sans so its
        # capitals stand that tall (iPad `InkTextRenderer.uiFont`, web
        # `inkTextLayout`), draw only explicit `\n` lines, and advance each
        # line by the font's ascent + descent.
        em = min(256.0, max(8.0, size)) / INK_CAP_HEIGHT
        lines = text[:400].split("\n")
        width = em * INK_ADVANCE * max(1, max(len(line) for line in lines))
        height = em * INK_LINE_HEIGHT * len(lines)
        return _box(_number(element, "x"), _number(element, "y"),
                    width, height)
    if kind == "math_text":
        size = _number(element, "font_size")
        if size <= 0:
            return None
        return _box(_number(element, "x"), _number(element, "y"),
                    size * 6, size * 1.4)
    if kind == "angle_marker":
        radius = _number(element, "radius", 40.0)
        return _box(
            _number(element, "vertex_x") - radius,
            _number(element, "vertex_y") - radius,
            radius * 2,
            radius * 2,
        )
    if kind == "arc":
        radius = _number(element, "radius")
        if radius <= 0:
            return None
        return _box(
            _number(element, "cx") - radius, _number(element, "cy") - radius,
            radius * 2, radius * 2,
        )
    return None


def scene_tutor_blocks(
    scene: str | None,
) -> list[tuple[str, LogicalBox]]:
    """Every tutor element's id with its practical logical box, from a scene
    string. Returns an empty list for a scene that is absent, unparseable, or
    carries no `tutor_elements`/legacy `elements`. Geometry that cannot be
    computed is skipped rather than guessed."""
    if not scene:
        return []
    try:
        root = json.loads(scene)
    except (ValueError, TypeError):
        return []
    if not isinstance(root, dict):
        return []
    elements = root.get("tutor_elements")
    if not isinstance(elements, list):
        elements = root.get("elements")
    if not isinstance(elements, list):
        return []

    blocks: list[tuple[str, LogicalBox]] = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        box = element_logical_bounds(element)
        if box is None:
            continue
        ident = element.get("id")
        if not isinstance(ident, str) or not ident:
            continue
        blocks.append((ident, box))
    return blocks


def scene_is_truncated(scene: str | None) -> bool:
    """Whether the device omitted tutor elements from this scene envelope."""
    if not scene:
        return False
    try:
        root = json.loads(scene)
    except (ValueError, TypeError):
        return False
    return isinstance(root, dict) and root.get("truncated") is True


def learner_ink_bounds(scene: str | None) -> LogicalBox | None:
    """The learner's ink logical bounds from a `board_scene_context` envelope,
    if present and parseable as `[minX, minY, maxX, maxY]`."""
    if not scene:
        return None
    try:
        root = json.loads(scene)
    except (ValueError, TypeError):
        return None
    if not isinstance(root, dict):
        return None
    raw = root.get("learner_ink_logical_bounds")
    if (
        isinstance(raw, list) and len(raw) == 4
        and all(_finite(v) for v in raw)
    ):
        min_x, min_y, max_x, max_y = (float(v) for v in raw)
        if max_x > min_x and max_y > min_y:
            return LogicalBox(
                x=min_x, y=min_y, width=max_x - min_x, height=max_y - min_y,
            )
    return None


def visible_bounds(scene: str | None) -> LogicalBox | None:
    """The learner's visible board, `visible_logical_rect` from a
    `board_scene_context` envelope, if present and well formed."""
    if not scene:
        return None
    try:
        root = json.loads(scene)
    except (ValueError, TypeError):
        return None
    if not isinstance(root, dict):
        return None
    raw = root.get("visible_logical_rect")
    if (
        isinstance(raw, list) and len(raw) == 4
        and all(_finite(v) and not isinstance(v, bool) for v in raw)
    ):
        min_x, min_y, max_x, max_y = (float(v) for v in raw)
        if max_x > min_x and max_y > min_y:
            return LogicalBox(
                x=min_x, y=min_y, width=max_x - min_x, height=max_y - min_y,
            )
    return None


def overflow_edges(box: LogicalBox, visible: LogicalBox) -> list[str]:
    """Which edges of the visible board `box` crosses, beyond the tolerance."""
    t = VISIBLE_EDGE_TOLERANCE
    edges = []
    if box.min_x < visible.min_x - t:
        edges.append(f"left edge (x {visible.min_x:g})")
    if box.max_x > visible.max_x + t:
        edges.append(f"right edge (x {visible.max_x:g})")
    if box.min_y < visible.min_y - t:
        edges.append(f"top edge (y {visible.min_y:g})")
    if box.max_y > visible.max_y + t:
        edges.append(f"bottom edge (y {visible.max_y:g})")
    return edges


def overlap_fraction(new_box: LogicalBox, existing_box: LogicalBox) -> float:
    """What fraction of the *smaller* box the two overlap by, 0..1."""
    smaller = min(new_box.area(), existing_box.area())
    if smaller <= 0:
        return 0.0
    return new_box.intersection_area(existing_box) / smaller
