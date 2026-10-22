from app.learner.mastery import RELIABILITY
from app.memory.schema import MemoryCategory
from app.tutor.board_scene import (
    MAX_DELETES_PER_UPDATE,
    MAX_ELEMENTS_PER_UPDATE,
    MAX_INK_TEXT_CHARS,
    MAX_LATEX_CHARS,
    MAX_PATH_CHARS,
    MAX_SVG_CHARS,
)


SET_WORKSPACE_TOOL: dict = {
    "type": "function",
    "name": "set_workspace",
    "description": (
        "Replace the learner's session plan and board exercise. Call this only when "
        "the learner asks to create, add, replace, change, simplify, advance, or get "
        "another board exercise."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "plan": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "title": {"type": "string"},
                    "goal": {"type": "string"},
                    "outcomes": {"type": "array", "items": {"type": "string"}},
                    "steps": {"type": "array", "items": {"type": "string"}},
                    "currentStep": {"type": "integer"},
                },
                "required": ["title", "goal", "outcomes", "steps", "currentStep"],
            },
            "exercise": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "title": {"type": "string"},
                    "prompt": {"type": "string"},
                    "hint": {"type": "string"},
                    "context": {"type": "string"},
                },
                "required": ["title", "prompt", "hint", "context"],
            },
        },
        "required": ["plan", "exercise"],
    },
}

VIEW_BOARD_TOOL: dict = {
    "type": "function",
    "name": "view_board",
    "description": (
        "Look closely at part of the learner's whiteboard. The overview image in your "
        "context shows their whole board but is too small to read; call this to get a "
        "legible image of any region of it. Call it whenever answering depends on what "
        "is actually written — 'check this', 'is this right', 'what did I do wrong', or "
        "any reply that would otherwise be a guess about their working. You may call it "
        "more than once to read different parts — each region is rendered fresh on the "
        "learner's iPad at full resolution, so zooming in loses no detail. "
        "Before you draw or edit anything on a board that already has content on it, "
        "look at it here first; and after drawing, call this again to confirm how your "
        "placement rendered rather than guessing — if you see material overlap, "
        "clipping, or misalignment, correct it before you reply in prose. "
        "Never describe, quote, or grade the "
        "learner's work without having looked at it here first."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "x": {
                "type": "number",
                "description": "Left edge, percent across the overview (0-100).",
            },
            "y": {
                "type": "number",
                "description": "Top edge, percent down the overview (0-100).",
            },
            "width": {
                "type": "number",
                "description": "Region width in percent; 100 is the whole board, at readable size.",
            },
            "height": {
                "type": "number",
                "description": "Region height in percent.",
            },
        },
        "required": ["x", "y", "width", "height"],
    },
}


WEB_SEARCH_TOOL: dict = {
    "type": "function",
    "name": "web_search",
    "description": (
        "Search the current public web when the answer needs recent, changing, "
        "or externally verifiable information. Returns grounded evidence and "
        "concrete source URLs that the learner can open."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "query": {
                "type": "string",
                "description": "A focused standalone web search query.",
            },
        },
        "required": ["query"],
    },
}


#: The style fields every semantic board element carries, defined once.
#:
#: These were written out in full inside each of the twelve union arms, on the
#: reasoning that a self-contained arm is easier for a model to satisfy. The
#: cost of that turned out to be most of the tool surface: `update_board`
#: serialised to about 5,800 tokens, roughly three times the system prompt and
#: 78% of every tool definition this service sends, and eleven of the twelve
#: copies were the same bytes.
#:
#: Strict schemas take `$defs` and `$ref`, including inside `anyOf`, so the
#: duplication bought nothing that a reference does not. Each arm still lists
#: every one of these in its own `required`, so what a model must supply is
#: unchanged — only the description of it is now written once.
#:
#: Every field an arm *lists* is required, because strict function schemas have
#: no optional fields; the device defaults absent style to the same values these
#: describe. What an arm may leave out is what its own renderer never reads —
#: see `_board_element`'s `ignores`.
#:
#: `role` used to head this block: a four-value enum the model chose on every
#: element, and no arm of `BoardSceneRenderer` ever read it. It is no longer
#: asked for. It is still *accepted*: `BoardStyle` keeps the field, because
#: `extra="forbid"` would otherwise make every scene already saved on a device
#: undecodable, and the device still sends `role` back in the scene string.
_STYLE_DEFS: dict = {
    "stroke": {
        "type": "string",
        "pattern": "^#[0-9A-Fa-f]{6}$",
    },
    "fill": {
        "type": "string",
        "pattern": "^(transparent|#[0-9A-Fa-f]{6})$",
    },
    "stroke_width": {
        "type": "number",
        "minimum": 0.5,
        "maximum": 60,
        "description": "Stroke width in board points.",
    },
    "opacity": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
    },
    "dash": {
        "type": "array",
        "maxItems": 8,
        "items": {"type": "number", "minimum": 0, "maximum": 200},
        "description": "Dash pattern in board points; [] is solid.",
    },
    "rotation": {
        "type": "number",
        "description": "Clockwise degrees about the object's own centre; 0 for none.",
    },
}

