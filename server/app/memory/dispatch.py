"""The memory tools, run. One tool call in, one string back.

Answers are prose rather than the JSON status objects `app/tutor/loop.py`
gives its own tools, because most of these *are* prose: a list of facts, a
page of a transcript, a run of session cards. Wrapping those in an envelope
would cost escaping and tokens for a field nothing branches on — the model
reads the string and that is the whole protocol.

Nothing here raises. `embed_texts` documents the split deliberately: an offline
pass wants an embedding failure loud so the session can be re-run, and this
handler wants it caught so the learner still gets an answer. This is that
boundary. What each failure returns is written to stop the model drawing the
one wrong conclusion available to it — that memory was consulted and had
nothing, or that a fact was saved when it was not.

This is the second write path into `memory_atoms`, and every rule the offline
one enforces has to be enforced again here or it is not a rule. Two of them
are: the atom must carry an embedding, and a fact already on file word-for-word
is not written twice. `consolidate.py` is where each is explained; `_remember`
below is where each is repeated. The `stated` gate is deliberately NOT among
them any more — the offline extractor still drops unstated inferences, but a
`remember` call is the learner-visible act of saving, and refusing it over a
flag while the tutor says "noted" was the lie W14 names. The flag is stored
verbatim as provenance instead.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import SESSION_PAGE_CHARS
from app.learner.evidence import DEFAULT_KIND, record
from app.memory.consolidate import normalised
from app.memory.embed import embed_texts
from app.memory.retrieve import (
    TranscriptHit, episode_card, episodes_at, list_episodes, relative_label,
    search_atoms, search_episodes, search_transcripts,
)
from app.memory.schema import MemoryCategory
from app.store.models import MemoryAtom
from app.tutor.tools import MEMORY_TOOLS, SERVER_ONLY_KINDS

__all__ = ["MEMORY_TOOLS", "handle_memory_tool", "memory_handler"]

logger = logging.getLogger(__name__)

#: Each listing tool's bounds, whatever the model asked for. The upper bounds
#: are the tool descriptions' own; the lower one is because a limit of 0 or -3
#: is a model slip, and answering it with an empty listing would read as a
#: fact about the learner.
MIN_LIMIT = 1
MAX_LIST_SESSIONS = 20
MAX_SESSION_MATCHES = 5
MAX_HISTORY_MATCHES = 8

#: How much of a context line `search_history` shows. One line of situation,
#: not a second transcript: the excerpt is the hit, this is its footing, and
#: `get_session` is where whole context lives.
CONTEXT_CHARS = 160

#: One tool call, run. Every handler takes the same arguments whether it uses
#: them or not, so `_HANDLERS` can be a table rather than a chain of `if name
#: ==` — see the comment there for why that matters.
Handler = Callable[..., Awaitable[str]]


async def handle_memory_tool(
    db: AsyncSession,
    learner_id: uuid.UUID,
    name: str,
    arguments: dict,
    *,
    turn_id: uuid.UUID | None,
    session_id: uuid.UUID | None = None,
) -> str:
    """Run one memory tool call and return what the model should read.

    **Commits.** Hand it a session of its own — `memory_handler` below is what
    does that for a turn. It cannot leave the writes uncommitted the way
    `consolidate` and `record` do: those are called from a pass that owns a
    transaction spanning the whole job, whereas a tool call is answered mid-turn
    and the model is told the write landed. A "Saved." the enclosing request
    later rolls back is the exact lie the tool description forbids.
    """
    handler = _HANDLERS.get(name)
    if handler is None:
        # Unreachable through `loop._answer`, which routes on `MEMORY_TOOLS` —
        # and `test_every_offered_memory_tool_has_a_handler` is what keeps that
        # true. Here because this function is importable on its own, and a name
        # it does not know must not read as a successful no-op.
        return f"There is no tool called {name}."
    try:
        return await handler(db, learner_id, arguments,
                             turn_id=turn_id, session_id=session_id)
    except Exception:
        # Logged because this catch is broad enough to swallow a bug in the
        # code below as well as a provider outage, and a swallowed bug with no
        # trace is how a tool quietly stops working for a month. `except
        # Exception` and not bare: a client disconnect is CancelledError, a
        # BaseException, and a turn nobody is listening to should unwind rather
        # than answer.
        logger.exception("memory tool failed | tool=%s turn_id=%s", name, turn_id)
        try:
            # So a caller that does reuse the session — two memory calls in one
            # round — is not handed a poisoned one. Guarded because a rollback
            # that raises would take the learner's whole turn down, which is
            # the outcome this entire handler exists to prevent.
            await db.rollback()
        except Exception:
            logger.exception("memory tool rollback failed | tool=%s", name)
        return _FAILED[name]


#: What each tool says when it could not run. Per-tool rather than one shared
#: sentence: the wrong inference is different in each case, and naming it is
#: the whole value of the string.
_FAILED = {
    "remember": (
        "NOT saved — memory is unavailable right now. Do not tell the learner "
        "you have remembered this."
    ),
    "forget": (
        "NOT forgotten — memory is unavailable right now. Do not tell the "
        "learner the note is gone."
    ),
    "search_memory": (
        "The search could not run, so this is not a statement about what is on "
        "file. Do not tell the learner you have no memory of it."
    ),
    "search_sessions": (
        "The search could not run, so this is not a statement about what is on "
        "file. Do not tell the learner no such session exists."
    ),
    "search_history": (
        "The search could not run, so this is not a statement about what was "
        "said. Do not tell the learner it was never said."
    ),
    "get_session": "That session could not be read just now.",
    "list_sessions": "The session history could not be read just now.",
    "record_evidence": "Not recorded — the learner model is unavailable right now.",
}


async def _remember(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, *,
    turn_id: uuid.UUID | None, session_id: uuid.UUID | None, **_: object,
) -> str:
    """Write one atom the learner asked for, straight into the store.

    Deliberately not through `consolidate`. That would put an embedding call
    *and* an adjudication call on the request path, against a learner waiting
    for a reply — and the plan's standing constraint is that consolidation runs
    off it.

    What that costs, and what the checks below buy back. An atom written here
    is never adjudicated: `consolidate` only rules on the atoms handed to it,
    and an already-stored row sits on the *candidate* side of that comparison
    forever. So nothing downstream will ever notice that this tool was called
    twice on the same fact — the duplicate check here is the only one there
    will be. Supersession still works normally, because a later session's facts
    are adjudicated against this row like any other.

    The embedding is not optional either. A `MemoryAtom` with a NULL embedding
    is invisible to retrieval's dense arm and can never be selected as a
    supersession candidate, so it can never be corrected or found by meaning
    again — permanently, with nothing anywhere to notice it by. See the
    assertion and comment in `consolidate.py` that this path is the exception
    to. One embedding round trip on the request path buys that off.
    """
    # Only a string counts. `str()` on whatever arrived would file
    # `{'fact': ...}` as the learner's own words, and the column is Text so
    # nothing downstream would object.
    text = arguments.get("text")
    text = text.strip() if isinstance(text, str) else ""
    if not text:
        return "Nothing was saved: the fact was empty. Call again with the text."
    try:
        category = MemoryCategory(arguments.get("category"))
    except ValueError:
        # `ck_memory_atoms_category` would reject an invented category at
        # flush and take the turn's transaction with it. Filing it under the
        # catch-all keeps the fact, which is what the learner asked for.
        category = MemoryCategory.context

    # Deliberately no `stated` gate any more. The offline extractor still
    # drops unstated inferences — that flag exists to stop the system quietly
    # persisting guesses about the person — but a `remember` call is not
    # quiet: it is the tutor deciding, in front of the learner, that this is
    # worth keeping, and refusing it while the reply says "noted" was the lie
    # W14 names. The flag is still stored verbatim below, so a search result
    # can say whether the fact was their words or the tutor's read.

    # Checked before the embedding call, so a repeat costs no round trip. A
    # match that is not yet explicit is promoted rather than duplicated: the
    # learner asked for this exact fact to be kept, and pinning the existing
    # row into SAVED NOTES is that, without a second copy for consolidation
    # to trip over.
    if (already := await _already_stored(db, learner_id, text, category)) is not None:
        if already.explicit:
            return ("Already on file word for word in your saved notes, so "
                    "nothing was added. You can tell the learner you will "
                    "remember it.")
        already.explicit = True
        await db.commit()
        return ("Already on file word for word; it is now pinned as a saved "
                "note. You can tell the learner you will remember it.")

    vectors = await embed_texts([text])
    db.add(MemoryAtom(
        learner_id=learner_id,
        text=text,
        category=category.value,
        embedding=vectors[0],
        source_session_id=session_id,
        source_turn_ids=[turn_id] if turn_id else [],
        # Carried verbatim, never coerced — `consolidate` says why at its own
        # insert.
        stated=arguments.get("stated") is True,
        # What `remember` means now: the note is injected wholesale into
        # SAVED NOTES from the next turn on, and consolidation never offers
        # it for supersession. Only `forget` closes it.
        explicit=True,
    ))
    await db.commit()
    return ("Saved. It will be in your SAVED NOTES from the next turn. You "
            "can tell the learner you will remember it.")


async def _already_stored(
    db: AsyncSession, learner_id: uuid.UUID, text: str, category: MemoryCategory
) -> MemoryAtom | None:
    """The live atom already carrying this exact fact, by `consolidate`'s key.

    Compared in Python through the shared `normalised`, not in SQL, so the two
    write paths cannot drift on what counts as the same string — a `lower()`
    in a WHERE clause that stopped matching `casefold()` would fail silently
    and only ever in the permissive direction. The candidate set is one
    learner's live atoms in one category, which is what `profile._live_atoms`
    already reads unbounded.

    String identity, never similarity: a fact and its negation differ by one
    token, and deciding those are the same one is what `consolidate`'s
    adjudicator exists for.
    """
    rows = (await db.execute(
        select(MemoryAtom).where(
            MemoryAtom.learner_id == learner_id,
            MemoryAtom.valid_to.is_(None),
            MemoryAtom.category == category.value,
        )
    )).scalars().all()
    key = normalised(text)
    return next((row for row in rows if normalised(row.text) == key), None)


async def _forget(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, **_: object,
) -> str:
    """Close the one note the learner pointed at. The other half of W19.

    Closed — `valid_to` set — never deleted: the bi-temporal store's whole
    deal is that retraction is itself a recorded event, and a closed note
    drops out of SAVED NOTES and retrieval identically either way.

    Matching is by text because that is all the learner and the model have:
    notes carry no visible ids. Exact (normalised) match wins outright; a
    substring that lands on exactly one live atom is accepted as pointing;
    several candidates are listed rather than guessed between, because closing
    the wrong memory is strictly worse than one more round. Explicit notes are
    preferred at every step — "forget that" almost always means a note — but
    an extracted fact the learner wants gone is closable the same way.
    """
    text = arguments.get("text")
    text = text.strip() if isinstance(text, str) else ""
    if not text:
        return ("Nothing was forgotten: say which note, word for word or by a "
                "distinctive phrase from it.")
    rows = (await db.execute(
        select(MemoryAtom).where(
            MemoryAtom.learner_id == learner_id,
            MemoryAtom.valid_to.is_(None),
        )
        # Explicit notes first, then oldest first, so ties resolve toward the
        # thing "forget that note" most plausibly names — deterministically.
        .order_by(MemoryAtom.explicit.desc(), MemoryAtom.valid_from, MemoryAtom.id)
    )).scalars().all()
    key = normalised(text)
    matches = [row for row in rows if normalised(row.text) == key]
    if not matches:
        contains = [row for row in rows if key in normalised(row.text)]
        explicit_contains = [row for row in contains if row.explicit]
        if len(explicit_contains) == 1:
            matches = explicit_contains
        elif len(contains) == 1:
            matches = contains
        elif contains:
            listed = "\n".join(f"- {row.text}" for row in contains[:5])
            return ("That matches more than one note, so nothing was "
                    f"forgotten. Which one?\n{listed}\nCall again with the "
                    "exact text.")
    if not matches:
        return ("No note on file matches that, so nothing was forgotten. "
                "`search_memory` can find its exact wording.")
    now = datetime.now(timezone.utc)
    for row in matches:
        row.valid_to = now
        row.invalidated_at = now
    await db.commit()
    return f"Forgotten: {matches[0].text} You can tell the learner it is gone."


def _query_of(arguments: dict) -> str:
    query = arguments.get("query")
    return query.strip() if isinstance(query, str) else ""


#: What every searching handler answers an empty query with. Distinguished
#: from "nothing on file" on purpose: an empty query is the model's slip and
#: is worth one more round; a miss is not.
_EMPTY_QUERY = ("The query was empty, so nothing was searched. Ask again with "
                "a self-contained question.")


def _limit_of(arguments: dict, ceiling: int) -> int:
    """The listing bound, clamped into range whatever the model sent.

    `int()` on a float rather than a cast on whatever arrived: strict schemas
    do not stop a model emitting 5.0, and a non-number falls back to the top
    of the range rather than costing the round.
    """
    raw = arguments.get("limit")
    limit = int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) \
        else ceiling
    return max(MIN_LIMIT, min(ceiling, limit))


def _date_of(arguments: dict, key: str) -> date | str | None:
    """The date filter under `key`: a date, None for absent/null, or an error
    sentence for the model when the string would not parse.

    The error costs a round; silently dropping a filter the model set would
    cost a wrong answer presented as a filtered one, which is worse.
    """
    raw = arguments.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return date.fromisoformat(raw.strip())
    except ValueError:
        return (f"The {key} {raw!r} is not a date, so nothing was searched. "
                "Use YYYY-MM-DD, or null for no bound.")


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _atom_line(atom: MemoryAtom) -> str:
    """One fact, dated and attributed — what lets the tutor say "you told me
    this on the 14th" instead of asserting facts from nowhere (W9)."""
    line = f"- [{atom.valid_from:%Y-%m-%d}] [{atom.category}] {atom.text}"
    if atom.explicit:
        line += " (a saved note)"
    elif not atom.stated:
        line += " (tutor's inference, not their words)"
    return line


