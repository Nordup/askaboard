import asyncio
import contextlib
import json
import uuid

import anyio
import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import select

from app.api.turn import TurnRequest
from app.tutor.board_scene import MAX_SCENE_CHARS
from app.config import DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, get_settings
from app.main import create_app
from app.store.models import Message, Session, Turn
from app.tutor.events import TURN_FAILED_MESSAGE, StatusEvent
from app.tutor.loop import TurnResult
from tests.conftest import requires_db
from tests.fixtures.sse import (
    FETCH_IMAGE_FOLLOW_UP, FETCH_IMAGE_TURN, RATE_LIMIT_MESSAGE,
    RATE_LIMITED_MID_STREAM, TEXT_ONLY_TURN, TOOL_CALL_FOLLOW_UP,
    TOOL_CALL_TURN, sse_stream,
)

AUTH = {"Authorization": "Bearer test-token"}


def _prompt_text(body) -> str:
    """Every word of the context message in one captured provider request.

    The prompt goes out as two text parts — a half that only grows, closing a
    cache breakpoint, and a half this turn rewrites. Which side a given block
    lands on belongs to `prompt._sections`; what these tests assert is that the
    model was shown it.

    Not the turn being answered. That is a message of its own — see
    `context.split_live_turn` — and `_live_text` is what reads it.
    """
    return "".join(part["text"] for part in body["input"][1]["content"]
                   if part["type"] == "input_text")


def _live_text(body) -> str:
    """The learner turn the captured request was asking the model to answer."""
    return "".join(part["text"] for part in body["input"][-1]["content"])


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


def test_turn_request_accepts_a_board_scene():
    request = TurnRequest(
        turn_id=uuid.uuid4(),
        session_id=uuid.uuid4(),
        text="look at my triangle",
        model="gpt-5.6-luna",
        reasoning_effort="high",
        board_scene='{"elements":[{"id":"tri","kind":"polygon"}]}',
    )
    assert request.board_scene is not None


def test_turn_request_rejects_an_over_limit_board_scene():
    with pytest.raises(Exception):
        TurnRequest(
            turn_id=uuid.uuid4(),
            session_id=uuid.uuid4(),
            text="look",
            model="gpt-5.6-luna",
            reasoning_effort="high",
            board_scene="x" * (MAX_SCENE_CHARS + 1),
        )


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
async def test_board_scene_reaches_the_provider_prompt(db_app):
    route = respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    scene = '{"elements":[{"id":"tri","kind":"polygon"}]}'
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream(
            "POST", "/v1/turn",
            json=_payload(board_scene=scene),
            headers=AUTH,
        ) as r:
            await _collect(r)

    body = json.loads(route.calls[0].request.content)
    prompt_text = _prompt_text(body)
    assert scene in prompt_text


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

    # The device is told one app-authored sentence and nothing about the
    # failure itself — see `TURN_FAILED_MESSAGE`.
    assert events[-1]["message"] == TURN_FAILED_MESSAGE

    # A turn that dies mid-stream must not stay "running" forever — that
    # would permanently poison the turn_id, since the idempotency check only
    # tests for the row's existence.
    #
    # str(APIConnectionError(...)) alone is just the generic "Connection
    # error." — the row we persist must carry the exception type and the
    # underlying httpx failure that actually explains what went wrong, not just
    # that generic string. This is where that detail lives now, and the only
    # place it does.
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
    assert events[-1]["message"] == TURN_FAILED_MESSAGE

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn.status == "error"
        assert "OSError" in turn.error["message"]


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
async def test_a_rate_limit_inside_the_stream_is_recorded_retryable(
    db_app, db_factory
):
    """The failure that started all of this, and the one shape no handler could
    see. The round's POST answered 200 and the refusal arrived a minute later as
    an SSE `error` event, so the SDK raises a bare `openai.APIError`: no status
    code, and not an `APIStatusError`. It fell to the generic handler and was
    written down as final — while the provider's own words in it said "Please
    try again in 662ms"."""
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*RATE_LIMITED_MID_STREAM))
    )
    payload = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is True

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn.status == "error"
        assert turn.error["retryable"] is True
        # The row says which rule made that call, so a wrong one is arguable
        # from the table rather than only from the code.
        assert turn.error["diagnostics"]["classified"] == "rate limited"


