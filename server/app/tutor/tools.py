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
        "structured text and geometry, never simulated handwriting, and this tool "
        "never touches the learner's own PencilKit ink. Each object has a stable id: "
        "reuse ids to revise existing content and list ids in delete_ids to remove "
        "it. Pass elements=[] to only delete, delete_ids=[] to only upsert, or "
        "mode=replace_all to replace the entire tutor scene. Coordinates are logical "
        "board points: (0,0) is the board centre (25,000,25,000 in drawing "
        "coordinates), +x right, +y down. Keep new standalone diagrams compact and "
        "inside the current visible logical rectangle supplied in context. Do not cover "
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
                    ]
                },
            },
        },
        "required": ["mode", "delete_ids", "elements"],
    },
}

# SEAM: later work appends here. Web search is {"type": "web_search"};
# file search is {"type": "file_search", "vector_store_ids": [...]}.
TOOL_DEFINITIONS: list[dict] = [SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, UPDATE_BOARD_TOOL]
