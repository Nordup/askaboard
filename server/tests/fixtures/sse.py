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
            # `output` is not optional on a real `response.completed`, and this
            # fixture used to omit it — which is precisely why no test caught
            # that a function call ends the response and has to be answered
            # before the model will write anything. A reasoning item rides
            # along with it, as it does on every reasoning-model response.
            "output": [
                {"type": "reasoning", "id": "rs_2", "summary": []},
                {
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_1",
                    "name": "set_workspace",
                    "arguments": json.dumps(WORKSPACE_ARGUMENTS),
                    "status": "completed",
                },
            ],
        },
    },
)


# What the model writes once the tool call has been answered — the second leg
# of a turn that sets the workspace, and the only leg the learner reads.
TOOL_CALL_FOLLOW_UP = (
    {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_2b"}},
    {"type": "response.output_text.delta", "sequence_number": 1, "delta": "Here is your plan."},
    {"type": "response.output_text.done", "sequence_number": 2, "text": "Here is your plan."},
    {
        "type": "response.completed",
        "sequence_number": 3,
        "response": {
            "id": "resp_2b",
            "usage": {"input_tokens": 90, "output_tokens": 12},
            "output": [
                {"type": "message", "id": "msg_1", "role": "assistant",
                 "content": [{"type": "output_text", "text": "Here is your plan."}]},
            ],
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


BOARD_UPDATE_ARGUMENTS = {
    "mode": "upsert",
    "delete_ids": ["old_label"],
    "elements": [
        {
            "id": "vector",
            "kind": "arrow",
            "x1": 0,
            "y1": 0,
            "x2": 300,
            "y2": -180,
            "head_size": 18,
            "role": "content",
            "stroke": "#0155FB",
            "fill": "transparent",
            "stroke_width": 5,
            "opacity": 1,
            "dash": [],
            "rotation": 0,
        },
        {
            "id": "vector_label",
            "kind": "text",
            "x": 330,
            "y": -220,
            "text": "v = (300, -180)",
            "font_size": 42,
            "alignment": "left",
            "width": 0,
            "role": "emphasis",
            "stroke": "#0A0A0A",
            "fill": "transparent",
            "stroke_width": 1,
            "opacity": 1,
            "dash": [],
            "rotation": 0,
        },
    ],
}


BOARD_UPDATE_TURN = (
    {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_board"}},
    {
        "type": "response.output_item.added",
        "sequence_number": 1,
        "output_index": 0,
        "item": {
            "type": "function_call",
            "id": "fc_board",
            "call_id": "call_board",
            "name": "update_board",
            "arguments": "",
        },
    },
    {
        "type": "response.function_call_arguments.delta",
        "sequence_number": 2,
        "output_index": 0,
        "item_id": "fc_board",
        "delta": '{"mode": "upsert",',
    },
    {
        "type": "response.function_call_arguments.done",
        "sequence_number": 3,
        "output_index": 0,
        "item_id": "fc_board",
        "name": "update_board",
        "arguments": json.dumps(BOARD_UPDATE_ARGUMENTS),
    },
    {
        "type": "response.completed",
        "sequence_number": 4,
        "response": {
            "id": "resp_board",
            "usage": {"input_tokens": 60, "output_tokens": 24},
            "output": [
                {"type": "reasoning", "id": "rs_board", "summary": []},
                {
                    "type": "function_call",
                    "id": "fc_board",
                    "call_id": "call_board",
                    "name": "update_board",
                    "arguments": json.dumps(BOARD_UPDATE_ARGUMENTS),
                    "status": "completed",
                },
            ],
        },
    },
)


BOARD_UPDATE_FOLLOW_UP = (
    {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_board_2"}},
    {"type": "response.output_text.delta", "sequence_number": 1, "delta": "Here is the vector diagram."},
    {"type": "response.output_text.done", "sequence_number": 2, "text": "Here is the vector diagram."},
    {
        "type": "response.completed",
        "sequence_number": 3,
        "response": {
            "id": "resp_board_2",
            "usage": {"input_tokens": 90, "output_tokens": 12},
            "output": [
                {"type": "message", "id": "msg_board", "role": "assistant",
                 "content": [{"type": "output_text", "text": "Here is the vector diagram."}]},
            ],
        },
    },
)


FETCH_IMAGE_ARGUMENTS = {"url": "https://example.com/parabola.png"}


FETCH_IMAGE_TURN = (
    {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_fetch"}},
    {
        "type": "response.output_item.added",
        "sequence_number": 1,
        "output_index": 0,
        "item": {
            "type": "function_call",
            "id": "fc_fetch",
            "call_id": "call_fetch",
            "name": "fetch_image",
            "arguments": "",
        },
    },
    {
        "type": "response.function_call_arguments.done",
        "sequence_number": 2,
        "output_index": 0,
        "item_id": "fc_fetch",
        "name": "fetch_image",
        "arguments": json.dumps(FETCH_IMAGE_ARGUMENTS),
    },
    {
        "type": "response.completed",
        "sequence_number": 3,
        "response": {
            "id": "resp_fetch",
            "usage": {"input_tokens": 70, "output_tokens": 14},
            "output": [
                {"type": "reasoning", "id": "rs_fetch", "summary": []},
                {
                    "type": "function_call",
                    "id": "fc_fetch",
                    "call_id": "call_fetch",
                    "name": "fetch_image",
                    "arguments": json.dumps(FETCH_IMAGE_ARGUMENTS),
                    "status": "completed",
                },
            ],
        },
    },
)


FETCH_IMAGE_FOLLOW_UP = (
    {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_fetch_2"}},
    {"type": "response.output_text.delta", "sequence_number": 1, "delta": "Here is the parabola."},
    {"type": "response.output_text.done", "sequence_number": 2, "text": "Here is the parabola."},
    {
        "type": "response.completed",
        "sequence_number": 3,
        "response": {
            "id": "resp_fetch_2",
            "usage": {"input_tokens": 95, "output_tokens": 11},
            "output": [
                {"type": "message", "id": "msg_fetch", "role": "assistant",
                 "content": [{"type": "output_text", "text": "Here is the parabola."}]},
            ],
        },
    },
)
