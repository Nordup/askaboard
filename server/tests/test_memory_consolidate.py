import json
import pathlib
import uuid
from functools import lru_cache

import pytest
from sqlalchemy import select

from app.config import EMBEDDING_MODEL, EXTRACTION_MODEL, SOLE_LEARNER_ID
from app.memory.consolidate import (
    ADJUDICATION_SCHEMA, FLOOR, ConsolidationResult, _adjudicate, _candidates,
    _decide, _distinct, consolidate,
)
from app.memory.schema import ExtractedAtom, MemoryCategory
from app.store.models import Learner, MemoryAtom
from tests.conftest import requires_db

# ---------------------------------------------------------------------------
# Vectors
#
# Real 1024-float embeddings, not zeros. Zeros would look like the cheaper
# fixture and would quietly disable the thing most of this file is about:
# cosine distance against a zero vector is NaN, so every candidate query would
# return nothing, every adjudication would be short-circuited, and the test for
# "a fact and its negation are ~0.99 similar and must still not be merged"
# would be asserting over an empty candidate list. The tilt below is what makes
# two vectors near-identical-but-distinct the way a sentence and its negation
# are in a real embedding model.
# ---------------------------------------------------------------------------


#: Real vectors from the shipped embedding model, recorded once.
#:
#: Regenerate whenever `config.EMBEDDING_MODEL` or `EMBEDDING_DIMS` changes —
#: the whole value of this fixture is that it is the model's own output, and a
#: stale one asserts about a model that is no longer in use, which is the exact
#: failure `test_a_real_supersession_pair_clears_the_shipped_floor` exists to
#: stop happening a second time.
_REAL_EMBEDDINGS = pathlib.Path(__file__).parent / "fixtures" / "real_embeddings.json"


@lru_cache
def _real_embeddings() -> dict:
    fixture = json.loads(_REAL_EMBEDDINGS.read_text())
    assert fixture["model"] == EMBEDDING_MODEL, (
        f"{_REAL_EMBEDDINGS.name} holds {fixture['model']} vectors but this "
        f"service now embeds with {EMBEDDING_MODEL}. Similarity does not carry "
        "across models — regenerate the fixture and re-check FLOOR against it."
    )
    return fixture


def _near(tilt: float = 0.0) -> list[float]:
    """A unit vector with a small tilt on a second axis.

    Any two of these are ~0.99 cosine similar for tilts in the range used
    here — comfortably inside `FLOOR`, which is the point: they are all
    candidates for one another, so what happens to them is decided by the
    adjudicator and by nothing else.
    """
    vector = [0.0] * 1024
    vector[0] = 1.0
    vector[1] = tilt
    return vector


def _far() -> list[float]:
    """Orthogonal to every `_near` vector: cosine similarity 0, distance 1."""
    vector = [0.0] * 1024
    vector[500] = 1.0
    return vector


def _exact() -> list[float]:
    """A vector whose every non-zero value survives float16 unchanged.

    `MemoryAtom.embedding` is `halfvec`, so 0.1 would come back as 0.0999755
    and an equality assertion on a round trip would be testing float16 rather
    than the round trip. These values are exact in half precision, which lets
    the assertion be `==` against the list that went in.
    """
    vector = [0.0] * 1024
    vector[0] = 1.0
    vector[1] = 0.5
    vector[2] = -0.25
    vector[3] = 0.125
    vector[1023] = -1.0
    return vector


# ---------------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------------


class _Embedder:
    """Stands in for `embed_texts`, keyed by the text so pairing is checkable."""

    def __init__(self, by_text: dict[str, list[float]] | None = None,
                 default: list[float] | None = None):
        self.calls: list[list[str]] = []
        self._by_text = by_text or {}
        self._default = _near() if default is None else default

    async def __call__(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self._by_text.get(text, self._default) for text in texts]


class _Adjudicator:
    """Stands in for `_adjudicate`, recording the two prompt halves it saw."""

    def __init__(self, payload: str):
        self.calls: list[tuple[str, str]] = []
        self._payload = payload

    async def __call__(self, new_facts: str, existing_facts: str) -> str:
        self.calls.append((new_facts, existing_facts))
        return self._payload


async def _explode(*args, **kwargs) -> str:
    raise AssertionError("the adjudicator was called when it should not have been")


