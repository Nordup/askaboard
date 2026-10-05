import uuid
from datetime import datetime, timezone

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.config import DEFAULT_MODEL, DEFAULT_REASONING_EFFORT
from app.api import live as live_api
from app.store.blobs import LocalBlobStore
from app.store.models import (
    KC, Attachment, Episode, Learner, LLMCall, MemoryAtom, Message, Observation,
    LiveSession, LiveUsage, Session, ToolCall, Turn, WebWorkspace,
)
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
async def test_workspace_revision_cas_rejects_stale_save(db_app, db):
    session = Session(model=DEFAULT_MODEL, reasoning_effort=DEFAULT_REASONING_EFFORT)
    db.add(session)
    await db.commit()
    workspace = {
        "version": 1, "id": str(session.id), "title": "Algebra",
        "strokes": [], "scene": {"elements": []},
        "camera": {"center": [0, 0], "zoom": 1}, "messages": [],
        "model": DEFAULT_MODEL, "reasoningEffort": DEFAULT_REASONING_EFFORT,
        "plan": None, "exercise": None, "updatedAt": "2026-10-05T00:00:00Z",
    }
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        saved = await client.put(
            f"/v1/sessions/{session.id}/workspace", headers=AUTH,
            json={"workspace": workspace, "expected_revision": 0},
        )
        assert saved.status_code == 200
        assert saved.json()["revision"] == 1
        stale = await client.put(
            f"/v1/sessions/{session.id}/workspace", headers=AUTH,
            json={"workspace": {**workspace, "title": "stale"}, "expected_revision": 0},
        )
        current = await client.get(f"/v1/sessions/{session.id}/workspace", headers=AUTH)
    assert stale.status_code == 409
    assert current.json() == {"workspace": workspace, "revision": 1}


@requires_db
async def test_workspace_put_lazily_creates_session_and_round_trips(db_app, db):
    session_id = uuid.uuid4()
    workspace = {
        "version": 1, "id": str(session_id), "title": "Fresh board",
        "strokes": [], "scene": {"elements": []},
        "camera": {"center": [0, 0], "zoom": 1}, "messages": [],
        "model": DEFAULT_MODEL, "reasoningEffort": DEFAULT_REASONING_EFFORT,
        "plan": None, "exercise": None, "updatedAt": "2026-10-05T00:00:00Z",
    }
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        saved = await client.put(
            f"/v1/sessions/{session_id}/workspace", headers=AUTH,
            json={"workspace": workspace, "expected_revision": 0},
        )
        fetched = await client.get(f"/v1/sessions/{session_id}/workspace", headers=AUTH)
    assert saved.status_code == 200
    assert fetched.json() == {"workspace": workspace, "revision": 1}
    assert (await db.get(Session, session_id)).model == DEFAULT_MODEL
    assert await db.get(WebWorkspace, session_id) is not None


@requires_db
async def test_live_usage_is_attributed_and_cumulative(db_app, db):
    app_session = Session(model=DEFAULT_MODEL, reasoning_effort=DEFAULT_REASONING_EFFORT)
    db.add(app_session)
    await db.flush()
    db.add(LiveSession(live_session_id="live_test_123", session_id=app_session.id, model="gpt-live-1"))
    await db.commit()
    body = {
        "live_session_id": "live_test_123", "session_id": str(app_session.id),
        "model": "gpt-live-1", "duration_seconds": 120,
    }
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post("/v1/live/usage", headers=AUTH, json=body)
        retry = await client.post("/v1/live/usage", headers=AUTH, json=body)
        rows = (await db.execute(select(LiveUsage))).scalars().all()
    assert response.status_code == retry.status_code == 204
    assert len(rows) == 1
    assert rows[0].duration_seconds == 120
    assert rows[0].cost_usd == 0.1


