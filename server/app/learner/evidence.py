"""One `record_evidence` call, turned into rows.

The boundary between a tool payload — model-authored JSON, where any field may
be absent, the wrong type, or a concept code that does not exist — and the
arithmetic in `mastery.py`, which takes floats and assumes they mean something.
Coercing rather than raising is the choice throughout: this runs inside a turn
the learner is waiting on, and a malformed annotation should cost the estimate
its accuracy, not cost the child their answer.

Writes but never commits. The caller owns the transaction, so a turn that
records evidence and then fails records none of it.
"""
import math
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.learner.mastery import elo_step, is_mastered, reliability_of
from app.store.models import KC, LearnerKCState, Observation

#: What an observation is assumed to have come through when it does not say.
#: The commonest channel and a middling one — an omission should be neither the
#: most nor the least trusted thing that could have happened.
DEFAULT_KIND = "answer_llm"

#: Difficulty is a logit on theta's scale, where ±6 is already 99.75% either
#: way. Past that it is not a hard item, it is a broken number, and left alone
#: it would make every observation a maximal surprise for as long as it stood.
DIFFICULTY_LIMIT = 6.0

#: `observations.kind` is fixed width and `kind` arrives from a tool call, so
#: an overlong one is truncated to fit rather than allowed to abort the whole
#: turn's transaction at flush. Read off the column so the two cannot drift.
_KIND_WIDTH: int = Observation.__table__.c.kind.type.length


def _as_float(value: object, default: float = 0.0) -> float:
    """A finite number out of whatever the model actually emitted.

    Non-finite is rejected, and that is the half that matters. A NaN difficulty
    makes theta NaN, and a NaN theta is worse than a crash: Postgres sorts NaN
    above every other float, so `theta >= MASTERY_THRESHOLD` is true while
    `theta < MASTERY_THRESHOLD` is false. The concept vanishes from the fringe
    and simultaneously reads as a cleared bar for everything downstream, for
    good, while `band` still calls it "familiar". One malformed number would
    unlock a subtree of the curriculum in silence.
    """
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _kind(payload: dict) -> str:
    """The channel this observation came through, as it will be stored.

    Normalised before `reliability_of` ever sees it, so the reliability written
    on the row is a pure function of the `kind` written on the row. That is
    what makes the table replayable: revise a channel's number, re-run every
    observation, get the state that number implies.
    """
    kind = payload.get("kind")
    if not isinstance(kind, str) or not kind:
        return DEFAULT_KIND
    return kind[:_KIND_WIDTH]


def _misconception(payload: dict) -> str | None:
    """The misconception label, if the model wrote one as text.

    A model describing a misconception as an object rather than a sentence is
    an entirely natural thing for a model to do, and the column is `Text`: a
    dict, a list or an int each abort the turn's transaction on the way in.
    Dropped rather than stringified, because this column gets grouped and
    counted later and `"{'type': ...}"` is not a label — and because nothing is
    actually lost, `detail` keeping the payload verbatim either way.
    """
    value = payload.get("misconception")
    return value if isinstance(value, str) and value else None


def _shares(entries: object) -> dict[str, float]:
    """Concept code -> its share of this call's evidence, summing to 1.

    One call is one turn's worth of evidence however many concepts it names, so
    a turn spread over three of them is a third of a turn each rather than
    three turns.

    A code named twice is one claim about one concept and its weights are
    summed here, so it costs one row and one update. Two half-steps are not one
    whole step — `k` shrinks between them and the second is quietly discounted
    against the first — and two rows would be one annotation logged as two
    observations.

    Weights that are all absent, zero or negative mean the caller named the
    concepts but ranked none of them, which is far likelier than a turn worth
    nothing at all; those split evenly. Individual negatives clamp to zero,
    where they read as "named, contributed nothing".
    """
    named: dict[str, float] = {}
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        code = entry.get("code")
        if not isinstance(code, str) or not code:
            continue
        named[code] = named.get(code, 0.0) + max(0.0, _as_float(entry.get("weight")))
    if not named:
        return {}
    total = sum(named.values())
    if total <= 0.0:
        return {code: 1.0 / len(named) for code in named}
    return {code: weight / total for code, weight in named.items()}