#: The two other shapes every arm repeated: the id, and one [x, y] pair.
_BOARD_DEFS: dict = {
    **_STYLE_DEFS,
    "element_id": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:+-]{1,128}$",
        "description": "Stable id. Reuse it in a later call to revise this object.",
    },
    "point": {
        "type": "array",
        "items": {"type": "number"},
        "minItems": 2,
        "maxItems": 2,
        "description": "One board point as [x, y].",
    },
}

#: `$defs` lives at the root of the tool's `parameters`, so every reference is
#: rooted there too. Named once so a rename cannot leave a dangling pointer.
_POINT_REF = {"$ref": "#/$defs/point"}
_STYLE_REFS: dict = {name: {"$ref": f"#/$defs/{name}"} for name in _STYLE_DEFS}


def _board_element(
    *,
    kind: str,
    fields: dict,
    required: list[str],
    kind_description: str | None = None,
    ignores: tuple[str, ...] = (),
) -> dict:
    """One arm of the element union.

    Every arm is a singleton: `kind` names exactly one element kind, and the
    discriminator is a `const`. This is deliberate, and it is the whole point
    of the fix below.

    An OpenAI constrained decoder may lock a *multi-value* discriminator (a
    short `enum`) onto the wrong arm when the model emits a mixed array — the
    confirmed live failure coerced intended `image`/placeholder ids into
    `ellipse`/`rectangle` arms because `rectangle`/`ellipse` shared one `enum`
    arm and the decoder pinned the whole batch to it. A single `const` per arm
    leaves no room for that coercion: every kind is its own arm, and the model
    is forced to name the exact one it means.

    `ignores` names the style fields *this kind's renderer does not read*, and
    they are left out of both `properties` and `required`. A strict schema has
    no optional fields, so a listed field is one the model must write on every
    element — and a field that reaches no drawing call is pure output tokens,
    generated serially, uncached, in front of the learner. Each name here is
    named in the comment beside it, with the renderer line that proves it dead.

    Leaving a field out changes nothing the device does. Every one of them is
    still a field on `BoardStyle` on both sides — `board_scene.BoardStyle` has a
    default, and `WireElement` in `MathTutor/Domain/BoardScene.swift` reads
    every style key with `decodeIfPresent` — so an absent key decodes to the
    same value the model used to have to spell out, and a model that sends one
    anyway is still accepted.

    A name that is not a style field raises rather than being ignored: a typo
    here would silently keep a field this arm meant to drop, which is a saving
    that quietly does not happen.
    """
    unknown = [name for name in ignores if name not in _STYLE_DEFS]
    if unknown:
        raise KeyError(f"not style fields: {unknown!r}")
    discriminator: dict = {"type": "string", "const": kind}
    if kind_description:
        discriminator["description"] = kind_description
    properties: dict = {
        "id": {"$ref": "#/$defs/element_id"},
        "kind": discriminator,
    }
    properties.update(fields)
    style = {name: ref for name, ref in _STYLE_REFS.items() if name not in ignores}
    properties.update(style)
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": ["id", "kind"] + required + list(style),
    }