@respx.mock
async def test_the_providers_own_words_never_reach_the_device(db_app, db_factory):
    """A provider writes its errors for whoever holds the account. This one
    named the model, the organization id and the account's per-minute ceiling,
    and every character of it was put on a child's iPad. It belongs in the row
    and in the log, and nowhere else."""
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*RATE_LIMITED_MID_STREAM))
    )
    payload = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    wire = json.dumps(events)
    assert "org-EXAMPLE0000" not in wire
    assert "tokens per min" not in wire
    assert "gpt-5.6-luna" not in wire
    assert events[-1]["message"] == TURN_FAILED_MESSAGE

    # And it is genuinely kept, not merely dropped: a turn nobody can diagnose
    # is the other half of this failure.
    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert RATE_LIMIT_MESSAGE in turn.error["message"]


@respx.mock
async def test_a_fetched_picture_reaches_the_model_small_and_the_blob_whole(
    db_app, db_factory, monkeypatch
):
    """The two halves of one download, and they are deliberately different
    pictures. The device loads the blob and draws it, so the blob keeps what
    arrived. The model looks at the picture once and is then re-billed for it on
    every later round of the turn, so what goes into the conversation is a small
    copy — which is the single largest lever on the token ceiling this turn
    family kept hitting."""
    import base64
    import io

    from PIL import Image

    from app.store.models import Attachment
    from app.tutor import fetch_image as fetch_image_module
    from app.tutor.fetch_image import (
        MODEL_IMAGE_JPEG_TYPE, MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_PNG_TYPE,
    )

    async def _public(host: str, port: int) -> list[str]:
        return ["93.184.216.34"]

    monkeypatch.setattr(fetch_image_module, "_resolve", _public)

    original = io.BytesIO()
    Image.new("RGB", (1080, 1080), "white").save(original, format="PNG")
    original = original.getvalue()

    respx.get("https://example.com/parabola.png").mock(return_value=Response(
        200, headers={"Content-Type": "image/png"}, content=original,
    ))
    route = respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*FETCH_IMAGE_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*FETCH_IMAGE_FOLLOW_UP)),
        ]
    )
    payload = _payload(text="find me a parabola")
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            await _collect(r)

    # What the model was shown, dug out of the round that answered the call.
    second = json.loads(route.calls[1].request.content)
    parts = [part for item in second["input"]
             if isinstance(item.get("content"), list)
             for part in item["content"] if part["type"] == "input_image"]
    assert len(parts) == 1
    url = parts[0]["image_url"]
    # Whichever of the two encodings came out smaller — flat white is a PNG's
    # best case, so this one is a PNG. What the test pins is the media type
    # matching the bytes, and the size, which is where the tokens are.
    media_type = url.removeprefix("data:").split(";", 1)[0]
    assert media_type in {MODEL_IMAGE_JPEG_TYPE, MODEL_IMAGE_PNG_TYPE}
    shown = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert shown.size == (MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_MAX_EDGE)
    assert shown.get_format_mimetype() == media_type
    # Still `high`. What comes back is a diagram with labels on it, and the
    # low-detail path downsamples until none of them can be read.
    assert parts[0]["detail"] == "high"

    # And the blob is the download, untouched — it is what the iPad will GET
    # when the model places this picture by id.
    async with db_factory() as db:
        row = (await db.execute(
            select(Attachment).where(Attachment.kind == "fetched_image")
        )).scalar_one()
        assert row.bytes == len(original)
        assert row.content_type == "image/png"


