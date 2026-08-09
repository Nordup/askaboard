"""Turning a finished session into memory, once nobody is waiting.

A session becomes an `Episode` — the transcript, frozen — and that episode
becomes a digest, a set of atoms, and a rebuilt profile. Five provider round
trips end to end, which is the whole reason none of it happens on the request
path.

The recovery story is one nullable column, and the order of writes here is
what makes it work. The episode is committed *before* any model is called,
with `extracted_at` NULL, so the two failures that actually happen — the
provider erroring, and the process going away with the background task still
running — leave a row saying "this session happened and has not been read
yet" instead of leaving nothing at all. `run_extraction_backlog` reads those
rows back, and both a close and a service start run it — so a lost session is
retried by the next of either, rather than by a queue this service does not
have. Startup is the one that matters in practice: the device does not call
the close endpoint, so `run_startup_drain` is very nearly the only trigger the
whole pipeline has.

One episode per session, forever, is the invariant `uq_episodes_session`
enforces — which makes *when* a session is recorded the load-bearing decision
in this file, not just how. Recording it while the learner is still in it
freezes the transcript at that moment and drops everything they do afterwards,
silently and permanently. So a close is only ever taken from a device that has
genuinely left the session, and `sweep_abandoned_sessions` is what covers the
sessions nobody ever leaves on purpose.
"""

import asyncio
import logging
import uuid
import weakref
from collections.abc import Coroutine, Sequence
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from openai import AsyncOpenAI
from sqlalchemy import func as sa_func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import EXTRACTION_MODEL, SOLE_LEARNER_ID, get_settings
from app.memory.consolidate import consolidate
from app.memory.extract import extract_atoms
from app.memory.profile import rebuild_profile
from app.store.db import session_factory
from app.store.models import Episode, Message, Session, Turn

log = logging.getLogger(__name__)

Factory = async_sessionmaker[AsyncSession]

#: How quiet a session has to go before `sweep_abandoned_sessions` closes it
#: for the learner.
#:
#: Deliberately long, because the two ways of being wrong here do not cost the
#: same. Sweeping too late delays a memory by hours. Sweeping too early records
#: the episode mid-session, and `uq_episodes_session` then makes that
#: permanent — every turn after it is dropped with nothing recording that they
#: existed. Six hours is past any plausible within-session pause and still
#: catches the same evening's work.
STALE_AFTER = timedelta(hours=6)

#: How long a turn may sit at status="running" before this file stops believing
#: it.
#:
#: A running turn is the one thing that must stop a close: it means the reply
#: is still being written into `messages`, and `_record_episode` would freeze
#: the transcript without it — permanently, because `uq_episodes_session`
#: allows no second attempt. But "running" is a claim made by a process that
#: can die, and `turn.py`'s close-out only relabels the turns whose generator
#: got to run its `finally`. A hard kill leaves the row saying "running"
#: forever, and a guard that trusted it forever would answer one lost process
#: with a session that can never be remembered.
#:
#: Fifteen minutes is well past a real turn — several tool rounds against a
#: reasoning model, the provider's own ten-minute default behind them — and
#: well short of `STALE_AFTER`, so a session held up by a dead turn is still
#: swept the same day.
TURN_ASSUMED_DEAD_AFTER = timedelta(minutes=15)

#: Ceiling on the write transaction in `_extract_episode`.
#:
#: The transaction holds a row lock on `episodes` and update locks on every
#: atom it supersedes, across three provider calls it does not own the timeouts
#: of — the SDK's own default is ten minutes with two retries behind it. Left
#: unbounded, one wedged provider call parks a pooled Neon connection
#: idle-in-transaction for most of an hour. A timeout here costs nothing that
#: is not already recoverable: the transaction rolls back, `extracted_at` stays
#: NULL, and the next close tries again.
WRITE_TIMEOUT_SECONDS = 180.0

#: `23505`, unique_violation. Named because `IntegrityError` covers every
#: constraint on the table, and the one this code expects is a very specific
#: race — see `_record_episode`.
_UNIQUE_VIOLATION = "23505"

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