UPDATE_BOARD_TOOL: dict = {
    "type": "function",
    "name": "update_board",
    "description": (
        "Draw, label, correct, update, or delete the tutor's semantic objects on the "
        "learner's whiteboard. Use it whenever a visual would help them — an exercise "
        "to work on, a diagram that carries an explanation, a correction beside their "
        "work — and not only when one is asked for. Choose the "
        "element for the job: ordinary primitives — lines, arrows, shapes, arcs, "
        "angle markers, compact `text` labels — for simple geometry and short "
        "captions; `path` for curves and freeform shapes; `ink_text` for anything "
        "you say in words — a hint, encouragement, a note in the margin, "
        "commentary beside a step — written in handwriting-look ink, the way a "
        "teacher writes at a board, and reach for it often; `math_text` for every "
        "piece of mathematical notation, never plain `text`, never SVG `<text>`, "
        "and never symbols built out of primitives; `svg` for any figure made of "
        "several parts, which is what most real illustrations are — one document "
        "with a viewBox, `width` and `height` sent as 0, drawn one user unit to one "
        "board point; `image` for a photograph fetched with fetch_image or a chart "
        "a script produced, placed by the blob_id that tool answered with. "
        "This tool never touches the "
        "learner's own PencilKit ink: what you write is a tutor object in your "
        "own scene, and theirs stays theirs. Each object has a stable id: "
        "reuse ids to revise existing content and list ids in delete_ids to remove "
        "it. Pass elements=[] to only delete and delete_ids=[] to only upsert. "
        "Coordinates and every size are logical board points: (0,0) is the board "
        "centre, +x right, +y down. Inspect the current board with `view_board` "
        "before you grade, correct, or place content on it, and read the live "
        "scene supplied in context. When live layout rects are present, place "
        "new material inside `recommended_tutor_rect` and leave "
        "`reserved_learner_work_rect` clear for the learner's working. Otherwise "
        "(for example an offscreen session), inspect the full "
        "board and use the scene's learner-ink, overview, and tutor-element "
        "bounds to choose unoccupied space. In either case, do "
        "not cover or erase learner ink. Place corrections beside the relevant "
        "work rather than on top of it. After any draw or edit, call "
        "`view_board` to inspect how it rendered and correct any material "
        "overlap, clipping, or misalignment you see before replying in prose. "
        "A requested standalone exercise or diagram may be drawn on a board "
        "with no renderable content without that initial look; do not draw "
        "gratuitously for simple conversational answers. "
        "Use this for object-level edits whose separate elements need stable ids. "
        "For a standalone exercise or coherent diagram, call `draw_board_svg` instead. "
        "Never fake text, labels or equations with rectangles; rectangles are "
        "visible boxes only."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        # Referenced from inside `elements.items.anyOf`, which is allowed:
        # every arm is still a complete strict schema, it just names the parts
        # it shares with its eleven siblings instead of restating them.
        "$defs": _BOARD_DEFS,
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["upsert", "replace_all"],
                "description": "upsert applies the batch by id; replace_all clears the scene first and applies the batch.",
            },
            "delete_ids": {
                "type": "array",
                "maxItems": MAX_DELETES_PER_UPDATE,
                "items": {"type": "string"},
            },
            "elements": {
                "type": "array",
                "maxItems": MAX_ELEMENTS_PER_UPDATE,
                "items": {
                    "anyOf": [
                        _board_element(
                            kind="text",
                            fields={
                                "x": {"type": "number", "description": "Left edge."},
                                "y": {"type": "number", "description": "Top edge."},
                                "text": {"type": "string", "maxLength": 2000, "description": "Newlines make multiple lines."},
                                "font_size": {"type": "number", "minimum": 8, "maximum": 256},
                                "alignment": {"type": "string", "enum": ["left", "center", "right"]},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000, "description": "Text box width; 0 means natural width."},
                            },
                            required=["x", "y", "text", "font_size", "alignment", "width"],
                            # A label is glyphs, not a shape. `draw(text:in:)`
                            # paints them from an attributed string whose
                            # `.foregroundColor` is `stroke`, and sets no
                            # `.strokeWidth` attribute, so neither the context's
                            # fill colour nor its pen reaches the run
                            # (BoardSceneRenderer.swift:376-384); the bounds arm
                            # applies no stroke inset either (line 588-591).
                            ignores=("fill", "stroke_width"),
                        ),
                        _board_element(
                            kind="line",
                            fields={
                                "x1": {"type": "number"},
                                "y1": {"type": "number"},
                                "x2": {"type": "number"},
                                "y2": {"type": "number"},
                            },
                            required=["x1", "y1", "x2", "y2"],
                            # An open segment has no interior: the arm only ever
                            # strokes (BoardSceneRenderer.swift:118-120).
                            ignores=("fill",),
                        ),
                        _board_element(
                            kind="arrow",
                            fields={
                                "x1": {"type": "number", "description": "Tail x."},
                                "y1": {"type": "number", "description": "Tail y."},
                                "x2": {"type": "number", "description": "Head x: the arrowhead is drawn here."},
                                "y2": {"type": "number", "description": "Head y."},
                                "head_size": {"type": "number", "minimum": 4, "maximum": 120},
                            },
                            required=["x1", "y1", "x2", "y2", "head_size"],
                            # The shaft is stroked and the head is filled — but
                            # filled in `stroke`'s colour, which the arm sets
                            # over the context's fill immediately before the
                            # `fillPath` (BoardSceneRenderer.swift:406-407). An
                            # arrow is one colour by construction.
                            ignores=("fill",),
                        ),
                        # Two arms, not one. A rectangle and an ellipse are
                        # placed by the same four numbers, but sharing one arm
                        # made the discriminator a short `enum`, and the
                        # constrained decoder locked a mixed `[rectangle,
                        # ...]` batch onto the first arm of the pair — the
                        # confirmed place where `image` ids came back as
                        # `ellipse`. Each gets its own `const` arm so the model
                        # can only name exactly the kind it means.
                        _board_element(
                            kind="rectangle",
                            fields={
                                "x": {"type": "number", "description": "Top-left x of the box."},
                                "y": {"type": "number", "description": "Top-left y of the box."},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000},
                                "height": {"type": "number", "minimum": 0, "maximum": 50000},
                            },
                            required=["x", "y", "width", "height"],
                        ),
                        _board_element(
                            kind="ellipse",
                            fields={
                                "x": {"type": "number", "description": "Top-left x of the box."},
                                "y": {"type": "number", "description": "Top-left y of the box."},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000},
                                "height": {"type": "number", "minimum": 0, "maximum": 50000},
                            },
                            required=["x", "y", "width", "height"],
                        ),
                        _board_element(
                            kind="circle",
                            fields={
                                "cx": {"type": "number"},
                                "cy": {"type": "number"},
                                "radius": {"type": "number", "minimum": 0, "maximum": 50000},
                            },
                            required=["cx", "cy", "radius"],
                        ),
                        _board_element(
                            kind="polygon",
                            fields={
                                "points": {
                                    "type": "array",
                                    "minItems": 3,
                                    "maxItems": 512,
                                    "items": _POINT_REF,
                                }
                            },
                            required=["points"],
                        ),
                        # Two singleton arms for the two open chains. Sharing
                        # one would turn the discriminator into a short `enum`
                        # and open the same mixed-batch coercion that broke
                        # `rectangle`/`ellipse`; `polygon` keeps its own
                        # separately because only it can say minItems 3.
                        _board_element(
                            kind="polyline",
                            fields={
                                "points": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 512,
                                    "items": _POINT_REF,
                                }
                            },
                            required=["points"],
                            # Both open chains, and neither fills: `polyline`
                            # strokes its path.
                            ignores=("fill",),
                        ),
                        _board_element(
                            kind="freehand",
                            fields={
                                "points": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 512,
                                    "items": _POINT_REF,
                                }
                            },
                            required=["points"],
                            # And `freehand` strokes the smoothed one
                            # (BoardSceneRenderer.swift:166-177). Only
                            # `polygon`, which closes, fills.
                            ignores=("fill",),
                        ),
                        _board_element(
                            kind="arc",
                            fields={
                                "cx": {"type": "number"},
                                "cy": {"type": "number"},
                                "radius": {"type": "number", "minimum": 0, "maximum": 50000},
                                "start_angle": {"type": "number", "description": "Degrees; 0 is right, increasing clockwise."},
                                "end_angle": {"type": "number", "description": "Sweeps clockwise from start_angle, past 180 degrees when asked; use circle for a full turn."},
                            },
                            required=["cx", "cy", "radius", "start_angle", "end_angle"],
                            # An arc is a sampled open path and is only stroked
                            # (BoardSceneRenderer.swift:186-189). A full turn is
                            # a `circle`, which does fill.
                            ignores=("fill",),
                        ),
                        _board_element(
                            kind="angle_marker",
                            fields={
                                "vertex_x": {"type": "number"},
                                "vertex_y": {"type": "number"},
                                "ray1_x": {"type": "number", "description": "A point on the first ray."},
                                "ray1_y": {"type": "number", "description": "A point on the first ray."},
                                "ray2_x": {"type": "number", "description": "A point on the second ray."},
                                "ray2_y": {"type": "number", "description": "A point on the second ray."},
                                "radius": {"type": "number", "minimum": 4, "maximum": 50000},
                                "right_angle": {"type": "boolean", "description": "Draw the small-square right-angle mark."},
                            },
                            required=[
                                "vertex_x", "vertex_y", "ray1_x", "ray1_y",
                                "ray2_x", "ray2_y", "radius", "right_angle",
                            ],
                            # Neither branch fills: the right-angle square is
                            # three stroked segments and the sweep is a stroked
                            # arc (BoardSceneRenderer.swift:427-428, 441-442).
                            ignores=("fill",),
                        ),
                        _board_element(
                            kind="path",
                            fields={
                                "d": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": MAX_PATH_CHARS,
                                    "description": "One SVG path string: M, L, H, V, C, S, Q, T, A, Z. Every coordinate is in absolute board points, the same space as every other element, so the path needs no frame and no viewbox.",
                                },
                                "fill_rule": {
                                    "type": "string",
                                    "enum": ["nonzero", "evenodd"],
                                    "description": "How overlapping subpaths fill; nonzero unless the shape needs holes.",
                                },
                            },
                            required=["d", "fill_rule"],
                        ),
                        _board_element(
                            kind="math_text",
                            fields={
                                "x": {"type": "number", "description": "Left edge."},
                                "y": {"type": "number", "description": "Top edge."},
                                "latex": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": MAX_LATEX_CHARS,
                                    "description": "The expression as LaTeX, with no surrounding $ or $$ delimiters, typeset on the learner's device. This is the only correct way to put mathematical notation on the board.",
                                },
                                "font_size": {"type": "number", "minimum": 8, "maximum": 256},
                            },
                            required=["x", "y", "latex", "font_size"],
                            # Notation is typeset into a bitmap of its own, with
                            # `stroke` as the glyph colour, and then composited
                            # (BoardMathStore.swift:244, 341-347, 50).
                            # Compositing a `CGImage` reads the context's alpha
                            # and nothing else about paint, so neither the fill
                            # colour nor the pen can reach the glyphs; the
                            # bounds arm applies no stroke inset and says so
                            # (BoardSceneRenderer.swift:682-683).
                            ignores=("fill", "stroke_width"),
                        ),
                        _board_element(
                            kind="ink_text",
                            fields={
                                "x": {"type": "number", "description": "Left edge of the writing."},
                                "y": {"type": "number", "description": "Top edge of the first line."},
                                "text": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": MAX_INK_TEXT_CHARS,
                                    # Written without em dashes, curly quotes,
                                    # or an ellipsis, on purpose. The device
                                    # draws from an ASCII glyph table and
                                    # normalises the typographic forms into it;
                                    # a description written in the register it
                                    # is asking the model *not* to use teaches
                                    # the opposite of what it says.
                                    "description": "The words to write, drawn on the device as handwriting-look ink in your own hand; newlines make lines. Prose only, and every piece of notation still goes in `math_text`. Write it as plain text: em and en dashes, curly quotes and ellipses are normalised to their ASCII equivalents, and a non-Latin script has no glyph to draw and comes out as a placeholder. An emoji is not a placeholder: it draws as itself, in full colour, standing as tall as the writing around it, so a star beside a good step or a warning sign beside a trap is yours to use. Your writing looks handwritten in a board capture too, so when you read the board back, the learner's work is the writing you did not put there: every piece you did is listed, by id, in the scene you were given, plus whatever you have written this turn.",
                                },
                                "size": {"type": "number", "minimum": 8, "maximum": 256, "description": "Cap height: how tall one line of the writing stands. Lines never wrap on their own: each character runs about 0.75 x size wide and each line about 1.9 x size tall, so break long writing with newlines to keep it inside the visible board."},
                            },
                            required=["x", "y", "text", "size"],
                            # Handwriting is a filled pen outline rather than a
                            # stroked centreline, and it is filled in `stroke`'s
                            # colour, set over the context's fill immediately
                            # before the `fillPath`
                            # (BoardSceneRenderer.swift:237-238). The nib's
                            # width comes from `size`, not from the pen, so the
                            # bounds arm takes no stroke inset (line 700-701).
                            ignores=("fill", "stroke_width"),
                        ),
                        _board_element(
                            kind="image",
                            fields={
                                "x": {"type": "number", "description": "Left edge."},
                                "y": {"type": "number", "description": "Top edge."},
                                # Every size this schema allows is a size the
                                # scene model accepts: it refuses a frame with
                                # no area, and nothing is legible under a
                                # board point.
                                "width": {"type": "number", "minimum": 1, "maximum": 50000, "description": "Frame width; the picture is drawn inside it."},
                                "height": {"type": "number", "minimum": 1, "maximum": 50000, "description": "Frame height."},
                                "blob_id": {
                                    "type": "string",
                                    "pattern": "^sha256:[0-9a-f]{64}$",
                                    "description": "The key of a picture already on the server, copied from a tool result word for word. Never invent one: a made-up key draws an empty frame.",
                                },
                            },
                            required=["x", "y", "width", "height", "blob_id"],
                            # A picture is composited, and until its blob lands
                            # its frame is filled with the system's own
                            # placeholder grey — set inside the helper, over
                            # whatever the context held
                            # (BoardSceneRenderer.swift:338, 359). Nothing
                            # outlines a photograph: `BoardImageStore` reads no
                            # style at all, and the bounds arm takes no stroke
                            # inset and says why (line 711-712).
                            ignores=("fill", "stroke_width", "stroke"),
                        ),
                        _board_element(
                            kind="svg",
                            fields={
                                "x": {"type": "number", "description": "Where the viewBox's top-left corner lands."},
                                "y": {"type": "number", "description": "Where the viewBox's top-left corner lands."},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000, "description": "Send 0: the figure is drawn at the size its viewBox gives it. A positive value scales the whole document into that box instead."},
                                "height": {"type": "number", "minimum": 0, "maximum": 50000, "description": "Send 0, as for width."},
                                "svg": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": MAX_SVG_CHARS,
                                    "description": "A complete raw SVG document, passed through unchanged and interpreted locally on the learner's device. Give it a viewBox: one user unit is drawn as one board point, and the viewBox's top-left corner sits at (x, y), so size the figure in the same units as every other element and size it only once. The device draws paths, shapes, groups, transforms, linear and radial gradients, defs/use, masks, clip paths, CSS `<style>` blocks, and text; `<filter>` effects are dropped, and animation, scripts, `<foreignObject>`, and external references draw nothing.",
                                },
                            },
                            required=["x", "y", "width", "height", "svg"],
                            # The document owns its own paint. SwiftDraw
                            # rasterizes it in a detached task, into a renderer
                            # it creates for itself, and the board's context
                            # only ever composites the finished bitmap
                            # (BoardSVGStore.swift:386-406, 40) — so no board
                            # style can reach a shape inside the markup. The
                            # cache key is the markup's digest and nothing else
                            # (line 185-188), which is the same statement made
                            # twice: two figures differing only in `stroke`
                            # share one bitmap. No stroke inset either
                            # (BoardSceneRenderer.swift:730-732).
                            ignores=("fill", "stroke_width", "stroke"),
                        ),
                    ]
                },
            },
        },
        "required": ["mode", "delete_ids", "elements"],
    },
}

