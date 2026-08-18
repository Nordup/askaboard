from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache

import anyio
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from google import genai
import httpx
from openai import APIConnectionError, APIError, APIStatusError, AsyncOpenAI
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import Row, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.attachments.parts import UploadPart
from app.auth import require_device_token
from app.config import (
    EFFORTS_FOR_MODEL, MAX_ATTACHMENTS_PER_TURN, MODEL_ALLOWLIST,
    PROVIDER_FOR_MODEL, RECENT_SESSION_COUNT, SOLE_LEARNER_ID,
    get_settings,
)
from app.learner.mastery import snapshot
from app.memory.dispatch import memory_handler
from app.memory.profile import current_profile
from app.memory.retrieve import (
    backstop_tail, explicit_notes, recent_episodes, render_notes,
    render_sessions,
)
from app.sse import SSE_HEADERS, format_sse
from app.store.db import db_session, note_request_use, session_factory
from app.store.blobs import LocalBlobStore
from app.store.models import Attachment, Message, Session, Turn
from app.store.recorder import Recorder, cache_tokens
from app.tutor import ledger
from app.tutor.context import (
    assemble_session_context, open_session_preamble, split_live_turn,
)
from app.tutor.events import (
    TURN_FAILED_MESSAGE, DoneEvent, ErrorEvent, StatusEvent,
)
from app.tutor.board_scene import MAX_SCENE_CHARS
from app.tutor import rendezvous
from app.tutor.fetch_image import (
    ALLOWED_CONTENT_TYPES, ImageFetchError, fetch_image, model_copy,
)
from app.tutor.loop import (
    FetchedImage,
    TurnResult,
    run_turn,
)
from app.tutor.providers import (
    PICTURE_NOT_SHOWN_NOTE,
    ProducedFile,
    Provider,
    RelayedFile,
    relayed_content_type,
)
from app.tutor.providers.gemini import GeminiProvider
from app.tutor.providers.openai import ContainerFileTooLarge, OpenAIProvider
from app.tutor.rendezvous import BoardRegion
from app.tutor.retry import RetryDecision, classify
from app.tutor.web_search import search_web

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device_token)])

# `Attachment.kind` for the whole-board upload every turn carries.
#
# Deliberately **not** `board_png`, which is already taken by the region a
# learner marquees and sends. The two are different things — one is the board,
# the other is a thing they pointed at — and the turn-to-turn comparison that
# tells the model whether the board moved has to compare boards with boards. A
# shared kind would have a selection sent between two identical boards read as
# the board having changed twice. Fits `Attachment.kind`'s String(16).
BOARD_KIND = "board_full"

# `Attachment.kind` for a picture the tutor downloaded from the web.
#
# Its own kind rather than sharing one with the two above, because its
# provenance is different in the way that matters: these bytes came from an
# address a *model* chose, not from the learner's device. Anyone reading a
# turn's attachments — or deciding one day that fetched pictures expire and
# board captures do not — needs to be able to tell them apart, and the row is
# the only place that fact is written down. Fits `Attachment.kind`'s String(16).
FETCHED_IMAGE_KIND = "fetched_image"

# `Attachment.kind` for a file the hosted code interpreter's script wrote.
#
# Its own kind for the reason `FETCHED_IMAGE_KIND` is one: the provenance is
# different again. These bytes were computed, on the provider's machine, from
# whatever the script was given — so they are neither the learner's board nor
# something copied off a web page, and a row is the only place that is written
# down. It also matters for what a turn *costs*: this is the one attachment kind
# that exists because a model decided to run a program. Fits `Attachment.kind`'s
# String(16) with three characters to spare.
SCRIPT_OUTPUT_KIND = "script_output"

#: How long the close-out in `stream`'s `finally` may take before it is
#: abandoned.
#:
#: It runs shielded from cancellation, which is the only way it can run at all
#: on the disconnect path — and a shield with no deadline is how a wedged
#: database turns one dropped connection into a coroutine that never returns.
#: Two writes against a warm pool; ten seconds is slack, not a budget.
CLEANUP_TIMEOUT_SECONDS = 10.0


#: How long one OpenAI request may wait on a read, in **seconds**.
#:
#: The SDK's own default is 600 s (`DEFAULT_TIMEOUT.read`), which is minutes of
#: silence inside a learner's turn: `BackendTutorService.streamTimeout` abandons
#: the stream after 120 s while this server would still believe it is live.
#: Under httpx a read bound is per-read — the gap between two SSE events, not the
#: length of the round — so 90 s is generous for a model that thinks before it
#: writes, and always fires before the device gives up.
OPENAI_READ_TIMEOUT_SECONDS = 90.0


@lru_cache
def _client() -> AsyncOpenAI:
    """The one provider client, built on first use and then kept.

    Cached for the reason every module in `app/memory` caches its own: a client
    built per request is a fresh `httpx.AsyncClient`, which is a fresh
    connection pool, which is a DNS lookup and a TLS handshake in front of the
    first token of every turn. The pools are never closed either, so they
    accumulate until they are collected. The offline memory passes had this
    right and the two request paths did not.

    `max_retries=0`: the SDK's own retry (default 2) retries any 429 or 5xx,
    including a billing 429, because it cannot tell one from the other. Left on,
    the transport would sit through backoff on an exhausted account before
    `classify` ever saw the error. `loop._open_round` is the only retry that may run.
    """
    return AsyncOpenAI(
        api_key=get_settings().openai_api_key,
        max_retries=0,
        timeout=httpx.Timeout(
            connect=5.0,
            read=OPENAI_READ_TIMEOUT_SECONDS,
            write=600.0,
            pool=600.0,
        ),
    )


#: How long the Gemini transport may wait on one read, in **milliseconds**.
#:
#: A constant so a test can assert the built client really carries it, and named
#: in the unit the SDK's own field is documented in. See `_gemini_client` for why
#: 90 s, why an unset value is unbounded rather than long, and what it does not
#: bound.
GEMINI_TIMEOUT_MS = 90_000


