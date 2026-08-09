import asyncio
import logging
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import func as sa_func, select

from app.config import EMBEDDING_DIMS, SOLE_LEARNER_ID
from app.memory.jobs import (
    STALE_AFTER, _TASKS, _extract_episode, backlog_status,
    run_extraction_backlog, run_session_close, run_startup_drain,
    schedule_session_close, schedule_startup_drain, sweep_abandoned_sessions,
)
from app.memory.schema import ExtractedAtom, MemoryCategory
from app.store.models import Episode, Learner, MemoryAtom, Message, Session
from tests.conftest import requires_db

# Every model call in the pipeline is stubbed. What is under test is the order
# of writes around them — which row exists when a provider raises, and what a
# second run does to rows the first one already wrote — so the calls themselves
# are the one part that can be a constant.

MARCH = datetime(2026, 3, 4, 9, 30, tzinfo=timezone.utc)
JUNE = datetime(2026, 6, 1, 9, 30, tzinfo=timezone.utc)

#: Never all zeros. Cosine distance against a zero vector is NaN, so a row
#: carrying one silently fails every `<=` it is compared through — nothing here
#: ranks today, but a written row outlives the test that wrote it.
VECTOR = [0.1] * EMBEDDING_DIMS


class _Digest:
    """Stands in for `_digest`, recording the transcripts it was handed.

    The order of that list is the order episodes were processed, which is what
    the backlog test reads it for.
    """

    def __init__(self, body: str = "Worked on fractions.", *, fails: bool = False):
        self.calls: list[str] = []
        self._body = body
        self.fails = fails

    async def __call__(self, transcript: str) -> str:
        self.calls.append(transcript)
        if self.fails:
            raise RuntimeError("the provider fell over")
        return self._body


class _Extract:
    """Stands in for `extract_atoms`, recording the date it was told to use."""

    def __init__(self, atoms: list[ExtractedAtom] | None = None):
        self.dates: list[date] = []
        self._atoms = atoms or []

    async def __call__(self, transcript: str, *, session_date: date):
        self.dates.append(session_date)
        return list(self._atoms)


class _Consolidate:
    """Stands in for `consolidate`, writing one row per atom.

    Rows and not just a call count: what a double-extraction costs is measured
    in atoms, and a test that only counted calls would still pass if the second
    pass reached the store by another route.
    """

    def __init__(self):
        self.calls: list[list[ExtractedAtom]] = []
        self.valid_from: list[datetime | None] = []

    async def __call__(self, db, learner_id, atoms, *, session_id, turn_ids,
                       valid_from=None):
        self.calls.append(list(atoms))
        self.valid_from.append(valid_from)
        for atom in atoms:
            row = MemoryAtom(
                learner_id=learner_id, text=atom.text, category=atom.category.value,
                embedding=VECTOR, source_session_id=session_id,
                source_turn_ids=turn_ids, stated=atom.stated,
            )
            if valid_from is not None:
                row.valid_from = valid_from
            db.add(row)
        await db.flush()


class _Rebuild:
    """Stands in for `rebuild_profile`, optionally parking the first caller.

    The gate is what forces the row-lock contention: `rebuild_profile` runs
    inside the write transaction, so a pass held here is a pass holding the
    lock on `episodes`, which is the state a second pass has to arrive into
    for `with_for_update()` to be under test at all.
    """

    def __init__(self, *, gated: bool = False):
        self.calls = 0
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self._gated = gated

    async def __call__(self, db, learner_id) -> str:
        self.calls += 1
        if self._gated:
            self._gated = False
            self.entered.set()
            await self.release.wait()
        return ""


def _install(monkeypatch, *, digest=None, extract=None, consolidate=None,
             rebuild=None):
    """Point the pipeline at stubs. Returns the four, in that order."""
    digest = digest or _Digest()
    extract = extract or _Extract()
    consolidate = consolidate or _Consolidate()
    rebuild = rebuild or _Rebuild()
    monkeypatch.setattr("app.memory.jobs._digest", digest)
    monkeypatch.setattr("app.memory.jobs.extract_atoms", extract)
    monkeypatch.setattr("app.memory.jobs.consolidate", consolidate)
    monkeypatch.setattr("app.memory.jobs.rebuild_profile", rebuild)
    return digest, extract, consolidate, rebuild


