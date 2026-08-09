"""The concept vocabulary: Common Core standards and their prerequisite graph.

The vocabulary is Common Core codes because they are public, stable and
already known to every model we call, so an annotator can name a concept
without being taught a private taxonomy first. `scripts/build_kc_seed.py`
says where the seed comes from and how it was parsed.
"""
import json
import pathlib
import uuid

from sqlalchemy import ARRAY, Float, and_, cast, func, literal, select
from sqlalchemy.dialects.postgresql import UUID as PGUUID, array, insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.store.models import KC, PREREQUISITE, KCEdge, LearnerKCState

SEED = pathlib.Path(__file__).parent / "seed" / "ccss_kcs.json"

#: `theta` is a logit: the chance of getting a fresh item on the concept right
#: is 1 / (1 + exp(-theta)), so 0 is a coin flip and 1.1 is roughly 75%. That
#: is the bar `outer_fringe` treats as "knows it", and one number moves both
#: halves of the question at once — what counts as not-yet-learned, and what
#: counts as a prerequisite already in place. Tune it here.
#:
#: It must stay above zero. An unobserved concept has no state row and so
#: reads as theta 0; at a threshold of 0 nothing is *below* the bar, and the
#: query returns an empty list for every learner, forever.
MASTERY_THRESHOLD = 1.1


def _load_seed() -> tuple[list[dict], list[dict]]:
    data = json.loads(SEED.read_text())
    return data["kcs"], data["edges"]


async def seed_kcs(db: AsyncSession) -> int:
    """Idempotent. Returns the total KC count after seeding.

    Re-running after rebuilding the JSON refreshes the wording of a standard
    but never its id: observations and mastery state point at those ids, so
    the reconciliation key is `code` and a row is updated, never replaced.
    """
    kcs, edges = _load_seed()

    # One multi-row INSERT rather than 480: this runs against a remote
    # database, where the round trips cost more than the statement does.
    insert_kcs = pg_insert(KC).values([
        {
            "id": uuid.uuid4(),
            "code": entry["code"],
            "title": entry["title"],
            "description": entry["description"],
            "grade": entry["grade"],
        }
        for entry in kcs
    ])
    await db.execute(
        insert_kcs.on_conflict_do_update(
            index_elements=[KC.code],
            # `excluded` is the row the INSERT proposed; naming the columns
            # themselves here would compile to `SET title = kcs.title`, which
            # assigns a row its own value and refreshes nothing. `id` is
            # deliberately absent: it stays whatever it already was.
            set_={
                "title": insert_kcs.excluded.title,
                "description": insert_kcs.excluded.description,
                "grade": insert_kcs.excluded.grade,
            },
        )
    )

    by_code = {
        code: kc_id
        for kc_id, code in (await db.execute(select(KC.id, KC.code))).all()
    }
    # A KeyError here means the seed file references a standard it does not
    # define. The file is generated with that invariant and tested for it, so
    # failing loudly beats seeding a graph with edges quietly missing.
    await db.execute(
        pg_insert(KCEdge)
        .values([
            {
                "prereq_id": by_code[edge["prereq"]],
                "kc_id": by_code[edge["kc"]],
                "kind": edge["kind"],
            }
            for edge in edges
        ])
        .on_conflict_do_nothing(index_elements=[
            KCEdge.prereq_id, KCEdge.kc_id, KCEdge.kind,
        ])
    )
    return len(by_code)


async def prerequisites_of(
    db: AsyncSession, code: str, *, depth: int = 3,
) -> list[str]:
    """Transitive prerequisites of a standard, to `depth` hops.

    Only `prerequisite` edges are walked. A `related` edge is an undirected
    association with no ordering, so treating one as a dependency would invent
    an ordering the source never claimed.

    The `path` guard is not decoration. `depth` bounds the walk on its own,
    so the recursion terminates either way; what the guard prevents is the
    number of distinct paths within that bound growing combinatorially once
    the graph has a cycle in it, and a standard coming back as its own
    prerequisite. The seed is acyclic today, but hand-authored prerequisite
    data routinely is not — Junyi's published expert graph ships with a
    three-node cycle its loader hard-codes around.
    """
    walk = (
        select(
            KC.id.label("id"),
            literal(0).label("depth"),
            cast(array([KC.id]), ARRAY(PGUUID(as_uuid=True))).label("path"),
        )
        .where(KC.code == code)
        .cte("walk", recursive=True)
    )
    step = (
        select(
            KCEdge.prereq_id.label("id"),
            (walk.c.depth + 1).label("depth"),
            func.array_append(walk.c.path, KCEdge.prereq_id).label("path"),
        )
        .join_from(
            walk,
            KCEdge,
            and_(KCEdge.kc_id == walk.c.id, KCEdge.kind == PREREQUISITE),
        )
        .where(
            func.array_position(walk.c.path, KCEdge.prereq_id).is_(None),
            walk.c.depth < depth,
        )
    )
    walk = walk.union_all(step)

    rows = await db.execute(
        select(KC.code)
        .join_from(walk, KC, KC.id == walk.c.id)
        # Depth 0 is the standard itself, which is not its own prerequisite.
        .where(walk.c.depth > 0)
        .distinct()
    )
    return list(rows.scalars().all())


async def outer_fringe(
    db: AsyncSession,
    learner_id: uuid.UUID,
    *,
    threshold: float = MASTERY_THRESHOLD,
    limit: int = 5,
) -> list[str]:
    """What this learner is ready to learn: below `threshold` themselves, with
    every prerequisite above it.

    Standards with no prerequisites at all qualify vacuously, which is what
    makes the fringe of a learner we know nothing about the roots of the
    graph rather than the empty set.
    """
    state = aliased(LearnerKCState)
    prereq_state = aliased(LearnerKCState)
    zero = literal(0.0, Float)
    theta = func.coalesce(state.theta, zero)

    unmet_prerequisite = (
        select(literal(1))
        .select_from(KCEdge)
        .outerjoin(
            prereq_state,
            and_(
                prereq_state.kc_id == KCEdge.prereq_id,
                prereq_state.learner_id == learner_id,
            ),
        )
        .where(
            KCEdge.kc_id == KC.id,
            KCEdge.kind == PREREQUISITE,
            func.coalesce(prereq_state.theta, zero) < threshold,
        )
    )

    rows = await db.execute(
        select(KC.code)
        .outerjoin(
            state, and_(state.kc_id == KC.id, state.learner_id == learner_id)
        )
        .where(theta < threshold, ~unmet_prerequisite.exists())
        # Closest to the bar first. `code` only breaks ties, but it has to:
        # a learner with no history has hundreds of concepts at theta 0, and
        # without it `limit` would return an arbitrary handful of them.
        .order_by(theta.desc(), KC.code)
        .limit(limit)
    )
    return list(rows.scalars().all())
