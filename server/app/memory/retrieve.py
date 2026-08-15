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
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time as dt_time, timedelta, timezone

from sqlalchemy import Select, and_, desc, func, join, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import (
    BACKSTOP_TAIL_CHARS, SAVED_NOTES_CHAR_CAP, SEARCH_FLOOR_DISTANCE,
    WINDOW_QUIET_AFTER,
)
from app.memory.embed import embed_texts
from app.store.models import Episode, Message, MemoryAtom

#: RRF's smoothing constant, from the original TREC formulation. Tuning it is
#: low-yield; the per-ranker weights are where the gains are.
K = 60

#: Equal, as canonical RRF has them. Neither number has been measured against a
#: relevance set — there is nothing to build one from until the store has real
#: use behind it — so these are the first two to tune when there is. The comment
#: below is what an asymmetry between them costs in the meantime.
DENSE_WEIGHT = 1.0
SPARSE_WEIGHT = 1.0

#: Each arm's candidate pool. A row in neither pool cannot be fused in at all,
#: but pool size is not what decides recall: an arm's best possible
#: contribution is `weight / (K + 1)`, so a row only one arm found must outscore
#: whatever the other arm's whole pool is scoring. Equal weights make a
#: sparse-only hit at rank 1 tie the dense pool's own best row, which is what
#: keeps an exact token findable in a store far larger than this one. At 0.7 the
#: same hit would lose to every dense rank down to 27 — the pool would fill with
#: rows outranking the one answer the sparse arm exists to rescue.
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
        #
        # The distance ceiling is the relevance floor. Rank alone cannot say
        # "nothing here is about that" — some atom is always nearest — so the
        # dense arm admits only rows within `SEARCH_FLOOR_DISTANCE`, the sparse
        # arm admits only rows the query actually matches, and a query that
        # clears neither bar fuses to an empty set. That empty set is what
        # makes "Nothing on file about that." a reachable answer.
        .where(*live, MemoryAtom.embedding.is_not(None),
               distance <= SEARCH_FLOOR_DISTANCE)
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

    A `limit` above `POOL` cannot be filled: neither arm offers more rows than
    its own pool holds, and the fused set is bounded by their union.

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


#: A window's summary is whichever of the rich fields exists. `narrative` once
#: the new summarizer has run, `digest` for rows the backfill has not reached.
#: One expression, used by every reader that means "this episode has something
#: to say", so the compatibility fallback cannot be applied in one place and
#: forgotten in another.
_SUMMARIZED = or_(Episode.narrative.is_not(None), Episode.digest.is_not(None))


async def recent_episodes(
    db: AsyncSession, learner_id: uuid.UUID, *, limit: int = 20,
) -> list[Episode]:
    """The learner's last summarized windows, most recent first.

    Unsummarized episodes are skipped rather than shown empty: a row whose
    extraction has not run yet has nothing to say here, and `backstop_tail` is
    what stands in for it — the raw end of the window, so recall never waits on
    a background job. The transcripts stay where they are; `get_session` is how
    a whole one is read.
    """
    return list((await db.execute(
        select(Episode)
        .where(Episode.learner_id == learner_id, _SUMMARIZED)
        # `id` last for the same reason the retrieval arms carry it.
        .order_by(desc(Episode.closed_at), Episode.id)
        .limit(limit)
    )).scalars().all())


def relative_label(when: date, today: date) -> str:
    """"today", "yesterday", "3 days ago" — computed here, never by the model.

    Server-side because models are bad at date arithmetic: handed only ISO
    dates, a tutor asked "what did we do yesterday" has to subtract, and it
    subtracts wrong often enough to misattribute a session. The ISO date still
    rides beside this everywhere it is shown — the label resolves "yesterday",
    the date anchors the fact.

    The units coarsen as the distance grows because the label's job is the
    learner's own sense of when, not a count: nobody calls three months ago
    "97 days ago". Boundaries are day-arithmetic on dates, so the label is a
    pure function of the two dates and never of the clock.
    """
    days = (today - when).days
    if days <= 0:
        return "today"
    if days == 1:
        return "yesterday"
    if days < 14:
        return f"{days} days ago"
    if days < 61:
        return f"{days // 7} weeks ago"
    if days < 730:
        return f"{days // 30} months ago"
    return f"{days // 365} years ago"