# A coherent document gets its own tool instead of asking a structured decoder
# to choose the sixteenth arm of a large semantic union. The server still parses
# legacy `update_board` calls carrying SVG; only the offered schema is split.
_board_arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
_svg_arm_index = next(
    index for index, arm in enumerate(_board_arms)
    if arm["properties"]["kind"].get("const") == "svg"
)
_svg_arm = _board_arms.pop(_svg_arm_index)

DRAW_BOARD_SVG_TOOL: dict = {
    "type": "function",
    "name": "draw_board_svg",
    "description": (
        "Draw one complete standalone exercise or coherent diagram as a single "
        "SVG document containing every visible word, equation, shape, and "
        "illustration. Use this only when you are intentionally replacing the "
        "entire tutor scene with one self-contained figure. It clears the "
        "existing tutor scene before drawing, so it deletes everything already "
        "placed. On a populated tutor scene use `update_board` instead to add, "
        "revise, or delete objects without wiping the rest. Before drawing on a "
        "board that already has content, call `view_board` to see the current "
        "board in this turn first; a board with no renderable content may be "
        "drawn straight away. Place the figure in clear space using the current "
        "scene: use `recommended_tutor_rect` and "
        "`reserved_learner_work_rect` when those live layout rects are present; "
        "otherwise inspect the full board and use learner-ink, overview, and "
        "tutor-element bounds. After it lands, call `view_board` to "
        "inspect the full board and correct any material overlap, clipping, or "
        "misalignment before replying in prose."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "$defs": _BOARD_DEFS,
        "properties": {
            "mode": {"type": "string", "const": "replace_all"},
            "delete_ids": {"type": "array", "maxItems": 0, "items": {"type": "string"}},
            "elements": {
                "type": "array", "minItems": 1, "maxItems": 1,
                "items": _svg_arm,
            },
        },
        "required": ["mode", "delete_ids", "elements"],
    },
}

