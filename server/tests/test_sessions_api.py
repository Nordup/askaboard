import uuid

from httpx import ASGITransport, AsyncClient

from app.store.models import Message, Session
from tests.conftest import requires_db

AUTH = {"Authorization": "Bearer test-token"}


@requires_db
async def test_listing_sessions_returns_newest_first(db_app, db):
    older = Session(model="gpt-5.6-luna", reasoning_effort="high")
    newer = Session(model="gpt-5.6-sol", reasoning_effort="low")
    db.add_all([older, newer])
    await db.commit()

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.get("/v1/sessions", headers=AUTH)

    assert response.status_code == 200
    assert len(response.json()["sessions"]) == 2


@requires_db
async def test_fetching_a_session_includes_its_messages(db_app, db):
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    db.add(Message(session_id=session.id, seq=0, role="learner", text="hello"))
    await db.commit()

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.get(f"/v1/sessions/{session.id}", headers=AUTH)

    assert [m["text"] for m in response.json()["messages"]] == ["hello"]


@requires_db
async def test_an_unknown_session_is_a_404(db_app):
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.get(f"/v1/sessions/{uuid.uuid4()}", headers=AUTH)
    assert response.status_code == 404


@requires_db
async def test_read_back_requires_the_device_token(db_app):
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        assert (await client.get("/v1/sessions")).status_code == 401