@lru_cache
def _gemini_client() -> genai.Client:
    """The one Gemini client, built on first use and then kept.

    Cached for the reason `_client` is cached: a client per request is a fresh
    connection pool, which is a DNS lookup and a TLS handshake in front of the
    first token of every turn, and the pools are never closed.

    **The transport's own retry is off, for the reason `max_retries=0` is set
    above.** `loop._open_round` is the only retry that may run, and it is the
    only one that classifies before it waits: `GeminiProvider.classify` reads a
    spent quota apart from a burst limit, which no transport can do. A transport
    retry underneath it is a second loop stacked under the first, so each of the
    loop's attempts can hide a whole backoff before the error is ever
    classified, and the learner waits the product of the two rather than one
    bounded wait.

    The figures this docstring used to quote were wrong — four attempts, 500 ms
    doubling to an 8 s cap, a 30 s `max_elapsed_time` ceiling — so they are
    written down again from the installed SDK, `google-genai==2.18.1`, which has
    no `max_elapsed_time` in it at all:

      * With no `http_options` at all, `retry_options` stays unset and
        `_api_client.retry_args(None)` makes that `stop_after_attempt(1)` — one
        attempt, no transport retry. So this line is a pin rather than a repair.
        What it stops is a future default, or one stray `HttpRetryOptions()`,
        putting the stacked loop back silently.
      * Supply `retry_options` and leave `attempts` unset and the SDK's own
        defaults apply: 5 attempts, 1 s doubling to a 60 s cap, jittered, over
        408, 429, 500, 502, 503 and 504. That is about 17 s of sleeping inside a
        single open, and `_open_round` opens up to three times — a minute or more
        of silence on a persistently failing 5xx or a burst 429, against the
        handful of seconds the loop's own retry bounds it to. That is what
        re-enabling this would cost, and it is why `attempts=0` is written out
        rather than left to a default that happens to agree with it today.

    `attempts=0` rather than `1` because 0 is how this SDK spells "do not retry".
    `retry_args` then normalises it to 1 *in place*, so reading
    `retry_options.attempts` back off a built client says 1; the honest thing to
    assert is `_api_client._async_retry.stop.max_attempt_number`, and
    `tests/test_turn_endpoint.py` does.

    `genai.types.` rather than a top-level import of the two option classes, so
    the qualified name says whose retry is being turned off.

    **`timeout` is stated because this SDK has no default for it.** Left unset,
    `HttpOptions.timeout` is `None`, `_api_client.get_timeout_in_seconds` returns
    `None`, and the httpx path is built with `timeout=None` — which in httpx means
    *no deadline at all*, not a long one. So a Gemini round whose stream went
    quiet forever would have been awaited forever, with `run_turn` inside an
    `async for` that never yields again and the turn row never finished. That is
    read off the installed 2.18.1, not the documentation: `aiohttp` is not a
    dependency of this service, so `_use_aiohttp()` is False and the httpx branch
    is the one that runs. (On the aiohttp branch the same number would be an
    `aiohttp.ClientTimeout(total=…)` — a whole-request deadline rather than a
    per-read one — so adding that dependency would silently change what this
    bounds. Worth knowing before anyone does.)

    **Milliseconds, and the field says so.** `HttpOptions.timeout` is documented
    as "Timeout for the request in milliseconds" and divided by 1000 before it
    reaches httpx, so the plain `90` a reader of the openai SDK would write here
    is 90 ms and fails every turn on the connect.

    **90 s, chosen against the device's 120 s and nothing else.**
    `BackendTutorService.streamTimeout` is 120 s and it is an *idle* bound on
    iOS, so the learner's app abandons a stream after 120 s without a byte. The
    server's own keep-alive cannot cover that gap — `EventTranslator.translate`
    emits one on incoming provider events, of which there are none while the
    provider is silent. So the only useful place for this number is below 120 s:
    at 90 s the server's read raises, `app.api.turn` records the failure and puts
    an `error` event on the wire with 30 s to spare, instead of the device giving
    up on a stream this process still believes is live. Above 120 s the number
    could never help, because the turn is already lost to the learner by then.
    Under httpx this is a per-read bound — the gap between two SSE events, not
    the length of the round — which is what makes 90 s generous rather than tight
    for a model that thinks before it writes.

    **The four eventless waits in `loop.py` were re-checked against this SDK and
    none of them moves.** Every one of them is awaited outside this client:
    `rendezvous.RENDER_TIMEOUT_SECONDS` (20 s) waits on the iPad through an
    `asyncio.Future` and touches no HTTP client at all;
    `loop.MEMORY_TIMEOUT_SECONDS` (20 s) bounds a database query and an
    embeddings call on the *OpenAI* client; `loop.IMAGE_FETCH_TIMEOUT_SECONDS`
    (15 s) sits over `app.tutor.fetch_image`, which owns its own
    `httpx.AsyncClient` and its own total deadline; and
    `loop.FILE_RELAY_TIMEOUT_SECONDS` (15 s) covers `ProducedFile.read`, which on
    this family is `gemini._inline_bytes` — the picture already arrived inside the
    stream, so there is no second request to bound and the 15 s covers only the
    blob write. The bound this client needed was the missing one, above.
    """
    return genai.Client(
        api_key=get_settings().gemini_api_key,
        http_options=genai.types.HttpOptions(
            retry_options=genai.types.HttpRetryOptions(attempts=0),
            timeout=GEMINI_TIMEOUT_MS,
        ),
    )


def _provider(model: str) -> Provider:
    """The family that serves this model.

    `TurnRequest.model` has already been checked against `MODEL_ALLOWLIST`, and
    every allowlisted model has a provider row or the process did not boot, so
    a KeyError here is unreachable rather than unhandled.
    """
    family = PROVIDER_FOR_MODEL[model]
    if family == "openai":
        return OpenAIProvider(client=_client())
    if family == "gemini":
        # A 503 rather than a crash at import, which is the whole reason
        # `gemini_api_key` is optional: a server holding only an OpenAI key must
        # still boot and serve every OpenAI model. What it may not do is answer a
        # Gemini turn, and this is the point where that becomes true — after the
        # request has been validated and before any spend.
        if not get_settings().gemini_api_key:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "GEMINI_API_KEY is not configured on this server",
            )
        return GeminiProvider(client=_gemini_client())
    raise ValueError(f"no provider wired for {family!r}")


def _open_verdict(model: str, error: Exception) -> RetryDecision | None:
    """This model's family reading the exception that ended the turn, or `None`.

    The one thing `stream`'s last `except` clause could not do for itself, and
    the reason a correct verdict was being thrown away. `loop._open_round`
    re-raises a refused open unchanged — immediately for a refusal the provider
    called final, or after `RETRY_LIMIT` attempts — and by then
    `Provider.open_failure` and the family's own `classify` have already decided
    the question. Every named clause in that ladder is `openai`-typed, so a
    `google.genai` exception matched none of them, fell to the generic clause,
    and was recorded `retryable=False` on top of a `RetryDecision` that said
    otherwise: a Gemini 429 the provider itself had read as a burst limit
    reached the iPad as final.

    `None` means no family claims this exception, which is every bug in this
    service's own code, and it is what preserves the generic clause's old
    answer for exactly those. An unanticipated exception is a bug of ours, and
    telling a learner to retry into a bug is worse than telling them plainly
    that the turn failed.

    `provider.open_failure` rather than a second `except` clause naming
    `google.genai`, for the reason the seam exists: this module already imports
    that SDK to *build* a client, but the rule about which of its exceptions is
    retryable belongs to the provider that raised it, beside the `classify` that
    answers it. It is also the only arrangement that scales — a third family
    would otherwise be a fourth clause and a fourth set of attribute names.

    The provider is rebuilt here rather than carried out of the round. It is a
    value object over an `lru_cache`d client, so a second one costs nothing,
    and the alternative is one more piece of generator state that every failure
    path has to keep `None`-safe — including the paths that fail before a
    provider was ever chosen. Everything is guarded, because an exception raised
    while classifying an exception would replace a recorded failure with an
    unrecorded one, inside the handler written to record it: `_provider` itself
    raises an `HTTPException` for a Gemini turn on a server holding no Gemini
    key, and a provider's own `open_failure` reads attributes off a stranger's
    exception object. Logged rather than swallowed silently, because a verdict
    that stopped being recoverable should not look the same as one that was
    never claimed.
    """
    try:
        failure = _provider(model).open_failure(error)
    except Exception:
        logger.exception(
            "could not read a provider verdict for a failed turn on model=%s", model
        )
        return None
    return failure.decision if failure is not None else None


async def _memory_sections(
    sessions: async_sessionmaker[AsyncSession],
    *,
    session_id: uuid.UUID | None = None,
    first_turn: bool = False,
) -> dict:
    """Everything memory contributes to one turn's context — the standing
    block of the memory redesign, deterministic and fresh on every turn.

    Four rendered blocks plus two bare facts, in the shape
    `open_session_preamble` takes them — see `prompt._sections` for where each
    sits relative to the cache boundary and why. The blocks are rendered by the
    module that owns the rows, so the tools cannot answer with the same
    sessions written a second way inside the same prompt.

    `session_id` is this turn's own session: `backstop_tail` must not stand
    the current conversation in for a "previous window" — the transcript
    already carries it. `first_turn` is the caller's claim, made where the
    messages were already in hand.

    `None` rather than `""` for a block with nothing in it, and the difference
    is not cosmetic: `compose_user_prompt` omits a falsy section, so an empty
    string would be dropped too — but only by luck, and a caller reading this
    dict would see a section that exists and is blank. `snapshot` returns `""`
    for a learner nothing has been measured about yet, which is a learner we
    have no reading on, not one who knows nothing.

    Five readers, five sessions, run together. A session owns one connection
    and one transaction, so a `gather` over a single `AsyncSession` interleaves
    two coroutines' protocol traffic on one socket and corrupts its state — the
    fan-out has to be over independent sessions or not at all. Serially these
    are six to eight round trips at 262 ms each; together they cost the slowest
    one, and the block went from 5.5 s to 1.6 s when it was measured.

    The *maker* rather than a session, and not only because the fan-out needs
    one. Test overrides are keyed on `get_recorder`, so a caller that has
    pointed the recorder at another database — the tests do exactly that —
    keeps every leg pointed there too. Resolving `session_factory()` in here
    would have reached past those overrides to whatever `DATABASE_URL` names,
    which is the branch holding real sessions.
    """
    today = datetime.now(timezone.utc).date()

    async def read(fn):
        async with sessions() as db:
            return await fn(db)

    # The backstop: when the latest quiet window has no summary yet —
    # extraction pending, failed, or quarantined — its raw transcript tail
    # stands in as the newest card, so recall never depends on a background
    # job having run.
    episodes, tail, notes, profile, learner_state = await _all_of(
        read(lambda db: recent_episodes(db, SOLE_LEARNER_ID,
                                        limit=RECENT_SESSION_COUNT)),
        read(lambda db: backstop_tail(db, SOLE_LEARNER_ID,
                                      exclude_session=session_id)),
        read(lambda db: explicit_notes(db, SOLE_LEARNER_ID)),
        read(lambda db: current_profile(db, SOLE_LEARNER_ID)),
        read(lambda db: snapshot(db, SOLE_LEARNER_ID)),
    )
    return {
        "profile": profile,
        "learner_state": learner_state or None,
        "recent_sessions": render_sessions(episodes, today=today,
                                           backstop=tail) or None,
        "saved_notes": render_notes(notes) or None,
        "today": today,
        "first_turn": first_turn,
    }


