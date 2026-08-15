"""The founder scenario, as a regression: session, note, new session, recall.

The forensics report (docs/research/memory/session-forensics.md) records the
failure this file must keep impossible: a voice session asked four times what
the previous session did, the standing block held a one-message fossil, the
saved note was nowhere in any request, and no memory tool was ever called. The
tutor answered confidently and wrongly, four times.

Three tests, one per leg of the fix, each driven through `POST /v1/turn` with
a scripted provider — the same vantage point as `test_turn_memory`, because
"the model was told" is only distinguishable from "we wrote it down somewhere"
in the request body respx captures on its way out.

A scripted provider cannot *decide* to call a tool, so the recency test
asserts the stronger, deterministic property the design turns on: the answer
to "what did we do last time" is already in the prompt — dated, labelled,
with the newest session's full narrative — before the model thinks at all.
The detail test scripts the call the prompt instructs and asserts the exact
stored words come back; the note test asserts the wholesale re-injection that
made `remember` worth trusting.
"""

import json
import uuid
from datetime import datetime, timedelta, timezone

import respx
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import select

from app.config import EMBEDDING_DIMS, SOLE_LEARNER_ID
from app.store.models import Episode, Learner, MemoryAtom
from tests.conftest import requires_db
from tests.fixtures.sse import TEXT_ONLY_TURN, sse_stream

AUTH = {"Authorization": "Bearer test-token"}

#: The note the founder actually saved on 2026-08-15, verbatim from the
#: forensics report. It was live, embedded, findable by both retrieval arms —
#: and never reached a single prompt.
THE_NOTE = ("Next session, the learner wants to derive the ideal-gas "
            "temperature-kinetic-energy relationship from molecular "
            "collisions step by step.")


def _payload(**overrides):
    body = {
        "turn_id": str(uuid.uuid4()),
        "session_id": str(uuid.uuid4()),
        "text": "what did we do last time?",
        "model": "gpt-5.6-luna",
        "reasoning_effort": "high",
    }
    body.update(overrides)
    return body


async def _collect(response) -> list[dict]:
    return [
        json.loads(line.removeprefix("data: "))
        async for line in response.aiter_lines()
        if line.startswith("data: ")
    ]


def _prompt_of(call) -> str:
    """The user text in one captured provider request, joined across the
    cacheable and per-turn parts — which half a block lands on is
    `prompt._sections`' business, not this file's."""
    content = json.loads(call.request.content)["input"][1]["content"]
    return "".join(part["text"] for part in content
                   if part["type"] == "input_text")


def _tool_call_turn(name: str, arguments: dict, *, response_id: str) -> tuple:
    """A scripted response that ends on one tool call, as the API sends it."""
    return (
        {"type": "response.created", "sequence_number": 0,
         "response": {"id": response_id}},
        {"type": "response.completed", "sequence_number": 1, "response": {
            "id": response_id,
            "usage": {"input_tokens": 60, "output_tokens": 24},
            "output": [
                {"type": "reasoning", "id": f"rs_{response_id}", "summary": []},
                {"type": "function_call", "id": f"fc_{response_id}",
                 "call_id": f"call_{response_id}", "name": name,
                 "arguments": json.dumps(arguments), "status": "completed"},
            ],
        }},
    )


async def _turn(db_app, payload) -> list[dict]:
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream(
            "POST", "/v1/turn", json=payload, headers=AUTH
        ) as response:
            assert response.status_code == 200
            return await _collect(response)


