"""Read-back endpoints for the project owner and for agents debugging a bad
turn, plus the one write the device does make: telling us a session is over.

`/v1/turns/{id}` in particular exists to make a bad turn diagnosable without
touching the database directly: it returns the full trace of `llm_calls`
(exact request and response JSON), `tool_calls`, and `attachments` (with
their blob keys), so someone can reconstruct what the model was told and
what it said.
"""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import require_device_token
from app.config import get_settings
from app.memory.jobs import schedule_session_close
from app.store.blobs import LocalBlobStore
from app.store.db import db_session
from app.store.models import Attachment, LLMCall, Message, Session, ToolCall, Turn

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device_token)])

# Blob keys are always `sha256:<64 lowercase hex chars>` — see
# `store/blobs.py`'s `BlobRef`. Anything else is rejected before it ever
# reaches `LocalBlobStore.get()`, which builds a filesystem path from it.
_BLOB_KEY_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def get_blob_store() -> LocalBlobStore:
    """A dependency, not a direct construction — mirrors `turn.get_recorder`
    so a test can point it at a different root than `BLOB_DIR` if it needs
    to."""
    return LocalBlobStore(get_settings().blob_dir)


def _session_summary(session: Session) -> dict:
    return {
        "id": session.id,
        "model": session.model,
        "reasoning_effort": session.reasoning_effort,
        "plan": session.plan,
        "exercise": session.exercise,
        "started_at": session.started_at,
        "updated_at": session.updated_at,
    }


def _message_dict(message: Message) -> dict:
    return {
        "id": message.id,
        "seq": message.seq,
        "role": message.role,
        "text": message.text,
        "signal": message.signal,
        "created_at": message.created_at,
    }


def _turn_summary(turn: Turn) -> dict:
    return {
        "id": turn.id,
        "session_id": turn.session_id,
        "status": turn.status,
        "model": turn.model,
        "reasoning_effort": turn.reasoning_effort,
        "ttft_ms": turn.ttft_ms,
        "latency_ms": turn.latency_ms,
        "input_tokens": turn.input_tokens,
        "output_tokens": turn.output_tokens,
        "reasoning_tokens": turn.reasoning_tokens,
        "cost_usd": turn.cost_usd,
        "error": turn.error,
        "started_at": turn.started_at,
        "finished_at": turn.finished_at,
    }


def _llm_call_dict(call: LLMCall) -> dict:
    return {
        "id": call.id,
        "seq": call.seq,
        "model": call.model,
        "request": call.request,
        "response": call.response,
        "raw_events_blob": call.raw_events_blob,
        "usage": call.usage,
        "started_at": call.started_at,
        "finished_at": call.finished_at,
    }


def _tool_call_dict(call: ToolCall) -> dict:
    return {
        "id": call.id,
        "llm_call_id": call.llm_call_id,
        "name": call.name,
        "arguments": call.arguments,
        "result": call.result,
        "error": call.error,
        "started_at": call.started_at,
        "finished_at": call.finished_at,
    }


def _attachment_dict(attachment: Attachment) -> dict:
    return {
        "id": attachment.id,
        "turn_id": attachment.turn_id,
        "session_id": attachment.session_id,
        "kind": attachment.kind,
        "blob_key": attachment.blob_key,
        "sha256": attachment.sha256,
        "bytes": attachment.bytes,
        "width": attachment.width,
        "height": attachment.height,
        "content_type": attachment.content_type,
        "created_at": attachment.created_at,
    }