class _FakeResponses:
    def __init__(self, recorder, payload: str):
        self._recorder = recorder
        self._payload = payload

    async def create(self, **kwargs):
        self._recorder.append(kwargs)
        return type("R", (), {"output_text": self._payload})()


class _FakeClient:
    def __init__(self, recorder, payload: str = '{"ops": []}'):
        self.responses = _FakeResponses(recorder, payload)


ADD_0 = '{"ops": [{"index": 0, "op": "ADD", "target": null}]}'
NOOP_0 = '{"ops": [{"index": 0, "op": "NOOP", "target": null}]}'


def _atom(text: str, category: MemoryCategory = MemoryCategory.skill_state,
          *, stated: bool = True) -> ExtractedAtom:
    return ExtractedAtom(text=text, category=category, stated=stated)


def _install(monkeypatch, embedder, adjudicator) -> None:
    monkeypatch.setattr("app.memory.consolidate.embed_texts", embedder)
    monkeypatch.setattr("app.memory.consolidate._adjudicate", adjudicator)


async def _sole_learner(db) -> None:
    """Migration 0003 seeds this row; the test schema is built from the
    metadata and so has no seed (see `conftest.db_factory`)."""
    db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
    await db.flush()


async def _live(db) -> list[MemoryAtom]:
    return list((await db.execute(
        select(MemoryAtom).where(MemoryAtom.valid_to.is_(None))
    )).scalars().all())


# ---------------------------------------------------------------------------
# _decide: turning whatever the model said into exactly one op per atom
# ---------------------------------------------------------------------------


def test_decide_parses_operations():
    ops = _decide('{"ops": [{"index": 0, "op": "ADD", "target": null}, '
                  '{"index": 1, "op": "SUPERSEDE", "target": 3}]}', n=2)
    assert ops[0] == ("ADD", None)
    assert ops[1] == ("SUPERSEDE", 3)


def test_decide_defaults_missing_entries_to_add():
    """A model that returns fewer ops than atoms must not silently drop them."""
    ops = _decide('{"ops": [{"index": 0, "op": "NOOP", "target": null}]}', n=3)
    assert len(ops) == 3
    assert ops[1] == ("ADD", None)
    assert ops[2] == ("ADD", None)


def test_decide_rejects_supersede_without_target():
    ops = _decide('{"ops": [{"index": 0, "op": "SUPERSEDE", "target": null}]}', n=1)
    assert ops[0] == ("ADD", None)


def test_decide_ignores_indexes_outside_the_batch():
    """An index naming an atom that is not in this batch names nothing.

    Clamping it into range would apply an operation the model asked for on
    some other fact to whichever atom happened to sit at the end of the list.
    """
    ops = _decide('{"ops": [{"index": 9, "op": "NOOP", "target": null}, '
                  '{"index": -1, "op": "NOOP", "target": null}]}', n=2)
    assert ops == [("ADD", None), ("ADD", None)]


def test_decide_ignores_non_integer_indexes():
    """`"0"` and `true` are both things a model emits and neither is an index.

    `True` is the sharp one: it is an `int` in Python and would address
    position 1, silently reassigning a real atom's operation.
    """
    ops = _decide('{"ops": [{"index": "0", "op": "NOOP", "target": null}, '
                  '{"index": true, "op": "NOOP", "target": null}]}', n=2)
    assert ops == [("ADD", None), ("ADD", None)]


@pytest.mark.parametrize("payload", [
    "not json at all",
    '["ADD", "ADD"]',            # the bare array a model reaches for
    '{"ops": "ADD"}',            # right key, wrong shape
    '{"ops": [null, 7, "ADD"]}',  # entries that are not objects
    # An unhashable `op`. `in` on a set hashes its left operand, so this is a
    # TypeError out of the one function that must not raise.
    '{"ops": [{"index": 0, "op": ["ADD"], "target": null}]}',
    '{"ops": [{"index": 0, "op": null, "target": null}]}',
    "",
])
def test_decide_degrades_to_add_on_anything_malformed(payload):
    """Every unreadable answer means ADD, which writes and destroys nothing.

    A refusal, a truncation, a bare array: none of them is a reason to lose
    the batch, and none of them is licence to close a row on file.
    """
    assert _decide(payload, n=2) == [("ADD", None), ("ADD", None)]


# ---------------------------------------------------------------------------
# _distinct: the batch against itself
# ---------------------------------------------------------------------------


