import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.config import SOLE_LEARNER_ID
from app.memory.retrieve import recent_episodes, search_atoms
from app.store.models import Episode, Learner, MemoryAtom
from tests.conftest import requires_db

# ---------------------------------------------------------------------------
# Vectors
#
# Unit basis vectors: any two are either identical (distance 0) or orthogonal
# (distance 1), which is what lets a test say exactly where the dense arm will
# point. Never zeros — cosine distance against a zero vector is NaN, and NaN
# neither orders nor compares, so every dense assertion below would be passing
# over an arm that had quietly stopped ranking anything.
# ---------------------------------------------------------------------------


def _axis(index: int) -> list[float]:
    vector = [0.0] * 1024
    vector[index] = 1.0
    return vector


def _near(tilt: float) -> list[float]:
    """A vector a measured distance from `_axis(0)`, further the bigger the
    tilt, for when a test needs the dense arm's exact ordering and not just
    which rows are in it."""
    vector = _axis(0)
    vector[1] = tilt
    return vector


class _Embedder:
    """Stands in for `embed_texts`, answering with one fixed query vector."""

    def __init__(self, vector: list[float]):
        self.calls: list[list[str]] = []
        self._vector = vector

    async def __call__(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self._vector for _ in texts]


def _install(monkeypatch, vector: list[float]) -> _Embedder:
    embedder = _Embedder(vector)
    monkeypatch.setattr("app.memory.retrieve.embed_texts", embedder)
    return embedder


async def _learner(db, learner_id: uuid.UUID = SOLE_LEARNER_ID) -> None:
    """Migration 0003 seeds the sole learner; the test schema is built from the
    metadata and so has no seed (see `conftest.db_factory`)."""
    db.add(Learner(id=learner_id, display_name="me"))
    await db.flush()


def _atom(text: str, vector: list[float] | None, *,
          learner_id: uuid.UUID = SOLE_LEARNER_ID,
          valid_to: datetime | None = None) -> MemoryAtom:
    return MemoryAtom(learner_id=learner_id, text=text, category="skill_state",
                      source_turn_ids=[], embedding=vector, valid_to=valid_to)


def _episode(closed_at: datetime, *, digest: str | None,
             learner_id: uuid.UUID = SOLE_LEARNER_ID) -> Episode:
    return Episode(learner_id=learner_id, session_id=uuid.uuid4(),
                   transcript="learner: hi\ntutor: hi", digest=digest,
                   message_count=2, started_at=closed_at, closed_at=closed_at)


# ---------------------------------------------------------------------------
# search_atoms: the two arms, and what each one is for
# ---------------------------------------------------------------------------


@requires_db
async def test_an_exact_token_is_found_though_the_vectors_point_elsewhere(db, monkeypatch):
    """The reason there is a sparse arm at all, written so dense-only fails it.

    `3/4` is a single token to the tsvector and a smear to an embedding model,
    so the query vector here is set to *another* atom's exactly: dense retrieval
    does not merely fail to help, it confidently ranks the wrong row first.
    Fusion still has to put the atom containing the token on top of it.
    """
    _install(monkeypatch, _axis(3))  # the geometry atom's own vector
    await _learner(db)
    db.add_all([
        _atom("Reads 3/4 as three minus four.", _axis(7)),
        _atom("Enjoys geometry proofs.", _axis(3)),
        _atom("Studies on Tuesday evenings.", _axis(11)),
    ])
    await db.commit()

    hits = await search_atoms(db, SOLE_LEARNER_ID, "3/4", limit=1)

    assert [hit.text for hit in hits] == ["Reads 3/4 as three minus four."]


@requires_db
async def test_a_paraphrase_is_found_with_no_word_in_common(db, monkeypatch):
    """The other half. Not one stem is shared, so only the dense arm can score it.

    It covers the join as well: with the sparse arm matching nothing at all, a
    fusion that dropped whatever the other arm had missed would answer nothing
    here rather than answering from dense alone.
    """
    _install(monkeypatch, _axis(7))
    await _learner(db)
    db.add_all([
        _atom("Simplifies fractions confidently.", _axis(7)),
        _atom("Enjoys geometry proofs.", _axis(3)),
    ])
    await db.commit()

    hits = await search_atoms(db, SOLE_LEARNER_ID, "reducing a ratio to its lowest terms")

    assert hits[0].text == "Simplifies fractions confidently."


@requires_db
async def test_a_sparse_only_hit_outside_the_dense_pool_still_surfaces(db, monkeypatch):
    """The regime the other tests cannot reach: a store bigger than the pools.

    Every other test here holds two to six atoms, so both pools contain
    everything and a row can only be lost by scoring badly. With `POOL` cut to
    3, the needle sits outside the dense pool entirely and the sparse arm is its
    only route in — and it has to beat two dense rows to be inside `limit=2`.
    This is the test that fails at the weights the plan originally specified
    (see the comment on `POOL`).
    """
    monkeypatch.setattr("app.memory.retrieve.POOL", 3)
    _install(monkeypatch, _axis(0))
    await _learner(db)
    db.add_all([
        _atom("Reads 3/4 as three minus four.", _axis(50)),
        _atom("Enjoys geometry proofs.", _near(0.1)),
        _atom("Studies on Tuesday evenings.", _near(0.2)),
        _atom("Prefers worked examples first.", _near(0.3)),
    ])
    await db.commit()

    hits = await search_atoms(db, SOLE_LEARNER_ID, "3/4", limit=2)

    # The needle ties the dense pool's own best row, so which of the two comes
    # first is decided by the id tiebreak and is not what this asserts.
    assert {hit.text for hit in hits} == {"Reads 3/4 as three minus four.",
                                          "Enjoys geometry proofs."}


