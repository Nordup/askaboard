from __future__ import annotations

import base64
import time
import uuid
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI, APIStatusError
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_device_token
from app.config import get_settings
from app.sse import SSE_HEADERS, format_sse
from app.store.db import db_session, session_factory
from app.store.blobs import LocalBlobStore
from app.store.models import Message, Session, Turn
from app.store.recorder import Recorder
from app.tutor.context import assemble_context
from app.tutor.events import DoneEvent, ErrorEvent, StatusEvent
from app.tutor.loop import run_turn
from app.tutor.retry import classify

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device_token)])


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
    await db.commit()

    # assemble_context reads only .role and .text, so the pending learner turn
    # joins the history as a plain record rather than a premature ORM object.
    messages = list(existing_messages) + [
        PendingMessage(role="learner", text=body.text)
    ]
    bundle = assemble_context(
        session=session, messages=messages, image_data=image,
        image_region=body.image_region, signal=body.signal, goal=body.goal,
    )

    async def stream():
        started = time.monotonic()
        ttft_ms: int | None = None
        image_ref = None

        if image is not None:
            # The service knows an image is attached before the model does, so this
            # status is deterministic rather than translated from a provider event.
            # detail is left unset: image_region already reaches the model through
            # the assembled prompt, and the wire contract for this status is bare.
            yield format_sse(StatusEvent(phase="looking", detail=None))
            image_ref = await recorder.record_attachment(
                turn_id=body.turn_id, kind="board_png", data=image,
                content_type="image/png",
            )

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        result = None
        try:
            async for event, running in run_turn(
                client=client, model=body.model, effort=body.reasoning_effort,
                bundle=bundle,
            ):
                result = running
                if ttft_ms is None and event.type == "text_delta":
                    ttft_ms = int((time.monotonic() - started) * 1000)
                yield format_sse(event)
        except APIStatusError as error:
            decision = classify(error.status_code, error.body)
            await recorder.fail_turn(
                turn_id=body.turn_id, message=str(error), retryable=decision.retry
            )
            yield format_sse(ErrorEvent(message=str(error), retryable=decision.retry))
            return

        if result is not None:
            await recorder.finish_turn(
                turn_id=body.turn_id, result=result, request_body={
                    "model": body.model, "input": bundle.input,
                },
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

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers=SSE_HEADERS)