def test_distinct_collapses_repeats_within_one_batch():
    kept, dropped = _distinct([
        _atom("Prefers seeing a diagram first."),
        _atom("  prefers   seeing a DIAGRAM first.  "),
        _atom("Sits the higher paper in June.", MemoryCategory.goal),
    ])
    assert [atom.text for atom in kept] == [
        "Prefers seeing a diagram first.", "Sits the higher paper in June."
    ]
    assert dropped == 1


def test_distinct_keeps_the_same_sentence_filed_two_ways():
    """Category is part of the key, so a second filing is not a duplicate."""
    kept, dropped = _distinct([
        _atom("Still guesses at negative exponents.", MemoryCategory.skill_state),
        _atom("Still guesses at negative exponents.", MemoryCategory.misconception),
    ])
    assert [atom.category for atom in kept] == [
        MemoryCategory.skill_state, MemoryCategory.misconception
    ]
    assert dropped == 0


def test_distinct_keeps_a_negation():
    """The in-batch filter is string identity, and identity cannot see a `not`.

    If this ever collapses to one atom, the batch filter has grown a notion of
    similarity and the whole guarantee of this module is gone.
    """
    kept, dropped = _distinct([
        _atom("Understands how to add fractions with unlike denominators."),
        _atom("Does not understand how to add fractions with unlike denominators."),
    ])
    assert len(kept) == 2
    assert dropped == 0


# ---------------------------------------------------------------------------
# _adjudicate: the request itself
# ---------------------------------------------------------------------------


async def test_adjudicate_asks_for_strict_json_and_stores_nothing(monkeypatch):
    calls = []
    monkeypatch.setattr("app.memory.consolidate._client", lambda: _FakeClient(calls))

    out = await _adjudicate("0. [goal] Sits the higher paper.", "0. [goal] Older goal.")

    assert out == '{"ops": []}'
    assert calls[0]["model"] == EXTRACTION_MODEL
    fmt = calls[0]["text"]["format"]
    assert fmt["type"] == "json_schema"
    # `strict` is what makes the op enum binding rather than advisory, and the
    # schema is passed by identity so a second copy cannot drift from the one
    # `_decide` was written against.
    assert fmt["strict"] is True
    assert fmt["schema"] is ADJUDICATION_SCHEMA
    # A learner's facts go in this body. Retention of them is this service's
    # decision to make in its own database, not a copy left on the provider's
    # side that nothing here can enumerate or delete.
    assert calls[0]["store"] is True
    assert "Sits the higher paper." in calls[0]["input"][0]["content"]
    assert "Older goal." in calls[0]["input"][0]["content"]


async def test_consolidate_no_atoms_does_nothing(monkeypatch):
    """No atoms means no embedding call, no query, no model call.

    `None` for the session is deliberate: if this ever grows a database access
    before the early return, the test fails with an AttributeError rather than
    passing while doing a round trip for an empty list.
    """
    embedder, adjudicator = _Embedder(), _Adjudicator(ADD_0)
    _install(monkeypatch, embedder, adjudicator)

    result = await consolidate(None, SOLE_LEARNER_ID, [], session_id=None, turn_ids=[])

    assert result == ConsolidationResult(0, 0, 0)
    assert embedder.calls == []
    assert adjudicator.calls == []


async def test_a_short_embedding_response_is_not_silently_dropped(monkeypatch):
    """One vector short would pair the wrong atoms and lose the trailing ones.

    `embed_texts` promises to raise rather than return a short list but never
    checks, and `zip` truncates in silence. `None` for the session again: this
    has to fail before anything reaches Postgres.
    """
    async def _short(texts):
        return [_near()]

    _install(monkeypatch, _short, _explode)

    with pytest.raises(AssertionError, match="1 vectors for 2 atoms"):
        await consolidate(None, SOLE_LEARNER_ID,
                          [_atom("A first fact."), _atom("A second fact.")],
                          session_id=None, turn_ids=[])


async def test_an_empty_embedding_is_refused(monkeypatch):
    """A row written without an embedding can never be superseded, so refuse it.

    `_candidates` selects on cosine distance, which a NULL embedding fails, so
    such an atom could never be offered as a supersession target again — and
    retrieval could only ever reach it through its keyword arm, never by
    meaning.
    """
    _install(monkeypatch, _Embedder(default=[]), _explode)

    with pytest.raises(AssertionError, match="empty vector"):
        await consolidate(None, SOLE_LEARNER_ID, [_atom("A fact.")],
                          session_id=None, turn_ids=[])


