import json

import respx
from httpx import Response
from openai import AsyncOpenAI
from openai._streaming import SSEDecoder

from app.tutor.context import ContextBundle
from app.tutor.events import (
    BoardUpdateEvent, ReasoningDeltaEvent, StatusEvent, TextDeltaEvent,
    WorkspaceEvent,
)
from app.tutor.loop import (
    MALFORMED_BOARD_ACK,
    MAX_TOOL_ROUNDS,
    UNSUPPORTED_TOOL_ACK,
    UPDATE_BOARD_ACK,
    _answer,
    run_turn,
)
from tests.fixtures.sse import (
    BOARD_UPDATE_FOLLOW_UP,
    BOARD_UPDATE_TURN,
    REASONING_TURN,
    TEXT_ONLY_TURN,
    TOOL_CALL_FOLLOW_UP,
    TOOL_CALL_TURN,
    WORKSPACE_ARGUMENTS,
    sse_stream,
)


def test_sse_stream_terminates_done_as_its_own_record():
    """Prove the fixture's [DONE] line is a real, independently-decoded SSE
    record — not dead code that only happens to coincide with the byte
    source running out.

    Feeds the encoded bytes through the real SDK's own SSEDecoder (the exact
    class AsyncStream uses) and asserts a record with data "[DONE]" comes
    back as its own ServerSentEvent, distinct from the preceding events.
    Without the trailing newline in sse_stream, this fails: the decoder only
    ever flushes a record on a blank line, and the [DONE] line never got one.
    """
    raw = sse_stream(*TEXT_ONLY_TURN)

    decoder = SSEDecoder()
    sses = list(decoder.iter_bytes(iter([raw])))

    assert len(sses) == len(TEXT_ONLY_TURN) + 1
    assert sses[-1].data == "[DONE]"
    assert [sse.event for sse in sses[:-1]] == [event["type"] for event in TEXT_ONLY_TURN]


@respx.mock
async def test_a_text_only_turn_streams_status_then_text():
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=sse_stream(*TEXT_ONLY_TURN),
        )
    )
    client = AsyncOpenAI(api_key="sk-test")
    bundle = ContextBundle(system="s", input=[{"role": "user", "content": "hi"}])

    events = []
    result = None
    async for event, running in run_turn(
        client=client, model="gpt-5.6-luna", effort="high", bundle=bundle
    ):
        events.append(event)
        result = running

    assert events[0] == StatusEvent(phase="thinking")
    assert TextDeltaEvent(text="Nice ") in events
    assert result.text == "Nice work."
    assert result.usage == {"input_tokens": 120, "output_tokens": 8}
    assert len(result.raw_events) == len(TEXT_ONLY_TURN)


@respx.mock
async def test_the_request_body_carries_the_tool_and_disables_storage():
    route = respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=sse_stream(*TEXT_ONLY_TURN),
        )
    )
    client = AsyncOpenAI(api_key="sk-test")
    bundle = ContextBundle(system="s", input=[{"role": "user", "content": "hi"}])

    async for _ in run_turn(
        client=client, model="gpt-5.6-luna", effort="high", bundle=bundle
    ):
        pass

    body = json.loads(route.calls[0].request.content)
    assert body["store"] is False
    assert body["stream"] is True
    assert body["reasoning"] == {"effort": "high", "summary": "auto"}
    assert [tool["name"] for tool in body["tools"]] == [
        "set_workspace", "view_board", "update_board",
    ]


@respx.mock
async def test_a_tool_call_turn_yields_a_workspace_event():
    """Guards the Responses-vs-Realtime event name trap: this turn only
    produces a WorkspaceEvent if response.output_item.added and
    response.function_call_arguments.{delta,done} — the Responses API's
    dotted names — are the ones the translator (and the real SDK) actually
    fire on. A silently-wrong event name (e.g. the Realtime API's
    response.function_call.arguments_delta) would make this test fail by
    producing zero WorkspaceEvents rather than passing by accident.
    """
    respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TOOL_CALL_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TOOL_CALL_FOLLOW_UP)),
        ]
    )
    client = AsyncOpenAI(api_key="sk-test")
    bundle = ContextBundle(system="s", input=[{"role": "user", "content": "hi"}])

    events = []
    result = None
    async for event, running in run_turn(
        client=client, model="gpt-5.6-luna", effort="high", bundle=bundle
    ):
        events.append(event)
        result = running

    workspace_events = [event for event in events if isinstance(event, WorkspaceEvent)]
    assert len(workspace_events) == 1

    workspace = workspace_events[0]
    assert workspace.plan.title == WORKSPACE_ARGUMENTS["plan"]["title"]
    assert workspace.plan.goal == WORKSPACE_ARGUMENTS["plan"]["goal"]
    assert workspace.plan.outcomes == WORKSPACE_ARGUMENTS["plan"]["outcomes"]
    assert workspace.plan.steps == WORKSPACE_ARGUMENTS["plan"]["steps"]
    assert workspace.plan.currentStep == WORKSPACE_ARGUMENTS["plan"]["currentStep"]
    assert workspace.exercise.title == WORKSPACE_ARGUMENTS["exercise"]["title"]
    assert workspace.exercise.prompt == WORKSPACE_ARGUMENTS["exercise"]["prompt"]
    assert workspace.exercise.hint == WORKSPACE_ARGUMENTS["exercise"]["hint"]
    assert workspace.exercise.context == WORKSPACE_ARGUMENTS["exercise"]["context"]

    assert result.workspace is not None
    assert result.workspace["plan"]["title"] == WORKSPACE_ARGUMENTS["plan"]["title"]
    assert result.workspace["exercise"]["prompt"] == WORKSPACE_ARGUMENTS["exercise"]["prompt"]


