import os
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.store.db import dispose_engine, init_engine

pytestmark = pytest.mark.skipif(
    os.environ.get("MATHTUTOR_LIVE_TESTS") != "1",
    reason="Set MATHTUTOR_LIVE_TESTS=1 to call the real API.",
)


async def test_a_real_turn_streams_text():
    # httpx.ASGITransport calls the app directly and never runs the ASGI
    # lifespan protocol, so create_app()'s own lifespan (which calls
    # init_engine()) never fires here. Without this, the first thing
    # POST /v1/turn does is resolve db_session -> session_factory(), which
    # raises RuntimeError before a single byte reaches OpenAI — this test
    # has never actually executed successfully. Calling init_engine() /
    # dispose_engine() by hand does exactly what the missing lifespan would
    # have done.
    app = create_app()
    init_engine()
    try:
        payload = {
            "turn_id": str(uuid.uuid4()),
            "session_id": str(uuid.uuid4()),
            "text": "What is 2 + 2? Answer in one short sentence.",
            "model": "gpt-5.6-luna",
            "reasoning_effort": "low",
        }
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test", timeout=120
        ) as client:
            async with client.stream(
                "POST", "/v1/turn", json=payload,
                headers={"Authorization": f"Bearer {os.environ['DEVICE_TOKEN']}"},
            ) as response:
                kinds = [
                    line for line in [l async for l in response.aiter_lines()]
                    if line.startswith("data: ")
                ]
    finally:
        await dispose_engine()
    assert any("text_delta" in line for line in kinds)