@requires_db
async def test_live_issue_reserves_minimum_and_reports_only_increase(db_app, db, monkeypatch):
    class UpstreamResponse:
        status_code = 201
        is_error = False
        def json(self):
            return {"session": {"id": "live_reserved"}, "transport": {"type": "webrtc", "sdp": "v=0\r\nanswer"}}

    class UpstreamClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): return None
        async def post(self, *_args, **_kwargs): return UpstreamResponse()

    settings = type("Settings", (), {
        "openai_live_model": "gpt-live-1", "openai_api_key": "test-key",
        "openai_base_url": "https://api.openai.com/v1", "daily_spend_cap_usd": 5,
    })()
    monkeypatch.setattr(live_api, "get_settings", lambda: settings)
    monkeypatch.setattr(live_api, "_client", UpstreamClient)
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        issued = await client.post("/v1/live/calls", headers=AUTH, json={"sdp": "v=0\r\no=-"})
        reservation = (await db.execute(select(LiveUsage.duration_seconds, LiveUsage.cost_usd))).one()
        lower = await client.post("/v1/live/usage", headers=AUTH, json={
            "live_session_id": "live_reserved", "model": "gpt-live-1", "duration_seconds": 5,
        })
        after_lower = (await db.execute(select(LiveUsage.duration_seconds, LiveUsage.cost_usd))).one()
        higher = await client.post("/v1/live/usage", headers=AUTH, json={
            "live_session_id": "live_reserved", "model": "gpt-live-1", "duration_seconds": 120,
        })
        after_higher = (await db.execute(select(LiveUsage.duration_seconds, LiveUsage.cost_usd))).one()
        repeated_lower = await client.post("/v1/live/usage", headers=AUTH, json={
            "live_session_id": "live_reserved", "model": "gpt-live-1", "duration_seconds": 30,
        })
        final = (await db.execute(select(LiveUsage.duration_seconds, LiveUsage.cost_usd))).one()
    assert issued.status_code == 200
    assert reservation.duration_seconds == 15
    assert reservation.cost_usd == 0.0125
    assert lower.status_code == higher.status_code == repeated_lower.status_code == 204
    assert after_lower.duration_seconds == 15
    assert after_higher.duration_seconds == 120
    assert final.duration_seconds == 120
    assert final.cost_usd == 0.1


@requires_db
async def test_live_rejects_unknown_app_session_before_provider_call(db_app, monkeypatch):
    called = False
    class UpstreamClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): return None
        async def post(self, *_args, **_kwargs):
            nonlocal called
            called = True
            raise AssertionError("must not initialize a billed session")

    settings = type("Settings", (), {
        "openai_live_model": "gpt-live-1", "openai_api_key": "test-key",
        "openai_base_url": "https://api.openai.com/v1", "daily_spend_cap_usd": 5,
    })()
    monkeypatch.setattr(live_api, "get_settings", lambda: settings)
    monkeypatch.setattr(live_api, "_client", UpstreamClient)
    async with AsyncClient(transport=ASGITransport(app=db_app), base_url="http://test") as client:
        response = await client.post("/v1/live/calls", headers=AUTH, json={
            "session_id": str(uuid.uuid4()), "sdp": "v=0\r\no=-",
        })
    assert response.status_code == 404
    assert not called


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


