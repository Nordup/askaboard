import base64
import uuid

from httpx import ASGITransport, AsyncClient

from app.config import MAX_UPLOAD_BYTES
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
async def test_a_lying_content_length_is_refused_with_413(db_app, db_factory):
    """The real bytes here are tiny — this is exercising the header-only
    rejection (`_reject_oversize_body`), not the chunked-read cap the test
    above covers. A Content-Length far past MAX_UPLOAD_BYTES must be refused
    with 413 even though the body FastAPI actually receives is small.

    This only proves the dependency rejects on a lying header; it does not
    prove Starlette never reads the wire body first. See the fix report for
    how that was checked separately (a raw-ASGI receive-call count), and why
    this endpoint still benefits from the dependency even so — it runs ahead
    of the session-existence check, the conversion call, and the recorder
    write either way.
    """
    session_id = await _seed_session(db_factory)
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post(
            "/v1/attachments",
            headers={**AUTH, "Content-Length": str(MAX_UPLOAD_BYTES * 2)},
            data={"session_id": str(session_id)},
            files={"file": ("board.png", files.PNG_2X2, "image/png")},
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


@requires_db
async def test_an_unknown_session_is_refused_before_any_conversion_work(db_app):
    """`test_an_unknown_session_is_refused` above uses a file that converts
    fine either way, so it cannot tell the session-check-first ordering
    apart from a convert-first one — both orderings would pass it. Pairing
    an unknown session with a file that convert() itself would refuse
    (BINARY_JUNK, a 415) is the only combination that distinguishes the two:
    whichever check runs first decides whether the response is 404 or 415.
    """
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(uuid.uuid4())},
            files={"file": ("mystery.bin", files.BINARY_JUNK, "application/octet-stream")},
        )

    assert response.status_code == 404


async def test_upload_requires_the_device_token(db_app):
    # db_app, matching every sibling auth test (test_turn_endpoint.py,
    # test_sessions_api.py, test_dictation.py) — not @requires_db, matching
    # those same siblings: db_app's own db_factory dependency already skips
    # the test itself when TEST_DATABASE_URL is unset, so this still runs
    # without a database exactly like they do.
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post(
            "/v1/attachments",
            data={"session_id": str(uuid.uuid4())},
            files={"file": ("board.png", files.PNG_2X2, "image/png")},
        )

    assert response.status_code == 401
