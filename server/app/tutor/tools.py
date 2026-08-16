from app.learner.mastery import RELIABILITY
from app.memory.schema import MemoryCategory
from app.tutor.board_scene import (
    MAX_INK_TEXT_CHARS,
    MAX_LATEX_CHARS,
    MAX_PATH_CHARS,
    MAX_SVG_CHARS,
)


SET_WORKSPACE_TOOL: dict = {
    "type": "function",
    "name": "set_workspace",
    "description": (
        "Replace the learner's session plan and board exercise. Call it when the "
        "learner asks to create, add, change, simplify, advance, or get another "
        "exercise."
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
        "Read any region of the learner's whiteboard at full resolution; the "
        "overview is too small to read clearly. Call before grading, quoting, "
        "or placing anything relative to learner work, and whenever an answer "
        "depends on what is actually written. Call again for other regions; "
        "each crop renders fresh."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "x": {
                "type": "number",
                "description": "Left edge, percent across the board (0-100).",
            },
            "y": {
                "type": "number",
                "description": "Top edge, percent down the board (0-100).",
            },
            "width": {
                "type": "number",
                "description": "Region width in percent; 100 = whole board.",
            },
            "height": {
                "type": "number",
                "description": "Region height in percent.",
            },
        },
        "required": ["x", "y", "width", "height"],
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
        "description": "Width in board points.",
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
        "description": "Dash pattern; [] solid.",
    },
    "rotation": {
        "type": "number",
        "description": "Clockwise degrees; 0 = none.",
    },
}

#: The two other shapes every arm repeated: the id, and one [x, y] pair.
_BOARD_DEFS: dict = {
    **_STYLE_DEFS,
    "element_id": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:+-]{1,128}$",
        "description": "Stable id; reuse to revise.",
    },
    "point": {
        "type": "array",
        "items": {"type": "number"},
        "minItems": 2,
        "maxItems": 2,
        "description": "Board point [x, y].",
    },
}

#: `$defs` lives at the root of the tool's `parameters`, so every reference is
#: rooted there too. Named once so a rename cannot leave a dangling pointer.
_POINT_REF = {"$ref": "#/$defs/point"}
_STYLE_REFS: dict = {name: {"$ref": f"#/$defs/{name}"} for name in _STYLE_DEFS}


