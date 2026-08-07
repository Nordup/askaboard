import uuid

from sqlalchemy import select

from app.store.blobs import LocalBlobStore
from app.store.models import LLMCall, Session, Turn
from app.store.recorder import Recorder, redact_images
from tests.conftest import requires_db


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
    )
    await recorder.finish_turn(
        turn_id=turn_id, result=result, request_body={"model": "gpt-5.6-luna"},
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


@requires_db
async def test_the_recorder_returns_every_connection_it_takes(db_factory, tmp_path):
    """A leaked session per turn exhausts the pool after a day of tutoring."""
    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    for _ in range(30):
        assert await recorder.spend_today() == 0.0
