"""Turning a finished session into memory, once nobody is waiting.

A session becomes an `Episode` — the transcript, frozen — and that episode
becomes a digest, a set of atoms, and a rebuilt profile. Four provider round
trips end to end, which is the whole reason none of it happens on the request
path.

The recovery story is one nullable column, and the order of writes here is
what makes it work. The episode is committed *before* any model is called,
with `extracted_at` NULL, so the two failures that actually happen — the
provider erroring, and the process going away with the background task still
running — leave a row saying "this session happened and has not been read
yet" instead of leaving nothing at all. `run_extraction_backlog` reads those
rows back and every close runs it, so a lost session is retried by the next
close rather than by a queue this service does not have.
"""

import asyncio
import logging
import uuid
from collections.abc import Sequence
from datetime import datetime, timezone
from functools import lru_cache

from openai import AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import EXTRACTION_MODEL, SOLE_LEARNER_ID, get_settings
from app.memory.consolidate import consolidate
from app.memory.extract import extract_atoms
from app.memory.profile import rebuild_profile
from app.store.db import session_factory
from app.store.models import Episode, Message, Session

log = logging.getLogger(__name__)

Factory = async_sessionmaker[AsyncSession]

#: Undated on purpose. `dispatch._recent_sessions` prefixes every digest with
#: its episode's `closed_at` when it renders them, so a date in the prose would
#: be a second one for a model to reconcile against the first.
DIGEST_PROMPT = """\
Summarise this maths tutoring session in two or three sentences, for a tutor \
opening the next session. Say what was worked on, what went well, and where \
the learner got stuck. Write plainly, no preamble.

{transcript}"""

#: Strong references to the tasks `schedule_session_close` starts.
#:
#: The event loop keeps only a weak reference to a running task, so one that
#: nothing else names can be collected mid-await and simply stop. Here that
#: would be a session's memory vanishing with no exception raised anywhere —
#: the one failure the `extracted_at` backlog cannot describe, because the row
#: would look exactly like a task that is still working. The done callback is
#: what keeps this set from being a leak.
_TASKS: set[asyncio.Task] = set()


@lru_cache
def _client() -> AsyncOpenAI:
    """The one digest client, built on first use and then kept.

    Cached, and keeping the SDK's default retries, for the reasons
    `app/memory/extract.py` sets out. Its own client rather than that module's
    so neither one's caching decision silently becomes the other's.
    """
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


async def _digest(transcript: str) -> str:
    """Two or three sentences of prose. Raises whatever the provider raised.

    Nothing is caught, for the reason the module docstring gives: a failure has
    to leave `extracted_at` NULL so the next close picks the episode up again.
    A caught error would write an empty digest, and `retrieve.recent_episodes`
    filters on `digest IS NOT NULL` — the episode would be marked done and be
    invisible forever.

    `store=False` for the reason every other model call in this service sets
    it: the body is an entire session's transcript, and retention of that is a
    decision this service makes in its own database rather than one it leaves
    a second, unenumerable copy of on the provider's side.
    """
    response = await _client().responses.create(
        model=EXTRACTION_MODEL,
        input=[{"role": "user",
                "content": DIGEST_PROMPT.format(transcript=transcript)}],
        store=False,
    )
    return response.output_text.strip()


def _render(messages: Sequence[Message]) -> str:
    """The transcript in the shape `extract_atoms` documents: one line a turn,
    each opening with the speaker."""
    return "\n".join(f"{m.role}: {m.text}" for m in messages)


async def _record_episode(factory: Factory, session_id: uuid.UUID) -> None:
    """Freeze this session as an episode, if it is not already one.

    Committed on its own, before anything is extracted from it, because this
    is the write that makes every later failure recoverable. It is also the
    only part of the pipeline that reads `sessions` and `messages` at all —
    everything downstream works from the episode, so a session purged after
    close costs the back-reference and not the memory.

    Two things can already have recorded this session: an earlier close (the
    ordinary case) and a concurrent one (the double-schedule). The SELECT
    catches the first cheaply; `uq_episodes_session` catches the second, and
    the loser of that race returns rather than re-reading and extracting, so
    the winner owns the episode outright.
    """
    async with factory() as db:
        already = (await db.execute(
            select(Episode.id).where(Episode.session_id == session_id)
        )).scalar_one_or_none()
        if already is not None:
            return

        session = await db.get(Session, session_id)
        if session is None:
            log.warning("close asked for unknown session %s", session_id)
            return
        messages = (await db.execute(
            select(Message).where(Message.session_id == session_id)
            .order_by(Message.seq)
        )).scalars().all()
        if not messages:
            # Nothing was said, so there is nothing to be the ground truth of.
            # Deliberately no episode row: an empty one would be a permanent
            # member of the backlog that every close pays a provider call for.
            return

        db.add(Episode(
            learner_id=SOLE_LEARNER_ID,
            session_id=session_id,
            transcript=_render(messages),
            message_count=len(messages),
            started_at=session.started_at,
        ))
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            log.info("session %s was already recorded by a concurrent close",
                     session_id)


