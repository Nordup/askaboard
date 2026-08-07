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
    # The trailing "\n" matters: without it the [DONE] line never gets the
    # blank-line terminator every earlier record gets for free from the line
    # that follows it, so the SDK's SSE decoder never flushes it as its own
    # ServerSentEvent. See test_sse_stream_terminates_done_as_its_own_record.
    return ("\n".join(lines) + "\n").encode()


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


WORKSPACE_ARGUMENTS = {
    "plan": {
        "title": "Fractions",
        "goal": "Add fractions with unlike denominators",
        "outcomes": ["Find a common denominator", "Add the numerators"],
        "steps": ["Find the LCD", "Convert both fractions", "Add and simplify"],
        "currentStep": 0,
    },
    "exercise": {
        "title": "Add 1/3 and 1/4",
        "prompt": "What is 1/3 + 1/4?",
        "hint": "Find a common denominator first.",
        "context": "Unlike denominators",
    },
}


TOOL_CALL_TURN = (
    {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_2"}},
    {
        "type": "response.output_item.added",
        "sequence_number": 1,
        "output_index": 0,
        "item": {
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_1",
            "name": "set_workspace",
            "arguments": "",
        },
    },
    {
        "type": "response.function_call_arguments.delta",
        "sequence_number": 2,
        "output_index": 0,
        "item_id": "fc_1",
        "delta": '{"plan": {"title": "Fractions",',
    },
    {
        "type": "response.function_call_arguments.delta",
        "sequence_number": 3,
        "output_index": 0,
        "item_id": "fc_1",
        "delta": ' "goal": "Add fractions with unlike denominators", "..."}',
    },
    {
        "type": "response.function_call_arguments.done",
        "sequence_number": 4,
        "output_index": 0,
        "item_id": "fc_1",
        "name": "set_workspace",
        "arguments": json.dumps(WORKSPACE_ARGUMENTS),
    },
    {
        "type": "response.completed",
        "sequence_number": 5,
        "response": {
            "id": "resp_2",
            "usage": {"input_tokens": 60, "output_tokens": 24},
        },
    },
)


REASONING_TURN = (
    {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_3"}},
    {
        "type": "response.reasoning_summary_text.delta",
        "sequence_number": 1,
        "item_id": "rs_1",
        "output_index": 0,
        "summary_index": 0,
        "delta": "Checking the ",
    },
    {
        "type": "response.reasoning_summary_text.delta",
        "sequence_number": 2,
        "item_id": "rs_1",
        "output_index": 0,
        "summary_index": 0,
        "delta": "denominators.",
    },
    {
        "type": "response.output_text.delta",
        "sequence_number": 3,
        "delta": "Let's add these fractions.",
    },
    {
        "type": "response.output_text.done",
        "sequence_number": 4,
        "text": "Let's add these fractions.",
    },
    {
        "type": "response.completed",
        "sequence_number": 5,
        "response": {
            "id": "resp_3",
            "usage": {"input_tokens": 40, "output_tokens": 12},
        },
    },
)
