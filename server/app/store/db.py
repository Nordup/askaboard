import asyncio
import logging
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

logger = logging.getLogger(__name__)

# No pgvector asyncpg codec is registered on this engine, and registering one
# would break every write to `memory_atoms.embedding`. pgvector's SQLAlchemy
# `HALFVEC` type already converts a vector to its text form in `bind_processor`
# and parses it back in `result_processor`, so what reaches asyncpg is a `str`
# and Postgres casts it on the way in. `pgvector.asyncpg.register_vector`
# installs a *binary* codec whose encoder expects a list or an ndarray, and it
# would be handed that string instead: the first INSERT fails with
# `DataError: invalid input for query argument $N ... (expected list or
# ndarray)`. The two mechanisms are alternatives, not layers.
#
# That vectors survive the trip without it is not assumed:
# `tests/test_memory_consolidate.py::test_embedding_round_trips_through_postgres`
# writes one through `consolidate`, reads it back in a session that never saw
# the object, and then makes the database order by cosine distance on it.

#: How many pooled connections to keep open, and to open at startup.
#:
#: Sized for the fan-out, not for the traffic. One turn checks out up to five
#: connections at once in `api.turn.create_turn`'s prologue and up to seven in
#: its `stream`'s pre-provider block, and a checkout the pool cannot serve is a
#: brand-new connection to Neon — measured at 524 ms from where this server
#: runs, against 52 ms for a round trip on one that already exists. An overflow
#: connection is also discarded when it is returned, so the cost comes back on
#: the next turn. `max_overflow` below stays as a safety valve for concurrent
#: turns; reaching it on the normal path means this number is too small.
#:
#: Both figures are for the `aws-ap-southeast-1` (Singapore) project the app
#: moved to on 2026-08-16; the same pair measured 2.16 s and 272 ms against the
#: old `aws-us-east-2` project.
#:
#: The URL is deliberately the **direct** endpoint, not `-pooler`. PgBouncer
#: earns its keep when many short-lived processes each want a connection. This
#: is one process holding this pool open for its whole life, so the pooler
#: would only add a hop, and its transaction-scoped semantics fight asyncpg's
#: prepared statements. Revisit only if the deployment becomes multi-process.
POOL_SIZE = 12

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None

#: When a request last reached for the database, or None if none has since this
#: process started. Read by `app.memory.jobs.run_periodic_sweep`.
#:
#: Only the two per-request dependencies write it — `db_session` here and
#: `api.turn.get_recorder`. Background work resolves `session_factory` directly
#: and stays invisible, which is the entire point: the sweep asks this stamp
#: whether anything can have happened since it last looked, and a sweep whose
#: own queries counted as activity would answer "yes" forever.
_last_request_use: datetime | None = None


def note_request_use() -> None:
    """Stamp now as the last time a request reached for the database."""
    global _last_request_use
    _last_request_use = datetime.now(timezone.utc)


def last_request_use() -> datetime | None:
    """When a request last reached for it. None if none has, this process."""
    return _last_request_use


def init_engine() -> AsyncEngine:
    """Create the process-wide engine and sessionmaker, and return the engine.

    Call once, from the FastAPI lifespan's startup phase, so the engine (and
    the asyncpg connections it pools) is bound to the loop that will actually
    serve requests rather than whichever loop happened to be running at
    import time.
    """
    global _engine, _session_factory
    _engine = create_async_engine(
        get_settings().database_url,
        # No `pool_pre_ping`. It cost three extra round trips on every single
        # checkout, because SQLAlchemy's asyncpg dialect wraps the ping in
        # BEGIN / SELECT 1 / ROLLBACK for PgBouncer's sake — a wrapper this
        # engine does not need now that it talks to the direct endpoint.
        # Measured against the old us-east-2 project, `engine.connect()` plus
        # one `SELECT 1` took 796 ms with the ping off and 1597 ms with it on:
        # 801 ms, or 2.94 round trips, of pure overhead per checkout. At
        # Singapore's 52 ms that same ping is ~156 ms per checkout, still paid
        # on a connection that is almost always healthy.
        #
        # `pool_recycle` replaces it: instead of proving liveness before every
        # checkout, retire a connection once it has been idle long enough to be
        # doubtful. 280 s sits just under the 300 s at which Neon scale-to-zero
        # suspends this compute and drops every connection with it, so the pool
        # renews itself rather than handing out corpses.
        pool_recycle=280,
        pool_size=POOL_SIZE,
        max_overflow=8,
        pool_timeout=15,
    )
    _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


async def warm_pool() -> None:
    """Open `POOL_SIZE` connections now, so no turn has to open one later.

    Deliberately not a keepalive: it runs once, at startup, because the *first*
    turn after a boot — and `uvicorn --reload` reboots on every prompt edit —
    would otherwise open its connections one at a time on the critical path, at
    about 524 ms each. Opened together they cost one connection's worth of wall
    clock.

    This docstring used to argue against `pool_recycle`, on the grounds that a
    recycled connection is a closed one and `pool_pre_ping` discarded dead
    connections transparently instead. `init_engine` now sets `pool_recycle`
    and no pre-ping, because both premises moved: the reconnect it feared was
    5.5 s against us-east-2 and is 524 ms from Singapore, and the pre-ping was
    never free — ~2.94 round trips on *every* checkout, healthy or not.

    It remains a judgement, not a fact. A pre-ping pays a small toll constantly
    and never surprises anyone; `pool_recycle` is free most of the time and
    occasionally puts a reconnect on a turn's critical path. An unexplained
    ~0.5 s stall roughly every 280 s is the signature of that, and
    `pool_pre_ping=True` is the one-line reversal.

    Never raises. A boot that cannot reach the database still has to answer
    `/health` and say so — the same contract `seed_curriculum` keeps.
    """
    engine = _engine
    if engine is None:
        return

    async def _one() -> None:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    results = await asyncio.gather(
        *(_one() for _ in range(POOL_SIZE)), return_exceptions=True
    )
    failed = [r for r in results if isinstance(r, BaseException)]
    if failed:
        logger.warning(
            "pool warm-up: %d of %d connections failed | %s: %s",
            len(failed), POOL_SIZE, type(failed[0]).__name__, failed[0],
        )
    else:
        logger.info("pool warm-up: %d connections open", POOL_SIZE)


async def dispose_engine() -> None:
    """Dispose the engine and clear module state, from lifespan shutdown."""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None


def session_factory() -> async_sessionmaker[AsyncSession]:
    if _session_factory is None:
        raise RuntimeError(
            "Database engine is not initialised. Call init_engine() during "
            "app startup (see app.main's lifespan) before using session_factory."
        )
    return _session_factory


async def db_session() -> AsyncIterator[AsyncSession]:
    note_request_use()
    async with session_factory()() as session:
        yield session