async def _search_memory(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, **_: object
) -> str:
    query = _query_of(arguments)
    if not query:
        return _EMPTY_QUERY
    hits = await search_atoms(db, learner_id, query)
    if not hits:
        # Reachable now that both retrieval arms carry a relevance bar
        # (`SEARCH_FLOOR_DISTANCE`), and exactly the sentence the tool
        # description licenses the tutor to pass on.
        return "Nothing on file about that."
    return "\n".join(_atom_line(hit) for hit in hits)


async def _search_sessions(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, **_: object
) -> str:
    query = _query_of(arguments)
    if not query:
        return _EMPTY_QUERY
    date_from = _date_of(arguments, "date_from")
    if isinstance(date_from, str):
        return date_from
    date_to = _date_of(arguments, "date_to")
    if isinstance(date_to, str):
        return date_to
    episodes, total = await search_episodes(
        db, learner_id, query,
        limit=_limit_of(arguments, MAX_SESSION_MATCHES),
        date_from=date_from, date_to=date_to,
    )
    if not episodes:
        return ("No past sessions match that. `search_history` searches the "
                "raw transcripts word by word, and `list_sessions` browses "
                "everything in order.")
    today = _today()
    # The card is `episode_card` with the narrative in full — a search hit is
    # exactly the case where the whole summary is wanted — and each carries
    # its provenance line so the tutor can cite the session rather than
    # asserting from nowhere.
    cards = [
        "\n".join([
            episode_card(episode, today=today, full=True),
            f"  (from the session of {episode.closed_at:%Y-%m-%d}; "
            f"get_session reads its full transcript)",
        ])
        for episode in episodes
    ]
    return "\n".join(
        [f"{total} session(s) match; showing the top {len(episodes)}:", *cards]
    )


