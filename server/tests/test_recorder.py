import uuid

import pytest
from sqlalchemy import select

from app.attachments.convert import Converted
from app.attachments.kinds import Kind
from app.store.blobs import LocalBlobStore
from app.store.models import (
    Attachment, LLMCall, Message, RealtimeUsage, Session, ToolCall, Turn,
)
from app.store.recorder import (
    ORIGINAL_CONTENT_TYPE, REPLY_LOST_TEXT, Recorder, cache_tokens, redact_images,
)
from tests.conftest import requires_db


def test_cache_tokens_reads_the_nested_hit_count():
    cached, written = cache_tokens({
        "input_tokens": 9_800,
        "input_tokens_details": {"cached_tokens": 9_216},
    })
    assert cached == 9_216
    assert written is None


def test_cache_tokens_finds_the_write_count_wherever_it_is_reported():
    """The provider documents the field beside `cached_tokens` but reports it
    at the top level in some responses. Reading one place and guessing wrong
    is a column that is silently always NULL."""
    nested = cache_tokens({"input_tokens_details": {"cache_write_tokens": 512}})
    top = cache_tokens({"cache_write_tokens": 512})

    assert nested[1] == 512
    assert top[1] == 512


def test_cache_tokens_of_a_turn_that_reported_nothing_is_two_nones():
    """A failed turn's usage is often `{}`. Zero would be a measurement; None
    is the truth, which is that nothing was measured."""
    assert cache_tokens({}) == (None, None)


def test_redact_images_replaces_the_data_url_with_a_blob_ref():
    body = {
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": "check this"},
                {"type": "input_image", "image_url": "data:image/png;base64,QUJD"},
            ],
        }]
    }
    redacted = redact_images(body, "sha256:deadbeef")
    image_part = redacted["input"][0]["content"][1]
    assert image_part["image_url"] == {"blob": "sha256:deadbeef"}
    assert redacted["input"][0]["content"][0]["text"] == "check this"


