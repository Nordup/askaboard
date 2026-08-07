from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

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
