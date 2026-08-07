import pytest

from app.store.db import dispose_engine, init_engine, session_factory


async def test_session_factory_raises_before_init():
    # Guard against test ordering: make sure no earlier test left the engine
    # initialised before asserting the uninitialised-state error.
    await dispose_engine()
    with pytest.raises(RuntimeError):
        session_factory()


async def test_session_factory_returns_a_sessionmaker_after_init():
    init_engine()
    try:
        assert session_factory() is not None
    finally:
        # dispose_engine() resetting both module globals to None is what
        # keeps this test from leaking initialised state into other tests.
        await dispose_engine()