async def _session_with(db_factory, turns: list[tuple[str, str]], *,
                        started_at: datetime | None = None,
                        last_message_at: datetime | None = None) -> uuid.UUID:
    """A learner, a session and its messages, committed. Returns the session id.

    Migration 0003 seeds the sole learner; the test schema is built from the
    metadata and so has no seed (see `conftest.db_factory`).
    """
    async with db_factory() as db:
        db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
        session = Session(model="gpt-5.6-luna", reasoning_effort="high",
                          **({"started_at": started_at} if started_at else {}))
        db.add(session)
        await db.flush()
        for seq, (role, text) in enumerate(turns):
            message = Message(session_id=session.id, seq=seq, role=role, text=text)
            if last_message_at is not None:
                message.created_at = last_message_at
            db.add(message)
        await db.commit()
        return session.id


async def _backlog(db_factory, episodes: list[tuple[datetime, str]]) -> None:
    """Unextracted episodes, straight into the table.

    No sessions or messages behind them: extraction reads the episode alone, so
    building the rows the close path would have written is the whole setup.
    """
    async with db_factory() as db:
        db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
        # Flushed before the episodes, not with them. `Episode.learner_id` is a
        # foreign key with no ORM relationship for the unit of work to order by,
        # so a single flush batches all three inserts in add-order-by-table and
        # the episodes reach Postgres before the learner does.
        await db.flush()
        for closed_at, transcript in episodes:
            db.add(Episode(
                learner_id=SOLE_LEARNER_ID, session_id=uuid.uuid4(),
                transcript=transcript, message_count=1,
                started_at=closed_at, closed_at=closed_at,
            ))
        await db.commit()


async def _episodes(db_factory, session_id: uuid.UUID) -> list[Episode]:
    async with db_factory() as db:
        return list((await db.execute(
            select(Episode).where(Episode.session_id == session_id)
        )).scalars().all())


@requires_db
async def test_close_writes_an_episode_and_marks_it_extracted(db_factory, monkeypatch):
    _install(monkeypatch)
    session_id = await _session_with(db_factory, [
        ("learner", "help with fractions"),
        ("tutor", "what do you have so far"),
    ])

    await run_session_close(session_id, db_factory=db_factory)

    episodes = await _episodes(db_factory, session_id)
    assert len(episodes) == 1
    assert episodes[0].digest == "Worked on fractions."
    assert episodes[0].extracted_at is not None
    assert episodes[0].message_count == 2
    # One line a turn, speaker first — the shape `extract_atoms` is documented
    # against, and the shape the atoms will claim to have come from forever.
    assert episodes[0].transcript == (
        "learner: help with fractions\ntutor: what do you have so far"
    )


@requires_db
async def test_close_is_idempotent(db_factory, monkeypatch):
    """A double-schedule must not double a session's contribution to memory.

    Both halves are asserted, because they fail separately: `uq_episodes_session`
    stops the second episode, and the `extracted_at` check stops the second
    extraction of the first one.
    """
    atom = ExtractedAtom(text="Sits Edexcel higher tier in May 2027.",
                         category=MemoryCategory.context, stated=True)
    _, _, consolidate, _ = _install(monkeypatch, extract=_Extract([atom]))
    session_id = await _session_with(db_factory, [("learner", "hi")])

    await run_session_close(session_id, db_factory=db_factory)
    await run_session_close(session_id, db_factory=db_factory)

    async with db_factory() as db:
        episodes = (await db.execute(
            select(sa_func.count()).select_from(Episode)
            .where(Episode.session_id == session_id)
        )).scalar_one()
        atoms = (await db.execute(
            select(sa_func.count()).select_from(MemoryAtom)
        )).scalar_one()
    assert episodes == 1
    assert atoms == 1
    assert len(consolidate.calls) == 1