@respx.mock
async def test_a_picture_too_large_to_decode_is_named_but_never_described(
    db_app, db_factory, monkeypatch
):
    """The gap between the two ceilings, end to end. `_measured` admits
    anything under 32 Mpx and `model_copy` refuses to decode past 8, so every
    fetched picture in between is saved, blob-stored, named to the model — and
    never seen by it. A 4000x3000 PNG is an ordinary thing to find on the web.

    Without the note the tool result is indistinguishable from a successful one:
    a blob id, a width, a height, no error, and no picture. A model in that
    position places the image and describes it from the URL, which is exactly
    what `UNAVAILABLE_ACK` exists to stop `view_board` doing."""
    import io

    from PIL import Image

    from app.tutor import fetch_image as fetch_image_module
    from app.tutor.fetch_image import MODEL_IMAGE_MAX_PIXELS
    from app.tutor.providers import PICTURE_NOT_SHOWN_NOTE

    async def _public(host: str, port: int) -> list[str]:
        return ["93.184.216.34"]

    monkeypatch.setattr(fetch_image_module, "_resolve", _public)

    assert 4_000 * 3_000 > MODEL_IMAGE_MAX_PIXELS
    original = io.BytesIO()
    Image.new("RGB", (4_000, 3_000), "white").save(original, format="PNG")
    original = original.getvalue()

    respx.get("https://example.com/parabola.png").mock(return_value=Response(
        200, headers={"Content-Type": "image/png"}, content=original,
    ))
    route = respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*FETCH_IMAGE_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*FETCH_IMAGE_FOLLOW_UP)),
        ]
    )
    payload = _payload(text="find me a parabola")
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            await _collect(r)

    second = json.loads(route.calls[1].request.content)
    answered = [item for item in second["input"]
                if item.get("type") == "function_call_output"]
    result = json.loads(answered[0]["output"])

    # The blob id still goes out: the picture is fine, the device can draw it,
    # and placing it then looking at the board is a complete recovery.
    assert result["blob_id"].startswith("sha256:")
    assert (result["width"], result["height"]) == (4_000, 3_000)
    assert result["note"] == PICTURE_NOT_SHOWN_NOTE

    assert not [
        part for item in second["input"] if isinstance(item.get("content"), list)
        for part in item["content"] if part["type"] == "input_image"
    ], "nothing was decoded, so no picture may be sent"


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
    prompt_text = _prompt_text(second_turn_body)
    assert "learner: first" in prompt_text
    assert "tutor: Nice work." in prompt_text
    # The turn being answered is not history and is not in that block. It is
    # the request, and it goes as its own message — see `split_live_turn`.
    assert "learner: second" not in prompt_text
    assert _live_text(second_turn_body) == "second"


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
    prompt_text = _prompt_text(second_turn_body)
    assert "EXERCISE CONTEXT" in prompt_text
    assert "SESSION PLAN" in prompt_text


@respx.mock
async def test_an_unallowed_model_is_rejected_before_any_provider_call(db_app):
    """I7: the model is unvalidated device input straight to the provider —
    MODEL_ALLOWLIST + a 422 is the ceiling on *which* models can be named at
    all; the spend cap prices what they run (config refuses to boot if an
    allowlisted model has no price row). The route is mocked but never
    expected to be hit — if validation regressed and the code called the
    provider anyway, respx (not a live request) would be what answered."""
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

    # `**_` for the same reason as `_hanging_run_turn` below: without it, every
    # keyword the endpoint learns to pass makes the call raise TypeError before
    # the body runs, and the turn reaches "error" through the generic path
    # instead of the CancelledError path this test is about.
    async def _cancelled_run_turn(*, provider, model, effort, bundle, fetch_board,
                                  handle_memory, **_):
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


