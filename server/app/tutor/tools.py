from app.learner.mastery import RELIABILITY
from app.memory.schema import MemoryCategory
from app.tutor.board_scene import MAX_SVG_CHARS


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


def _style_properties() -> dict:
    """The style fields every semantic board element carries.

    Inline in each union arm rather than `$defs`: the strict schema is handed
    to the provider verbatim and a self-contained arm is easier for a model to
    satisfy. Every field is required because strict function schemas have no
    optional fields; the device defaults absent style to the same values these
    describe.
    """
    return {
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


def _board_element(*, kind: str, fields: dict, required: list[str]) -> dict:
    properties = {
        "id": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:+-]{1,128}$",
            "description": "Stable id. Reuse it in a later call to revise this object, or list it in delete_ids to remove it.",
        },
        "kind": {"type": "string", "const": kind},
    }
    properties.update(fields)
    properties.update(_style_properties())
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": ["id", "kind"] + required + list(_style_properties()),
    }


_POINT_SCHEMA = {
    "type": "array",
    "items": {"type": "number"},
    "minItems": 2,
    "maxItems": 2,
    "description": "One board point as [x, y].",
}


UPDATE_BOARD_TOOL: dict = {
    "type": "function",
    "name": "update_board",
    "description": (
        "Draw, label, correct, update, or delete the tutor's semantic objects on the "
        "learner's whiteboard. Use it when the learner explicitly asks for a visual, "
        "exercise, or diagram, and when a small visual correction materially helps "
        "(for example placing a correction beside their work). Tutor objects are "
        "structured text and geometry, never simulated handwriting. Use ordinary "
        "primitives for simple editable diagrams and raw SVG for complex "
        "multi-part illustrations such as rich paths, gradients, masks, filters, "
        "or elaborate figures; provide a complete raw SVG document, passed through unchanged and "
        "interpreted locally on the learner's device. This tool never touches the "
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
                                    "items": _POINT_SCHEMA,
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
                                    "items": _POINT_SCHEMA,
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
                                    "items": _POINT_SCHEMA,
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
                            kind="svg",
                            fields={
                                "x": {"type": "number", "description": "Left edge of the SVG frame, board points."},
                                "y": {"type": "number", "description": "Top edge of the SVG frame, board points."},
                                "width": {"type": "number", "minimum": 0, "maximum": 50000, "description": "SVG frame width in board points."},
                                "height": {"type": "number", "minimum": 0, "maximum": 50000, "description": "SVG frame height in board points."},
                                "svg": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": MAX_SVG_CHARS,
                                    "description": "A complete raw SVG document, passed through unchanged and interpreted locally on the learner's device. Accepts full declarative SVG markup including paths, gradients, masks, filters, clips, markers, symbols, text, and animation.",
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

REMEMBER_TOOL: dict = {
    "type": "function",
    "name": "remember",
    "description": (
        "Save something about this learner for future sessions. Call this when "
        "they ask you to remember or forget something, and when they tell you "
        "something that will still matter next time — a preference, a goal, a "
        "deadline, how they like to work. Write the fact so it stands alone "
        "with no surrounding conversation: resolve every pronoun and "
        "reference. Before you write any message containing 'noted', 'got it', "
        "or 'I'll remember that', call this tool first — otherwise you have "
        "told them something untrue."
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
        "required": ["text", "category"],
    },
}

SEARCH_MEMORY_TOOL: dict = {
    "type": "function",
    "name": "search_memory",
    "description": (
        "Search everything you know about this learner from previous sessions. "
        "Use it whenever answering depends on something they told you before — "
        "what they were working on, what they found hard, what they asked for. "
        "This tool has NO access to the current conversation, so your query "
        "must be entirely self-contained: write 'what has this learner said "
        "about preparing for their June exam', never 'what did they mean by "
        "that'. Never tell the learner you cannot remember something without "
        "searching here first."
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

RECENT_SESSIONS_TOOL: dict = {
    "type": "function",
    "name": "recent_sessions",
    "description": (
        "List what happened in recent sessions, most recent first, as short "
        "summaries. Use this for continuity questions — 'what did we do last "
        "time', 'where did we leave off' — where a search would be the wrong "
        "shape because the learner wants the sequence, not a fact."
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
        },
        "required": ["limit"],
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

#: The four that need a database session to answer, kept together so the
#: router and the registry cannot disagree about which those are. A name in one
#: and not the other is a tool the model is offered and then told is
#: unsupported — a whole turn spent on a dead round.
MEMORY_TOOL_DEFINITIONS: list[dict] = [
    REMEMBER_TOOL, SEARCH_MEMORY_TOOL, RECENT_SESSIONS_TOOL, RECORD_EVIDENCE_TOOL,
]
MEMORY_TOOLS: frozenset[str] = frozenset(
    tool["name"] for tool in MEMORY_TOOL_DEFINITIONS
)

# SEAM: later work appends here. Web search is {"type": "web_search"};
# file search is {"type": "file_search", "vector_store_ids": [...]}.
#
# Every tool a session can ever use is here, whether or not this turn could
# answer it. Tool definitions sit at the top of the provider's
# cache-invalidation hierarchy, so offering three tools on one turn and seven
# on the next re-bills the entire prompt prefix every time the set changes.
# `loop._answer` is where a tool the turn cannot serve is turned down.
TOOL_DEFINITIONS: list[dict] = [
    SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, UPDATE_BOARD_TOOL,
    *MEMORY_TOOL_DEFINITIONS,
]
