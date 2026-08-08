import json

import respx
from httpx import Response
from openai import AsyncOpenAI
from openai._streaming import SSEDecoder

from app.tutor.context import ContextBundle
from app.tutor.events import ReasoningDeltaEvent, StatusEvent, TextDeltaEvent, WorkspaceEvent
from app.tutor.loop import MAX_TOOL_ROUNDS, run_turn
from tests.fixtures.sse import (
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
    assert [tool["name"] for tool in body["tools"]] == ["set_workspace", "view_board"]


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
