import uuid
from datetime import datetime, timedelta, timezone

from app.config import EXTRACTION_MODEL, SOLE_LEARNER_ID
from app.memory.profile import (
    _HISTORY_HEADING, _LIVE_HEADING, ORDER, _group, _render, _synthesize,
    current_profile, rebuild_profile,
)
from app.store.models import Learner, LearnerProfile, MemoryAtom
from tests.conftest import requires_db

# ---------------------------------------------------------------------------
# No embeddings anywhere below. This module selects and orders atoms and never
# ranks them, so the column stays NULL — which also keeps these tests clear of
# the zero-vector trap in `test_memory_retrieve.py`, where a cosine distance
# against all-zeros is NaN and every assertion built on it passes vacuously.
#
# Two dates, far enough apart to read as a trajectory: a fact from March that a
# June one replaced.
# ---------------------------------------------------------------------------

MARCH = datetime(2026, 3, 4, tzinfo=timezone.utc)
JUNE = datetime(2026, 6, 1, tzinfo=timezone.utc)


class _Synthesis:
    """Stands in for `_synthesize`, recording the facts block it was handed.

    That block is everything this module actually produces — the prose after it
    belongs to the model — so nearly every assertion below reads `calls`. With
    no `body` given it echoes the block back as the portrait, for the few tests
    that care what the stored body is made of rather than what was sent.
    """

    def __init__(self, body: str | None = None):
        self.calls: list[str] = []
        self._body = body

    async def __call__(self, facts: str) -> str:
        self.calls.append(facts)
        return self._body if self._body is not None else facts


def _install(monkeypatch, body: str | None = None) -> _Synthesis:
    synthesis = _Synthesis(body)
    monkeypatch.setattr("app.memory.profile._synthesize", synthesis)
    return synthesis


async def _learner(db, learner_id: uuid.UUID = SOLE_LEARNER_ID) -> None:
    """Migration 0003 seeds the sole learner; the test schema is built from the
    metadata and so has no seed (see `conftest.db_factory`)."""
    db.add(Learner(id=learner_id, display_name="me"))
    await db.flush()


def _atom(text: str, *, category: str = "skill_state",
          learner_id: uuid.UUID = SOLE_LEARNER_ID,
          valid_from: datetime = MARCH, valid_to: datetime | None = None,
          superseded_by: uuid.UUID | None = None,
          atom_id: uuid.UUID | None = None) -> MemoryAtom:
    return MemoryAtom(id=atom_id or uuid.uuid4(), learner_id=learner_id, text=text,
                      category=category, source_turn_ids=[], valid_from=valid_from,
                      valid_to=valid_to, superseded_by=superseded_by)


async def _closed(db, text: str, *, successor: MemoryAtom,
                  valid_to: datetime = JUNE, **kwargs) -> MemoryAtom:
    """A superseded atom, pointing at the row that replaced it.

    `superseded_by` is a real foreign key and there is no relationship for the
    unit of work to order the two inserts by, so the successor has to be on
    disk before this can name it.
    """
    atom = _atom(text, valid_to=valid_to, superseded_by=successor.id, **kwargs)
    db.add(atom)
    await db.flush()
    return atom


# ---------------------------------------------------------------------------
# Rendering: the part that has to be byte-stable
# ---------------------------------------------------------------------------


def test_group_walks_one_fixed_category_order():
    """Categories come out in `ORDER` however they went in, and every key is
    there. `episode_ref` is not a fact about the person and never appears."""
    grouped = _group([
        _atom("Second goal.", category="goal"),
        _atom("A preference.", category="preference"),
        _atom("First goal.", category="goal"),
        _atom("Covered fractions on 2026-06-01.", category="episode_ref"),
    ])

    assert list(grouped) == list(ORDER)
    # Input order is kept inside a category — the queries decide it, not this.
    assert [atom.text for atom in grouped["goal"]] == ["Second goal.", "First goal."]
    assert [atom.text for atom in grouped["preference"]] == ["A preference."]
    assert "episode_ref" not in grouped


