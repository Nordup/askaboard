import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.config import SOLE_LEARNER_ID
from app.store.models import Episode, Learner, LearnerProfile, MemoryAtom, Session
from tests.conftest import requires_db


async def _sole_learner(db) -> Learner:
    """The one learner every memory row hangs off.

    Migration 0003 seeds this row; the test schema is built straight from the
    metadata (see conftest.db_factory) and so has no seed, which is why every
    test here inserts it explicitly.
    """
    learner = Learner(id=SOLE_LEARNER_ID, display_name="me")
    db.add(learner)
    await db.flush()
    return learner


@requires_db
async def test_atom_defaults_to_currently_valid(db):
    await _sole_learner(db)

    atom = MemoryAtom(
        learner_id=SOLE_LEARNER_ID,
        text="Prefers seeing geometric intuition before algebra.",
        category="preference",
        source_session_id=None,
        source_turn_ids=[],
    )
    db.add(atom)
    await db.commit()

    live = (await db.execute(
        select(MemoryAtom).where(MemoryAtom.valid_to.is_(None))
    )).scalars().all()
    assert len(live) == 1
    assert live[0].superseded_by is None
    assert live[0].valid_from is not None
    # `stated` is what separates "she told me" from "I inferred it", and an
    # atom that arrives without an opinion is treated as stated so that a
    # missing flag can never quietly downgrade something the learner said.
    assert live[0].stated is True


@requires_db
async def test_superseding_an_atom_leaves_the_old_one_readable(db):
    """Supersession closes a row's validity window; it never rewrites it.

    This is the whole reason for four timestamps. After the update the old
    text is still there, still attributable, and still carries the window in
    which it was true — which is what makes "struggled in March, fluent in
    June" a trajectory the tutor can read rather than a fact that silently
    changed underneath it.
    """
    await _sole_learner(db)

    old = MemoryAtom(
        learner_id=SOLE_LEARNER_ID,
        text="Guesses when negative exponents appear.",
        category="misconception",
        source_turn_ids=[],
    )
    db.add(old)
    await db.flush()

    new = MemoryAtom(
        learner_id=SOLE_LEARNER_ID,
        text="Applies negative exponents correctly without prompting.",
        category="skill_state",
        source_turn_ids=[],
    )
    db.add(new)
    await db.flush()

    closed_at = datetime.now(timezone.utc)
    old.valid_to = closed_at
    old.invalidated_at = closed_at
    old.superseded_by = new.id
    await db.commit()

    live = (await db.execute(
        select(MemoryAtom).where(MemoryAtom.valid_to.is_(None))
    )).scalars().all()
    assert [a.id for a in live] == [new.id]

    superseded = await db.get(MemoryAtom, old.id)
    assert superseded.text == "Guesses when negative exponents appear."
    assert superseded.superseded_by == new.id
    assert superseded.valid_to is not None


@requires_db
async def test_episode_records_the_raw_session_and_starts_unextracted(db):
    """`extracted_at` is the extraction backlog, so a fresh episode is NULL."""
    await _sole_learner(db)

    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()

    started = datetime.now(timezone.utc) - timedelta(minutes=20)
    db.add(
        Episode(
            learner_id=SOLE_LEARNER_ID,
            session_id=session.id,
            transcript="learner: what is a fraction\ntutor: a piece of a whole\n",
            message_count=2,
            started_at=started,
        )
    )
    await db.commit()

    stored = (await db.execute(select(Episode))).scalar_one()
    assert stored.session_id == session.id
    assert stored.digest is None
    assert stored.extracted_at is None
    assert stored.closed_at is not None


@requires_db
async def test_atom_keeps_the_turns_it_came_from(db):
    """Provenance is an array of turn ids, not prose, so a claim in the
    profile can be traced back to the exact turns that produced it."""
    await _sole_learner(db)

    turn_ids = [uuid.uuid4(), uuid.uuid4()]
    db.add(
        MemoryAtom(
            learner_id=SOLE_LEARNER_ID,
            text="Wants to be ready for the entrance exam in June.",
            category="goal",
            source_session_id=uuid.uuid4(),
            source_turn_ids=turn_ids,
            stated=True,
        )
    )
    await db.commit()

    stored = (await db.execute(select(MemoryAtom))).scalar_one()
    assert stored.source_turn_ids == turn_ids


@requires_db
async def test_learner_profile_is_one_row_per_learner(db):
    """The profile is a cache of the atoms, keyed by the learner it describes
    — hence the learner id as its own primary key, so a rebuild can only ever
    replace the single row rather than accumulate versions."""
    await _sole_learner(db)

    db.add(
        LearnerProfile(
            learner_id=SOLE_LEARNER_ID,
            body="Prefers geometric intuition first. Working towards a June exam.",
            atom_count=2,
        )
    )
    await db.commit()

    stored = (await db.execute(select(LearnerProfile))).scalar_one()
    assert stored.learner_id == SOLE_LEARNER_ID
    assert stored.atom_count == 2
    assert stored.rebuilt_at is not None
