from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.dictation import router as dictation_router
from app.api.sessions import router as sessions_router
from app.api.turn import router as turn_router
from app.learner.kcs import seed_curriculum
from app.memory.jobs import backlog_status, schedule_startup_drain
from app.store.db import dispose_engine, init_engine


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
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

    return app


app = create_app()