# ---------------------------------------------------------------------------
# consolidate: what actually lands in Postgres
# ---------------------------------------------------------------------------


@requires_db
async def test_supersede_closes_the_old_atom(db_factory, monkeypatch):
    """The old row is closed, not rewritten, and the new one takes over.

    Four fields move and none of them is `text`: `valid_to` and
    `invalidated_at` close the two intervals, `superseded_by` records what
    replaced it, and the sentence itself is still sitting in the table
    afterwards — which is the difference between a trajectory and a lost fact.
    """
    _install(monkeypatch, _Embedder(default=_near(0.1)),
             _Adjudicator('{"ops": [{"index": 0, "op": "SUPERSEDE", "target": 0}]}'))

    async with db_factory() as db:
        await _sole_learner(db)
        old = MemoryAtom(learner_id=SOLE_LEARNER_ID,
                         text="Cannot factor quadratics.",
                         category="skill_state", source_turn_ids=[],
                         embedding=_near())
        db.add(old)
        await db.commit()
        old_id = old.id

        result = await consolidate(
            db, SOLE_LEARNER_ID,
            [_atom("Can now factor quadratics reliably.")],
            session_id=None, turn_ids=[],
        )
        await db.commit()

    assert result == ConsolidationResult(added=1, superseded=1, skipped=0)

    async with db_factory() as db:
        closed = await db.get(MemoryAtom, old_id)
        assert closed.valid_to is not None
        assert closed.invalidated_at is not None
        assert closed.superseded_by is not None
        # The whole point: the replaced sentence is still there to read.
        assert closed.text == "Cannot factor quadratics."

        live = await _live(db)
        assert len(live) == 1
        assert live[0].text == "Can now factor quadratics reliably."
        assert closed.superseded_by == live[0].id


@requires_db
async def test_opposite_facts_are_not_merged(db_factory, monkeypatch):
    """A fact and its own negation are near-identical vectors and both survive.

    This is the test a threshold-only implementation fails. The two sentences
    differ by two words and sit at ~0.99 cosine similarity here, which is above
    any threshold anyone would pick — so an implementation that decided on the
    number would NOOP the new fact, or supersede the old one, without ever
    asking what the sentences meant. The adjudicator is what decides, it says
    ADD, and both facts have to be live afterwards.

    The assertion on `existing_facts` is the other half: similarity is supposed
    to have done exactly one job here, which is to put the fact on file in
    front of the model. If it stops doing that, this stops being a test of
    adjudication and starts being a test of an empty candidate list.
    """
    understands = "Understands how to add fractions with unlike denominators."
    does_not = "Does not understand how to add fractions with unlike denominators."
    adjudicator = _Adjudicator(ADD_0)
    _install(monkeypatch, _Embedder({understands: _near(), does_not: _near(0.14)}),
             adjudicator)

    async with db_factory() as db:
        await _sole_learner(db)
        db.add(MemoryAtom(learner_id=SOLE_LEARNER_ID, text=understands,
                          category="skill_state", source_turn_ids=[],
                          embedding=_near()))
        await db.commit()

        result = await consolidate(db, SOLE_LEARNER_ID, [_atom(does_not)],
                                   session_id=None, turn_ids=[])
        await db.commit()

    assert result == ConsolidationResult(added=1, superseded=0, skipped=0)
    assert len(adjudicator.calls) == 1
    assert understands in adjudicator.calls[0][1]

    async with db_factory() as db:
        live = await _live(db)
        assert {atom.text for atom in live} == {understands, does_not}
        assert all(atom.superseded_by is None for atom in live)


@requires_db
async def test_noop_writes_no_row(db_factory, monkeypatch):
    """A restatement is skipped, and skipping means no INSERT at all."""
    _install(monkeypatch, _Embedder(default=_near(0.05)), _Adjudicator(NOOP_0))

    async with db_factory() as db:
        await _sole_learner(db)
        db.add(MemoryAtom(learner_id=SOLE_LEARNER_ID,
                          text="Sits the higher tier paper in June 2026.",
                          category="goal", source_turn_ids=[], embedding=_near()))
        await db.commit()

        result = await consolidate(
            db, SOLE_LEARNER_ID,
            [_atom("Is taking the higher paper in June 2026.", MemoryCategory.goal)],
            session_id=None, turn_ids=[],
        )
        await db.commit()

    assert result == ConsolidationResult(added=0, superseded=0, skipped=1)

    async with db_factory() as db:
        rows = (await db.execute(select(MemoryAtom))).scalars().all()
        assert [row.text for row in rows] == ["Sits the higher tier paper in June 2026."]