FETCH_IMAGE_TOOL: dict = {
    "type": "function",
    "name": "fetch_image",
    "description": (
        "Download one picture from the web so you can see it and put it on the "
        "learner's board — a diagram they linked, or an image you found. The "
        "answer carries a blob_id, which is what the `image` element in "
        "update_board takes, and the picture itself arrives in your context: "
        "look at it before you place it, and never describe one you have not "
        "seen. Give the direct https address of the image file itself — .png, "
        ".jpg, .webp or .gif — not of the page it sits on. Anything refused "
        "answers with an error you can read and retry from with another URL."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "url": {
                "type": "string",
                "description": "The direct https URL of one image file.",
            },
        },
        "required": ["url"],
    },
}

REMEMBER_TOOL: dict = {
    "type": "function",
    "name": "remember",
    "description": (
        "Save a note about this learner for future sessions. Call this when "
        "they ask you to remember something, and when they tell you something "
        "that will still matter next time — a preference, a goal, a deadline, "
        "how they like to work. Write the fact so it stands alone with no "
        "surrounding conversation: resolve every pronoun and reference. A "
        "saved note appears, dated, in your SAVED NOTES block from the next "
        "turn on, every turn, until `forget` removes it. Before you write any "
        "message containing 'noted', 'got it', or 'I'll remember that', call "
        "this tool first and wait for its answer — otherwise you have told "
        "them something untrue."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "text": {
                "type": "string",
                "description": "The fact, self-contained, 10-30 words.",
            },
            # The same question `EXTRACTION_SCHEMA` asks the offline extractor.
            # No longer a gate — an explicit save is the learner-visible act,
            # and refusing it over this flag was how "noted" became a lie
            # (W14) — but still provenance: the flag is stored verbatim and
            # search results say which facts were their words.
            "stated": {
                "type": "boolean",
                "description": (
                    "True only if the learner said this themselves; false for "
                    "anything concluded, inferred, or guessed at."
                ),
            },
            # Generated from `MemoryCategory` for the reason
            # `EXTRACTION_SCHEMA` gives: a value the model may return and
            # `ck_memory_atoms_category` will reject is a fact lost between the
            # two, and here it would be lost in front of a learner who has just
            # been told it was saved.
            "category": {
                "type": "string",
                "enum": [category.value for category in MemoryCategory],
            },
        },
        "required": ["text", "category", "stated"],
    },
}