#: One drain at a time, per event loop.
#:
#: Two closes seconds apart — a session switch followed by an explicit end —
#: otherwise run two drains over the same backlog concurrently. The row lock in
#: `_extract_episode` stops them double-writing, but only after the loser has
#: already paid for a digest and an extraction it throws away, and nothing
#: stops the two of them taking episodes in interleaved order.
#:
#: **In-process only.** Correctness does not depend on it: the blocking row
#: lock is what actually carries the ordering guarantee, across processes as
#: well as within one. This removes the wasted provider calls, and it does that
#: only for drains sharing this interpreter — a second uvicorn worker would
#: still pay for a digest and an extraction it discards on every overlap. That
#: costs nothing under the single worker this service runs today, and is the
#: thing to remember on the day a second one is added.
#:
#: Keyed by loop rather than a module-level `asyncio.Lock`, because a Lock
#: binds to the loop it first blocks on and raises ever after on any other —
#: which under pytest, where every test gets its own loop, is a failure in
#: whichever test happens to run second. The weak key does not make this
#: self-cleaning in the case that matters: `Lock._get_loop()` runs precisely on
#: the blocking path, so a lock that has ever been contended holds a strong
#: reference to its own key and that entry never expires. One entry, for the
#: process's one loop, which is why it is left alone.
_DRAIN_LOCKS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = (
    weakref.WeakKeyDictionary()
)


def _drain_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _DRAIN_LOCKS.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        _DRAIN_LOCKS[loop] = lock
    return lock


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


async def _running_turn(db: AsyncSession, session_id: uuid.UUID) -> uuid.UUID | None:
    """The id of a turn still plausibly writing into this session, if any.

    "Plausibly" is `TURN_ASSUMED_DEAD_AFTER`, and it is the whole reason this
    is a function rather than one clause. Filtering on `status == "running"`
    alone would let a single crashed process make a session permanently
    unrememberable; filtering on age alone would ignore the state the column
    actually records. Both together say what is meant: a turn that claims to be
    running and started recently enough for the claim to be worth anything.
    """
    return (await db.execute(
        select(Turn.id)
        .where(Turn.session_id == session_id,
               Turn.status == "running",
               Turn.started_at
               > datetime.now(timezone.utc) - TURN_ASSUMED_DEAD_AFTER)
        .limit(1)
    )).scalar_one_or_none()