@respx.mock
async def test_a_reasoning_turn_yields_reasoning_deltas():
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            content=sse_stream(*REASONING_TURN),
        )
    )
    client = AsyncOpenAI(api_key="sk-test")
    bundle = ContextBundle(system="s", input=[{"role": "user", "content": "hi"}])

    events = []
    async for event, _ in run_turn(
        client=client, model="gpt-5.6-luna", effort="high", bundle=bundle
    ):
        events.append(event)

    assert ReasoningDeltaEvent(text="Checking the ") in events
    assert ReasoningDeltaEvent(text="denominators.") in events


@respx.mock
async def test_an_update_board_turn_yields_a_board_update_event_and_prose():
    """The board update event is the mutation, the ack is the handshake, and
    the model keeps writing after both — the same shape that fixed the
    workspace silence must hold for the drawing tool."""
    respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*BOARD_UPDATE_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*BOARD_UPDATE_FOLLOW_UP)),
        ]
    )
    client = AsyncOpenAI(api_key="sk-test")
    bundle = ContextBundle(system="s", input=[{"role": "user", "content": "draw it"}])

    events = []
    result = None
    async for event, running in run_turn(
        client=client, model="gpt-5.6-luna", effort="high", bundle=bundle
    ):
        events.append(event)
        result = running

    update_events = [event for event in events if isinstance(event, BoardUpdateEvent)]
    assert len(update_events) == 1
    assert update_events[0].payload.upserts[0].id == "vector"
    assert update_events[0].payload.deletes == ["old_label"]
    assert result.text == "Here is the vector diagram."


def test_update_board_is_answered_with_its_own_ack_not_set_workspaces():
    answer = _answer(
        {"call_id": "c", "name": "update_board", "arguments": '{"mode":"upsert","delete_ids":[],"elements":[]}'},
        has_board=True,
    )
    assert answer.ask is None
    assert answer.items[0]["output"] == UPDATE_BOARD_ACK


def test_malformed_update_board_is_rejected_without_an_applied_ack():
    answer = _answer(
        {"call_id": "c", "name": "update_board", "arguments": '{"elements": "not a list"}'},
        has_board=True,
    )
    assert answer.items[0]["output"] == MALFORMED_BOARD_ACK


def test_an_unknown_tool_is_answered_with_an_unsupported_ack():
    answer = _answer(
        {"call_id": "c", "name": "future_web_search", "arguments": "{}"},
        has_board=True,
    )
    assert answer.ask is None
    assert answer.items[0]["output"] == UNSUPPORTED_TOOL_ACK
    assert json.loads(answer.items[0]["output"])["status"] == "unsupported"


@respx.mock
async def test_a_tool_call_is_answered_so_the_model_writes_its_reply():
    """**The bug the loop exists for.** A function call ends a Responses API
    response: the model stops, having written no prose. A single-request turn
    therefore ended with the workspace set and the thread silent — the learner
    got a new plan on the board and nothing to read.

    So the tool result goes back and the model is asked to continue. This
    asserts the second request happens, that it carries the call's output, and
    that the text the learner actually reads comes out of it.
    """
    route = respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TOOL_CALL_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TOOL_CALL_FOLLOW_UP)),
        ]
    )
    client = AsyncOpenAI(api_key="sk-test")
    bundle = ContextBundle(system="s", input=[{"role": "user", "content": "hi"}])

    result = None
    async for _event, running in run_turn(
        client=client, model="gpt-5.6-luna", effort="high", bundle=bundle
    ):
        result = running

    assert route.call_count == 2, "the tool call has to be answered, not left hanging"
    assert result.text == "Here is your plan.", "the learner reads the second leg"
    assert result.workspace is not None, "and the first leg still set the workspace"

    second = json.loads(route.calls[1].request.content)
    kinds = [item.get("type") for item in second["input"]]
    assert "function_call" in kinds
    assert "function_call_output" in kinds
    output = next(i for i in second["input"] if i.get("type") == "function_call_output")
    assert output["call_id"] == "call_1"
    # A reasoning item from a store=False response is a bare id the API has not
    # kept; handing it back names an item that does not exist.
    assert "reasoning" not in kinds