FORGET_TOOL: dict = {
    "type": "function",
    "name": "forget",
    "description": (
        "Close one saved note or remembered fact, so it stops appearing and "
        "stops being found. Call this when the learner asks you to forget "
        "something, and confirm only after the tool answers that it was "
        "closed. Pass the note's text word for word as SAVED NOTES or a "
        "search result shows it — or a phrase distinctive enough to match "
        "exactly one note; if several match, the answer lists them so you can "
        "call again with the exact one."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "text": {
                "type": "string",
                "description": (
                    "The note to forget, word for word, or a distinctive "
                    "phrase from it."
                ),
            },
        },
        "required": ["text"],
    },
}

SEARCH_MEMORY_TOOL: dict = {
    "type": "function",
    "name": "search_memory",
    "description": (
        "Search the individual facts on file about this learner — "
        "preferences, goals, struggles, saved notes. Every result is dated "
        "and says where it came from. Use it whenever answering depends on "
        "something they told you before. This tool has NO access to the "
        "current conversation, so your query must be entirely self-contained: "
        "write 'what has this learner said about preparing for their June "
        "exam', never 'what did they mean by that'. Never tell the learner "
        "you cannot remember something without searching here first — and "
        "when it answers that nothing is on file, that is the truth to pass "
        "on. For whole sessions use `search_sessions`; for the exact words of "
        "a past conversation use `search_history`."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "query": {
                "type": "string",
                "description": "A self-contained natural-language question.",
            },
        },
        "required": ["query"],
    },
}