@requires_db
async def test_embedding_round_trips_through_postgres(db_factory, monkeypatch):
    """The first vector this service ever writes comes back as it went in.

    Two assertions, because they can fail independently. The first is the
    value: read out of a session that never saw the object, so it is decoded
    from `halfvec` rather than handed back out of the identity map. The second
    is that Postgres agrees it is a vector — a column that had silently become
    text would still compare equal here and would fail the moment anything
    asked it to order by distance, which is every read this table exists for.
    """
    vector = _exact()
    _install(monkeypatch, _Embedder(default=vector), _explode)

    async with db_factory() as db:
        await _sole_learner(db)
        await consolidate(
            db, SOLE_LEARNER_ID,
            [_atom("Sits the higher tier paper in June 2026.", MemoryCategory.goal)],
            session_id=None, turn_ids=[],
        )
        await db.commit()

    async with db_factory() as db:
        stored = (await db.execute(select(MemoryAtom))).scalar_one()
        assert stored.embedding == vector

        nearest = await _candidates(db, SOLE_LEARNER_ID, [vector])
        assert [row.text for row in nearest] == ["Sits the higher tier paper in June 2026."]


@requires_db
async def test_first_facts_skip_the_adjudicator(db_factory, monkeypatch):
    """With nothing on file within reach there is nothing to adjudicate.

    Asking anyway would be a request whose only usable answer is the one the
    caller already knows, and whose other answers name candidates that do not
    exist.
    """
    embedder = _Embedder(default=_near())
    _install(monkeypatch, embedder, _explode)

    async with db_factory() as db:
        await _sole_learner(db)
        result = await consolidate(
            db, SOLE_LEARNER_ID,
            [_atom("Is in Year 11.", MemoryCategory.context),
             _atom("Sits the higher tier paper in June 2026.", MemoryCategory.goal)],
            session_id=None, turn_ids=[],
        )
        await db.commit()

    assert result == ConsolidationResult(added=2, superseded=0, skipped=0)
    assert embedder.calls == [["Is in Year 11.",
                               "Sits the higher tier paper in June 2026."]]


@requires_db
async def test_candidates_are_live_and_near(db_factory, monkeypatch):
    """Only live atoms above `FLOOR` are put in front of the adjudicator.

    A distant atom is not evidence about this fact and costs tokens to show. A
    superseded one is already closed, and offering it would let a second
    supersession overwrite the pointer recording what replaced it first.
    """
    adjudicator = _Adjudicator(ADD_0)
    _install(monkeypatch, _Embedder(default=_near(0.08)), adjudicator)

    async with db_factory() as db:
        await _sole_learner(db)
        near = MemoryAtom(learner_id=SOLE_LEARNER_ID, text="NEAR AND LIVE",
                          category="skill_state", source_turn_ids=[],
                          embedding=_near(0.02))
        far = MemoryAtom(learner_id=SOLE_LEARNER_ID, text="FAR AND LIVE",
                         category="skill_state", source_turn_ids=[],
                         embedding=_far())
        closed = MemoryAtom(learner_id=SOLE_LEARNER_ID, text="NEAR BUT CLOSED",
                            category="skill_state", source_turn_ids=[],
                            embedding=_near(0.03))
        db.add_all([near, far, closed])
        await db.flush()
        closed.valid_to = closed.invalidated_at = closed.ingested_at
        await db.commit()
        stamped = f"({near.valid_from:%Y-%m-%d})"

        await consolidate(db, SOLE_LEARNER_ID, [_atom("Something new entirely.")],
                          session_id=None, turn_ids=[])
        await db.commit()

    existing_facts = adjudicator.calls[0][1]
    assert "NEAR AND LIVE" in existing_facts
    assert "FAR AND LIVE" not in existing_facts
    assert "NEAR BUT CLOSED" not in existing_facts
    # Dated, so the model can tell which way time runs rather than assuming the
    # batch in front of it is the later one — which a backlog walked out of
    # order would make false.
    assert stamped in existing_facts


