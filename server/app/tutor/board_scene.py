"""The tutor-authored semantic board scene.

The learner's PencilKit handwriting stays a ``PKDrawing`` on the iPad. What the
tutor draws is a separate, structured scene of text and geometry, because it has
to be editable: the model may revisit, correct, or delete its own content by
stable id, and a flattened bitmap could never answer "update the arrow I drew
last turn". Every value here is model-authored, so the server validates and
clamps before anything reaches the device, and every wire field is chosen to
mirror ``MathTutor/Domain/BoardScene.swift`` exactly.
"""

from __future__ import annotations

import json
import math
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

#: How much model output one update may carry. Large enough for a diagram, small
#: enough that a runaway loop cannot push a megabyte of geometry at the device.
MAX_ELEMENTS_PER_UPDATE = 200
MAX_DELETES_PER_UPDATE = 200
MAX_POINTS_PER_ELEMENT = 512
MAX_ID_LENGTH = 128
#: Hard cap on the scene string the device sends back in `TurnRequest`.
#: Context already truncates this value, but the request itself should refuse
#: an over-limit scene rather than paying for it twice.
MAX_SCENE_CHARS = 60_000
#: Maximum length of one raw SVG document. Kept well under the scene cap so a
#: complex illustration plus ids and surrounding elements still fits in the
#: 60,000-character scene string the device sends back on every turn.
MAX_SVG_CHARS = 40_000
#: Maximum length of one path's `d` string. A path is a single shape rather
#: than a whole document, so it needs far less room than raw SVG, and a runaway
#: curve list is the cheapest way for one element to fill the scene budget.
MAX_PATH_CHARS = 20_000
#: Maximum length of one LaTeX fragment. Notation is short: 2,000 characters is
#: already a very long expression, and the same figure caps plain text.
MAX_LATEX_CHARS = 2_000

#: The logical board is 50,000 points on a side centred on the drawing-space
#: origin (25,000, 25,000), so the valid logical range is -25,000...25,000 on
#: each axis. The clamp is deliberately a little generous only where a stroke
#: width or text box could reasonably hang past a shape: an element that
#: straddles the edge stays visible instead of vanishing.
MIN_COORDINATE = -25_000.0
MAX_COORDINATE = 25_000.0
MAX_DIMENSION = 50_000.0
MIN_FONT_SIZE = 8.0
MAX_FONT_SIZE = 256.0
MIN_STROKE_WIDTH = 0.5
MAX_STROKE_WIDTH = 60.0
MAX_ARC_RADIUS = 50_000.0
MAX_HEAD_SIZE = 120.0

_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_ID_RE = re.compile(r"^[A-Za-z0-9._:+-]{1,128}$")
#: The shape of every key the blob store writes, and the one shape
#: `GET /v1/blobs/{key}` serves — `app/api/sessions.py` gates the same pattern
#: before it builds a filesystem path out of the string. Restated rather than
#: imported: this module is the wire contract and holds no API import.
_BLOB_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

BoardRole = Literal["content", "hint", "correction", "emphasis"]
TextAlignment = Literal["left", "center", "right"]
BoardMode = Literal["upsert", "replace_all"]


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _finite(value: float) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def _validated_document(value: str, *, name: str, limit: int) -> str:
    """One model-authored document the device parses and the server does not.

    `svg`, `d`, and `latex` are all markup rather than values this side
    understands, so the checks are the same three: a string, something to draw,
    and a length the scene budget can carry. An over-long one is refused with
    its cap named instead of truncated, because half a path or half an
    expression is markup the device cannot parse — it would render as nothing,
    with no error anywhere. Refusing it tells the model to write a shorter one.
    """
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    if not value:
        raise ValueError(f"{name} must not be empty")
    if len(value) > limit:
        raise ValueError(f"{name} must be at most {limit} characters; got {len(value)}")
    return value


def _validated_font_size(value: float) -> float:
    """Shared by every element that sets type, so one range governs all of it."""
    if not _finite(value):
        raise ValueError("font_size must be a finite number")
    return _clamp(value, MIN_FONT_SIZE, MAX_FONT_SIZE)