SEARCH_SESSIONS_TOOL: dict = {
    "type": "function",
    "name": "search_sessions",
    "description": (
        "Find past sessions by what they were about — topic, problem, "
        "formula, anything the work touched. Searches every session summary, "
        "by meaning as well as by keyword, and answers with dated cards: "
        "when, a title, and the session's narrative, plus how many sessions "
        "matched in total. The RECENT SESSIONS block already in your context "
        "covers the newest few — search when the session you want is older or "
        "you only know the topic. The query must be self-contained; this tool "
        "cannot see the current conversation. Follow up with `get_session` "
        "when you need a session's exact words."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "A self-contained description of the session you want — "
                    "topic, problem, or phrasing from it."
                ),
            },
            "date_from": {
                "type": ["string", "null"],
                "description": (
                    "Earliest session date to include, as YYYY-MM-DD, or null "
                    "for no lower bound."
                ),
            },
            "date_to": {
                "type": ["string", "null"],
                "description": (
                    "Latest session date to include (that whole day counts), "
                    "as YYYY-MM-DD, or null for no upper bound."
                ),
            },
            "limit": {
                "type": "integer",
                "description": "How many sessions to return, 1 to 5.",
            },
        },
        "required": ["query", "date_from", "date_to", "limit"],
    },
}

SEARCH_HISTORY_TOOL: dict = {
    "type": "function",
    "name": "search_history",
    "description": (
        "Find the exact place something was said, in any session ever. "
        "Full-text search over every stored message of the entire history — "
        "nothing ages out of it — answering with dated excerpts: who said it, "
        "when, the matched words marked, and the line spoken just before. Use "
        "it when the question is about specific words, numbers, formulas, or "
        "claims — 'where did I say X', 'what exactly did you tell me about "
        "Y' — then `get_session` with that date to read the full context. "
        "Keyword search: it finds the words you give it, so quote distinctive "
        "ones rather than describing the topic (that is `search_sessions`)."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "The words to find — distinctive terms, not a topic "
                    "description."
                ),
            },
            "date_from": {
                "type": ["string", "null"],
                "description": (
                    "Earliest message date to include, as YYYY-MM-DD, or null "
                    "for no lower bound."
                ),
            },
            "date_to": {
                "type": ["string", "null"],
                "description": (
                    "Latest message date to include (that whole day counts), "
                    "as YYYY-MM-DD, or null for no upper bound."
                ),
            },
            "limit": {
                "type": "integer",
                "description": "How many excerpts to return, 1 to 8.",
            },
        },
        "required": ["query", "date_from", "date_to", "limit"],
    },
}

GET_SESSION_TOOL: dict = {
    "type": "function",
    "name": "get_session",
    "description": (
        "Read one past session — its summary, or its full stored transcript, "
        "page by page. This is the detail path: a summary says what happened, "
        "the transcript says what exactly was said, and for any question "
        "about the details of a past session you read here BEFORE answering "
        "rather than reciting a summary from memory. Name the session by its "
        "date (YYYY-MM-DD, all of that day's windows) or by an offset "
        "counting back through RECENT SESSIONS ('0' is the newest, '1' the "
        "one before). Long transcripts come paged; the answer says how many "
        "pages there are."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "date_or_offset": {
                "type": "string",
                "description": (
                    "A date like 2026-08-14, or an offset like 0 (newest), 1, "
                    "2 counting back."
                ),
            },
            "part": {
                "type": "string",
                "enum": ["summary", "transcript"],
                "description": (
                    "summary for what happened; transcript for the exact "
                    "words."
                ),
            },
            "page": {
                "type": "integer",
                "description": "Which transcript page, from 1. Use 1 first.",
            },
        },
        "required": ["date_or_offset", "part", "page"],
    },
}

LIST_SESSIONS_TOOL: dict = {
    "type": "function",
    "name": "list_sessions",
    "description": (
        "Browse the session history in order, most recent first: one dated "
        "line per session with its title. The RECENT SESSIONS block in your "
        "context already shows the newest few in more detail — call this to "
        "see past its end, and page further back by passing before_date = "
        "the oldest date the previous call showed. The sequence, which is "
        "what a continuity question wants and what a search is the wrong "
        "shape for."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "limit": {
                "type": "integer",
                "description": "How many sessions to list, 1 to 20.",
            },
            "before_date": {
                "type": ["string", "null"],
                "description": (
                    "Only sessions before this date (YYYY-MM-DD), or null to "
                    "start from the most recent."
                ),
            },
        },
        "required": ["limit", "before_date"],
    },
}

#: Evidence channels the model is not allowed to claim for itself.
#:
#: `answer_verified` is worth 0.95 in `RELIABILITY` — near-certainty — and it
#: means a symbolic check actually ran. Nothing in a turn runs one: the model
#: picks its own `kind`, so offering this value would let the tutor self-award
#: near-certain evidence for work nobody checked, and eight of those clear the
#: mastery gate on a concept the learner may not have. `mastery.RELIABILITY`
#: keeps the number for the day a CAS check exists and names this enum as the
#: place the rule is enforced.
SERVER_ONLY_KINDS = frozenset({"answer_verified"})

