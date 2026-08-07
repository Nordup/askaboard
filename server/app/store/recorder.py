from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.store.blobs import BlobRef, BlobStore
from app.store.models import Attachment, LLMCall, Turn


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

    async def finish_turn(
        self,
        *,
        turn_id: uuid.UUID,
        result: Any,
        request_body: dict,
        ttft_ms: int | None,
        latency_ms: int | None,
        image_blob_key: str | None = None,
    ) -> None:
        raw = "\n".join(json.dumps(e) for e in result.raw_events).encode()
        events_ref = await self._blobs.put(raw, "application/jsonl")

        usage = result.usage or {}
        stored_body = (
            redact_images(request_body, image_blob_key) if image_blob_key else request_body
        )

        async with self._sessionmaker() as session:
            session.add(LLMCall(
                turn_id=turn_id, seq=0, model=request_body.get("model", ""),
                request=stored_body,
                response={"id": result.response_id, "text": result.text},
                raw_events_blob=events_ref.key, usage=usage or None,
                finished_at=datetime.now(timezone.utc),
            ))

            turn = await session.get(Turn, turn_id)
            turn.status = "ok"
            turn.ttft_ms = ttft_ms
            turn.latency_ms = latency_ms
            turn.input_tokens = usage.get("input_tokens")
            turn.output_tokens = usage.get("output_tokens")
            turn.reasoning_tokens = (usage.get("output_tokens_details") or {}).get(
                "reasoning_tokens"
            )
            turn.finished_at = datetime.now(timezone.utc)
            await session.commit()

    async def fail_turn(
        self, *, turn_id: uuid.UUID, message: str, retryable: bool
    ) -> None:
        async with self._sessionmaker() as session:
            turn = await session.get(Turn, turn_id)
            turn.status = "error"
            turn.error = {"message": message, "retryable": retryable}
            turn.finished_at = datetime.now(timezone.utc)
            await session.commit()

    async def record_attachment(
        self, *, turn_id: uuid.UUID, kind: str, data: bytes, content_type: str
    ) -> BlobRef:
        ref = await self._blobs.put(data, content_type)
        async with self._sessionmaker() as session:
            session.add(Attachment(
                turn_id=turn_id, kind=kind, blob_key=ref.key, sha256=ref.sha256,
                bytes=ref.bytes, content_type=content_type,
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