@requires_db
async def test_deleting_a_session_forgets_it_but_keeps_the_learner(db_app, db):
    """The whole point of `DELETE /v1/sessions/{id}`: the episode behind the
    RECENT SESSIONS block goes, the session's own rows go (so the sweep
    cannot quietly re-record it from the surviving messages), and the
    learner's extracted memory and measured evidence stay.
    """
    learner = Learner(display_name="Test learner")
    kc = KC(code=f"T.{uuid.uuid4().hex[:8]}", title="t", description="t", grade="8")
    db.add_all([learner, kc])
    await db.flush()

    session = Session(model="gpt-5.6-sol", reasoning_effort="medium")
    db.add(session)
    await db.flush()
    db.add(Message(session_id=session.id, seq=0, role="learner", text="hi"))

    turn = Turn(
        id=uuid.uuid4(), session_id=session.id, status="ok",
        model="gpt-5.6-sol", reasoning_effort="medium",
    )
    db.add(turn)
    await db.flush()
    call = LLMCall(turn_id=turn.id, seq=0, model="gpt-5.6-sol", request={})
    db.add(call)
    await db.flush()
    db.add(ToolCall(turn_id=turn.id, llm_call_id=call.id, name="remember"))
    db.add(Attachment(
        turn_id=turn.id, kind="board_full", blob_key="sha256:" + "0" * 64,
        sha256="0" * 64, bytes=1, content_type="image/png",
    ))
    db.add(Episode(
        learner_id=learner.id, session_id=session.id, transcript="learner: hi",
        digest="Said hi.", message_count=1, started_at=session.started_at,
    ))
    atom = MemoryAtom(
        learner_id=learner.id, text="Likes teal.", category="preference",
        source_session_id=session.id,
    )
    observation = Observation(
        learner_id=learner.id, turn_id=turn.id, kc_id=kc.id,
        weight=1.0, outcome=1.0, reliability=0.9, kind="worked_problem",
    )
    db.add_all([atom, observation])
    await db.commit()
    # Plain values, read while the instances are live: `expire_all` below
    # turns every later attribute access into a lazy refresh, and refreshing
    # a deleted row from an async session raises MissingGreenlet.
    session_id = session.id

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.delete(f"/v1/sessions/{session_id}", headers=AUTH)

    assert response.status_code == 204
    # The delete ran through the app's own session; without this, the reads
    # below serve this session's identity-map copies (expire_on_commit=False)
    # and the nulled `Observation.turn_id` looks unchanged.
    db.expire_all()
    for model in (Session, Message, Turn, LLMCall, ToolCall, Attachment, Episode):
        assert (await db.execute(select(model))).scalars().first() is None, model

    kept_atom = (await db.execute(select(MemoryAtom))).scalar_one()
    assert kept_atom.text == "Likes teal."
    assert kept_atom.source_session_id == session_id
    kept_observation = (await db.execute(select(Observation))).scalar_one()
    assert kept_observation.turn_id is None


@requires_db
async def test_deleting_an_unknown_session_is_a_404(db_app):
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.delete(f"/v1/sessions/{uuid.uuid4()}", headers=AUTH)
    assert response.status_code == 404


@requires_db
async def test_deleting_a_purged_sessions_leftover_episode(db_app, db):
    """An episode deliberately outlives its session (`Episode.session_id` is
    not a foreign key), so a delete that arrives after the session rows are
    gone must still remove the episode — that row alone is what keeps the
    session in RECENT SESSIONS.
    """
    learner = Learner(display_name="Test learner")
    db.add(learner)
    await db.flush()
    session_id = uuid.uuid4()
    db.add(Episode(
        learner_id=learner.id, session_id=session_id, transcript="learner: hi",
        digest="Said hi.", message_count=1,
        started_at=datetime.now(timezone.utc),
    ))
    await db.commit()

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.delete(f"/v1/sessions/{session_id}", headers=AUTH)

    assert response.status_code == 204
    assert (await db.execute(select(Episode))).scalars().first() is None


@requires_db
async def test_deleting_a_session_requires_the_device_token(db_app):
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.delete(f"/v1/sessions/{uuid.uuid4()}")
    assert response.status_code == 401


@requires_db
async def test_turn_read_back_includes_the_full_trace(db_app, db, tmp_path):
    """This is the test that proves someone can reconstruct what the model
    was told and what it said: a nested JSONB request, the model's response,
    a tool call's arguments, and an attachment's blob key must all survive
    the round trip through `GET /v1/turns/{id}`.
    """
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()

    turn = Turn(
        id=uuid.uuid4(), session_id=session.id, status="ok",
        model="gpt-5.6-luna", reasoning_effort="high",
    )
    db.add(turn)
    await db.flush()

    llm_call = LLMCall(
        turn_id=turn.id, seq=0, model="gpt-5.6-luna",
        request={
            "model": "gpt-5.6-luna",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "check my work"}]}
            ],
        },
        response={"id": "resp_123", "text": "Looks right!"},
    )
    db.add(llm_call)
    await db.flush()

    store = LocalBlobStore(tmp_path)
    ref = await store.put(b"fake-png-bytes", "image/png")

    db.add(ToolCall(
        turn_id=turn.id, llm_call_id=llm_call.id, name="check_step",
        arguments={"step": 2}, result={"ok": True},
    ))
    db.add(Attachment(
        turn_id=turn.id, kind="board_png", blob_key=ref.key, sha256=ref.sha256,
        bytes=ref.bytes, content_type="image/png",
    ))
    await db.commit()

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.get(f"/v1/turns/{turn.id}", headers=AUTH)

    assert response.status_code == 200
    body = response.json()
    assert body["llm_calls"][0]["request"]["input"][0]["content"][0]["text"] == "check my work"
    assert body["llm_calls"][0]["response"] == {"id": "resp_123", "text": "Looks right!"}
    assert body["tool_calls"][0]["arguments"] == {"step": 2}
    assert body["attachments"][0]["blob_key"] == ref.key


