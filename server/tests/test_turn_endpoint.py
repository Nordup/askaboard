import asyncio
import contextlib
import json
import uuid

import httpx
import respx
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import select

from app.config import DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, get_settings
from app.main import create_app
from app.store.models import Message, Session, Turn
from app.tutor.events import StatusEvent
from app.tutor.loop import TurnResult
from tests.fixtures.sse import (
    TEXT_ONLY_TURN, TOOL_CALL_FOLLOW_UP, TOOL_CALL_TURN, sse_stream,
)

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


@respx.mock
async def test_a_turn_refreshes_the_model_on_a_session_it_did_not_create(db_app, db_factory):
    """A session created by /v1/dictation carries `DEFAULT_MODEL`, because the
    dictation form names no model. The first turn has to correct it, or a
    dictation-first session would report the wrong route for the rest of its
    life while its `Turn` rows said something else."""
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    session_id = uuid.uuid4()
    async with db_factory() as db:
        db.add(Session(id=session_id, model=DEFAULT_MODEL,
                       reasoning_effort=DEFAULT_REASONING_EFFORT))
        await db.commit()

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream(
            "POST", "/v1/turn",
            json=_payload(session_id=str(session_id), model="gpt-5.6-sol",
                          reasoning_effort="low"),
            headers=AUTH,
        ) as response:
            assert response.status_code == 200
            await _collect(response)

    async with db_factory() as db:
        session = await db.get(Session, session_id)
        assert session.model == "gpt-5.6-sol"
        assert session.reasoning_effort == "low"


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

    # Each turn now writes both the learner's message and the tutor's reply
    # (see Recorder.finish_turn) — the learner's own seq must still continue
    # forward rather than restarting at 0 on the second turn, interleaved
    # tutor rows and all. Before the C1 fix this asserted just
    # ["first", "second"], which is the exact shape that confirms the
    # tutor's replies are silently absent rather than proving anything about
    # seq continuation.
    assert [(m.seq, m.role, m.text) for m in rows] == [
        (0, "learner", "first"),
        (1, "tutor", "Nice work."),
        (2, "learner", "second"),
        (3, "tutor", "Nice work."),
    ]


@respx.mock
async def test_a_second_turns_prompt_contains_the_first_turns_reply(db_app):
    """C1: assemble_context's transcript must include what the tutor said on
    the previous turn, not just what the learner said — otherwise turn 3 of
    a session has no record of anything the model replied to. This inspects
    the captured respx request body (not our own internal state): reading
    our own persisted rows back would happily pass even if the tutor's
    reply were never included in the prompt actually sent to the provider.
    """
    route = respx.post("https://api.openai.com/v1/responses").mock(
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

    assert route.call_count == 2
    second_turn_body = json.loads(route.calls[1].request.content)
    prompt_text = second_turn_body["input"][1]["content"][0]["text"]
    assert "learner: first" in prompt_text
    assert "tutor: Nice work." in prompt_text
    assert "learner: second" in prompt_text


@respx.mock
async def test_a_turn_that_sets_the_workspace_persists_plan_and_exercise(
    db_app, db_factory
):
    """C2: sessions.plan / sessions.exercise must be written when a turn
    fires set_workspace, and a later turn's prompt must actually include the
    EXERCISE CONTEXT / SESSION PLAN sections compose_user_prompt only emits
    when those columns are non-null."""
    # Three provider calls for two turns: the first turn's tool call has to be
    # answered before the model will write anything, so that turn is two
    # requests on its own. See `app.tutor.loop.run_turn`.
    route = respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TOOL_CALL_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TOOL_CALL_FOLLOW_UP)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TEXT_ONLY_TURN)),
        ]
    )
    session_id = str(uuid.uuid4())
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream(
            "POST", "/v1/turn",
            json=_payload(session_id=session_id, text="give me an exercise"),
            headers=AUTH,
        ) as r:
            await _collect(r)

        async with db_factory() as db:
            session = await db.get(Session, uuid.UUID(session_id))
            assert session.plan is not None
            assert session.exercise is not None
            assert session.plan["title"] == "Fractions"
            assert session.exercise["prompt"] == "What is 1/3 + 1/4?"

        async with client.stream(
            "POST", "/v1/turn", json=_payload(session_id=session_id, text="ok next"),
            headers=AUTH,
        ) as r:
            await _collect(r)

    assert route.call_count == 3
    second_turn_body = json.loads(route.calls[2].request.content)
    prompt_text = second_turn_body["input"][1]["content"][0]["text"]
    assert "EXERCISE CONTEXT" in prompt_text
    assert "SESSION PLAN" in prompt_text