async def test_a_cancel_scope_disconnect_still_leaves_the_turn_not_running(
    db_app, db_factory, monkeypatch
):
    """The disconnect the test above *doesn't* reproduce, and the one that
    actually happened.

    Raising `CancelledError` inside the generator is a plain exception: the
    task's cancel state is never set, no cancel scope is cancelled, and every
    `await` in the closing `finally` therefore runs to completion. A real
    disconnect is the other thing — Starlette cancels the anyio scope the
    generator runs in, and a cancelled scope re-delivers cancellation at every
    subsequent `await`, so the `finally` was killed on its first one and the
    turn stayed "running" forever. Four of them are sitting in the production
    database, put there while the test above was green.

    So this cancels from the outside, through a real scope, which is the only
    version of the failure that exercises the shield."""

    # `**_` rather than the argument list `run_turn` happens to take today: this
    # fake stands in for the whole signature, and every keyword the endpoint
    # learns to pass would otherwise fail it as a TypeError that reads like a
    # cancellation bug. `request_body` did exactly that.
    async def _hanging_run_turn(*, provider, model, effort, bundle, fetch_board,
                                handle_memory, **_):
        result = TurnResult()
        yield StatusEvent(phase="thinking"), result
        # Parked, so the cancellation below lands mid-turn rather than racing a
        # generator that has already finished and closed the turn out cleanly.
        await anyio.sleep_forever()

    monkeypatch.setattr("app.api.turn.run_turn", _hanging_run_turn)

    payload = _payload()
    body = json.dumps(payload).encode()
    streaming = anyio.Event()
    request_sent = False

    # Driven as raw ASGI rather than through `AsyncClient`, because httpx's
    # `ASGITransport` cannot express this at all: it accumulates the whole
    # response body and only constructs a `Response` once the app has returned,
    # so by the time `client.stream(...)` hands anything back the turn is over
    # and there is nothing left to disconnect from. This is what uvicorn does —
    # and sending a real `http.disconnect` means Starlette cancels its own task
    # group exactly the way it does in production, rather than the test
    # cancelling something from outside and hoping the shape matches.
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/v1/turn",
        "raw_path": b"/v1/turn",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"test"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"authorization", b"Bearer test-token"),
        ],
        "client": ("127.0.0.1", 51234),
        "server": ("test", 80),
    }

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        # Starlette's `listen_for_disconnect` is what calls this next. Hold the
        # disconnect until the turn is genuinely mid-stream: dropping it any
        # earlier and the endpoint has not committed the turn row yet, which is
        # a different failure that this test would otherwise pass by accident.
        await streaming.wait()
        return {"type": "http.disconnect"}

    async def send(message) -> None:
        if message["type"] == "http.response.body" and message.get("body"):
            streaming.set()

    with anyio.fail_after(30):
        await db_app(scope, receive, send)

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn is not None
        assert turn.status == "error"
        assert turn.error is not None
        assert turn.error["retryable"] is True

        # The row has to say *how* it died, not just that it did. `max_silence_ms`
        # is what separates a client timeout from someone closing the app, and
        # its absence is why the original four stranded turns could not be told
        # apart from each other by anyone reading the table.
        diagnostics = turn.error["diagnostics"]
        assert diagnostics["max_silence_ms"] >= 0
        assert diagnostics["events_sent"] >= 1
        assert diagnostics["elapsed_ms"] >= 0
        assert "provider_events" in diagnostics


def test_turn_request_accepts_attachment_ids():
    request = TurnRequest(
        turn_id=uuid.uuid4(),
        session_id=uuid.uuid4(),
        text="here's my homework",
        model="gpt-5.6-luna",
        reasoning_effort="high",
        attachment_ids=[uuid.uuid4()],
    )
    assert len(request.attachment_ids) == 1


def test_turn_request_defaults_attachment_ids_to_empty():
    """Every existing caller and fixture predates this field."""
    request = TurnRequest(
        turn_id=uuid.uuid4(), session_id=uuid.uuid4(), text="hi",
        model="gpt-5.6-luna", reasoning_effort="high",
    )
    assert request.attachment_ids == []


def test_turn_request_rejects_more_attachments_than_the_cap():
    from pydantic import ValidationError

    from app.config import MAX_ATTACHMENTS_PER_TURN

    with pytest.raises(ValidationError):
        TurnRequest(
            turn_id=uuid.uuid4(), session_id=uuid.uuid4(), text="hi",
            model="gpt-5.6-luna", reasoning_effort="high",
            attachment_ids=[uuid.uuid4() for _ in range(MAX_ATTACHMENTS_PER_TURN + 1)],
        )


@requires_db
async def test_a_turn_naming_a_foreign_attachment_is_refused(db_app, db_factory, tmp_path):
    """An attachment id is a capability. This names a *real* upload that
    belongs to a different session — not merely a random uuid, which would
    pass this test even if `load_uploads`'s session filter were missing
    entirely. The learner must never be able to reach another session's
    files by naming a uuid they happen to hold."""
    from app.attachments.convert import Converted
    from app.attachments.kinds import Kind
    from app.store.blobs import LocalBlobStore
    from app.store.recorder import Recorder

    mine = Session(model="gpt-5.6-luna", reasoning_effort="high")
    theirs = Session(model="gpt-5.6-luna", reasoning_effort="high")
    async with db_factory() as db:
        db.add_all([mine, theirs])
        await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    converted = Converted(
        kind=Kind.IMAGE, data=b"jpeg-bytes", text=None,
        content_type="image/jpeg", page_count=1, thumbnail=b"thumb",
    )
    foreign_upload_id = await recorder.record_upload(
        session_id=theirs.id, filename="private.png",
        converted=converted, original=b"original-png-bytes",
    )

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v1/turn",
            headers=AUTH,
            json=_payload(session_id=str(mine.id), attachment_ids=[str(foreign_upload_id)]),
        )

    assert response.status_code == 400