@requires_db
async def test_an_episode_ref_is_never_offered_as_a_supersession_target(
    db_factory, monkeypatch,
):
    """A closed `episode_ref` is read by nothing, anywhere, forever.

    `profile._closed_atoms` only renders categories in `profile.ORDER`, and
    `episode_ref` is deliberately not one of them; retrieval and the live
    profile query both filter `valid_to IS NULL`. So a superseded episode atom
    is dropped by all three readers at once — not demoted, gone. And it can
    never be superseded *back*, because `_candidates` offers live rows only.

    Nothing stopped that happening. These atoms are the most formulaic text in
    the store — "Covered adding fractions on <date>", one a session — so two of
    them are far closer to each other than two real facts are, which is exactly
    what `FLOOR = 0.35` newly admits. Dormant at 0.75, live now.

    The category is also the reason this is a rule and not a saving: an episode
    record is a fact about a *session*, and a session cannot stop having
    happened. There is nothing for a later fact to replace.
    """
    adjudicator = _Adjudicator(ADD_0)
    _install(monkeypatch, _Embedder(default=_near(0.08)), adjudicator)

    async with db_factory() as db:
        await _sole_learner(db)
        episode = MemoryAtom(learner_id=SOLE_LEARNER_ID,
                             text="Covered adding fractions on 2026-08-02.",
                             category=MemoryCategory.episode_ref.value,
                             source_turn_ids=[], embedding=_near(0.02),
                             stated=False)
        skill = MemoryAtom(learner_id=SOLE_LEARNER_ID,
                           text="Adds fractions with unlike denominators.",
                           category="skill_state", source_turn_ids=[],
                           embedding=_near(0.03))
        db.add_all([episode, skill])
        await db.commit()

        # Both are live and both are well inside `FLOOR` of the query vector,
        # so the episode atom is excluded by its category and by nothing else.
        nearest = await _candidates(db, SOLE_LEARNER_ID, [_near(0.025)])
        assert [row.text for row in nearest] == [
            "Adds fractions with unlike denominators."
        ]

        await consolidate(
            db, SOLE_LEARNER_ID,
            [_atom("Covered adding fractions on 2026-08-09.",
                   MemoryCategory.episode_ref)],
            session_id=None, turn_ids=[],
        )
        await db.commit()

    assert "2026-08-02" not in adjudicator.calls[0][1]
    async with db_factory() as db:
        episodes = (await db.execute(
            select(MemoryAtom)
            .where(MemoryAtom.category == MemoryCategory.episode_ref.value)
        )).scalars().all()
    assert len(episodes) == 2
    assert all(row.valid_to is None for row in episodes)


@requires_db
async def test_a_real_supersession_pair_clears_the_shipped_floor(
    db_factory, monkeypatch
):
    """`FLOOR`, measured against vectors the real model actually produced.

    This is the one test in the file that does not use `_near`. Every other
    candidate test builds vectors ~0.99 similar by construction, which is a
    similarity `text-embedding-3-small` never produces for two different
    English sentences — so they all assert over a number the shipped system
    cannot reach, and they all passed while `FLOOR` was set to a figure carried
    over from `text-embedding-ada-002`. `_candidates` returned empty on every
    real supersession, `_adjudicate` was never called, and a learner who had
    stopped struggling with something kept both facts live. Nothing in this
    file could see it; `tests/eval/run_probes.py` is what found it.

    So the vectors below are checked in rather than generated: real output from
    the model named in `config.EMBEDDING_MODEL`, recorded once, kept so this
    costs no provider call and cannot drift. If that constant changes, this
    fixture has to be regenerated — and the point of the assertion is that
    regenerating it against a model `FLOOR` was never tuned for turns this red
    instead of leaving the whole supersede path silently dead.
    """
    fixture = _real_embeddings()
    stale = fixture["texts"]["stale_skill"]
    current = fixture["texts"]["current_skill"]
    unrelated = fixture["texts"]["unrelated"]

    # The trap, stated as an assertion rather than a comment: a genuine
    # supersession pair is nowhere near the old 0.75, so any floor set from
    # ada-002's scale rejects it outright.
    assert fixture["cosine_similarity"]["stale_vs_current"] < 0.75
    assert FLOOR < fixture["cosine_similarity"]["stale_vs_current"]

    adjudicator = _Adjudicator(ADD_0)
    _install(
        monkeypatch,
        _Embedder({current: fixture["vectors"]["current_skill"]}),
        adjudicator,
    )

    async with db_factory() as db:
        await _sole_learner(db)
        db.add_all([
            MemoryAtom(learner_id=SOLE_LEARNER_ID, text=stale,
                       category="skill_state", source_turn_ids=[],
                       embedding=fixture["vectors"]["stale_skill"]),
            MemoryAtom(learner_id=SOLE_LEARNER_ID, text=unrelated,
                       category="context", source_turn_ids=[],
                       embedding=fixture["vectors"]["unrelated"]),
        ])
        await db.flush()

        await consolidate(db, SOLE_LEARNER_ID, [_atom(current)],
                          session_id=None, turn_ids=[])
        await db.commit()

    assert adjudicator.calls, (
        "the adjudicator was never reached: no live atom cleared FLOOR "
        f"({FLOOR}) against a real embedding of a fact that supersedes one of "
        "them, so every reversal of the learner's state would be written as a "
        "second coexisting fact"
    )
    existing_facts = adjudicator.calls[0][1]
    assert stale in existing_facts
    # The floor still does its job: an unrelated fact is not worth a token.
    assert unrelated not in existing_facts


