import gc
import json
import uuid
import warnings

import pytest
import respx
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import func, select

from app.config import DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, get_settings
from app.store.models import Attachment, Session
from app.tutor.vocabulary import (
    BOILERPLATE_SILENCE, DICTATION_PROMPT, KEYWORDS, is_silence, sanitize,
)
from tests.fixtures.sse import sse_stream

AUTH = {"Authorization": "Bearer test-token"}
TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions"

# ---------------------------------------------------------------------------
# Step 1's vocabulary tests, unchanged.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["a<b", "a>b", "a\rb", "a\nb"])
def test_sanitize_rejects_characters_that_break_the_request(bad):
    with pytest.raises(ValueError):
        sanitize(bad)


def test_sanitize_passes_ordinary_maths_vocabulary():
    assert sanitize("square root") == "square root"


@pytest.mark.parametrize("text", ["Thank you.", " you", "thank you", "  "])
def test_boilerplate_transcripts_are_treated_as_silence(text):
    assert is_silence(text) is True


def test_a_real_transcript_is_not_silence():
    assert is_silence("solve x squared plus five") is False


# ---------------------------------------------------------------------------
# The endpoint. `db_app` (server/tests/conftest.py) wires both `db_session`
# and `get_recorder` to the test schema; dictation.py imports turn.py's
# get_recorder rather than defining its own, so this fixture covers it too
# without any conftest change.
# ---------------------------------------------------------------------------


def _dictation_events(*deltas: str, done_text: str | None) -> bytes:
    """The wire shape of a `stream=true` transcription: a delta per chunk,
    then `transcript.text.done` — or, when `done_text` is None, no `.done`
    event at all, modelling a truncated stream."""
    events = [{"type": "transcript.text.delta", "delta": delta} for delta in deltas]
    if done_text is not None:
        events.append({"type": "transcript.text.done", "text": done_text})
    return sse_stream(*events)


def _dictation_events_with_mid_stream_error(*deltas: str, error_message: str) -> bytes:
    """Some deltas, then an embedded `{"error": ...}` frame instead of
    `.done` — the shape openai/_streaming.py's AsyncStream.__stream__ raises
    `APIError` on directly, from inside the `async for` consumption, after
    the connection has already opened successfully."""
    events = [{"type": "transcript.text.delta", "delta": delta} for delta in deltas]
    events.append({"type": "error", "error": {"message": error_message, "code": "server_error"}})
    return sse_stream(*events)


async def _post_dictation(app, *, session_id, audio: bytes = b"RIFF....WAVEfmt ", headers=AUTH):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(
            "/v1/dictation",
            files={"audio": ("speech.wav", audio, "audio/wav")},
            data={"session_id": str(session_id)},
            headers=headers,
        )


async def _stream_dictation(app, *, session_id, audio: bytes = b"RIFF....WAVEfmt "):
    events = []
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        async with client.stream(
            "POST", "/v1/dictation",
            files={"audio": ("speech.wav", audio, "audio/wav")},
            data={"session_id": str(session_id)},
            headers=AUTH,
        ) as response:
            status_code = response.status_code
            headers_out = response.headers
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line.removeprefix("data: ")))
    return status_code, headers_out, events


async def _make_session(db_factory) -> uuid.UUID:
    session_id = uuid.uuid4()
    async with db_factory() as db:
        db.add(Session(id=session_id, model="gpt-5.6-luna", reasoning_effort="high"))
        await db.commit()
    return session_id


async def test_dictation_requires_the_device_token(db_app):
    response = await _post_dictation(db_app, session_id=uuid.uuid4(), headers={})
    assert response.status_code == 401


@respx.mock
async def test_an_unknown_session_is_created_rather_than_rejected(db_app, db_factory):
    """The bug this replaces: dictating before typing anything 404'd.

    A session is only created by a turn, so on a fresh install the very first
    mic tap had nothing to attach its audio to and failed — for a student who
    would rather talk than type, that is the first thing they do. The endpoint
    now creates the session the same way /v1/turn does.
    """
    respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events("two thirds", done_text="two thirds"),
        )
    )
    session_id = uuid.uuid4()

    status_code, _, events = await _stream_dictation(db_app, session_id=session_id)

    assert status_code == 200
    assert events[-1] == {"type": "done", "text": "two thirds"}
    async with db_factory() as db:
        session = await db.get(Session, session_id)
        assert session is not None, "the dictation must leave a session behind to attach to"
        # The form carries neither, so the row takes the client's own defaults
        # until a turn states what is actually selected.
        assert session.model == DEFAULT_MODEL
        assert session.reasoning_effort == DEFAULT_REASONING_EFFORT


