import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.attachments import router as attachments_router
from app.api.dictation import router as dictation_router
from app.api.sessions import router as sessions_router
from app.api.turn import router as turn_router
from app.config import get_settings
from app.learner.kcs import seed_curriculum
from app.logging_config import configure_logging
from app.memory.jobs import backlog_status, schedule_startup_drain
from app.store.db import dispose_engine, init_engine

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Here rather than in create_app(), so that constructing an app in a test
    # does not start writing log files into the repository — the real server
    # is the thing with a lifespan, and the real server is the thing whose
    # logs need to outlive its terminal.
    path = configure_logging(get_settings().log_dir)
    logger.info("service starting | log_file=%s", path)
    init_engine()
    # Both are startup work the rest of the service assumes has happened, and
    # neither may stop the service coming up: `seed_curriculum` swallows and
    # logs, `schedule_startup_drain` detaches. A boot that cannot reach the
    # database still has to answer `/health` and say so.
    await seed_curriculum()
    schedule_startup_drain()
    try:
        yield
    finally:
        logger.info("service stopping")
        await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(title="Math Tutor Backend", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict:
        # The memory block is here rather than on an endpoint of its own
        # because a stalled extraction backlog has no other symptom: nothing
        # errors, no request fails, and the tutor simply stops learning
        # anything new. `backlog_status` never raises, so this stays a
        # liveness answer either way.
        return {"status": "ok", "memory": await backlog_status()}

    app.include_router(turn_router)
    app.include_router(dictation_router)
    app.include_router(sessions_router)
    app.include_router(attachments_router)

    return app


app = create_app()