def test_render_pins_the_shape_of_both_blocks():
    """The exact bytes, because the exact bytes are the contract.

    A closed atom is unmistakable twice over — under its own heading and again
    on its own line — and the live atom passed in first still renders second,
    which is `ORDER` doing its job rather than the input order.
    """
    live = [
        _atom("Factors simple quadratics unaided.", valid_from=JUNE),
        _atom("In Year 11, sitting AQA higher tier.", category="context"),
    ]
    historical = [_atom("Cannot factor quadratics.", valid_to=JUNE)]

    assert _render(live, historical) == (
        "CURRENTLY TRUE\n"
        "- [context] (since 2026-03-04) In Year 11, sitting AQA higher tier.\n"
        "- [skill_state] (since 2026-06-01) Factors simple quadratics unaided.\n"
        "\n"
        "NO LONGER TRUE (history, for narrating change only)\n"
        "- [skill_state] (was true 2026-03-04 to 2026-06-01, no longer) "
        "Cannot factor quadratics."
    )


def test_render_leaves_the_history_heading_out_when_there_is_no_history():
    """An empty section is an invitation to fill it, and this is the one block
    where filling it would invent a past for the learner."""
    rendered = _render([_atom("Enjoys geometry proofs.")], [])

    assert _HISTORY_HEADING not in rendered
    assert rendered.startswith(_LIVE_HEADING)


async def test_the_request_is_the_shape_the_other_memory_calls_use(monkeypatch):
    """Same model and the same `store=False` as extraction and consolidation.

    The facts block reaches the provider inside the prompt and not as a second
    message, so a prompt template that stopped interpolating it would fail here
    rather than silently ask the model to describe nobody.
    """
    sent: list[dict] = []

    class _Responses:
        async def create(self, **kwargs):
            sent.append(kwargs)
            return type("R", (), {"output_text": "  A portrait.  "})()

    monkeypatch.setattr("app.memory.profile._client",
                        lambda: type("C", (), {"responses": _Responses()})())

    assert await _synthesize("CURRENTLY TRUE\n- [goal] Wants the June exam.") == \
        "A portrait."
    assert sent[0]["model"] == EXTRACTION_MODEL
    assert sent[0]["store"] is False
    assert "- [goal] Wants the June exam." in sent[0]["input"][0]["content"]


# ---------------------------------------------------------------------------
# rebuild_profile
# ---------------------------------------------------------------------------


@requires_db
async def test_rebuild_writes_and_current_reads_back(db, monkeypatch):
    _install(monkeypatch, body="## Goals\nWants the June exam.")
    await _learner(db)
    db.add(_atom("Wants to be ready for the June exam.", category="goal"))
    await db.commit()

    written = await rebuild_profile(db, SOLE_LEARNER_ID)
    await db.commit()

    assert "June exam" in written
    assert await current_profile(db, SOLE_LEARNER_ID) == written


@requires_db
async def test_rebuild_with_no_atoms_returns_empty_and_writes_nothing(db, monkeypatch):
    synthesis = _install(monkeypatch)
    await _learner(db)
    await db.commit()

    assert await rebuild_profile(db, SOLE_LEARNER_ID) == ""
    await db.commit()

    assert await current_profile(db, SOLE_LEARNER_ID) is None
    # An empty store must not have cost a request either.
    assert synthesis.calls == []


