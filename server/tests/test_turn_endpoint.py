import json
import uuid

import respx
from httpx import ASGITransport, AsyncClient, Response

from app.main import create_app
from tests.fixtures.sse import TEXT_ONLY_TURN, sse_stream

AUTH = {"Authorization": "Bearer test-token"}


def _payload(**overrides):
    body = {
        "turn_id": str(uuid.uuid4()),
        "session_id": str(uuid.uuid4()),
        "text": "check my work",
        "model": "gpt-5.6-luna",
        "reasoning_effort": "high",
    }
    body.update(overrides)
    return body


async def _collect(response) -> list[dict]:
    events = []
    async for line in response.aiter_lines():
        if line.startswith("data: "):
            events.append(json.loads(line.removeprefix("data: ")))
    return events


@respx.mock
async def test_turn_streams_our_event_vocabulary(db_app):
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream(
            "POST", "/v1/turn", json=_payload(), headers=AUTH
        ) as response:
            assert response.status_code == 200
            assert response.headers["x-accel-buffering"] == "no"
            events = await _collect(response)

    kinds = [e["type"] for e in events]
    assert kinds[0] == "status"
    assert "text_delta" in kinds
    assert kinds[-1] == "done"


async def test_turn_requires_the_device_token(db_app):
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post("/v1/turn", json=_payload())
    assert response.status_code == 401


@respx.mock
async def test_an_image_produces_a_looking_status_before_thinking(db_app):
    import base64
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    payload = _payload(
        image_base64=base64.b64encode(b"pixels").decode(),
        image_region="the top of the board",
    )
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    assert events[0] == {"type": "status", "phase": "looking", "detail": None}


@respx.mock
async def test_a_replayed_turn_id_is_rejected_without_calling_the_model(db_app):
    route = respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    payload = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            await _collect(r)
        second = await client.post("/v1/turn", json=payload, headers=AUTH)

    assert second.status_code == 409
    assert route.call_count == 1