def _upload_kind(row) -> str:
    """The rung this upload came off, recovered from what it converted to.

    Stored as a content type rather than as a kind because the content type is
    what the provider needs; the rung is derivable from it, and one column is
    better than two that can disagree.
    """
    content_type = row.converted_content_type or row.content_type
    if content_type.startswith("image/"):
        return "image"
    if content_type == "text/plain":
        return "text"
    return "pdf"


def _describe_error(error: Exception) -> str:
    """A diagnosable message: exception type, its own text, and — when
    present — the underlying cause.

    str(APIConnectionError(...)) alone is just the generic "Connection
    error."; the actual reason (e.g. the httpx failure that triggered it)
    lives on __cause__, which openai sets via `raise ... from err`. Without
    it, the one piece of information someone debugging a failed turn
    actually needs is the piece that gets thrown away.
    """
    message = f"{type(error).__name__}: {error}"
    cause = error.__cause__
    if cause is not None:
        message += f" (caused by {type(cause).__name__}: {cause})"
    return message


async def _all_of(*aws) -> list:
    """Run these to completion, concurrently, then raise the first failure.

    `asyncio.gather(..., return_exceptions=True)` rather than a `TaskGroup`,
    and the difference is durability rather than style. A TaskGroup cancels its
    siblings the moment one child raises — so a memory read that failed would
    cancel the board write beside it, and a turn that failed would lose the
    attachment row it writes today. Here every await runs to the end, and only
    then is the first exception re-raised.

    Every exception is retrieved, so none can surface later as an unhandled
    "Task exception was never retrieved". The ones not re-raised are logged,
    because a second failure hidden behind the first is exactly the kind of
    thing that goes unnoticed for a month.

    Cancellation propagates as it would from any await: `gather` cancels the
    children and re-raises `CancelledError`, which is a `BaseException` and so
    reaches `stream`'s `finally` untouched by any `except Exception` on the way.
    """
    results = await asyncio.gather(*aws, return_exceptions=True)
    failures = [r for r in results if isinstance(r, BaseException)]
    for extra in failures[1:]:
        logger.warning("concurrent step also failed | %s", _describe_error(extra))
    if failures:
        raise failures[0]
    return results


async def _nothing() -> None:
    """A coroutine standing in for a step this turn does not have.

    Keeps `_all_of`'s results positional, so the caller unpacks the same names
    whether or not the learner sent a region.
    """
    return None


async def _fail_turn_and_report(
    recorder: Recorder,
    *,
    turn_id: uuid.UUID,
    message: str,
    retryable: bool,
    result: TurnResult | None,
    request_body: dict,
    image_blob_key: str | None,
    diagnostics: dict | None = None,
) -> ErrorEvent:
    """Persist the failure, but never let persisting it fail silently.

    fail_turn does real work now — a blob write plus an insert — while
    running inside an except handler, where a second exception is uncaught
    and would leave the turn "running" forever with no ErrorEvent ever
    reaching the client. A learner seeing a clear (if unrecorded) error beats
    a stream that just stops.

    Logged as well as persisted, and logged *first*, because the two failure
    modes this has to survive are "the database write failed" and "the process
    is about to go away" — in both, the log line is the only account that will
    exist.

    `message` is the diagnosable text and it stops here. What goes back to the
    device is `TURN_FAILED_MESSAGE` — see that constant for the rate-limit
    error, organization id and all, that a learner was once shown verbatim.
    """
    logger.warning(
        "turn failed | turn_id=%s retryable=%s %s | %s",
        turn_id, retryable,
        " ".join(f"{k}={v}" for k, v in (diagnostics or {}).items()),
        message,
    )
    try:
        await recorder.fail_turn(
            turn_id=turn_id, message=message, retryable=retryable,
            result=result, request_body=request_body, image_blob_key=image_blob_key,
            diagnostics=diagnostics,
        )
    except Exception:
        # The client still gets its ErrorEvent below either way — this
        # swallow is deliberate, not a bug. But a database-down scenario is
        # exactly the case where this is the *only* place that would ever
        # say why, so it must not be invisible too.
        logger.exception("could not persist turn failure for turn_id=%s", turn_id)
    return ErrorEvent(message=TURN_FAILED_MESSAGE, retryable=retryable)


@dataclass(frozen=True)
class PendingMessage:
    """The learner turn that has not been round-tripped through the DB yet."""

    role: str
    text: str


class TurnRequest(BaseModel):
    turn_id: uuid.UUID
    session_id: uuid.UUID
    text: str
    signal: str | None = None
    goal: str | None = None
    image_base64: str | None = None
    image_region: str | None = None
    #: The learner's whole board as it currently stands, sent on every turn that
    #: has ink on it — not because they asked for it to be looked at, but so the
    #: tutor *can* look. `image_base64` above is the other thing: a region they
    #: chose and pointed at. See `assemble_session_context`.
    #:
    #: A thumbnail, not the board: it is what the model aims with, and anything
    #: it wants to read it asks the device to render. The full-resolution upload
    #: this replaced cost ~160KB on every turn, including every turn where the
    #: model never looked.
    board_overview_base64: str | None = None
    #: The device's own account of where the ink sits, in the percent
    #: coordinates `view_board` takes. A board whose writing occupies two
    #: percent of a large empty field cannot be aimed at from the overview
    #: alone; this is what makes it aimable.
    board_manifest: str | None = None
    #: The device's exact current tutor-authored scene and board state, as a
    #: compact string the model can read and update. Unlike `board_manifest`
    #: (learner ink clusters), this is the model's own semantic output, so it
    #: goes into context verbatim so the model can see what it already drew.
    board_scene: str | None = Field(default=None, max_length=MAX_SCENE_CHARS)
    #: Files the learner attached in the composer, uploaded ahead of this turn
    #: through `POST /v1/attachments`. Ids rather than bytes: conversion has
    #: already happened, the body stays small enough to record verbatim, and a
    #: retry does not re-upload. See `app/api/attachments.py`.
    #:
    #: The cap lives on the field rather than in the handler so a device that
    #: sends six is refused before anything is loaded, and so the recorded
    #: request body can never contain more than the tutor was ever going to
    #: read.
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_ATTACHMENTS_PER_TURN)
    model: str
    reasoning_effort: str

    @field_validator("model")
    @classmethod
    def _model_must_be_allowed(cls, value: str) -> str:
        # Rejected here, at request-body validation, so it 422s before any
        # dependency runs and long before any provider call — a client
        # naming any model at any price is exactly the gap this service
        # exists to close.
        if value not in MODEL_ALLOWLIST:
            raise ValueError(
                f"Unknown model {value!r}. Allowed: {sorted(MODEL_ALLOWLIST)}"
            )
        return value

    @model_validator(mode="after")
    def _effort_must_suit_the_model(self) -> TurnRequest:
        # The other half of the same gap the check above closes. Effort is a
        # multiplier on reasoning tokens, which bill at the output rate, so a
        # device free to name it is a device free to choose the bill. It went
        # unguarded while the model beside it did not.
        #
        # A model validator rather than a field validator on
        # `reasoning_effort`, because the effort cannot be judged alone any
        # more: the two families offer different depths, so which efforts are
        # allowed depends on which model this turn names.
        #
        # `EFFORTS_FOR_MODEL[self.model]` cannot KeyError, and the reason is
        # ordering, which looks incidental and is not. Pydantic runs field
        # validators before every `mode="after"` model validator, so
        # `_model_must_be_allowed` has already refused any model outside
        # MODEL_ALLOWLIST by the time this runs — and every allowlisted model
        # has a row, guarded at import in app/config.py. Move this check ahead
        # of the field validators and an unknown model becomes a 500.
        allowed = EFFORTS_FOR_MODEL[self.model]
        if self.reasoning_effort not in allowed:
            raise ValueError(
                f"Model {self.model!r} does not accept reasoning effort "
                f"{self.reasoning_effort!r}. Allowed: {sorted(allowed)}"
            )
        return self


