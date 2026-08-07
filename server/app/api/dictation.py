from __future__ import annotations

import asyncio
import uuid
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from openai import APIConnectionError, APIStatusError, AsyncOpenAI
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.turn import get_recorder
from app.auth import require_device_token
from app.config import get_settings
from app.sse import SSE_HEADERS, format_sse
from app.store.db import db_session
from app.store.models import Session
from app.store.recorder import Recorder
from app.tutor.events import ErrorEvent
from app.tutor.retry import classify
from app.tutor.vocabulary import DICTATION_PROMPT, KEYWORDS, LANGUAGES, is_silence, sanitize

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device_token)])

# `07-dictation.md §1.4`: not a cheaper model — `gpt-transcribe` is the only
# one in the file-transcription set that accepts `keywords`, and maths
# vocabulary steering is the difference between a usable feature and an
# unusable one.
MODEL = "gpt-transcribe"
FILENAME = "speech.wav"
CONTENT_TYPE = "audio/wav"

# `OpenAITranscriptionClient.retryLimit` / `.fallbackRetryDelay`, ported
# server-side now that this client proxies the request instead of the app.
RETRY_LIMIT = 2
FALLBACK_RETRY_DELAY = 1.0
# A provider asking for longer than the student will wait is a failure, not
# a pause — `OpenAITranscriptionClient.retryDelay(from:)`.
MAX_RETRY_DELAY = 10.0


class DictationTextDeltaEvent(BaseModel):
    """One `transcript.text.delta`, forwarded as received. The client
    accumulates — this event carries the increment, not the running total,
    matching how `TextDeltaEvent` already works for `/v1/turn`."""

    type: Literal["text_delta"] = "text_delta"
    text: str


class DictationDoneEvent(BaseModel):
    """`transcript.text.done`'s text, authoritative over the summed deltas,
    and emptied when `is_silence` judges it boilerplate."""

    type: Literal["done"] = "done"
    text: str


def _describe_error(error: Exception) -> str:
    """A diagnosable message that never quotes the provider's own text.

    Unlike `/v1/turn`'s `_describe_error`, this deliberately discards the
    provider's free-text `message` even when one is available — it is a
    child's voice, transcribed, and that text can quote what was heard. Only
    the exception type and, for a status error, the numeric status and
    machine-readable error code (never the human-readable message) are kept.
    """
    if isinstance(error, APIStatusError):
        code = _error_code(error.body)
        detail = f" code={code}" if code else ""
        return f"{type(error).__name__}: status {error.status_code}{detail}"
    return type(error).__name__


def _error_code(body: object) -> str | None:
    if not isinstance(body, dict):
        return None
    error = body.get("error", body)
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None


def _retry_delay(response: httpx.Response) -> float:
    header = response.headers.get("Retry-After")
    if header is None:
        return FALLBACK_RETRY_DELAY
    try:
        seconds = float(header.strip())
    except ValueError:
        return FALLBACK_RETRY_DELAY
    if seconds <= 0:
        return FALLBACK_RETRY_DELAY
    return min(seconds, MAX_RETRY_DELAY)


async def _open_stream(client: AsyncOpenAI, audio: bytes):
    """Connect to the streaming transcription endpoint, retrying silently on
    a retryable failure — 429 rate limits and 5xx, never a billing 429 — and
    honouring `Retry-After`. Reuses `classify` from `app.tutor.retry` rather
    than a second copy of that decision.

    Retries happen here and only here, before any SSE bytes have reached the
    client: once a delta has been forwarded, restarting the transcript would
    rewrite words the student is already reading (mirrors
    `OpenAITranscriptionClient.run`, which retries only around
    `attemptTranscription`'s connection step). A stream that opens but ends
    without `transcript.text.done` is a separate failure, handled by the
    caller, and is never retried even on the first attempt.
    """
    for attempt in range(RETRY_LIMIT + 1):
        try:
            return await client.audio.transcriptions.create(
                model=MODEL,
                file=(FILENAME, audio, CONTENT_TYPE),
                prompt=sanitize(DICTATION_PROMPT),
                keywords=[sanitize(keyword) for keyword in KEYWORDS],
                languages=LANGUAGES,
                stream=True,
            )
        except APIStatusError as error:
            decision = classify(error.status_code, error.body)
            if not decision.retry or attempt == RETRY_LIMIT:
                raise
            await asyncio.sleep(_retry_delay(error.response))
    raise AssertionError("unreachable: loop above always returns or raises")