@requires_db
async def test_a_session_with_nothing_said_is_not_recorded(db_factory, monkeypatch):
    """An episode with an empty transcript would be a permanent backlog entry."""
    digest, _, _, _ = _install(monkeypatch)
    session_id = await _session_with(db_factory, [])

    await run_session_close(session_id, db_factory=db_factory)

    assert await _episodes(db_factory, session_id) == []
    assert digest.calls == []


@requires_db
async def test_a_failed_extraction_leaves_the_episode_retryable(db_factory, monkeypatch):
    """The failure this is really about is losing a session's memory silently.

    The episode is committed before the first provider call precisely so a
    failure after it is a findable row rather than nothing, and the second half
    of this test is the proof that "findable" means "picked up next time".
    """
    digest, _, _, _ = _install(monkeypatch, digest=_Digest(fails=True))
    session_id = await _session_with(db_factory, [("learner", "help with fractions")])

    with pytest.raises(RuntimeError):
        await run_session_close(session_id, db_factory=db_factory)

    episodes = await _episodes(db_factory, session_id)
    assert len(episodes) == 1
    assert episodes[0].extracted_at is None
    assert episodes[0].digest is None

    digest.fails = False
    assert await run_extraction_backlog(db_factory=db_factory) == 1

    episodes = await _episodes(db_factory, session_id)
    assert len(episodes) == 1
    assert episodes[0].extracted_at is not None
    assert episodes[0].digest == "Worked on fractions."


@requires_db
async def test_facts_are_dated_by_the_session_not_by_the_pass(db_factory, monkeypatch):
    """A backlog retry can run months after the session it is reading.

    Both axes, because they are dated separately and only one of them is
    visible in the fact's words: `session_date` reaches the extractor's prompt,
    `valid_from` is the column the bi-temporal store answers "when was this
    true" from — and the one consolidation's own ordering backstop reads.
    """
    atom = ExtractedAtom(text="Sits Edexcel higher tier in May 2027.",
                         category=MemoryCategory.context, stated=True)
    _, extract, consolidate, _ = _install(monkeypatch, extract=_Extract([atom]))
    session_id = await _session_with(
        db_factory, [("learner", "help with fractions")], started_at=MARCH,
    )

    await run_session_close(session_id, db_factory=db_factory)

    assert extract.dates == [MARCH.date()]
    assert consolidate.valid_from == [MARCH]
    async with db_factory() as db:
        stored = (await db.execute(select(MemoryAtom))).scalars().one()
    assert stored.valid_from == MARCH


@requires_db
async def test_the_backlog_runs_oldest_first(db_factory, monkeypatch):
    """Out of order, a March session gets to supersede a June one's facts."""
    digest, _, _, _ = _install(monkeypatch)
    # Written newest first, so passing cannot be an accident of insertion
    # order — `closed_at` has to be what the drain reads.
    await _backlog(db_factory, [(JUNE, "june"), (MARCH, "march")])

    assert await run_extraction_backlog(db_factory=db_factory) == 2

    assert digest.calls == ["march", "june"]


@requires_db
async def test_a_failure_stops_the_drain_rather_than_stepping_over_it(
    db_factory, monkeypatch,
):
    """The episode behind a failed one must stay unread, not jump the queue."""
    digest, _, _, _ = _install(monkeypatch, digest=_Digest(fails=True))
    await _backlog(db_factory, [(MARCH, "march"), (JUNE, "june")])

    with pytest.raises(RuntimeError):
        await run_extraction_backlog(db_factory=db_factory)

    assert digest.calls == ["march"]
    async with db_factory() as db:
        unread = (await db.execute(
            select(sa_func.count()).select_from(Episode)
            .where(Episode.extracted_at.is_(None))
        )).scalar_one()
    assert unread == 2


