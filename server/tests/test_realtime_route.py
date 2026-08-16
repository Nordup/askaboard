"""`POST /v1/realtime/calls` — the SDP proxy, with the upstream faked.

No database anywhere in here: `ASGITransport` runs no lifespan, so
`create_app()` never touches an engine, and these tests must stay runnable
without TEST_DATABASE_URL. The route reads memory when a call names a session,
so the tests that cover that stub the memory sources the way
`test_turn_memory` does and hand the route a recorder whose session is never
used — the database stays absent, the assembly is real.
"""

import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import respx
from httpx import ASGITransport, AsyncClient, Response

from app.api.realtime import (
    TURN_DETECTION_HEADER, build_realtime_session, redact_api_key,
)
from app.api.turn import get_recorder
from app.main import create_app
from app.tutor.prompt import SYSTEM_PROMPT

AUTH = {"Authorization": "Bearer test-token"}
SDP_HEADERS = {**AUTH, "Content-Type": "application/sdp"}

OFFER = "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
ANSWER = "v=0\r\no=- 987654321 2 IN IP4 203.0.113.7\r\ns=-\r\nt=0 0\r\n"

UPSTREAM = "https://api.openai.com/v1/realtime/calls"


def _client_for(app) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _app_client() -> AsyncClient:
    return _client_for(create_app())


