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

# SEAM: later work appends here. Web search is {"type": "web_search"};
# file search is {"type": "file_search", "vector_store_ids": [...]}.
TOOL_DEFINITIONS: list[dict] = [SET_WORKSPACE_TOOL]
