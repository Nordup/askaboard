"""The SDP proxy for live voice.

The device speaks WebRTC directly to OpenAI; this route is the one HTTP
exchange in between, so the API key never leaves the server. The device POSTs
its SDP offer here, the server attaches the session configuration plus the
permanent key, and OpenAI's SDP answer is handed straight back. A port of the
sleep app's `apps/server/src/routes/realtime-session.ts` to FastAPI/httpx
(`docs/research/voice-mode/sleep-app-voice-stack.md` §2-3).

Stateless on purpose: no database, no session row. Rendezvous stays
in-process elsewhere, so this route can live in the same worker as the turn
stream without caring which worker that is.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from functools import lru_cache

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response

from app.auth import require_device_token
from app.config import get_settings
from app.tutor.vocabulary import DICTATION_PROMPT, KEYWORDS, sanitize
from app.tutor.voice_prompt import SEND_TO_TUTOR_TOOL, VOICE_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device_token)])

UPSTREAM_TIMEOUT_SECONDS = 20.0

#: The turn detection the call actually negotiated, returned with the SDP
#: answer. The fallback below can silently swap `semantic_vad` for
#: `server_vad` mid-flight; without this header the client would keep
#: believing in the mode the upstream just rejected.
TURN_DETECTION_HEADER = "X-Turn-Detection-Mode"

# An upstream rejection that names turn detection. Only these get the one
# fallback retry — a rejected model or a bad key must fail loudly instead of
# being tried twice.
_TURN_DETECTION_REJECTION = re.compile(
    r"semantic_vad|turn_detection|eagerness", re.IGNORECASE
)

# Anything key-shaped, including the partially-masked form OpenAI echoes back
# on a 401 ("Incorrect API key provided: sk-abcd***********wxyz"). That echo
# still exposes the key's prefix and suffix, and it would otherwise reach both
# the log and the device.
_API_KEY_SHAPED = re.compile(r"\bsk-[A-Za-z0-9_*-]{4,}")

# Semantic VAD with both response controls on: the server segments the audio
# AND drives the replies. The opposite of the sleep app's bedtime profile,
# deliberately — a tutor wants fast turn-taking, and barge-in
# (`interrupt_response`) is a feature here, not the defect it was in a dark
# bedroom.
_SEMANTIC_TURN_DETECTION = {
    "type": "semantic_vad",
    "create_response": True,
    "interrupt_response": True,
}

# The energy-VAD fallback for a model that rejects `semantic_vad`. The numbers
# are the codex profile from the sleep research (§4) — 500 ms of silence is
# conversation-speed, which is what a tutoring register wants — with both
# response controls kept true so a fallback call behaves like a normal one.
_SERVER_VAD_FALLBACK = {
    "type": "server_vad",
    "threshold": 0.5,
    "prefix_padding_ms": 300,
    "silence_duration_ms": 500,
    "create_response": True,
    "interrupt_response": True,
}

# The same maths-vocabulary steering `/v1/dictation` sends, in the one field
# the realtime transcription config accepts. `gpt-live-transcribe` has no
# `keywords` parameter, so the terms ride inside the prompt instead.
# `sanitize` at import time: a forbidden character in a future edit should
# fail the boot, not the first call of the evening.
TRANSCRIPTION_PROMPT = sanitize(
    f"{DICTATION_PROMPT} Vocabulary that may come up: {', '.join(KEYWORDS)}."
)


def build_realtime_session(mode: str = "semantic_vad") -> dict:
    """The whole session configuration, server-owned.

    Built here rather than on the device so there is not a second copy of
    these values to drift — and so the device never re-encodes an
    OpenAI-bound number (sleep lesson 7). PCM 24 kHz both directions;
    transcription pinned to English with the maths vocabulary, because
    semantic VAD reads the words to decide when a turn ended and a
    hallucinated language breaks turn-taking, not just the transcript.
    """
    settings = get_settings()
    return {
        "type": "realtime",
        "model": settings.openai_realtime_model,
        "instructions": VOICE_SYSTEM_PROMPT,
        "output_modalities": ["audio"],
        "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "turn_detection": (
                    dict(_SERVER_VAD_FALLBACK) if mode == "server_vad"
                    else dict(_SEMANTIC_TURN_DETECTION)
                ),
                "transcription": {
                    "model": "gpt-live-transcribe",
                    "language": "en",
                    "prompt": TRANSCRIPTION_PROMPT,
                },
            },
            "output": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "voice": settings.openai_realtime_voice,
            },
        },
        "tools": [SEND_TO_TUTOR_TOOL],
        "tool_choice": "auto",
    }


def redact_api_key(text: str, api_key: str) -> str:
    """The exact key and anything key-shaped, gone before logging or return."""
    if api_key:
        text = text.replace(api_key, "[redacted]")
    return _API_KEY_SHAPED.sub("[redacted]", text)


def _read_upstream_error(response: httpx.Response, api_key: str) -> str:
    """The upstream's own explanation, redacted, for the log and the 502.

    Prefers the structured `error.message`; falls back to the first 500
    characters of whatever the body was. Either way the key — exact or
    sk-shaped — never survives.
    """
    body = response.text
    try:
        parsed = json.loads(body)
        message = parsed.get("error", {}).get("message") if isinstance(parsed, dict) else None
        if isinstance(message, str):
            return redact_api_key(message, api_key)
    except (ValueError, AttributeError):
        pass
    return redact_api_key(body[:500], api_key)


@lru_cache
def _client() -> httpx.AsyncClient:
    """The one upstream client, built on first use and then kept.

    Cached for the reason `/v1/turn` and `/v1/dictation` cache theirs: a
    client per request is a fresh connection pool, which is a DNS lookup and
    a TLS handshake in front of every call start — the moment the learner is
    sitting in silence waiting for the voice to pick up.
    """
    return httpx.AsyncClient(timeout=httpx.Timeout(UPSTREAM_TIMEOUT_SECONDS))


@router.post("/realtime/calls")
async def create_realtime_call(
    request: Request,
    session_id: uuid.UUID | None = None,
) -> Response:
    """Forward an SDP offer to OpenAI and return the SDP answer.

    `session_id` is the learning session the call belongs to — optional but
    expected, carried for the log line only: the route itself is stateless
    and the voice model learns about the session through `send_to_tutor`
    turns, not through this parameter.
    """
    settings = get_settings()

    content_type = request.headers.get("content-type", "")
    if "application/sdp" not in content_type and "text/plain" not in content_type:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Content-Type must be application/sdp.",
        )

    offer = (await request.body()).decode("utf-8", errors="replace")
    if not offer.lstrip().startswith("v="):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Body must be an SDP offer.",
        )

    if not settings.openai_api_key:
        logger.error("realtime.calls rejected | OPENAI_API_KEY is not configured")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server is not configured for Realtime calls.",
        )

    async def post(mode: str) -> httpx.Response:
        # FormData {sdp, session}, the shape the upstream endpoint takes. The
        # `(None, bytes)` tuples make httpx send multipart fields without
        # filenames — what a browser FormData of two strings produces.
        return await _client().post(
            f"{settings.openai_base_url}/realtime/calls",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            files={
                "sdp": (None, offer.encode("utf-8")),
                "session": (None, json.dumps(build_realtime_session(mode)).encode("utf-8")),
            },
        )

    could_not_reach = HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Could not reach the Realtime API.",
    )

    started = time.monotonic()
    mode = "semantic_vad"
    try:
        upstream = await post(mode)
    except httpx.HTTPError as error:
        # `str(error)` on a transport failure can quote the request, so even
        # this path goes through redaction before the log.
        logger.error(
            "realtime.calls upstream request failed | model=%s reason=%s",
            settings.openai_realtime_model,
            redact_api_key(f"{type(error).__name__}: {error}", settings.openai_api_key),
        )
        raise could_not_reach from error

    detail = "" if upstream.is_success else _read_upstream_error(upstream, settings.openai_api_key)

    # Semantic VAD is the right setting, and a model that does not support it
    # is a call that never starts. Rather than hand the device a 502, retry
    # once with the energy-VAD fallback — worse turn-taking beats no call.
    # Only a rejection that names turn detection qualifies; a bad key or a
    # rejected model fails loudly the first time.
    if not upstream.is_success and _TURN_DETECTION_REJECTION.search(detail):
        logger.error(
            "realtime.calls semantic_vad rejected | model=%s status=%s detail=%s — retrying with server_vad",
            settings.openai_realtime_model, upstream.status_code, detail,
        )
        mode = "server_vad"
        try:
            upstream = await post(mode)
        except httpx.HTTPError as error:
            logger.error(
                "realtime.calls upstream request failed | model=%s reason=%s",
                settings.openai_realtime_model,
                redact_api_key(f"{type(error).__name__}: {error}", settings.openai_api_key),
            )
            raise could_not_reach from error
        detail = "" if upstream.is_success else _read_upstream_error(upstream, settings.openai_api_key)

    duration_ms = int((time.monotonic() - started) * 1000)

    if not upstream.is_success:
        logger.error(
            "realtime.calls upstream error | model=%s turn_detection=%s status=%s duration_ms=%s detail=%s",
            settings.openai_realtime_model, mode, upstream.status_code, duration_ms, detail,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Realtime API rejected the session (status {upstream.status_code}): {detail}",
        )

    answer = upstream.text
    logger.info(
        "realtime.calls ok | session_id=%s model=%s voice=%s turn_detection=%s duration_ms=%s answer_bytes=%s",
        session_id, settings.openai_realtime_model, settings.openai_realtime_voice,
        mode, duration_ms, len(answer),
    )

    # The mode rides back with the answer on every call, not just after a
    # fallback, so the device always knows what this call actually negotiated.
    return Response(
        content=answer,
        media_type="application/sdp",
        headers={TURN_DETECTION_HEADER: mode},
    )