async def test_a_second_dictation_adopts_the_session_the_first_one_created(db_app, db_factory):
    """No unique-violation, and no second session: the id is the client's, so
    both requests name the same row and the loser of the race adopts it."""
    session_id = uuid.uuid4()

    first = await _post_dictation(db_app, session_id=session_id, audio=b"")
    second = await _post_dictation(db_app, session_id=session_id, audio=b"")

    assert first.status_code == 200
    assert second.status_code == 200
    async with db_factory() as db:
        count = (await db.execute(
            select(func.count()).select_from(Session).where(Session.id == session_id)
        )).scalar_one()
        assert count == 1


@respx.mock
async def test_empty_audio_is_not_sent_to_the_provider(db_app, db_factory):
    route = respx.post(TRANSCRIBE_URL)
    session_id = await _make_session(db_factory)

    status_code, _, events = await _stream_dictation(db_app, session_id=session_id, audio=b"")

    assert status_code == 200
    assert events == [{"type": "done", "text": ""}]
    assert route.call_count == 0

    async with db_factory() as db:
        assert (await db.get(Session, session_id)) is not None
        rows = (await db.execute(select(Attachment))).scalars().all()
        assert rows == []


@respx.mock
async def test_deltas_are_forwarded_raw_and_done_is_authoritative(db_app, db_factory):
    """`transcript.text.done` overrides the summed deltas — here the deltas
    spell "sign" but `.done` corrects it to "sine", and the done event must
    carry the correction, not the sum."""
    respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events("sig", "n", done_text="sine"),
        )
    )
    session_id = await _make_session(db_factory)

    status_code, headers, events = await _stream_dictation(db_app, session_id=session_id)

    assert status_code == 200
    assert headers["x-accel-buffering"] == "no"
    assert events == [
        {"type": "text_delta", "text": "sig"},
        {"type": "text_delta", "text": "n"},
        {"type": "done", "text": "sine"},
    ]


@respx.mock
async def test_the_outgoing_request_carries_the_maths_vocabulary(db_app, db_factory):
    route = respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events("hi", done_text="hi"),
        )
    )
    session_id = await _make_session(db_factory)
    await _stream_dictation(db_app, session_id=session_id)

    sent = route.calls.last.request
    body = sent.content.decode("utf-8", errors="ignore")
    assert 'name="model"' in body and "gpt-transcribe" in body
    assert 'name="stream"' in body and "true" in body
    # Array parameters repeat the field — every keyword appears as its own
    # part, named "keywords[]" by the SDK's own multipart encoding.
    assert body.count('name="keywords[]"') == len(KEYWORDS)
    assert "sine" in body and "square root" in body
    assert 'name="languages[]"' in body and "\r\nen\r\n" in body
    assert DICTATION_PROMPT in body


@respx.mock
async def test_a_truncated_stream_is_a_failure_not_a_short_transcript(db_app, db_factory):
    respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events("solve for", " x", done_text=None),
        )
    )
    session_id = await _make_session(db_factory)

    status_code, _, events = await _stream_dictation(db_app, session_id=session_id)

    assert status_code == 200
    kinds = [e["type"] for e in events]
    assert "done" not in kinds
    assert kinds[-1] == "error"
    assert events[-1]["retryable"] is False


@respx.mock
async def test_an_empty_done_keeps_the_accumulated_deltas(db_app, db_factory):
    """`.done` is authoritative only when it carries something. Swift's own
    reader guards this with `!final.isEmpty`; an empty `.done.text` must not
    discard text the student already watched stream in."""
    respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events("solve for ", "x", done_text=""),
        )
    )
    session_id = await _make_session(db_factory)

    _, _, events = await _stream_dictation(db_app, session_id=session_id)

    assert [e["text"] for e in events if e["type"] == "text_delta"] == ["solve for ", "x"]
    assert events[-1] == {"type": "done", "text": "solve for x"}


@respx.mock
async def test_a_mid_stream_provider_error_yields_a_clean_error_event(db_app, db_factory):
    """openai/_streaming.py raises `APIError` from inside the consumption
    loop, not just from opening the connection — this must not crash the
    response, and the provider's own text (which can quote what the
    student said) must never reach the client."""
    secret_sounding_message = "the student's answer was seven point five"
    respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events_with_mid_stream_error(
                "partial", error_message=secret_sounding_message,
            ),
        )
    )
    session_id = await _make_session(db_factory)

    status_code, _, events = await _stream_dictation(db_app, session_id=session_id)

    assert status_code == 200
    # The delta that arrived before the failure still reached the client...
    assert events[0] == {"type": "text_delta", "text": "partial"}
    # ...but the stream ends with a clean error, not a dead connection or an
    # unhandled exception, and it is never retried (a delta may already have
    # reached the client).
    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is False
    assert "done" not in [e["type"] for e in events]
    assert secret_sounding_message not in json.dumps(events)


