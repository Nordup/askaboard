import json
import uuid

import httpx
import respx
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import select

from app.config import get_settings
from app.main import create_app
from app.store.models import Message, Session, Turn
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


@respx.mock
async def test_a_dropped_connection_fails_the_turn_visibly(db_app, db_factory):
    respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=httpx.ConnectError("connection reset by peer")
    )
    payload = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is True

    # str(APIConnectionError(...)) alone is just the generic "Connection
    # error." — both the event the client sees and the row we persist must
    # carry the exception type and the underlying httpx failure that
    # actually explains what went wrong, not just that generic string.
    assert "APIConnectionError" in events[-1]["message"]
    assert "connection reset by peer" in events[-1]["message"]

    # A turn that dies mid-stream must not stay "running" forever — that
    # would permanently poison the turn_id, since the idempotency check only
    # tests for the row's existence.
    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn.status == "error"
        assert "APIConnectionError" in turn.error["message"]
        assert "connection reset by peer" in turn.error["message"]


@respx.mock
async def test_a_failed_attachment_write_still_fails_the_turn_visibly(
    db_factory, tmp_path
):
    """record_attachment runs before any model call, but a failure there
    must be exactly as fatal to the turn as a failed model call — nothing
    between accepting the request and finishing it may strand a turn."""
    import base64

    from app.api.turn import get_recorder
    from app.store.blobs import LocalBlobStore
    from app.store.db import db_session
    from app.store.recorder import Recorder

    class _BrokenAttachmentRecorder(Recorder):
        async def record_attachment(self, **kwargs):
            raise OSError("disk full")

    app = create_app()

    async def _session():
        async with db_factory() as session:
            yield session

    app.dependency_overrides[db_session] = _session
    app.dependency_overrides[get_recorder] = lambda: _BrokenAttachmentRecorder(
        db_factory, LocalBlobStore(tmp_path)
    )

    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    payload = _payload(
        image_base64=base64.b64encode(b"pixels").decode(),
        image_region="the top of the board",
    )
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
                events = await _collect(r)
    finally:
        app.dependency_overrides.clear()

    assert events[-1]["type"] == "error"
    assert "OSError" in events[-1]["message"]

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn.status == "error"


@respx.mock
async def test_a_billing_429_is_reported_as_not_retryable(db_app):
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(
            429, json={"error": {"code": "insufficient_quota", "message": "no credits"}}
        )
    )
    payload = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is False


@respx.mock
async def test_a_billing_429_is_not_retried_by_the_sdk(db_app):
    """classify() alone is not enough — the openai SDK also retries 429s at
    the transport layer by default (max_retries=2), which would fire off two
    more requests before classify() ever saw the first response. Without
    max_retries=0 on the client, this would be call_count == 3."""
    route = respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(
            429, json={"error": {"code": "credit_balance_exhausted"}}
        )
    )
    payload = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is False
    assert route.call_count == 1


async def test_the_daily_spend_cap_returns_402(db_app, db_factory):
    cap = get_settings().daily_spend_cap_usd
    session_id = uuid.uuid4()
    async with db_factory() as db:
        db.add(Session(id=session_id, model="gpt-5.6-luna", reasoning_effort="high"))
        await db.flush()
        db.add(Turn(
            id=uuid.uuid4(), session_id=session_id, status="ok",
            model="gpt-5.6-luna", reasoning_effort="high", cost_usd=cap,
        ))
        await db.commit()

    payload = _payload(session_id=str(session_id))
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post("/v1/turn", json=payload, headers=AUTH)

    assert response.status_code == 402


@respx.mock
async def test_a_second_turn_continues_seq_instead_of_restarting_at_zero(db_app, db_factory):
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    session_id = str(uuid.uuid4())
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream(
            "POST", "/v1/turn", json=_payload(session_id=session_id, text="first"),
            headers=AUTH,
        ) as r:
            await _collect(r)
        async with client.stream(
            "POST", "/v1/turn", json=_payload(session_id=session_id, text="second"),
            headers=AUTH,
        ) as r:
            await _collect(r)

    async with db_factory() as db:
        rows = (await db.execute(
            select(Message)
            .where(Message.session_id == uuid.UUID(session_id))
            .order_by(Message.seq)
        )).scalars().all()

    assert [m.seq for m in rows] == [0, 1]
    assert [m.text for m in rows] == ["first", "second"]
