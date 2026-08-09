"""The four memory tools, run. One tool call in, one string back.

Answers are prose rather than the JSON status objects `app/tutor/loop.py`
gives its own tools, because three of these four *are* prose: a list of facts,
a list of session digests. Wrapping those in an envelope would cost escaping
and tokens for a field nothing branches on — the model reads the string and
that is the whole protocol.

Nothing here raises. `embed_texts` documents the split deliberately: an offline
pass wants an embedding failure loud so the session can be re-run, and this
handler wants it caught so the learner still gets an answer. This is that
boundary. What each failure returns is written to stop the model drawing the
one wrong conclusion available to it — that memory was consulted and had
nothing, or that a fact was saved when it was not.

This is the second write path into `memory_atoms`, and every rule the offline
one enforces has to be enforced again here or it is not a rule. Three of them
are: the atom must carry an embedding, an unstated fact outside
`STATED_EXEMPT` is dropped rather than written, and a fact already on file
word-for-word is not written twice. `consolidate.py` is where each is
explained; `_remember` below is where each is repeated.
"""

import logging
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.learner.evidence import DEFAULT_KIND, record
from app.memory.consolidate import normalised
from app.memory.embed import embed_texts
from app.memory.retrieve import recent_episodes, search_atoms
from app.memory.schema import STATED_EXEMPT, MemoryCategory
from app.store.models import MemoryAtom
from app.tutor.tools import MEMORY_TOOLS, SERVER_ONLY_KINDS

__all__ = ["MEMORY_TOOLS", "handle_memory_tool", "memory_handler"]

logger = logging.getLogger(__name__)

#: What `recent_sessions` will list, whatever the model asked for. The upper
#: bound is the tool description's own; the lower one is because a limit of 0
#: or -3 is a model slip, and answering it with "no previous sessions" would
#: read as a fact about the learner.
MIN_SESSIONS = 1
MAX_SESSIONS = 20

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
    "search_memory": (
        "The search could not run, so this is not a statement about what is on "
        "file. Do not tell the learner you have no memory of it."
    ),
    "recent_sessions": "The session history could not be read just now.",
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

    # The same rule `extract._parse` applies, because this is the same column
    # and `stated` is not a label — an inference stored with a learner
    # statement's authority is what the flag exists to prevent, and provenance
    # cannot be reconstructed after the fact. `is True` rather than truthiness
    # for the reason `_parse` gives: the string "false" is truthy.
    if arguments.get("stated") is not True and category not in STATED_EXEMPT:
        return ("Nothing was saved: that was marked as your own inference "
                "rather than something the learner said, and only what they "
                "said is kept as a fact about them. Do not tell them you have "
                "remembered it.")

    # Checked before the embedding call, so a repeat costs no round trip.
    if await _already_stored(db, learner_id, text, category):
        return ("Already on file word for word, so nothing was added. You can "
                "tell the learner you will remember it.")

    vectors = await embed_texts([text])
    db.add(MemoryAtom(
        learner_id=learner_id,
        text=text,
        category=category.value,
        embedding=vectors[0],
        source_session_id=session_id,
        source_turn_ids=[turn_id] if turn_id else [],
        # Carried verbatim, never coerced — `consolidate` says why at its own
        # insert. An exempt category legitimately arrives False.
        stated=arguments.get("stated") is True,
    ))
    await db.commit()
    return "Saved. You can tell the learner you will remember it."


async def _already_stored(
    db: AsyncSession, learner_id: uuid.UUID, text: str, category: MemoryCategory
) -> bool:
    """Whether this exact fact is already live, by `consolidate`'s own key.

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
        select(MemoryAtom.text).where(
            MemoryAtom.learner_id == learner_id,
            MemoryAtom.valid_to.is_(None),
            MemoryAtom.category == category.value,
        )
    )).scalars().all()
    key = normalised(text)
    return any(normalised(row) == key for row in rows)


async def _search_memory(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, **_: object
) -> str:
    query = arguments.get("query")
    query = query.strip() if isinstance(query, str) else ""
    if not query:
        # Distinguished from "nothing on file" on purpose. An empty query is
        # the model's slip and is worth one more round; a miss is not.
        return ("The query was empty, so nothing was searched. Ask again with a "
                "self-contained question.")
    hits = await search_atoms(db, learner_id, query)
    if not hits:
        return "Nothing on file about that."
    return "\n".join(f"- [{hit.category}] {hit.text}" for hit in hits)


async def _recent_sessions(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict, **_: object
) -> str:
    raw = arguments.get("limit")
    # `int()` on a float rather than a cast on whatever arrived: strict schemas
    # do not stop a model emitting 5.0, and a non-number falls back to the top
    # of the range rather than costing the round.
    limit = int(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) \
        else MAX_SESSIONS
    limit = max(MIN_SESSIONS, min(MAX_SESSIONS, limit))
    episodes = await recent_episodes(db, learner_id, limit=limit)
    if not episodes:
        return "No previous sessions on file."
    return "\n".join(f"{e.closed_at:%Y-%m-%d}: {e.digest}" for e in episodes)


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
#: was a fourth hand-maintained copy of the tool list: a fifth tool added to
#: `MEMORY_TOOL_DEFINITIONS` would be offered, routed here by `_answer`, and
#: told it does not exist. This cannot be derived from the JSON definitions —
#: they hold no functions — so the drift is closed by
#: `test_every_offered_memory_tool_has_a_handler` instead, which is also what
#: keeps `_FAILED` complete.
_HANDLERS: dict[str, Handler] = {
    "remember": _remember,
    "search_memory": _search_memory,
    "recent_sessions": _recent_sessions,
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
        async with sessions() as db:
            return await handle_memory_tool(
                db, learner_id, name, arguments,
                turn_id=turn_id, session_id=session_id,
            )
    return handle
