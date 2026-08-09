from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.attachments.convert import Converted
from app.store.blobs import BlobRef, BlobStore
from app.store.models import Attachment, LLMCall, Message, Session, Turn

#: What an uploaded file's *original* bytes are recorded as, in the blob store
#: and in the row that names them — one constant so the two cannot drift. See
#: `Recorder.record_upload` for why it is deliberately not more specific.
ORIGINAL_CONTENT_TYPE = "application/octet-stream"


def redact_images(body: dict, blob_key: str) -> dict:
    """Swap inline base64 image data for a blob reference.

    Keeps llm_calls rows small enough to read, and means a board that did not
    change between turns is stored once rather than once per turn.
    """
    redacted = copy.deepcopy(body)
    for item in redacted.get("input", []):
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and part.get("type") == "input_image":
                part["image_url"] = {"blob": blob_key}
    return redacted


class Recorder:
    """Every method opens its own session and closes it.

    `async with` is not decoration here. These methods run once per turn on a
    long-lived server; a session opened and merely committed is a pooled
    connection never returned, and the pool is exhausted after as many turns as
    it has slots.
    """

    def __init__(
        self, sessionmaker: async_sessionmaker[AsyncSession], blob_store: BlobStore
    ) -> None:
        self._sessionmaker = sessionmaker
        self._blobs = blob_store

    async def _build_llm_call(
        self,
        *,
        turn_id: uuid.UUID,
        result: Any,
        request_body: dict,
        image_blob_key: str | None = None,
    ) -> tuple[LLMCall, dict]:
        """Build (but do not persist) the LLMCall row shared by finish_turn
        and fail_turn, plus its usage dict.

        Deliberately takes no session: the blob write and JSON serialization
        it does are external I/O, not database work, and must finish before
        any pooled connection is checked out — holding one open across a
        blob-store round trip is exactly the leaked-connection failure mode
        this class's own docstring warns about. The caller opens a session
        only after this returns, to add the row and commit.

        Whatever text and raw events the model produced before a turn ends —
        whether it ended cleanly or mid-stream — go through this one path, so
        a failed turn is exactly as diagnosable as a successful one.
        """
        raw = "\n".join(json.dumps(e) for e in result.raw_events).encode()
        events_ref = await self._blobs.put(raw, "application/jsonl")

        usage = result.usage or {}
        stored_body = (
            redact_images(request_body, image_blob_key) if image_blob_key else request_body
        )

        call = LLMCall(
            turn_id=turn_id, seq=0, model=request_body.get("model", ""),
            request=stored_body,
            response={"id": result.response_id, "text": result.text},
            raw_events_blob=events_ref.key, usage=usage or None,
            finished_at=datetime.now(timezone.utc),
        )
        return call, usage

    async def finish_turn(
        self,
        *,
        turn_id: uuid.UUID,
        session_id: uuid.UUID,
        next_seq: int,
        result: Any,
        request_body: dict,
        ttft_ms: int | None,
        latency_ms: int | None,
        image_blob_key: str | None = None,
    ) -> None:
        """Persist a successful turn — and, in the same transaction, the two
        things a successful turn produces that must never land apart from
        the turn record itself:

        - the tutor's own reply, as a `Message(role="tutor")` at `next_seq`,
          so the next turn's transcript actually contains what the model
          said (without this, `assemble_context` only ever sees the
          learner's side of the conversation);
        - `session.plan` / `session.exercise`, when the turn called
          `set_workspace`, so `compose_user_prompt`'s EXERCISE CONTEXT and
          SESSION PLAN sections — and `GET /v1/sessions/{id}` — are ever
          reachable in production instead of permanently NULL.

        Both are conditional on the turn actually having produced them
        (`result.text`, `result.workspace`), but never optional writes done
        separately — they commit alongside `turns.status = "ok"` or not at
        all.
        """
        call, usage = await self._build_llm_call(
            turn_id=turn_id, result=result, request_body=request_body,
            image_blob_key=image_blob_key,
        )

        async with self._sessionmaker() as session:
            session.add(call)

            turn = await session.get(Turn, turn_id)
            if turn is None:
                raise ValueError(f"finish_turn: no turn found with id {turn_id}")
            turn.status = "ok"
            turn.ttft_ms = ttft_ms
            turn.latency_ms = latency_ms
            turn.input_tokens = usage.get("input_tokens")
            turn.output_tokens = usage.get("output_tokens")
            turn.reasoning_tokens = (usage.get("output_tokens_details") or {}).get(
                "reasoning_tokens"
            )
            turn.finished_at = datetime.now(timezone.utc)

            if result.text:
                session.add(Message(
                    session_id=session_id, seq=next_seq, role="tutor", text=result.text,
                ))

            if result.workspace:
                session_row = await session.get(Session, session_id)
                if session_row is not None:
                    session_row.plan = result.workspace["plan"]
                    session_row.exercise = result.workspace["exercise"]

            await session.commit()

    async def turn_status(self, turn_id: uuid.UUID) -> str | None:
        """Read a turn's current status through a brand-new session.

        Used by the request handler's structural `finally` guard to decide
        whether a turn is still "running" after any exit path — success, a
        classified exception whose own handler already failed it, or a
        client disconnect that handler can never catch. A fresh session
        (rather than a borrowed, possibly-stale one) is what makes this an
        honest read of what another connection actually committed.
        """
        async with self._sessionmaker() as session:
            turn = await session.get(Turn, turn_id)
            return turn.status if turn is not None else None

    async def fail_turn(
        self,
        *,
        turn_id: uuid.UUID,
        message: str,
        retryable: bool,
        result: Any | None = None,
        request_body: dict | None = None,
        image_blob_key: str | None = None,
        diagnostics: dict | None = None,
    ) -> None:
        """Record a turn that ended in an error.

        `result` is the TurnResult accumulated up to the point of failure —
        optional because some failures (the idempotency check, the spend cap)
        happen before any model call exists to accumulate one. When it is
        given, the partial raw events and partial text are written the same
        way a successful turn's are: that partial output is exactly what the
        learner already saw on screen, and it is what makes a bad turn
        diagnosable afterwards instead of just a blank error.

        `diagnostics` is how the turn looked from the wire — elapsed, events
        sent, and above all the longest silence. It goes into `turns.error`
        rather than into new columns because it is diagnostic detail attached
        to a failure, not a fact about every turn, and because JSONB means the
        next thing worth recording needs no migration.

        Token counts are written here as well as in `finish_turn`. A turn that
        died after the provider had already billed for its output used to
        record none of them, which is precisely the shape of the failure this
        service exists to make visible: money spent, nothing to show for it,
        and no row saying how much.
        """
        call = None
        usage: dict = {}
        if result is not None:
            call, usage = await self._build_llm_call(
                turn_id=turn_id, result=result,
                request_body=request_body or {}, image_blob_key=image_blob_key,
            )

        async with self._sessionmaker() as session:
            if call is not None:
                session.add(call)

            turn = await session.get(Turn, turn_id)
            if turn is None:
                raise ValueError(f"fail_turn: no turn found with id {turn_id}")
            turn.status = "error"
            turn.error = {
                "message": message,
                "retryable": retryable,
                **({"diagnostics": diagnostics} if diagnostics else {}),
            }
            turn.input_tokens = usage.get("input_tokens")
            turn.output_tokens = usage.get("output_tokens")
            turn.reasoning_tokens = (usage.get("output_tokens_details") or {}).get(
                "reasoning_tokens"
            )
            turn.finished_at = datetime.now(timezone.utc)
            await session.commit()

    async def record_attachment(
        self,
        *,
        kind: str,
        data: bytes,
        content_type: str,
        turn_id: uuid.UUID | None = None,
        session_id: uuid.UUID | None = None,
    ) -> BlobRef:
        """Persist a blob and its row, attached to a turn, a session, or both.

        `turn_id` and `session_id` are both optional so a dictation — which
        happens before any turn_id exists, since that is only minted
        client-side when the student hits Send — can attach its audio to the
        session instead. But an attachment with neither is a row nothing can
        ever find again, so at least one is required; this is the one place
        that invariant is enforced; column nullability alone cannot express
        "at least one of two columns", so it is not an accident that both
        stayed nullable at the schema level.
        """
        if turn_id is None and session_id is None:
            raise ValueError(
                "record_attachment requires turn_id, session_id, or both — "
                "an attachment cannot be written with nothing to attach it to."
            )
        ref = await self._blobs.put(data, content_type)
        async with self._sessionmaker() as session:
            session.add(Attachment(
                turn_id=turn_id, session_id=session_id, kind=kind,
                blob_key=ref.key, sha256=ref.sha256, bytes=ref.bytes,
                content_type=content_type,
            ))
            await session.commit()
        return ref

    async def record_upload(
        self,
        *,
        session_id: uuid.UUID,
        filename: str,
        converted: Converted,
        original: bytes,
    ) -> uuid.UUID:
        """One row for one file the learner attached, holding both blob keys.

        Session-scoped with a null `turn_id`, exactly as a dictation's audio
        is: the upload happens while the learner is still typing, and the turn
        it ends up on does not exist yet. Which turns referred to it is
        recoverable from those turns' own recorded request bodies, which name
        `attachment_ids` verbatim — so there is no second row per turn, and a
        worksheet re-sent three times stays one upload.

        `content_type` describes the blob at `blob_key` and nothing else — the
        same contract `record_attachment` keeps, where the value handed to the
        blob store is the value written to the column. It used to be set to
        `converted.content_type`, so a HEIC photo produced a row claiming
        `image/jpeg`, a `blob_key` holding HEIC, and a blob store entry saying
        `application/octet-stream`: three answers to one question, none of them
        readable as "what did the learner actually send". What the model saw is
        `converted_content_type`, one column over, which is where it belongs.

        The original's own type stays `ORIGINAL_CONTENT_TYPE` because it is not
        known any more precisely: sniffing decides a *rung* (see
        `app.attachments.kinds`), not a media type, and the multipart header
        that claimed one is learner-supplied and deliberately never trusted.
        Unknown, stated honestly, beats a confident wrong answer in the one
        place someone goes looking a year later.
        """
        original_ref = await self._blobs.put(original, ORIGINAL_CONTENT_TYPE)
        converted_bytes = converted.data if converted.data is not None else converted.text.encode()
        converted_ref = await self._blobs.put(converted_bytes, converted.content_type)
        thumbnail_ref = await self._blobs.put(converted.thumbnail, "image/jpeg")

        attachment = Attachment(
            session_id=session_id,
            kind="learner_upload",
            blob_key=original_ref.key,
            sha256=original_ref.sha256,
            bytes=original_ref.bytes,
            content_type=ORIGINAL_CONTENT_TYPE,
            filename=filename,
            page_count=converted.page_count,
            converted_blob_key=converted_ref.key,
            converted_content_type=converted.content_type,
            thumbnail_blob_key=thumbnail_ref.key,
        )
        async with self._sessionmaker() as session:
            session.add(attachment)
            await session.commit()
            return attachment.id

    async def load_uploads(
        self, *, session_id: uuid.UUID, ids: list[uuid.UUID]
    ) -> list[Attachment]:
        """The named uploads, in the order named, and only this session's.

        The session filter is the whole security property: an attachment id is
        a capability, and the device holding one token must not be able to
        reach another session's files by guessing a uuid. An id that does not
        match is simply absent from the result, which is what lets the caller
        answer with one 400 for "one of these is not yours" without saying
        which.
        """
        if not ids:
            return []
        async with self._sessionmaker() as session:
            rows = (await session.execute(
                select(Attachment).where(
                    Attachment.id.in_(ids),
                    Attachment.session_id == session_id,
                    Attachment.kind == "learner_upload",
                )
            )).scalars().all()
        by_id = {row.id: row for row in rows}
        return [by_id[wanted] for wanted in ids if wanted in by_id]

    async def blob(self, key: str) -> bytes:
        """Read a stored blob back. The store is the same one `put` writes to."""
        return await self._blobs.get(key)

    async def spend_today(self) -> float:
        midnight = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        async with self._sessionmaker() as session:
            total = await session.scalar(
                select(func.coalesce(func.sum(Turn.cost_usd), 0.0)).where(
                    Turn.started_at >= midnight
                )
            )
        return float(total or 0.0)