@requires_db
async def test_a_turn_naming_an_unknown_attachment_is_refused(db_app):
    """The same refusal for the simpler case: an id that names no row at
    all, not just one that belongs to someone else."""
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/v1/turn",
            headers=AUTH,
            json=_payload(attachment_ids=[str(uuid.uuid4())]),
        )

    assert response.status_code == 400


@respx.mock
async def test_a_turn_naming_a_valid_attachment_includes_it_in_the_prompt(
    db_app, db_factory, tmp_path
):
    """The happy path: an upload that really is on this session becomes a
    content part the model sees, appended after the board images (pinned by
    a dedicated test on `assemble_context` itself — this only proves the
    turn handler wires the loaded upload through to the provider call)."""
    from app.attachments.convert import Converted
    from app.attachments.kinds import Kind
    from app.store.recorder import Recorder

    route = respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )

    session_id = uuid.uuid4()
    async with db_factory() as db:
        db.add(Session(id=session_id, model="gpt-5.6-luna", reasoning_effort="high"))
        await db.commit()

    from app.api.turn import get_recorder
    recorder = db_app.dependency_overrides[get_recorder]()
    assert isinstance(recorder, Recorder)
    converted = Converted(
        kind=Kind.TEXT, data=None, text="2 + 2 = ?", content_type="text/plain",
        page_count=1, thumbnail=b"thumb",
    )
    upload_id = await recorder.record_upload(
        session_id=session_id, filename="homework.txt",
        converted=converted, original=b"2 + 2 = ?",
    )

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream(
            "POST", "/v1/turn",
            json=_payload(session_id=str(session_id), attachment_ids=[str(upload_id)]),
            headers=AUTH,
        ) as r:
            assert r.status_code == 200
            await _collect(r)

    body = json.loads(route.calls[0].request.content)
    content = body["input"][1]["content"]
    texts = [part["text"] for part in content if part.get("type") == "input_text"]
    assert any("homework.txt" in text and "2 + 2 = ?" in text for text in texts)


# ---- a refused open, and whose verdict is recorded -------------------------
#
# Everything below is one failure and the two layers that used to lose it: the
# `google.genai` transport retrying underneath the round loop's own retry, and
# `stream`'s `except` ladder writing `retryable=False` over a verdict the
# provider had already got right.


def _gemini_refusal(status: int, message: str, retry_after: str | None = None):
    """A real `google.genai` refusal, raised by the SDK's own constructor.

    `APIError.raise_for_response` is the classmethod the SDK itself calls on a
    response it did not like, so what comes back is exactly the class production
    raises — `ServerError` for a 5xx, `ClientError` for a 4xx — carrying `code`,
    `details` and `message` under the names `GeminiProvider.open_failure` reads
    them by. A `Mock` would prove only that a mock satisfies the `isinstance`
    check the real exception has to satisfy for itself, which is the one thing
    that decides whether the provider claims the error at all.

    `retry_after` is read off the response by `gemini._open_retry_delay`, and the
    tests set it small for exactly one reason: `_open_round` really does sleep
    between its attempts, and a test asserting that it made all of them should
    not spend two seconds proving it.
    """
    from google.genai import errors as genai_errors

    headers = {"Retry-After": retry_after} if retry_after is not None else {}
    response = httpx.Response(
        status,
        headers=headers,
        json={"error": {
            "code": status, "message": message,
            "status": "UNAVAILABLE" if status >= 500 else "RESOURCE_EXHAUSTED",
        }},
        request=httpx.Request(
            "POST", "https://generativelanguage.googleapis.com/v1beta/interactions"
        ),
    )
    try:
        genai_errors.APIError.raise_for_response(response)
    except genai_errors.APIError as error:
        return error
    raise AssertionError(f"the SDK does not treat {status} as an error")