@requires_db
async def test_supersede_target_that_does_not_exist_only_adds(db_factory, monkeypatch):
    """An invented target closes nothing; the fact is still written.

    Documented decision. The alternatives both lose something real: clamping
    the index into range closes a row picked by arithmetic on a number the
    model made up, and a wrongly closed atom disappears from every live query
    with nothing to distinguish it from one that genuinely stopped being true;
    raising abandons the atoms in the same batch that were fine, in a pass that
    runs unattended over a backlog. Writing the fact and leaving the store
    alone is the only outcome that cannot destroy anything.
    """
    _install(monkeypatch, _Embedder(default=_near(0.1)), _Adjudicator(
        '{"ops": [{"index": 0, "op": "SUPERSEDE", "target": 7}, '
        '{"index": 1, "op": "SUPERSEDE", "target": -1}]}'))

    async with db_factory() as db:
        await _sole_learner(db)
        db.add(MemoryAtom(learner_id=SOLE_LEARNER_ID, text="The only fact on file.",
                          category="skill_state", source_turn_ids=[],
                          embedding=_near()))
        await db.commit()

        result = await consolidate(
            db, SOLE_LEARNER_ID,
            [_atom("A first new fact."), _atom("A second new fact.")],
            session_id=None, turn_ids=[],
        )
        await db.commit()

    assert result == ConsolidationResult(added=2, superseded=0, skipped=0)

    async with db_factory() as db:
        live = await _live(db)
        assert len(live) == 3
        assert all(row.superseded_by is None for row in live)


@requires_db
async def test_two_atoms_naming_one_target_close_it_once(db_factory, monkeypatch):
    """The first supersession stands; the second is written but claims nothing.

    Documented decision. The adjudicator is not asked to keep its answers
    consistent with each other, so both atoms in a batch can name the same
    existing fact. Applying both would close the row twice and leave
    `superseded_by` pointing at whichever atom happened to be processed last —
    the record of what actually replaced it, overwritten. Both new facts are
    still kept: dropping one would lose a fact to fix a bookkeeping conflict.
    """
    _install(monkeypatch, _Embedder(default=_near(0.1)), _Adjudicator(
        '{"ops": [{"index": 0, "op": "SUPERSEDE", "target": 0}, '
        '{"index": 1, "op": "SUPERSEDE", "target": 0}]}'))

    async with db_factory() as db:
        await _sole_learner(db)
        old = MemoryAtom(learner_id=SOLE_LEARNER_ID, text="Cannot factor quadratics.",
                         category="skill_state", source_turn_ids=[],
                         embedding=_near())
        db.add(old)
        await db.commit()
        old_id = old.id

        result = await consolidate(
            db, SOLE_LEARNER_ID,
            [_atom("Factors quadratics with a hint."),
             _atom("Factors quadratics unaided.")],
            session_id=None, turn_ids=[],
        )
        await db.commit()

    assert result == ConsolidationResult(added=2, superseded=1, skipped=0)

    async with db_factory() as db:
        closed = await db.get(MemoryAtom, old_id)
        live = {row.text: row for row in await _live(db)}
        assert set(live) == {"Factors quadratics with a hint.",
                             "Factors quadratics unaided."}
        assert closed.superseded_by == live["Factors quadratics with a hint."].id