@requires_db
async def test_close_reads_the_session_only_once(db_factory, monkeypatch):
    """Extraction works from the episode, so a purged session costs nothing.

    The transcript is frozen at close time on purpose — deleting the messages
    afterwards must leave the memory that was derived from them intact and
    still extractable.
    """
    digest, _, _, _ = _install(monkeypatch, digest=_Digest(fails=True))
    session_id = await _session_with(db_factory, [("learner", "help with fractions")])
    with pytest.raises(RuntimeError):
        await run_session_close(session_id, db_factory=db_factory)

    async with db_factory() as db:
        for message in (await db.execute(
            select(Message).where(Message.session_id == session_id)
        )).scalars().all():
            await db.delete(message)
        await db.delete(await db.get(Session, session_id))
        await db.commit()

    digest.fails = False
    assert await run_extraction_backlog(db_factory=db_factory) == 1
    assert digest.calls == ["learner: help with fractions"] * 2


@requires_db
async def test_two_closes_of_one_session_cannot_both_record_it(
    db_factory, monkeypatch,
):
    """The `uq_episodes_session` branch, which a sequential retry never reaches.

    Two closes landing together — a session switch and the app going away
    behind it — both see no episode and both insert. One of them has to lose
    on the constraint and stand down rather than going on to extract.
    """
    atom = ExtractedAtom(text="Sits Edexcel higher tier in May 2027.",
                         category=MemoryCategory.context, stated=True)
    _, _, consolidate, _ = _install(monkeypatch, extract=_Extract([atom]))
    session_id = await _session_with(db_factory, [("learner", "hi")])

    await asyncio.gather(
        run_session_close(session_id, db_factory=db_factory),
        run_session_close(session_id, db_factory=db_factory),
    )

    async with db_factory() as db:
        episodes = (await db.execute(
            select(sa_func.count()).select_from(Episode)
        )).scalar_one()
        atoms = (await db.execute(
            select(sa_func.count()).select_from(MemoryAtom)
        )).scalar_one()
    assert (episodes, atoms, len(consolidate.calls)) == (1, 1, 1)


@requires_db
async def test_two_passes_cannot_extract_the_same_episode(db_factory, monkeypatch):
    """The row lock, exercised with a second pass genuinely blocked on it.

    `_extract_episode` directly rather than through `run_session_close`, which
    serialises drains in-process and would keep the two from ever contending —
    the lock is the cross-process backstop and this is the only way to reach
    it. The second pass has already done its own digest and extraction by the
    time it arrives, so what is under test is that it still writes nothing.
    """
    atom = ExtractedAtom(text="Sits Edexcel higher tier in May 2027.",
                         category=MemoryCategory.context, stated=True)
    rebuild = _Rebuild(gated=True)
    _, extract, consolidate, _ = _install(
        monkeypatch, extract=_Extract([atom]), rebuild=rebuild,
    )
    await _backlog(db_factory, [(MARCH, "march")])
    async with db_factory() as db:
        episode_id = (await db.execute(select(Episode.id))).scalar_one()

    first = asyncio.create_task(_extract_episode(db_factory, episode_id))
    # The first pass is now inside its write transaction holding the lock.
    await asyncio.wait_for(rebuild.entered.wait(), 30)
    second = asyncio.create_task(_extract_episode(db_factory, episode_id))

    # `_Extract` is the last stub before the locked SELECT, so its second call
    # is the second pass arriving at the lock.
    for _ in range(300):
        if len(extract.dates) == 2:
            break
        await asyncio.sleep(0.1)
    else:
        pytest.fail("the second pass never got as far as the lock")

    # The assertion that separates waiting from skipping. Every other
    # assertion here holds just as well under `skip_locked=True`, which is the
    # behaviour finding 2 was about: a pass that steps over a held episode goes
    # on to extract a newer one, and the ordering guarantee is gone.
    #
    # Expressed as a timeout on the pass finishing, rather than a sleep
    # followed by `not second.done()`. A sleep has to be longer than the
    # non-blocking path takes, and that path is not fast — measured at 2.1s,
    # nearly all of it Neon round trips, which is why the first version of
    # this passed under `skip_locked=True` and proved nothing. Under a
    # blocking lock the wait cannot end at all until the gate below is
    # released, so the margin only has to clear that 2.1s and can be as
    # generous as patience allows.
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(asyncio.shield(second), 8)
    rebuild.release.set()
    assert await asyncio.wait_for(asyncio.gather(first, second), 60) == [True, False]

    async with db_factory() as db:
        atoms = (await db.execute(
            select(sa_func.count()).select_from(MemoryAtom)
        )).scalar_one()
    assert atoms == 1
    assert len(consolidate.calls) == 1


