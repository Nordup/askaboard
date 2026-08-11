from __future__ import annotations

import asyncio
import uuid
from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import StreamingResponse
from openai import APIConnectionError, APIError, APIStatusError, AsyncOpenAI
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.turn import get_recorder
from app.auth import require_device_token
from app.config import DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, get_settings
from app.sse import SSE_HEADERS, format_sse
from app.store.db import db_session
from app.store.models import Session
from app.store.recorder import Recorder
from app.tutor.events import ErrorEvent
from app.tutor.retry import RETRY_LIMIT, classify, retry_delay
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

    `APIError` (not just its `APIStatusError` subclass) is handled too: a
    mid-stream error frame — an embedded `{"error": ...}` inside an
    otherwise-200 SSE response — raises the bare base class, which has no
    `status_code`, but does carry the same machine-readable `.code`.
    """
    if isinstance(error, APIStatusError):
        code = _error_code(error.body)
        detail = f" code={code}" if code else ""
        return f"{type(error).__name__}: status {error.status_code}{detail}"
    if isinstance(error, APIError) and error.code:
        return f"{type(error).__name__}: code={error.code}"
    return type(error).__name__


def _error_code(body: object) -> str | None:
    if not isinstance(body, dict):
        return None
    error = body.get("error", body)
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None


@lru_cache
def _client() -> AsyncOpenAI:
    """The one provider client, built on first use and then kept.

    Cached for the reason every module in `app/memory` caches its own: a client
    built per request is a fresh `httpx.AsyncClient`, which is a fresh
    connection pool, which is a DNS lookup and a TLS handshake in front of the
    first token of every dictation. The pools are never closed either, so they
    accumulate until they are collected. The offline memory passes had this
    right and the two request paths did not.

    `max_retries=0`: the SDK's own retry (default 2) retries any 429 or 5xx,
    including a billing 429, because it cannot tell one from the other. Left on,
    the transport would sit through backoff on an exhausted account before
    `classify` ever saw the error. `_open_stream` is the only retry that may run.
    """
    return AsyncOpenAI(api_key=get_settings().openai_api_key, max_retries=0)


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
            await asyncio.sleep(retry_delay(error.response))
    raise AssertionError("unreachable: loop above always returns or raises")


@router.post("/dictation")
async def create_dictation(
    audio: UploadFile = File(...),
    session_id: uuid.UUID = Form(...),
    db: AsyncSession = Depends(db_session),
    recorder: Recorder = Depends(get_recorder),
):
    settings = get_settings()

    # A dictation has no turn, but the recorder still needs a session to attach
    # the audio to — so create one, exactly the way /v1/turn does.
    #
    # This used to 404 instead, on the stated reasoning that "every session is
    # created lazily by /v1/turn". That had the dependency backwards: /v1/turn
    # *creates* the session, it does not require one, so dictation was the only
    # endpoint that demanded a row someone else had already written. On a fresh
    # install nobody has, and tapping the mic before typing anything — the first
    # thing a student who would rather talk than type does — 404'd every time.
    #
    # The form carries no model or effort, hence the defaults; the next turn
    # overwrites both with what the device actually has selected.
    if await db.get(Session, session_id) is None:
        db.add(Session(
            id=session_id,
            model=DEFAULT_MODEL,
            reasoning_effort=DEFAULT_REASONING_EFFORT,
        ))
        try:
            await db.commit()
        except IntegrityError:
            # Two dictations racing on the same brand-new session id: the
            # db.get() above and this insert are not atomic, so both can pass
            # it. Whichever loses adopts the row the other just wrote — the
            # same resolution /v1/turn applies to a duplicate turn_id.
            await db.rollback()

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

        client = _client()

        # One guard around the connection AND the whole consumption loop —
        # not just the open. openai/_streaming.py's AsyncStream.__stream__
        # raises APIError directly when an SSE frame carries an embedded
        # `{"error": ...}`, i.e. after the connection has already opened
        # successfully; a guard around only _open_stream() lets that
        # exception fall straight through StreamingResponse uncaught. This
        # is the same shape /v1/turn's create_turn uses for the same reason:
        # nothing between accepting the request and finishing it may escape
        # unhandled. `async with` closes the upstream connection whether the
        # loop ends by exception, by `break`, or by exhaustion.
        text = ""
        saw_done = False
        try:
            transcript_stream = await _open_stream(client, audio_bytes)
            async with transcript_stream:
                async for event in transcript_stream:
                    if event.type == "transcript.text.delta":
                        if event.delta:
                            text += event.delta
                            yield format_sse(DictationTextDeltaEvent(text=event.delta))
                    elif event.type == "transcript.text.done":
                        # Authoritative, not merely terminal — but only when
                        # it actually carries something. An empty `.done`
                        # text must not overwrite the deltas already shown
                        # to the student; Swift's own reader has the same
                        # `!final.isEmpty` guard.
                        if event.text:
                            text = event.text
                        saw_done = True
                        break
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
            # Covers the mid-stream APIError above and anything
            # unanticipated. Never retried: once a delta may already have
            # reached the client, restarting the transcript would rewrite
            # words the student is already reading — the same rule that
            # keeps a truncated stream (below) from being retried.
            yield format_sse(ErrorEvent(message=_describe_error(error), retryable=False))
            return

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
