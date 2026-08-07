import os

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


@pytest.fixture
async def db_factory():
    """A sessionmaker bound to a clean schema per test, on a dedicated Neon branch.

    Dropping and recreating is safe only because this branch holds nothing but
    test data. Never point TEST_DATABASE_URL at the branch the app uses.
    """
    if TEST_DATABASE_URL is None:
        pytest.skip("TEST_DATABASE_URL is not set.")
    engine = create_async_engine(TEST_DATABASE_URL)
    async with engine.begin() as conn:
        await conn.execute(sa_text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


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
