from sqlalchemy import select

from app.config import SOLE_LEARNER_ID
from app.learner.kcs import (
    _load_seed, outer_fringe, prerequisites_of, seed_kcs,
)
from app.store.models import KC, KCEdge, Learner, LearnerKCState
from tests.conftest import requires_db


def _prerequisite_edges(edges: list[dict]) -> list[dict]:
    return [edge for edge in edges if edge["kind"] == "prerequisite"]


def test_seed_file_is_acyclic_and_populated():
    """A cycle here would hang the recursive walk in production.

    The walk carries a path guard so it cannot, but the guard turns a cycle
    into silently truncated prerequisites rather than an error, so the seed is
    checked directly: a re-seed that introduces one has to fail here, loudly,
    while someone is looking at it.

    Only `prerequisite` edges take part. `related` pairs are undirected, so
    feeding them to a topological sort would report cycles that are not there.
    """
    kcs, edges = _load_seed()
    assert len(kcs) >= 400
    codes = {kc["code"] for kc in kcs}
    assert len(codes) == len(kcs), "codes must be unique — they are the vocabulary"
    assert all(e["prereq"] in codes and e["kc"] in codes for e in edges)

    prerequisites = _prerequisite_edges(edges)
    assert len(prerequisites) >= 700

    # Kahn's algorithm: a graph with no topological order has a cycle.
    incoming = {code: 0 for code in codes}
    adjacency: dict[str, list[str]] = {}
    for edge in prerequisites:
        incoming[edge["kc"]] += 1
        adjacency.setdefault(edge["prereq"], []).append(edge["kc"])
    queue = [code for code, n in incoming.items() if n == 0]
    seen = 0
    while queue:
        node = queue.pop()
        seen += 1
        for successor in adjacency.get(node, []):
            incoming[successor] -= 1
            if incoming[successor] == 0:
                queue.append(successor)
    assert seen == len(codes), "prerequisite graph contains a cycle"


def test_related_pairs_are_stored_once_each():
    """`related` is undirected, so the source records both directions.

    The seed keeps one row per pair, endpoints in code order. Two rows would
    be two half-facts that could drift apart, and would double-count anything
    that later reads the associations.
    """
    _, edges = _load_seed()
    related = [(e["prereq"], e["kc"]) for e in edges if e["kind"] == "related"]
    assert related
    assert all(a < b for a, b in related)
    assert len(set(related)) == len(related)


async def _seed_for(db) -> int:
    """Migration 0003 seeds the learner and 0004 leaves `kcs` empty; the test
    schema is built straight from the metadata (conftest.db_factory), so both
    have to be arranged here."""
    db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
    await db.flush()
    total = await seed_kcs(db)
    await db.commit()
    return total


@requires_db
async def test_prerequisites_of_walks_transitively(db_factory):
    async with db_factory() as db:
        assert await _seed_for(db) >= 400

        direct = await prerequisites_of(db, "7.RP.A.2", depth=1)
        assert set(direct) == {"7.RP.A.1", "6.RP.A.2", "6.RP.A.3"}

        deep = await prerequisites_of(db, "7.RP.A.2", depth=3)
        assert set(direct).issubset(set(deep))
        assert len(deep) > len(direct)
        # Two hops back through 6.RP.A.2, so reachable at depth 3 and not at 1.
        assert "5.NF.B.7" in deep

        # 7.EE.B.4.a is stored as a `related` edge pointing at 7.RP.A.2 — the
        # exact shape the walk would pick up if it stopped filtering on kind.
        # An association carries no ordering, so it is not a prerequisite.
        assert "7.EE.B.4.a" not in deep


@requires_db
async def test_seed_is_idempotent(db_factory):
    async with db_factory() as db:
        first = await _seed_for(db)
        second = await seed_kcs(db)
        await db.commit()
        assert second == first

        kcs, edges = _load_seed()
        assert await db.scalar(
            select(KC.code).where(KC.code == "7.RP.A.2")
        ) == "7.RP.A.2"
        assert len((await db.execute(select(KC.id))).all()) == len(kcs)
        assert len((await db.execute(select(KCEdge.kind))).all()) == len(edges)


@requires_db
async def test_outer_fringe_needs_the_prerequisites_in_place(db_factory):
    async with db_factory() as db:
        await _seed_for(db)
        _, edges = _load_seed()
        has_prerequisites = {e["kc"] for e in _prerequisite_edges(edges)}

        # A learner we know nothing about sits at theta 0 everywhere. The
        # fringe is then the roots of the graph, and — the part worth pinning
        # down — it is not empty: a threshold at or below 0 makes every
        # concept read as already known and the answer is silently nothing.
        fresh = await outer_fringe(db, SOLE_LEARNER_ID)
        assert len(fresh) == 5
        assert not (set(fresh) & has_prerequisites)

        ids = {
            code: kc_id
            for kc_id, code in (await db.execute(
                select(KC.id, KC.code).where(KC.code.in_([
                    "7.RP.A.1", "6.RP.A.2", "6.RP.A.3", "7.RP.A.2",
                ]))
            )).all()
        }
        for code in ("7.RP.A.1", "6.RP.A.2", "6.RP.A.3"):
            db.add(LearnerKCState(
                learner_id=SOLE_LEARNER_ID, kc_id=ids[code], theta=2.0
            ))
        # Started but well short of the bar, which is what should put it at the
        # head of the fringe: closest to ready, not furthest.
        db.add(LearnerKCState(
            learner_id=SOLE_LEARNER_ID, kc_id=ids["7.RP.A.2"], theta=0.5
        ))
        await db.commit()

        assert (await outer_fringe(db, SOLE_LEARNER_ID))[0] == "7.RP.A.2"

        whole = await outer_fringe(db, SOLE_LEARNER_ID, limit=500)
        # Above the bar already: known, not ready to be learned.
        assert "7.RP.A.1" not in whole
        # Needs 7.RP.A.2, which is at 0.5 — one prerequisite short is enough.
        assert "7.RP.A.3" not in whole