@requires_db
async def test_getting_a_blob_streams_its_bytes_back(db_app, tmp_path):
    store = LocalBlobStore(tmp_path)
    ref = await store.put(b"hello blob", "text/plain")

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.get(f"/v1/blobs/{ref.key}", headers=AUTH)

    assert response.status_code == 200
    assert response.content == b"hello blob"


@requires_db
async def test_blob_route_rejects_path_traversal(db_app, tmp_path):
    """A regression test for the `:path`-converter defect: this key resolves
    (via `LocalBlobStore._path_for`) outside the blob root, so a real file
    is planted exactly there. Against the old `{key:path}` route with no
    shape check, this request would succeed and return that file's bytes,
    failing the assertion below — that is what makes this a regression test
    rather than a formality, not just a check that returns 404.
    """
    store = LocalBlobStore(tmp_path)
    traversal_key = "../../etc/passwd"
    escape_path = store._path_for(traversal_key)
    escape_path.parent.mkdir(parents=True, exist_ok=True)
    escape_path.write_bytes(b"root:x:0:0:root:/root:/bin/bash\n")

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        # A literal ".." in the URL is normalised away by httpx itself
        # before the request ever leaves the client, which would 404 for
        # the wrong reason (no route matches "/etc/passwd") and prove
        # nothing about this route's own defenses. Percent-encoding the
        # slashes keeps ".." as literal characters inside the `key`
        # segment all the way through to the ASGI scope's decoded path,
        # which is what actually exercises the route.
        response = await client.get(
            "/v1/blobs/..%2F..%2Fetc%2Fpasswd", headers=AUTH
        )

    assert response.status_code == 404
    assert response.content != escape_path.read_bytes()


@requires_db
async def test_getting_a_blob_with_two_attachments_sharing_the_key(db_app, db, tmp_path):
    """I5: blobs are content-addressed and deduplicated on disk, but
    record_attachment inserts a row per call, so a board that did not
    change between two turns produces two attachment rows sharing one
    blob_key — the normal case for a deduplicated store, not an edge case.
    scalar_one_or_none() raises MultipleResultsFound on exactly that; this
    is the regression test for it.
    """
    store = LocalBlobStore(tmp_path)
    ref = await store.put(b"same board twice", "image/png")

    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    db.add_all([
        Attachment(
            session_id=session.id, kind="board_png", blob_key=ref.key,
            sha256=ref.sha256, bytes=ref.bytes, content_type="image/png",
        ),
        Attachment(
            session_id=session.id, kind="board_png", blob_key=ref.key,
            sha256=ref.sha256, bytes=ref.bytes, content_type="image/png",
        ),
    ])
    await db.commit()

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.get(f"/v1/blobs/{ref.key}", headers=AUTH)

    assert response.status_code == 200
    assert response.content == b"same board twice"


@requires_db
async def test_an_unknown_but_well_formed_blob_key_is_a_404(db_app):
    unknown_key = "sha256:" + "0" * 64
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.get(f"/v1/blobs/{unknown_key}", headers=AUTH)
    assert response.status_code == 404