@requires_db
async def test_the_sweep_closes_a_session_nobody_came_back_to(
    db_factory, monkeypatch,
):
    """Backgrounding no longer closes a session, so abandonment needs an answer.

    `closed_at` is the last message and not now: the drain orders by it, and it
    is what the tutor is shown as the session's date.
    """
    _install(monkeypatch)
    silent_since = datetime.now(timezone.utc) - STALE_AFTER - timedelta(minutes=1)
    session_id = await _session_with(
        db_factory, [("learner", "help with fractions")],
        last_message_at=silent_since,
    )

    assert await sweep_abandoned_sessions(db_factory=db_factory) == 1

    episodes = await _episodes(db_factory, session_id)
    assert len(episodes) == 1
    assert episodes[0].closed_at == silent_since


@requires_db
async def test_the_sweep_leaves_a_session_still_in_use_alone(db_factory, monkeypatch):
    """The failure this whole threshold exists for: freezing a live session.

    An episode written now is the only one this session will ever get, so
    everything the learner does after coming back would be dropped.
    """
    _install(monkeypatch)
    session_id = await _session_with(
        db_factory, [("learner", "help with fractions")],
        last_message_at=datetime.now(timezone.utc) - STALE_AFTER + timedelta(hours=1),
    )

    assert await sweep_abandoned_sessions(db_factory=db_factory) == 0
    assert await _episodes(db_factory, session_id) == []


@requires_db
async def test_the_sweep_ignores_a_session_already_closed(db_factory, monkeypatch):
    """Otherwise every closed session is swept again on every close."""
    _install(monkeypatch)
    session_id = await _session_with(
        db_factory, [("learner", "help with fractions")],
        last_message_at=datetime.now(timezone.utc) - STALE_AFTER - timedelta(hours=1),
    )
    await run_session_close(session_id, db_factory=db_factory)

    assert await sweep_abandoned_sessions(db_factory=db_factory) == 0
    assert len(await _episodes(db_factory, session_id)) == 1


@requires_db
async def test_a_late_sweep_says_so_rather_than_slipping_in_quietly(
    db_factory, monkeypatch, caplog,
):
    """A session that crashed before an already-extracted one still exists.

    It is recorded — losing a session's memory is worse than reading it late —
    and honestly dated, so the log line is the only thing standing between an
    out-of-order consolidation and nobody knowing one happened.
    """
    _install(monkeypatch)
    session_id = await _session_with(
        db_factory, [("learner", "help with fractions")], last_message_at=MARCH,
    )
    async with db_factory() as db:
        db.add(Episode(
            learner_id=SOLE_LEARNER_ID, session_id=uuid.uuid4(),
            transcript="june", message_count=1, started_at=JUNE, closed_at=JUNE,
            extracted_at=JUNE,
        ))
        await db.commit()

    with caplog.at_level(logging.WARNING, logger="app.memory.jobs"):
        assert await sweep_abandoned_sessions(db_factory=db_factory) == 1

    assert "behind the extraction watermark" in caplog.text
    episodes = await _episodes(db_factory, session_id)
    assert len(episodes) == 1
    assert episodes[0].closed_at == MARCH


@requires_db
async def test_backlog_status_counts_what_is_waiting(db_factory, monkeypatch):
    """A halted drain has no other symptom; this is the one place it surfaces."""
    _install(monkeypatch)
    await _backlog(db_factory, [(MARCH, "march"), (JUNE, "june")])

    status = await backlog_status(db_factory=db_factory)

    assert status["unextracted_episodes"] == 2
    # Aged from the oldest, so a single stuck episode does not look fresher
    # every time a newer one lands behind it.
    assert status["oldest_unextracted_age_seconds"] > 0
    expected = int((datetime.now(timezone.utc) - MARCH).total_seconds())
    assert abs(status["oldest_unextracted_age_seconds"] - expected) < 60

    assert await run_extraction_backlog(db_factory=db_factory) == 2
    assert await backlog_status(db_factory=db_factory) == {
        "unextracted_episodes": 0, "oldest_unextracted_age_seconds": None,
    }


