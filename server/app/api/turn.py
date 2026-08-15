from __future__ import annotations

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
from openai import APIConnectionError, APIStatusError, AsyncOpenAI
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.attachments.parts import UploadPart
from app.auth import require_device_token
from app.config import (
    MAX_ATTACHMENTS_PER_TURN, MODEL_ALLOWLIST, REASONING_EFFORT_ALLOWLIST,
    RECENT_SESSION_COUNT, SOLE_LEARNER_ID, get_settings,
)
from app.learner.mastery import snapshot
from app.memory.dispatch import memory_handler
from app.memory.profile import current_profile
from app.memory.retrieve import (
    backstop_tail, explicit_notes, recent_episodes, render_notes,
    render_sessions,
)
from app.sse import SSE_HEADERS, format_sse
from app.store.db import db_session, session_factory
from app.store.blobs import LocalBlobStore
from app.store.models import Attachment, Message, Session, Turn
from app.store.recorder import Recorder, cache_tokens
from app.tutor.context import assemble_context
from app.tutor.events import DoneEvent, ErrorEvent, StatusEvent
from app.tutor.board_scene import MAX_SCENE_CHARS
from app.tutor import rendezvous
from app.tutor.fetch_image import ImageFetchError, fetch_image
from app.tutor.loop import FetchedImage, TurnResult, run_turn
from app.tutor.rendezvous import BoardRegion
from app.tutor.retry import classify

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

#: How long the close-out in `stream`'s `finally` may take before it is
#: abandoned.
#:
#: It runs shielded from cancellation, which is the only way it can run at all
#: on the disconnect path — and a shield with no deadline is how a wedged
#: database turns one dropped connection into a coroutine that never returns.
#: Two writes against a warm pool; ten seconds is slack, not a budget.
CLEANUP_TIMEOUT_SECONDS = 10.0


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
    return AsyncOpenAI(api_key=get_settings().openai_api_key, max_retries=0)


