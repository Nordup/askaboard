from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

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

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def init_engine() -> AsyncEngine:
    """Create the process-wide engine and sessionmaker, and return the engine.

    Call once, from the FastAPI lifespan's startup phase, so the engine (and
    the asyncpg connections it pools) is bound to the loop that will actually
    serve requests rather than whichever loop happened to be running at
    import time.
    """
    global _engine, _session_factory
    _engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
    _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


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
    async with session_factory()() as session:
        yield session