async def test_schedule_never_raises_at_its_caller(monkeypatch, caplog):
    """A device closing a session must not see a memory failure as a 500."""
    async def _boom(session_id):
        raise RuntimeError("no database today")

    monkeypatch.setattr("app.memory.jobs.run_session_close", _boom)
    session_id = uuid.uuid4()

    with caplog.at_level(logging.ERROR, logger="app.memory.jobs"):
        await schedule_session_close(session_id)
        # The set is what holds the only strong reference to the task; awaiting
        # through it is also the assertion that the reference exists at all.
        assert len(_TASKS) == 1
        await next(iter(_TASKS))

    assert str(session_id) in caplog.text


@requires_db
async def test_the_startup_drain_remembers_a_session_no_client_ever_closed(
    db_factory, monkeypatch,
):
    """Boot is the pipeline's only trigger that does not need the device.

    `sweep_abandoned_sessions` is reachable from the close endpoint alone and
    the Swift client never calls it, so before this ran at startup nothing ever
    closed a session and nothing was ever extracted — the whole memory system
    was inert in production while every unit test passed. `STALE_AFTER` is six
    hours, so a restart catches every session that is genuinely over.

    Sweep then drain, in that order: an episode the sweep writes after the
    drain has finished waits for the next boot.
    """
    _install(monkeypatch)
    silent_since = datetime.now(timezone.utc) - STALE_AFTER - timedelta(minutes=1)
    session_id = await _session_with(
        db_factory, [("learner", "help with fractions")],
        last_message_at=silent_since,
    )

    await run_startup_drain(db_factory=db_factory)

    episodes = await _episodes(db_factory, session_id)
    assert len(episodes) == 1
    assert episodes[0].extracted_at is not None
    assert await backlog_status(db_factory=db_factory) == {
        "unextracted_episodes": 0, "oldest_unextracted_age_seconds": None,
    }


@requires_db
async def test_the_startup_drain_retries_an_extraction_that_failed(
    db_factory, monkeypatch,
):
    """Nothing else retries one. A restart is the recovery step.

    `run_extraction_backlog` halts on the first failure rather than stepping
    over it, deliberately — and the only other thing that runs it again is the
    next close, which a client that never closes never sends. So a provider
    blip left an episode unread permanently.
    """
    _install(monkeypatch, digest=_Digest(fails=True))
    await _backlog(db_factory, [(MARCH, "march")])

    with pytest.raises(RuntimeError):
        await run_startup_drain(db_factory=db_factory)
    assert (await backlog_status(db_factory=db_factory))["unextracted_episodes"] == 1

    _install(monkeypatch)
    await run_startup_drain(db_factory=db_factory)
    assert (await backlog_status(db_factory=db_factory))["unextracted_episodes"] == 0


async def test_the_startup_drain_never_stops_the_app_booting(monkeypatch, caplog):
    """A drain is provider calls, and none of them may keep the service down.

    Detached rather than awaited for the same reason: uvicorn accepts no
    connection until the lifespan's startup phase returns, so an awaited drain
    of twenty episodes is a service that answers nothing at all for as long as
    the provider takes.
    """
    async def _boom(*, db_factory=None):
        raise RuntimeError("no database today")

    monkeypatch.setattr("app.memory.jobs.run_startup_drain", _boom)

    with caplog.at_level(logging.ERROR, logger="app.memory.jobs"):
        schedule_startup_drain()
        # The set holds the only strong reference to the task; awaiting through
        # it is also the assertion that the reference exists at all.
        assert len(_TASKS) == 1
        await next(iter(_TASKS))

    assert "startup memory drain failed" in caplog.text
