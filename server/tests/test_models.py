import uuid

from sqlalchemy import select

from app.store.models import Message, Session
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
