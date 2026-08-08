"""Finding the facts a question is actually about.

Hybrid, because the two halves fail on opposite inputs. Dense retrieval smears
exact tokens: `3/4`, `x²`, an exam board's name, "the Tuesday problem" all land
in the general neighbourhood of their topic and no nearer, because putting a
sentence near its topic is what an embedding is for. Keyword search finds those
exactly and misses every paraphrase — "reducing a ratio to lowest terms" shares
not one stem with "simplifies fractions confidently". A learner's store is asked
both kinds of question, often in the same turn.

Reciprocal rank fusion combines the two on *ranks* rather than scores, and that
is the only reason their results can be added together at all. A cosine distance
and a `ts_rank_cd` are numbers on unrelated scales with unrelated distributions;
any constant mapping one onto the other would be a guess that stops holding as
the store grows. A row's position in a ranked list needs no such mapping.
"""

import uuid

from sqlalchemy import Select, desc, func, join, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.memory.embed import embed_texts
from app.store.models import Episode, MemoryAtom

#: RRF's smoothing constant, from the original TREC formulation. Tuning it is
#: low-yield; tuning the per-ranker weights below is where the gains are.
K = 60
DENSE_WEIGHT = 1.0
SPARSE_WEIGHT = 0.7

#: Each arm's candidate pool. A row outside both pools cannot be fused in, so
#: this is the true recall ceiling — keep it well above the final limit.
POOL = 50


def _hybrid(learner_id: uuid.UUID, vector: list[float], query: str, limit: int) -> Select:
    """One statement: two ranked pools over the same rows, fused by rank.

    Built through Core rather than as `text()` SQL because the test suite runs
    every model through `schema_translate_map` (see `conftest.db_factory`),
    which rewrites schema-less Table objects and does not touch raw SQL at all.
    A literal `FROM memory_atoms` here would resolve through the connection's
    search_path instead — a different schema from the one the rows are in.

    Live atoms only, in both arms. A superseded row is a fact that has stopped
    being true; the trajectory it belongs to is read deliberately elsewhere, and
    never by a tutor asking what is the case now.
    """
    live = (MemoryAtom.learner_id == learner_id, MemoryAtom.valid_to.is_(None))

    distance = MemoryAtom.embedding.cosine_distance(vector)
    # `id` last in all three orderings below. Distances tie whenever two atoms
    # sit the same way from the query and `ts_rank_cd` ties across whole bands
    # of short documents, and without a tiebreak the rows a pool keeps — and so
    # the answer — would vary between two runs of the same query.
    dense_order = (distance, MemoryAtom.id)
    dense = (
        select(MemoryAtom.id, func.row_number().over(order_by=dense_order).label("rank"))
        # An atom with no embedding has no distance from anything; it is left to
        # the sparse arm, which can still find it by its words.
        .where(*live, MemoryAtom.embedding.is_not(None))
        .order_by(*dense_order)
        .limit(POOL)
        .cte("dense")
    )

    # `websearch_to_tsquery` rather than `plainto_tsquery`: these queries are
    # written by a model and arrive with quotes, brackets and stray punctuation
    # in them, and this is the parser that treats all of that as ordinary input.
    tsquery = func.websearch_to_tsquery("english", query)
    # `ts_rank_cd` rather than `ts_rank` because atoms are one sentence long:
    # cover density rewards the terms landing close together, which is nearly
    # all the signal there is in a document this short. Neither is BM25 — there
    # is no term-frequency saturation or length normalisation in either.
    relevance = func.ts_rank_cd(MemoryAtom.fts, tsquery)
    sparse_order = (desc(relevance), MemoryAtom.id)
    sparse = (
        select(MemoryAtom.id, func.row_number().over(order_by=sparse_order).label("rank"))
        .where(*live, MemoryAtom.fts.bool_op("@@")(tsquery))
        .order_by(*sparse_order)
        .limit(POOL)
        .cte("sparse")
    )

    # FULL OUTER JOIN, so a row that only one arm found still scores: the
    # missing side contributes its COALESCE default of zero rather than
    # annihilating the row. That is also what makes an arm that matched nothing
    # at all — an empty tsquery, a table with no embeddings yet — degrade to the
    # other arm alone instead of to no results.
    fused_id = func.coalesce(dense.c.id, sparse.c.id).label("id")
    score = (
        func.coalesce(DENSE_WEIGHT / (K + dense.c.rank), 0.0)
        + func.coalesce(SPARSE_WEIGHT / (K + sparse.c.rank), 0.0)
    ).label("score")
    return (
        select(fused_id, score)
        .select_from(join(dense, sparse, dense.c.id == sparse.c.id, full=True))
        .order_by(desc(score), fused_id)
        .limit(limit)
    )


async def search_atoms(
    db: AsyncSession, learner_id: uuid.UUID, query: str, *, limit: int = 8,
) -> list[MemoryAtom]:
    """The learner's live atoms most relevant to `query`, best first.

    A query that is empty or all whitespace returns nothing. There is no
    question in it to rank against, and the alternative — embedding it and
    handing back whichever `limit` atoms that vector happened to land near — is
    an arbitrary slice of the store presented to the tutor as relevant.

    A query of nothing but stopwords or punctuation is deliberately not that
    case. `websearch_to_tsquery` reduces it to an empty tsquery which matches no
    row, so the sparse arm drops out and the result is the dense ranking alone.
    That is the right degradation: such a query still embeds, and the embedding
    of "the one from Tuesday" is not nothing even though every word in it is a
    stopword. Returning nothing would be discarding the half of the system that
    still works.

    Whatever `embed_texts` raises propagates. Callers differ on what a retrieval
    that could not run should mean — the turn's tool handler answers without
    memory rather than failing the turn, an offline pass wants it loud — and
    `embed_texts` documents why that choice is not made below the caller.
    """
    if not query.strip():
        return []
    vectors = await embed_texts([query])
    rows = (await db.execute(_hybrid(learner_id, vectors[0], query, limit))).all()
    ids = [row.id for row in rows]
    if not ids:
        return []
    found = (await db.execute(
        select(MemoryAtom).where(MemoryAtom.id.in_(ids))
    )).scalars().all()
    # `IN` returns a set in no particular order, and the fused order is the
    # whole answer — so it is reimposed here rather than assumed to survive.
    by_id = {atom.id: atom for atom in found}
    return [by_id[atom_id] for atom_id in ids if atom_id in by_id]


async def recent_episodes(
    db: AsyncSession, learner_id: uuid.UUID, *, limit: int = 20,
) -> list[Episode]:
    """The learner's last sessions, most recent first. Digests, not transcripts.

    Undigested episodes are skipped rather than shown with an empty summary:
    `digest` is NULL until the close path has written one, and a row in that
    state has nothing to say yet. The transcripts stay where they are — this is
    read to remind a tutor what has been covered lately, and no sensible number
    of full transcripts fits in that.
    """
    return list((await db.execute(
        select(Episode)
        .where(Episode.learner_id == learner_id, Episode.digest.is_not(None))
        .order_by(desc(Episode.closed_at))
        .limit(limit)
    )).scalars().all())
