import uuid
from types import SimpleNamespace

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.sessions import router
from app.store.db import db_session
from app.store.models import Session, WebWorkspace

AUTH = {"Authorization": "Bearer test-token"}


class FakeDB:
    def __init__(self, session_id):
        self.session = SimpleNamespace(
            id=session_id, model="gpt-5.6-luna", reasoning_effort="high",
            plan=None, exercise=None, started_at=None, updated_at=None,
        )
        self.workspace = None
        self.pending = None

    async def get(self, model, _id, **_kwargs):
        if model is Session:
            return self.session if _id == self.session.id else None
        if model is WebWorkspace:
            return self.workspace
        raise AssertionError(model)

    def add(self, value):
        self.pending = value

    async def commit(self):
        if self.pending is not None:
            self.workspace = self.pending
            self.pending = None


async def test_workspace_save_returns_revision_and_rejects_stale_tab():
    session_id = uuid.uuid4()
    database = FakeDB(session_id)
    app = FastAPI()
    app.include_router(router)

    async def fake_db():
        yield database
    app.dependency_overrides[db_session] = fake_db

    workspace = {
        "version": 1, "id": str(session_id), "title": "Algebra",
        "strokes": [], "scene": {"elements": []},
        "camera": {"center": [0, 0], "zoom": 1}, "messages": [],
        "model": "gpt-5.6-luna", "reasoningEffort": "high",
        "plan": None, "exercise": None, "updatedAt": "2026-10-05T00:00:00Z",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        saved = await client.put(
            f"/v1/sessions/{session_id}/workspace", headers=AUTH,
            json={"workspace": workspace, "expected_revision": 0},
        )
        stale = await client.put(
            f"/v1/sessions/{session_id}/workspace", headers=AUTH,
            json={"workspace": {**workspace, "title": "stale"}, "expected_revision": 0},
        )
        fetched = await client.get(f"/v1/sessions/{session_id}/workspace", headers=AUTH)

    assert saved.status_code == 200
    assert saved.json() == {"workspace": workspace, "revision": 1}
    assert stale.status_code == 409
    assert fetched.json() == {"workspace": workspace, "revision": 1}