async def explicit_notes(
    db: AsyncSession, learner_id: uuid.UUID,
) -> list[MemoryAtom]:
    """Every live note the learner asked to keep, oldest first.

    Oldest first because the block reads as a log the learner has been keeping:
    a new note lands at the bottom, and when the cap in `render_notes` bites it
    is the oldest — the top — that fall out. All of them, no similarity gate,
    no limit: being injected wholesale is the property that makes a saved note
    trustworthy, and the cap is a rendering decision, not a query.
    """
    return list((await db.execute(
        select(MemoryAtom)
        .where(MemoryAtom.learner_id == learner_id,
               MemoryAtom.valid_to.is_(None),
               MemoryAtom.explicit.is_(True))
        .order_by(MemoryAtom.valid_from, MemoryAtom.id)
    )).scalars().all())


def render_notes(
    atoms: Sequence[MemoryAtom], *, cap_chars: int = SAVED_NOTES_CHAR_CAP,
) -> str:
    """The SAVED NOTES body: one dated line per note, newest kept under the cap.

    `[YYYY-MM-DD] text`, the date being when the note was saved — which for a
    note is also when it was true. When the block would run past `cap_chars`,
    whole lines drop from the oldest end and the first line says how many are
    missing and where they still live, because a silently truncated list of
    promises reads as promises kept.
    """
    lines = [f"[{atom.valid_from:%Y-%m-%d}] {atom.text}" for atom in atoms]
    if not lines:
        return ""
    dropped = 0
    while dropped < len(lines) - 1 and \
            sum(len(line) + 1 for line in lines[dropped:]) > cap_chars:
        dropped += 1
    kept = lines[dropped:]
    if dropped:
        kept.insert(0, f"({dropped} older notes are not shown; `search_memory` "
                       "still finds them.)")
    return "\n".join(kept)


def _next_steps(episode: Episode) -> str | None:
    """The open loops as one line, whatever shape the JSONB arrived in.

    A list of strings is the contract; a bare string is a summarizer slip that
    should still render rather than vanish. Anything else has nothing legible
    in it.
    """
    steps = episode.next_steps
    if isinstance(steps, str):
        steps = [steps]
    if not isinstance(steps, list):
        return None
    parts = [str(step).strip() for step in steps if str(step).strip()]
    return "; ".join(parts) if parts else None


def episode_card(episode: Episode, *, today: date, full: bool) -> str:
    """One session window as the standing block and the tools both show it.

    One rendering for the same reason `render_digests` used to be one: the
    RECENT SESSIONS block, `search_sessions` and `get_session` can all land in
    the same context, and the same session written three ways is three things
    for a tutor to reconcile.

    The first line opens with the ISO date at column zero — that is what
    `prompt._session_count` counts — with the relative label beside it, then
    the title (or the old two-sentence digest, for rows the backfill has not
    re-summarized). `full` adds the narrative, indented so it stays visibly
    part of this card; the newest session gets it in the standing block, every
    session gets it from the tools.
    """
    label = relative_label(episode.closed_at.date(), today)
    title = (episode.title or episode.digest or "").strip()
    lines = [f"{episode.closed_at:%Y-%m-%d} ({label}) — {title}"]
    if full:
        body = (episode.narrative or "").strip()
        # When there is no narrative the digest already stood in as the title;
        # repeating it as a body would show the same sentences twice.
        if body and body != title:
            lines.extend(f"  {line}".rstrip() for line in body.splitlines())
    steps = _next_steps(episode)
    if steps:
        lines.append(f"  next: {steps}")
    return "\n".join(lines)


