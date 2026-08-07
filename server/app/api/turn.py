from __future__ import annotations

import base64
import logging
import time
import uuid
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from openai import APIConnectionError, APIStatusError, AsyncOpenAI
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_device_token
from app.config import MODEL_ALLOWLIST, get_settings
from app.sse import SSE_HEADERS, format_sse
from app.store.db import db_session, session_factory
from app.store.blobs import LocalBlobStore
from app.store.models import Message, Session, Turn
from app.store.recorder import Recorder
from app.tutor.context import assemble_context
from app.tutor.events import DoneEvent, ErrorEvent, StatusEvent
from app.tutor.loop import TurnResult, run_turn
from app.tutor.retry import classify

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device_token)])


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
) -> ErrorEvent:
    """Persist the failure, but never let persisting it fail silently.

    fail_turn does real work now — a blob write plus an insert — while
    running inside an except handler, where a second exception is uncaught
    and would leave the turn "running" forever with no ErrorEvent ever
    reaching the client. A learner seeing a clear (if unrecorded) error beats
    a stream that just stops.
    """
    try:
        await recorder.fail_turn(
            turn_id=turn_id, message=message, retryable=retryable,
            result=result, request_body=request_body, image_blob_key=image_blob_key,
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


def get_recorder() -> Recorder:
    """A dependency, not a direct construction.

    Tests must be able to point the recorder at the test branch. If the
    endpoint built it from the module-level session_factory(), an overridden
    db_session would not reach it and the recorder would write to whatever
    DATABASE_URL names — which is the branch holding real sessions.
    """
    settings = get_settings()
    return Recorder(session_factory(), LocalBlobStore(settings.blob_dir))


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

    image = base64.b64decode(body.image_base64) if body.image_base64 else None

    # Fetched explicitly rather than through `session.messages`: on an
    # AsyncSession, touching an unloaded relationship attribute after flush()
    # attempts a lazy SELECT outside the greenlet context and raises
    # MissingGreenlet. A plain awaited query has no such trap.
    existing_messages = (
        await db.execute(
            select(Message).where(Message.session_id == session.id).order_by(Message.seq)
        )
    ).scalars().all()

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
    messages = list(existing_messages) + [
        PendingMessage(role="learner", text=body.text)
    ]
    next_seq = seq + 1

    async def stream():
        started = time.monotonic()
        ttft_ms: int | None = None
        image_ref = None
        result: TurnResult | None = None
        # Always defined, even if assemble_context itself never runs: an
        # except clause (or the finally guard) reached before "input" is
        # filled in must still have something to hand to fail_turn/
        # finish_turn rather than raising NameError on top of the original
        # failure.
        request_body: dict = {"model": body.model, "input": None}
        # max_retries=0: the SDK's own default retry logic (max_retries=2)
        # retries any 429 or 5xx, including a billing 429 — it has no way to
        # tell a billing error from a rate limit. Left at its default, the
        # transport would retry a spend-limit failure before classify() ever
        # saw it, silently defeating "never retry billing" at a layer this
        # code cannot see into.
        client = AsyncOpenAI(api_key=settings.openai_api_key, max_retries=0)

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
                yield format_sse(StatusEvent(phase="looking", detail=None))
                image_ref = await recorder.record_attachment(
                    turn_id=body.turn_id, kind="board_png", data=image,
                    content_type="image/png",
                )

            bundle = assemble_context(
                session=session, messages=messages, image_data=image,
                image_region=body.image_region, signal=body.signal, goal=body.goal,
            )
            request_body["input"] = bundle.input

            async for event, running in run_turn(
                client=client, model=body.model, effort=body.reasoning_effort,
                bundle=bundle,
            ):
                result = running
                if ttft_ms is None and event.type == "text_delta":
                    ttft_ms = int((time.monotonic() - started) * 1000)
                yield format_sse(event)

            if result is not None:
                await recorder.finish_turn(
                    turn_id=body.turn_id, session_id=session.id, next_seq=next_seq,
                    result=result, request_body=request_body,
                    ttft_ms=ttft_ms,
                    latency_ms=int((time.monotonic() - started) * 1000),
                    image_blob_key=image_ref.key if image_ref else None,
                )
                usage = result.usage or {}
                yield format_sse(DoneEvent(
                    turn_id=body.turn_id,
                    input_tokens=usage.get("input_tokens"),
                    output_tokens=usage.get("output_tokens"),
                ))
        except APIStatusError as error:
            decision = classify(error.status_code, error.body)
            event = await _fail_turn_and_report(
                recorder, turn_id=body.turn_id, message=_describe_error(error),
                retryable=decision.retry, result=result, request_body=request_body,
                image_blob_key=image_ref.key if image_ref else None,
            )
            yield format_sse(event)
        except APIConnectionError as error:
            # Covers APITimeoutError too — it subclasses APIConnectionError.
            # Both are transient network failures, not a verdict from the
            # provider, so they are retryable by definition.
            event = await _fail_turn_and_report(
                recorder, turn_id=body.turn_id, message=_describe_error(error),
                retryable=True, result=result, request_body=request_body,
                image_blob_key=image_ref.key if image_ref else None,
            )
            yield format_sse(event)
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
            )
            yield format_sse(event)
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
                )
            # Deliberately not caught anywhere above: re-raising is what
            # tells the ASGI server the connection is really gone, and
            # swallowing a BaseException here would be exactly the kind of
            # silent failure this whole guard exists to prevent.

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers=SSE_HEADERS)
