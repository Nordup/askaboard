"""What we believe a learner can do, one observation at a time.

An online Elo-style update rather than a batch fit: `LearnerKCState` holds a
single number per learner per concept and each observation nudges it, so the
estimate is current the moment a turn ends and the next prompt can read it.
Nothing is given up by that — every observation is kept in `observations` with
the reliability it was folded in at, so the whole table is replayable if the
arithmetic here changes or a channel's number is revised.

The arithmetic only. `evidence.py` is what turns a tool call into calls of it.
"""
import math
import uuid

from sqlalchemy import ColumnElement, and_, desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.store.models import KC, LearnerKCState

#: How far to trust each evidence channel, as a factor on how far one
#: observation may move the estimate.
#:
#: Not a scale of importance — these track measured agreement with human
#: raters. A symbolically checked answer is near-certain. Handwritten symbolic
#: work reads at roughly human inter-rater agreement (κ≈0.90). A child's
#: *diagram* does not: models agree with human raters barely above chance on
#: children's mathematical illustrations (κ≈0.20). An explicit "I don't know"
#: is a button press rather than a judgement of the work, so what limits it is
#: the learner meaning it, not anything reading it.
#:
#: `answer_verified` says a symbolic check ran and is settable server-side
#: only; nothing taking a model's word for it may claim it. This module does
#: not police that, and deliberately: `kind` is a lookup key here and the same
#: key is used whether the payload was built by a tool call or by server code.
#: The place to enforce it is the enum the model chooses from.
RELIABILITY: dict[str, float] = {
    "answer_verified": 0.95,
    "dont_know": 0.90,
    "ink_symbolic": 0.70,
    "answer_llm": 0.70,
    "hinted": 0.60,
    "ink_diagram": 0.35,
}

#: What an unrecognised channel name is worth. Below every channel we do
#: recognise bar diagrams, and that ordering is the point: not knowing how a
#: piece of evidence was obtained must never buy more trust than naming a real
#: channel does.
UNKNOWN_RELIABILITY = 0.5

#: Opening step size, and how fast it decays with accumulated evidence. The
#: first observation about a concept moves theta by up to ~0.74 of the surprise
#: it carries; the twentieth, by ~0.2. Evidence should stop rewriting a belief
#: it has already established, but never stop being able to revise it, which is
#: why this decays rather than terminating.
K0 = 0.8
BETA = 0.15

#: `theta` is a logit: the chance of getting a fresh item on the concept right
#: is 1 / (1 + exp(-theta)), so 0 is a coin flip and 1.1 is roughly 75%. Tune
#: the bar here — one number moves both halves of the question at once, what
#: counts as not-yet-learned and what counts as a prerequisite already in
#: place.
#:
#: It no longer has to stay above zero to keep `outer_fringe` from returning
#: the empty list for every learner. That hazard — an unobserved concept has no
#: state row, so it reads as theta 0 and at a threshold of 0 nothing is below
#: the bar — is now covered by the evidence half of `is_mastered`, since an
#: unobserved concept has no evidence either. It should still sit here: this is
#: where "knows it" is a defensible claim about a fresh item.
MASTERY_THRESHOLD = 1.1

#: How much evidence a concept needs before it can be called anything sharper
#: than "attempted".
#:
#: This gate, not the reliability factor, is what stops a weak channel
#: establishing mastery. `n_effective` accrues at `weight * reliability`, so
#: five or six verified answers clear it while diagrams — 0.35 at a time — take
#: fifteen. That is the honest form of "diagrams inform but never decide": it
#: composes across channels, it degrades smoothly, and unlike a cap on theta it
#: does not quietly stop working when someone retunes a constant.
MIN_EVIDENCE_FOR_BAND = 5.0

#: Where the sigmoid is flat enough to stop computing it. See `elo_step`.
_SATURATION = 40.0


def reliability_of(kind: str) -> float:
    """How far to trust an observation that arrived through `kind`."""
    return RELIABILITY.get(kind, UNKNOWN_RELIABILITY)


def is_mastered(theta: float, n_effective: float) -> bool:
    """Both halves: the estimate has cleared the bar, and it means something.

    The single definition of mastery in this service. `band` renders it for the
    prompt and `mastered_clause` asks it of the database; neither has a rule of
    its own, because the two answering differently is a real failure and not a
    hypothetical one — see `kcs.outer_fringe`.
    """
    return n_effective >= MIN_EVIDENCE_FOR_BAND and theta >= MASTERY_THRESHOLD


