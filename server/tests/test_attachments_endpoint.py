import base64
import uuid

from httpx import ASGITransport, AsyncClient

from app.config import MAX_UPLOAD_BYTES
from app.main import create_app
from app.store.models import Session
from tests.conftest import requires_db
from tests.fixtures import files

AUTH = {"Authorization": "Bearer test-token"}


async def _seed_session(db_factory) -> uuid.UUID:
    async with db_factory() as db:
        session = Session(model="gpt-5.6-luna", reasoning_effort="high")
        db.add(session)
        await db.commit()
        return session.id


@requires_db
async def test_uploading_a_photo_returns_a_thumbnail_and_an_id(db_app, db_factory):
    session_id = await _seed_session(db_factory)
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(session_id)},
            files={"file": ("board.png", files.PNG_2X2, "image/png")},
        )

    assert response.status_code == 200
    body = response.json()
    assert uuid.UUID(body["id"])
    assert body["kind"] == "image"
    assert body["page_count"] == 1
    assert base64.b64decode(body["thumbnail_base64"]).startswith(b"\xff\xd8\xff")


@requires_db
async def test_an_unreadable_file_is_refused_with_a_sentence_for_the_learner(
    db_app, db_factory
):
    """415 at upload, not at send: the learner finds out while they are still
    looking at the picker."""
    session_id = await _seed_session(db_factory)
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(session_id)},
            files={"file": ("mystery.bin", files.BINARY_JUNK, "application/octet-stream")},
        )

    assert response.status_code == 415
    assert "mystery.bin" in response.json()["detail"]


@requires_db
async def test_an_oversize_file_is_refused_with_413(db_app, db_factory):
    session_id = await _seed_session(db_factory)
    oversize = b"\x89PNG\r\n\x1a\n" + b"\x00" * MAX_UPLOAD_BYTES
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(session_id)},
            files={"file": ("huge.png", oversize, "image/png")},
        )

    assert response.status_code == 413


@requires_db
async def test_an_unknown_session_is_refused(db_app):
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(uuid.uuid4())},
            files={"file": ("board.png", files.PNG_2X2, "image/png")},
        )

    assert response.status_code == 404


async def test_upload_requires_the_device_token():
    # No db_app here: the auth dependency runs before any database
    # dependency is resolved, so a request with no bearer token never
    # touches db_session/get_recorder — a plain create_app() (unwired to
    # the test schema) is safe for this one test only.
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/v1/attachments",
            data={"session_id": str(uuid.uuid4())},
            files={"file": ("board.png", files.PNG_2X2, "image/png")},
        )

    assert response.status_code == 401
