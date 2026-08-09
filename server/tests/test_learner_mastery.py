import uuid

import pytest
from sqlalchemy import select

from app.config import SOLE_LEARNER_ID
from app.learner.evidence import _shares, record
from app.learner.kcs import MASTERY_THRESHOLD
from app.learner.mastery import (
    MIN_EVIDENCE_FOR_BAND, RELIABILITY, band, elo_step, snapshot,
)
from app.store.models import KC, Learner, LearnerKCState, Observation
from tests.conftest import requires_db

# ---------------------------------------------------------------------------
# Everything above `_vocabulary` is arithmetic and runs without a database.
# ---------------------------------------------------------------------------


def test_correct_answer_raises_theta():
    theta, n = elo_step(0.0, 0.5, outcome=1.0, reliability=0.95,
                        weight=1.0, difficulty=0.0)
    assert theta > 0.0
    assert n > 0.5


def test_wrong_answer_lowers_theta():
    theta, _ = elo_step(0.0, 0.5, outcome=0.0, reliability=0.95,
                        weight=1.0, difficulty=0.0)
    assert theta < 0.0


def test_low_reliability_moves_theta_less():
    strong, _ = elo_step(0.0, 0.5, outcome=1.0, reliability=0.95,
                         weight=1.0, difficulty=0.0)
    weak, _ = elo_step(0.0, 0.5, outcome=1.0, reliability=0.35,
                       weight=1.0, difficulty=0.0)
    assert weak < strong


def test_k_factor_decays_with_evidence():
    early, _ = elo_step(0.0, 0.5, outcome=1.0, reliability=0.95,
                        weight=1.0, difficulty=0.0)
    late, _ = elo_step(0.0, 20.0, outcome=1.0, reliability=0.95,
                       weight=1.0, difficulty=0.0)
    assert late < early


def test_weight_splits_a_multi_concept_turn():
    """A turn touching two concepts must not count as full evidence for both."""
    whole, _ = elo_step(0.0, 0.5, outcome=1.0, reliability=0.95,
                        weight=1.0, difficulty=0.0)
    half, _ = elo_step(0.0, 0.5, outcome=1.0, reliability=0.95,
                       weight=0.5, difficulty=0.0)
    assert half == pytest.approx(whole / 2, rel=1e-6)


def test_diagram_evidence_is_weakest():
    assert RELIABILITY["ink_diagram"] < RELIABILITY["ink_symbolic"]
    assert RELIABILITY["ink_symbolic"] < RELIABILITY["answer_verified"]


def test_band_is_coarse_until_evidence_accumulates():
    assert band(2.0, n_effective=1.0) == "attempted"
    assert band(2.0, n_effective=9.0) == "mastered"


def test_diagram_evidence_alone_can_never_certify_mastery():
    """The ceiling, which is what makes a weak channel honest and not just slow.

    Shrinking toward chance caps where repeated agreement can drive theta, so
    an unlimited run of correct diagrams accumulates real evidence and still
    stops short of the bar. Without it a channel that agrees with human raters
    barely above chance would certify mastery given enough drawings.
    """
    theta, n = 0.0, 0.5
    for _ in range(500):
        theta, n = elo_step(theta, n, outcome=1.0,
                            reliability=RELIABILITY["ink_diagram"],
                            weight=1.0, difficulty=0.0)
    assert n > MIN_EVIDENCE_FOR_BAND
    assert theta < MASTERY_THRESHOLD
    assert band(theta, n_effective=n) == "proficient"


def test_shares_merge_a_repeated_code_into_one_claim():
    assert _shares([{"code": "A", "weight": 2}, {"code": "A", "weight": 1},
                    {"code": "B", "weight": 1}]) == {"A": 0.75, "B": 0.25}


def test_unranked_concepts_split_the_turn_evenly():
    assert _shares([{"code": "A"}, {"code": "B"}]) == {"A": 0.5, "B": 0.5}
    assert _shares([{"code": "A", "weight": 0},
                    {"code": "B", "weight": "high"}]) == {"A": 0.5, "B": 0.5}


def test_shares_survive_a_malformed_payload():
    """The payload is model-authored, so every field is a maybe."""
    assert _shares([{"code": "A", "weight": -3}, {"code": "B", "weight": 1},
                    {"code": "", "weight": 5}, "not a dict",
                    {"weight": 9}]) == {"A": 0.0, "B": 1.0}
    assert _shares(None) == {}
    assert _shares([]) == {}


# ---------------------------------------------------------------------------
# Two database tests. They are slow against the remote branch, so each one
# carries a whole behaviour rather than one assertion.
# ---------------------------------------------------------------------------

RATIO = "6.RP.A.2"
UNIT_RATE = "7.RP.A.1"
NOT_A_STANDARD = "9.ZZ.Q.7"