def render_sessions(
    episodes: Sequence[Episode], *, today: date, backstop: str | None = None,
) -> str:
    """The RECENT SESSIONS body: newest first, the newest in full.

    `episodes` is `recent_episodes`' order — newest first — and only the first
    card carries its narrative: that is the session "what did we do last time"
    is about, and five more narratives would be an archive, not a block.

    `backstop` leads when present. It is the raw tail of a window newer than
    any summary, so it *is* the newest session as far as the learner is
    concerned, and it takes the narrative's slot: the first summarized episode
    then keeps its full card too, because the backstop is a stand-in, not a
    summary.
    """
    cards = []
    if backstop:
        cards.append(backstop)
    cards.extend(
        episode_card(episode, today=today, full=index == 0)
        for index, episode in enumerate(episodes)
    )
    return "\n".join(cards)


def _tail_of(lines: Sequence[str], cap_chars: int) -> list[str]:
    """The last whole lines that fit in `cap_chars`, at least one.

    Whole lines, never a cut through one, for the reason `context.transcript`
    gives: half a learner turn reads as a learner who stopped mid-sentence.
    The one guaranteed line can exceed the cap by itself; a single enormous
    message is still a better tail than no tail.
    """
    kept: list[str] = []
    budget = cap_chars
    for line in reversed(lines):
        cost = len(line) + 1
        if kept and cost > budget:
            break
        kept.append(line)
        budget -= cost
    kept.reverse()
    return kept


def _backstop_header(when: datetime) -> str:
    """The stand-in card's first line: dated at column zero like every card,
    so `prompt._session_count` counts the window it stands in for."""
    label = relative_label(when.date(), datetime.now(timezone.utc).date())
    return (f"{when:%Y-%m-%d} ({label}) — not yet summarised; "
            "the raw end of that session:")


def _with_tail(header: str, raw: str, cap_chars: int) -> str:
    """A stand-in card: the header, then the transcript tail indented under it.

    Indented two spaces like a narrative body, and not only for looks: only a
    column-zero date opens a card, and a learner is free to type a line that
    starts with one. The indent keeps their text visibly — and countably —
    inside this card.
    """
    tail = _tail_of(raw.splitlines(), cap_chars)
    return "\n".join([header, *(f"  {line}".rstrip() for line in tail)])


async def backstop_tail(
    db: AsyncSession,
    learner_id: uuid.UUID,
    *,
    exclude_session: uuid.UUID | None = None,
    quiet_after: timedelta = WINDOW_QUIET_AFTER,
    cap_chars: int = BACKSTOP_TAIL_CHARS,
) -> str | None:
    """The raw tail of the latest quiet window, when no summary covers it yet.

    This is what makes recall independent of the background jobs: between a
    window going quiet and its summary landing — extraction pending, failed,
    or quarantined — "what did we do last time" would otherwise be answered
    from a block that simply does not mention the most recent session. The
    tail is worse prose than a narrative and infinitely better than silence.

    Two gaps can exist and they are looked for in order of recency. Messages
    no episode covers at all (recording has not run — the window watermark is
    `seq_to`, in the 1-based ordinals `Episode` documents, so uncovered means
    `seq >= seq_to`'s maximum) come first; an episode recorded but never
    summarized second. Whichever is newest wins, and neither is shown if a
    *summarized* episode is newer still — the block's first card already tells
    that story, and an older fossil must not wear the newest slot.

    `exclude_session` is the turn's own session: its messages are the
    conversation transcript already, and duplicating them here would bloat a
    stable-half block on every turn. A window in any *other* session is quiet
    the moment the learner has switched away from it — that is what makes the
    founder's session-switch-then-ask sequence work with no delay. Only a
    caller with no session of its own falls back to `quiet_after` silence.
    """
    coverage = (
        select(Episode.session_id.label("session_id"),
               func.max(Episode.seq_to).label("covered"))
        .where(Episode.learner_id == learner_id)
        .group_by(Episode.session_id)
        .subquery()
    )
    uncovered = (Message.seq >= func.coalesce(coverage.c.covered, 0),)
    if exclude_session is not None:
        scope = Message.session_id != exclude_session
    else:
        scope = Message.created_at < datetime.now(timezone.utc) - quiet_after
    window = (await db.execute(
        select(Message.session_id, func.max(Message.created_at).label("last_at"))
        .outerjoin(coverage, coverage.c.session_id == Message.session_id)
        .where(*uncovered, scope)
        .group_by(Message.session_id)
        .order_by(desc("last_at"))
        .limit(1)
    )).one_or_none()

    watermark = (await db.execute(
        select(func.max(Episode.closed_at))
        .where(Episode.learner_id == learner_id, _SUMMARIZED)
    )).scalar_one()

    if window is not None and (watermark is None or window.last_at > watermark):
        session_id, last_at = window
        covered = (await db.execute(
            select(func.coalesce(func.max(Episode.seq_to), 0))
            .where(Episode.learner_id == learner_id,
                   Episode.session_id == session_id)
        )).scalar_one()
        messages = (await db.execute(
            select(Message)
            .where(Message.session_id == session_id, Message.seq >= covered)
            .order_by(Message.seq)
        )).scalars().all()
        raw = "\n".join(f"{message.role}: {message.text}" for message in messages)
        return _with_tail(_backstop_header(last_at), raw, cap_chars)

    # No uncovered messages newer than the last summary. The other gap: the
    # newest recorded window itself has no summary — extraction pending or
    # quarantined — so its frozen transcript stands in.
    newest = (await db.execute(
        select(Episode)
        .where(Episode.learner_id == learner_id)
        .order_by(desc(Episode.closed_at), Episode.id)
        .limit(1)
    )).scalars().first()
    if newest is None or newest.narrative is not None or newest.digest is not None:
        return None
    if watermark is not None and newest.closed_at <= watermark:
        return None
    return _with_tail(_backstop_header(newest.closed_at), newest.transcript,
                      cap_chars)