@requires_db
async def test_duplicate_atoms_in_one_batch_are_written_once(db_factory, monkeypatch):
    """Documented decision: the batch is de-duplicated by text before anything.

    The adjudicator only ever compares new facts against existing ones, so two
    identical atoms out of one session would both be told ADD and both be
    written — and would then be two live rows saying the same thing forever,
    because a later pass only ever compares *new* facts against them and
    neither can supersede the other. The check is string identity, which is why
    it is safe to run before the model: identity cannot merge a fact with its
    negation, and anything short of identical is left for the model to rule on.
    """
    embedder = _Embedder(default=_near())
    _install(monkeypatch, embedder, _explode)

    text = "Sits the higher tier paper in June 2026."
    async with db_factory() as db:
        await _sole_learner(db)
        result = await consolidate(
            db, SOLE_LEARNER_ID,
            [_atom(text, MemoryCategory.goal), _atom(text, MemoryCategory.goal)],
            session_id=None, turn_ids=[],
        )
        await db.commit()

    assert result == ConsolidationResult(added=1, superseded=0, skipped=1)
    # The duplicate never reached the embeddings endpoint either.
    assert embedder.calls == [[text]]

    async with db_factory() as db:
        rows = (await db.execute(select(MemoryAtom))).scalars().all()
        assert [row.text for row in rows] == [text]


@requires_db
async def test_unstated_episode_ref_is_stored_unstated(db_factory, monkeypatch):
    """`stated=False` is carried onto the row, never quietly promoted.

    An `episode_ref` legitimately arrives unstated — it is a record of what the
    session covered rather than a claim about the learner, so the tutor is its
    author (see `schema.STATED_EXEMPT`). Defaulting it to True here would
    give an observation a learner statement's authority, and nothing
    downstream could tell the two apart again.
    """
    _install(monkeypatch, _Embedder(default=_near()), _explode)

    async with db_factory() as db:
        await _sole_learner(db)
        await consolidate(
            db, SOLE_LEARNER_ID,
            [_atom("Covered adding unlike fractions on 2026-05-12.",
                   MemoryCategory.episode_ref, stated=False),
             _atom("Is in Year 11.", MemoryCategory.context, stated=True)],
            session_id=None, turn_ids=[],
        )
        await db.commit()

    async with db_factory() as db:
        rows = {row.category: row for row in
                (await db.execute(select(MemoryAtom))).scalars().all()}
        assert rows["episode_ref"].stated is False
        assert rows["context"].stated is True


@requires_db
async def test_provenance_is_recorded_on_every_new_row(db_factory, monkeypatch):
    """Which session and which turns produced the fact, read back from Postgres.

    `source_turn_ids` is a `uuid[]`, so this also covers asyncpg decoding the
    array back into `uuid.UUID` objects rather than strings.
    """
    _install(monkeypatch, _Embedder(default=_near()), _explode)
    session_id = uuid.uuid4()
    turn_ids = [uuid.uuid4(), uuid.uuid4()]

    async with db_factory() as db:
        await _sole_learner(db)
        await consolidate(
            db, SOLE_LEARNER_ID, [_atom("Is in Year 11.", MemoryCategory.context)],
            session_id=session_id, turn_ids=turn_ids,
        )
        await db.commit()

    async with db_factory() as db:
        stored = (await db.execute(select(MemoryAtom))).scalar_one()
        assert stored.source_session_id == session_id
        assert stored.source_turn_ids == turn_ids
        assert all(isinstance(turn_id, uuid.UUID) for turn_id in stored.source_turn_ids)
        assert stored.category == "context"
        assert stored.valid_to is None and stored.superseded_by is None


@requires_db
async def test_consolidate_leaves_the_transaction_to_the_caller(db_factory, monkeypatch):
    """It flushes, it does not commit. A rollback afterwards must lose the lot.

    The extraction pass consolidates and then marks the episode extracted; if
    this committed on its own, a failure between the two would leave the atoms
    written and the episode still queued, and the next run would write them all
    again.
    """
    _install(monkeypatch, _Embedder(default=_near()), _explode)

    async with db_factory() as db:
        await _sole_learner(db)
        await db.commit()
        result = await consolidate(
            db, SOLE_LEARNER_ID, [_atom("Is in Year 11.", MemoryCategory.context)],
            session_id=None, turn_ids=[],
        )
        assert result.added == 1
        await db.rollback()

    async with db_factory() as db:
        assert (await db.execute(select(MemoryAtom))).scalars().all() == []