@requires_db
@pytest.mark.parametrize("query", ["the and of it", "?!", '"', "   the   "])
async def test_a_query_with_no_searchable_words_falls_back_to_dense(db, monkeypatch, query):
    """Every one of these reduces to an empty tsquery — including the lone
    quote, which is the sort of thing `to_tsquery` raises on and a model writing
    the query will eventually send. The fallback is `search_atoms`' documented
    decision; this pins that it returns the whole dense ranking and not nothing.
    """
    _install(monkeypatch, _axis(3))
    await _learner(db)
    db.add_all([
        _atom("Enjoys geometry proofs.", _axis(3)),
        _atom("Studies on Tuesday evenings.", _axis(11)),
    ])
    await db.commit()

    hits = await search_atoms(db, SOLE_LEARNER_ID, query)

    assert [hit.text for hit in hits] == ["Enjoys geometry proofs.",
                                          "Studies on Tuesday evenings."]


@requires_db
async def test_an_empty_query_is_answered_without_a_round_trip(db, monkeypatch):
    """The other half of that decision, and deliberately not the same answer.

    Nothing comes back, and the embeddings endpoint is never called — an empty
    result must not have cost a request.
    """
    embedder = _install(monkeypatch, _axis(3))
    await _learner(db)
    db.add(_atom("Enjoys geometry proofs.", _axis(3)))
    await db.commit()

    assert await search_atoms(db, SOLE_LEARNER_ID, "   ") == []
    assert embedder.calls == []


@requires_db
async def test_superseded_atoms_are_never_returned(db, monkeypatch):
    """A closed fact is not an answer to what is the case now.

    Both rows say the same thing and match the query identically, so this fails
    for an implementation that filters one arm and forgets the other.
    """
    _install(monkeypatch, _axis(7))
    await _learner(db)
    live = _atom("Cannot factor quadratics.", _axis(7))
    db.add_all([live, _atom("Cannot factor quadratics.", _axis(7),
                            valid_to=datetime.now(timezone.utc))])
    await db.commit()
    live_id = live.id

    hits = await search_atoms(db, SOLE_LEARNER_ID, "quadratics")

    assert [hit.id for hit in hits] == [live_id]


@requires_db
async def test_an_atom_with_no_embedding_is_still_findable_by_its_words(db, monkeypatch):
    """Only the dense arm requires an embedding, and this is what that buys.

    Every atom `consolidate` writes has one and it asserts on that, so this is
    the recovery path for a row that arrived by some other route.
    """
    _install(monkeypatch, _axis(7))
    await _learner(db)
    db.add(_atom("Studies on Tuesday evenings.", None))
    await db.commit()

    hits = await search_atoms(db, SOLE_LEARNER_ID, "Tuesday")

    assert [hit.text for hit in hits] == ["Studies on Tuesday evenings."]


@requires_db
async def test_one_learners_atoms_are_invisible_to_another(db, monkeypatch):
    """There is one learner today; the filter is what makes a second one safe."""
    other = uuid.uuid4()
    _install(monkeypatch, _axis(7))
    await _learner(db)
    await _learner(db, other)
    db.add_all([
        _atom("Cannot factor quadratics.", _axis(7)),
        _atom("Cannot factor quadratics.", _axis(7), learner_id=other),
    ])
    await db.commit()

    hits = await search_atoms(db, other, "quadratics")

    assert [hit.learner_id for hit in hits] == [other]


@requires_db
async def test_limit_caps_what_comes_back(db, monkeypatch):
    """Which two, not just how many — the fixture fixes both.

    The query shares no stem with any atom, so the sparse arm is empty and the
    graded tilts decide the order outright.
    """
    _install(monkeypatch, _axis(0))
    await _learner(db)
    db.add_all([_atom(f"Fact {n} about fractions.", _near(n / 10 + 0.1))
                for n in range(5)])
    await db.commit()

    hits = await search_atoms(db, SOLE_LEARNER_ID, "reducing a ratio", limit=2)

    assert [hit.text for hit in hits] == ["Fact 0 about fractions.",
                                          "Fact 1 about fractions."]


# ---------------------------------------------------------------------------
# recent_episodes
# ---------------------------------------------------------------------------


@requires_db
async def test_recent_episodes_are_newest_first_and_capped(db):
    await _learner(db)
    now = datetime.now(timezone.utc)
    for age in range(4):
        db.add(_episode(now - timedelta(days=age), digest=f"Day {age}."))
    await db.commit()

    episodes = await recent_episodes(db, SOLE_LEARNER_ID, limit=2)

    assert [episode.digest for episode in episodes] == ["Day 0.", "Day 1."]


@requires_db
async def test_recent_episodes_skip_the_undigested_and_other_learners(db):
    """An episode is listed once the close path has summarised it, not before.

    The undigested row here is also the newest, so a missing filter shows up as
    the first result rather than as something a reader has to go looking for.
    """
    other = uuid.uuid4()
    await _learner(db)
    await _learner(db, other)
    now = datetime.now(timezone.utc)
    db.add_all([
        _episode(now, digest=None),
        _episode(now - timedelta(minutes=1), digest="Not mine.", learner_id=other),
        _episode(now - timedelta(minutes=2), digest="Mine."),
    ])
    await db.commit()

    episodes = await recent_episodes(db, SOLE_LEARNER_ID)

    assert [episode.digest for episode in episodes] == ["Mine."]