# ---------------------------------------------------------------------------
# The archive: what the tools read. Everything below serves a model-initiated
# call, never the standing block — the split the whole design turns on.
# ---------------------------------------------------------------------------


def _day_start(day: date) -> datetime:
    return datetime.combine(day, dt_time.min, tzinfo=timezone.utc)


def _between(column, date_from: date | None, date_to: date | None) -> list:
    """Inclusive date-range filters on a timestamptz column, UTC days.

    `date_to` is inclusive of the whole day named — a learner saying "up to
    Tuesday" means Tuesday too — which is why the upper bound is the start of
    the following day, strictly less than.
    """
    clauses = []
    if date_from is not None:
        clauses.append(column >= _day_start(date_from))
    if date_to is not None:
        clauses.append(column < _day_start(date_to) + timedelta(days=1))
    return clauses


def _episode_text_fts():
    """The sparse arm's document for an episode: title and narrative together.

    Computed per query rather than stored, unlike `messages.fts` and
    `memory_atoms.fts`: those tables are searched by every turn's tools over
    every row, while episodes number in the hundreds and the store would need
    a migration W does not make. The day this shows up in a query plan, a
    generated column is the fix.
    """
    return func.to_tsvector(
        "english", func.concat_ws(" ", Episode.title, Episode.narrative)
    )


def _hybrid_episodes(
    learner_id: uuid.UUID,
    vector: list[float],
    query: str,
    *,
    limit: int,
    date_from: date | None,
    date_to: date | None,
) -> Select:
    """`_hybrid` for episode summaries: same fusion, same floors, other table.

    Dense over `narrative_embedding`, sparse over title+narrative, fused by
    rank with each arm holding its own relevance bar — see `_hybrid` for why
    the floor lives on the arms and not on the fused score. Unsummarized and
    quarantined episodes fall out naturally: they have no embedding and no
    text for either arm to match.
    """
    scoped = [Episode.learner_id == learner_id,
              *_between(Episode.closed_at, date_from, date_to)]

    distance = Episode.narrative_embedding.cosine_distance(vector)
    dense_order = (distance, Episode.id)
    dense = (
        select(Episode.id, func.row_number().over(order_by=dense_order).label("rank"))
        .where(*scoped, Episode.narrative_embedding.is_not(None),
               distance <= SEARCH_FLOOR_DISTANCE)
        .order_by(*dense_order)
        .limit(POOL)
        .cte("dense_episodes")
    )

    tsquery = func.websearch_to_tsquery("english", query)
    relevance = func.ts_rank_cd(_episode_text_fts(), tsquery)
    sparse_order = (desc(relevance), Episode.id)
    sparse = (
        select(Episode.id, func.row_number().over(order_by=sparse_order).label("rank"))
        .where(*scoped, _episode_text_fts().bool_op("@@")(tsquery))
        .order_by(*sparse_order)
        .limit(POOL)
        .cte("sparse_episodes")
    )

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


