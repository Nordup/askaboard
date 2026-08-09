from sqlalchemy import select, update

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
    codes = {kc["code"] for kc in kcs}
    assert len(codes) == len(kcs), "codes must be unique — they are the vocabulary"
    assert all(e["prereq"] in codes and e["kc"] in codes for e in edges)

    prerequisites = _prerequisite_edges(edges)
    # Exact, not lower bounds. The builder walks three joined tables to
    # assemble every code, and a bound loose enough to be safe is loose
    # enough to accept a parse that silently dropped a fifth of the graph.
    assert len(kcs) == 480
    assert len(prerequisites) == 757
    assert len(edges) - len(prerequisites) == 142

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


def test_codes_and_grades_come_out_of_the_three_way_join():
    """The source carries no Common Core code and no grade on a standard.

    Both are assembled by walking standard -> cluster -> domain, which is the
    most fragile part of the parser and the part that fails quietly: a wrong
    join still produces plausible-looking codes. These three pin the three
    shapes a grade can take, each from a standard whose code is unmistakable.
    """
    kcs, _ = _load_seed()
    grades = {kc["code"]: kc["grade"] for kc in kcs}
    assert grades["K.CC.A.1"] == "K"
    assert grades["7.RP.A.2"] == "7"
    assert grades["HSA-APR.A.1"] == "HS"
    assert set(grades.values()) == {"K", "1", "2", "3", "4", "5", "6", "7", "8", "HS"}


def test_exponents_survive_the_html_strip():
    """`<sup>` is 61 descriptions' worth of arithmetic, not decoration.

    Flattening the tag the way the surrounding paragraphs and anchors are
    flattened leaves `3 2 × 3 –5`, which is not what the standard says. An
    annotator reads these to reason about the maths.
    """
    kcs, _ = _load_seed()
    described = {kc["code"]: kc["description"] for kc in kcs}
    assert "3^2 × 3^(–5) = 3^(–3)" in described["8.EE.A.1"]
    # Parenthesised because `5^1/3` is (5^1)/3, a different number.
    assert "5^(1/3) to be the cube root of 5" in described["HSN-RN.A.1"]
    # The other use of <sup> is a footnote marker's sentence, not an exponent.
    assert "^*" not in described["1.OA.B.3"]
    assert "*Students need not use formal terms" in described["1.OA.B.3"]


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
        assert await _seed_for(db) == 480

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
async def test_the_walk_survives_a_cycle(db_factory):
    """The path guard needs its own test, because the seed cannot give it one.

    `test_seed_file_is_acyclic_and_populated` guards the data; this guards the
    code. With an acyclic seed the guard can be deleted outright and every
    other test here still passes, so the cycle has to be introduced on purpose.
    """
    async with db_factory() as db:
        await _seed_for(db)
        before = set(await prerequisites_of(db, "7.RP.A.2", depth=6))

        ids = {
            code: kc_id
            for kc_id, code in (await db.execute(
                select(KC.id, KC.code).where(KC.code.in_(["7.RP.A.2", "6.RP.A.2"]))
            )).all()
        }
        # 6.RP.A.2 is already a prerequisite of 7.RP.A.2; this closes the loop.
        db.add(KCEdge(
            prereq_id=ids["7.RP.A.2"], kc_id=ids["6.RP.A.2"], kind="prerequisite"
        ))
        await db.commit()

        after = await prerequisites_of(db, "7.RP.A.2", depth=6)
        # A standard is not its own prerequisite. Without the guard the walk
        # goes back around the loop and emits the node it started from.
        assert "7.RP.A.2" not in after
        # And nothing else changes: the only new arc leads back to the start.
        assert set(after) == before


@requires_db
async def test_seed_is_idempotent(db_factory):
    async with db_factory() as db:
        first = await _seed_for(db)
        original_id = await db.scalar(select(KC.id).where(KC.code == "7.RP.A.2"))

        # As if the seed had been rebuilt with a better parser: same code,
        # different wording. Re-seeding has to carry the new text across.
        await db.execute(
            update(KC).where(KC.code == "7.RP.A.2").values(title="stale")
        )
        await db.commit()

        second = await seed_kcs(db)
        await db.commit()
        assert second == first

        kcs, edges = _load_seed()
        db.expire_all()
        stored = (await db.execute(
            select(KC).where(KC.code == "7.RP.A.2")
        )).scalar_one()
        assert stored.title == next(
            kc["title"] for kc in kcs if kc["code"] == "7.RP.A.2"
        )
        # Observations and mastery state point at this id, so a re-seed
        # updates the row it found by code and never replaces it.
        assert stored.id == original_id
        assert len((await db.execute(select(KC.id))).all()) == len(kcs)
        assert len((await db.execute(select(KCEdge.kind))).all()) == len(edges)


@requires_db
async def test_outer_fringe_needs_the_prerequisites_in_place(db_factory):
    async with db_factory() as db:
        await _seed_for(db)
        _, edges = _load_seed()
        has_prerequisites = {e["kc"] for e in _prerequisite_edges(edges)}

        # A learner we know nothing about has no state rows at all. The fringe
        # is then the roots of the graph, and — the part worth pinning down —
        # it is not empty: every concept coalesces to no evidence and no
        # ability, which has to read as not-yet-learned rather than as known.
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
                learner_id=SOLE_LEARNER_ID, kc_id=ids[code],
                theta=2.0, n_effective=9.0,
            ))
        # Started but well short of the bar, which is what should put it at the
        # head of the fringe: closest to ready, not furthest.
        db.add(LearnerKCState(
            learner_id=SOLE_LEARNER_ID, kc_id=ids["7.RP.A.2"],
            theta=0.5, n_effective=6.0,
        ))
        await db.commit()

        assert (await outer_fringe(db, SOLE_LEARNER_ID))[0] == "7.RP.A.2"

        whole = await outer_fringe(db, SOLE_LEARNER_ID, limit=500)
        # Above the bar already: known, not ready to be learned.
        assert "7.RP.A.1" not in whole
        # Needs 7.RP.A.2, which is at 0.5 — one prerequisite short is enough.
        assert "7.RP.A.3" not in whole

        # Evidence, not theta alone. Mastery here is `mastery.mastered_clause`,
        # the same rule the prompt renders through `band`, and it takes both
        # halves: with only theta consulted, a standard that cleared the bar on
        # a couple of lucky answers retired every prerequisite depending on it
        # while the tutor was still being told the learner had merely attempted
        # it. 6.RP.A.2 keeps its theta of 2.0 and loses its evidence.
        thin = await db.get(LearnerKCState, (SOLE_LEARNER_ID, ids["6.RP.A.2"]))
        thin.n_effective = 2.0
        await db.commit()
        assert "7.RP.A.2" not in await outer_fringe(
            db, SOLE_LEARNER_ID, limit=500
        )
