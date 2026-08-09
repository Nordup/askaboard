"""Where memory finally reaches a live turn.

Two failures this file exists to catch, and a test of `_memory_sections` on its
own catches neither. The first is sections that are computed correctly and then
never passed to `assemble_context` — the store is read, the prompt is not
changed, and every assertion about the returned dict still passes. The second
is the four memory tools being offered on every turn with nothing bound to run
them, so the model calls one and is answered `NO_MEMORY_ACK`: four tool
definitions billed on every turn that can only ever fail.

So the two tests that matter here go through `POST /v1/turn` and assert against
the request body respx captured on its way to the provider. That is the only
vantage point from which "the model was told" is distinguishable from "we wrote
it down somewhere".
"""

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import respx
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import select

from app.api.turn import RECENT_SESSION_COUNT, _memory_sections
from app.config import EMBEDDING_DIMS, SOLE_LEARNER_ID
from app.store.models import (
    KC,
    Episode,
    Learner,
    LearnerKCState,
    LearnerProfile,
    MemoryAtom,
)
from app.tutor.loop import NO_MEMORY_ACK
from tests.conftest import requires_db
from tests.fixtures.sse import TEXT_ONLY_TURN, sse_stream

AUTH = {"Authorization": "Bearer test-token"}

PROFILE = "Sitting the higher tier paper in June. Prefers worked examples."
RATIO = "7.RP.A.2"