@respx.mock
async def test_a_model_that_only_ever_calls_the_tool_is_bounded():
    """Whatever prose arrived by the bound is the answer. Without it, a model
    that answers every tool result with another tool call bills the learner
    until something else stops it."""
    route = respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TOOL_CALL_TURN))
    )
    client = AsyncOpenAI(api_key="sk-test")
    bundle = ContextBundle(system="s", input=[{"role": "user", "content": "hi"}])

    async for _event, _running in run_turn(
        client=client, model="gpt-5.6-luna", effort="high", bundle=bundle
    ):
        pass

    assert route.call_count == MAX_TOOL_ROUNDS


@respx.mock
async def test_usage_is_summed_across_a_turns_rounds():
    """One turn, one bill. Keeping only the last round's usage under-reports
    exactly the turns that called a tool, which are the expensive ones."""
    respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TOOL_CALL_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TOOL_CALL_FOLLOW_UP)),
        ]
    )
    client = AsyncOpenAI(api_key="sk-test")
    bundle = ContextBundle(system="s", input=[{"role": "user", "content": "hi"}])

    result = None
    async for _event, running in run_turn(
        client=client, model="gpt-5.6-luna", effort="high", bundle=bundle
    ):
        result = running

    assert result.usage["input_tokens"] == 60 + 90
    assert result.usage["output_tokens"] == 24 + 12


SVG_UPDATE_ARGUMENTS = {
    "mode": "upsert",
    "delete_ids": [],
    "elements": [{
        "id": "circuit",
        "kind": "svg",
        "x": -200,
        "y": -160,
        "width": 400,
        "height": 320,
        "svg": (
            '<svg viewBox="0 0 400 320">'
            '<defs><linearGradient id="g">'
            '<stop offset="0" stop-color="#0155FB"/></linearGradient></defs>'
            '<path d="M20 160 L180 60" fill="url(#g)"/></svg>'
        ),
        "role": "content",
        "stroke": "#0A0A0A",
        "fill": "transparent",
        "stroke_width": 4,
        "opacity": 1,
        "dash": [],
        "rotation": 0,
    }],
}


SVG_BOARD_UPDATE_TURN = (
    {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_svg"}},
    {
        "type": "response.output_item.added",
        "sequence_number": 1,
        "output_index": 0,
        "item": {
            "type": "function_call",
            "id": "fc_svg",
            "call_id": "call_svg",
            "name": "update_board",
            "arguments": "",
        },
    },
    {
        "type": "response.function_call_arguments.done",
        "sequence_number": 2,
        "output_index": 0,
        "item_id": "fc_svg",
        "name": "update_board",
        "arguments": json.dumps(SVG_UPDATE_ARGUMENTS),
    },
    {
        "type": "response.completed",
        "sequence_number": 3,
        "response": {
            "id": "resp_svg",
            "usage": {"input_tokens": 60, "output_tokens": 24},
            "output": [
                {"type": "reasoning", "id": "rs_svg", "summary": []},
                {
                    "type": "function_call",
                    "id": "fc_svg",
                    "call_id": "call_svg",
                    "name": "update_board",
                    "arguments": json.dumps(SVG_UPDATE_ARGUMENTS),
                    "status": "completed",
                },
            ],
        },
    },
)


SVG_BOARD_UPDATE_FOLLOW_UP = (
    {"type": "response.created", "sequence_number": 0, "response": {"id": "resp_svg_2"}},
    {
        "type": "response.output_text.delta",
        "sequence_number": 1,
        "delta": "Here is the circuit.",
    },
    {
        "type": "response.output_text.done",
        "sequence_number": 2,
        "text": "Here is the circuit.",
    },
    {
        "type": "response.completed",
        "sequence_number": 3,
        "response": {
            "id": "resp_svg_2",
            "usage": {"input_tokens": 90, "output_tokens": 12},
            "output": [
                {
                    "type": "message",
                    "id": "msg_svg",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Here is the circuit."}],
                }
            ],
        },
    },
)


def test_update_board_accepts_raw_svg_and_acknowledges_it():
    answer = _answer(
        {"call_id": "c", "name": "update_board", "arguments": json.dumps(SVG_UPDATE_ARGUMENTS)},
        has_board=True,
    )

    assert answer.ask is None
    assert answer.items[0]["output"] == UPDATE_BOARD_ACK


@respx.mock
async def test_an_svg_update_board_turn_streams_the_raw_document_unchanged():
    respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*SVG_BOARD_UPDATE_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*SVG_BOARD_UPDATE_FOLLOW_UP)),
        ]
    )
    client = AsyncOpenAI(api_key="sk-test")
    bundle = ContextBundle(system="s", input=[{"role": "user", "content": "draw a circuit"}])

    events = []
    result = None
    async for event, running in run_turn(
        client=client, model="gpt-5.6-luna", effort="high", bundle=bundle
    ):
        events.append(event)
        result = running

    update_events = [event for event in events if isinstance(event, BoardUpdateEvent)]
    assert len(update_events) == 1
    svg = update_events[0].payload.upserts[0]
    assert svg.kind == "svg"
    assert svg.svg == SVG_UPDATE_ARGUMENTS["elements"][0]["svg"]
    assert result.text == "Here is the circuit."