async def _record_episode(
    factory: Factory, session_id: uuid.UUID, *, closed_at: datetime | None = None,
) -> None:
    """Freeze this session as an episode, if it is not already one.

    Committed on its own, before anything is extracted from it, because this
    is the write that makes every later failure recoverable. It is also the
    only part of the pipeline that reads `sessions` and `messages` at all —
    everything downstream works from the episode, so a session purged after
    close costs the back-reference and not the memory.

    `closed_at` defaults to the column's `now()`, which is the truth when a
    device says it has left. The sweep passes the last message's timestamp
    instead: an abandoned March session noticed in June ended in March, and
    that column is both what the drain orders by and what the tutor is shown
    as the session's date.

    Two things can already have recorded this session: an earlier close (the
    ordinary case) and a concurrent one (the double-schedule). The SELECT
    catches the first cheaply; `uq_episodes_session` catches the second, and
    the loser of that race returns rather than re-reading and extracting, so
    the winner owns the episode outright. Only that violation is treated as
    the race — every other constraint on this table means something has gone
    wrong that a shrug and an INFO line would bury.
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

        # A turn still writing into this session makes the transcript below a
        # moving target, and `uq_episodes_session` means whatever is read here
        # is read once and for all. So the close is declined rather than
        # served: the session keeps no episode, stays eligible, and
        # `sweep_abandoned_sessions` records it whole once the turn is over.
        #
        # The device guards this too (`TutorStore.endSessionOnServer`), but it
        # can only speak for itself — it cannot see a retry, another device, or
        # the moment between its own last event and this service finishing the
        # write. This is the side that knows.
        if (live := await _running_turn(db, session_id)) is not None:
            log.info(
                "close declined for session %s: turn %s is still running; "
                "the sweep will take it", session_id, live,
            )
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

        episode = Episode(
            learner_id=SOLE_LEARNER_ID,
            session_id=session_id,
            transcript=_render(messages),
            message_count=len(messages),
            started_at=session.started_at,
        )
        if closed_at is not None:
            episode.closed_at = closed_at
        db.add(episode)
        try:
            await db.commit()
        except IntegrityError as error:
            await db.rollback()
            code = getattr(error.orig, "sqlstate", None) or getattr(
                error.orig, "pgcode", None
            )
            if code != _UNIQUE_VIOLATION:
                raise
            log.info("session %s was already recorded by a concurrent close",
                     session_id)


async def _extract_episode(factory: Factory, episode_id: uuid.UUID) -> bool:
    """Digest one episode, mine it for facts, and mark it read.

    Three transactions and not one, and the split is the point. The naive
    shape holds a session open across the digest, the extraction, the
    adjudication and the synthesis — five provider calls, seconds each, with a
    pooled Neon connection pinned for all of them and doing nothing. So the
    two calls that need no database at all are made with no session open, and
    what remains is a short read, a gap, and one write transaction.

    That write transaction is single because it has to be: `consolidate` and
    `rebuild_profile` both document that the caller owns the transaction, and
    the atoms, the profile and `extracted_at` are only safe to retry if they
    land together. A crash between them would leave atoms written under an
    unmarked episode, and the retry would write them a second time. Those two
    do make provider calls of their own while the connection is held; that is
    their contract, and `WRITE_TIMEOUT_SECONDS` is what bounds it.

    The re-select takes a row lock, and it *waits* for one already held rather
    than skipping past it. Skipping looks like the cheaper answer and is the
    wrong one: a runner that steps over a locked episode goes on to extract a
    newer one, which is precisely the out-of-order supersession
    `run_extraction_backlog` halts a whole drain to prevent. Waiting costs a
    few seconds and then, under READ COMMITTED, re-evaluates `extracted_at IS
    NULL` against the row the holder committed — so the waiter still cannot
    double-extract, it just cannot jump the queue.
    """
    async with factory() as db:
        episode = await db.get(Episode, episode_id)
        if episode is None or episode.extracted_at is not None:
            return False
        transcript = episode.transcript
        source_session_id = episode.session_id
        # The session's own clock, never the pass's. A backlog retry can run
        # days later, and both of these end up in the permanent record: the
        # date is written into the fact text, and `valid_from` is the "when
        # was this true" axis the store is bi-temporal for. Dating either by
        # when extraction happened to run is a wrong answer that reads exactly
        # like a right one.
        started_at = episode.started_at

    digest = await _digest(transcript)
    atoms = await extract_atoms(transcript, session_date=started_at.date())

    async with asyncio.timeout(WRITE_TIMEOUT_SECONDS):
        async with factory() as db:
            episode = (await db.execute(
                select(Episode)
                .where(Episode.id == episode_id, Episode.extracted_at.is_(None))
                .with_for_update()
            )).scalar_one_or_none()
            if episode is None:
                log.info("episode %s was extracted by another pass", episode_id)
                return False
            episode.digest = digest
            await consolidate(db, SOLE_LEARNER_ID, atoms,
                              session_id=source_session_id, turn_ids=[],
                              valid_from=started_at)
            await rebuild_profile(db, SOLE_LEARNER_ID)
            episode.extracted_at = datetime.now(timezone.utc)
            await db.commit()
    return True


async def sweep_abandoned_sessions(*, db_factory: Factory | None = None) -> int:
    """Record an episode for every session nobody closed. Returns how many.

    The close endpoint is only called when a device has genuinely left a
    session, which leaves one hole: the sessions it never leaves. An app
    killed from the switcher, a crash, an iPad put down and not picked up
    again — none of those produce a close, and without this the session is
    never remembered at all.

    A session is fair game once it has been silent for `STALE_AFTER`. Silence
    is measured from the last message rather than `sessions.updated_at`,
    because that column is touched by anything that writes the row and is not
    a statement about the learner.

    The sweep is the one thing in this file that can add an episode *behind*
    the extraction watermark, and an ordinary sequence gets there: a session
    that dies on Monday afternoon is still too fresh to sweep when Monday
    evening's session is closed and extracted, and by the time Tuesday's close
    sweeps it, a newer episode has already been read. `run_extraction_backlog`
    orders a batch and cannot order across batches, so that one is extracted
    late whatever this does — recording it with a fabricated `closed_at` would
    hide the inversion rather than prevent it, and skipping it would trade a
    mis-ordered session for a lost one. So it is recorded, honestly dated, and
    logged loudly. What actually protects the store is downstream: the atoms
    carry the session's own `valid_from`, and consolidation is shown those
    dates and told not to let an older fact supersede a newer one.
    """
    factory = db_factory or session_factory()
    cutoff = datetime.now(timezone.utc) - STALE_AFTER
    async with factory() as db:
        watermark = (await db.execute(
            select(sa_func.max(Episode.closed_at))
            .where(Episode.extracted_at.is_not(None))
        )).scalar_one()
        last_message = (
            select(
                Message.session_id.label("session_id"),
                sa_func.max(Message.created_at).label("last_at"),
            )
            .group_by(Message.session_id)
            .subquery()
        )
        stale = (await db.execute(
            select(last_message.c.session_id, last_message.c.last_at)
            .outerjoin(Episode, Episode.session_id == last_message.c.session_id)
            .where(Episode.id.is_(None), last_message.c.last_at < cutoff)
            .order_by(last_message.c.last_at)
        )).all()

    for session_id, last_at in stale:
        if watermark is not None and last_at < watermark:
            log.warning(
                "sweeping session %s behind the extraction watermark: it went "
                "quiet at %s, but an episode closed %s has already been "
                "extracted. Its facts will be consolidated after newer ones",
                session_id, last_at, watermark,
            )
        else:
            log.info("sweeping abandoned session %s, silent since %s",
                     session_id, last_at)
        await _record_episode(factory, session_id, closed_at=last_at)
    return len(stale)


async def run_extraction_backlog(*, db_factory: Factory | None = None) -> int:
    """Extract every episode written but never read. Returns how many were.

    Oldest first, and that is a correctness requirement rather than tidiness.
    Consolidation's SUPERSEDE rule is "the learner's state has changed", which
    assumes the facts it is shown are older than the ones it is judging;
    running a March session after a June one hands it that assumption
    backwards and lets March close June's facts.

    Which is also why a failure stops the drain instead of skipping past it.
    Carrying on would extract a newer episode while an older one is still
    unread, and the eventual retry of the older one is then the inversion
    above. The cost of that choice is a poison episode blocking the ones
    behind it until someone looks — which is what `backlog_status` puts on the
    health endpoint, because a halt whose only symptom is a log line is a
    silence, not a signal.
    """
    factory = db_factory or session_factory()
    async with _drain_lock():
        async with factory() as db:
            pending = list((await db.execute(
                select(Episode.id).where(Episode.extracted_at.is_(None))
                # `id` last for the same reason every ordered query in this
                # package carries it: episodes closed in one statement share a
                # `closed_at`, and without a tiebreak their order is the
                # planner's.
                .order_by(Episode.closed_at, Episode.id)
            )).scalars().all())

        extracted = 0
        for done, episode_id in enumerate(pending):
            try:
                if await _extract_episode(factory, episode_id):
                    extracted += 1
            except Exception:
                log.exception(
                    "extraction failed for episode %s; it and the %d behind it "
                    "stay in the backlog", episode_id, len(pending) - done - 1,
                )
                raise
        return extracted


async def backlog_status(*, db_factory: Factory | None = None) -> dict:
    """How much unread memory is waiting, and how long the oldest has waited.

    On the health endpoint because a halted drain has no other symptom. The
    episodes are safe, nothing raises again until the next close, and the only
    account of it is a log line — so without two numbers on a page someone
    already watches, "memory quietly stopped updating in March" is discovered
    by noticing the tutor has gone vague.

    Never raises. Health is asked whether the process is alive, and answering
    "no" because a count could not be read would turn a memory problem into a
    failed liveness probe.
    """
    try:
        factory = db_factory or session_factory()
        async with factory() as db:
            count, oldest = (await db.execute(
                select(sa_func.count(Episode.id), sa_func.min(Episode.closed_at))
                .where(Episode.extracted_at.is_(None))
            )).one()
    except Exception:
        log.exception("could not read the extraction backlog")
        return {"unextracted_episodes": None, "oldest_unextracted_age_seconds": None}
    age = None if oldest is None else int(
        (datetime.now(timezone.utc) - oldest).total_seconds()
    )
    return {"unextracted_episodes": count, "oldest_unextracted_age_seconds": age}


async def run_session_close(
    session_id: uuid.UUID, *, db_factory: Factory | None = None
) -> None:
    """Record this session as an episode, then work off the backlog.

    Idempotent in the way that matters: an already-recorded session is not
    recorded twice, and an already-extracted episode is not extracted twice.
    Every atom is derived from an episode, so a double-extraction would double
    a session's contribution to the learner's permanent record — which is what
    `uq_episodes_session` and the `extracted_at` check are both for.

    It sweeps and drains rather than handling only the session it was given
    because that is where the retry lives: there is no queue and no cron here,
    so an episode that failed to extract, or a session nobody ever closed, is
    picked up by whichever close happens next. Draining also keeps the
    ordering `run_extraction_backlog` describes — extracting this session
    alone, while an older one sat unread, is exactly the inversion that
    function exists to avoid.
    """
    factory = db_factory or session_factory()
    await _record_episode(factory, session_id)
    await sweep_abandoned_sessions(db_factory=factory)
    await run_extraction_backlog(db_factory=factory)


async def run_startup_drain(*, db_factory: Factory | None = None) -> None:
    """Sweep, then extract, once at boot. Returns nothing; logs what it did.

    This is the whole pipeline's trigger of last resort, and today it is very
    nearly the only one. `sweep_abandoned_sessions` is reachable from the close
    endpoint alone and the device never calls it, so without this nothing ever
    closes a session and the store stays empty forever. `STALE_AFTER` is six
    hours, which catches every session that is genuinely over — so a restart
    is enough to make the whole thing work with no client change at all.

    It also closes the hole that nothing anywhere retries a failed extraction.
    `run_extraction_backlog` halts the drain on the first failure, deliberately,
    and the only thing that runs it again is the next close — which, with no
    client calling close, is never. Running it at boot turns "restart the
    service" into the recovery step, which is the one operators already reach
    for.

    Sweep before drain, in that order and not the other way: the sweep is what
    turns quiet sessions into episodes, and an episode written after the drain
    has finished waits for the next boot.
    """
    factory = db_factory or session_factory()
    swept = await sweep_abandoned_sessions(db_factory=factory)
    extracted = await run_extraction_backlog(db_factory=factory)
    log.info("startup memory drain | swept=%d extracted=%d", swept, extracted)


def _spawn(coro: Coroutine[object, object, None], *, description: str) -> asyncio.Task:
    """Run `coro` detached, keeping a strong reference to it, logging failures.

    Both callers need the same three things and get them wrong in the same two
    ways otherwise — see `_TASKS` for why the reference has to be held, and the
    two `schedule_*` docstrings for why swallowing the exception is honest in
    each case rather than in general.
    """
    async def _guarded() -> None:
        try:
            await coro
        except Exception:
            log.exception("%s failed", description)

    task = asyncio.create_task(_guarded())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return task


def schedule_startup_drain() -> None:
    """Fire and forget, from the app's lifespan. Boot never waits on a provider.

    Detached rather than awaited because a backlog is provider calls, five per
    episode, and uvicorn does not accept a connection until the lifespan's
    startup phase returns. Awaiting a drain of twenty episodes would mean a
    service that answers nothing — not `/health`, not a turn — for as long as
    the provider takes. Every failure inside is already recoverable by
    construction: the episodes keep `extracted_at` NULL and the next boot or
    close tries again.
    """
    _spawn(run_startup_drain(), description="startup memory drain")


async def schedule_session_close(session_id: uuid.UUID) -> None:
    """Fire and forget. A device closing a session never waits on extraction.

    The swallowed exception is not a shrug: by the time anything in here can
    fail, the episode is already committed with `extracted_at` NULL, so the
    failure is a row in the backlog and the log line is the account of why it
    is there. That ordering is the whole reason logging and carrying on is
    honest here — it would not be if the failure left nothing behind.
    """
    _spawn(run_session_close(session_id),
           description=f"session close for {session_id}")
