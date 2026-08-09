import uuid

import pytest
from sqlalchemy import select

from app.config import SOLE_LEARNER_ID
from app.learner.evidence import DEFAULT_KIND, _kind, _shares, record
from app.learner.mastery import (
    RELIABILITY, UNKNOWN_RELIABILITY, band, elo_step, is_mastered,
    reliability_of, snapshot,
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
    """A turn touching two concepts must not count as full evidence for both.

    Measured as movement from where theta started, and starting somewhere other
    than zero: at theta 0 the two deltas are the two thetas, so the halving
    would read as proved by an implementation that ignored `weight` entirely
    and merely happened to be linear.
    """
    start = 0.7
    whole, _ = elo_step(start, 0.5, outcome=1.0, reliability=0.95,
                        weight=1.0, difficulty=0.0)
    half, _ = elo_step(start, 0.5, outcome=1.0, reliability=0.95,
                       weight=0.5, difficulty=0.0)
    assert half - start == pytest.approx((whole - start) / 2, rel=1e-6)


def test_diagram_evidence_is_weakest():
    assert RELIABILITY["ink_diagram"] < RELIABILITY["ink_symbolic"]
    assert RELIABILITY["ink_symbolic"] < RELIABILITY["answer_verified"]


def test_a_correct_observation_never_lowers_an_established_estimate():
    """Reliability scales the step, and this is what that buys.

    Scaling the *target* instead makes the shrunken outcome an attractor: five
    correct diagrams at theta 1.5 used to leave it at 1.2487, three wrong ones
    at theta -2.0 used to raise it to -1.758, and a channel worth nothing moved
    theta rather than leaving it alone.
    """
    for reliability in RELIABILITY.values():
        raised, _ = elo_step(1.5, 4.0, outcome=1.0, reliability=reliability,
                             weight=1.0, difficulty=0.0)
        lowered, _ = elo_step(-2.0, 4.0, outcome=0.0, reliability=reliability,
                              weight=1.0, difficulty=0.0)
        assert raised > 1.5
        assert lowered < -2.0
    assert elo_step(2.0, 4.0, outcome=1.0, reliability=0.0,
                    weight=1.0, difficulty=0.0) == (2.0, 4.0)


def test_weak_channels_need_far_more_of_the_same_evidence():
    """Where "diagrams inform but never decide" actually lives.

    Not a cap on theta — theta has none — but the rate `n_effective` accrues,
    which is `weight * reliability`, against a gate that does not move.
    """
    def folds_to_mastery(reliability: float) -> int:
        theta, n = 0.0, 0.5
        for count in range(1, 201):
            theta, n = elo_step(theta, n, outcome=1.0, reliability=reliability,
                                weight=1.0, difficulty=0.0)
            if band(theta, n_effective=n) == "mastered":
                return count
        raise AssertionError("never reached mastery")

    verified = folds_to_mastery(RELIABILITY["answer_verified"])
    diagrams = folds_to_mastery(RELIABILITY["ink_diagram"])
    assert verified < 10
    assert diagrams > 2 * verified


def test_extreme_inputs_stay_finite_and_still_mean_something():
    """A replay may hand this anything the log holds, and `math.exp` gives up
    past ~709 — one OverflowError mid-turn costs a child their answer.

    Saturating returns right answers and not merely finite ones. An item far
    beyond the learner is predicted wrong, so failing it carries no information
    and passing it carries a great deal; an item far beneath them is the same
    the other way round.
    """
    beyond_and_wrong, n = elo_step(0.0, 0.5, outcome=0.0, reliability=0.95,
                                   weight=1.0, difficulty=10_000.0)
    assert beyond_and_wrong == pytest.approx(0.0, abs=1e-12)
    assert n == pytest.approx(1.45)
    beyond_and_right, _ = elo_step(0.0, 0.5, outcome=1.0, reliability=0.95,
                                   weight=1.0, difficulty=10_000.0)
    assert beyond_and_right > 0.5
    beneath_and_wrong, _ = elo_step(0.0, 0.5, outcome=0.0, reliability=0.95,
                                    weight=1.0, difficulty=-10_000.0)
    assert beneath_and_wrong < -0.5


def test_band_is_coarse_until_evidence_accumulates():
    assert band(2.0, n_effective=1.0) == "attempted"
    assert band(2.0, n_effective=9.0) == "mastered"


@pytest.mark.parametrize("theta,n_effective", [
    (2.0, 9.0), (2.0, 1.0), (1.0, 9.0), (1.1, 5.0), (1.1, 4.99), (-3.0, 9.0),
])
def test_band_and_the_mastery_predicate_cannot_disagree(theta, n_effective):
    """`outer_fringe` asks the SQL spelling of `is_mastered` and the prompt
    reads `band`. A learner cannot be told one thing and planned for as
    another, which means these two answer together or the split is back."""
    assert is_mastered(theta, n_effective) == (
        band(theta, n_effective=n_effective) == "mastered")


def test_an_unrecognised_channel_is_trusted_less_than_a_real_one():
    """Most often a model inventing an enum member. Not knowing how a piece of
    evidence was obtained must not buy more trust than naming a channel."""
    assert reliability_of("vibes") == UNKNOWN_RELIABILITY
    assert reliability_of("ink_symbolic") == RELIABILITY["ink_symbolic"]
    louder = [kind for kind, value in RELIABILITY.items()
              if value > UNKNOWN_RELIABILITY]
    assert set(RELIABILITY) - set(louder) == {"ink_diagram"}


def test_kind_defaults_and_fits_its_column():
    width = Observation.__table__.c.kind.type.length
    assert _kind({}) == DEFAULT_KIND
    assert _kind({"kind": ""}) == DEFAULT_KIND
    assert _kind({"kind": {"channel": "ink"}}) == DEFAULT_KIND
    assert _kind({"kind": "x" * (width + 20)}) == "x" * width


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
    assert _shares([{"code": "A", "weight": float("nan")},
                    {"code": "B", "weight": float("inf")}]) == {"A": 0.5, "B": 0.5}
    assert _shares(None) == {}
    assert _shares([]) == {}


# ---------------------------------------------------------------------------
# Three database tests. They are slow against the remote branch, so each one
# carries a whole behaviour rather than one assertion.
# ---------------------------------------------------------------------------

RATIO = "6.RP.A.2"
UNIT_RATE = "7.RP.A.1"
MENTIONED = "5.NF.B.7"
NOT_A_STANDARD = "9.ZZ.Q.7"

OTHER_LEARNER_ID = uuid.UUID("00000000-0000-4000-8000-0000000000ff")


async def _vocabulary(db, *codes: str) -> dict[str, uuid.UUID]:
    """The sole learner, a second learner, and a few concepts by code.

    Migration 0003 seeds the learner and `seed_kcs` fills the vocabulary; the
    test schema is built straight from the metadata (conftest.db_factory), and
    nothing here needs all 480 standards.

    The second learner exists to be left alone. Production has exactly one
    learner, so every `learner_id` filter in this package is unexercised by
    construction — drop one and nothing fails. This one holds a
    heavily-evidenced state row on the first concept, which is the one the
    tests below also write to, so anything reading or writing across learners
    shows up immediately and at the top of the ordering.
    """
    db.add_all([Learner(id=SOLE_LEARNER_ID, display_name="me"),
                Learner(id=OTHER_LEARNER_ID, display_name="someone else")])
    ids = {code: uuid.uuid4() for code in codes}
    for code, kc_id in ids.items():
        db.add(KC(id=kc_id, code=code, title=f"title {code}",
                  description="", grade="6"))
    db.add(LearnerKCState(learner_id=OTHER_LEARNER_ID, kc_id=ids[codes[0]],
                          theta=3.0, n_effective=20.0))
    await db.flush()
    return ids


@requires_db
async def test_one_call_is_one_turns_evidence_split_over_its_concepts(db):
    ids = await _vocabulary(db, RATIO, UNIT_RATE, MENTIONED)
    assert await record(db, SOLE_LEARNER_ID, {}, turn_id=None) == 0

    payload = {
        "kind": "ink_symbolic",
        "outcome": 1.4,
        "misconception": {"label": "inverts the unit rate"},
        "difficulty": 500.0,
        "kcs": [
            {"code": RATIO, "weight": 2},
            {"code": RATIO, "weight": 1},
            {"code": UNIT_RATE, "weight": 1},
            {"code": MENTIONED, "weight": -3},
            {"code": NOT_A_STANDARD, "weight": 4},
        ],
    }
    assert await record(db, SOLE_LEARNER_ID, payload, turn_id=None) == 2
    await db.commit()
    db.expire_all()

    logged = {row.kc_id: row
              for row in (await db.execute(select(Observation))).scalars()}
    assert set(logged) == {ids[RATIO], ids[UNIT_RATE], ids[MENTIONED]}
    # Named twice, logged once: one claim about one concept, at the sum of the
    # weights it was claimed at.
    assert logged[ids[RATIO]].weight == pytest.approx(0.375)
    assert logged[ids[UNIT_RATE]].weight == pytest.approx(0.125)
    assert logged[ids[MENTIONED]].weight == 0.0
    # Half the turn went to a code that does not exist, and that half is gone
    # rather than shared out among the two that resolved. A model inventing a
    # code should cost evidence, never inflate what survived into a whole turn.
    assert sum(row.weight for row in logged.values()) == pytest.approx(0.5)

    row = logged[ids[RATIO]]
    assert (row.kind, row.reliability) == ("ink_symbolic",
                                           RELIABILITY["ink_symbolic"])
    # An outcome above 1 is an annotator being emphatic, not better than
    # certain; a difficulty of 500 is a broken number, not a hard item.
    assert row.outcome == 1.0
    assert row.difficulty == 6.0
    # An object where the column wants text: dropped, and — the point — the
    # write went through rather than taking the turn down with it. Nothing is
    # lost, because `detail` keeps what the annotator said either way.
    assert row.misconception is None
    assert row.detail == payload
    assert row.turn_id is None  # nullable: not every observation has a turn

    ours = {row.kc_id: row for row in (await db.execute(
        select(LearnerKCState)
        .where(LearnerKCState.learner_id == SOLE_LEARNER_ID)
    )).scalars()}
    # A share of zero is a mention: logged above, but no state conjured for it,
    # or the concept would surface in the prompt as one we know something about.
    assert set(ours) == {ids[RATIO], ids[UNIT_RATE]}
    # Both moved up; the concept that carried most of the turn moved most.
    assert ours[ids[RATIO]].theta > ours[ids[UNIT_RATE]].theta > 0.0
    assert ours[ids[RATIO]].n_effective == pytest.approx(
        0.5 + 0.375 * RELIABILITY["ink_symbolic"])
    assert ours[ids[RATIO]].last_seen_at is not None
    assert ours[ids[RATIO]].first_mastered_at is None

    # The other learner has a row on this very concept, and it is untouched.
    theirs = await db.get(LearnerKCState, (OTHER_LEARNER_ID, ids[RATIO]))
    assert (theirs.theta, theirs.n_effective) == (3.0, 20.0)


@requires_db
async def test_mastery_is_dated_once_and_outlives_a_later_wrong_answer(db):
    ids = await _vocabulary(db, RATIO)

    async def fold(outcome: float) -> LearnerKCState:
        assert await record(db, SOLE_LEARNER_ID, {
            "kind": "answer_verified", "outcome": outcome,
            "kcs": [{"code": RATIO, "weight": 1.0}],
        }, turn_id=None) == 1
        return (await db.execute(
            select(LearnerKCState)
            .where(LearnerKCState.learner_id == SOLE_LEARNER_ID)
        )).scalar_one()

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


@requires_db
async def test_snapshot_reads_one_learners_best_evidenced_concepts(db):
    ids = await _vocabulary(db, RATIO, UNIT_RATE, MENTIONED)
    assert await snapshot(db, SOLE_LEARNER_ID) == ""

    # RATIO and UNIT_RATE carry identical evidence and can only be separated by
    # code; they are added in the opposite order to the one expected back.
    db.add_all([
        LearnerKCState(learner_id=SOLE_LEARNER_ID, kc_id=ids[UNIT_RATE],
                       theta=2.0, n_effective=7.0),
        LearnerKCState(learner_id=SOLE_LEARNER_ID, kc_id=ids[RATIO],
                       theta=-0.5, n_effective=7.0),
        LearnerKCState(learner_id=SOLE_LEARNER_ID, kc_id=ids[MENTIONED],
                       theta=2.0, n_effective=1.0),
    ])
    await db.flush()

    # Evidence decides the order, not theta: MENTIONED sits at the same theta
    # as UNIT_RATE and the lowest code of the three, and still comes last.
    assert (await snapshot(db, SOLE_LEARNER_ID)).splitlines() == [
        "WHAT THIS LEARNER KNOWS:",
        f"- title {RATIO} ({RATIO}): familiar",
        f"- title {UNIT_RATE} ({UNIT_RATE}): mastered",
        f"- title {MENTIONED} ({MENTIONED}): attempted",
    ]
    assert (await snapshot(db, SOLE_LEARNER_ID, limit=2)).splitlines()[1:] == [
        f"- title {RATIO} ({RATIO}): familiar",
        f"- title {UNIT_RATE} ({UNIT_RATE}): mastered",
    ]
    # The other learner's block is their own row and nothing else — theirs is
    # the best-evidenced row in the table, so a missing filter reads top line.
    assert (await snapshot(db, OTHER_LEARNER_ID)).splitlines()[1:] == [
        f"- title {RATIO} ({RATIO}): mastered",
    ]