def get_recorder() -> Recorder:
    """A dependency, not a direct construction.

    Tests must be able to point the recorder at the test branch. If the
    endpoint built it from the module-level session_factory(), an overridden
    db_session would not reach it and the recorder would write to whatever
    DATABASE_URL names — which is the branch holding real sessions.

    The stamp is the second half of what `app.memory.jobs._SETTLED_AT` leans
    on, and it is here rather than only in `db_session` because the two
    `/realtime/*` routes take this dependency and no other: they reach the
    database through the recorder, so a stamp that only `db_session` wrote
    would leave a voice call invisible to the sweep's decision. Nothing writes
    a `Message` outside a `db_session` request today, so this changes no
    behaviour — it stops a future route that does from stranding a window.
    """
    settings = get_settings()
    note_request_use()
    return Recorder(session_factory(), LocalBlobStore(settings.blob_dir))


def _memory_sessions() -> AsyncSession:
    """One session for one memory tool call.

    Shaped like an `async_sessionmaker` because that is what `memory_handler`
    takes, and it wants the maker rather than this request's session on
    purpose — its docstring gives the two reasons.

    `session_factory()` is resolved here, when a tool actually runs, and not
    when the turn is built: a turn that calls no memory tool then never reaches
    the process engine at all. That keeps the memory tools out of the way of a
    caller that has pointed `db_session` and `get_recorder` somewhere else —
    the tests do exactly that — instead of dragging the process engine in
    behind them on every turn.
    """
    return session_factory()()


class BoardRenderBody(BaseModel):
    """One rendered region, on its way back up to the turn that asked for it —
    or the device saying it has none to send.

    Exactly one of the two fields carries the answer. `error` exists because
    the device's failures are instant and knowable: no canvas, a session whose
    board it cannot read. Leaving those to the 20 s timeout spends the
    learner's turn on an answer that was decided in a millisecond.
    """

    call_id: str
    image_base64: str | None = None
    #: Why the device could not render, in its own words. Recorded in the log
    #: and nowhere else — the model is told the board was unavailable, in the
    #: same words it is told after a timeout, because the reason is ours to
    #: debug and not the tutor's to explain to a learner.
    error: str | None = None


@router.post("/turn/{turn_id}/board")
async def deliver_board_render(turn_id: uuid.UUID, body: BoardRenderBody):
    """The device answering a `board_request`.

    A second request rather than anything on the SSE stream, because SSE only
    runs one way. The turn that asked is parked on a future in
    `app.tutor.rendezvous`; this hands it the bytes and the turn resumes.

    404 when nothing is waiting. That is a real case, not a defensive one: the
    turn may already have timed out and told the model it could not see the
    board, and a render that arrives after that must not be silently dropped
    into a void the device thinks succeeded. It also covers a duplicate POST and
    a device replaying an old turn.
    """
    if body.error is not None:
        # Logged at warning because this is the device failing to do the one
        # thing only it can do. It is the line to grep for when a tutor says it
        # could not see the board and the server never restarted.
        logger.warning(
            "board render refused by the device | turn_id=%s call_id=%s reason=%s",
            turn_id, body.call_id, body.error,
        )
        if not rendezvous.fail(turn_id, body.call_id):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "No turn is waiting for that render; it may have already timed out.",
            )
        return {"status": "ok"}

    if body.image_base64 is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Send image_base64, or error saying why not."
        )

    try:
        image = base64.b64decode(body.image_base64)
    except (ValueError, TypeError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "image_base64 is not valid base64.")

    if not image:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The render is empty.")

    if not rendezvous.deliver(turn_id, body.call_id, image):
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "No turn is waiting for that render; it may have already timed out.",
        )
    return {"status": "ok"}