@router.get("/sessions")
async def list_sessions(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(db_session),
):
    rows = (
        await db.execute(
            select(Session)
            .order_by(Session.started_at.desc())
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()
    return {"sessions": [_session_summary(s) for s in rows]}


@router.get("/sessions/{session_id}")
async def get_session(session_id: uuid.UUID, db: AsyncSession = Depends(db_session)):
    session = (
        await db.execute(
            select(Session)
            .where(Session.id == session_id)
            .options(selectinload(Session.messages), selectinload(Session.turns))
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown session.")

    return {
        **_session_summary(session),
        "messages": [
            _message_dict(m) for m in sorted(session.messages, key=lambda m: m.seq)
        ],
        "turns": [
            _turn_summary(t) for t in sorted(session.turns, key=lambda t: t.started_at)
        ],
    }


@router.post("/sessions/{session_id}/close", status_code=status.HTTP_204_NO_CONTENT)
async def close_session(
    session_id: uuid.UUID, db: AsyncSession = Depends(db_session)
):
    """The device saying it has left this session for good.

    Call it on a session switch and on an explicit end. **Never on
    backgrounding.** A close freezes the transcript into an `Episode`, and
    `uq_episodes_session` makes that the only one this session will ever
    get — so a close sent while the learner is coming back drops every turn
    after it, permanently and with nothing recording that it happened. An iPad
    backgrounds constantly and says nothing about whether the learner is done.
    `jobs.sweep_abandoned_sessions` is what covers the sessions that are never
    explicitly left; it needs no help from the device.

    Safe to send twice — `run_session_close` is idempotent, so a device can
    retry a close it is not sure landed rather than tracking whether it
    already sent one.

    Returns before any of the work starts, and deliberately reports nothing
    about it. Extraction is five provider calls; the answer to "did the memory
    write succeed" is minutes away and is not something the device can act on
    in either case. `app/memory/jobs.py` is where a failed one is accounted
    for, and `/health` is where a stuck one shows up.

    404 rather than a silent 204 for a session that does not exist: a device
    with the wrong id would otherwise get the same answer as one that worked,
    and every session it ever closed would go unremembered with nothing
    anywhere saying so.
    """
    if await db.get(Session, session_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown session.")
    await schedule_session_close(session_id)


@router.get("/turns/{turn_id}")
async def get_turn(turn_id: uuid.UUID, db: AsyncSession = Depends(db_session)):
    turn = await db.get(Turn, turn_id)
    if turn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown turn.")

    # Turn has no ORM relationships to these three — each is a plain,
    # explicitly awaited select rather than a lazy-loaded attribute, so
    # there's no MissingGreenlet trap to avoid in the first place.
    llm_calls = (
        await db.execute(
            select(LLMCall).where(LLMCall.turn_id == turn_id).order_by(LLMCall.seq)
        )
    ).scalars().all()
    tool_calls = (
        await db.execute(
            select(ToolCall)
            .where(ToolCall.turn_id == turn_id)
            .order_by(ToolCall.started_at)
        )
    ).scalars().all()
    attachments = (
        await db.execute(
            select(Attachment)
            .where(Attachment.turn_id == turn_id)
            .order_by(Attachment.created_at)
        )
    ).scalars().all()

    return {
        **_turn_summary(turn),
        "llm_calls": [_llm_call_dict(c) for c in llm_calls],
        "tool_calls": [_tool_call_dict(c) for c in tool_calls],
        "attachments": [_attachment_dict(a) for a in attachments],
    }


@router.get("/blobs/{key}")
async def get_blob(
    key: str,
    db: AsyncSession = Depends(db_session),
    blob_store: LocalBlobStore = Depends(get_blob_store),
):
    # A plain `{key}` is correct here: Starlette's default converter matches
    # `[^/]+`, which already includes the colon in `sha256:<hex>` — only `/`
    # is excluded. A `:path` converter was tried here before and is wrong:
    # it widens the match to `.*`, which admits `/` and `..` into `key`, and
    # nothing downstream validated the key's shape before it reached
    # `LocalBlobStore.get()`, which builds a filesystem path from it —
    # `key="../../etc/passwd"` escapes the blob root. The regex check below
    # is what actually closes that: reject on shape, not by trying to
    # sanitise the path.
    if not _BLOB_KEY_RE.fullmatch(key):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown blob.")

    try:
        data = await blob_store.get(key)
    except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown blob.")

    # The blob store itself only knows bytes, not content type, so the
    # content type is recovered from whichever attachment wrote this key.
    # Blobs with no matching attachment (an LLM call's raw_events_blob, for
    # instance) fall back to a generic type rather than guessing wrong.
    #
    # .limit(1) / .first(), not scalar_one_or_none(): blobs are
    # content-addressed and deduplicated on disk, but record_attachment
    # inserts a row per call, so a board that did not change between two
    # turns produces two attachment rows sharing one blob_key — the normal
    # case for a deduplicated store, not an edge case. scalar_one_or_none()
    # raises MultipleResultsFound on exactly that, turning the common case
    # into a 500. Any matching row's content_type is fine; they're all
    # attachments of the same bytes.
    attachment = (
        await db.execute(
            select(Attachment).where(Attachment.blob_key == key).limit(1)
        )
    ).scalars().first()
    content_type = attachment.content_type if attachment else "application/octet-stream"
    return Response(content=data, media_type=content_type)
