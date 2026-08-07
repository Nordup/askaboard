import os
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app

pytestmark = pytest.mark.skipif(
    os.environ.get("MATHTUTOR_LIVE_TESTS") != "1",
    reason="Set MATHTUTOR_LIVE_TESTS=1 to call the real API.",
)


async def test_a_real_turn_streams_text():
    app = create_app()
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
    assert any("text_delta" in line for line in kinds)
