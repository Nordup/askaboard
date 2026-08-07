import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.store.models import Attachment, LLMCall, Message, Session, ToolCall, Turn
from tests.conftest import requires_db


@requires_db
async def test_session_and_message_round_trip(db):
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()

    db.add(Message(session_id=session.id, seq=0, role="learner", text="hello"))
    await db.commit()

    stored = (await db.execute(select(Message))).scalar_one()
    assert stored.text == "hello"
    assert stored.session_id == session.id
    assert isinstance(session.id, uuid.UUID)


@requires_db
async def test_turn_id_is_client_generated_and_survives_unchanged(db):
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()

    client_id = uuid.uuid4()
    db.add(
        Turn(
            id=client_id,
            session_id=session.id,
            status="ok",
            model="gpt-5.6-luna",
            reasoning_effort="high",
        )
    )
    await db.commit()

    stored = (await db.execute(select(Turn))).scalar_one()
    assert stored.id == client_id


@requires_db
async def test_turn_without_an_id_is_rejected(db):
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()

    # Turn.id is deliberately undefaulted (the client supplies it, which is
    # what makes a turn idempotent), so omitting it must fail rather than
    # silently generating one.
    db.add(
        Turn(
            session_id=session.id,
            status="ok",
            model="gpt-5.6-luna",
            reasoning_effort="high",
        )
    )
    with pytest.raises(IntegrityError):
        await db.commit()


@requires_db
async def test_llm_call_tool_call_and_attachment_round_trip(db):
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()

    turn = Turn(
        id=uuid.uuid4(),
        session_id=session.id,
        status="ok",
        model="gpt-5.6-luna",
        reasoning_effort="high",
    )
    db.add(turn)
    await db.flush()

    nested_request = {
        "model": "gpt-5.6-luna",
        "messages": [
            {"role": "system", "content": "You are a tutor."},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "How is this so far?"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc", "detail": "high"}},
                ],
            },
        ],
        "temperature": 0.7,
        "metadata": {"tags": ["board", "check"], "retry": {"count": 0, "reasons": []}},
    }

    llm_call = LLMCall(
        turn_id=turn.id,
        seq=0,
        model="gpt-5.6-luna",
        request=nested_request,
    )
    db.add(llm_call)
    await db.flush()

    db.add(
        ToolCall(
            turn_id=turn.id,
            llm_call_id=llm_call.id,
            name="set_workspace",
            arguments={"plan": "1. Add 2\n2. Add 3"},
            result={"ok": True},
        )
    )
    db.add(
        Attachment(
            turn_id=turn.id,
            kind="board_png",
            blob_key="ab/cd/abcd1234",
            sha256="a" * 64,
            bytes=1024,
            content_type="image/png",
        )
    )
    await db.commit()

    stored_llm_call = (await db.execute(select(LLMCall))).scalar_one()
    assert stored_llm_call.request == nested_request
    assert stored_llm_call.turn_id == turn.id

    stored_tool_call = (await db.execute(select(ToolCall))).scalar_one()
    assert stored_tool_call.llm_call_id == llm_call.id
    assert stored_tool_call.turn_id == turn.id
    assert stored_tool_call.arguments == {"plan": "1. Add 2\n2. Add 3"}

    stored_attachment = (await db.execute(select(Attachment))).scalar_one()
    assert stored_attachment.turn_id == turn.id
    assert stored_attachment.sha256 == "a" * 64


@requires_db
async def test_message_with_a_nonexistent_session_id_is_rejected(db):
    db.add(Message(session_id=uuid.uuid4(), seq=0, role="learner", text="hello"))
    with pytest.raises(IntegrityError):
        await db.commit()