#: What the model may choose from, derived from `RELIABILITY` rather than typed
#: out again. A name written here that `RELIABILITY` does not carry does not
#: fail — it scores `UNKNOWN_RELIABILITY`, quietly, on every observation that
#: uses it.
EVIDENCE_KINDS: tuple[str, ...] = tuple(
    kind for kind in RELIABILITY if kind not in SERVER_ONLY_KINDS
)

RECORD_EVIDENCE_TOOL: dict = {
    "type": "function",
    "name": "record_evidence",
    "description": (
        "Record what the learner just demonstrated about a concept, so their "
        "mastery is tracked across sessions. Call this whenever they attempt "
        "something and you can judge how it went — a solved problem, a step "
        "on the board, an explanation, or an explicit 'I don't know'. Name "
        "Common Core standard codes such as 7.RP.A.2. Weights say how much of "
        "the attempt each concept accounts for and should sum to about 1. "
        "Choose `kind` honestly: it decides how much this observation is "
        "trusted, and calling a glance at a sketch a reading of their working "
        "corrupts the record."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "kcs": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "code": {"type": "string"},
                        "weight": {"type": "number"},
                    },
                    "required": ["code", "weight"],
                },
            },
            "outcome": {
                "type": "number",
                "description": (
                    "0 to 1. 1 correct unaided, 0.6 correct after one nudge, "
                    "0.2 correct after being walked through, 0 wrong."
                ),
            },
            "kind": {
                "type": "string",
                "description": (
                    "How you observed this. dont_know: they said outright they "
                    "did not know. ink_symbolic: you read the symbolic working "
                    "they wrote on the board. answer_llm: you judged an answer "
                    "they wrote or said. hinted: they got there after you gave "
                    "the step away. ink_diagram: you read a drawing or sketch."
                ),
                "enum": list(EVIDENCE_KINDS),
            },
            "difficulty": {
                "type": "number",
                "description": "How hard this was for their level, -2 to 2.",
            },
            "misconception": {
                "type": ["string", "null"],
                "description": "The specific wrong belief, named, or null.",
            },
        },
        "required": ["kcs", "outcome", "kind", "difficulty", "misconception"],
    },
}

#: The tools that need a database session to answer, kept together so the
#: router and the registry cannot disagree about which those are. A name in one
#: and not the other is a tool the model is offered and then told is
#: unsupported — a whole turn spent on a dead round.
#:
#: `list_sessions` REPLACED `recent_sessions` outright (memory rework,
#: 2026-08-15) rather than leaving the old name answering a redirect: the set
#: is a module constant, identical on every request of a deployment, so the
#: cache-prefix rule — tool definitions never vary per request — holds either
#: way, and a dead name kept alive re-bills its tokens on every turn for the
#: privilege of telling the model to call something else.
MEMORY_TOOL_DEFINITIONS: list[dict] = [
    REMEMBER_TOOL, FORGET_TOOL, SEARCH_MEMORY_TOOL, SEARCH_SESSIONS_TOOL,
    SEARCH_HISTORY_TOOL, GET_SESSION_TOOL, LIST_SESSIONS_TOOL,
    RECORD_EVIDENCE_TOOL,
]
MEMORY_TOOLS: frozenset[str] = frozenset(
    tool["name"] for tool in MEMORY_TOOL_DEFINITIONS
)

# SEAM: later work appends hosted tools here, after every function tool.
# File search is {"type": "file_search", "vector_store_ids": [...]}.
#
# Every tool a session can ever use is here, whether or not this turn could
# answer it. Tool definitions sit at the top of the provider's
# cache-invalidation hierarchy, so offering three tools on one turn and seven
# on the next re-bills the entire prompt prefix every time the set changes.
# `loop._answer` is where a tool the turn cannot serve is turned down.
#
# Web search is deliberately a function tool here. The answering model can be
# OpenAI or Gemini; the server executes the same focused hosted-search
# subrequest and returns the same source evidence to either family.
#
# `code_interpreter` carries one key beyond its type, and it is configuration
# rather than schema. `{"type": "auto"}` tells the provider to create and own a
# sandbox per response; the alternative is naming a container id, which would
# pin every learner in the deployment to one machine and one filesystem and let
# one turn's scratch files be read by the next learner's script.
#
# It differs from every other tool here in what it leaves behind. A script that
# draws a chart writes a *file*, and that file lives in the provider's container
# and expires with it — so a turn that does not fetch the bytes before it ends
# has produced a picture nobody can ever see.
# `providers.openai._container_citations` is what finds those files, and
# `loop.FileRelay` is what keeps them.
TOOL_DEFINITIONS: list[dict] = [
    SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, DRAW_BOARD_SVG_TOOL, UPDATE_BOARD_TOOL,
    FETCH_IMAGE_TOOL,
    *MEMORY_TOOL_DEFINITIONS,
    WEB_SEARCH_TOOL,
    {"type": "code_interpreter", "container": {"type": "auto"}},
]
