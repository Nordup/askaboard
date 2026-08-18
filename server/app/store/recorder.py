from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.attachments.convert import Converted
from app.pricing import realtime_cost_usd, turn_cost_usd
from app.store.blobs import BlobRef, BlobStore
from app.store.models import (
    Attachment, LLMCall, Message, RealtimeUsage, Session, ToolCall, Turn,
)

#: What an uploaded file's *original* bytes are recorded as, in the blob store
#: and in the row that names them — one constant so the two cannot drift. See
#: `Recorder.record_upload` for why it is deliberately not more specific.
ORIGINAL_CONTENT_TYPE = "application/octet-stream"

#: The tutor line a failed turn leaves in `messages`. See `Recorder.fail_turn`
#: for why a failed turn leaves one at all.
REPLY_LOST_TEXT = "[reply lost]"


def _redact_part(part: object, blob_key: str) -> object:
    if isinstance(part, dict) and part.get("type") == "input_image":
        return {**part, "image_url": {"blob": blob_key}}
    return copy.deepcopy(part)


def redact_images(body: dict, blob_key: str) -> dict:
    """Swap inline base64 image data for a blob reference.

    Keeps llm_calls rows small enough to read, and means a board that did not
    change between turns is stored once rather than once per turn.

    Copied part by part rather than with one `deepcopy` of the whole body. The
    images are the largest thing in a turn's request — a board overview, a
    selected region at full detail, and up to five uploads — and deep-copying
    the body first meant duplicating every one of those base64 strings in
    memory purely to overwrite them on the next line. The parts that survive
    are still copied, so the caller's body is left alone either way.
    """
    redacted = dict(body)
    items = body.get("input")
    if not isinstance(items, list):
        return redacted

    rebuilt: list[object] = []
    for item in items:
        content = item.get("content") if isinstance(item, dict) else None
        if not isinstance(content, list):
            rebuilt.append(copy.deepcopy(item))
            continue
        rebuilt.append({
            **item,
            "content": [_redact_part(part, blob_key) for part in content],
        })
    redacted["input"] = rebuilt
    return redacted


def cache_tokens(usage: dict) -> tuple[int | None, int | None]:
    """What the provider read from its prompt cache, and what it wrote to it.

    Two lookups for `cache_write_tokens` because the provider documents the
    field without pinning where it sits: `cached_tokens` is nested under
    `input_tokens_details`, and the write counter is described beside it but
    reported at the top level in some responses. Reading both places is three
    lines; reading one and guessing wrong is a column that is silently always
    NULL, which is the exact failure these columns exist to end.
    """
    details = usage.get("input_tokens_details") or {}
    written = details.get("cache_write_tokens")
    if written is None:
        written = usage.get("cache_write_tokens")
    return details.get("cached_tokens"), written