def _hit_lines(hit: TranscriptHit) -> str:
    lines = [f"- {hit.created_at:%Y-%m-%d}, {hit.role}: {hit.excerpt}"]
    if hit.context_text is not None:
        context = hit.context_text.replace("\n", " ")
        if len(context) > CONTEXT_CHARS:
            context = context[:CONTEXT_CHARS] + "…"
        lines.append(f"  (just after {hit.context_role}: {context})")
    lines.append(
        f"  (get_session with \"{hit.created_at:%Y-%m-%d}\" reads that "
        "session in full)"
    )
    return "\n".join(lines)


async def _search_history(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, **_: object
) -> str:
    query = _query_of(arguments)
    if not query:
        return _EMPTY_QUERY
    date_from = _date_of(arguments, "date_from")
    if isinstance(date_from, str):
        return date_from
    date_to = _date_of(arguments, "date_to")
    if isinstance(date_to, str):
        return date_to
    hits, total = await search_transcripts(
        db, query,
        limit=_limit_of(arguments, MAX_HISTORY_MATCHES),
        date_from=date_from, date_to=date_to,
    )
    if not hits:
        # A true statement about the stored words — this arm is exact-match by
        # design — with the paraphrase arm offered before the model concludes
        # the topic never came up.
        return ("No stored message contains those words. `search_sessions` "
                "finds sessions by meaning if the wording was different.")
    return "\n".join([
        f"{total} stored message(s) match; showing {len(hits)}:",
        *(_hit_lines(hit) for hit in hits),
    ])


