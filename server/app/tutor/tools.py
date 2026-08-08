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

# SEAM: later work appends here. Web search is {"type": "web_search"};
# file search is {"type": "file_search", "vector_store_ids": [...]}.
TOOL_DEFINITIONS: list[dict] = [SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL]