@router.post("/dictation")
async def create_dictation(
    audio: UploadFile = File(...),
    session_id: uuid.UUID = Form(...),
    db: AsyncSession = Depends(db_session),
    recorder: Recorder = Depends(get_recorder),
):
    settings = get_settings()

    # A dictation has no turn — the recorder needs *something* to attach the
    # audio to, and a session that does not exist yet cannot receive it.
    # Every session today is created lazily by /v1/turn, so this is the same
    # invariant that endpoint already relies on, not a new one.
    if await db.get(Session, session_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown session.")

    audio_bytes = await audio.read()

    async def stream():
        # Nothing was said, or the client sent nothing. Not a failure and
        # not worth a provider round trip — mirrors the old client-side
        # `guard !audio.isEmpty else { continuation.finish() }`.
        if not audio_bytes:
            yield format_sse(DictationDoneEvent(text=""))
            return

        if settings.persist_dictation_audio:
            try:
                await recorder.record_attachment(
                    session_id=session_id, kind="audio",
                    data=audio_bytes, content_type=CONTENT_TYPE,
                )
            except Exception as error:
                yield format_sse(ErrorEvent(
                    message=f"{type(error).__name__}: could not save the recording.",
                    retryable=False,
                ))
                return

        # max_retries=0: the SDK's own default retry logic (max_retries=2)
        # retries any 429 or 5xx, including a billing 429 — it has no way to
        # tell a billing error from a rate limit. Left at its default, the
        # transport would retry a spend-limit failure before classify() ever
        # saw it, silently defeating "never retry billing" at a layer this
        # code cannot see into. _open_stream is the only retry loop that may
        # run.
        client = AsyncOpenAI(api_key=settings.openai_api_key, max_retries=0)
        try:
            transcript_stream = await _open_stream(client, audio_bytes)
        except APIStatusError as error:
            decision = classify(error.status_code, error.body)
            yield format_sse(ErrorEvent(message=_describe_error(error), retryable=decision.retry))
            return
        except APIConnectionError as error:
            # Covers APITimeoutError too — it subclasses APIConnectionError.
            # A transient network failure, not a verdict from the provider,
            # so it is retryable by definition — same convention as /v1/turn.
            yield format_sse(ErrorEvent(message=_describe_error(error), retryable=True))
            return
        except Exception as error:
            yield format_sse(ErrorEvent(message=_describe_error(error), retryable=False))
            return

        text = ""
        saw_done = False
        async with transcript_stream:
            async for event in transcript_stream:
                if event.type == "transcript.text.delta":
                    if event.delta:
                        yield format_sse(DictationTextDeltaEvent(text=event.delta))
                elif event.type == "transcript.text.done":
                    # Authoritative, not merely terminal: it carries the
                    # whole transcript, punctuated and cased, where the sum
                    # of the deltas need not be.
                    text = event.text
                    saw_done = True
                    break

        if not saw_done:
            # A truncated stream is a failure, not a short transcript: half
            # a sentence a student might not notice is worse than none.
            yield format_sse(ErrorEvent(
                message="TruncatedStream: the transcription ended before it finished.",
                retryable=False,
            ))
            return

        final_text = "" if is_silence(text) else text
        yield format_sse(DictationDoneEvent(text=final_text))

    return StreamingResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)