def mastered_clause(
    theta: ColumnElement[float], n_effective: ColumnElement[float]
) -> ColumnElement[bool]:
    """`is_mastered` as a SQL expression, over columns a query supplies.

    Two spellings because SQLAlchemy's `and_` cannot return a Python bool and
    `and` cannot return a SQL clause. They are kept adjacent and are checked
    against each other by test, which is the part that stops them drifting.
    """
    return and_(n_effective >= MIN_EVIDENCE_FOR_BAND, theta >= MASTERY_THRESHOLD)


def elo_step(
    theta: float, n_effective: float, *, outcome: float, reliability: float,
    weight: float, difficulty: float,
) -> tuple[float, float]:
    """One observation folded into one concept's ability estimate.

    Returns the new `(theta, n_effective)`. `outcome` is 1 for right, 0 for
    wrong and anything between for partial credit; `weight` is how much of the
    turn this concept accounted for; `difficulty` is the item's logit, on the
    same scale as theta.

    Why shrink by reliability at all: the grader is an LLM reading a child's
    maths, and LLM graders are lopsided: on Khan's published benchmark of real
    tutoring dialogue the best model was right 85.8% of the time when the
    student was correct but only 68.5% when the student was wrong. Taken at
    face value that asymmetry more than doubles the effective guess rate, and
    the estimate drifts confidently upward — deciding a learner has mastered
    what they have not.

    `reliability` scales the *step*, not the target. Shrinking the target
    instead — comparing the prediction against `0.5 + reliability * (outcome -
    0.5)` — reads plausibly and is wrong: it makes the shrunken outcome an
    attractor, so a *correct* observation on a weak channel drags an
    established theta down toward chance, a *wrong* one on a badly-lagging
    concept pulls it up, and a channel worth nothing moves theta rather than
    leaving it alone. Scaling the step preserves direction — right always
    raises, wrong always lowers, `reliability=0` does nothing — which is what
    "an unreliable channel should move the estimate less" has to mean.
    """
    # Saturating rather than overflowing: math.exp gives up somewhere past 709
    # and the sigmoid is flat to within 1e-17 by ±40, so clamping the gap costs
    # nothing real and keeps this total for whatever a replay hands it.
    gap = max(-_SATURATION, min(_SATURATION, theta - difficulty))
    predicted = 1.0 / (1.0 + math.exp(-gap))
    k = K0 / (1.0 + BETA * n_effective)
    return (
        theta + k * weight * reliability * (outcome - predicted),
        # Evidence accrues at the rate it can be trusted; MIN_EVIDENCE_FOR_BAND
        # is where that rate does its work.
        n_effective + weight * reliability,
    )


def band(theta: float, *, n_effective: float) -> str:
    """Four coarse levels, not a percentage.

    A meter reading 0.62 off two observations implies a confidence the model
    does not have, so until there is real evidence every concept reads as
    "attempted" regardless of where theta sits.
    """
    if n_effective < MIN_EVIDENCE_FOR_BAND:
        return "attempted"
    if is_mastered(theta, n_effective):
        return "mastered"
    if theta >= 0.0:
        return "proficient"
    return "familiar"


async def snapshot(db: AsyncSession, learner_id: uuid.UUID, *, limit: int = 8) -> str:
    """The learner-model block for the prompt, or "" when there is nothing yet.

    Ordered by evidence, not by theta or recency: the concepts we know most
    about are the ones a claim about the learner can be made about at all, and
    `limit` has to spend its places on those. `code` only breaks ties, but it
    has to — this block is pasted into a prompt, and two rows swapping places
    for no reason rewrites text that would otherwise have been cached.
    """
    rows = (await db.execute(
        select(KC.code, KC.title, LearnerKCState.theta,
               LearnerKCState.n_effective)
        .join(LearnerKCState, LearnerKCState.kc_id == KC.id)
        .where(LearnerKCState.learner_id == learner_id)
        .order_by(desc(LearnerKCState.n_effective), KC.code)
        .limit(limit)
    )).all()
    if not rows:
        return ""
    lines = [
        f"- {row.title} ({row.code}): {band(row.theta, n_effective=row.n_effective)}"
        for row in rows
    ]
    return "WHAT THIS LEARNER KNOWS:\n" + "\n".join(lines)