def test_the_session_config_matches_the_spec():
    session = build_realtime_session()

    assert session["type"] == "realtime"
    # The mini since 2026-08-16, reversing the founder decision voice mode
    # shipped on. Only reached when a call names no model of its own.
    assert session["model"] == "gpt-realtime-2.1-mini"
    assert session["output_modalities"] == ["audio"]
    assert session["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 24000}
    assert session["audio"]["output"]["format"] == {"type": "audio/pcm", "rate": 24000}
    # `cedar` since 2026-08-16 — the sleep app's own default, carried over.
    assert session["audio"]["output"]["voice"] == "cedar"

    turn_detection = session["audio"]["input"]["turn_detection"]
    assert turn_detection["type"] == "semantic_vad"
    assert turn_detection["create_response"] is True
    assert turn_detection["interrupt_response"] is True

    transcription = session["audio"]["input"]["transcription"]
    assert transcription["model"] == "gpt-live-transcribe"
    assert transcription["language"] == "en"
    # The maths-vocabulary steering rides in the prompt — spot-check a term.
    assert "hypotenuse" in transcription["prompt"]

    assert [tool["name"] for tool in session["tools"]] == ["send_to_tutor", "step_back"]
    assert session["tool_choice"] == "auto"
    # The voice prompt is the tutor prompt with the delegation section on top.
    assert session["instructions"].startswith(SYSTEM_PROMPT)
    assert "send_to_tutor" in session["instructions"]

    fallback = build_realtime_session("server_vad")
    assert fallback["audio"]["input"]["turn_detection"]["type"] == "server_vad"


def test_the_session_config_takes_the_model_it_is_given():
    """The one value in this config the device chooses.

    Everything else stays server-owned — a device that could name the voice,
    the VAD or the tools would be a second copy of the spec to drift. Asserted
    with the full model precisely because it is no longer the default: this
    must pass because the argument was honoured, not because it matched.
    """
    full = build_realtime_session(model="gpt-realtime-2.1")
    assert full["model"] == "gpt-realtime-2.1"
    assert full["audio"]["output"]["voice"] == "cedar"
    assert [tool["name"] for tool in full["tools"]] == ["send_to_tutor", "step_back"]


@respx.mock
async def test_proxies_the_offer_and_returns_the_answer_sdp():
    route = respx.post(UPSTREAM).mock(
        return_value=Response(
            200, content=ANSWER, headers={"Content-Type": "application/sdp"}
        )
    )
    async with _app_client() as client:
        response = await client.post(
            f"/v1/realtime/calls?session_id={uuid.uuid4()}",
            content=OFFER, headers=SDP_HEADERS,
        )

    assert response.status_code == 200
    assert response.text == ANSWER
    assert response.headers["content-type"].startswith("application/sdp")
    assert response.headers[TURN_DETECTION_HEADER] == "semantic_vad"

    request = route.calls[0].request
    assert request.headers["authorization"] == "Bearer sk-test"
    body = request.read()
    # Multipart FormData {sdp, session}: the offer verbatim in one field, the
    # session config — with the tool and the negotiated mode — in the other.
    assert b'name="sdp"' in body
    assert OFFER.encode() in body
    assert b'name="session"' in body
    assert b"semantic_vad" in body
    assert b"send_to_tutor" in body
    assert b"gpt-realtime-2.1" in body


@respx.mock
async def test_a_named_model_reaches_the_upstream_session_config():
    route = respx.post(UPSTREAM).mock(
        return_value=Response(
            200, content=ANSWER, headers={"Content-Type": "application/sdp"}
        )
    )
    async with _app_client() as client:
        response = await client.post(
            "/v1/realtime/calls?model=gpt-realtime-2.1",
            content=OFFER, headers=SDP_HEADERS,
        )

    assert response.status_code == 200
    # The full model, which is not the default — so this passes only if the
    # query parameter was read.
    assert b'"model": "gpt-realtime-2.1"' in route.calls[0].request.read()


async def test_a_model_off_the_allowlist_never_reaches_the_upstream():
    """Refused before the offer is even read, and with no upstream mocked.

    `respx` is deliberately absent: if the check were missing, the route would
    try a real network call and the test would fail loudly rather than pass on
    a fake. The device may pick from a priced menu, never invent an entry.
    """
    async with _app_client() as client:
        response = await client.post(
            "/v1/realtime/calls?model=gpt-realtime-2.1-turbo",
            content=OFFER, headers=SDP_HEADERS,
        )
    assert response.status_code == 422
    assert "gpt-realtime-2.1-mini" in response.json()["detail"]


@respx.mock
async def test_a_call_that_names_no_model_opens_on_the_configured_one():
    route = respx.post(UPSTREAM).mock(
        return_value=Response(
            200, content=ANSWER, headers={"Content-Type": "application/sdp"}
        )
    )
    async with _app_client() as client:
        await client.post("/v1/realtime/calls", content=OFFER, headers=SDP_HEADERS)

    body = route.calls[0].request.read()
    assert b'"model": "gpt-realtime-2.1-mini"' in body


@respx.mock
async def test_retries_once_with_server_vad_when_semantic_vad_is_rejected():
    route = respx.post(UPSTREAM).mock(side_effect=[
        Response(400, json={"error": {"message":
            "Unsupported value: 'semantic_vad' is not supported with this model."}}),
        Response(200, content=ANSWER, headers={"Content-Type": "application/sdp"}),
    ])
    async with _app_client() as client:
        response = await client.post(
            "/v1/realtime/calls", content=OFFER, headers=SDP_HEADERS,
        )

    assert response.status_code == 200
    assert response.text == ANSWER
    # The header names what the call actually negotiated, not what was asked.
    assert response.headers[TURN_DETECTION_HEADER] == "server_vad"
    assert route.call_count == 2
    assert b"server_vad" in route.calls[1].request.read()


@respx.mock
async def test_upstream_errors_come_back_with_the_key_redacted():
    route = respx.post(UPSTREAM).mock(
        return_value=Response(401, json={"error": {"message":
            "Incorrect API key provided: sk-test. "
            "You provided: sk-abcd***********wxyz."}})
    )
    async with _app_client() as client:
        response = await client.post(
            "/v1/realtime/calls", content=OFFER, headers=SDP_HEADERS,
        )

    assert response.status_code == 502
    # Neither the exact key nor the masked echo survives into the body.
    assert "sk-" not in response.text
    assert "[redacted]" in response.text
    # A bad key is not a turn-detection rejection: no second attempt.
    assert route.call_count == 1


async def test_missing_device_token_is_rejected():
    async with _app_client() as client:
        response = await client.post(
            "/v1/realtime/calls", content=OFFER,
            headers={"Content-Type": "application/sdp"},
        )
    assert response.status_code == 401


async def test_a_body_that_is_not_sdp_is_rejected():
    async with _app_client() as client:
        response = await client.post(
            "/v1/realtime/calls", content="hello there", headers=SDP_HEADERS,
        )
    assert response.status_code == 400


async def test_a_json_content_type_is_rejected():
    async with _app_client() as client:
        response = await client.post(
            "/v1/realtime/calls", content=OFFER,
            headers={**AUTH, "Content-Type": "application/json"},
        )
    assert response.status_code == 415


# ---------------------------------------------------------------------------
# The standing memory blocks in the call's instructions. `VOICE_SYSTEM_PROMPT`
# contains the tutor prompt, which promises the model those blocks are already
# in front of it; these are what make the promise true for a call.
# ---------------------------------------------------------------------------


class _FakeRecorder:
    """Only the seam `/v1/realtime/calls` touches.

    `sessions()` yields nothing, because every memory source below is stubbed
    and none of them reads the session. That is the point: the assembly under
    test is real, the database is absent.
    """

    @property
    def sessions(self):
        @asynccontextmanager
        async def _session():
            yield None
        return _session


class _BrokenRecorder:
    """A recorder whose database will not answer."""

    @property
    def sessions(self):
        def _session():
            raise RuntimeError("no connection")
        return _session


class _FakeEpisode:
    """The two fields `episode_card` needs off a summarized window."""

    def __init__(self, closed_at, digest):
        self.closed_at = closed_at
        self.digest = digest
        self.title = None
        self.narrative = None
        self.next_steps = None


class _FakeNote:
    def __init__(self, text, valid_from):
        self.text = text
        self.valid_from = valid_from


def _stub_memory(monkeypatch, *, episodes=(), notes=(), profile=None):
    """The same stubbing `test_turn_memory` uses, on the same five sources —
    so a call and a turn are shown to read one builder, not two."""
    async def _profile(db, learner_id):
        return profile

    async def _snapshot(db, learner_id):
        return ""

    async def _episodes(db, learner_id, *, limit):
        return list(episodes)

    async def _tail(db, learner_id, *, exclude_session=None):
        return None

    async def _notes(db, learner_id):
        return list(notes)

    monkeypatch.setattr("app.api.turn.current_profile", _profile)
    monkeypatch.setattr("app.api.turn.snapshot", _snapshot)
    monkeypatch.setattr("app.api.turn.recent_episodes", _episodes)
    monkeypatch.setattr("app.api.turn.backstop_tail", _tail)
    monkeypatch.setattr("app.api.turn.explicit_notes", _notes)


def _app_with(recorder):
    """An app whose `get_recorder` is this fake — the override the route reads
    by hand, keyed by the same function object the fixtures use."""
    app = create_app()
    app.dependency_overrides[get_recorder] = lambda: recorder
    return app


def _upstream_body(route) -> str:
    """The multipart body as text; the session JSON, instructions and all,
    is one of its two fields."""
    return route.calls[0].request.read().decode("utf-8", errors="replace")


@respx.mock
async def test_a_call_carries_this_learners_standing_memory_blocks(monkeypatch):
    """What the prompt has always claimed was there.

    `SYSTEM_PROMPT` tells the model to answer "what did we do last time?"
    straight out of the RECENT SESSIONS block, with no tool call. A call built
    from the prompt alone had the instruction and not the block.
    """
    _stub_memory(
        monkeypatch,
        episodes=[_FakeEpisode(datetime(2026, 8, 10, tzinfo=timezone.utc),
                               "similar triangles")],
        notes=[_FakeNote("Exam is on the 3rd of September.",
                         datetime(2026, 8, 1, tzinfo=timezone.utc))],
    )
    route = respx.post(UPSTREAM).mock(
        return_value=Response(
            200, content=ANSWER, headers={"Content-Type": "application/sdp"}
        )
    )
    async with _client_for(_app_with(_FakeRecorder())) as client:
        response = await client.post(
            f"/v1/realtime/calls?session_id={uuid.uuid4()}",
            content=OFFER, headers=SDP_HEADERS,
        )

    assert response.status_code == 200
    body = _upstream_body(route)
    # The rendered heading, counted — not the phrase, which `SYSTEM_PROMPT`
    # uses when it tells the model the block is there.
    assert "THE 1 MOST RECENT SESSIONS, most recent first" in body
    assert "similar triangles" in body
    assert "SAVED NOTES" in body
    assert "Exam is on the 3rd of September." in body
    # The date anchor rides with them: the cards are ISO dates, and "last
    # week" is unanswerable without knowing what today is.
    assert "Today is " in body


@respx.mock
async def test_a_call_with_no_session_opens_on_the_prompt_alone(monkeypatch):
    """No session named, nothing to load — and still a working call."""
    _stub_memory(monkeypatch, episodes=[
        _FakeEpisode(datetime(2026, 8, 10, tzinfo=timezone.utc), "vectors"),
    ])
    route = respx.post(UPSTREAM).mock(
        return_value=Response(
            200, content=ANSWER, headers={"Content-Type": "application/sdp"}
        )
    )
    async with _client_for(_app_with(_FakeRecorder())) as client:
        response = await client.post(
            "/v1/realtime/calls", content=OFFER, headers=SDP_HEADERS,
        )

    assert response.status_code == 200
    body = _upstream_body(route)
    assert "MOST RECENT SESSIONS, most recent first" not in body
    assert "vectors" not in body
    assert "send_to_tutor" in body


@respx.mock
async def test_a_memory_read_that_fails_still_opens_the_call(monkeypatch):
    """The trade this fallback exists to make.

    A learner who taps the voice button gets a tutor with a shorter
    recollection, never silence, when the memory read cannot be done.
    """
    _stub_memory(monkeypatch)
    route = respx.post(UPSTREAM).mock(
        return_value=Response(
            200, content=ANSWER, headers={"Content-Type": "application/sdp"}
        )
    )
    async with _client_for(_app_with(_BrokenRecorder())) as client:
        response = await client.post(
            f"/v1/realtime/calls?session_id={uuid.uuid4()}",
            content=OFFER, headers=SDP_HEADERS,
        )

    assert response.status_code == 200
    assert response.text == ANSWER
    body = _upstream_body(route)
    assert "MOST RECENT SESSIONS, most recent first" not in body
    assert "send_to_tutor" in body


@respx.mock
async def test_a_call_without_a_recorder_at_all_still_opens():
    """No database configured under this app: `get_recorder` itself raises.

    Every other test in this file goes down this path — no override, no
    engine — so the assertion is really about all of them: the memory read is
    additive, and its absence changes nothing about whether a call starts.
    """
    route = respx.post(UPSTREAM).mock(
        return_value=Response(
            200, content=ANSWER, headers={"Content-Type": "application/sdp"}
        )
    )
    async with _app_client() as client:
        response = await client.post(
            f"/v1/realtime/calls?session_id={uuid.uuid4()}",
            content=OFFER, headers=SDP_HEADERS,
        )

    assert response.status_code == 200
    assert b"send_to_tutor" in route.calls[0].request.read()


def test_the_blocks_are_the_same_text_a_turn_carries():
    """One builder, so the two prompts cannot drift.

    `standing_memory_blocks` is what the call route appends;
    `compose_user_prompt` is what a worker turn sends. The block bodies must be
    byte-identical, or "answer from the RECENT SESSIONS block" means two
    different blocks depending on which way the learner is talking.
    """
    from app.tutor.prompt import compose_user_prompt, standing_memory_blocks

    sections = {
        "profile": "You like a worked example first.",
        "learner_state": None,
        "recent_sessions": "2026-08-10 (last week) — similar triangles",
        "saved_notes": "[2026-08-01] Exam is on the 3rd of September.",
        "today": datetime(2026, 8, 16, tzinfo=timezone.utc).date(),
        "first_turn": False,
    }
    blocks = standing_memory_blocks(**sections)
    turn = compose_user_prompt(
        conversation="", goal=None, exercise=None, plan=None,
        image_region=None, has_image=False, signal=None, **sections,
    )
    for block in blocks.split("\n\n"):
        assert block in turn


def test_redaction_catches_exact_and_shaped_keys():
    text = "key sk-test failed; echo sk-abcd***********wxyz; sk_not_a_key stays"
    redacted = redact_api_key(text, "sk-test")
    assert "sk-test" not in redacted
    assert "sk-abcd" not in redacted
    assert "sk_not_a_key" in redacted


def test_session_config_lists_both_tools():
    """The voice model's whole vocabulary: delegate, or step back. Order
    matters only for prompt stability (caching), so pin the exact list."""
    from app.api.realtime import build_realtime_session
    from app.tutor.voice_prompt import SEND_TO_TUTOR_TOOL, STEP_BACK_TOOL

    tools = build_realtime_session()["tools"]
    assert tools == [SEND_TO_TUTOR_TOOL, STEP_BACK_TOOL]