async def _extract_episode(factory: Factory, episode_id: uuid.UUID) -> None:
    """Digest one episode, mine it for facts, and mark it read.

    Three transactions and not one, and the split is the point. The naive
    shape holds a session open across the digest, the extraction, the
    adjudication and the synthesis — four provider calls, seconds each, with a
    pooled Neon connection pinned for all of them and doing nothing. So the
    two calls that need no database at all are made with no session open, and
    what remains is a short read, a gap, and one write transaction.

    That write transaction is single because it has to be: `consolidate` and
    `rebuild_profile` both document that the caller owns the transaction, and
    the atoms, the profile and `extracted_at` are only safe to retry if they
    land together. A crash between them would leave atoms written under an
    unmarked episode, and the retry would write them a second time. Those two
    do make provider calls of their own while the connection is held; that is
    their contract and not something this module can unpick from outside.

    The re-select locks, which is what stops two overlapping drains from
    extracting the same episode twice. `SKIP LOCKED` rather than a wait: a
    runner that finds the row taken has nothing useful to do with it, and
    queueing behind the holder would only earn it the `extracted_at IS NOT
    NULL` bail-out a few seconds later.
    """
    async with factory() as db:
        episode = await db.get(Episode, episode_id)
        if episode is None or episode.extracted_at is not None:
            return
        transcript = episode.transcript
        source_session_id = episode.session_id
        # The date the session happened, never today's. A backlog retry can run
        # days later, and `extract_atoms` writes this date into the facts it
        # produces — dating them by the pass rather than by the session is a
        # wrong answer that reads exactly like a right one.
        session_date = episode.started_at.date()

    digest = await _digest(transcript)
    atoms = await extract_atoms(transcript, session_date=session_date)

    async with factory() as db:
        episode = (await db.execute(
            select(Episode)
            .where(Episode.id == episode_id, Episode.extracted_at.is_(None))
            .with_for_update(skip_locked=True)
        )).scalar_one_or_none()
        if episode is None:
            return
        episode.digest = digest
        await consolidate(db, SOLE_LEARNER_ID, atoms,
                          session_id=source_session_id, turn_ids=[])
        await rebuild_profile(db, SOLE_LEARNER_ID)
        episode.extracted_at = datetime.now(timezone.utc)
        await db.commit()


async def run_extraction_backlog(*, db_factory: Factory | None = None) -> int:
    """Extract every episode written but never read. Returns how many.

    Oldest first, and that is a correctness requirement rather than tidiness.
    Consolidation's SUPERSEDE rule is "the learner's state has changed", which
    assumes the facts it is shown are older than the ones it is judging;
    running a March session after a June one hands it that assumption
    backwards and lets March close June's facts.

    Which is also why a failure stops the drain instead of skipping past it.
    Carrying on would extract a newer episode while an older one is still
    unread, and the eventual retry of the older one is then the inversion
    above. The cost of that choice is a poison episode blocking the ones
    behind it until someone looks — visible in the logs, and preferable to a
    silently mis-ordered store.
    """
    factory = db_factory or session_factory()
    async with factory() as db:
        pending = list((await db.execute(
            select(Episode.id).where(Episode.extracted_at.is_(None))
            # `id` last for the same reason every ordered query in this package
            # carries it: episodes closed in the same transaction share a
            # `closed_at`, and without a tiebreak their order is the planner's.
            .order_by(Episode.closed_at, Episode.id)
        )).scalars().all())

    for done, episode_id in enumerate(pending):
        try:
            await _extract_episode(factory, episode_id)
        except Exception:
            log.exception(
                "extraction failed for episode %s; it and the %d behind it stay "
                "in the backlog", episode_id, len(pending) - done - 1,
            )
            raise
    return len(pending)


async def run_session_close(
    session_id: uuid.UUID, *, db_factory: Factory | None = None
) -> None:
    """Record this session as an episode, then work off the backlog.

    Idempotent in the way that matters: an already-recorded session is not
    recorded twice, and an already-extracted episode is not extracted twice.
    Every atom is derived from an episode, so a double-extraction would double
    a session's contribution to the learner's permanent record — which is what
    `uq_episodes_session` and the `extracted_at` check are both for.

    It drains the whole backlog rather than only the session it was given
    because that is where the retry lives: there is no queue and no cron here,
    so an episode that failed to extract is picked up by whichever close
    happens next. Draining also keeps the ordering `run_extraction_backlog`
    describes — extracting this session alone, while an older one sat unread,
    is exactly the inversion that function exists to avoid.
    """
    factory = db_factory or session_factory()
    await _record_episode(factory, session_id)
    await run_extraction_backlog(db_factory=factory)


async def schedule_session_close(session_id: uuid.UUID) -> None:
    """Fire and forget. A device closing a session never waits on extraction.

    The `except` is not a swallow: by the time anything in here can fail, the
    episode is already committed with `extracted_at` NULL, so the failure is a
    row in the backlog and this log line is the account of why it is there.
    That ordering is the whole reason a bare `except Exception: log` is honest
    here — it would not be if the failure left nothing behind.
    """
    async def _run() -> None:
        try:
            await run_session_close(session_id)
        except Exception:
            log.exception("session close failed for %s", session_id)

    task = asyncio.create_task(_run())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
