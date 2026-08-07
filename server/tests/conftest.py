import os

import pytest
from sqlalchemy import text as sa_text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
os.environ.setdefault("DEVICE_TOKEN", "test-token")
os.environ.setdefault("BLOB_DIR", "./.test-blobs")

from app.store.models import Base

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

requires_db = pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to a Neon test branch to run database tests.",
)


@pytest.fixture
async def db():
    """A clean schema per test, on a dedicated Neon branch.

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
    async with factory() as session:
        yield session
    await engine.dispose()
