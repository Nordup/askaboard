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
"""

import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.learner.evidence import record
from app.memory.embed import embed_texts
from app.memory.retrieve import recent_episodes, search_atoms
from app.memory.schema import MemoryCategory
from app.store.models import MemoryAtom
from app.tutor.tools import MEMORY_TOOLS

__all__ = ["MEMORY_TOOLS", "handle_memory_tool", "memory_handler"]

logger = logging.getLogger(__name__)

#: What `recent_sessions` will list, whatever the model asked for. The upper
#: bound is the tool description's own; the lower one is because a limit of 0
#: or -3 is a model slip, and answering it with "no previous sessions" would
#: read as a fact about the learner.
MIN_SESSIONS = 1
MAX_SESSIONS = 20

#: What `remember` writes into `MemoryAtom.stated`.
#:
#: True, because the tool's description scopes it to what the learner asked to
#: be remembered or told us themselves. `stated` records whose claim a fact is,
#: and the alternative would file a learner's own stated deadline as the
#: tutor's guess about them. The risk runs the other way — a model calling this
#: on its own inference gets that inference a learner's authority — and the
#: description is the only thing holding that line today.
REMEMBER_STATED = True


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
    try:
        if name == "remember":
            return await _remember(db, learner_id, arguments,
                                   turn_id=turn_id, session_id=session_id)
        if name == "search_memory":
            return await _search_memory(db, learner_id, arguments)
        if name == "recent_sessions":
            return await _recent_sessions(db, learner_id, arguments)
        if name == "record_evidence":
            return await _record_evidence(db, learner_id, arguments,
                                          turn_id=turn_id)
    except Exception:
        # Logged because this catch is broad enough to swallow a bug in the
        # code above as well as a provider outage, and a swallowed bug with no
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
    # Unreachable through `loop._answer`, which routes on `MEMORY_TOOLS`. Here
    # because this function is importable on its own and a name it does not
    # know must not read as a successful no-op.
    return f"There is no tool called {name}."


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
    turn_id: uuid.UUID | None, session_id: uuid.UUID | None,
) -> str:
    """Write one atom the learner asked for, straight into the store.

    Deliberately not through `consolidate`. That would put an embedding call
    *and* an adjudication call on the request path, against a learner waiting
    for a reply — and the plan's standing constraint is that consolidation runs
    off it. The atom is written live and unadjudicated; the session-close pass
    sees it next to everything else that session produced and supersedes what
    it replaces then.

    The embedding is not similarly optional. A `MemoryAtom` with a NULL
    embedding is invisible to retrieval's dense arm and can never be selected
    as a supersession candidate, so it can never be corrected or found by
    meaning again — permanently, with nothing anywhere to notice it by. See the
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

    vectors = await embed_texts([text])
    db.add(MemoryAtom(
        learner_id=learner_id,
        text=text,
        category=category.value,
        embedding=vectors[0],
        source_session_id=session_id,
        source_turn_ids=[turn_id] if turn_id else [],
        stated=REMEMBER_STATED,
    ))
    await db.commit()
    return "Saved. You can tell the learner you will remember it."


async def _search_memory(
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict
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
    db: AsyncSession, learner_id: uuid.UUID, arguments: dict
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
    turn_id: uuid.UUID | None,
) -> str:
    written = await record(db, learner_id, arguments, turn_id=turn_id)
    await db.commit()
    if not written:
        # `record` returns 0 when every code named is outside the vocabulary,
        # which is the one failure the model can actually fix — and it cannot
        # see that it happened otherwise.
        return ("Nothing was recorded: none of those codes are in the "
                "curriculum. Use Common Core codes such as 7.RP.A.2.")
    return f"Recorded against {written} concept(s)."


def memory_handler(
    sessions: async_sessionmaker[AsyncSession],
    *,
    learner_id: uuid.UUID,
    turn_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
):
    """Bind a turn's identity to `handle_memory_tool`, for `run_turn` to call.

    A sessionmaker and not a session, so each call opens and closes its own.
    The request-scoped session from `Depends(db_session)` is the wrong thing to
    reach for here: a turn's tool calls run while the `StreamingResponse` body
    is being iterated, which is after the endpoint returned and its dependencies
    were torn down. `app/api/turn.py` already builds the `Recorder` from
    `session_factory()` for exactly this reason.
    """
    async def handle(name: str, arguments: dict) -> str:
        async with sessions() as db:
            return await handle_memory_tool(
                db, learner_id, name, arguments,
                turn_id=turn_id, session_id=session_id,
            )
    return handle
