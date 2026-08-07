import respx
from httpx import Response
from openai import AsyncOpenAI

from app.tutor.context import ContextBundle
from app.tutor.events import StatusEvent, TextDeltaEvent
from app.tutor.loop import run_turn
from tests.fixtures.sse import TEXT_ONLY_TURN, sse_stream


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

    import json
    body = json.loads(route.calls[0].request.content)
    assert body["store"] is False
    assert body["stream"] is True
    assert body["reasoning"] == {"effort": "high", "summary": "auto"}
    assert [tool["name"] for tool in body["tools"]] == ["set_workspace"]
