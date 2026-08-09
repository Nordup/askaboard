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

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.learner.kcs import MASTERY_THRESHOLD
from app.store.models import KC, LearnerKCState

#: How far to trust each evidence channel, as a factor on how far one
#: observation may move the estimate.
#:
#: Not a scale of importance — these track measured agreement with human
#: raters. A symbolically checked answer is near-certain. Handwritten symbolic
#: work reads at roughly human inter-rater agreement (κ≈0.90). A child's
#: *diagram* does not: models agree with human raters barely above chance on
#: children's mathematical illustrations (κ≈0.20), and the ceiling described in
#: `elo_step` is what turns that number into diagram evidence being unable to
#: certify anything on its own. An explicit "I don't know" is a button press
#: rather than a judgement of the work, so what limits it is the learner
#: meaning it, not anything reading it.
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

#: How much evidence a concept needs before `band` will say anything sharper
#: than "attempted" — five or six single-concept observations on a channel we
#: mostly trust, since each contributes `weight * reliability`.
MIN_EVIDENCE_FOR_BAND = 5.0


def reliability_of(kind: str) -> float:
    """How far to trust an observation that arrived through `kind`."""
    return RELIABILITY.get(kind, UNKNOWN_RELIABILITY)


def elo_step(
    theta: float, n_effective: float, *, outcome: float, reliability: float,
    weight: float, difficulty: float,
) -> tuple[float, float]:
    """One observation folded into one concept's ability estimate.

    Returns the new `(theta, n_effective)`. `outcome` is 1 for right, 0 for
    wrong and anything between for partial credit; `weight` is how much of the
    turn this concept accounted for; `difficulty` is the item's logit, on the
    same scale as theta.

    The line worth reading twice is `effective`, which shrinks the outcome
    toward chance before it is compared with the prediction. The grader is an
    LLM reading a child's maths, and LLM graders are lopsided: on Khan's
    published benchmark of real tutoring dialogue the best model was right
    85.8% of the time when the student was correct but only 68.5% when the
    student was wrong. Taken at face value that asymmetry more than doubles the
    effective guess rate, and the estimate drifts confidently upward — deciding
    a learner has mastered what they have not. Moving an unreliable channel
    less is the correction. Moving it confidently in a possibly wrong direction
    is the failure being corrected.

    The shrink also caps the estimate, which is what keeps a weak channel
    honest rather than merely slow. Repeated correct answers drive theta to
    `difficulty + logit(0.5 + reliability / 2)` and no further, so `ink_diagram`
    tops out near 0.73 on a difficulty-0 item — under MASTERY_THRESHOLD,
    however many drawings arrive. Diagrams inform; they cannot certify.
    """
    predicted = 1.0 / (1.0 + math.exp(-(theta - difficulty)))
    effective = 0.5 + reliability * (outcome - 0.5)
    k = K0 / (1.0 + BETA * n_effective)
    return (
        theta + k * weight * (effective - predicted),
        # Evidence accrues at the rate it can be trusted, so five diagrams
        # count for less than two verified answers — which is what stops a
        # stream of weak observations unlocking `band` on its own.
        n_effective + weight * reliability,
    )


def band(theta: float, *, n_effective: float) -> str:
    """Four coarse levels, not a percentage.

    A meter reading 0.62 off two observations implies a confidence the model
    does not have, so until there is real evidence every concept reads as
    "attempted" regardless of where theta sits.

    The bar for "mastered" is `kcs.MASTERY_THRESHOLD`, shared with
    `outer_fringe`: what the tutor is told the learner knows and what the
    planner treats as a prerequisite already in place have to be one fact.
    """
    if n_effective < MIN_EVIDENCE_FOR_BAND:
        return "attempted"
    if theta >= MASTERY_THRESHOLD:
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