class BoardStyle(BaseModel):
    """The style every primitive shares. `fill` is "transparent" when absent."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    role: BoardRole = "content"
    stroke: str = "#0A0A0A"
    fill: str = "transparent"
    stroke_width: float = 4.0
    opacity: float = 1.0
    dash: list[float] = Field(default_factory=list)
    rotation: float = 0.0

    @field_validator("stroke", "fill")
    @classmethod
    def _colour(cls, value: str) -> str:
        if value != "transparent" and _COLOR_RE.fullmatch(value) is None:
            raise ValueError(f"colour must be #RRGGBB or transparent: {value!r}")
        return value

    @field_validator("stroke_width")
    @classmethod
    def _stroke_width(cls, value: float) -> float:
        if not _finite(value):
            raise ValueError("stroke_width must be a finite number")
        return _clamp(value, MIN_STROKE_WIDTH, MAX_STROKE_WIDTH)

    @field_validator("opacity")
    @classmethod
    def _opacity(cls, value: float) -> float:
        if not _finite(value):
            raise ValueError("opacity must be a finite number")
        return _clamp(value, 0.0, 1.0)

    @field_validator("rotation")
    @classmethod
    def _rotation(cls, value: float) -> float:
        if not _finite(value):
            raise ValueError("rotation must be a finite number")
        return value % 360.0

    @field_validator("dash")
    @classmethod
    def _dash(cls, value: list[float]) -> list[float]:
        if len(value) > 8:
            value = value[:8]
        return [_clamp(item, 0.0, 200.0) if _finite(item) else 0.0 for item in value]


class _Identified(BoardStyle):
    id: str

    @field_validator("id")
    @classmethod
    def _identifier(cls, value: str) -> str:
        if not isinstance(value, str):
            raise ValueError("id must be a string")
        value = value.strip()
        if not value or len(value) > MAX_ID_LENGTH or _ID_RE.fullmatch(value) is None:
            raise ValueError(
                f"id must be 1-{MAX_ID_LENGTH} characters of letters, digits, "
                "dots, underscores, colons, plus, or hyphen"
            )
        return value

    @model_validator(mode="before")
    @classmethod
    def _clamp_geometry(cls, data: dict) -> dict:
        """Clamp model-authored geometry without assuming every element has it.

        Each element only carries the keys its primitive uses, so the clamps
        below are applied to whatever is present. Unknown keys are rejected
        later by `additionalProperties`-style validation (strict schemas).
        """
        if not isinstance(data, dict):
            return data
        for key in ("x", "y", "x1", "y1", "x2", "y2", "cx", "cy",
                    "vertex_x", "vertex_y", "ray1_x", "ray1_y",
                    "ray2_x", "ray2_y"):
            if key in data and _finite(data[key]):
                data[key] = _clamp(data[key], MIN_COORDINATE, MAX_COORDINATE)
        for key in ("width", "height", "radius"):
            if key in data and _finite(data[key]):
                data[key] = _clamp(data[key], 0.0, MAX_DIMENSION)
        return data


class TextElement(_Identified):
    kind: Literal["text"] = "text"
    x: float
    y: float
    text: str
    font_size: float
    alignment: TextAlignment = "left"
    #: Text box width in board points; 0 means the text's natural width.
    width: float = 0.0

    @field_validator("text")
    @classmethod
    def _text(cls, value: str) -> str:
        if not isinstance(value, str):
            raise ValueError("text must be a string")
        return value[:2_000]

    @field_validator("font_size")
    @classmethod
    def _font_size(cls, value: float) -> float:
        return _validated_font_size(value)


class LineElement(_Identified):
    kind: Literal["line"] = "line"
    x1: float
    y1: float
    x2: float
    y2: float


class ArrowElement(_Identified):
    kind: Literal["arrow"] = "arrow"
    x1: float
    y1: float
    x2: float
    y2: float
    head_size: float = 12.0

    @field_validator("head_size")
    @classmethod
    def _head_size(cls, value: float) -> float:
        if not _finite(value):
            raise ValueError("head_size must be a finite number")
        return _clamp(value, 4.0, MAX_HEAD_SIZE)


class RectangleElement(_Identified):
    kind: Literal["rectangle"] = "rectangle"
    x: float
    y: float
    width: float
    height: float


class EllipseElement(_Identified):
    kind: Literal["ellipse"] = "ellipse"
    x: float
    y: float
    width: float
    height: float


class CircleElement(_Identified):
    kind: Literal["circle"] = "circle"
    cx: float
    cy: float
    radius: float


def _validated_points(points: list, minimum: int) -> list[list[float]]:
    if not isinstance(points, list) or len(points) < minimum:
        raise ValueError(f"points must be an array of at least {minimum} [x, y] pairs")
    result: list[list[float]] = []
    for point in points[:MAX_POINTS_PER_ELEMENT]:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise ValueError("each point must be [x, y]")
        x, y = point
        if not _finite(x) or not _finite(y):
            raise ValueError("point coordinates must be finite numbers")
        result.append([
            _clamp(float(x), MIN_COORDINATE, MAX_COORDINATE),
            _clamp(float(y), MIN_COORDINATE, MAX_COORDINATE),
        ])
    return result


class _Pointed(_Identified):
    points: list = Field(default_factory=list)

    @model_validator(mode="after")
    def _points(self):
        minimum = 3 if self.kind == "polygon" else 2
        self.points = _validated_points(self.points, minimum)
        return self


class PolygonElement(_Pointed):
    kind: Literal["polygon"] = "polygon"


class PolylineElement(_Pointed):
    kind: Literal["polyline"] = "polyline"


class FreehandElement(_Pointed):
    kind: Literal["freehand"] = "freehand"


class ArcElement(_Identified):
    kind: Literal["arc"] = "arc"
    cx: float
    cy: float
    radius: float
    start_angle: float
    end_angle: float

    @field_validator("start_angle", "end_angle")
    @classmethod
    def _angle(cls, value: float) -> float:
        if not _finite(value):
            raise ValueError("angles must be finite numbers")
        return value % 360.0


class AngleMarkerElement(_Identified):
    kind: Literal["angle_marker"] = "angle_marker"
    vertex_x: float
    vertex_y: float
    ray1_x: float
    ray1_y: float
    ray2_x: float
    ray2_y: float
    radius: float = 40.0
    right_angle: bool = False

    @field_validator("radius")
    @classmethod
    def _radius(cls, value: float) -> float:
        if not _finite(value):
            raise ValueError("radius must be a finite number")
        return _clamp(value, 4.0, MAX_ARC_RADIUS)


class PathElement(_Identified):
    """One SVG path: the curve and freeform primitive, still editable by id.

    `d` carries absolute board points rather than a local viewbox, so a path
    needs no frame and sits in the same space as every other element. That also
    means its coordinates are the one geometry here the server does not clamp:
    the numbers are inside a string it does not parse, and the device culls
    whatever falls outside the board.
    """

    kind: Literal["path"] = "path"
    d: str
    fill_rule: Literal["nonzero", "evenodd"] = "nonzero"

    @field_validator("d")
    @classmethod
    def _path_data(cls, value: str) -> str:
        return _validated_document(value, name="d", limit=MAX_PATH_CHARS)


class MathTextElement(_Identified):
    """Mathematical notation, typeset from LaTeX on the device.

    This is the only element that puts notation on the board. Notation spelled
    out as plain text, or assembled from lines and glyphs, is unreadable and
    cannot be revised. The server does not typeset the fragment and holds no
    opinion on the dialect; the device renders it with the engine chat already
    uses, so board notation and chat notation match.
    """

    kind: Literal["math_text"] = "math_text"
    x: float
    y: float
    latex: str
    font_size: float

    @field_validator("latex")
    @classmethod
    def _latex(cls, value: str) -> str:
        return _validated_document(value, name="latex", limit=MAX_LATEX_CHARS)

    @field_validator("font_size")
    @classmethod
    def _font_size(cls, value: float) -> float:
        return _validated_font_size(value)


class ImageElement(_Identified):
    """A picture the server already holds, placed on the board by its key.

    The bytes never travel in the scene: `blob_id` names a blob a tool put in
    the store, and the device downloads it from `GET /v1/blobs/{key}` and
    caches it. That is what lets one photograph or one computed chart sit in a
    scene the model rewrites every turn without paying for it again.

    Whether the blob *exists* is not checked here. Parsing a tool call touches
    no database — this whole module is pure — and a lookup would buy little:
    the id comes from a tool result the model was handed, and a key that names
    nothing renders a placeholder frame rather than failing the update.

    The frame must be a real rectangle. An image is placed by its frame rather
    than by its own pixel size, and a missing blob draws its placeholder inside
    that frame, so a zero-size one draws nothing at all — while the model reads
    an applied ack and believes a picture is on the board. Refused, not
    clamped, for the reason an empty document string is.
    """

    kind: Literal["image"] = "image"
    x: float
    y: float
    width: float
    height: float
    blob_id: str

    @field_validator("blob_id")
    @classmethod
    def _blob_id(cls, value: str) -> str:
        if not isinstance(value, str) or _BLOB_ID_RE.fullmatch(value) is None:
            raise ValueError(
                "blob_id must be a blob key from a tool result: 'sha256:' and "
                "64 lowercase hexadecimal characters"
            )
        return value

    @field_validator("width", "height")
    @classmethod
    def _extent(cls, value: float) -> float:
        # `_Identified._clamp_geometry` has already pulled the value into
        # 0...MAX_DIMENSION, so the only thing left to refuse is a frame with
        # no area — which is what a negative size arrives here as.
        if not _finite(value) or value <= 0:
            raise ValueError("image width and height must be greater than 0")
        return value


class SVGElement(_Identified):
    """Opaque raw SVG transport for complex multi-part illustrations.

    The server deliberately does not parse, whitelist, rewrite, or sanitize the
    document; the device interprets it locally. The only checks are practical
    bounds: a finite clamped frame, a non-empty document, and a generous length
    cap chosen to fit the scene limit. What the device cannot draw is named by
    `lint_svg` at the bottom of this module — as warnings the model reads on
    the tool's ack, never as a refusal that would leave the board blank.

    A figure normally has no frame. The device draws the document's `viewBox`
    one user unit to one board point, with its top-left corner at `(x, y)`, so
    the figure is authored in the same space as every other element and is
    sized exactly once. `width` and `height` stay in the strict schema — every
    property there is required, and the model cannot omit a key — so 0 is how
    "no frame" is written on the wire, and it arrives here as `None`.

    A positive frame is the legacy path, and the migration for scenes already
    on a device: the device scales the whole document to fit that box.
    """

    kind: Literal["svg"] = "svg"
    x: float
    y: float
    #: The frame the figure is scaled into, or `None` for the document's own
    #: size. See the class docstring for why 0 rather than an omitted key.
    width: float | None = None
    height: float | None = None
    svg: str

    @field_validator("width", "height")
    @classmethod
    def _frame(cls, value: float | None) -> float | None:
        """0, or anything that clamped down to it, means "natural size".

        `_clamp_geometry` has already pinned the value into 0...MAX_DIMENSION,
        so a negative frame arrives here as 0. A box with no area is not a
        frame the device could draw into — it would show nothing at all — and
        the document's own size is what the model wanted in every case that
        reaches this line.
        """
        if value is None or not _finite(value) or value <= 0:
            return None
        return value

    @field_validator("svg")
    @classmethod
    def _svg(cls, value: str) -> str:
        return _validated_document(value, name="svg", limit=MAX_SVG_CHARS)


BoardElement = Annotated[
    TextElement | LineElement | ArrowElement | RectangleElement | EllipseElement
    | CircleElement | PolygonElement | PolylineElement | FreehandElement
    | ArcElement | AngleMarkerElement | PathElement | MathTextElement
    | ImageElement | SVGElement,
    Field(discriminator="kind"),
]


class BoardSceneUpdate(BaseModel):
    """The tool call's validated arguments, before translation to an event."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    mode: BoardMode = "upsert"
    delete_ids: list[str] = Field(default_factory=list)
    elements: list[BoardElement] = Field(default_factory=list)

    @field_validator("elements")
    @classmethod
    def _cap_elements(cls, value: list[BoardElement]) -> list[BoardElement]:
        return value[:MAX_ELEMENTS_PER_UPDATE]

    @field_validator("delete_ids")
    @classmethod
    def _cap_deletes(cls, value: list[str]) -> list[str]:
        result: list[str] = []
        for item in value[:MAX_DELETES_PER_UPDATE]:
            if isinstance(item, str):
                item = item.strip()
                if 0 < len(item) <= MAX_ID_LENGTH:
                    result.append(item)
        return result


