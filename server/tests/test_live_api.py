from types import SimpleNamespace
import uuid

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api import live
from app.api.turn import get_recorder
from app.api.live import router
from app.store.db import db_session
from app.store.models import Session


class FakeRecorder:
    class _Sessions:
        async def __aenter__(self): return FakeDB()
        async def __aexit__(self, *_): return None
    def sessions(self): return self._Sessions()

    async def spend_today(self):
        return 0.0


class FakeDB:
    def add(self, _): pass
    async def commit(self): pass
    async def get(self, model, _id):
        return SimpleNamespace(id=_id) if model is Session else None
    async def execute(self, _):
        return SimpleNamespace(all=lambda: [])


class FakeResponse:
    status_code = 201
    is_error = False

    def json(self):
        return {"session": {"id": "live_123"}, "transport": {"type": "webrtc", "sdp": "v=0\r\nanswer"}}


class FakeClient:
    def __init__(self):
        self.payload = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return None

    async def post(self, url, *, headers, json):
        self.url = url
        self.headers = headers
        self.payload = json
        return FakeResponse()


async def test_live_call_uses_official_webrtc_session_contract(monkeypatch):
    settings = SimpleNamespace(
        openai_live_model="gpt-live-1", openai_api_key="sk-test",
        openai_base_url="https://api.openai.com/v1", daily_spend_cap_usd=5,
    )
    monkeypatch.setattr(live, "get_settings", lambda: settings)
    async def instructions(*_):
        return "voice prompt"
    monkeypatch.setattr(live, "_instructions", instructions)
    upstream = FakeClient()
    monkeypatch.setattr(live, "_client", lambda: upstream)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_recorder] = lambda: FakeRecorder()
    app.dependency_overrides[db_session] = lambda: FakeDB()
    session_id = uuid.uuid4()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/v1/live/calls", headers={"Authorization": "Bearer test-token"},
            json={"session_id": str(session_id), "sdp": "v=0\r\no=- 1 1 IN IP4 127.0.0.1"},
        )
    assert response.status_code == 200
    assert response.json() == {
        "session": {"id": "live_123"},
        "transport": {"type": "webrtc", "sdp": "v=0\r\nanswer"},
    }
    assert upstream.url == "https://api.openai.com/v1/live/sessions"
    assert upstream.payload["session"] == {
        "model": "gpt-live-1", "instructions": "voice prompt",
        "input": [],
        "audio": {"output": {"voice": "marin"}},
        "delegation": {"type": "client"},
    }
    assert upstream.payload["transport"]["type"] == "webrtc"


async def test_live_minimum_charge_is_included_in_cap_check(monkeypatch):
    settings = SimpleNamespace(
        openai_live_model="gpt-live-1", openai_api_key="sk-test",
        openai_base_url="https://api.openai.com/v1", daily_spend_cap_usd=0.0124,
    )
    monkeypatch.setattr(live, "get_settings", lambda: settings)
    upstream = FakeClient()
    monkeypatch.setattr(live, "_client", lambda: upstream)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_recorder] = lambda: FakeRecorder()
    app.dependency_overrides[db_session] = lambda: FakeDB()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/v1/live/calls", headers={"Authorization": "Bearer test-token"},
            json={"sdp": "v=0\r\no=- 1 1 IN IP4 127.0.0.1"},
        )
    assert response.status_code == 402
    assert upstream.payload is None
