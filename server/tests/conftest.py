import asyncio
import os
import uuid

import pytest
from dotenv import load_dotenv
from sqlalchemy import text as sa_text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
os.environ.setdefault("DEVICE_TOKEN", "test-token")
os.environ.setdefault("BLOB_DIR", "./.test-blobs")

# Populate TEST_DATABASE_URL (and anything else) from server/.env, without
# clobbering the test defaults set above — override=False means an already-set
# var (from the OS environment or the setdefault() calls above) wins.
load_dotenv(override=False)

from app.store.models import Base

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

requires_db = pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to a Neon test branch to run database tests.",
)

# One schema per pytest *process*, not per test — computed once at import
# time so every test in this run shares it. Two pytest processes running
# against the same TEST_DATABASE_URL branch at once (the leading explanation
# for the one spurious 404 the last full-suite run produced: a second run's
# drop_all deleting a row this run had just committed) now get two different
# schemas and cannot touch each other's tables no matter how they interleave.
_SCHEMA_NAME = f"test_{uuid.uuid4().hex}"
_schema_ready = False  # set True once this process has created its schema


@pytest.fixture
async def db_factory():
    """A sessionmaker bound to this pytest process's own schema, reset to
    empty tables before every test, on a dedicated Neon branch.

    The schema (and its tables) are created once per process, the first time
    any test asks for `db_factory`, via `schema_translate_map` — every model
    here has no explicit `schema=`, so the map transparently rewrites both
    DDL and every ORM query onto `_SCHEMA_NAME` without changing a single
    model or query. Every test after the first just TRUNCATEs: one round
    trip for every table instead of one DROP/CREATE pair per table, and,
    unlike drop_all/create_all, TRUNCATE never changes a table's OID —
    sidestepping the known-bad combination the review flagged as a secondary
    hypothesis for the spurious 404 (PgBouncer transaction pooling + asyncpg's
    prepared-statement cache + repeated DROP/CREATE cycles of the same table
    names against a pooled endpoint can serve a query against stale catalogue
    state).

    Safe only because this branch holds nothing but test data — never point
    TEST_DATABASE_URL at the branch the app uses. The schema itself is
    dropped at session teardown by `_drop_test_schema` below.
    """
    global _schema_ready
    if TEST_DATABASE_URL is None:
        pytest.skip("TEST_DATABASE_URL is not set.")
    engine = create_async_engine(TEST_DATABASE_URL)
    engine = engine.execution_options(schema_translate_map={None: _SCHEMA_NAME})
    async with engine.begin() as conn:
        if not _schema_ready:
            await conn.execute(sa_text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.execute(
                sa_text(f'CREATE SCHEMA IF NOT EXISTS "{_SCHEMA_NAME}"')
            )
            await conn.run_sync(Base.metadata.create_all)
            _schema_ready = True
        else:
            # Schema-qualified explicitly: schema_translate_map only rewrites
            # schema-less Table objects reached through Core/ORM constructs
            # (create_all, select(), session.add(), ...); it does not touch
            # raw text() SQL at all. An unqualified `TRUNCATE TABLE
            # "sessions", ...` here resolves through the connection's actual
            # Postgres search_path — not this schema — so it silently
            # truncates nothing in `_SCHEMA_NAME` while every ORM write
            # keeps landing there via the map, and rows pile up across tests
            # instead of resetting.
            table_names = ", ".join(
                f'"{_SCHEMA_NAME}"."{table.name}"' for table in Base.metadata.sorted_tables
            )
            await conn.execute(
                sa_text(f"TRUNCATE TABLE {table_names} RESTART IDENTITY CASCADE")
            )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


def pytest_sessionfinish(session, exitstatus):
    """Drop this process's schema once the whole run is done.

    A plain sync hook, deliberately: by the time pytest calls this every
    test's own event loop (pytest-asyncio runs each test in a fresh one) has
    already been closed, so spinning up one throwaway loop here with
    asyncio.run() is the safe way to do one last bit of async cleanup rather
    than trying to reuse a loop that no longer exists.
    """
    if TEST_DATABASE_URL is None or not _schema_ready:
        return

    async def _drop() -> None:
        engine = create_async_engine(TEST_DATABASE_URL)
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    sa_text(f'DROP SCHEMA IF EXISTS "{_SCHEMA_NAME}" CASCADE')
                )
        finally:
            await engine.dispose()

    try:
        asyncio.run(_drop())
    except Exception:
        # Best-effort cleanup of a throwaway schema — must never turn a
        # green run red, or mask the real result with a teardown-only error.
        pass


@pytest.fixture
async def db(db_factory):
    """A single borrowed session on the schema `db_factory` just built.

    Most tests just want a session to read and write through; `db_factory`
    itself is for tests exercising code that opens its own sessions.
    """
    async with db_factory() as session:
        yield session


@pytest.fixture
async def db_app(db_factory, tmp_path):
    """A FastAPI app wired to the test schema instead of `DATABASE_URL`.

    Overriding all three dependencies is the point: `db_session` alone would
    leave the recorder writing to, and the blob read-back route reading
    from, whatever `DATABASE_URL`/`BLOB_DIR` name — the branch and directory
    holding real sessions. The recorder and the blob route share one
    `LocalBlobStore(tmp_path)` so a blob a test writes through the recorder
    is readable back through `GET /v1/blobs/{key}` in the same test.
    """
    from app.api.sessions import get_blob_store
    from app.api.turn import get_recorder
    from app.main import create_app
    from app.store.blobs import LocalBlobStore
    from app.store.db import db_session
    from app.store.recorder import Recorder

    app = create_app()

    async def _session():
        async with db_factory() as session:
            yield session

    blob_store = LocalBlobStore(tmp_path)
    app.dependency_overrides[db_session] = _session
    app.dependency_overrides[get_recorder] = lambda: Recorder(db_factory, blob_store)
    app.dependency_overrides[get_blob_store] = lambda: blob_store
    yield app
    app.dependency_overrides.clear()