@requires_db
async def test_turn_and_blob_read_back_require_the_device_token(db_app):
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        turn_response = await client.get(f"/v1/turns/{uuid.uuid4()}")
        blob_response = await client.get(f"/v1/blobs/sha256:{'0' * 64}")

    assert turn_response.status_code == 401
    assert blob_response.status_code == 401


@requires_db
async def test_replacing_the_transcript_makes_the_prefix_the_whole_story(db_app, db):
    """`PUT /v1/sessions/{id}/transcript` after an edit-and-resend: the rows
    become exactly the device's prefix, reseqed from 0, and the cut tail is
    gone — including a retry's duplicate learner row, which is why this is a
    replace and not a delete-from-seq.
    """
    session = Session(model="gpt-5.6-sol", reasoning_effort="medium")
    db.add(session)
    await db.flush()
    for seq, (role, text) in enumerate([
        ("learner", "first question"),
        ("learner", "first question"),  # a retry's duplicate row
        ("tutor", "first answer"),
        ("learner", "second question"),
        ("tutor", "second answer"),
    ]):
        db.add(Message(session_id=session.id, seq=seq, role=role, text=text))
    await db.commit()

    prefix = {
        "messages": [
            {"role": "learner", "text": "first question", "signal": "evaluate"},
            {"role": "tutor", "text": "first answer"},
        ]
    }
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.put(
            f"/v1/sessions/{session.id}/transcript", json=prefix, headers=AUTH
        )

    assert response.status_code == 204
    rows = (
        await db.execute(
            select(Message)
            .where(Message.session_id == session.id)
            .order_by(Message.seq)
        )
    ).scalars().all()
    assert [(m.seq, m.role, m.text, m.signal) for m in rows] == [
        (0, "learner", "first question", "evaluate"),
        (1, "tutor", "first answer", None),
    ]


@requires_db
async def test_replacing_with_an_empty_prefix_empties_the_transcript(db_app, db):
    """An edit of the very first message cuts everything: the prefix is
    empty, and so — after the PUT — is the transcript."""
    session = Session(model="gpt-5.6-sol", reasoning_effort="medium")
    db.add(session)
    await db.flush()
    db.add(Message(session_id=session.id, seq=0, role="learner", text="hello"))
    await db.commit()

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.put(
            f"/v1/sessions/{session.id}/transcript",
            json={"messages": []},
            headers=AUTH,
        )

    assert response.status_code == 204
    remaining = (
        await db.execute(
            select(Message).where(Message.session_id == session.id)
        )
    ).scalars().all()
    assert remaining == []


@requires_db
async def test_replacing_an_unknown_sessions_transcript_creates_the_session(
    db_app, db
):
    """A live-voice session syncs its transcript before anything calls
    `/v1/turn`, so the first sync arrives for a session id the backend has
    never seen. This used to 404 and the spoken conversation stayed on the
    device; now the row is created with the defaults and the messages land.
    """
    session_id = uuid.uuid4()
    body = {
        "messages": [
            {"role": "learner", "text": "what is a fraction"},
            {"role": "tutor", "text": "a part of a whole"},
        ]
    }
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.put(
            f"/v1/sessions/{session_id}/transcript", json=body, headers=AUTH
        )

    assert response.status_code == 204
    created = await db.get(Session, session_id)
    assert created is not None
    assert created.model == DEFAULT_MODEL
    assert created.reasoning_effort == DEFAULT_REASONING_EFFORT
    rows = (
        await db.execute(
            select(Message)
            .where(Message.session_id == session_id)
            .order_by(Message.seq)
        )
    ).scalars().all()
    assert [(m.seq, m.role, m.text) for m in rows] == [
        (0, "learner", "what is a fraction"),
        (1, "tutor", "a part of a whole"),
    ]


@requires_db
async def test_a_transcript_with_an_unknown_role_is_rejected(db_app, db):
    session = Session(model="gpt-5.6-sol", reasoning_effort="medium")
    db.add(session)
    await db.commit()

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        response = await client.put(
            f"/v1/sessions/{session.id}/transcript",
            json={"messages": [{"role": "narrator", "text": "no"}]},
            headers=AUTH,
        )
    assert response.status_code == 422