def _apply_usage(turn: Turn, usage: dict) -> None:
    """Copy one turn's token counts onto its row, and price them.

    Shared by the success and the failure path, which have to record the same
    five numbers: a turn that spent money and then died is exactly the turn
    whose usage matters most. `loop._merge_usage` has already summed the nested
    detail dicts across every round, so these are per-turn totals.

    `cost_usd` is written here because this is the one place both paths pass
    through with the usage in hand — it is the column `spend_today()` sums,
    and pricing it anywhere later would reopen the always-0.0 gap the daily
    cap sat behind. Priced from `turn.model`, the model this turn actually
    ran, not from anything in the request body.
    """
    turn.input_tokens = usage.get("input_tokens")
    turn.output_tokens = usage.get("output_tokens")
    turn.reasoning_tokens = (usage.get("output_tokens_details") or {}).get(
        "reasoning_tokens"
    )
    turn.cached_tokens, turn.cache_write_tokens = cache_tokens(usage)
    turn.cost_usd = turn_cost_usd(turn.model, usage)


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

    @property
    def sessions(self) -> async_sessionmaker[AsyncSession]:
        """The maker this recorder writes through, for a caller that has to
        read.

        A route holds a recorder because the recorder is where the test
        fixtures point the database — overrides are keyed by `get_recorder`,
        and a second factory resolved anywhere else writes to whatever
        DATABASE_URL names. A caller that needs a plain read on the same
        database (`/v1/realtime/calls` loading the standing memory blocks)
        therefore has to borrow this one rather than build its own. Read-only
        by convention: writes belong in the methods below, which is where the
        `async with` discipline is enforced.
        """
        return self._sessionmaker

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
        prompt_preamble: str | None = None,
        prompt_log: dict | None = None,
    ) -> None:
        """Persist a successful turn — and, in the same transaction, the two
        things a successful turn produces that must never land apart from
        the turn record itself:

        - the tutor's own reply, as a `Message(role="tutor")` at `next_seq`,
          so the next turn's log actually contains what the model said
          (without this, `ledger.advance` only ever folds in the learner's
          side of the conversation);
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
        tool_calls = getattr(result, "tool_calls", None) or []

        async with self._sessionmaker() as session:
            session.add(call)
            await session.flush()
            # The turn's tool calls, as rows, so `GET /v1/turns/{id}` and the
            # inspection script can see them without opening the raw events
            # blob. `run_turn` records each call with the answer it received;
            # without this, `tool_calls` was a table only tests wrote to and
            # every real tool use was invisible to the API.
            for tool in tool_calls:
                session.add(ToolCall(
                    turn_id=turn_id,
                    llm_call_id=call.id,
                    name=tool.get("name") or "",
                    arguments=tool.get("arguments"),
                    result={"output": tool.get("result")},
                ))

            turn = await session.get(Turn, turn_id)
            if turn is None:
                raise ValueError(f"finish_turn: no turn found with id {turn_id}")
            turn.status = "ok"
            turn.ttft_ms = ttft_ms
            turn.latency_ms = latency_ms
            _apply_usage(turn, usage)
            turn.finished_at = datetime.now(timezone.utc)

            if result.text:
                session.add(Message(
                    session_id=session_id, seq=next_seq, role="tutor", text=result.text,
                ))

            if result.workspace or prompt_preamble is not None or prompt_log is not None:
                session_row = await session.get(Session, session_id)
                if session_row is not None:
                    if result.workspace:
                        session_row.plan = result.workspace["plan"]
                        session_row.exercise = result.workspace["exercise"]
                    # The prompt this turn actually sent, kept so the next turn
                    # can extend it rather than rebuild it. Written here and
                    # nowhere else, which is what makes a failed turn harmless:
                    # nothing was stored, so the retry re-derives the same head
                    # and the same log from the same rows, and the bytes match.
                    #
                    # A turn that fails *after* its learner message is committed
                    # is the interesting case, and it is safe for a reason worth
                    # naming: the extra message is folded in by the next turn as
                    # more quoted lines on the end of the same block, and
                    # `quoting.quoted` is line-wise, so the shorter rendering is
                    # a byte prefix of the longer one.
                    if prompt_preamble is not None:
                        session_row.prompt_preamble = prompt_preamble
                    if prompt_log is not None:
                        session_row.prompt_log = prompt_log

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

        `tool_calls` rows are written here for exactly that argument, one step
        further along. A turn that spent money and died is the turn whose tool
        calls matter most, and they were the one thing this path dropped: a
        session that downloaded four pictures and then hit a rate limit left
        `SELECT count(*) FROM tool_calls WHERE name='fetch_image'` answering
        zero, all time. Nothing else holds them either — `llm_calls.request` is
        the *first* round's body, so the accumulated `function_call` items never
        reach it, and `raw_events` carries only what the provider sent, never
        what a tool answered. The evidence existed nowhere.

        Written once, however many times this runs. `_fail_turn_and_report`
        swallows a failed write and the handler's `finally` then sees the turn
        still "running" and fails it again, so a second pass is a real path —
        and a second pass that re-filed every tool call would report a turn that
        fetched two pictures as having fetched four.

        A `REPLY_LOST_TEXT` tutor `Message` is written too, in the same
        transaction. The learner's side of a failed turn is already in
        `messages` — the request handler commits it with the turn row before
        any model call — so a failed turn used to leave a one-sided
        transcript: a question with no answer and nothing saying why, which
        every episode window recorded over it then presented to the
        summarizer as the learner talking to silence. The placeholder makes
        the window read as what happened. It is deliberately a marker and not
        the partial text the model may have produced — the partial is in this
        turn's `llm_calls` row for anyone diagnosing, but it was never
        delivered as a reply and recording it as one would put words in the
        tutor's mouth that the next turn's context then treats as said.

        The turn row is where `session_id` and the next `seq` come from, read
        rather than passed so the signature — and every call site in the
        request handler's exception paths — stays as it was.
        """
        call = None
        usage: dict = {}
        tool_calls: list = []
        if result is not None:
            call, usage = await self._build_llm_call(
                turn_id=turn_id, result=result,
                request_body=request_body or {}, image_blob_key=image_blob_key,
            )
            tool_calls = list(getattr(result, "tool_calls", None) or [])

        async with self._sessionmaker() as session:
            if call is not None:
                session.add(call)
                if tool_calls:
                    # Flushed for `call.id`, which the rows below are keyed on —
                    # the same order `finish_turn` writes them in.
                    await session.flush()
                    already = await session.scalar(
                        select(func.count())
                        .select_from(ToolCall)
                        .where(ToolCall.turn_id == turn_id)
                    )
                    if not already:
                        for tool in tool_calls:
                            session.add(ToolCall(
                                turn_id=turn_id,
                                llm_call_id=call.id,
                                name=tool.get("name") or "",
                                arguments=tool.get("arguments"),
                                result={"output": tool.get("result")},
                            ))

            turn = await session.get(Turn, turn_id)
            if turn is None:
                raise ValueError(f"fail_turn: no turn found with id {turn_id}")
            turn.status = "error"
            turn.error = {
                "message": message,
                "retryable": retryable,
                **({"diagnostics": diagnostics} if diagnostics else {}),
            }
            _apply_usage(turn, usage)
            turn.finished_at = datetime.now(timezone.utc)

            last_seq = (await session.execute(
                select(func.max(Message.seq))
                .where(Message.session_id == turn.session_id)
            )).scalar_one()
            session.add(Message(
                session_id=turn.session_id,
                seq=(last_seq if last_seq is not None else -1) + 1,
                role="tutor",
                text=REPLY_LOST_TEXT,
            ))
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

    async def record_realtime_usage(
        self,
        *,
        report_id: uuid.UUID,
        session_id: uuid.UUID | None,
        response_id: str | None,
        model: str,
        audio_input_tokens: int,
        cached_audio_input_tokens: int,
        audio_output_tokens: int,
        text_input_tokens: int,
        cached_text_input_tokens: int,
        text_output_tokens: int,
    ) -> None:
        """One voice response's token counts, priced and written.

        Idempotent twice over, and both keys matter. `report_id` is minted on
        the device, so a blind retry of the same report hits the primary key —
        the same idempotency `Turn.id` gives `/v1/turn`. But one
        `response.done` can also be delivered through two event paths, each
        delivery minting a fresh `report_id`; the unique index on
        `(session_id, response_id)` is what makes *that* bill once. Either
        conflict is swallowed by ON CONFLICT DO NOTHING — nothing to
        reconcile, the row's values are a function of the same usage event —
        so a duplicate report commits clean and the route answers 200.
        """
        statement = pg_insert(RealtimeUsage).values(
            id=report_id, session_id=session_id, response_id=response_id,
            model=model,
            audio_input_tokens=audio_input_tokens,
            cached_audio_input_tokens=cached_audio_input_tokens,
            audio_output_tokens=audio_output_tokens,
            text_input_tokens=text_input_tokens,
            cached_text_input_tokens=cached_text_input_tokens,
            text_output_tokens=text_output_tokens,
            cost_usd=realtime_cost_usd(
                model,
                audio_input_tokens=audio_input_tokens,
                cached_audio_input_tokens=cached_audio_input_tokens,
                audio_output_tokens=audio_output_tokens,
                text_input_tokens=text_input_tokens,
                cached_text_input_tokens=cached_text_input_tokens,
                text_output_tokens=text_output_tokens,
            ),
        ).on_conflict_do_nothing()
        async with self._sessionmaker() as session:
            await session.execute(statement)
            await session.commit()

    async def spend_today(self) -> float:
        """Today's recorded dollars: turns plus voice, since UTC midnight.

        Two sums, one *statement*. Voice rows counted in because the realtime
        path used to record nothing at all — the day this fix was written,
        voice was ~$4.70 of a $7 day and `DAILY_SPEND_CAP_USD` saw none of it.

        One statement rather than two, because this runs on the request path in
        front of every turn and a round trip to Neon costs 262 ms from where
        this server sits. Scalar subqueries rather than a join: the two tables
        share no key to join on, and a cross join would multiply each sum by the
        other table's row count.
        """
        midnight = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        async with self._sessionmaker() as session:
            turns, voice = (await session.execute(
                select(
                    select(func.coalesce(func.sum(Turn.cost_usd), 0.0))
                    .where(Turn.started_at >= midnight)
                    .scalar_subquery(),
                    select(func.coalesce(func.sum(RealtimeUsage.cost_usd), 0.0))
                    .where(RealtimeUsage.created_at >= midnight)
                    .scalar_subquery(),
                )
            )).one()
        return float(turns or 0.0) + float(voice or 0.0)
