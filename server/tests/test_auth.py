import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient
from types import SimpleNamespace

from app.auth import WEB_COOKIE_NAME, make_web_session, require_device_token


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


def _web_settings():
    return SimpleNamespace(
        device_token="test-token", web_session_secret="secret-for-tests",
        web_session_ttl_seconds=3600,
        web_allowed_hosts=("localhost:5173",),
    )


@pytest.fixture
def cookie_client(monkeypatch):
    import app.auth as auth
    monkeypatch.setattr(auth, "get_settings", _web_settings)
    app = FastAPI()

    @app.post("/write", dependencies=[Depends(require_device_token)])
    async def write():
        return {"ok": True}

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://localhost:5173")


async def test_signed_browser_cookie_is_accepted_for_same_origin_mutation(cookie_client):
    token = make_web_session("secret-for-tests")
    async with cookie_client as client:
        response = await client.post(
            "/write", headers={"Origin": "http://localhost:5173"},
            cookies={WEB_COOKIE_NAME: token},
        )
    assert response.status_code == 200


async def test_browser_cookie_rejects_cross_origin_mutation(cookie_client):
    token = make_web_session("secret-for-tests")
    async with cookie_client as client:
        response = await client.post(
            "/write", headers={"Origin": "https://attacker.example"},
            cookies={WEB_COOKIE_NAME: token},
        )
    assert response.status_code == 403


async def test_expired_browser_cookie_is_rejected(cookie_client):
    import time
    token = make_web_session("secret-for-tests", int(time.time()) - 1)
    async with cookie_client as client:
        response = await client.post(
            "/write", headers={"Origin": "http://localhost:5173"},
            cookies={WEB_COOKIE_NAME: token},
        )
    assert response.status_code == 401
