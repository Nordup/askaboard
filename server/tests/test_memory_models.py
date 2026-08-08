import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import SOLE_LEARNER_ID
from app.store.models import (
    MEMORY_CATEGORIES, Episode, Learner, LearnerProfile, MemoryAtom, Session,
)
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


def _forget_everything(db) -> None:
    """Expire every loaded object so the next read comes back from Postgres.

    The session is built with `expire_on_commit=False` (conftest), so after a
    commit a SELECT returns the identity-mapped instance still holding the
    Python values that were assigned to it. Without this, an assertion about a
    round-tripped column tests the object we just built rather than the
    database — which is exactly the path (asyncpg decoding `uuid[]`, a server
    default that only exists in the DDL) that could actually break.

    Read any attribute you need *before* calling this: refreshing an expired
    attribute needs IO, and outside an awaited query that raises MissingGreenlet.
    """
    db.expire_all()


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
    _forget_everything(db)

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

    old_id, new_id = old.id, new.id
    _forget_everything(db)

    live = (await db.execute(
        select(MemoryAtom).where(MemoryAtom.valid_to.is_(None))
    )).scalars().all()
    assert [a.id for a in live] == [new_id]

    superseded = await db.get(MemoryAtom, old_id)
    assert superseded.text == "Guesses when negative exponents appear."
    assert superseded.superseded_by == new_id
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

    session_id = session.id
    _forget_everything(db)

    stored = (await db.execute(select(Episode))).scalar_one()
    assert stored.session_id == session_id
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
    _forget_everything(db)

    stored = (await db.execute(select(MemoryAtom))).scalar_one()
    # Read back through asyncpg's uuid[] decoding, not out of the identity map.
    assert stored.source_turn_ids == turn_ids
    assert all(isinstance(t, uuid.UUID) for t in stored.source_turn_ids)


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
    _forget_everything(db)

    stored = (await db.execute(select(LearnerProfile))).scalar_one()
    assert stored.learner_id == SOLE_LEARNER_ID
    assert stored.atom_count == 2
    assert stored.rebuilt_at is not None


@requires_db
async def test_one_episode_per_closed_session(db):
    """A session can only be logged once.

    `extracted_at` is per-episode, so a second row for the same session would
    be extracted again and duplicate every atom derived from it. The close path
    leans on this: writing the episode twice has to fail, not silently succeed.
    """
    await _sole_learner(db)

    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()

    for _ in range(2):
        db.add(
            Episode(
                learner_id=SOLE_LEARNER_ID,
                session_id=session.id,
                transcript="learner: hello\n",
                message_count=1,
                started_at=datetime.now(timezone.utc),
            )
        )
    # Matched by name so that some *other* integrity error — a NOT NULL, the
    # learner FK — cannot quietly stand in for the constraint under test.
    with pytest.raises(IntegrityError, match="uq_episodes_session"):
        await db.commit()


@requires_db
async def test_atom_category_must_be_one_of_the_known_six(db):
    """The category vocabulary is enforced by the database, not by the prompt.

    An LLM writes this column. A near-miss like "preferences" would otherwise
    insert cleanly and then match nothing for the rest of the atom's life.
    """
    await _sole_learner(db)

    assert "preferences" not in MEMORY_CATEGORIES
    db.add(
        MemoryAtom(
            learner_id=SOLE_LEARNER_ID,
            text="Likes worked examples.",
            category="preferences",
            source_turn_ids=[],
        )
    )
    with pytest.raises(IntegrityError, match="ck_memory_atoms_category"):
        await db.commit()