def _sessions_ago(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


def _episode(closed: datetime, *, title: str, narrative: str,
             next_steps=None, transcript="learner: hi\ntutor: hi") -> Episode:
    return Episode(
        learner_id=SOLE_LEARNER_ID, session_id=uuid.uuid4(),
        transcript=transcript, message_count=2, seq_from=1, seq_to=2,
        started_at=closed - timedelta(hours=1), closed_at=closed,
        title=title, narrative=narrative, next_steps=next_steps,
    )


async def _seed_learner(db_factory) -> None:
    async with db_factory() as db:
        db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
        await db.commit()


@respx.mock
@requires_db
async def test_a_recency_question_is_already_answered_in_the_standing_block(
    db_app, db_factory
):
    """Leg one: "what did we do last time" needs no retrieval to go right.

    A new session's first turn carries the previous session dated and
    labelled, its narrative with the exact details the digest era lost, and
    the saved open loop — plus the date anchor and the first-turn marker that
    tell the model it is at exactly this moment. Everything session B's four
    wrong answers needed, present before the first token is generated.
    """
    route = respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    await _seed_learner(db_factory)
    async with db_factory() as db:
        db.add(_episode(
            _sessions_ago(1),
            title="Derived the KE-temperature link; started v_rms for O2",
            narrative=("Wrote and corrected E_k = 1/2 m v^2, converted 30 C "
                       "to 303.15 K, and was given E_k = 3/2 k_B T boxed at "
                       "own request. Mid-way through v_rms for O2."),
            next_steps=["derive the relationship from collisions step by step"],
        ))
        db.add(_episode(
            _sessions_ago(6), title="Fractions",
            narrative="Added unlike denominators.",
        ))
        await db.commit()

    await _turn(db_app, _payload())

    prompt = _prompt_of(route.calls[0])
    today = datetime.now(timezone.utc).date()
    yesterday = (today - timedelta(days=1)).isoformat()
    # The block, dated and labelled, newest first, narrative in full.
    assert "MOST RECENT SESSIONS" in prompt
    assert (f"{yesterday} (yesterday) — Derived the KE-temperature link; "
            "started v_rms for O2") in prompt
    assert "E_k = 3/2 k_B T boxed at" in prompt
    assert "next: derive the relationship from collisions step by step" in prompt
    # The older session is a card, not a narrative.
    assert "Fractions" in prompt
    assert "Added unlike denominators." not in prompt
    # The anchor and the marker: what "last time" means, and that this is the
    # moment to use it.
    assert f"Today is {today.isoformat()}" in prompt
    assert "This is the first turn of a new session" in prompt


@respx.mock
@requires_db
async def test_a_detail_question_reads_the_stored_transcript_before_answering(
    db_app, db_factory, monkeypatch
):
    """Leg two: "what exactly did we write" reaches the frozen words.

    The prompt's MEMORY section orders the lookup; this scripts the model
    obeying it and asserts the machinery holds up its end — the tool call is
    answered with the actual stored transcript page, exact formula and all,
    fed back into the round the model answers from. W3's "architecturally
    impossible" is now one tool call.
    """
    # The memory handler opens its own sessions from the process sessionmaker;
    # point it at the test schema, as every live-handler test does.
    monkeypatch.setattr("app.api.turn.session_factory", lambda: db_factory)
    boxed = "tutor: here it is, boxed: E_k = (3/2) k_B T — at your request"
    route = respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*_tool_call_turn(
                         "get_session",
                         {"date_or_offset": "0", "part": "transcript",
                          "page": 1},
                         response_id="resp_detail"))),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TEXT_ONLY_TURN)),
        ]
    )
    await _seed_learner(db_factory)
    async with db_factory() as db:
        db.add(_episode(
            _sessions_ago(2),
            title="Derived the KE-temperature link",
            narrative="Reached the boxed relation.",
            transcript=("learner: can you just give me the formula\n"
                        f"{boxed}\n"
                        "learner: so average KE only depends on temperature"),
        ))
        await db.commit()

    await _turn(db_app, _payload(text="what exactly did you write when you "
                                      "gave me that formula?"))

    assert route.call_count == 2
    second = json.loads(route.calls[1].request.content)["input"]
    outputs = [item for item in second
               if item.get("type") == "function_call_output"]
    assert len(outputs) == 1
    answer = outputs[0]["output"]
    assert "transcript page 1 of 1" in answer
    assert boxed in answer
    assert "so average KE only depends on temperature" in answer


@respx.mock
@requires_db
async def test_a_note_saved_this_turn_stands_in_the_next_turns_prompt(
    db_app, db_factory, monkeypatch
):
    """Leg three: `remember` on turn N is SAVED NOTES on turn N+1.

    The forensics' load-bearing failure (W2): the note was saved, embedded,
    findable — and reached no prompt, because only an extraction rebuild
    could carry it there and extraction could never run again. The standing
    block now reads the explicit notes directly, so the very next turn — in a
    different session — carries the note, dated, wholesale.
    """
    async def _embed(texts):
        return [[0.1] * EMBEDDING_DIMS for _ in texts]

    monkeypatch.setattr("app.memory.dispatch.embed_texts", _embed)
    # The memory handler opens its own sessions from the process sessionmaker,
    # which no test ever initialises — redirect it at the test schema.
    monkeypatch.setattr("app.api.turn.session_factory", lambda: db_factory)

    route = respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*_tool_call_turn(
                         "remember",
                         {"text": THE_NOTE, "category": "goal", "stated": True},
                         response_id="resp_note"))),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TEXT_ONLY_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TEXT_ONLY_TURN)),
        ]
    )
    await _seed_learner(db_factory)

    # Turn one, session A: the learner asks for the note.
    await _turn(db_app, _payload(
        text="I do wanna derive it from collisions step by step, but maybe "
             "next time, can you remember that?"))
    saved = [item for item in
             json.loads(route.calls[1].request.content)["input"]
             if item.get("type") == "function_call_output"]
    assert saved[0]["output"].startswith("Saved.")
    async with db_factory() as db:
        stored = (await db.execute(select(MemoryAtom))).scalar_one()
        assert stored.explicit is True

    # Turn two, a NEW session: the note is simply there. No rebuild, no
    # retrieval, no similarity gate between the promise and the prompt.
    await _turn(db_app, _payload(text="hey, new day"))
    prompt = _prompt_of(route.calls[2])
    today = datetime.now(timezone.utc).date().isoformat()
    assert "SAVED NOTES" in prompt
    assert f"[{today}] {THE_NOTE}" in prompt
