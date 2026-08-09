"""The concept vocabulary: Common Core standards and their prerequisite graph.

The vocabulary is Common Core codes because they are public, stable and
already known to every model we call, so an annotator can name a concept
without being taught a private taxonomy first. `scripts/build_kc_seed.py`
says where the seed comes from and how it was parsed.
"""
import json
import logging
import pathlib
import uuid

from sqlalchemy import ARRAY, Float, and_, cast, func, literal, select
from sqlalchemy.dialects.postgresql import UUID as PGUUID, array, insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from app.learner.mastery import mastered_clause
from app.store.db import session_factory
from app.store.models import KC, PREREQUISITE, KCEdge, LearnerKCState

log = logging.getLogger(__name__)

SEED = pathlib.Path(__file__).parent / "seed" / "ccss_kcs.json"


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


async def seed_curriculum(
    *, db_factory: async_sessionmaker[AsyncSession] | None = None
) -> int | None:
    """Seed the vocabulary at startup. Returns the KC count, or None on failure.

    Every boot, and it has to be a boot rather than a migration. `0004`'s
    docstring gives the reason: the seed is 480 standards and 899 edges built
    from a checked-in JSON that is regenerated from an upstream source, and a
    migration carrying it would have to be re-opened every time that file is
    rebuilt. Migrations own the shape of the tables; this owns their contents.

    Nothing else calls `seed_kcs`, and until something did, an empty `kcs` was
    not a degraded learner model but an inert one that failed loudly at the
    model: `evidence.record` resolves the tutor's codes against this table, an
    empty table resolves none of them, and `dispatch._record_evidence` then
    answers "none of those codes are in the curriculum" to every call it will
    ever receive. The tutor reads that as "wrong codes", tries different ones,
    and spends `MAX_TOOL_ROUNDS` doing it. `mastery.snapshot` returns "" the
    whole time, so the prompt says nothing about the learner either.

    Cheap enough to repeat: two statements, both upserts keyed on the natural
    key, so re-running refreshes the wording of a standard and never its id.

    **Never raises.** For the reason `jobs.backlog_status` does not: a boot
    that cannot reach the database must still produce a process that answers
    `/health` and says what is wrong, rather than a container that exits before
    anything can be asked. The log line is the account, and the next boot
    retries.
    """
    try:
        factory = db_factory or session_factory()
        async with factory() as db:
            total = await seed_kcs(db)
            await db.commit()
    except Exception:
        log.exception(
            "could not seed the curriculum; the learner model is inert until a "
            "boot succeeds — every record_evidence call will report unknown codes"
        )
        return None
    log.info("curriculum seeded | kcs=%d", total)
    return total


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
    limit: int = 5,
) -> list[str]:
    """What this learner is ready to learn: not yet mastered themselves, with
    every prerequisite mastered.

    Standards with no prerequisites at all qualify vacuously, which is what
    makes the fringe of a learner we know nothing about the roots of the
    graph rather than the empty set.

    "Mastered" is `mastery.mastered_clause` and nothing else — the same rule
    `band` renders into the prompt. The two used to differ, and the gap was
    reachable in two observations: theta alone cleared the bar on a hard item,
    which retired that standard as a satisfied prerequisite for everything
    downstream while the tutor was still being told the learner had merely
    attempted it. A prerequisite declared satisfied on 2.4 units of evidence is
    exactly the confident-upward drift the reliability weighting exists to
    prevent. There is no `threshold` override any more for the same reason:
    half a predicate is a way for the two definitions to drift apart again.
    """
    state = aliased(LearnerKCState)
    prereq_state = aliased(LearnerKCState)
    zero = literal(0.0, Float)
    theta = func.coalesce(state.theta, zero)
    evidence = func.coalesce(state.n_effective, zero)

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
            # Coalesced to zero on both halves, which is what keeps an
            # unobserved prerequisite unmet rather than vacuously satisfied.
            ~mastered_clause(
                func.coalesce(prereq_state.theta, zero),
                func.coalesce(prereq_state.n_effective, zero),
            ),
        )
    )

    rows = await db.execute(
        select(KC.code)
        .outerjoin(
            state, and_(state.kc_id == KC.id, state.learner_id == learner_id)
        )
        .where(~mastered_clause(theta, evidence), ~unmet_prerequisite.exists())
        # Closest to the bar first. `code` only breaks ties, but it has to:
        # a learner with no history has hundreds of concepts at theta 0, and
        # without it `limit` would return an arbitrary handful of them.
        .order_by(theta.desc(), KC.code)
        .limit(limit)
    )
    return list(rows.scalars().all())