async def search_episodes(
    db: AsyncSession,
    learner_id: uuid.UUID,
    query: str,
    *,
    limit: int = 5,
    date_from: date | None = None,
    date_to: date | None = None,
) -> tuple[list[Episode], int]:
    """The sessions most relevant to `query`, best first, and how many matched.

    The count is the second half of the answer: "3 of 11 matching sessions"
    tells a tutor there is more to ask for, where a bare three cards reads as
    all there ever was. Counted over everything either arm admits, not over
    the fused top — the fused list is the ranking, the count is the coverage.

    Same empty-query contract as `search_atoms`, same reason.
    """
    if not query.strip():
        return [], 0
    vectors = await embed_texts([query])

    rows = (await db.execute(_hybrid_episodes(
        learner_id, vectors[0], query,
        limit=limit, date_from=date_from, date_to=date_to,
    ))).all()
    ids = [row.id for row in rows]

    tsquery = func.websearch_to_tsquery("english", query)
    distance = Episode.narrative_embedding.cosine_distance(vectors[0])
    total = (await db.execute(
        select(func.count(Episode.id)).where(
            Episode.learner_id == learner_id,
            *_between(Episode.closed_at, date_from, date_to),
            or_(
                and_(Episode.narrative_embedding.is_not(None),
                     distance <= SEARCH_FLOOR_DISTANCE),
                _episode_text_fts().bool_op("@@")(tsquery),
            ),
        )
    )).scalar_one()

    if not ids:
        return [], total
    found = (await db.execute(
        select(Episode).where(Episode.id.in_(ids))
    )).scalars().all()
    by_id = {episode.id: episode for episode in found}
    return [by_id[row_id] for row_id in ids if row_id in by_id], total


@dataclass(frozen=True)
class TranscriptHit:
    """One place in the stored history where the words were actually said."""

    session_id: uuid.UUID
    seq: int
    role: str
    created_at: datetime
    #: `ts_headline`'s excerpt: the matched words marked, a few words around
    #: them kept.
    excerpt: str
    #: The line spoken just before, so the hit reads as a moment rather than a
    #: fragment. None on a session's first message.
    context_role: str | None = None
    context_text: str | None = None


#: How `ts_headline` marks and trims an excerpt. Guillemets rather than the
#: default `<b>` tags because the excerpt lands in a prose tool answer, where
#: HTML reads as noise and a model may echo it at the learner.
_HEADLINE_OPTIONS = "StartSel=«, StopSel=», MaxFragments=2, MaxWords=14, MinWords=5"