async def _vocabulary(db, *codes: str) -> dict[str, uuid.UUID]:
    """The sole learner and a few concepts, by code.

    Migration 0003 seeds the learner and `seed_kcs` fills the vocabulary; the
    test schema is built straight from the metadata (conftest.db_factory), and
    nothing here needs all 480 standards.
    """
    db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
    ids = {code: uuid.uuid4() for code in codes}
    for code, kc_id in ids.items():
        db.add(KC(id=kc_id, code=code, title=f"title {code}",
                  description="", grade="6"))
    await db.flush()
    return ids


@requires_db
async def test_one_call_is_one_turns_evidence_split_over_its_concepts(db):
    ids = await _vocabulary(db, RATIO, UNIT_RATE)
    assert await snapshot(db, SOLE_LEARNER_ID) == ""
    assert await record(db, SOLE_LEARNER_ID, {}, turn_id=None) == 0

    payload = {
        "kind": "ink_symbolic",
        "outcome": 1.0,
        "misconception": None,
        "kcs": [
            {"code": RATIO, "weight": 2},
            {"code": RATIO, "weight": 1},
            {"code": UNIT_RATE, "weight": 1},
            {"code": NOT_A_STANDARD, "weight": 4},
        ],
    }
    assert await record(db, SOLE_LEARNER_ID, payload, turn_id=None) == 2
    await db.commit()
    db.expire_all()

    logged = {row.kc_id: row
              for row in (await db.execute(select(Observation))).scalars()}
    assert set(logged) == {ids[RATIO], ids[UNIT_RATE]}
    # Named twice, logged once: one claim about one concept, at the sum of the
    # weights it was claimed at.
    assert logged[ids[RATIO]].weight == pytest.approx(0.375)
    assert logged[ids[UNIT_RATE]].weight == pytest.approx(0.125)
    # Half the turn went to a code that does not exist, and that half is gone
    # rather than shared out among the two that resolved. A model inventing a
    # code should cost evidence, never inflate what survived into a whole turn.
    assert sum(row.weight for row in logged.values()) == pytest.approx(0.5)

    row = logged[ids[RATIO]]
    assert (row.kind, row.reliability) == ("ink_symbolic",
                                           RELIABILITY["ink_symbolic"])
    assert row.outcome == 1.0
    assert row.turn_id is None  # nullable: not every observation has a turn
    assert row.detail == payload

    state = {row.kc_id: row
             for row in (await db.execute(select(LearnerKCState))).scalars()}
    # Both moved up; the concept that carried most of the turn moved most.
    assert state[ids[RATIO]].theta > state[ids[UNIT_RATE]].theta > 0.0
    assert state[ids[RATIO]].n_effective == pytest.approx(
        0.5 + 0.375 * RELIABILITY["ink_symbolic"])
    assert state[ids[RATIO]].last_seen_at is not None
    assert state[ids[RATIO]].first_mastered_at is None

    block = await snapshot(db, SOLE_LEARNER_ID)
    # Most-evidenced concept first, and coarse: one turn cannot say more.
    assert block.splitlines() == [
        "WHAT THIS LEARNER KNOWS:",
        f"- title {RATIO} ({RATIO}): attempted",
        f"- title {UNIT_RATE} ({UNIT_RATE}): attempted",
    ]


@requires_db
async def test_mastery_is_dated_once_and_outlives_a_later_wrong_answer(db):
    ids = await _vocabulary(db, RATIO)

    async def fold(outcome: float) -> LearnerKCState:
        assert await record(db, SOLE_LEARNER_ID, {
            "kind": "answer_verified", "outcome": outcome,
            "kcs": [{"code": RATIO, "weight": 1.0}],
        }, turn_id=None) == 1
        return (await db.execute(select(LearnerKCState))).scalar_one()

    # One right answer, however well verified, is not mastery.
    assert (await fold(1.0)).first_mastered_at is None

    state = None
    for _ in range(12):
        state = await fold(1.0)
        if state.first_mastered_at is not None:
            break
    assert state.first_mastered_at is not None
    assert band(state.theta, n_effective=state.n_effective) == "mastered"
    mastered_at = state.first_mastered_at

    # Another right answer, still mastered. The column records when the bar was
    # first cleared, so restamping it here would make every mastery date read
    # as the last time the concept came up.
    state = await fold(1.0)
    assert band(state.theta, n_effective=state.n_effective) == "mastered"
    assert state.first_mastered_at == mastered_at
    before = state.last_seen_at

    state = await fold(0.0)
    assert band(state.theta, n_effective=state.n_effective) != "mastered"
    # "Knew this in March and has since lost it" has to stay readable, so the
    # date of first mastery is never moved and never cleared.
    assert state.first_mastered_at == mastered_at
    assert state.last_seen_at > before

    await db.commit()
    db.expire_all()
    stored = await db.get(LearnerKCState, (SOLE_LEARNER_ID, ids[RATIO]))
    assert stored.first_mastered_at == mastered_at
    assert stored.last_seen_at > mastered_at