@requires_db
async def test_a_superseded_atom_arrives_as_history_and_never_as_fact(db, monkeypatch):
    """The bi-temporal store's only reader, and the reason it is bi-temporal.

    Both rows are about the same skill and say opposite things, so an
    implementation that merged the blocks — or dropped the closed row, as the
    live-only selection this replaced did — cannot pass: the March fact has to
    be present, and present only where it cannot read as current.
    """
    synthesis = _install(monkeypatch)
    await _learner(db)
    live = _atom("Factors simple quadratics unaided.", valid_from=JUNE)
    db.add(live)
    await db.flush()
    await _closed(db, "Cannot factor quadratics.", successor=live)
    await db.commit()

    await rebuild_profile(db, SOLE_LEARNER_ID)

    facts = synthesis.calls[0]
    current, _, history = facts.partition(_HISTORY_HEADING)
    assert "Cannot factor quadratics." not in current
    assert ("- [skill_state] (was true 2026-03-04 to 2026-06-01, no longer) "
            "Cannot factor quadratics.") in history
    assert "Factors simple quadratics unaided." in current


@requires_db
async def test_history_keeps_the_most_recently_closed_and_drops_the_rest(db, monkeypatch):
    """The cap, proved by which atoms survive it rather than by how many.

    All three closed rows are identical but for their closing dates, so only an
    implementation that orders by `valid_to` before cutting keeps the right two.
    """
    monkeypatch.setattr("app.memory.profile.HISTORY", 2)
    synthesis = _install(monkeypatch)
    await _learner(db)
    live = _atom("Factors simple quadratics unaided.", valid_from=JUNE)
    db.add(live)
    await db.flush()
    for age in range(3):
        await _closed(db, f"Stuck on quadratics, take {age}.", successor=live,
                      valid_to=JUNE - timedelta(days=age))
    await db.commit()

    await rebuild_profile(db, SOLE_LEARNER_ID)

    facts = synthesis.calls[0]
    assert "take 0." in facts
    assert "take 1." in facts
    assert "take 2." not in facts


@requires_db
async def test_a_retracted_atom_is_not_narrated_as_history(db, monkeypatch):
    """Closed with nothing pointing at it means withdrawn, not outgrown.

    It is byte-for-byte a superseded row apart from the missing `superseded_by`,
    so this fails for any selection that reads `valid_to IS NOT NULL` as "was
    once true" — and what that would cost is a fact we decided was never true
    being handed back to the tutor as the learner's past.
    """
    synthesis = _install(monkeypatch)
    await _learner(db)
    db.add_all([
        _atom("Factors simple quadratics unaided.", valid_from=JUNE),
        _atom("Is probably an anxious learner.", valid_to=JUNE),
    ])
    await db.commit()

    await rebuild_profile(db, SOLE_LEARNER_ID)

    assert "anxious" not in synthesis.calls[0]
    assert _HISTORY_HEADING not in synthesis.calls[0]


@requires_db
async def test_atoms_written_in_one_pass_are_ordered_by_id(db, monkeypatch):
    """The tiebreak, with the tie that actually happens.

    All three share a `valid_from`, as every atom from one consolidation pass
    does, and they are inserted in an order that is not their id order — so a
    query ordered on the timestamp alone would hand back heap order and this
    would read C, A, B.
    """
    synthesis = _install(monkeypatch)
    await _learner(db)
    ids = [uuid.UUID(f"00000000-0000-4000-8000-00000000ff0{n}") for n in range(3)]
    for position in (2, 0, 1):
        db.add(_atom(f"Fact {'ABC'[position]}.", atom_id=ids[position]))
        await db.flush()
    await db.commit()

    await rebuild_profile(db, SOLE_LEARNER_ID)

    assert synthesis.calls[0] == (
        f"{_LIVE_HEADING}\n"
        "- [skill_state] (since 2026-03-04) Fact A.\n"
        "- [skill_state] (since 2026-03-04) Fact B.\n"
        "- [skill_state] (since 2026-03-04) Fact C."
    )