async def search_transcripts(
    db: AsyncSession,
    query: str,
    *,
    limit: int = 8,
    date_from: date | None = None,
    date_to: date | None = None,
) -> tuple[list[TranscriptHit], int]:
    """Every stored utterance, full-text searched. The founder's requirement.

    Nothing ages out: `messages` is append-only and its generated `fts` column
    covers every row ever written, so "find where I said X" is a query however
    old X is. Keyword search only, deliberately — this tool exists to find the
    exact place exact words were said, and `search_sessions` is the arm that
    handles paraphrase.

    No learner filter because `messages` carries none: sessions belong to the
    sole learner (`config.SOLE_LEARNER_ID`), and the day a second learner
    exists, sessions grow an owner and this grows a join.

    Ranked by cover density, newest first among ties — two hits saying the
    same thing should lead with the one the learner remembers saying.
    """
    if not query.strip():
        return [], 0
    tsquery = func.websearch_to_tsquery("english", query)
    scoped = [Message.fts.bool_op("@@")(tsquery),
              *_between(Message.created_at, date_from, date_to)]
    relevance = func.ts_rank_cd(Message.fts, tsquery)
    rows = (await db.execute(
        select(
            Message.session_id, Message.seq, Message.role, Message.created_at,
            func.ts_headline("english", Message.text, tsquery,
                             _HEADLINE_OPTIONS).label("excerpt"),
        )
        .where(*scoped)
        .order_by(desc(relevance), desc(Message.created_at), Message.id)
        .limit(limit)
    )).all()
    total = (await db.execute(
        select(func.count(Message.id)).where(*scoped)
    )).scalar_one()

    # The line before each hit, fetched as one round trip for all of them.
    wanted = [(row.session_id, row.seq - 1) for row in rows if row.seq > 0]
    context: dict[tuple[uuid.UUID, int], tuple[str, str]] = {}
    if wanted:
        for prev in (await db.execute(
            select(Message.session_id, Message.seq, Message.role, Message.text)
            .where(tuple_(Message.session_id, Message.seq).in_(wanted))
        )).all():
            context[(prev.session_id, prev.seq)] = (prev.role, prev.text)

    hits = []
    for row in rows:
        before = context.get((row.session_id, row.seq - 1))
        hits.append(TranscriptHit(
            session_id=row.session_id, seq=row.seq, role=row.role,
            created_at=row.created_at, excerpt=row.excerpt,
            context_role=before[0] if before else None,
            context_text=before[1] if before else None,
        ))
    return hits, total


async def episodes_at(
    db: AsyncSession, learner_id: uuid.UUID, value: str,
) -> list[Episode] | None:
    """The episodes one `get_session` reference names. None: the reference
    itself was unintelligible, which is a different answer from "nothing there".

    An offset counts sessions back through the same newest-first order the
    RECENT SESSIONS block shows — "0" is the block's top card, "2" is two
    below it — so the tutor can point at what it can already see. A sign is
    tolerated because "-1" for "one back" is a model slip with an obvious
    meaning.

    A date returns *every* window recorded that day, oldest first: the device
    reopens one session across a day, and a learner asking about "Tuesday"
    means the day's work, not whichever fragment of it closed first.
    """
    value = value.strip()
    if value.lstrip("+-").isdigit():
        offset = abs(int(value))
        episode = (await db.execute(
            select(Episode)
            .where(Episode.learner_id == learner_id)
            .order_by(desc(Episode.closed_at), Episode.id)
            .offset(offset)
            .limit(1)
        )).scalars().first()
        return [episode] if episode is not None else []
    try:
        day = date.fromisoformat(value)
    except ValueError:
        return None
    return list((await db.execute(
        select(Episode)
        .where(Episode.learner_id == learner_id,
               *_between(Episode.closed_at, day, day))
        .order_by(Episode.closed_at, Episode.id)
    )).scalars().all())


async def list_episodes(
    db: AsyncSession,
    learner_id: uuid.UUID,
    *,
    limit: int,
    before: date | None = None,
) -> list[Episode]:
    """A page of the session history, newest first, older than `before`.

    Includes unsummarized and quarantined windows — a browse is an inventory,
    and a row shown as "(not yet summarised)" is more honest than a gap where
    a session the learner remembers should be. `before` is the whole
    pagination scheme: the caller passes the oldest date it was shown and gets
    the page behind it, which unlike an offset cannot skip or repeat a row
    when a new session lands between two calls.
    """
    filters = [Episode.learner_id == learner_id]
    if before is not None:
        filters.append(Episode.closed_at < _day_start(before))
    return list((await db.execute(
        select(Episode)
        .where(*filters)
        .order_by(desc(Episode.closed_at), Episode.id)
        .limit(limit)
    )).scalars().all())
