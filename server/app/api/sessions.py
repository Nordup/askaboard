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
from pydantic import BaseModel, field_validator
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import require_device_token
from app.config import DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, get_settings
from app.memory.jobs import schedule_session_close
from app.store.blobs import LocalBlobStore
from app.store.db import db_session
from app.store.models import (
    Attachment, Episode, LLMCall, Message, Observation, Session, ToolCall, Turn,
)

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


class TranscriptMessage(BaseModel):
    role: str
    text: str
    signal: str | None = None

    @field_validator("role")
    @classmethod
    def _known_role(cls, value: str) -> str:
        if value not in {"learner", "tutor", "system"}:
            raise ValueError("role must be learner, tutor, or system")
        return value


class TranscriptBody(BaseModel):
    messages: list[TranscriptMessage]


@router.put(
    "/sessions/{session_id}/transcript", status_code=status.HTTP_204_NO_CONTENT
)
async def replace_transcript(
    session_id: uuid.UUID,
    body: TranscriptBody,
    db: AsyncSession = Depends(db_session),
):
    """The device saying: the conversation is now exactly this.

    Sent when the learner edits an earlier message and resends from it. The
    device cuts its thread at that message; this call makes the server's
    `messages` rows match, because `turn.py` assembles every turn's context
    from these rows and not from the request — without this, the tutor would
    keep answering from a tail the learner can no longer see.

    A whole-transcript replace rather than a delete-from-seq, deliberately.
    The two sides drift: a retried turn writes its learner row here twice, so
    a seq or an ordinal computed on the device can point at the wrong row.
    The device's thread is the conversation the learner is actually having,
    so it is the authority, and replacing with it also heals any earlier
    drift. Transcripts are text-only and small.

    Idempotent by shape — a PUT of the same prefix lands the same rows — so
    the device can retry one it is not sure about.

    Only `messages` moves. Turns, attachments and episodes are records of
    what actually happened and are not rewritten by an edit.

    Created on demand, not 404'd — the same rule `/v1/dictation` and
    `/v1/attachments` follow, and for the same reason: the device mints a
    session id locally, so an id the backend has not seen is a new session and
    not a wrong id. This used to 404, and live voice is what exposed it. A
    voice session syncs its transcript as the learner talks, and nothing in
    that loop calls `/v1/turn` — so until the learner typed something, every
    sync 404'd and the spoken conversation existed only on the device. A call
    that ended there took the whole transcript with it.

    The body carries no model or effort, hence the defaults; the next turn
    overwrites both with what the device actually has selected.
    """
    if await db.get(Session, session_id) is None:
        db.add(Session(
            id=session_id,
            model=DEFAULT_MODEL,
            reasoning_effort=DEFAULT_REASONING_EFFORT,
        ))
        try:
            await db.commit()
        except IntegrityError:
            # Two syncs racing on the same brand-new session id — voice sends
            # these on a timer, so the second can start before the first has
            # landed. Whichever loses adopts the row the other wrote. Committed
            # on its own, ahead of the replace below, so this rollback can
            # never undo the message rows.
            await db.rollback()

    await db.execute(delete(Message).where(Message.session_id == session_id))
    for seq, message in enumerate(body.messages):
        db.add(
            Message(
                session_id=session_id,
                seq=seq,
                role=message.role,
                text=message.text,
                signal=message.signal,
            )
        )
    await db.commit()


@router.post("/sessions/{session_id}/close", status_code=status.HTTP_204_NO_CONTENT)
async def close_session(
    session_id: uuid.UUID, db: AsyncSession = Depends(db_session)
):
    """The device saying it has left this session, for now or for good.

    Call it on a session switch and on an explicit end. **Still never on
    backgrounding.** A close freezes the messages the last episode did not
    cover into the session's next `Episode` window — no longer the only one
    the session will ever get, so a close sent while the learner is coming
    back now costs a window split rather than every later turn. But an iPad
    backgrounds constantly and says nothing about whether the learner is
    done, and a close per backgrounding would shred sessions into
    single-exchange windows for nothing. `jobs.sweep_abandoned_sessions` is
    what covers the stretches that are never explicitly left; it needs no
    help from the device.

    Safe to send twice — `run_session_close` is idempotent, so a device can
    retry a close it is not sure landed rather than tracking whether it
    already sent one: a fully covered session yields an empty window and no
    new episode.

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


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: uuid.UUID, db: AsyncSession = Depends(db_session)
):
    """The device saying this session should be forgotten, not remembered.

    `close` freezes a session into an `Episode`; this is the opposite act, and
    it exists because deleting a session on the device used to do nothing
    here — the server closed it anyway (or the sweep did), and the deleted
    session kept appearing in the RECENT SESSIONS block of every later turn.

    What it removes, in one transaction so a retry can never see half of it:

    - every `Episode` window this session produced, which are the rows the
      RECENT SESSIONS block is rendered from — this is the visible fix;
    - the session's own rows (`messages`, `turns`, `llm_calls`, `tool_calls`,
      `attachments`, and the `sessions` row itself). Removing the messages is
      load-bearing, not tidiness: `sweep_abandoned_sessions` selects sessions
      with messages beyond their episodes' coverage, so episodes deleted
      alone would be quietly re-recorded within the half hour.

    What it deliberately keeps: `memory_atoms`, the learner profile, and
    `observations`. Extracted facts and measured mastery are about the
    learner, not the session, and the schema already says a purge costs the
    citation and never the fact (`MemoryAtom.source_session_id` is not a
    foreign key for exactly this reason). Observations lose only their
    `turn_id` back-reference, which is nullable by design. Blobs stay too:
    the store is content-addressed and shared across sessions, so unreferenced
    bytes are a cleanup job's problem, not this request's.

    404 when nothing exists under this id — neither a session nor a leftover
    episode — for the same reason `close` answers 404: a device with the
    wrong id should find out. The device treats delete as fire-and-forget, so
    a 404 for a session that never reached the backend costs a log line and
    nothing else.
    """
    session = await db.get(Session, session_id)
    episode_exists = (await db.execute(
        select(Episode.id).where(Episode.session_id == session_id).limit(1)
    )).scalar_one_or_none() is not None
    if session is None and not episode_exists:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown session.")

    turn_ids = (await db.execute(
        select(Turn.id).where(Turn.session_id == session_id)
    )).scalars().all()

    if turn_ids:
        await db.execute(
            update(Observation)
            .where(Observation.turn_id.in_(turn_ids))
            .values(turn_id=None)
        )
        await db.execute(delete(ToolCall).where(ToolCall.turn_id.in_(turn_ids)))
        await db.execute(delete(LLMCall).where(LLMCall.turn_id.in_(turn_ids)))
        await db.execute(
            delete(Attachment).where(Attachment.turn_id.in_(turn_ids))
        )
    await db.execute(
        delete(Attachment).where(Attachment.session_id == session_id)
    )
    await db.execute(delete(Message).where(Message.session_id == session_id))
    await db.execute(delete(Turn).where(Turn.session_id == session_id))
    await db.execute(delete(Episode).where(Episode.session_id == session_id))
    if session is not None:
        await db.delete(session)
    await db.commit()


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
