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
    db.add(Turn(
        id=turn_id, session_id=session.id, status="running",
        model="gpt-5.6-luna", reasoning_effort="high",
    ))
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

    turn = (await db.execute(select(Turn))).scalar_one()
    assert turn.status == "ok"
    assert turn.ttft_ms == 420
    assert turn.input_tokens == 100

    call = (await db.execute(select(LLMCall))).scalar_one()
    assert call.raw_events_blob is not None


@requires_db
async def test_the_recorder_returns_every_connection_it_takes(db_factory, tmp_path):
    """A leaked session per turn exhausts the pool after a day of tutoring."""
    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    for _ in range(30):
        assert await recorder.spend_today() == 0.0