def _pages_of(text: str, page_chars: int) -> list[str]:
    """The transcript cut into pages on line boundaries, in order.

    A single line longer than a page is split mid-line rather than served
    whole: a learner can paste an essay into one message, and "page 2 of 9"
    that arrives as forty thousand characters is not a page. Deterministic,
    so page 3 tomorrow is page 3 today.
    """
    chunks: list[str] = []
    for line in text.splitlines():
        while len(line) > page_chars:
            chunks.append(line[:page_chars])
            line = line[page_chars:]
        chunks.append(line)
    pages: list[str] = []
    current: list[str] = []
    used = 0
    for chunk in chunks:
        cost = len(chunk) + 1
        if current and used + cost > page_chars:
            pages.append("\n".join(current))
            current, used = [], 0
        current.append(chunk)
        used += cost
    if current:
        pages.append("\n".join(current))
    return pages or [""]


async def _get_session(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, **_: object
) -> str:
    value = arguments.get("date_or_offset")
    value = value.strip() if isinstance(value, str) else ""
    if not value:
        return ("Say which session: a date like 2026-08-14, or an offset like "
                "\"0\" for the most recent.")
    episodes = await episodes_at(db, learner_id, value)
    if episodes is None:
        return (f"{value!r} is neither a date nor an offset, so nothing was "
                "read. Use YYYY-MM-DD, or \"0\" for the most recent session.")
    if not episodes:
        return (f"No recorded session matches {value!r}. `list_sessions` "
                "shows what is on file.")

    day = f"{episodes[0].closed_at:%Y-%m-%d}"
    part = arguments.get("part")
    if part == "summary":
        today = _today()
        cards = []
        for episode in episodes:
            if episode.narrative is None and episode.digest is None:
                cards.append(
                    f"{episode.closed_at:%Y-%m-%d} — not summarised yet; "
                    "part=\"transcript\" reads the raw words."
                )
            else:
                cards.append(episode_card(episode, today=today, full=True))
        cards.append("(part=\"transcript\" reads the exact words.)")
        return "\n".join(cards)
    if part != "transcript":
        return ("part must be \"summary\" or \"transcript\", so nothing was "
                "read. Call again.")

    # A day's windows read as one continuous transcript, separated so a gap in
    # the conversation is visible as the recording boundary it was.
    text = "\n".join(
        part_text
        for episode in episodes
        for part_text in (
            f"[window recorded {episode.closed_at:%Y-%m-%d %H:%M} UTC]",
            episode.transcript,
        )
    ) if len(episodes) > 1 else episodes[0].transcript
    pages = _pages_of(text, SESSION_PAGE_CHARS)
    raw_page = arguments.get("page")
    page = int(raw_page) if isinstance(raw_page, (int, float)) \
        and not isinstance(raw_page, bool) else 1
    page = max(1, page)
    if page > len(pages):
        return (f"That transcript has only {len(pages)} page(s); there is no "
                f"page {page}.")
    return "\n".join([
        f"Session of {day} — transcript page {page} of {len(pages)}:",
        pages[page - 1],
    ])