@requires_db
async def test_two_rebuilds_over_an_unchanged_store_send_the_same_bytes(db, monkeypatch):
    """What the stable ordering is for: this block sits in a cached prompt
    prefix, and a reordered line costs a cache miss on every turn after it.

    Everything is expired between the two runs so the second genuinely re-reads
    the rows rather than re-rendering the objects the first one left behind.
    """
    synthesis = _install(monkeypatch)
    await _learner(db)
    live = [_atom("Prefers worked examples first.", category="preference"),
            _atom("In Year 11, sitting AQA higher tier.", category="context"),
            _atom("Factors simple quadratics unaided.", valid_from=JUNE)]
    db.add_all(live)
    await db.flush()
    await _closed(db, "Cannot factor quadratics.", successor=live[2])
    await db.commit()

    await rebuild_profile(db, SOLE_LEARNER_ID)
    await db.commit()
    db.expire_all()
    await rebuild_profile(db, SOLE_LEARNER_ID)

    # Both blocks, all four atoms — so the equality below is over a real
    # rendering and not over two empty strings.
    assert synthesis.calls[0].count("\n- [") == 4
    assert _HISTORY_HEADING in synthesis.calls[0]
    assert synthesis.calls[0] == synthesis.calls[1]


@requires_db
async def test_a_deleted_atom_is_gone_from_the_next_body(db, monkeypatch):
    """The deletion story end to end: the body is only ever a reading of the
    atoms this run could see, so removing one removes it from here too."""
    _install(monkeypatch)  # echoes the facts block back as the portrait
    await _learner(db)
    forgettable = _atom("Prefers worked examples first.", category="preference")
    db.add_all([forgettable, _atom("Studies on Tuesday evenings.", category="context")])
    await db.commit()

    assert "worked examples" in await rebuild_profile(db, SOLE_LEARNER_ID)
    await db.commit()

    await db.delete(forgettable)
    rebuilt = await rebuild_profile(db, SOLE_LEARNER_ID)
    await db.commit()

    assert "worked examples" not in rebuilt
    assert "Tuesday" in rebuilt
    db.expire_all()
    assert (await db.get(LearnerProfile, SOLE_LEARNER_ID)).atom_count == 1


@requires_db
async def test_deleting_every_atom_takes_the_stored_profile_with_it(db, monkeypatch):
    """A portrait that outlived every fact behind it would be a second copy of
    deleted facts, in the one table nothing rebuilds."""
    _install(monkeypatch)
    await _learner(db)
    atom = _atom("Prefers worked examples first.", category="preference")
    db.add(atom)
    await db.commit()
    await rebuild_profile(db, SOLE_LEARNER_ID)
    await db.commit()

    await db.delete(atom)

    assert await rebuild_profile(db, SOLE_LEARNER_ID) == ""
    await db.commit()
    db.expire_all()
    assert await current_profile(db, SOLE_LEARNER_ID) is None


@requires_db
async def test_another_learners_atoms_are_left_out(db, monkeypatch):
    """There is one learner today; the filter is what makes a second one safe."""
    other = uuid.uuid4()
    synthesis = _install(monkeypatch)
    await _learner(db)
    await _learner(db, other)
    db.add_all([
        _atom("Studies on Tuesday evenings.", category="context"),
        _atom("Studies on Thursday evenings.", category="context", learner_id=other),
    ])
    await db.commit()

    await rebuild_profile(db, SOLE_LEARNER_ID)

    assert "Tuesday" in synthesis.calls[0]
    assert "Thursday" not in synthesis.calls[0]


@requires_db
async def test_episode_refs_are_left_out_of_the_portrait(db, monkeypatch):
    """`recent_episodes` answers what has been covered lately, in date order. A
    portrait made partly of session summaries is a log with a face drawn on it.
    """
    synthesis = _install(monkeypatch)
    await _learner(db)
    db.add_all([
        _atom("Studies on Tuesday evenings.", category="context"),
        _atom("Covered adding fractions on 2026-06-01.", category="episode_ref"),
    ])
    await db.commit()

    await rebuild_profile(db, SOLE_LEARNER_ID)

    assert "adding fractions" not in synthesis.calls[0]