def _gemini_turn_that_refuses(monkeypatch, error) -> list:
    """Point the turn at a real `GeminiProvider` whose open always raises.

    The provider is the production class, holding a real (never-called) SDK
    client, with only `open_round` replaced — so `open_failure` and `classify`
    are the shipped ones, which is the whole point: the verdict under test is
    the provider's own. Patching `_provider` rather than setting a key also keeps
    the test hermetic, and it means `_open_verdict` is answered by the same
    instance that refused, exactly as in production.

    Returns the list every open appends to, so a caller can say how many
    attempts `loop._open_round` really made.
    """
    from google import genai

    from app.tutor.providers.gemini import GeminiProvider

    provider = GeminiProvider(client=genai.Client(api_key="test-key"))
    opens: list = []

    async def _refuse(payload):
        opens.append(payload)
        raise error

    monkeypatch.setattr(provider, "open_round", _refuse)
    monkeypatch.setattr("app.api.turn._provider", lambda model: provider)
    return opens


def test_the_gemini_client_leaves_the_transport_no_attempt_to_retry(monkeypatch):
    """Read back off the built client, because the call site is not the contract.

    Two retry loops stacked is the failure this closes: `loop._open_round`
    classifies a refusal and retries it a bounded number of times, and a
    transport retry underneath it can hide a whole backoff inside each of those
    attempts. The learner then waits the product of the two instead of one
    bounded wait, and `GeminiProvider.classify` — the only layer that can tell a
    burst limit from a spent quota — does not get to speak until all of it is
    over.

    The second half of this test pins the figures `turn._gemini_client`'s
    docstring quotes, straight out of the installed SDK. The docstring it
    replaced quoted four attempts, 500 ms doubling to 8 s and a 30-second
    ceiling; none of those were `google-genai` 2.18.1's, and prose that has
    silently gone stale is what sent someone looking for a ceiling that does not
    exist. An SDK upgrade that moves these numbers now fails here.
    """
    from google.genai import _api_client as sdk
    from google.genai.types import HttpRetryOptions

    from app.api.turn import _gemini_client
    from app.config import get_settings

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    get_settings.cache_clear()
    _gemini_client.cache_clear()
    try:
        api = _gemini_client()._api_client

        # `attempts=0` is how this SDK spells "do not retry", and `retry_args`
        # normalises it to 1 in place — so the built client reports 1 here, and
        # the assertion that means anything is the stop strategy below.
        assert api._http_options.retry_options is not None
        assert api._http_options.retry_options.attempts in (0, 1)
        assert api._async_retry.stop.max_attempt_number == 1
        assert api._retry.stop.max_attempt_number == 1

        # Passing `http_options` must not cost the SDK's other defaults. It
        # merges rather than replaces, and a client that had quietly lost its
        # base URL would fail a long way from here.
        assert api._http_options.base_url == "https://generativelanguage.googleapis.com/"
        assert api._http_options.api_version == "v1beta"
    finally:
        _gemini_client.cache_clear()
        get_settings.cache_clear()

    # What re-enabling it would cost, which is the paragraph the docstring owes
    # anyone reading it: supply `retry_options` and leave `attempts` unset and
    # these are the defaults that apply.
    assert sdk.retry_args(HttpRetryOptions())["stop"].max_attempt_number == 5
    assert sdk._RETRY_INITIAL_DELAY == 1.0
    assert sdk._RETRY_EXP_BASE == 2
    assert sdk._RETRY_MAX_DELAY == 60.0
    assert sdk._RETRY_HTTP_STATUS_CODES == (408, 429, 500, 502, 503, 504)


def test_the_gemini_client_bounds_a_silent_read(monkeypatch):
    """Unset is unbounded on this SDK, which is the trap this closes.

    `HttpOptions.timeout` defaults to `None`, `get_timeout_in_seconds` turns that
    into `None`, and httpx reads `timeout=None` as *no deadline* rather than a
    long one — so a Gemini round whose stream went quiet forever was awaited
    forever, with the turn row never finished. Read back off the built client
    and off the SDK's own converter, because the number is in milliseconds and
    the plain `90` a reader of the openai SDK would write is 90 ms.

    Asserted as a bound *below* the device's own idle timeout rather than as a
    literal. `BackendTutorService.streamTimeout` is 120 s; above it this number
    could never help, because the learner's app has already abandoned the
    stream.
    """
    from google.genai._api_client import get_timeout_in_seconds

    from app.api.turn import GEMINI_TIMEOUT_MS, _gemini_client
    from app.config import get_settings

    DEVICE_STREAM_TIMEOUT_SECONDS = 120.0

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    get_settings.cache_clear()
    _gemini_client.cache_clear()
    try:
        options = _gemini_client()._api_client._http_options
        assert options.timeout == GEMINI_TIMEOUT_MS
        seconds = get_timeout_in_seconds(options.timeout)
        assert 0 < seconds < DEVICE_STREAM_TIMEOUT_SECONDS, (
            "a read bound at or past the device's own idle timeout is a bound "
            "that can never be reached in time to tell the learner anything"
        )
        # Enough margin to record the failure and put an `error` event on the
        # wire before the device gives up on the stream.
        assert DEVICE_STREAM_TIMEOUT_SECONDS - seconds >= 15.0
    finally:
        _gemini_client.cache_clear()
        get_settings.cache_clear()