async def _list_sessions(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, **_: object
) -> str:
    before = _date_of(arguments, "before_date")
    if isinstance(before, str):
        return before.replace("searched", "listed")
    limit = _limit_of(arguments, MAX_LIST_SESSIONS)
    # One extra row asked for beyond the limit: whether a next page exists is
    # part of the answer, and the extra row is how it is known without a
    # second query.
    episodes = await list_episodes(db, learner_id, limit=limit + 1, before=before)
    more = len(episodes) > limit
    episodes = episodes[:limit]
    if not episodes:
        if before is not None:
            return f"No sessions on file before {before.isoformat()}."
        return "No previous sessions on file."
    today = _today()
    lines = [
        f"- {episode.closed_at:%Y-%m-%d} "
        f"({relative_label(episode.closed_at.date(), today)}): "
        f"{(episode.title or episode.digest or '(not yet summarised)').strip()}"
        for episode in episodes
    ]
    if more:
        lines.append(
            f"(older sessions exist; call again with "
            f"before_date=\"{episodes[-1].closed_at:%Y-%m-%d}\")"
        )
    return "\n".join(lines)


async def _record_evidence(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, *,
    turn_id: uuid.UUID | None, **_: object,
) -> str:
    """Fold one model-authored observation into the learner model.

    The server-only channels are refused *here* and not left to the enum. The
    enum is a request to the provider, `Observation.kind` is a bare String(24),
    and `reliability_of` is a dict lookup that would hand `answer_verified`
    back its 0.95 without a word — so a model that ignores the schema, or a
    provider that stops enforcing it, would have the tutor grading its own
    guesses as verified arithmetic. Downgraded rather than rejected: the
    observation is real, and `DEFAULT_KIND` is what it actually was.
    """
    kind = arguments.get("kind")
    if isinstance(kind, str) and kind in SERVER_ONLY_KINDS:
        logger.warning(
            "refused a server-only evidence kind | kind=%s turn_id=%s", kind, turn_id
        )
        arguments = {**arguments, "kind": DEFAULT_KIND}

    written = await record(db, learner_id, arguments, turn_id=turn_id)
    await db.commit()
    if not written:
        # `record` returns 0 when every code named is outside the vocabulary,
        # which is the one failure the model can actually fix — and it cannot
        # see that it happened otherwise.
        return ("Nothing was recorded: none of those codes are in the "
                "curriculum. Use Common Core codes such as 7.RP.A.2.")
    return f"Recorded against {written} concept(s)."