def _board_element(
    *,
    kind: str | tuple[str, ...],
    fields: dict,
    required: list[str],
    kind_description: str | None = None,
    ignores: tuple[str, ...] = (),
) -> dict:
    """One arm of the element union.

    `kind` may name several element kinds at once. Two or more kinds share an
    arm only when their field sets are identical, so the arm they share is the
    schema each of them already had; the discriminator becomes a short `enum`
    instead of a `const`, which `parse_board_update` reads the same way — the
    pydantic union discriminates on the value, not on how the schema wrote it.
    A merged arm is one copy of the twelve-name `required` list and one copy of
    the style block instead of two or three, and that duplication was most of
    what this tool cost.

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
    discriminator: dict = (
        {"type": "string", "const": kind} if isinstance(kind, str)
        else {"type": "string", "enum": list(kind)}
    )
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
        "Draw, label, revise, or delete your objects on the learner's whiteboard "
        "whenever a visual teaches better than words; do not wait to be asked. "
        "Compose like a thoughtful teacher: clear hierarchy, whitespace, a "
        "restrained coherent palette, legible type, one cohesive scene rather "
        "than scattered marks. Surprise is welcome when it clarifies or makes "
        "an idea memorable. "
        "Kind by job: primitives and `text` labels for simple labels and "
        "geometry; `path`/freehand for curves; `ink_text` for brief tutor "
        "prose in your own hand; `math_text` for notation; `svg` for a "
        "polished multi-part illustration; `image` for a photo fetched with "
        "fetch_image or a script chart by blob_id. "
        "Your objects never alter the learner's PencilKit ink. Use stable "
        "ids: reuse to revise, list in delete_ids to remove; elements=[] "
        "deletes only, delete_ids=[] upserts only. Board points: (0,0) "
        "centre, +x right, +y down. Keep work compact in "
        "`recommended_tutor_rect`, leave `reserved_learner_work_rect` clear, "
        "place corrections beside learner work, and view_board before grading "
        "or quoting."
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
                "description": "upsert applies by id; replace_all clears first, then applies.",
            },
            "delete_ids": {
                "type": "array",
                "maxItems": 200,
                "items": {"type": "string"},
            },
            "elements": {
                "type": "array",
                "maxItems": 200,
                "items": {
                    "anyOf": [
                        _board_element(
                            kind="text",
                            fields={
                                "x": {"type": "number", "description": "Left edge."},
                                "y": {"type": "number", "description": "Top edge."},
                                "text": {"type": "string", "maxLength": 2000, "description": "Newlines make lines."},
                                "font_size": {"type": "number", "minimum": 8, "maximum": 256},
                                "alignment": {"type": "string", "enum": ["left", "center", "right"]},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000, "description": "Text box width; 0 = natural."},
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
                                "x2": {"type": "number", "description": "Head x: the arrowhead lands here."},
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
                        # One arm, because a rectangle and an ellipse are placed
                        # by exactly the same four numbers: the box, and the
                        # figure inscribed in it.
                        _board_element(
                            kind=("rectangle", "ellipse"),
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
                        # One arm for the two open chains. `polygon` keeps its
                        # own, because only it can say minItems 3, and a
                        # two-point polygon the schema allowed would come back
                        # from `parse_board_update` as a refusal of the whole
                        # call.
                        _board_element(
                            kind=("polyline", "freehand"),
                            kind_description="Open chains: polyline joins straight, freehand smooths.",
                            fields={
                                "points": {
                                    "type": "array",
                                    "minItems": 2,
                                    "maxItems": 512,
                                    "items": _POINT_REF,
                                }
                            },
                            required=["points"],
                            # Both are open chains, and neither arm fills:
                            # `polyline` strokes its path and `freehand` strokes
                            # the smoothed one (BoardSceneRenderer.swift:
                            # 166-177). Only `polygon`, which closes, fills.
                            ignores=("fill",),
                        ),
                        _board_element(
                            kind="arc",
                            fields={
                                "cx": {"type": "number"},
                                "cy": {"type": "number"},
                                "radius": {"type": "number", "minimum": 0, "maximum": 50000},
                                "start_angle": {"type": "number", "description": "Degrees; 0 is right, increasing clockwise."},
                                "end_angle": {"type": "number", "description": "Degrees clockwise from start_angle, past 180 when asked; use circle for a full turn."},
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
                                "ray1_x": {"type": "number"},
                                "ray1_y": {"type": "number"},
                                "ray2_x": {"type": "number"},
                                "ray2_y": {"type": "number"},
                                "radius": {"type": "number", "minimum": 4, "maximum": 50000},
                                "right_angle": {"type": "boolean", "description": "Also draw the square mark."},
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
                                    "description": "SVG path data (M L H V C S Q T A Z) in absolute board points; no frame or viewBox.",
                                },
                                "fill_rule": {
                                    "type": "string",
                                    "enum": ["nonzero", "evenodd"],
                                    "description": "nonzero unless the shape needs holes.",
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
                                    "description": "LaTeX without $ delimiters, typeset on the learner's device; use for all notation.",
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
                                    "description": "The words to draw as handwriting-look ink; newlines make lines. Prose only - notation goes in `math_text`. Plain text: dashes, quotes, and ellipses become ASCII equivalents; emoji or non-Latin scripts become placeholders. When reading the board back, your ink is the scene list plus anything written this turn; the rest is the learner's.",
                                },
                                "size": {"type": "number", "minimum": 8, "maximum": 256, "description": "Line height in board points."},
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
                                    "description": "Blob key from a tool result; an invented key draws an empty frame.",
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
                                "x": {"type": "number", "description": "Where the viewBox top-left lands."},
                                "y": {"type": "number", "description": "Where the viewBox top-left lands."},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000, "description": "0 = draw at viewBox size; positive scales the whole document into this box."},
                                "height": {"type": "number", "minimum": 0, "maximum": 50000, "description": "0, as for width."},
                                "svg": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": MAX_SVG_CHARS,
                                    "description": "A complete raw SVG document, interpreted locally on the learner's device. Give a viewBox: one user unit = one board point, top-left at (x, y); width/height 0 sizes it once. Draws paths, shapes, groups, transforms, gradients, defs/use, masks, clip paths, `<style>`, text; `<filter>` effects are dropped; animation, scripts, `<foreignObject>`, external references draw nothing.",
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

FETCH_IMAGE_TOOL: dict = {
    "type": "function",
    "name": "fetch_image",
    "description": (
        "Download an image to see and place on the board - a diagram the "
        "learner linked, or a real image that teaches better than a drawing. "
        "It returns a blob_id for update_board's `image` element and the "
        "picture lands in your context - look before placing. Give the direct "
        "https image URL (.png, .jpg, .webp, .gif), not a page; refusals "
        "return an error to retry from."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "url": {
                "type": "string",
                "description": "Direct https URL of one image file.",
            },
        },
        "required": ["url"],
    },
}

REMEMBER_TOOL: dict = {
    "type": "function",
    "name": "remember",
    "description": (
        "Save a self-contained fact about this learner for future sessions - a "
        "preference, goal, deadline, or how they like to work. It appears "
        "dated in SAVED NOTES until `forget` closes it. Never say 'noted', "
        "'got it', or 'I'll remember that' until the tool answers."
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
        "Close one saved note so it stops appearing and being found. Call "
        "when asked to forget something, and confirm only after the tool "
        "answers. Pass the note text word for word, or a phrase distinctive "
        "enough to match exactly one; if several match, the answer lists "
        "them."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "text": {
                "type": "string",
                "description": (
                    "The note, word for word, or a distinctive phrase."
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
        "Search the individual facts on file about this learner - preferences, "
        "goals, saved notes - all dated and sourced. Use it when an answer "
        "depends on what they told you before. Query must be self-contained; "
        "this tool cannot see the current conversation. Nothing on file is "
        "the truth to pass on. Whole sessions: `search_sessions`; exact past "
        "words: `search_history`."
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
        "Find past sessions by topic, problem, or what the work touched; "
        "results are dated cards with titles and summaries. RECENT SESSIONS "
        "already in your context covers the newest few; call this for older "
        "or topic-led searches. Query is self-contained (no current "
        "conversation); follow with `get_session` for exact words."
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
                    "YYYY-MM-DD or null (no lower bound)."
                ),
            },
            "date_to": {
                "type": ["string", "null"],
                "description": (
                    "YYYY-MM-DD or null (no upper bound)."
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
        "Find the exact place words were said in any session, ever: dated "
        "excerpts with who said it and the matched words. Use for specific "
        "wording, numbers, or claims, then `get_session` for context. Keyword "
        "search: quote distinctive terms, not the topic (`search_sessions` "
        "does that)."
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
                    "YYYY-MM-DD or null (no lower bound)."
                ),
            },
            "date_to": {
                "type": ["string", "null"],
                "description": (
                    "YYYY-MM-DD or null (no upper bound)."
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
        "Read one past session: its summary or full stored transcript, page "
        "by page. For any question about what was said, read the transcript "
        "BEFORE answering. Name it by date (YYYY-MM-DD) or offset from RECENT "
        "SESSIONS (0 = newest). Long transcripts are paged; the answer says "
        "how many pages."
    ),
    "strict": True,
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "date_or_offset": {
                "type": "string",
                "description": (
                    "YYYY-MM-DD or an offset back (0 newest)."
                ),
            },
            "part": {
                "type": "string",
                "enum": ["summary", "transcript"],
                "description": "summary or transcript.",
            },
            "page": {
                "type": "integer",
                "description": "Transcript page, from 1.",
            },
        },
        "required": ["date_or_offset", "part", "page"],
    },
}

LIST_SESSIONS_TOOL: dict = {
    "type": "function",
    "name": "list_sessions",
    "description": (
        "Browse sessions newest first: one dated line per session. RECENT "
        "SESSIONS already shows the newest few; call this to see past its end "
        "with before_date = the oldest date shown. Use it when a continuity "
        "question needs the sequence."
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
                    "YYYY-MM-DD or null (start newest)."
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
        "Record what the learner just demonstrated so mastery is tracked "
        "across sessions; call whenever you can judge an attempt - a solved "
        "problem, a board step, an explanation, or 'I don't know'. Use Common "
        "Core codes like 7.RP.A.2; weights sum to about 1. Choose `kind` "
        "honestly - it sets how much the observation is trusted."
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
                    "0-1: 1 unaided, 0.6 after a nudge, 0.2 after a "
                    "walkthrough, 0 wrong."
                ),
            },
            "kind": {
                "type": "string",
                "description": (
                    "How observed: dont_know = said so; ink_symbolic = read "
                    "board work; answer_llm = judged a written/spoken answer; "
                    "hinted = after a nudge; ink_diagram = read a drawing."
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
# A hosted tool is a type and nothing else of ours: the provider owns its name,
# its schema and its execution, so no call of it ever reaches `loop._answer` and
# nothing here describes it. `web_search` reports itself through
# `response.web_search_call.*`, which `events` already reads as the searching
# phase. Anything walking this list for a `name` or a `description` must first
# say it means the function tools — the entries carrying `"type": "function"`.
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
    SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, UPDATE_BOARD_TOOL, FETCH_IMAGE_TOOL,
    *MEMORY_TOOL_DEFINITIONS,
    {"type": "web_search"},
    {"type": "code_interpreter", "container": {"type": "auto"}},
]