@respx.mock
async def test_a_mid_stream_error_closes_the_upstream_connection_cleanly(db_app, db_factory):
    """The generator must terminate cleanly on a mid-stream failure, closing
    the upstream response rather than leaking it — no unclosed-stream
    warning, and the underlying httpx response is actually closed."""
    route = respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events_with_mid_stream_error("hi", error_message="overloaded"),
        )
    )
    session_id = await _make_session(db_factory)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        _, _, events = await _stream_dictation(db_app, session_id=session_id)
        gc.collect()

    assert events[-1]["type"] == "error"
    assert route.calls.last.response.is_closed
    unclosed = [w for w in caught if "unclosed" in str(w.message).lower()]
    assert unclosed == []


@respx.mock
async def test_boilerplate_from_near_silent_audio_is_returned_as_empty(db_app, db_factory):
    boilerplate = "Thank you."
    respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events("Thank", " you.", done_text=boilerplate),
        )
    )
    session_id = await _make_session(db_factory)

    _, _, events = await _stream_dictation(db_app, session_id=session_id)

    # The deltas still flow live (the student sees words appear)...
    assert [e["text"] for e in events if e["type"] == "text_delta"] == ["Thank", " you."]
    # ...but the final, authoritative result is emptied rather than handed to
    # the composer as if the student said it.
    assert events[-1] == {"type": "done", "text": ""}


@respx.mock
async def test_a_billing_429_is_not_retried_and_never_quotes_the_provider(db_app, db_factory):
    secret_sounding_message = "we heard you say the quiet part out loud"
    route = respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            429, json={"error": {"code": "insufficient_quota", "message": secret_sounding_message}}
        )
    )
    session_id = await _make_session(db_factory)

    _, _, events = await _stream_dictation(db_app, session_id=session_id)

    assert route.call_count == 1  # never retried
    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is False
    assert secret_sounding_message not in json.dumps(events)


@respx.mock
async def test_a_rate_limited_429_is_retried_and_then_succeeds(db_app, db_factory, monkeypatch):
    monkeypatch.setattr("app.api.dictation.asyncio.sleep", _no_sleep)
    route = respx.post(TRANSCRIBE_URL)
    route.side_effect = [
        Response(429, json={"error": {"code": "rate_limit_exceeded"}}, headers={"Retry-After": "0.01"}),
        Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events("ok", done_text="ok"),
        ),
    ]
    session_id = await _make_session(db_factory)

    status_code, _, events = await _stream_dictation(db_app, session_id=session_id)

    assert status_code == 200
    assert route.call_count == 2
    assert events[-1] == {"type": "done", "text": "ok"}


@respx.mock
async def test_a_503_is_retried_up_to_the_limit_then_fails_retryably(db_app, db_factory, monkeypatch):
    monkeypatch.setattr("app.api.dictation.asyncio.sleep", _no_sleep)
    route = respx.post(TRANSCRIBE_URL).mock(return_value=Response(503, json={"error": {"message": "overloaded"}}))
    session_id = await _make_session(db_factory)

    _, _, events = await _stream_dictation(db_app, session_id=session_id)

    # RETRY_LIMIT=2 silent retries -> 3 attempts total, then the client
    # finally hears about it, and it is still worth trying again later.
    assert route.call_count == 3
    assert events[-1]["type"] == "error"
    assert events[-1]["retryable"] is True


@respx.mock
async def test_audio_is_persisted_against_the_session_when_enabled(db_app, db_factory):
    respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events("hi", done_text="hi"),
        )
    )
    session_id = await _make_session(db_factory)
    assert get_settings().persist_dictation_audio is True

    await _stream_dictation(db_app, session_id=session_id, audio=b"RIFF-fake-wav-bytes")

    async with db_factory() as db:
        rows = (await db.execute(select(Attachment))).scalars().all()
    assert len(rows) == 1
    assert rows[0].session_id == session_id
    assert rows[0].turn_id is None
    assert rows[0].kind == "audio"
    assert rows[0].content_type == "audio/wav"


@respx.mock
async def test_audio_is_not_persisted_when_disabled(db_app, db_factory, monkeypatch):
    disabled = get_settings().model_copy(update={"persist_dictation_audio": False})
    monkeypatch.setattr("app.api.dictation.get_settings", lambda: disabled)

    respx.post(TRANSCRIBE_URL).mock(
        return_value=Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=_dictation_events("hi", done_text="hi"),
        )
    )
    session_id = await _make_session(db_factory)

    await _stream_dictation(db_app, session_id=session_id)

    async with db_factory() as db:
        rows = (await db.execute(select(Attachment))).scalars().all()
    assert rows == []


async def _no_sleep(*_args, **_kwargs):
    return None