def _payload(**overrides):
    body = {
        "turn_id": str(uuid.uuid4()),
        "session_id": str(uuid.uuid4()),
        "text": "check my work",
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
    """The user text in one captured provider request."""
    return json.loads(call.request.content)["input"][1]["content"][0]["text"]


# ---------------------------------------------------------------------------
# What `_memory_sections` makes of what its three sources return. Stubbed, so
# these need neither a database nor a network and stay fast.
# ---------------------------------------------------------------------------


@dataclass
class _FakeEpisode:
    closed_at: datetime
    digest: str | None


def _stub_sources(monkeypatch, *, profile, state, episodes, seen=None):
    async def _profile(db, learner_id):
        return profile

    async def _snapshot(db, learner_id):
        return state

    async def _episodes(db, learner_id, *, limit):
        if seen is not None:
            seen["limit"] = limit
            seen["learner_id"] = learner_id
        return episodes

    monkeypatch.setattr("app.api.turn.current_profile", _profile)
    monkeypatch.setattr("app.api.turn.snapshot", _snapshot)
    monkeypatch.setattr("app.api.turn.recent_episodes", _episodes)


async def test_the_digest_is_dated_and_asked_for_by_the_dozen(monkeypatch):
    """Deliberately claims nothing about ordering.

    The stub hands back whatever order the test wrote, so an assertion here
    would only be reading its own input. `recent_episodes` is what orders these
    and `test_memory_retrieve` is where that is pinned; what this covers is the
    limit, the learner, and the line format.
    """
    seen: dict = {}
    _stub_sources(
        monkeypatch, profile=None, state="", seen=seen,
        episodes=[
            _FakeEpisode(datetime(2026, 6, 3, tzinfo=timezone.utc), "ratios"),
            _FakeEpisode(datetime(2026, 5, 28, tzinfo=timezone.utc), "fractions"),
        ],
    )

    sections = await _memory_sections(None)

    assert sections["recent_digest"] == "2026-06-03: ratios\n2026-05-28: fractions"
    assert seen["limit"] == RECENT_SESSION_COUNT
    assert seen["learner_id"] == SOLE_LEARNER_ID


async def test_a_block_with_nothing_to_say_is_none_and_not_an_empty_string(
    monkeypatch
):
    """`snapshot` says "" for a learner nothing has been measured about yet.

    Passed through as-is it would be a section that exists and is blank, which
    is a different claim from having no reading on them at all — and it is one
    `compose_user_prompt` only declines to render by the luck of testing
    truthiness rather than `is not None`.
    """
    _stub_sources(monkeypatch, profile=None, state="", episodes=[])

    sections = await _memory_sections(None)

    assert sections == {"profile": None, "learner_state": None,
                        "recent_digest": None}


# ---------------------------------------------------------------------------
# The same helper against the real store, then the two wiring tests.
# ---------------------------------------------------------------------------


async def _seed(db) -> None:
    """A learner with all three kinds of memory on file.

    Migration 0003 seeds the sole learner; the test schema is built from the
    metadata (see `conftest.db_factory`) and so has no seed.
    """
    kc_id = uuid.uuid4()
    # Flushed before anything that points at them: nothing here declares a
    # `relationship`, so the unit of work has no dependency to sort these
    # inserts by and would otherwise write the children first.
    db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
    db.add(KC(id=kc_id, code=RATIO, title="Unit rate", description="", grade="7"))
    await db.flush()

    db.add(LearnerProfile(learner_id=SOLE_LEARNER_ID, body=PROFILE, atom_count=2))
    db.add(LearnerKCState(learner_id=SOLE_LEARNER_ID, kc_id=kc_id,
                          theta=2.0, n_effective=7.0))

    # Two, added oldest-first, so the newest-first ordering the block claims is
    # the database's answer and not the order they were written in.
    for closed, digest in (
        (datetime(2026, 5, 28, 9, 0, tzinfo=timezone.utc), "Simplified fractions."),
        (datetime(2026, 6, 3, 9, 0, tzinfo=timezone.utc), "Worked through unit rates."),
    ):
        db.add(Episode(learner_id=SOLE_LEARNER_ID, session_id=uuid.uuid4(),
                       transcript="learner: hi", digest=digest, message_count=2,
                       started_at=closed - timedelta(hours=1), closed_at=closed))
    await db.commit()


@requires_db
async def test_memory_sections_reads_the_three_blocks_out_of_the_real_store(db):
    await _seed(db)
    db.expire_all()

    sections = await _memory_sections(db)

    assert sections["profile"] == PROFILE
    assert sections["learner_state"] == (
        f"WHAT THIS LEARNER KNOWS:\n- Unit rate ({RATIO}): mastered"
    )
    # Newest first, dated, both lines — the ordering the stubbed test above
    # cannot assert, because here `recent_episodes` is the thing producing it.
    assert sections["recent_digest"] == (
        "2026-06-03: Worked through unit rates.\n"
        "2026-05-28: Simplified fractions."
    )


@respx.mock
@requires_db
async def test_a_turns_memory_reaches_the_model_and_not_just_the_dictionary(
    db_app, db_factory
):
    """The failure this task exists to prevent, in one assertion.

    Read against the captured provider request rather than a spy on
    `assemble_context`: a spy proves the call was made with the right keyword
    arguments, and the thing that actually has to be true is that the learner's
    portrait ends up in the text the model reads.
    """
    route = respx.post("https://api.openai.com/v1/responses").mock(
        return_value=Response(200, headers={"Content-Type": "text/event-stream"},
                              content=sse_stream(*TEXT_ONLY_TURN))
    )
    async with db_factory() as db:
        await _seed(db)

    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream(
            "POST", "/v1/turn", json=_payload(), headers=AUTH
        ) as response:
            assert response.status_code == 200
            await _collect(response)

    prompt = _prompt_of(route.calls[0])
    assert PROFILE in prompt
    assert f"- Unit rate ({RATIO}): mastered" in prompt
    assert "2026-06-03: Worked through unit rates." in prompt
    # The headings come from `compose_user_prompt`; asserting them here is what
    # says the blocks arrived as the sections they are rather than as prose
    # smuggled into the transcript.
    assert "WHAT YOU KNOW ABOUT THIS LEARNER" in prompt
    assert "RECENT SESSIONS" in prompt


REMEMBER_ARGUMENTS = {
    "text": "Sits the higher tier paper in June.",
    "category": "goal",
    "stated": True,
}

#: One turn in which the model calls `remember` and stops, which is what a
#: function call does to a Responses API response. The follow-up leg is
#: `TEXT_ONLY_TURN`.
REMEMBER_TURN = (
    {"type": "response.created", "sequence_number": 0,
     "response": {"id": "resp_mem"}},
    {"type": "response.output_item.added", "sequence_number": 1, "output_index": 0,
     "item": {"type": "function_call", "id": "fc_mem", "call_id": "call_mem",
              "name": "remember", "arguments": ""}},
    {"type": "response.function_call_arguments.done", "sequence_number": 2,
     "output_index": 0, "item_id": "fc_mem", "name": "remember",
     "arguments": json.dumps(REMEMBER_ARGUMENTS)},
    {"type": "response.completed", "sequence_number": 3,
     "response": {
         "id": "resp_mem",
         "usage": {"input_tokens": 60, "output_tokens": 24},
         "output": [
             {"type": "reasoning", "id": "rs_mem", "summary": []},
             {"type": "function_call", "id": "fc_mem", "call_id": "call_mem",
              "name": "remember", "arguments": json.dumps(REMEMBER_ARGUMENTS),
              "status": "completed"},
         ],
     }},
)


@respx.mock
@requires_db
async def test_a_memory_tool_call_in_a_live_turn_reaches_a_real_handler(
    db_app, db_factory, monkeypatch
):
    """`remember`, called by the model, answered by `app.memory.dispatch`.

    Nothing here stubs the handler: the answer the model is fed back and the
    row in `memory_atoms` are both produced by the real one, on the session it
    opened for itself while the request's own session was still in use.

    Two assertions and neither is redundant. The output going back to the model
    is what `NO_MEMORY_ACK` would have occupied — it is the whole failure this
    test is named after — and the row is what says the handler did the work
    rather than merely returning a cheerful string.
    """
    async def _embed(texts):
        return [[0.1] * EMBEDDING_DIMS for _ in texts]

    monkeypatch.setattr("app.memory.dispatch.embed_texts", _embed)
    # The memory handler opens its own sessions from the process sessionmaker,
    # which no test ever initialises — `db_app` overrides `db_session` and the
    # recorder instead. This is the same redirection for the third one.
    monkeypatch.setattr("app.api.turn.session_factory", lambda: db_factory)

    route = respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*REMEMBER_TURN)),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TEXT_ONLY_TURN)),
        ]
    )
    async with db_factory() as db:
        db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
        await db.commit()

    payload = _payload()
    async with AsyncClient(
        transport=ASGITransport(app=db_app), base_url="http://test"
    ) as client:
        async with client.stream(
            "POST", "/v1/turn", json=payload, headers=AUTH
        ) as response:
            assert response.status_code == 200
            events = await _collect(response)

    assert events[-1]["type"] == "done"
    assert route.call_count == 2

    second = json.loads(route.calls[1].request.content)
    outputs = [item for item in second["input"]
               if item.get("type") == "function_call_output"]
    assert len(outputs) == 1
    assert outputs[0]["output"] != NO_MEMORY_ACK
    assert outputs[0]["output"].startswith("Saved.")

    async with db_factory() as db:
        stored = (await db.execute(select(MemoryAtom))).scalar_one()
        assert stored.text == REMEMBER_ARGUMENTS["text"]
        assert stored.category == "goal"
        assert stored.embedding is not None
        # Provenance is why the handler is bound per turn rather than once per
        # process: an atom has to say which turn of which session produced it.
        assert stored.source_session_id == uuid.UUID(payload["session_id"])
        assert stored.source_turn_ids == [uuid.UUID(payload["turn_id"])]
