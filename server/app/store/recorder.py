from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.store.blobs import BlobRef, BlobStore
from app.store.models import Attachment, LLMCall, Message, Session, Turn


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
    ) -> None:
        """Record a turn that ended in an error.

        `result` is the TurnResult accumulated up to the point of failure —
        optional because some failures (the idempotency check, the spend cap)
        happen before any model call exists to accumulate one. When it is
        given, the partial raw events and partial text are written the same
        way a successful turn's are: that partial output is exactly what the
        learner already saw on screen, and it is what makes a bad turn
        diagnosable afterwards instead of just a blank error.
        """
        call = None
        if result is not None:
            call, _ = await self._build_llm_call(
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
            turn.error = {"message": message, "retryable": retryable}
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