#: Name to handler. A table and not a chain of `if name ==`, because the chain
#: was a fourth hand-maintained copy of the tool list: a ninth tool added to
#: `MEMORY_TOOL_DEFINITIONS` would be offered, routed here by `_answer`, and
#: told it does not exist. This cannot be derived from the JSON definitions —
#: they hold no functions — so the drift is closed by
#: `test_every_offered_memory_tool_has_a_handler` instead, which is also what
#: keeps `_FAILED` complete.
_HANDLERS: dict[str, Handler] = {
    "remember": _remember,
    "forget": _forget,
    "search_memory": _search_memory,
    "search_sessions": _search_sessions,
    "search_history": _search_history,
    "get_session": _get_session,
    "list_sessions": _list_sessions,
    "record_evidence": _record_evidence,
}


def memory_handler(
    sessions: async_sessionmaker[AsyncSession],
    *,
    learner_id: uuid.UUID,
    turn_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
):
    """Bind a turn's identity to `handle_memory_tool`, for `run_turn` to call.

    A sessionmaker and not a session, for the two reasons `Recorder` is built
    the same way. A session held open for the whole turn is a pooled connection
    held for the whole turn, and a turn is minutes of model streaming with
    seconds of database work in it — enough of those in flight and the pool is
    empty. And a tool that fails needs to roll back only its own work: sharing
    the request's session would put that rollback across whatever else the
    request had pending.

    (Not a teardown problem. `Depends(db_session)` outlives the streaming body
    on the pinned FastAPI — `routing.py` awaits the response *inside* the
    request's exit stack — so the request session would still be open here. It
    is the wrong session to use, not a closed one.)
    """
    async def handle(name: str, arguments: dict) -> str:
        try:
            async with sessions() as db:
                return await handle_memory_tool(
                    db, learner_id, name, arguments,
                    turn_id=turn_id, session_id=session_id,
                )
        except Exception:
            # Opening the session, and closing it again, both sit outside
            # `handle_memory_tool`'s own guard — so a pool that cannot hand one
            # out, or an `__aexit__` that raises on the way back, was the one
            # memory failure that took the learner's whole turn down while
            # every other one was answered politely. `except Exception` and not
            # bare, so the turn's timeout cancellation still unwinds.
            logger.exception(
                "memory session failed | tool=%s turn_id=%s", name, turn_id
            )
            return _FAILED.get(name, f"The tool {name} could not be run.")
    return handle