async def record(
    db: AsyncSession, learner_id: uuid.UUID, payload: dict, *,
    turn_id: uuid.UUID | None,
) -> int:
    """Log one observation per concept named, and fold each into learner state.

    Returns how many concepts were folded into state — fewer than the call
    named if it named a code outside the vocabulary, or gave one a zero share.
    """
    shares = _shares(payload.get("kcs"))
    if not shares:
        return 0

    kind = _kind(payload)
    reliability = reliability_of(kind)
    # Clamped rather than rejected: an outcome of 1.4 is an annotator being
    # emphatic, and reading it as "better than certain" would let a single turn
    # move theta further than any true answer can.
    outcome = min(1.0, max(0.0, _as_float(payload.get("outcome"))))
    difficulty = max(-DIFFICULTY_LIMIT,
                     min(DIFFICULTY_LIMIT, _as_float(payload.get("difficulty"))))
    misconception = _misconception(payload)
    # One clock reading for the whole call, so every concept a turn touched
    # carries the same `last_seen_at` and the rows sort as one event.
    now = datetime.now(timezone.utc)

    # Resolved in one round trip rather than one per concept: this runs against
    # a remote database in the middle of a turn.
    #
    # Note what the ordering buys. Shares were normalised over every code the
    # call named, including any that turn out not to exist, so an unknown code
    # simply loses its share instead of handing it to the concepts that
    # survived. A model that hallucinates one code out of three should cost us
    # a third of the evidence, not silently inflate the other two thirds into a
    # whole turn's worth.
    kc_ids = dict((await db.execute(
        select(KC.code, KC.id).where(KC.code.in_(list(shares)))
    )).all())
    if not kc_ids:
        return 0
    states = {
        state.kc_id: state
        for state in (await db.execute(
            select(LearnerKCState).where(
                LearnerKCState.learner_id == learner_id,
                LearnerKCState.kc_id.in_(list(kc_ids.values())),
            )
        )).scalars()
    }

    written = 0
    for code, weight in shares.items():
        kc_id = kc_ids.get(code)
        if kc_id is None:
            continue
        db.add(Observation(
            learner_id=learner_id, turn_id=turn_id, kc_id=kc_id, weight=weight,
            outcome=outcome, reliability=reliability, kind=kind,
            difficulty=difficulty, misconception=misconception,
            # Verbatim: the columns are what the update reads, this is
            # everything the annotator said — including fields a later version
            # of the tool adds before a column exists for them.
            detail=payload,
        ))
        if weight <= 0.0:
            # A share of zero is a mention, not evidence. It is logged above,
            # and that is all it gets: creating a state row for it would put a
            # concept nothing was actually observed about into `snapshot`
            # reading "attempted", and into every evidence gate downstream.
            continue
        state = states.get(kc_id)
        if state is None:
            # Spelled out rather than left to the column defaults, which a
            # pending row does not have: theta is read back on the next line.
            state = LearnerKCState(learner_id=learner_id, kc_id=kc_id,
                                   theta=0.0, n_effective=0.5)
            db.add(state)
        state.theta, state.n_effective = elo_step(
            state.theta, state.n_effective, outcome=outcome,
            reliability=reliability, weight=weight, difficulty=difficulty,
        )
        state.last_seen_at = now
        if (state.first_mastered_at is None
                and is_mastered(state.theta, state.n_effective)):
            # Stamped through the shared predicate rather than against the
            # threshold alone, so the date marks the moment the tutor would
            # have been told this was mastered and not a first lucky answer.
            # Set once and never moved: it is the origin of any later
            # rate-of-improvement curve, and a date that slides is not one.
            state.first_mastered_at = now
        written += 1
    return written
