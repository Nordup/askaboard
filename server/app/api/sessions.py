"""Read-back endpoints for the project owner and for agents debugging a bad
turn — the iPad app never calls any of these.

`/v1/turns/{id}` in particular exists to make a bad turn diagnosable without
touching the database directly: it returns the full trace of `llm_calls`
(exact request and response JSON), `tool_calls`, and `attachments` (with
their blob keys), so someone can reconstruct what the model was told and
what it said.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import require_device_token
from app.config import get_settings
from app.store.blobs import LocalBlobStore
from app.store.db import db_session
from app.store.models import Attachment, LLMCall, Message, Session, ToolCall, Turn

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device_token)])


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


@router.get("/blobs/{key:path}")
async def get_blob(
    key: str,
    db: AsyncSession = Depends(db_session),
    blob_store: LocalBlobStore = Depends(get_blob_store),
):
    # `:path` (rather than a plain `{key}`) is required because blob keys
    # are of the form `sha256:<hex>` — a plain path parameter stops matching
    # at the colon.
    try:
        data = await blob_store.get(key)
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown blob.")

    # The blob store itself only knows bytes, not content type, so the
    # content type is recovered from whichever attachment wrote this key.
    # Blobs with no matching attachment (an LLM call's raw_events_blob, for
    # instance) fall back to a generic type rather than guessing wrong.
    attachment = (
        await db.execute(select(Attachment).where(Attachment.blob_key == key))
    ).scalar_one_or_none()
    content_type = attachment.content_type if attachment else "application/octet-stream"
    return Response(content=data, media_type=content_type)
