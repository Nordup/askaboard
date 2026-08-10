import base64
import uuid

from httpx import ASGITransport, AsyncClient

from app.config import DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, MAX_UPLOAD_BYTES
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
async def test_a_brand_new_session_is_created_rather_than_refused(db_app, db_factory):
    """The feature's opening move: open the app, tap +, photograph the
    worksheet, send. The device mints the session id locally and nothing has
    reached the server yet, so refusing an id it has not seen would 404 the
    one flow this exists for — the chip read "No such session" at the moment
    nothing was wrong. `/v1/turn` has always materialised the device's id on
    first contact; so does this.
    """
    session_id = uuid.uuid4()
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(session_id)},
            files={"file": ("board.png", files.PNG_2X2, "image/png")},
        )

    assert response.status_code == 200
    async with db_factory() as fresh:
        created = await fresh.get(Session, session_id)
        assert created is not None
        # The form carries neither, so the row takes the defaults the next
        # turn will overwrite.
        assert created.model == DEFAULT_MODEL
        assert created.reasoning_effort == DEFAULT_REASONING_EFFORT


@requires_db
async def test_a_second_upload_adopts_the_session_the_first_one_created(db_app, db_factory):
    """Two files picked in quick succession on a brand-new session. The
    second must not fail on the row the first just wrote.
    """
    session_id = uuid.uuid4()
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        for _ in range(2):
            response = await client.post(
                "/v1/attachments",
                headers=AUTH,
                data={"session_id": str(session_id)},
                files={"file": ("board.png", files.PNG_2X2, "image/png")},
            )
            assert response.status_code == 200


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
