"""`POST /v1/realtime/calls` — the SDP proxy, with the upstream faked.

No database anywhere in here: the route is stateless by design, and these
tests must stay runnable without TEST_DATABASE_URL (`ASGITransport` runs no
lifespan, so `create_app()` never touches an engine).
"""

import uuid

import respx
from httpx import ASGITransport, AsyncClient, Response

from app.api.realtime import (
    TURN_DETECTION_HEADER, build_realtime_session, redact_api_key,
)
from app.main import create_app
from app.tutor.prompt import SYSTEM_PROMPT

AUTH = {"Authorization": "Bearer test-token"}
SDP_HEADERS = {**AUTH, "Content-Type": "application/sdp"}

OFFER = "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
ANSWER = "v=0\r\no=- 987654321 2 IN IP4 203.0.113.7\r\ns=-\r\nt=0 0\r\n"

UPSTREAM = "https://api.openai.com/v1/realtime/calls"


def _app_client() -> AsyncClient:
    return AsyncClient(
        transport=ASGITransport(app=create_app()), base_url="http://test"
    )


def test_the_session_config_matches_the_spec():
    session = build_realtime_session()

    assert session["type"] == "realtime"
    # The full model, never a mini variant as the default — founder decision.
    assert session["model"] == "gpt-realtime-2.1"
    assert "mini" not in session["model"]
    assert session["output_modalities"] == ["audio"]
    assert session["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 24000}
    assert session["audio"]["output"]["format"] == {"type": "audio/pcm", "rate": 24000}
    assert session["audio"]["output"]["voice"] == "marin"

    turn_detection = session["audio"]["input"]["turn_detection"]
    assert turn_detection["type"] == "semantic_vad"
    assert turn_detection["create_response"] is True
    assert turn_detection["interrupt_response"] is True

    transcription = session["audio"]["input"]["transcription"]
    assert transcription["model"] == "gpt-live-transcribe"
    assert transcription["language"] == "en"
    # The maths-vocabulary steering rides in the prompt — spot-check a term.
    assert "hypotenuse" in transcription["prompt"]

    assert [tool["name"] for tool in session["tools"]] == ["send_to_tutor"]
    assert session["tool_choice"] == "auto"
    # The voice prompt is the tutor prompt with the delegation section on top.
    assert session["instructions"].startswith(SYSTEM_PROMPT)
    assert "send_to_tutor" in session["instructions"]

    fallback = build_realtime_session("server_vad")
    assert fallback["audio"]["input"]["turn_detection"]["type"] == "server_vad"


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


def test_redaction_catches_exact_and_shaped_keys():
    text = "key sk-test failed; echo sk-abcd***********wxyz; sk_not_a_key stays"
    redacted = redact_api_key(text, "sk-test")
    assert "sk-test" not in redacted
    assert "sk-abcd" not in redacted
    assert "sk_not_a_key" in redacted