async def _memory_sections(
    db: AsyncSession,
    *,
    session_id: uuid.UUID | None = None,
    first_turn: bool = False,
) -> dict:
    """Everything memory contributes to one turn's context — the standing
    block of the memory redesign, deterministic and fresh on every turn.

    Four rendered blocks plus two bare facts, in the shape `assemble_context`
    takes them — see `prompt._sections` for where each sits relative to the
    cache boundary and why. The blocks are rendered by the module that owns
    the rows, so the tools cannot answer with the same sessions written a
    second way inside the same prompt.

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
    """
    today = datetime.now(timezone.utc).date()
    episodes = await recent_episodes(db, SOLE_LEARNER_ID,
                                     limit=RECENT_SESSION_COUNT)
    # The backstop: when the latest quiet window has no summary yet —
    # extraction pending, failed, or quarantined — its raw transcript tail
    # stands in as the newest card, so recall never depends on a background
    # job having run.
    tail = await backstop_tail(db, SOLE_LEARNER_ID, exclude_session=session_id)
    notes = await explicit_notes(db, SOLE_LEARNER_ID)
    return {
        "profile": await current_profile(db, SOLE_LEARNER_ID),
        "learner_state": (await snapshot(db, SOLE_LEARNER_ID)) or None,
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
    return ErrorEvent(message=message, retryable=retryable)


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
    #: chose and pointed at. See `assemble_context`.
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

    @field_validator("reasoning_effort")
    @classmethod
    def _effort_must_be_allowed(cls, value: str) -> str:
        # The other half of the same gap the check above closes. Effort is a
        # multiplier on reasoning tokens, which bill at the output rate, so a
        # device free to name it is a device free to choose the bill. It went
        # unguarded while the model beside it did not.
        if value not in REASONING_EFFORT_ALLOWLIST:
            raise ValueError(
                f"Unknown reasoning effort {value!r}. "
                f"Allowed: {sorted(REASONING_EFFORT_ALLOWLIST)}"
            )
        return value


def get_recorder() -> Recorder:
    """A dependency, not a direct construction.

    Tests must be able to point the recorder at the test branch. If the
    endpoint built it from the module-level session_factory(), an overridden
    db_session would not reach it and the recorder would write to whatever
    DATABASE_URL names — which is the branch holding real sessions.
    """
    settings = get_settings()
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
    """One rendered region, on its way back up to the turn that asked for it."""

    call_id: str
    image_base64: str


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


@router.post("/turn")
async def create_turn(
    body: TurnRequest,
    db: AsyncSession = Depends(db_session),
    recorder: Recorder = Depends(get_recorder),
):
    settings = get_settings()

    if await db.get(Turn, body.turn_id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This turn was already handled.")

    # INERT today: spend_today() sums turns.cost_usd, and nothing in this
    # service ever writes that column, so it is always 0.0 and this check
    # can never trip (see server/README.md, Known limitations). Left in
    # place because the owner accepted that gap knowingly, not because it
    # does anything — MODEL_ALLOWLIST above is today's only real ceiling.
    if await recorder.spend_today() >= settings.daily_spend_cap_usd:
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED, "Daily spend cap reached."
        )

    session = await db.get(Session, body.session_id)
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

    # Loaded before the stream opens, because a missing attachment is a
    # transport-level refusal — the learner's file never made it — rather than
    # something to report mid-turn once they have already seen the tutor start
    # to answer.
    upload_rows = await recorder.load_uploads(
        session_id=body.session_id, ids=body.attachment_ids
    )
    if len(upload_rows) != len(body.attachment_ids):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "One of those attachments is not on this session.",
        )
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
            data=await recorder.blob(row.converted_blob_key or row.blob_key),
        )
        for row in upload_rows
    ]

    # Whether the board differs from the one this session last sent.
    #
    # Computed here rather than left for the model to notice, because it cannot:
    # its context holds a fresh picture *and* a transcript of its own earlier
    # descriptions of an older one, and it will repeat the text. This is the
    # single fact that stops it — see `board.describe`. `None` means "no previous
    # board to compare against", which is a first look, not an unchanged one.
    board_sha = hashlib.sha256(board).hexdigest() if board is not None else None
    previous_sha = (
        await db.execute(
            select(Attachment.sha256)
            .join(Turn, Turn.id == Attachment.turn_id)
            .where(Turn.session_id == body.session_id, Attachment.kind == BOARD_KIND)
            .order_by(Attachment.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    board_changed = None if previous_sha is None else (board_sha != previous_sha)

    # Fetched explicitly rather than through `session.messages`: on an
    # AsyncSession, touching an unloaded relationship attribute after flush()
    # attempts a lazy SELECT outside the greenlet context and raises
    # MissingGreenlet. A plain awaited query has no such trap.
    existing_messages = (
        await db.execute(
            select(Message).where(Message.session_id == session.id).order_by(Message.seq)
        )
    ).scalars().all()

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

    # assemble_context reads only .role and .text, so the pending learner turn
    # joins the history as a plain record rather than a premature ORM object.
    # It joins it at the end, and being last is what makes it the turn rather
    # than more history: `context.split_live_turn` takes the trailing learner
    # message back off and sends it as its own message, so the request is asked
    # rather than quoted. Appending it anywhere else would bury it again.
    messages = list(existing_messages) + [
        PendingMessage(role="learner", text=body.text)
    ]
    next_seq = seq + 1

    logger.info(
        "turn started | turn_id=%s session_id=%s model=%s effort=%s "
        "has_image=%s has_board=%s history=%d",
        body.turn_id, session.id, body.model, body.reasoning_effort,
        image is not None, board is not None, seq,
    )

    async def stream():
        started = time.monotonic()
        ttft_ms: int | None = None
        image_ref = None
        result: TurnResult | None = None
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
        # Always defined, even if assemble_context itself never runs: an
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
        client = _client()

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
            """
            try:
                fetched = await fetch_image(url)
            except ImageFetchError as error:
                return FetchedImage(output=json.dumps({"error": error.reason}))

            ref = await recorder.record_attachment(
                turn_id=body.turn_id, kind=FETCHED_IMAGE_KIND,
                data=fetched.data, content_type=fetched.content_type,
            )
            logger.info(
                "image fetched | turn_id=%s bytes=%d type=%s size=%dx%d",
                body.turn_id, len(fetched.data), fetched.content_type,
                fetched.width, fetched.height,
            )
            return FetchedImage(
                output=json.dumps({
                    "blob_id": ref.key,
                    "width": fetched.width,
                    "height": fetched.height,
                }),
                # The same bytes the blob now holds, handed back so `run_turn`
                # can show them to the model. It is about to place this picture
                # by id and then tell the learner what it shows.
                image=fetched.data,
                content_type=fetched.content_type,
            )

        # Everything that can strand a turn at status="running" — the image
        # write, assembling the prompt, the model call, and persisting the
        # result — lives inside this one try, and the matching `finally`
        # below is the single structural guard that closes it off,
        # regardless of which of those raised, or whether nothing raised at
        # all and the client simply disconnected. A per-branch try/except
        # was tried here twice before and left new holes each time:
        # assemble_context used to run entirely outside this generator
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
                image_ref = await recorder.record_attachment(
                    turn_id=body.turn_id, kind="board_png", data=image,
                    content_type="image/png",
                )

            if board is not None:
                # Recorded for the *next* turn's comparison as much as for the
                # audit trail: `board_changed` above reads exactly this row back.
                # Content-addressed, so a board sent twice unchanged costs one
                # blob, not two.
                await recorder.record_attachment(
                    turn_id=body.turn_id, kind=BOARD_KIND, data=board,
                    content_type="image/png",
                )

            # Read inside the guard, not before the stream opens. These are
            # a handful of round trips to Neon, and a failure in any of them
            # has to fail the turn visibly rather than raise past
            # `create_turn` and leave the row at status="running" forever —
            # the same hole `assemble_context` itself was moved in here to
            # close.
            sections = await _memory_sections(
                db, session_id=session.id, first_turn=first_turn,
            )

            bundle = assemble_context(
                session=session, messages=messages, image_data=image,
                image_region=body.image_region, signal=body.signal, goal=body.goal,
                board_overview=board, board_manifest=body.board_manifest,
                board_scene=body.board_scene,
                board_changed=board_changed,
                uploads=uploads,
                **sections,
            )
            async for event, running in run_turn(
                client=client, model=body.model, effort=body.reasoning_effort,
                bundle=bundle, request_body=request_body, fetch_board=fetch_board,
                fetch_image=fetch_and_record_image,
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
            ):
                result = running
                if ttft_ms is None and event.type == "text_delta":
                    ttft_ms = int((time.monotonic() - started) * 1000)
                yield sse(event)

            if result is not None:
                await recorder.finish_turn(
                    turn_id=body.turn_id, session_id=session.id, next_seq=next_seq,
                    result=result, request_body=request_body,
                    ttft_ms=ttft_ms,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    image_blob_key=image_ref.key if image_ref else None,
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
                logger.info(
                    "turn ok | turn_id=%s %s in=%s cached=%s written=%s "
                    "out=%s reasoning=%s",
                    body.turn_id,
                    " ".join(f"{k}={v}" for k, v in diagnostics().items()),
                    usage.get("input_tokens"), cached, written,
                    usage.get("output_tokens"),
                    (usage.get("output_tokens_details") or {}).get("reasoning_tokens"),
                )
        except APIStatusError as error:
            decision = classify(error.status_code, error.body)
            event = await _fail_turn_and_report(
                recorder, turn_id=body.turn_id, message=_describe_error(error),
                retryable=decision.retry, result=result, request_body=request_body,
                image_blob_key=image_ref.key if image_ref else None,
                diagnostics=diagnostics(),
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
        except Exception as error:
            # A mid-stream failure is never silently retried by us, and an
            # unanticipated exception is treated as a bug in our own code
            # rather than a transient provider hiccup: telling a learner to
            # retry into a bug is worse than telling them plainly it failed.
            # This also now covers a raise from assemble_context and from
            # recorder.finish_turn, neither of which used to be reachable
            # from here.
            event = await _fail_turn_and_report(
                recorder, turn_id=body.turn_id, message=_describe_error(error),
                retryable=False, result=result, request_body=request_body,
                image_blob_key=image_ref.key if image_ref else None,
                diagnostics=diagnostics(),
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
