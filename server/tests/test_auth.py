import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from app.auth import require_device_token


@pytest.fixture
def client():
    app = FastAPI()

    @app.get("/guarded", dependencies=[Depends(require_device_token)])
    async def guarded() -> dict[str, bool]:
        return {"ok": True}

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_missing_header_is_rejected(client):
    async with client as c:
        assert (await c.get("/guarded")).status_code == 401


async def test_wrong_token_is_rejected(client):
    async with client as c:
        response = await c.get("/guarded", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


async def test_malformed_header_is_rejected(client):
    async with client as c:
        response = await c.get("/guarded", headers={"Authorization": "test-token"})
    assert response.status_code == 401


async def test_correct_token_is_accepted(client):
    async with client as c:
        response = await c.get("/guarded", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200