class BoardUpdatePayload(BaseModel):
    """What the `board_update` SSE event carries to the device."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    upserts: list[BoardElement] = Field(default_factory=list)
    deletes: list[str] = Field(default_factory=list)
    replace_all: bool = False


def parse_board_update(raw_arguments: str) -> tuple[BoardSceneUpdate | None, str | None]:
    """Parse and validate one `update_board` call.

    Returns `(update, None)` on success and `(None, message)` on any malformed
    input. The translator and the tool-loop ack use this one function so the
    ack can never say "applied" for a call that produced no event.
    """
    try:
        payload = json.loads(raw_arguments)
        if not isinstance(payload, dict):
            return None, "update_board arguments must be a JSON object"
        return BoardSceneUpdate.model_validate(payload), None
    except (json.JSONDecodeError, TypeError, ValidationError) as error:
        return None, str(error)


def update_payload(update: BoardSceneUpdate) -> BoardUpdatePayload:
    """The idempotent operation set the device applies."""
    replace_all = update.mode == "replace_all"
    return BoardUpdatePayload(
        upserts=update.elements,
        deletes=[] if replace_all else update.delete_ids,
        replace_all=replace_all,
    )


#: What the device's renderer does not draw, and what the model is told about
#: each. One sentence per feature: what it is, that it is unsupported, and the
#: supported thing to reach for instead — a warning that only says "no" gets
#: the same document back with the same feature in it. None of them ends in a
#: full stop, because they are joined with "; " into one line on the ack.
#:
#: `<animate` covers `<animateTransform` and `<animateMotion` as well. The
#: element spellings are the ones valid SVG uses, so the scan is case
#: sensitive: `<Filter` is not a filter, it is markup the device drops anyway.
_UNSUPPORTED_SVG_FEATURES: tuple[tuple[str, str], ...] = (
    ("<filter",
     "`<filter>` is unsupported and is not drawn: bake the effect into the "
     "artwork, or leave it out"),
    ("<animate",
     "`<animate>` is unsupported and is not drawn: the board holds one still "
     "figure, so draw the end state"),
    ("<mask",
     "`<mask>` is unsupported and is not drawn: use a clip path, or draw only "
     "the shapes that should be visible"),
    ("<foreignObject",
     "`<foreignObject>` is unsupported and is not drawn: use SVG text, or a "
     "`math_text` element for notation"),
    ("<script",
     "`<script>` is unsupported and never runs: remove it"),
)

#: Both spellings of one problem in one pattern, so a document written with the
#: namespaced form is not told about it twice — `xlink:href` ends in `href`.
_EXTERNAL_REFERENCE_RE = re.compile(r'(?:xlink:)?href="http')
_EXTERNAL_REFERENCE_WARNING = (
    'an external reference (`href="http...`) is unsupported: the device '
    "fetches nothing while it draws, so inline the artwork or place the "
    "picture with an `image` element"
)


def lint_svg(markup: str) -> list[str]:
    """Name what one raw SVG document asks for and the device cannot draw.

    Warnings, and only warnings. The element is stored and sent whatever this
    returns, because the server does not render SVG and cannot be sure what
    the document would have looked like: three-quarters of a figure on the
    board beats a refused call and a blank board. The tool's ack carries these
    lines, so the model reads them beside "applied" and revises next turn.

    The scan is textual on purpose. Well-formedness is the device's business —
    it is the thing that parses the document — and a server-side XML parse
    would reject markup that draws perfectly well, or fall over an unclosed
    tag and then report nothing at all about the features that same document
    asked for. Length and emptiness are already refused at parse time.
    """
    if not isinstance(markup, str):
        return []
    warnings = [
        warning for needle, warning in _UNSUPPORTED_SVG_FEATURES if needle in markup
    ]
    if _EXTERNAL_REFERENCE_RE.search(markup):
        warnings.append(_EXTERNAL_REFERENCE_WARNING)
    return warnings