def test_the_except_ladder_keeps_its_order_and_recovers_only_at_the_end():
    """The ladder's order is load-bearing, so it is asserted rather than assumed.

    `APIStatusError` and `APIConnectionError` are subclasses of `APIError`, and
    Python takes the first clause that matches — so moving the base ahead of its
    subclasses throws away a status code and a `Retry-After` that are already
    read properly, silently and on every failure. The broad clause is wider
    still: it catches everything, including the exceptions of a family whose
    class this module must not name, so anywhere but last it would swallow all
    three.

    The behavioural half of this gate is the test below and the three that
    already exist (`..._billing_429_is_reported_as_not_retryable`,
    `..._dropped_connection_fails_the_turn_visibly`,
    `..._rate_limit_inside_the_stream_is_recorded_retryable`). What only a
    structural assertion can catch is a reordering that leaves all four clauses
    present and every one of those tests still passing for the wrong reason.
    """
    import ast
    import inspect

    from app.api import turn as turn_module

    tree = ast.parse(inspect.getsource(turn_module))
    stream = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "stream"
    )
    guarded = [
        node for node in ast.walk(stream)
        if isinstance(node, ast.Try) and node.finalbody
    ]
    assert len(guarded) == 1, "stream() should have exactly one guarded body"
    handlers = guarded[0].handlers

    assert [ast.unparse(handler.type) for handler in handlers] == [
        "APIStatusError", "APIConnectionError", "APIError", "Exception",
    ]

    # And the recovery lives only in the last clause. The three above it read
    # their own family's exception directly and must keep doing so — routing
    # them through the provider would lose the status code and the `Retry-After`
    # that only an `APIStatusError` carries.
    bodies = [ast.unparse(ast.Module(body=handler.body, type_ignores=[]))
              for handler in handlers]
    assert "_open_verdict" in bodies[-1]
    assert not any("_open_verdict" in body for body in bodies[:-1])


@respx.mock
async def test_the_openai_clauses_still_match_ahead_of_the_broad_one(
    db_app, db_factory
):
    """The regression gate, and it discriminates rather than merely passing.

    `OpenAIProvider.open_failure` claims `APIStatusError` and nothing wider —
    deliberately, so an `APIConnectionError` keeps travelling to this handler
    instead of being retried. That is what makes these two cases a real test of
    the ladder's order: if the broad clause were reached first it would ask the
    provider, be told `None`, and record both of them `retryable=False`. Clause
    two answers `True` because a transport failure is transient by definition,
    and clause three answers `True` because it reads the message a bare
    `APIError` carries. A reordering flips both to `False`.
    """
    # Clause two: a transport failure, retryable by definition and with no
    # `classified` reason, because no rule was consulted to decide it.
    respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=httpx.ConnectError("connection reset by peer")
    )
    dropped = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=dropped, headers=AUTH) as r:
            events = await _collect(r)
    assert events[-1]["retryable"] is True
    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(dropped["turn_id"]))
        assert "APIConnectionError" in turn.error["message"]
        assert "classified" not in turn.error["diagnostics"]

    # Clause three: the refusal that arrives inside an open stream as a bare
    # `APIError`, whose own words said to try again in 662 ms.
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*RATE_LIMITED_MID_STREAM))
    )
    in_stream = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=in_stream, headers=AUTH) as r:
            events = await _collect(r)
    assert events[-1]["retryable"] is True
    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(in_stream["turn_id"]))
        assert turn.error["diagnostics"]["classified"] == "rate limited"

    # Clause one: a status code and a body, read where they have always been
    # read. A billing 429 is the same status as a burst limit and the opposite
    # verdict.
    respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(
            429, json={"error": {"code": "insufficient_quota", "message": "no credits"}}
        )
    )
    billed = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=billed, headers=AUTH) as r:
            events = await _collect(r)
    assert events[-1]["retryable"] is False
    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(billed["turn_id"]))
        assert turn.error["diagnostics"]["classified"]


