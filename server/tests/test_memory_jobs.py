import logging
import uuid
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import func as sa_func, select

from app.config import EMBEDDING_DIMS, SOLE_LEARNER_ID
from app.memory.jobs import (
    _TASKS, run_extraction_backlog, run_session_close, schedule_session_close,
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

    async def __call__(self, db, learner_id, atoms, *, session_id, turn_ids):
        self.calls.append(list(atoms))
        for atom in atoms:
            db.add(MemoryAtom(
                learner_id=learner_id, text=atom.text, category=atom.category.value,
                embedding=VECTOR, source_session_id=session_id,
                source_turn_ids=turn_ids, stated=atom.stated,
            ))
        await db.flush()


async def _rebuild(db, learner_id) -> str:
    return ""


def _install(monkeypatch, *, digest=None, extract=None, consolidate=None):
    """Point the pipeline at stubs. Returns the three, in that order."""
    digest = digest or _Digest()
    extract = extract or _Extract()
    consolidate = consolidate or _Consolidate()
    monkeypatch.setattr("app.memory.jobs._digest", digest)
    monkeypatch.setattr("app.memory.jobs.extract_atoms", extract)
    monkeypatch.setattr("app.memory.jobs.consolidate", consolidate)
    monkeypatch.setattr("app.memory.jobs.rebuild_profile", _rebuild)
    return digest, extract, consolidate


async def _session_with(db_factory, turns: list[tuple[str, str]], *,
                        started_at: datetime | None = None) -> uuid.UUID:
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
            db.add(Message(session_id=session.id, seq=seq, role=role, text=text))
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
    _, _, consolidate = _install(monkeypatch, extract=_Extract([atom]))
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
    digest, _, _ = _install(monkeypatch)
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
    digest, _, _ = _install(monkeypatch, digest=_Digest(fails=True))
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
    """A backlog retry can run months after the session it is reading."""
    _, extract, _ = _install(monkeypatch)
    session_id = await _session_with(
        db_factory, [("learner", "help with fractions")], started_at=MARCH,
    )

    await run_session_close(session_id, db_factory=db_factory)

    assert extract.dates == [MARCH.date()]


@requires_db
async def test_the_backlog_runs_oldest_first(db_factory, monkeypatch):
    """Out of order, a March session gets to supersede a June one's facts."""
    digest, _, _ = _install(monkeypatch)
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
    digest, _, _ = _install(monkeypatch, digest=_Digest(fails=True))
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
    digest, _, _ = _install(monkeypatch, digest=_Digest(fails=True))
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