@respx.mock
async def test_an_unallowed_model_is_rejected_before_any_provider_call(db_app):
    """I7: the model is unvalidated device input straight to the provider —
    MODEL_ALLOWLIST + a 422 is today's only real ceiling, since the spend
    cap is inert (see the comment at the check in app/api/turn.py). The
    route is mocked but never expected to be hit — if validation regressed
    and the code called the provider anyway, respx (not a live request)
    would be what answered."""
    route = respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=sse_stream(*TEXT_ONLY_TURN),
        )
    )
    payload = _payload(model="gpt-5.6-mega-expensive")
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post("/v1/turn", json=payload, headers=AUTH)

    assert response.status_code == 422
    assert route.call_count == 0


async def test_an_exception_in_assemble_context_leaves_the_turn_not_running(
    db_app, db_factory, monkeypatch
):
    """C3: assemble_context used to run entirely outside the guarded
    generator — an exception there committed the turn as "running" and then
    500'd with nothing left to catch it, permanently stranding the
    turn_id."""
    def _boom(**kwargs):
        raise ValueError("boom")

    monkeypatch.setattr("app.api.turn.assemble_context", _boom)

    payload = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    assert events[-1]["type"] == "error"
    assert "ValueError" in events[-1]["message"]

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn.status == "error"
        assert turn.status != "running"


@respx.mock
async def test_a_finish_turn_failure_leaves_the_turn_not_running(db_factory, tmp_path):
    """C3: recorder.finish_turn used to sit outside the try/except entirely
    — a blob write plus a Neon round trip that, on failure, left a
    truncated stream and a turn stuck at status="running" forever."""
    from app.api.turn import get_recorder
    from app.store.blobs import LocalBlobStore
    from app.store.db import db_session
    from app.store.recorder import Recorder

    class _BrokenFinishRecorder(Recorder):
        async def finish_turn(self, **kwargs):
            raise RuntimeError("neon unreachable")

    app = create_app()

    async def _session():
        async with db_factory() as session:
            yield session

    app.dependency_overrides[db_session] = _session
    app.dependency_overrides[get_recorder] = lambda: _BrokenFinishRecorder(
        db_factory, LocalBlobStore(tmp_path)
    )

    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    payload = _payload()
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
                events = await _collect(r)
    finally:
        app.dependency_overrides.clear()

    assert events[-1]["type"] == "error"
    assert "RuntimeError" in events[-1]["message"]

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn.status == "error"
        assert turn.status != "running"


async def test_a_client_disconnect_mid_stream_leaves_the_turn_not_running(
    db_app, db_factory, monkeypatch
):
    """C4: a real disconnect throws asyncio.CancelledError into the
    generator at its current yield. CancelledError is a BaseException, not
    an Exception, so `except Exception` alone would miss it and nothing
    would ever persist. This stands in for a real disconnect by making
    run_turn itself raise CancelledError partway through a turn — exactly
    what Starlette's disconnect-cancellation does to this generator,
    regardless of what triggered it — and checks the one thing the finding
    actually requires: the turn does not stay "running"."""

    async def _cancelled_run_turn(*, client, model, effort, bundle):
        result = TurnResult()
        yield StatusEvent(phase="thinking"), result
        raise asyncio.CancelledError()

    monkeypatch.setattr("app.api.turn.run_turn", _cancelled_run_turn)

    payload = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        with contextlib.suppress(BaseException):
            async with client.stream(
                "POST", "/v1/turn", json=payload, headers=AUTH
            ) as r:
                async for _ in r.aiter_lines():
                    pass

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn is not None
        assert turn.status != "running"