def test_redact_images_leaves_an_imageless_body_untouched():
    body = {"input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]}
    assert redact_images(body, "sha256:x") == body


async def test_record_attachment_requires_a_turn_or_a_session(tmp_path):
    """An attachment with neither is a row nothing could ever find again.

    Raises before opening a session or touching the blob store — the
    sessionmaker below is never called, so a value that would fail if
    invoked is enough to prove this.
    """
    def _unreachable_sessionmaker():
        raise AssertionError("record_attachment must not open a session")

    recorder = Recorder(_unreachable_sessionmaker, LocalBlobStore(tmp_path))
    with pytest.raises(ValueError):
        await recorder.record_attachment(kind="audio", data=b"x", content_type="audio/wav")


@requires_db
async def test_record_attachment_can_attach_to_a_session_without_a_turn(db, db_factory, tmp_path):
    """A dictation has no turn_id yet — this is the schema path it uses."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    ref = await recorder.record_attachment(
        session_id=session.id, kind="audio", data=b"RIFF-fake-wav-bytes",
        content_type="audio/wav",
    )

    async with db_factory() as fresh:
        stored = (await fresh.execute(select(Attachment))).scalar_one()
        assert stored.session_id == session.id
        assert stored.turn_id is None
        assert stored.blob_key == ref.key


@requires_db
async def test_finish_turn_writes_the_turn_and_its_llm_call(db, db_factory, tmp_path):
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    turn = Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    )
    db.add(turn)
    await db.commit()

    # The factory, not the borrowed `db` session — the recorder opens and
    # closes its own, which is the behaviour under test.
    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    from app.tutor.loop import TurnResult
    result = TurnResult(
        raw_events=[{"type": "response.created"}],
        usage={"input_tokens": 100, "output_tokens": 20},
        text="Nice work.",
        tool_calls=[{
            "name": "remember",
            "arguments": {"text": "Prefers diagrams first."},
            "result": "Saved. You can tell the learner you will remember it.",
        }],
    )
    await recorder.finish_turn(
        turn_id=turn_id, session_id=session.id, next_seq=1,
        result=result, request_body={"model": "gpt-5.6-luna"},
        ttft_ms=420, latency_ms=1800,
    )

    # Read back through a fresh session, not `db`. `db` still holds a strong
    # reference to the `turn` object above, so its identity map would hand
    # back that same (now stale) instance on a plain select() instead of
    # re-querying the row the recorder just wrote — the assertions would
    # pass against pre-update values even if finish_turn did nothing. A new
    # session from db_factory has no identity-map entry for this row, so it
    # has no choice but to load what is actually in the database, which is
    # also a more honest test of what finish_turn promises: that another
    # connection can see the write.
    async with db_factory() as fresh:
        stored_turn = (await fresh.execute(select(Turn))).scalar_one()
        assert stored_turn.status == "ok"
        assert stored_turn.ttft_ms == 420
        assert stored_turn.input_tokens == 100

        call = (await fresh.execute(select(LLMCall))).scalar_one()
        assert call.raw_events_blob is not None

        tools = (await fresh.execute(select(ToolCall))).scalars().all()
        assert len(tools) == 1
        assert tools[0].llm_call_id == call.id
        assert tools[0].name == "remember"
        assert tools[0].arguments == {"text": "Prefers diagrams first."}
        assert tools[0].result == {
            "output": "Saved. You can tell the learner you will remember it.",
        }


@requires_db
async def test_finish_turn_writes_the_tutors_reply_as_a_message(db, db_factory, tmp_path):
    """C1: without this, assemble_context's transcript is learner-only —
    the model can never see anything it said on an earlier turn."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    from app.tutor.loop import TurnResult
    result = TurnResult(raw_events=[], usage={}, text="Nice work.")
    await recorder.finish_turn(
        turn_id=turn_id, session_id=session.id, next_seq=1,
        result=result, request_body={"model": "gpt-5.6-luna"},
        ttft_ms=1, latency_ms=1,
    )

    async with db_factory() as fresh:
        rows = (
            await fresh.execute(select(Message).order_by(Message.seq))
        ).scalars().all()
        assert [(m.seq, m.role, m.text) for m in rows] == [(1, "tutor", "Nice work.")]


@requires_db
async def test_finish_turn_writes_no_message_when_the_turn_produced_no_text(
    db, db_factory, tmp_path
):
    """A pure tool-call turn (set_workspace with no accompanying reply) must
    not write a blank tutor message."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    from app.tutor.loop import TurnResult
    result = TurnResult(raw_events=[], usage={}, text="")
    await recorder.finish_turn(
        turn_id=turn_id, session_id=session.id, next_seq=1,
        result=result, request_body={"model": "gpt-5.6-luna"},
        ttft_ms=1, latency_ms=1,
    )

    async with db_factory() as fresh:
        assert (await fresh.execute(select(Message))).first() is None


@requires_db
async def test_finish_turn_persists_the_workspace_onto_the_session(
    db, db_factory, tmp_path
):
    """C2: sessions.plan / sessions.exercise must land in the same write as
    the turn's own "ok" status — otherwise compose_user_prompt's EXERCISE
    CONTEXT and SESSION PLAN sections, and GET /v1/sessions/{id}, stay NULL
    forever."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
    await db.commit()

    workspace = {
        "type": "workspace",
        "plan": {
            "title": "Fractions", "goal": "Add unlike fractions",
            "outcomes": ["Find a common denominator"], "steps": ["Find the LCD"],
            "currentStep": 0,
        },
        "exercise": {
            "title": "Add 1/3 and 1/4", "prompt": "What is 1/3 + 1/4?",
            "hint": "Find a common denominator first.", "context": "Unlike denominators",
        },
    }
    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    from app.tutor.loop import TurnResult
    result = TurnResult(raw_events=[], usage={}, text="", workspace=workspace)
    await recorder.finish_turn(
        turn_id=turn_id, session_id=session.id, next_seq=0,
        result=result, request_body={"model": "gpt-5.6-luna"},
        ttft_ms=1, latency_ms=1,
    )

    async with db_factory() as fresh:
        stored = (await fresh.execute(select(Session))).scalar_one()
        assert stored.plan == workspace["plan"]
        assert stored.exercise == workspace["exercise"]


@requires_db
async def test_the_recorder_returns_every_connection_it_takes(db_factory, tmp_path):
    """A leaked session per turn exhausts the pool after a day of tutoring."""
    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    for _ in range(30):
        assert await recorder.spend_today() == 0.0


@requires_db
async def test_fail_turn_persists_the_partial_output_alongside_the_error(
    db, db_factory, tmp_path
):
    """The text a learner already saw on screen must survive a mid-stream
    failure, not just the failure message — that partial output is the
    evidence someone debugging a bad turn needs."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    turn = Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    )
    db.add(turn)
    await db.commit()

    blob_store = LocalBlobStore(tmp_path)
    recorder = Recorder(db_factory, blob_store)
    from app.tutor.loop import TurnResult
    result = TurnResult(
        raw_events=[
            {"type": "response.created"},
            {"type": "response.output_text.delta", "delta": "Nice wo"},
        ],
        text="Nice wo",
    )
    await recorder.fail_turn(
        turn_id=turn_id, message="connection reset", retryable=True,
        result=result, request_body={"model": "gpt-5.6-luna"},
    )

    async with db_factory() as fresh:
        stored_turn = (await fresh.execute(select(Turn))).scalar_one()
        assert stored_turn.status == "error"
        assert stored_turn.error == {"message": "connection reset", "retryable": True}

        call = (await fresh.execute(select(LLMCall))).scalar_one()
        assert call.response["text"] == "Nice wo"
        assert call.raw_events_blob is not None

        # The transcript gets the `[reply lost]` marker, never the partial
        # text: the partial was never delivered as a reply, and recording it
        # as one would put words in the tutor's mouth that the next turn's
        # context then treats as said. The partial stays in `llm_calls` above.
        message = (await fresh.execute(select(Message))).scalar_one()
        assert (message.role, message.text) == ("tutor", REPLY_LOST_TEXT)

    raw = await blob_store.get(call.raw_events_blob)
    assert b"response.created" in raw
    assert b"Nice wo" in raw


@requires_db
async def test_fail_turn_records_the_tokens_the_provider_already_billed_for(
    db, db_factory, tmp_path
):
    """A turn that dies after the model has produced output has still been paid
    for. Recording nothing was the exact shape of the failure that started all
    of this: money spent, no reply, and no row saying how much."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
    await db.commit()

    from app.tutor.loop import TurnResult
    result = TurnResult(
        raw_events=[{"type": "response.created"}],
        text="",
        usage={
            "input_tokens": 24294,
            "output_tokens": 4314,
            "output_tokens_details": {"reasoning_tokens": 467},
        },
    )
    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    await recorder.fail_turn(
        turn_id=turn_id, message="the client disconnected", retryable=True,
        result=result, request_body={"model": "gpt-5.6-luna"},
        diagnostics={"elapsed_ms": 109_000, "max_silence_ms": 61_000, "events_sent": 3},
    )

    async with db_factory() as fresh:
        stored = (await fresh.execute(select(Turn))).scalar_one()
        assert stored.input_tokens == 24294
        assert stored.output_tokens == 4314
        assert stored.reasoning_tokens == 467
        # Over sixty seconds of silence on a turn the client gave up on is the
        # signature of a timeout, and now it is a value someone can query for
        # rather than a theory someone has to reconstruct.
        assert stored.error["diagnostics"]["max_silence_ms"] == 61_000
        assert stored.error["message"] == "the client disconnected"


@requires_db
async def test_fail_turn_records_the_tool_calls_that_did_run(
    db, db_factory, tmp_path
):
    """A turn that spent money and died is the turn whose tool calls matter
    most, and this path used to drop every one of them. A session that
    downloaded four pictures and then hit a rate limit left `SELECT count(*)
    FROM tool_calls WHERE name='fetch_image'` answering zero, all time —
    nothing else holds them: `llm_calls.request` is the *first* round's body, so
    the accumulated calls never reach it, and `raw_events` is what the provider
    sent, never what a tool answered."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    from app.tutor.loop import TurnResult
    result = TurnResult(
        raw_events=[{"type": "response.created"}],
        usage={"input_tokens": 87_037, "output_tokens": 2_410},
        tool_calls=[
            {"name": "view_board",
             "arguments": {"x": 45, "y": 0, "width": 55, "height": 100},
             "result": '{"status": "ok"}'},
            {"name": "fetch_image",
             "arguments": {"url": "https://example.com/fish.png"},
             "result": '{"blob_id": "sha256:abc", "width": 1080, "height": 1080}'},
        ],
    )
    await recorder.fail_turn(
        turn_id=turn_id, message="APIError: Rate limit reached", retryable=True,
        result=result, request_body={"model": "gpt-5.6-luna"},
    )

    async with db_factory() as fresh:
        call = (await fresh.execute(select(LLMCall))).scalar_one()
        tools = (await fresh.execute(
            select(ToolCall).order_by(ToolCall.name)
        )).scalars().all()
        assert [tool.name for tool in tools] == ["fetch_image", "view_board"]
        assert all(tool.llm_call_id == call.id for tool in tools)
        assert tools[0].arguments == {"url": "https://example.com/fish.png"}
        assert tools[0].result == {
            "output": '{"blob_id": "sha256:abc", "width": 1080, "height": 1080}',
        }


@requires_db
async def test_fail_turn_files_the_tool_calls_once_however_often_it_runs(
    db, db_factory, tmp_path
):
    """A second pass is a real path, not a defensive one: the request handler
    swallows a failed `fail_turn` write, then its `finally` sees the turn still
    "running" and fails it again. A second pass that re-filed every call would
    report a turn that fetched one picture as having fetched two."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    from app.tutor.loop import TurnResult
    result = TurnResult(
        raw_events=[{"type": "response.created"}],
        tool_calls=[{"name": "fetch_image", "arguments": {"url": "u"},
                     "result": "{}"}],
    )
    for _ in range(2):
        await recorder.fail_turn(
            turn_id=turn_id, message="rate limited", retryable=True,
            result=result, request_body={"model": "gpt-5.6-luna"},
        )

    async with db_factory() as fresh:
        tools = (await fresh.execute(select(ToolCall))).scalars().all()
        assert len(tools) == 1


@requires_db
async def test_fail_turn_without_a_result_still_records_the_error(db, db_factory, tmp_path):
    """Failures before any model call exists (idempotency, spend cap) have no
    TurnResult to persist — fail_turn must still work without one."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    await recorder.fail_turn(turn_id=turn_id, message="spend cap reached", retryable=False)

    async with db_factory() as fresh:
        stored_turn = (await fresh.execute(select(Turn))).scalar_one()
        assert stored_turn.status == "error"
        assert (await fresh.execute(select(LLMCall))).first() is None
        # Even with no TurnResult, the failed turn leaves the `[reply lost]`
        # tutor line, so the window an episode later freezes over this session
        # reads as what happened rather than as a learner talking to silence.
        message = (await fresh.execute(select(Message))).scalar_one()
        assert (message.seq, message.role, message.text) == (
            0, "tutor", REPLY_LOST_TEXT,
        )


@requires_db
async def test_finish_turn_prices_the_turn_into_cost_usd(db, db_factory, tmp_path):
    """The column `spend_today()` sums. Nothing wrote it before this — the
    daily cap read 0.0 forever and could never trip."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    from app.tutor.loop import TurnResult
    result = TurnResult(
        raw_events=[], text="ok",
        usage={
            "input_tokens": 1_000_000,
            "output_tokens": 1_000_000,
            "input_tokens_details": {"cached_tokens": 500_000},
        },
    )
    await recorder.finish_turn(
        turn_id=turn_id, session_id=session.id, next_seq=1,
        result=result, request_body={"model": "gpt-5.6-luna"},
        ttft_ms=1, latency_ms=1,
    )

    async with db_factory() as fresh:
        stored = (await fresh.execute(select(Turn))).scalar_one()
        # 500k uncached in at $0.20/1M + 500k cached at $0.02/1M + 1M out at $1.20/1M.
        assert stored.cost_usd == pytest.approx(0.10 + 0.01 + 1.20)
    assert await recorder.spend_today() == pytest.approx(1.31)


@requires_db
async def test_fail_turn_prices_the_tokens_it_records(db, db_factory, tmp_path):
    """A turn that died after the provider billed for output was still paid
    for — its dollars must count against the cap like anyone else's."""
    session = Session(model="gpt-5.6-sol", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-sol", reasoning_effort="high",
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    from app.tutor.loop import TurnResult
    result = TurnResult(
        raw_events=[], text="",
        usage={"input_tokens": 24_294, "output_tokens": 4_314,
               "output_tokens_details": {"reasoning_tokens": 467}},
    )
    await recorder.fail_turn(
        turn_id=turn_id, message="connection reset", retryable=True,
        result=result, request_body={"model": "gpt-5.6-sol"},
    )

    async with db_factory() as fresh:
        stored = (await fresh.execute(select(Turn))).scalar_one()
        assert stored.cost_usd == pytest.approx(
            (24_294 * 5.00 + 4_314 * 30.00) / 1_000_000
        )


@requires_db
async def test_a_turn_with_no_usage_leaves_cost_usd_null(db, db_factory, tmp_path):
    """No usage means nothing was measured; NULL is the truth, and it keeps
    `spend_today()`'s sum honest rather than quietly adding zeros."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    turn_id = uuid.uuid4()
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    from app.tutor.loop import TurnResult
    result = TurnResult(raw_events=[], usage={}, text="ok")
    await recorder.finish_turn(
        turn_id=turn_id, session_id=session.id, next_seq=1,
        result=result, request_body={"model": "gpt-5.6-luna"},
        ttft_ms=1, latency_ms=1,
    )

    async with db_factory() as fresh:
        stored = (await fresh.execute(select(Turn))).scalar_one()
        assert stored.cost_usd is None


@requires_db
async def test_record_realtime_usage_prices_and_stores_the_row(db_factory, tmp_path):
    """One voice response's token bill, priced and written. `session_id` is a
    plain uuid on purpose — a voice call can start before any turn has created
    the session row, and the report must still land."""
    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    session_id = uuid.uuid4()

    await recorder.record_realtime_usage(
        report_id=uuid.uuid4(), session_id=session_id, response_id="resp_1",
        model="gpt-realtime-2.1",
        audio_input_tokens=100_000, cached_audio_input_tokens=40_000,
        audio_output_tokens=50_000,
        text_input_tokens=10_000, cached_text_input_tokens=5_000,
        text_output_tokens=2_000,
    )

    async with db_factory() as fresh:
        row = (await fresh.execute(select(RealtimeUsage))).scalar_one()
        assert row.session_id == session_id
        assert row.model == "gpt-realtime-2.1"
        assert row.audio_input_tokens == 100_000
        assert row.cost_usd == pytest.approx(
            (60_000 * 32.00 + 40_000 * 0.40 + 50_000 * 64.00
             + 5_000 * 4.00 + 5_000 * 0.40 + 2_000 * 24.00) / 1_000_000
        )


@requires_db
async def test_record_realtime_usage_is_idempotent_on_the_report_id(
    db_factory, tmp_path
):
    """The device may retry a report it never got an answer for. The same
    report id twice must bill once — same pattern as `Turn.id`."""
    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    report_id = uuid.uuid4()
    for _ in range(2):
        await recorder.record_realtime_usage(
            report_id=report_id, session_id=None, response_id="resp_1",
            model="gpt-realtime-2.1",
            audio_input_tokens=1_000, cached_audio_input_tokens=0,
            audio_output_tokens=1_000,
            text_input_tokens=0, cached_text_input_tokens=0,
            text_output_tokens=0,
        )

    async with db_factory() as fresh:
        rows = (await fresh.execute(select(RealtimeUsage))).scalars().all()
        assert len(rows) == 1


@requires_db
async def test_spend_today_sums_turn_and_voice_spend(db, db_factory, tmp_path):
    """The cap covers voice: a day's spend is turns plus realtime rows. On
    2026-08-15 voice was ~$4.70 of a $7 day and none of it was counted."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    db.add(Turn(
        id=uuid.uuid4(), session_id=session.id, status="ok",
        model="gpt-5.6-luna", reasoning_effort="high", cost_usd=1.25,
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    await recorder.record_realtime_usage(
        report_id=uuid.uuid4(), session_id=session.id, response_id=None,
        model="gpt-realtime-2.1",
        audio_input_tokens=0, cached_audio_input_tokens=0,
        audio_output_tokens=50_000,  # 50k audio out at $64/1M = $3.20
        text_input_tokens=0, cached_text_input_tokens=0,
        text_output_tokens=0,
    )

    assert await recorder.spend_today() == pytest.approx(1.25 + 3.20)


@requires_db
async def test_spend_today_ignores_yesterdays_voice_rows(db, db_factory, tmp_path):
    """It is a *daily* cap; only rows since UTC midnight count."""
    from datetime import datetime, timedelta, timezone
    db.add(RealtimeUsage(
        id=uuid.uuid4(), session_id=None, response_id=None,
        model="gpt-realtime-2.1",
        audio_input_tokens=0, cached_audio_input_tokens=0,
        audio_output_tokens=1_000_000,
        text_input_tokens=0, cached_text_input_tokens=0,
        text_output_tokens=0,
        cost_usd=64.0,
        created_at=datetime.now(timezone.utc) - timedelta(days=1),
    ))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    assert await recorder.spend_today() == 0.0


@requires_db
async def test_record_upload_stores_both_the_original_and_what_the_model_saw(
    db, db_factory, tmp_path
):
    """An investigation needs two things: what the learner sent, and what the
    model actually read. One row holds both blob keys."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.commit()

    blob_store = LocalBlobStore(tmp_path)
    recorder = Recorder(db_factory, blob_store)
    converted = Converted(
        kind=Kind.IMAGE, data=b"converted-jpeg-bytes", text=None,
        content_type="image/jpeg", page_count=1, thumbnail=b"thumb",
    )

    upload_id = await recorder.record_upload(
        session_id=session.id, filename="worksheet.png",
        converted=converted, original=b"original-png-bytes",
    )

    [row] = await recorder.load_uploads(session_id=session.id, ids=[upload_id])
    assert row.kind == "learner_upload"
    assert row.filename == "worksheet.png"
    assert row.turn_id is None
    assert await blob_store.get(row.blob_key) == b"original-png-bytes"
    assert await blob_store.get(row.converted_blob_key) == b"converted-jpeg-bytes"
    assert row.converted_content_type == "image/jpeg"
    assert row.page_count == 1
    # And the two content types describe their own blob. `content_type` used to
    # be set to the *converted* type, so a HEIC upload produced a row saying
    # `image/jpeg` over a `blob_key` holding HEIC — the one column someone
    # investigating a bad turn would read first, answering a question it was
    # not being asked.
    assert row.content_type == ORIGINAL_CONTENT_TYPE


@requires_db
async def test_a_repeat_upload_of_the_same_file_stores_the_blob_once(
    db, db_factory, tmp_path
):
    """The same worksheet attached to three turns is one blob on disk.

    The blob store is content-addressed, so this falls out of the key rather
    than out of a check — which is exactly why it is worth pinning: the day
    `record_upload` starts salting a key or writing per-row paths, a learner
    re-sending the same 20MB PDF starts costing 20MB each time, and nothing
    else in the suite would notice.

    Two rows, though, not one. An upload is a thing the learner did, and they
    did it twice.
    """
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.commit()

    blob_store = LocalBlobStore(tmp_path)
    recorder = Recorder(db_factory, blob_store)
    converted = Converted(
        kind=Kind.PDF, data=b"%PDF-1.4 same", text=None,
        content_type="application/pdf", page_count=1, thumbnail=b"thumb",
    )

    first = await recorder.record_upload(
        session_id=session.id, filename="worksheet.pdf",
        converted=converted, original=b"%PDF-1.4 same",
    )
    second = await recorder.record_upload(
        session_id=session.id, filename="worksheet.pdf",
        converted=converted, original=b"%PDF-1.4 same",
    )

    assert first != second
    rows = await recorder.load_uploads(session_id=session.id, ids=[first, second])
    assert rows[0].blob_key == rows[1].blob_key
    assert rows[0].sha256 == rows[1].sha256
    # One blob for the original, one for the thumbnail. The converted bytes are
    # the original here — a PDF passes through untouched — and a content
    # addressed store gives that back for free.
    assert len(list(tmp_path.rglob("*.blob"))) == 2


@requires_db
async def test_load_uploads_refuses_another_sessions_attachment(db, db_factory, tmp_path):
    """An attachment id is a capability. One device must not be able to name
    another's, and the session is what scopes it."""
    mine = Session(model="gpt-5.6-luna", reasoning_effort="high")
    theirs = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add_all([mine, theirs])
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    converted = Converted(
        kind=Kind.IMAGE, data=b"jpeg", text=None,
        content_type="image/jpeg", page_count=1, thumbnail=b"thumb",
    )
    upload_id = await recorder.record_upload(
        session_id=theirs.id, filename="private.png", converted=converted, original=b"png",
    )

    assert await recorder.load_uploads(session_id=mine.id, ids=[upload_id]) == []


@requires_db
async def test_load_uploads_refuses_an_attachment_of_another_kind(db, db_factory, tmp_path):
    """The kind filter is the other half of the same guard, and it had no test:
    deleting `Attachment.kind == "learner_upload"` left the whole suite green.

    Every row an id could name in this session is reachable without it — the
    board image uploaded on every turn, a dictation's audio — and the turn
    handler would hand whichever one it found to the model as a file the
    learner attached.
    """
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    await recorder.record_attachment(
        session_id=session.id, kind="audio", data=b"wav", content_type="audio/wav",
    )
    async with db_factory() as fresh:
        audio_id = (await fresh.execute(
            select(Attachment.id).where(Attachment.session_id == session.id)
        )).scalar_one()

    assert await recorder.load_uploads(session_id=session.id, ids=[audio_id]) == []


@requires_db
async def test_load_uploads_returns_rows_in_the_order_asked_for(db, db_factory, tmp_path):
    """The order is the learner's chip order, and it decides the order the
    model sees the pages in."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    converted = Converted(
        kind=Kind.IMAGE, data=b"jpeg", text=None,
        content_type="image/jpeg", page_count=1, thumbnail=b"thumb",
    )
    first = await recorder.record_upload(
        session_id=session.id, filename="a.png", converted=converted, original=b"a",
    )
    second = await recorder.record_upload(
        session_id=session.id, filename="b.png", converted=converted, original=b"b",
    )

    rows = await recorder.load_uploads(session_id=session.id, ids=[second, first])
    assert [row.filename for row in rows] == ["b.png", "a.png"]
