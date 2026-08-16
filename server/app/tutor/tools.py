from app.learner.mastery import RELIABILITY
from app.memory.schema import MemoryCategory
from app.tutor.board_scene import MAX_LATEX_CHARS, MAX_PATH_CHARS, MAX_SVG_CHARS


SET_WORKSPACE_TOOL: dict = {
    "type": "function",
    "name": "set_workspace",
    "description": (
        "Replace the learner's session plan and board exercise. Call this only when "
        "the learner asks to create, add, replace, change, simplify, advance, or get "
        "another board exercise. Both halves are required; there is no way to set one."
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
                "description": "Left edge, as a percentage across the overview (0 = its left edge, 100 = its right).",
            },
            "y": {
                "type": "number",
                "description": "Top edge, as a percentage down the overview (0 = its top edge, 100 = its bottom).",
            },
            "width": {
                "type": "number",
                "description": "Region width as a percentage of the board's width. Use 100 to see the whole board at readable size.",
            },
            "height": {
                "type": "number",
                "description": "Region height as a percentage of the board's height.",
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
#: Every field is required because strict function schemas have no optional
#: fields; the device defaults absent style to the same values these describe.
_STYLE_DEFS: dict = {
    "role": {
        "type": "string",
        "enum": ["content", "hint", "correction", "emphasis"],
        "description": "What the object is for: regular content, a hint, a correction beside learner work, or emphasis.",
    },
    "stroke": {
        "type": "string",
        "pattern": "^#[0-9A-Fa-f]{6}$",
        "description": "Stroke colour as #RRGGBB.",
    },
    "fill": {
        "type": "string",
        "pattern": "^(transparent|#[0-9A-Fa-f]{6})$",
        "description": "Fill colour as #RRGGBB, or transparent.",
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
        "description": "Element opacity from 0 to 1.",
    },
    "dash": {
        "type": "array",
        "maxItems": 8,
        "items": {"type": "number", "minimum": 0, "maximum": 200},
        "description": "Optional dash pattern in board points; use [] for a solid stroke.",
    },
    "rotation": {
        "type": "number",
        "description": "Clockwise rotation in degrees around the object's own centre; 0 for none.",
    },
}

#: The two other shapes every arm repeated: the id, and one [x, y] pair.
_BOARD_DEFS: dict = {
    **_STYLE_DEFS,
    "element_id": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:+-]{1,128}$",
        "description": "Stable id. Reuse it in a later call to revise this object, or list it in delete_ids to remove it.",
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


def _board_element(*, kind: str, fields: dict, required: list[str]) -> dict:
    properties: dict = {
        "id": {"$ref": "#/$defs/element_id"},
        "kind": {"type": "string", "const": kind},
    }
    properties.update(fields)
    properties.update(_STYLE_REFS)
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": ["id", "kind"] + required + list(_STYLE_REFS),
    }


UPDATE_BOARD_TOOL: dict = {
    "type": "function",
    "name": "update_board",
    "description": (
        "Draw, label, correct, update, or delete the tutor's semantic objects on the "
        "learner's whiteboard. Use it whenever a visual would help them — an exercise "
        "to work on, a diagram that carries an explanation, a correction beside their "
        "work — and not only when one is asked for. Tutor objects are "
        "structured text and geometry, never simulated handwriting. Choose the "
        "element for the job: ordinary primitives — lines, arrows, shapes, arcs, "
        "angle markers, plain text labels — for simple geometry and quick "
        "annotations; `path` for curves and freeform shapes; `math_text` for every "
        "piece of mathematical notation, never plain `text`, never SVG `<text>`, "
        "and never symbols built out of primitives; `svg` for any figure made of "
        "several parts, which is what most real illustrations are — one document "
        "with a viewBox, `width` and `height` sent as 0, drawn one user unit to one "
        "board point; `image` for a photograph fetched with fetch_image or a chart "
        "a script produced, placed by the blob_id that tool answered with. "
        "This tool never touches the "
        "learner's own PencilKit ink. Each object has a stable id: "
        "reuse ids to revise existing content and list ids in delete_ids to remove "
        "it. Pass elements=[] to only delete, delete_ids=[] to only upsert, or "
        "mode=replace_all to replace the entire tutor scene. Coordinates are logical "
        "board points: (0,0) is the board centre (25,000,25,000 in drawing "
        "coordinates), +x right, +y down. Keep new standalone diagrams compact and "
        "inside `recommended_tutor_rect` supplied in context; leave "
        "`reserved_learner_work_rect` clear for the learner's working. Do not cover "
        "or erase learner ink; place corrections "
        "beside the relevant work. Inspect the board with view_board before grading, "
        "correcting, or placing content relative to learner writing; a requested "
        "standalone exercise or diagram may be drawn on an empty board without that "
        "look, and do not draw gratuitously for simple conversational answers."
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
                "maxItems": 200,
                "items": {"type": "string"},
                "description": "Stable ids to delete.",
            },
            "elements": {
                "type": "array",
                "maxItems": 200,
                "items": {
                    "anyOf": [
                        _board_element(
                            kind="text",
                            fields={
                                "x": {"type": "number", "description": "Left edge of the text, board points."},
                                "y": {"type": "number", "description": "Top edge of the text, board points."},
                                "text": {"type": "string", "maxLength": 2000, "description": "Text; newlines make multiple lines."},
                                "font_size": {"type": "number", "minimum": 8, "maximum": 256, "description": "Font size in board points."},
                                "alignment": {"type": "string", "enum": ["left", "center", "right"]},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000, "description": "Text box width; 0 means natural width."},
                            },
                            required=["x", "y", "text", "font_size", "alignment", "width"],
                        ),
                        _board_element(
                            kind="line",
                            fields={
                                "x1": {"type": "number", "description": "Start x, board points."},
                                "y1": {"type": "number", "description": "Start y, board points."},
                                "x2": {"type": "number", "description": "End x, board points."},
                                "y2": {"type": "number", "description": "End y, board points."},
                            },
                            required=["x1", "y1", "x2", "y2"],
                        ),
                        _board_element(
                            kind="arrow",
                            fields={
                                "x1": {"type": "number", "description": "Tail x, board points."},
                                "y1": {"type": "number", "description": "Tail y, board points."},
                                "x2": {"type": "number", "description": "Head x, board points."},
                                "y2": {"type": "number", "description": "Head y, board points."},
                                "head_size": {"type": "number", "minimum": 4, "maximum": 120, "description": "Arrowhead size in board points."},
                            },
                            required=["x1", "y1", "x2", "y2", "head_size"],
                        ),
                        _board_element(
                            kind="rectangle",
                            fields={
                                "x": {"type": "number", "description": "Top-left x, board points."},
                                "y": {"type": "number", "description": "Top-left y, board points."},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000},
                                "height": {"type": "number", "minimum": 0, "maximum": 50000},
                            },
                            required=["x", "y", "width", "height"],
                        ),
                        _board_element(
                            kind="ellipse",
                            fields={
                                "x": {"type": "number", "description": "Bounding-box top-left x, board points."},
                                "y": {"type": "number", "description": "Bounding-box top-left y, board points."},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000},
                                "height": {"type": "number", "minimum": 0, "maximum": 50000},
                            },
                            required=["x", "y", "width", "height"],
                        ),
                        _board_element(
                            kind="circle",
                            fields={
                                "cx": {"type": "number", "description": "Centre x, board points."},
                                "cy": {"type": "number", "description": "Centre y, board points."},
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
                        ),
                        _board_element(
                            kind="arc",
                            fields={
                                "cx": {"type": "number", "description": "Centre x, board points."},
                                "cy": {"type": "number", "description": "Centre y, board points."},
                                "radius": {"type": "number", "minimum": 0, "maximum": 50000},
                                "start_angle": {"type": "number", "description": "Start angle in degrees; 0 = right and values increase clockwise."},
                                "end_angle": {"type": "number", "description": "End angle in degrees. The arc sweeps clockwise from start to end, including sweeps over 180 degrees; use circle for a full turn."},
                            },
                            required=["cx", "cy", "radius", "start_angle", "end_angle"],
                        ),
                        _board_element(
                            kind="angle_marker",
                            fields={
                                "vertex_x": {"type": "number", "description": "Angle vertex x, board points."},
                                "vertex_y": {"type": "number", "description": "Angle vertex y, board points."},
                                "ray1_x": {"type": "number", "description": "A point on the first ray, board points."},
                                "ray1_y": {"type": "number", "description": "A point on the first ray, board points."},
                                "ray2_x": {"type": "number", "description": "A point on the second ray, board points."},
                                "ray2_y": {"type": "number", "description": "A point on the second ray, board points."},
                                "radius": {"type": "number", "minimum": 4, "maximum": 50000, "description": "Marker radius in board points."},
                                "right_angle": {"type": "boolean", "description": "Use the small-square convention for a right angle."},
                            },
                            required=[
                                "vertex_x", "vertex_y", "ray1_x", "ray1_y",
                                "ray2_x", "ray2_y", "radius", "right_angle",
                            ],
                        ),
                        _board_element(
                            kind="path",
                            fields={
                                "d": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": MAX_PATH_CHARS,
                                    "description": "One SVG path string — M, L, H, V, C, S, Q, T, A, Z. Every coordinate is in absolute board points, the same space as every other element, so the path needs no frame and no viewbox. Use this for curves and freeform shapes.",
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
                                "x": {"type": "number", "description": "Left edge of the notation, board points."},
                                "y": {"type": "number", "description": "Top edge of the notation, board points."},
                                "latex": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": MAX_LATEX_CHARS,
                                    "description": "The expression as LaTeX, with no surrounding $ or $$ delimiters, typeset on the learner's device. This is the only correct way to put mathematical notation on the board: never spell an equation out with text and never build one from lines, arcs, or SVG glyphs.",
                                },
                                "font_size": {"type": "number", "minimum": 8, "maximum": 256, "description": "Font size in board points."},
                            },
                            required=["x", "y", "latex", "font_size"],
                        ),
                        _board_element(
                            kind="image",
                            fields={
                                "x": {"type": "number", "description": "Left edge of the picture, board points."},
                                "y": {"type": "number", "description": "Top edge of the picture, board points."},
                                # Every size this schema allows is a size the
                                # scene model accepts: it refuses a frame with
                                # no area, and nothing is legible under a
                                # board point.
                                "width": {"type": "number", "minimum": 1, "maximum": 50000, "description": "Frame width in board points; the picture is drawn inside this frame."},
                                "height": {"type": "number", "minimum": 1, "maximum": 50000, "description": "Frame height in board points."},
                                "blob_id": {
                                    "type": "string",
                                    "pattern": "^sha256:[0-9a-f]{64}$",
                                    "description": "The key of a picture already on the server, copied from a tool result word for word. Never invent one: a key names bytes the server holds, and a made-up key draws an empty frame.",
                                },
                            },
                            required=["x", "y", "width", "height", "blob_id"],
                        ),
                        _board_element(
                            kind="svg",
                            fields={
                                "x": {"type": "number", "description": "Where the viewBox's top-left corner lands, board points."},
                                "y": {"type": "number", "description": "Where the viewBox's top-left corner lands, board points."},
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
# has produced a picture nobody can ever see. `loop._container_citations` is
# what finds those files, and `loop.FileRelay` is what keeps them.
TOOL_DEFINITIONS: list[dict] = [
    SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, UPDATE_BOARD_TOOL, FETCH_IMAGE_TOOL,
    *MEMORY_TOOL_DEFINITIONS,
    {"type": "web_search"},
    {"type": "code_interpreter", "container": {"type": "auto"}},
]