async def _previous_board_sha(
    sessions: async_sessionmaker[AsyncSession], session_id: uuid.UUID
) -> str | None:
    """The sha256 of the last whole board this session sent, or None.

    Its own session so it can run beside the other prologue reads rather than
    behind them: they are all independent, and serially they are sixteen round
    trips at 262 ms in front of every turn.
    """
    async with sessions() as db:
        return (await db.execute(
            select(Attachment.sha256)
            .join(Turn, Turn.id == Attachment.turn_id)
            .where(Turn.session_id == session_id, Attachment.kind == BOARD_KIND)
            .order_by(Attachment.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()


async def _session_messages(
    sessions: async_sessionmaker[AsyncSession], session_id: uuid.UUID
) -> list[Row]:
    """This session's transcript so far, oldest first, as plain rows.

    Fetched by a query rather than through `session.messages`: on an
    AsyncSession, touching an unloaded relationship attribute after flush()
    attempts a lazy SELECT outside the greenlet context and raises
    MissingGreenlet. A plain awaited query has no such trap.

    Columns rather than `select(Message)`, and the column that matters is the
    one that is not here. `Message.fts` is a persisted generated tsvector, 99%
    the size of the text beside it, and nothing outside `search_history` ever
    reads it; hauling it cost a whole extra round trip on every turn — 527 ms
    against 265 ms.

    Plain rows also carry their values out of the session that fetched them.
    `split_live_turn` and `ledger.advance` read `.role` and `.text` long after
    this returns, and an ORM `Message` from a closed session is detached — a
    trap for the next reader rather than for this one.
    """
    async with sessions() as db:
        return list((await db.execute(
            select(Message.seq, Message.role, Message.text, Message.signal)
            .where(Message.session_id == session_id)
            .order_by(Message.seq)
        )).all())


@router.post("/turn")
async def create_turn(
    body: TurnRequest,
    db: AsyncSession = Depends(db_session),
    recorder: Recorder = Depends(get_recorder),
):
    # When the request arrived, not when the stream opens.
    #
    # `stream`'s clock used to start at the top of the generator, which runs
    # after everything below has already happened — so the prologue's round
    # trips were in no log line at all, and `ttft_ms` reported a turn as
    # starting several seconds after the learner pressed send. `stream` takes
    # `started = received`, so every number on the "turn ok" line now measures
    # from the request rather than from the middle of it.
    received = time.monotonic()
    settings = get_settings()

    # Every read this handler needs before it can write anything, at once.
    #
    # None of the five is upstream of another: the idempotency check, the spend
    # cap, the session row, the previous board's hash, the transcript and the
    # named uploads all answer questions about state that already exists.
    # Serially they were sixteen round trips at 262 ms — about 4.2 s in front
    # of every turn. The checks below still run in the order they always did,
    # so the same request still gets the same status code; only a duplicate
    # turn_id now pays for reads it will throw away, and that is an error path.
    #
    # `db.get(Turn)` and `db.get(Session)` share the request session because
    # the session row is mutated and committed through it. The rest take their
    # own session from the pool — a `gather` over one `AsyncSession` would
    # interleave two coroutines on one connection and corrupt it.
    async def _turn_and_session():
        return (await db.get(Turn, body.turn_id),
                await db.get(Session, body.session_id))

    (existing_turn, session), spend, previous_sha, existing_messages, upload_rows = (
        await _all_of(
            _turn_and_session(),
            recorder.spend_today(),
            _previous_board_sha(recorder.sessions, body.session_id),
            _session_messages(recorder.sessions, body.session_id),
            # Loaded before the stream opens, because a missing attachment is a
            # transport-level refusal — the learner's file never made it —
            # rather than something to report mid-turn once they have already
            # seen the tutor start to answer. Returns [] without touching the
            # database when the request named none.
            recorder.load_uploads(
                session_id=body.session_id, ids=body.attachment_ids
            ),
        )
    )

    if existing_turn is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This turn was already handled.")

    # Today's recorded dollars — turns and voice both, each priced at record
    # time from config's price tables. Checked before the session row or any
    # provider call exists, so a capped day is one clean 402 rather than a
    # turn that dies mid-stream.
    if spend >= settings.daily_spend_cap_usd:
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED, "Daily spend cap reached."
        )

    if session is None:
        session = Session(
            id=body.session_id, model=body.model, reasoning_effort=body.reasoning_effort
        )
        db.add(session)
        await db.flush()
    else:
        # Keep the session's own columns current rather than frozen at whatever
        # request happened to create the row. Two reasons: the device can change
        # either setting mid-session, and /v1/dictation can create a session
        # without knowing either, so a dictation-first session would otherwise
        # carry `DEFAULT_MODEL` for the rest of its life. The per-turn record is
        # on `Turn` and is unaffected either way — this is the *current*
        # selection, not a history.
        #
        # Changing the model mid-session is allowed and costs more than it
        # looks: prompt caches are model-scoped, so the next turn re-processes
        # the entire prefix — system prompt, tools, portrait, transcript — at
        # full price on the new model. Effort is a request parameter and not
        # part of the prefix, so switching that is free.
        session.model = body.model
        session.reasoning_effort = body.reasoning_effort

    image = base64.b64decode(body.image_base64) if body.image_base64 else None
    board = base64.b64decode(body.board_overview_base64) if body.board_overview_base64 else None

    if len(upload_rows) != len(body.attachment_ids):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "One of those attachments is not on this session.",
        )
    # Together, for the same reason the reads above are: the blob store is
    # local files read on a thread, so five uploads was five serial thread hops
    # for no reason. `_all_of` returns [] for no uploads without awaiting.
    upload_bytes = await _all_of(*(
        recorder.blob(row.converted_blob_key or row.blob_key)
        for row in upload_rows
    ))
    uploads = [
        UploadPart(
            # What the learner called it, for the prompt's inventory and for
            # anything the model says back about it. Not what the provider is
            # told the file is called — that is rebuilt from the content type,
            # which is why `"attachment"` with no extension is a safe fallback
            # here. See `parts.provider_filename`.
            filename=row.filename or "attachment",
            kind=_upload_kind(row),
            page_count=row.page_count or 1,
            content_type=row.converted_content_type or row.content_type,
            data=data,
        )
        for row, data in zip(upload_rows, upload_bytes)
    ]

    # Whether the board differs from the one this session last sent.
    #
    # Computed here rather than left for the model to notice, because it cannot:
    # its context holds a fresh picture *and* a transcript of its own earlier
    # descriptions of an older one, and it will repeat the text. This is the
    # single fact that stops it — see `board.describe`. `None` means "no previous
    # board to compare against", which is a first look, not an unchanged one.
    board_sha = hashlib.sha256(board).hexdigest() if board is not None else None
    board_changed = None if previous_sha is None else (board_sha != previous_sha)

    # First turn of a new session = no tutor message in it yet. Computed off
    # the rows already in hand, before this turn's own message is added: a
    # learner message that never got its reply still leaves the session on
    # its first turn.
    first_turn = not any(m.role == "tutor" for m in existing_messages)

    seq = len(existing_messages)
    db.add(Message(session_id=session.id, seq=seq, role="learner", text=body.text,
                   signal=body.signal))
    db.add(Turn(id=body.turn_id, session_id=session.id, status="running",
                model=body.model, reasoning_effort=body.reasoning_effort))
    try:
        await db.commit()
    except IntegrityError:
        # The db.get() check above and this insert are not atomic, so two
        # near-simultaneous submissions of the same turn_id can both pass it.
        # Defending against exactly that race is the whole point of the
        # idempotency check, so the loser gets the same clean 409 the fast
        # path gives, not a raw 500 on a primary-key violation.
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "This turn was already handled.")

    # split_live_turn and ledger.advance read only .role and .text, so the
    # pending learner turn joins the history as a plain record rather than a
    # premature ORM object.
    # It joins it at the end, and being last is what makes it the turn rather
    # than more history: `context.split_live_turn` takes the trailing learner
    # message back off and sends it as its own message, so the request is asked
    # rather than quoted. Appending it anywhere else would bury it again.
    messages = list(existing_messages) + [
        PendingMessage(role="learner", text=body.text)
    ]
    next_seq = seq + 1

    # `prologue_ms` is everything above this line: the concurrent read block
    # and the commit. It is on its own because it is the one stretch of a turn
    # that no other number covers — `elapsed_ms` now contains it, but only this
    # says how much of the total it was.
    logger.info(
        "turn started | turn_id=%s session_id=%s model=%s effort=%s "
        "has_image=%s has_board=%s history=%d prologue_ms=%d",
        body.turn_id, session.id, body.model, body.reasoning_effort,
        image is not None, board is not None, seq,
        int((time.monotonic() - received) * 1000),
    )

    async def stream():
        # The request's own clock, not the generator's. See `received` above.
        started = received
        ttft_ms: int | None = None
        image_ref = None
        result: TurnResult | None = None
        # The `error` event `run_turn` put on the wire, if it put one there.
        #
        # A round can fail *inside* an open stream, and that failure does not
        # raise: `run_turn` logs the provider's words, yields one `ErrorEvent`
        # and returns, so the `async for` below finishes normally and every
        # `except` clause is skipped. Without this the success path then ran —
        # `finish_turn` wrote status "ok" and a `DoneEvent` followed the error
        # the learner had already been shown, and because a stream that ends on
        # an error never sent a completion there was no usage either, so the
        # round's spend was recorded as nothing at all. That is the same shape
        # `TURN_FAILED_MESSAGE`'s own commit was written to close, arrived at
        # from the other side.
        #
        # The event rather than a bare flag, because `retryable` is the one
        # structured fact the device was given and the row should agree with it.
        stream_failure: ErrorEvent | None = None
        # How long this turn has gone without putting anything on the wire, and
        # the worst such gap so far.
        #
        # This is *the* number. The failure that produced all of this was a
        # client giving up after sixty silent seconds, and nothing recorded
        # anywhere said how quiet the connection had been — so the one fact that
        # would have identified it in a single query was the one fact nobody
        # had. It is now on every turn's log line and in every failed turn's
        # `error` column, healthy turns included, because a turn creeping toward
        # the timeout is worth seeing *before* it crosses it.
        last_sent = started
        max_silence = 0.0
        events_sent = 0

        def sse(event) -> str:
            """Serialise one event, and remember that the line just went quiet."""
            nonlocal last_sent, max_silence, events_sent
            now = time.monotonic()
            max_silence = max(max_silence, now - last_sent)
            last_sent = now
            events_sent += 1
            return format_sse(event)

        def diagnostics() -> dict:
            """What this turn looked like from the wire, whatever happened to it."""
            now = time.monotonic()
            return {
                "elapsed_ms": int((now - started) * 1000),
                "ttft_ms": ttft_ms,
                "events_sent": events_sent,
                # The trailing gap counts: on a timeout it *is* the failure, and
                # it is the one interval no `sse()` call ever closes.
                "max_silence_ms": int(max(max_silence, now - last_sent) * 1000),
                # Provider events consumed, not tool rounds — it is the cheapest
                # way to tell "the model never answered" from "the model was
                # answering and something cut it off".
                "provider_events": len(result.raw_events) if result is not None else 0,
            }
        # Always defined, even if the prompt is never assembled at all: an
        # except clause (or the finally guard) reached before the first
        # model round must still have something to hand to fail_turn/
        # finish_turn rather than raising NameError on top of the original
        # failure. Once a round actually starts, run_turn replaces this
        # envelope wholesale with the real payload — tools, reasoning,
        # store, stream and all — so the fallback only ever records the
        # skeleton of a turn that never reached the provider.
        request_body: dict = {
            "model": body.model,
            "input": None,
            # Recorded so a cache miss can be diagnosed from the stored call
            # rather than guessed at: the key is half of what decides which
            # cache a request reaches, and the prompt is the other half.
            "prompt_cache_key": str(session.id),
        }

        async def fetch_board(call_id: str, region: BoardRegion) -> bytes:
            """Wait for the device to render one region of its board.

            The matching `board_request` event has already been yielded by
            `run_turn` — that is what tells the device to draw this — so by the
            time this runs the ask is on the wire and all that is left is the
            wait. `open_request` is registered *before* the yield would be a
            nicer ordering, but the generator cannot hand us control between the
            two; the device cannot POST faster than its own render, so the small
            window where the future does not yet exist is not reachable in
            practice. `deliver` returning False is the guard if it ever is.
            """
            future = rendezvous.open_request(body.turn_id, call_id)
            return await rendezvous.await_render(
                future, turn_id=body.turn_id, call_id=call_id
            )

        async def fetch_and_record_image(url: str) -> FetchedImage:
            """Download one picture the model asked for, and keep the bytes.

            Two halves, and the second is not optional. `app.tutor.fetch_image`
            is the guarded download and holds every rule about where a
            model-chosen URL may point. This is what makes the result *usable*:
            the bytes have to live somewhere the iPad can GET them, because what
            the model does with this answer is place an `image` element carrying
            the `blob_id`, and the device then loads it from
            `/v1/blobs/{key}`. The attachment row is also where that endpoint
            recovers the content type — the blob store itself only knows bytes.

            A refusal comes back as `{"error": ...}` rather than raising. Every
            way this can fail is a URL that did not work out, and a model told
            so can look for another picture; a raise here would end a turn over
            a dead link.

            **The blob and the model get different pictures, on purpose.** The
            blob keeps the download exactly as it arrived, because that is what
            the device loads and draws. What goes back into the conversation is
            `model_copy`'s reduced version — see that function for why a
            1080x1080 PNG re-billed across a turn's rounds is what ended two of
            these turns at the account's tokens-per-minute ceiling. The
            `blob_id` the model is told still names the original, so nothing
            about placing the picture changes.
            """
            try:
                fetched = await fetch_image(url)
            except ImageFetchError as error:
                return FetchedImage(output=json.dumps({"error": error.reason}))

            ref = await recorder.record_attachment(
                turn_id=body.turn_id, kind=FETCHED_IMAGE_KIND,
                data=fetched.data, content_type=fetched.content_type,
            )
            # Off the event loop, and that is not politeness. `model_copy`
            # decodes, resamples and encodes; run inline it would stop every
            # other learner's SSE stream in this process for its whole length,
            # inside the one handler whose whole job is not to go quiet.
            shown = await asyncio.to_thread(
                model_copy, fetched.data, fetched.content_type
            )
            logger.info(
                "image fetched | turn_id=%s bytes=%d type=%s size=%dx%d "
                "shown_bytes=%s shown_type=%s",
                body.turn_id, len(fetched.data), fetched.content_type,
                fetched.width, fetched.height,
                len(shown[0]) if shown else None,
                shown[1] if shown else "none",
            )
            answer = {
                "blob_id": ref.key,
                "width": fetched.width,
                "height": fetched.height,
            }
            if shown is None:
                # Said out loud, because nothing else in this answer says it.
                # The blob id, the width and the height all arrive exactly as
                # they do for a picture the model *was* shown, and there is no
                # error — so without this the model places the image and then
                # describes it from the URL it read somewhere. See
                # `PICTURE_NOT_SHOWN_NOTE`.
                answer["note"] = PICTURE_NOT_SHOWN_NOTE
            return FetchedImage(
                output=json.dumps(answer),
                # Not the bytes the blob holds — the small copy of them, handed
                # back so `run_turn` can show the model what it is about to
                # place and then talk about. Without a picture at all it would
                # be describing a URL.
                #
                # `None` when there is no copy to show. The blob id above still
                # went out, so the model can place a picture it was not shown —
                # which is the same position `view_board` leaves it in when the
                # device cannot draw, and better than a turn that fails over it.
                image=shown[0] if shown else None,
                content_type=shown[1] if shown else None,
                source_bytes=len(fetched.data),
            )

        async def relay_container_file(file: ProducedFile) -> RelayedFile:
            """Keep one file a script wrote, wherever the provider held it.

            The reason this exists at all is that the container is temporary.
            A `code_interpreter` sandbox lives for the response that created it,
            and the chart its script drew lives in the sandbox — so bytes not
            taken now are bytes nobody can ever see. This is the only window.

            Three steps, and the middle one is what makes the result usable.
            `file.read()` is the guarded read the provider bound — for OpenAI,
            `download_container_file`: the SDK call verified against openai
            2.53.0, streamed and capped, holding every rule about how much of a
            file this service will take. The blob write is what gives the bytes a
            name the iPad can GET, because what the model does next is place an
            `image` element carrying that `blob_id`. The attachment row is where
            `GET /v1/blobs/{key}` recovers the content type — the blob store
            itself only knows bytes, and `relayed_content_type` is what decides
            which claim the row may make.

            A failure comes back as `RelayedFile(error=...)` rather than raising,
            for the reason `fetch_and_record_image` refuses in band: a provider
            hiccup over one chart must not end a learner's turn, and a model
            told the file did not save can say so instead of describing a
            picture that is not there.
            """
            filename = file.filename
            try:
                data = await file.read()
            except ContainerFileTooLarge as error:
                logger.warning(
                    "container file too large | turn_id=%s file=%s error=%s",
                    body.turn_id, filename, error,
                )
                return RelayedFile(error="the file was too large to keep")
            except APIError as error:
                logger.warning(
                    "container file relay failed | turn_id=%s file=%s error=%s",
                    body.turn_id, filename, error,
                )
                return RelayedFile(error="the file could not be read back")

            content_type = relayed_content_type(filename)
            ref = await recorder.record_attachment(
                turn_id=body.turn_id, kind=SCRIPT_OUTPUT_KIND,
                data=data, content_type=content_type,
            )
            # Pictures only, and for the reason `fetch_and_record_image` reduces
            # its download: a chart is looked at once by the model and re-billed
            # on every round after that. The blob keeps the file the script
            # wrote, which is the one the device downloads by `blob_id`. Nothing
            # else is touched — a CSV has no resolution to spend, and
            # `relay_item` never shows it anyway.
            # Off the event loop, for the reason the fetch above gives.
            shown = (
                await asyncio.to_thread(model_copy, data, content_type)
                if content_type in ALLOWED_CONTENT_TYPES
                else (data, content_type)
            )
            logger.info(
                "container file relayed | turn_id=%s file=%s bytes=%d type=%s "
                "shown_bytes=%s",
                body.turn_id, filename, len(data), content_type,
                len(shown[0]) if shown else None,
            )
            return RelayedFile(
                blob_id=ref.key,
                # The picture, reduced — or nothing, when `model_copy` refused to
                # decode it. This is the one path into that function with no
                # pixel guard in front of it, so the refusal is reachable here
                # and only here, and it lands somewhere that already works:
                # `relay_item` lists a file with no `data` by name and blob id,
                # with no picture beside it, which is exactly what a CSV gets.
                data=shown[0] if shown else None,
                content_type=shown[1] if shown else content_type,
                # The download, which `TURN_DOWNLOAD_BYTE_LIMIT` is counted in.
                source_bytes=len(data),
            )

        # Everything that can strand a turn at status="running" — the image
        # write, assembling the prompt, the model call, and persisting the
        # result — lives inside this one try, and the matching `finally`
        # below is the single structural guard that closes it off,
        # regardless of which of those raised, or whether nothing raised at
        # all and the client simply disconnected. A per-branch try/except
        # was tried here twice before and left new holes each time:
        # assembling the prompt used to run entirely outside this generator
        # (nothing caught it), recorder.finish_turn used to run after the
        # try/except ended (nothing caught it either), and a client
        # disconnect throws asyncio.CancelledError, a BaseException that
        # `except Exception` was never going to catch no matter where it
        # was placed.
        try:
            if image is not None:
                # The service knows an image is attached before the model does, so
                # this status is deterministic rather than translated from a
                # provider event. detail is left unset: image_region already
                # reaches the model through the assembled prompt, and the wire
                # contract for this status is bare.
                yield sse(StatusEvent(phase="looking", detail=None))

            # The two attachment writes and the memory read, together, because
            # not one of them is upstream of another.
            #
            # Both writes are *only for the record*. The bytes are already in
            # memory and reach the model through `assemble_session_context`
            # below, so nothing in the prompt waits on a row landing.
            # `board_changed` is the one thing that ever reads a BOARD_KIND row
            # back, and it read the *previous* turn's row in the prologue —
            # this turn's write cannot race its own comparison. The memory read
            # touches neither.
            #
            # Serially these were about 7.1 s on the measured link: a write
            # session is six round trips at 262 ms, and the memory read is six
            # to eight statements behind a fresh checkout. Run together they
            # cost the slowest one, about 2.4 s.
            #
            # Still inside the guard, not before the stream opens. A failure in
            # any of them has to fail the turn visibly rather than raise past
            # `create_turn` and leave the row at status="running" forever — the
            # same hole assembling the prompt was moved in here to close.
            # `_all_of` re-raises inside this `try`, from the same position
            # these awaits already raised from, so every existing `except`
            # below sees exactly what it saw before.
            image_ref, _board_ref, sections = await _all_of(
                recorder.record_attachment(
                    turn_id=body.turn_id, kind="board_png", data=image,
                    content_type="image/png",
                ) if image is not None else _nothing(),
                # Recorded for the *next* turn's comparison as much as for the
                # audit trail: `board_changed` above reads exactly this row
                # back. Content-addressed, so a board sent twice unchanged
                # costs one blob, not two.
                recorder.record_attachment(
                    turn_id=body.turn_id, kind=BOARD_KIND, data=board,
                    content_type="image/png",
                ) if board is not None else _nothing(),
                # Once per session, and never again. The four blocks it reads
                # go into `prompt_preamble`, which is then served byte for byte
                # for the rest of the session — so turns 2..N skip this
                # entirely. It is six to eight statements on a 262 ms link,
                # about 2,400 ms even parallelised, in front of every turn.
                _memory_sections(
                    recorder.sessions, session_id=session.id,
                    first_turn=first_turn,
                ) if session.prompt_preamble is None else _nothing(),
            )

            # The frozen head: this session's first turn builds it, every turn
            # after replays it. Nothing recomputes it, and that is deliberate
            # for the values inside it that *do* move — the mastery snapshot,
            # the goal, the workspace, the board scene. Whatever moved one of
            # them is a tool call the model made, sitting in the log below with
            # the ack it read; restating the result would be telling the model
            # something it just did and re-costing the whole head to say it.
            preamble = session.prompt_preamble
            if preamble is None:
                preamble = open_session_preamble(
                    goal=body.goal, exercise=session.exercise, plan=session.plan,
                    board_overview=board, board_scene=body.board_scene,
                    **sections,
                )

            # The log, extended by exactly this turn's bytes. `history` is the
            # conversation behind the live turn; the live turn stays out of the
            # log until it is history, which is what stops a request being
            # delivered as a quotation of itself.
            history, live_turn = split_live_turn(messages)
            stored_log = ledger.LogState.from_json(session.prompt_log)
            log = ledger.advance(
                stored_log,
                messages=history,
                entry=ledger.turn_entry(
                    stored_log.turn + 1,
                    image_region=body.image_region,
                    has_image=image is not None,
                    upload_names=[upload.filename for upload in uploads],
                    signal=body.signal,
                    board_changed=board_changed,
                    board_manifest=body.board_manifest,
                ),
            )

            bundle = assemble_session_context(
                preamble=preamble, log=log, live_turn=live_turn,
                image_data=image, board_overview=board, uploads=uploads,
            )
            async for event, running in run_turn(
                provider=_provider(body.model), model=body.model,
                effort=body.reasoning_effort,
                bundle=bundle, request_body=request_body, fetch_board=fetch_board,
                fetch_image=fetch_and_record_image,
                # Without this the hosted code interpreter can still run — it is
                # in `TOOL_DEFINITIONS` unconditionally — but every file its
                # script writes dies with the container it was written in, and
                # the model is never told a blob id it could place.
                relay_file=relay_container_file,
                # Every turn of one session shares the longest prompt prefix
                # there is, so they should all reach the same cache. The
                # session id is what says "these belong together".
                cache_key=str(session.id),
                # Without this the four memory tools are inert. They sit in
                # `TOOL_DEFINITIONS` unconditionally — varying the tool set per
                # turn would invalidate the cached prompt prefix — so the model
                # is offered them, calls them, and is answered `NO_MEMORY_ACK`
                # every time. Bound per turn rather than once per process
                # because `remember` and `record_evidence` file the turn and
                # session they came from as provenance.
                handle_memory=memory_handler(
                    _memory_sessions, learner_id=SOLE_LEARNER_ID,
                    turn_id=body.turn_id, session_id=session.id,
                ),
                handle_web_search=search_web,
            ):
                result = running
                if ttft_ms is None and event.type == "text_delta":
                    ttft_ms = int((time.monotonic() - started) * 1000)
                if event.type == "error":
                    # Both of `run_turn`'s error yields are a provider `Failed`
                    # arriving mid-stream, and both end the turn. Recorded here
                    # rather than acted on here so the event still reaches the
                    # device in its proper place in the stream.
                    stream_failure = event
                yield sse(event)

            if stream_failure is not None:
                # Failed, not finished. The device already has its `ErrorEvent`,
                # so the one this returns is dropped — telling a learner twice
                # would be worse than not recording at all, which is what this
                # branch exists to stop.
                #
                # `result` is passed for the reason `fail_turn`'s own docstring
                # gives: a turn that spent money and then died is the turn whose
                # usage matters most, and on a multi-round turn everything before
                # the failing round is already in it.
                #
                # The message says where the provider's own words are rather than
                # repeating them, because it cannot: `run_turn` logs them and
                # hands back only the sanitised event. The log line it names is
                # the grep target.
                await _fail_turn_and_report(
                    recorder, turn_id=body.turn_id,
                    message=(
                        "the round reported an error inside an open stream; the "
                        "provider's own words are in the preceding "
                        "'the round failed' log line"
                    ),
                    retryable=stream_failure.retryable, result=result,
                    request_body=request_body,
                    image_blob_key=image_ref.key if image_ref else None,
                    diagnostics=diagnostics(),
                )
            elif result is not None:
                await recorder.finish_turn(
                    turn_id=body.turn_id, session_id=session.id, next_seq=next_seq,
                    result=result, request_body=request_body,
                    ttft_ms=ttft_ms,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    image_blob_key=image_ref.key if image_ref else None,
                    # The exact bytes this turn sent, so the next turn extends
                    # them rather than rebuilding them. On the success path
                    # only: see `finish_turn` for why a failed turn storing
                    # nothing is the safe outcome rather than a lost update.
                    prompt_preamble=preamble,
                    # `recording` folds in what this turn drew, read off
                    # `result.tool_calls`. It is the only record of the ids the
                    # model assigned to its own board elements: the transcript
                    # renders a message as `role: text`, so a tool call leaves
                    # no trace in it, and the scene string that used to carry
                    # them is no longer re-sent.
                    prompt_log=log.recording(result.tool_calls).as_json(),
                )
                usage = result.usage or {}
                cached, written = cache_tokens(usage)
                yield sse(DoneEvent(
                    turn_id=body.turn_id,
                    input_tokens=usage.get("input_tokens"),
                    output_tokens=usage.get("output_tokens"),
                    cached_tokens=cached,
                ))
                # Logged on the happy path too, not only on failure. The turns
                # that died were preceded by turns that *worked* while creeping
                # toward the client's timeout — the last good one sent nothing
                # for 59.5 of its 62.7 seconds. Only a line on every turn makes
                # that trend visible before it becomes an outage.
                #
                # `cached` and `written` ride on the same line as the rest.
                # A cache hit rate is not something anyone goes looking for —
                # it is only ever noticed when it is already on the page next
                # to the cost it explains, and a prompt whose whole layout is
                # built around earning that hit deserves to say whether it did.
                #
                # `cached` alone could not say *why* it was low, which is why
                # a prefix that had quietly stopped matching went unnoticed
                # through eleven consecutive turns of one session. Three more
                # fields settle it between them, and all three are free:
                #
                #   `bp_chars` — the prompt in front of this turn's last cache
                #     breakpoint, the prefix the turn asked to read back.
                #   `bp` — how many breakpoints the request declared, so a
                #     silently dropped one is visible rather than inferred.
                #   `session_id` — which turns to read against each other, and
                #     the timestamps between two of them are the gap that says
                #     whether a cache had time to expire.
                #
                # Read together:
                #   cached ≈ 0                      → cold cache. Check the gap
                #     to this session's previous line against the 30m TTL, or
                #     it is simply the session's first turn.
                #   cached > 0, flat across turns,
                #   while bp_chars climbs           → breakpoint miss: something
                #     marked is a different string than it was last turn.
                #   cached rising with bp_chars     → healthy.
                logger.info(
                    "turn ok | turn_id=%s session_id=%s %s in=%s cached=%s "
                    "written=%s bp_chars=%s bp=%s out=%s reasoning=%s",
                    body.turn_id, session.id,
                    " ".join(f"{k}={v}" for k, v in diagnostics().items()),
                    usage.get("input_tokens"), cached, written,
                    bundle.cache_prefix_chars,
                    sum(
                        1 for item in bundle.input
                        for part in (item.get("content") or [])
                        if isinstance(part, dict) and "prompt_cache_breakpoint" in part
                    ),
                    usage.get("output_tokens"),
                    (usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
                )
        except APIStatusError as error:
            decision = classify(error.status_code, error.body)
            event = await _fail_turn_and_report(
                recorder, turn_id=body.turn_id, message=_describe_error(error),
                retryable=decision.retry, result=result, request_body=request_body,
                image_blob_key=image_ref.key if image_ref else None,
                # The rule that made the call, recorded beside the failure. On
                # this branch as much as on the in-stream one below: a billing
                # 429 and a rate-limit 429 are the same status and opposite
                # verdicts, and the row could not previously say which it read.
                diagnostics={**diagnostics(), "classified": decision.reason},
            )
            yield sse(event)
        except APIConnectionError as error:
            # Covers APITimeoutError too — it subclasses APIConnectionError.
            # Both are transient network failures, not a verdict from the
            # provider, so they are retryable by definition.
            event = await _fail_turn_and_report(
                recorder, turn_id=body.turn_id, message=_describe_error(error),
                retryable=True, result=result, request_body=request_body,
                image_blob_key=image_ref.key if image_ref else None,
                diagnostics=diagnostics(),
            )
            yield sse(event)
        except APIError as error:
            # **The provider refusing from inside the stream.** Third, because
            # both clauses above are subclasses of this one and Python takes the
            # first that matches — widening this to cover them would throw away
            # a status code and a `Retry-After` that are already read properly.
            #
            # What lands here is the failure neither of them can see: the
            # round's `POST` answered 200, the stream opened, and the refusal
            # arrived a minute later as an SSE `error` event. The SDK raises a
            # bare `APIError` for that — no status code, not an
            # `APIStatusError` — so it used to fall to the generic handler
            # below and be recorded `retryable=False`. The failure that made
            # this branch exist was a TPM rate limit whose own text said "Please
            # try again in 662ms", written into `turns.error` as final.
            #
            # `error.body` is the provider's error object, already unwrapped by
            # the SDK, and it is not guaranteed to be a dict — a non-JSON body
            # is passed through as whatever it was. `classify` reads the
            # message when the body names nothing, which is the shape this
            # arrived in.
            decision = classify(
                None,
                error.body if isinstance(error.body, dict) else None,
                error.message,
            )
            event = await _fail_turn_and_report(
                recorder, turn_id=body.turn_id, message=_describe_error(error),
                retryable=decision.retry, result=result, request_body=request_body,
                image_blob_key=image_ref.key if image_ref else None,
                diagnostics={**diagnostics(), "classified": decision.reason},
            )
            yield sse(event)
        except Exception as error:
            # **Last, and it has to stay last.** The three clauses above are all
            # `openai`-typed and two of them subclass the third, so Python's
            # first-match rule is the only thing keeping a status code and a
            # `Retry-After` from being swallowed by the wider clause behind them.
            # This one is wider still — it catches every exception, including
            # those of a family whose exception class this ladder must not name —
            # so anywhere but the end it would take all three.
            #
            # What it used to do with a `google.genai` refusal was throw the
            # answer away. `loop._open_round` re-raises one unchanged, either
            # straight away or once `RETRY_LIMIT` is spent; it matched none of the
            # `openai` clauses, arrived here, and was written down
            # `retryable=False` — a hardcoded verdict laid over the provider's
            # own, which `open_failure` and `classify` had already got right. So
            # the verdict is recovered rather than re-decided; see
            # `_open_verdict`.
            #
            # A mid-stream failure is still never silently retried by us, and a
            # bug in our own code still lands here and is still final: a `None`
            # verdict is what says no family claims this, and telling a learner
            # to retry into a bug is worse than telling them plainly it failed.
            # This clause also covers a raise from assembling the prompt and from
            # recorder.finish_turn, neither of which used to be reachable here.
            decision = _open_verdict(body.model, error)
            event = await _fail_turn_and_report(
                recorder, turn_id=body.turn_id, message=_describe_error(error),
                retryable=False if decision is None else decision.retry,
                result=result, request_body=request_body,
                image_blob_key=image_ref.key if image_ref else None,
                # `classified` only when a family actually made the call, for the
                # reason the two clauses above record it: a row saying which rule
                # was applied is a row someone can argue with. Its absence is
                # itself the reading — nothing classified this, so nothing about
                # it was ever judged retryable.
                diagnostics=diagnostics() if decision is None else {
                    **diagnostics(), "classified": decision.reason,
                },
            )
            yield sse(event)
        finally:
            # The structural backstop: whatever just happened above — a
            # clean finish, one of the classified excepts above (which
            # already failed the turn), some exception those excepts don't
            # know about, or a client disconnect delivered as
            # asyncio.CancelledError (a BaseException, so none of the
            # `except` clauses above ever see it and this finally is the
            # only code that runs) — a turn still "running" at this point
            # was never resolved by anything above and must not stay that
            # way, or its turn_id is stranded forever: the idempotency check
            # only tests whether the row exists, so a "running" row can
            # never be retried. Re-read through the recorder, not a local
            # variable, since a disconnect can land here without any of the
            # in-generator state being trustworthy.
            #
            # **Shielded, or none of the above happens.** This guard was
            # written for the disconnect case and did not survive it: a
            # disconnect cancels the anyio scope Starlette runs this generator
            # in, and a cancelled scope re-delivers cancellation at every
            # subsequent `await` — so `turn_status` below was cancelled on the
            # first one, every time, and `except Exception` never saw it
            # because `CancelledError` is a `BaseException`. The turns this was
            # supposed to rescue sat at status="running" forever, which is
            # exactly the state it exists to prevent. `move_on_after(...,
            # shield=True)` is the construct that lets cleanup finish inside a
            # cancelled scope, and its deadline is what keeps the shield from
            # becoming a hang.
            with anyio.move_on_after(CLEANUP_TIMEOUT_SECONDS, shield=True):
                try:
                    status_now = await recorder.turn_status(body.turn_id)
                except Exception:
                    # A database that can't answer this check can't persist a
                    # fail_turn write either — logging is the only thing left to
                    # do, same reasoning as _fail_turn_and_report's own swallow.
                    logger.exception(
                        "could not check turn status while closing out turn_id=%s",
                        body.turn_id,
                    )
                    status_now = None
                if status_now == "running":
                    await _fail_turn_and_report(
                        recorder, turn_id=body.turn_id,
                        message=(
                            "the turn ended without completing (the client "
                            "disconnected, or a failure went unrecorded)"
                        ),
                        retryable=True, result=result, request_body=request_body,
                        image_blob_key=image_ref.key if image_ref else None,
                        # `max_silence_ms` is the tell for this specific exit.
                        # A disconnect after a long quiet stretch is a client
                        # timeout; a disconnect at a few hundred milliseconds is
                        # someone closing the app. The row could not previously
                        # distinguish those, and neither could anyone reading it.
                        diagnostics=diagnostics(),
                    )
            # Deliberately not caught anywhere above: re-raising is what
            # tells the ASGI server the connection is really gone, and
            # swallowing a BaseException here would be exactly the kind of
            # silent failure this whole guard exists to prevent.

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers=SSE_HEADERS)