@respx.mock
async def test_a_gemini_refusal_is_recorded_with_the_providers_own_verdict(
    db_app, db_factory, monkeypatch
):
    """The verdict already existed; the ladder was writing over it.

    A `google.genai` exception matches none of the three `openai`-typed clauses,
    so it fell to the broad one and was recorded `retryable=False` — while
    `GeminiProvider.classify` had already read this 503 as a server error worth
    another go, and `loop._open_round` had already retried it that many times
    before giving the exception back. The learner was told a transient outage was
    final.

    `respx.mock` with no routes registered is the second assertion here: no HTTP
    request may be made at all. The refusal is raised by the provider's own
    `open_round`, which is where a refused open raises in production too.
    """
    from app.tutor.retry import RETRY_LIMIT

    error = _gemini_refusal(
        503, "The model is overloaded. Please try again later.", retry_after="0.01"
    )
    opens = _gemini_turn_that_refuses(monkeypatch, error)

    payload = _payload(model="gemini-3.7-flash", reasoning_effort="high")
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    # Retried first, and only reported once the loop ran out of attempts. A
    # verdict of `True` reported after one attempt would mean the loop had
    # stopped retrying.
    assert len(opens) == RETRY_LIMIT + 1

    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is True

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn.status == "error"
        assert turn.error["retryable"] is True
        # The row says which rule made the call, so a wrong verdict is arguable
        # from the table rather than only from the code.
        assert turn.error["diagnostics"]["classified"] == "server error 503"
        # And it is genuinely diagnosable: the provider's words are kept here.
        assert "ServerError" in turn.error["message"]
        assert "overloaded" in turn.error["message"]

    # A provider writes its errors for whoever holds the account, and this path
    # is no different from the others: one app-authored sentence reaches the
    # device and nothing else.
    wire = json.dumps(events)
    assert "overloaded" not in wire
    assert "503" not in wire
    assert "gemini-3.7-flash" not in wire
    assert events[-1]["message"] == TURN_FAILED_MESSAGE


@respx.mock
async def test_a_gemini_burst_limit_is_offered_again_rather_than_recorded_final(
    db_app, db_factory, monkeypatch
):
    """The reported failure, in the shape it was reported in.

    Gemini gives the same error code — `RESOURCE_EXHAUSTED` — to a one-second
    burst and to a spent day's quota, so `GeminiProvider.classify` reads the
    message to tell them apart. It read this one correctly as a burst limit all
    along; the verdict just never reached the row or the device.
    """
    error = _gemini_refusal(
        429, "Resource has been exhausted (e.g. check quota).", retry_after="0.01"
    )
    _gemini_turn_that_refuses(monkeypatch, error)

    payload = _payload(model="gemini-3.7-flash", reasoning_effort="high")
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    assert events[-1]["retryable"] is True
    assert events[-1]["message"] == TURN_FAILED_MESSAGE

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn.error["diagnostics"]["classified"] == "rate limited"


@respx.mock
async def test_a_bug_in_our_own_code_is_still_reported_final(
    db_app, db_factory, monkeypatch
):
    """The other half of asking the provider: it is allowed to say "not mine".

    `open_failure` returning `None` is the whole safety property of catching
    broadly — an exception no family claims is a bug in this service, and
    telling a learner to retry into a bug is worse than telling them plainly
    that the turn failed. `classified` stays off the row for the same reason: no
    rule was consulted, so there is none to name.
    """
    _gemini_turn_that_refuses(
        monkeypatch, TypeError("board_scene() got an unexpected keyword argument")
    )

    payload = _payload(model="gemini-3.7-flash", reasoning_effort="high")
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream("POST", "/v1/turn", json=payload, headers=AUTH) as r:
            events = await _collect(r)

    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is False
    assert events[-1]["message"] == TURN_FAILED_MESSAGE

    async with db_factory() as db:
        turn = await db.get(Turn, uuid.UUID(payload["turn_id"]))
        assert turn.status == "error"
        assert turn.error["retryable"] is False
        assert "classified" not in turn.error["diagnostics"]
        assert "TypeError" in turn.error["message"]
