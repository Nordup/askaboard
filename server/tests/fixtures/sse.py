import json


def sse_stream(*events: dict) -> bytes:
    """Encode events as the wire bytes the Responses API actually sends."""
    lines = []
    for event in events:
        lines.append(f"event: {event['type']}")
        lines.append(f"data: {json.dumps(event)}")
        lines.append("")
    lines.append("data: [DONE]")
    lines.append("")
    return "\n".join(lines).encode()


TEXT_ONLY_TURN = (
    {"type": "response.created", "response": {"id": "resp_1"}},
    {"type": "response.output_text.delta", "delta": "Nice "},
    {"type": "response.output_text.delta", "delta": "work."},
    {"type": "response.output_text.done", "text": "Nice work."},
    {
        "type": "response.completed",
        "response": {
            "id": "resp_1",
            "usage": {"input_tokens": 120, "output_tokens": 8},
        },
    },
)
