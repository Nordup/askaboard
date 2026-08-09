import json
import uuid
from datetime import datetime, timedelta, timezone

import respx
from httpx import Response
from openai import AsyncOpenAI
from sqlalchemy import select

from app.config import SOLE_LEARNER_ID
from app.learner.mastery import RELIABILITY
from app.memory.dispatch import _FAILED, handle_memory_tool, memory_handler
from app.memory.schema import MemoryCategory
from app.store.models import KC, Episode, Learner, LearnerKCState, MemoryAtom, Observation
from app.tutor.context import ContextBundle
from app.tutor.loop import (
    MALFORMED_MEMORY_ACK,
    NO_MEMORY_ACK,
    UNSUPPORTED_TOOL_ACK,
    _answer,
    run_turn,
)
from app.tutor.tools import (
    EVIDENCE_KINDS,
    MEMORY_TOOL_DEFINITIONS,
    MEMORY_TOOLS,
    SERVER_ONLY_KINDS,
    TOOL_DEFINITIONS,
)
from tests.conftest import requires_db
from tests.fixtures.sse import TEXT_ONLY_TURN, sse_stream

# ---------------------------------------------------------------------------
# Everything down to `_learner` is the definitions and the routing: no
# database, no network, and nothing that should ever be slow.
# ---------------------------------------------------------------------------


def _named(name: str) -> dict:
    return next(tool for tool in TOOL_DEFINITIONS if tool["name"] == name)


def test_all_four_tools_are_offered():
    names = {tool["name"] for tool in TOOL_DEFINITIONS}
    assert {"remember", "search_memory", "recent_sessions",
            "record_evidence"} <= names


def test_the_router_and_the_registry_name_the_same_four():
    """A tool offered but not routed is a whole round spent being refused."""
    assert MEMORY_TOOLS == {tool["name"] for tool in MEMORY_TOOL_DEFINITIONS}
    assert MEMORY_TOOLS <= {tool["name"] for tool in TOOL_DEFINITIONS}


def test_search_memory_demands_a_self_contained_query():
    """The tool has no access to the conversation, so the query must carry
    its own context or it retrieves nothing."""
    description = _named("search_memory")["description"].lower()
    assert "self-contained" in description
    # Both halves of the contrast, because the counter-example is what stops a
    # model writing the query it would otherwise write.
    assert "no access to the current conversation" in description
    assert "what did they mean by that" in description


def test_remember_forbids_claiming_a_save_before_making_one():
    description = _named("remember")["description"]
    assert "'noted'" in description
    assert "call this tool first" in description


def test_remember_offers_exactly_the_categories_the_column_allows():
    """A category the model may pick and the CHECK will reject is a fact lost
    between the tool call and the INSERT, in front of a learner who was just
    told it was saved."""
    offered = _named("remember")["parameters"]["properties"]["category"]["enum"]
    assert offered == [category.value for category in MemoryCategory]


def test_record_evidence_requires_weights_and_kind():
    params = _named("record_evidence")["parameters"]
    assert set(params["required"]) >= {"kcs", "outcome", "kind"}
    kc_item = params["properties"]["kcs"]["items"]
    assert set(kc_item["required"]) == {"code", "weight"}


def test_record_evidence_asks_for_weights_that_sum_to_one():
    assert "sum to about 1" in _named("record_evidence")["description"]


def test_the_model_cannot_award_itself_a_verified_answer():
    """`answer_verified` is 0.95 — near-certainty — and means a symbolic check
    ran. Nothing in a turn runs one, so offering it lets the tutor grade its
    own guess as fact. It stays in RELIABILITY for server-side use."""
    offered = _named("record_evidence")["parameters"]["properties"]["kind"]["enum"]
    assert "answer_verified" not in offered
    assert "answer_verified" in RELIABILITY
    assert SERVER_ONLY_KINDS == {"answer_verified"}


def test_every_offered_kind_is_a_channel_with_a_reliability():
    """A `kind` the model may send that `RELIABILITY` does not carry does not
    fail loudly — it silently scores `UNKNOWN_RELIABILITY` on every
    observation that uses it."""
    offered = _named("record_evidence")["parameters"]["properties"]["kind"]["enum"]
    assert set(offered) == set(RELIABILITY) - SERVER_ONLY_KINDS
    assert list(EVIDENCE_KINDS) == offered


def test_every_tool_is_strict_and_closed():
    for tool in TOOL_DEFINITIONS:
        assert tool.get("strict") is True, tool["name"]
        assert tool["parameters"]["additionalProperties"] is False, tool["name"]


def test_strict_schemas_require_every_property_they_declare():
    """Strict function schemas have no notion of an optional field: a property
    left out of `required` is rejected by the provider, not defaulted."""
    for tool in MEMORY_TOOL_DEFINITIONS:
        params = tool["parameters"]
        assert set(params["required"]) == set(params["properties"]), tool["name"]


# ---------------------------------------------------------------------------
# Routing: which shape of ToolAnswer a memory call becomes
# ---------------------------------------------------------------------------


def test_a_memory_call_becomes_an_intent_for_the_caller_to_run():
    answer = _answer(
        {"call_id": "c", "name": "search_memory",
         "arguments": '{"query": "what exam are they sitting"}'},
        has_board=False, has_memory=True,
    )
    assert answer.items is None and answer.ask is None
    assert answer.run == ("search_memory", {"query": "what exam are they sitting"})


def test_a_memory_call_with_no_handler_is_not_reported_as_unsupported():
    """"Unsupported" invites the model to give up on memory for the session.
    Nothing was searched is the true statement, and the difference decides
    whether it then tells the learner it does not remember them."""
    answer = _answer(
        {"call_id": "c", "name": "remember", "arguments": '{"text": "x"}'},
        has_board=False, has_memory=False,
    )
    assert answer.run is None
    assert answer.items[0]["output"] == NO_MEMORY_ACK
    assert answer.items[0]["output"] != UNSUPPORTED_TOOL_ACK


def test_memory_arguments_that_are_not_an_object_run_nothing():
    answer = _answer(
        {"call_id": "c", "name": "remember", "arguments": '["text", "x"]'},
        has_board=False, has_memory=True,
    )
    assert answer.run is None
    assert answer.items[0]["output"] == MALFORMED_MEMORY_ACK


def test_an_unknown_tool_is_still_unsupported():
    """The memory branch must not swallow every name it does not recognise."""
    answer = _answer(
        {"call_id": "c", "name": "future_web_search", "arguments": "{}"},
        has_board=False, has_memory=True,
    )
    assert answer.items[0]["output"] == UNSUPPORTED_TOOL_ACK


def _memory_call_turn(name: str, arguments: dict) -> tuple[dict, ...]:
    """A response that ends on one memory tool call, as the API sends it."""
    return (
        {"type": "response.created", "sequence_number": 0,
         "response": {"id": "resp_m"}},
        {"type": "response.completed", "sequence_number": 1, "response": {
            "id": "resp_m",
            "usage": {"input_tokens": 10, "output_tokens": 4},
            "output": [{
                "type": "function_call", "id": "fc_m", "call_id": "call_m",
                "name": name, "arguments": json.dumps(arguments),
                "status": "completed",
            }],
        }},
    )


@respx.mock
async def test_run_turn_hands_the_handlers_answer_back_to_the_model():
    """The whole point of the round: what memory said has to reach the model,
    behind the call it answers, or the tutor writes its reply without it."""
    route = respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*_memory_call_turn(
                         "search_memory", {"query": "their exam date"}))),
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*TEXT_ONLY_TURN)),
        ]
    )
    seen: list[tuple[str, dict]] = []

    async def handle(name: str, arguments: dict) -> str:
        seen.append((name, arguments))
        return "- [goal] Sits the higher tier paper in June."

    async for _ in run_turn(
        client=AsyncOpenAI(api_key="sk-test"), model="gpt-5.6-luna", effort="high",
        bundle=ContextBundle(system="s", input=[{"role": "user", "content": "hi"}]),
        handle_memory=handle,
    ):
        pass

    assert seen == [("search_memory", {"query": "their exam date"})]
    second = json.loads(route.calls[1].request.content)["input"]
    outputs = [item for item in second if item.get("type") == "function_call_output"]
    assert outputs == [{
        "type": "function_call_output", "call_id": "call_m",
        "output": "- [goal] Sits the higher tier paper in June.",
    }]


# ---------------------------------------------------------------------------
# The handlers, against a real database
# ---------------------------------------------------------------------------

RATIO = "7.RP.A.2"
UNIT_RATE = "6.RP.A.2"


def _axis(index: int) -> list[float]:
    """A unit basis vector: identical to itself, orthogonal to any other. Never
    zeros — cosine distance against a zero vector is NaN, which neither orders
    nor compares, so a dense assertion over one proves nothing."""
    vector = [0.0] * 1024
    vector[index] = 1.0
    return vector


class _Embedder:
    def __init__(self, vector: list[float]):
        self.vector = vector

    async def __call__(self, texts: list[str]) -> list[list[float]]:
        return [self.vector for _ in texts]


async def _explode(texts: list[str]) -> list[list[float]]:
    raise RuntimeError("the embeddings endpoint is down")


async def _learner(db) -> None:
    """Migration 0003 seeds the sole learner; the test schema is built from the
    metadata (see `conftest.db_factory`) and so has no seed."""
    db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
    await db.flush()


@requires_db
async def test_remember_writes_a_fact_that_can_be_found_by_meaning(db, monkeypatch):
    """The load-bearing property of the whole tool.

    An atom written with a NULL embedding is invisible to retrieval's dense arm
    and can never be offered as a supersession candidate — permanently. So the
    query here shares no lexeme with the stored fact: the sparse arm cannot
    match it, and only a real embedding can bring it back.
    """
    monkeypatch.setattr("app.memory.dispatch.embed_texts", _Embedder(_axis(0)))
    monkeypatch.setattr("app.memory.retrieve.embed_texts", _Embedder(_axis(0)))
    await _learner(db)
    await db.commit()

    saved = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "remember",
        {"text": "Sits the higher tier paper in June.", "category": "goal"},
        turn_id=None,
    )
    assert saved.startswith("Saved.")

    db.expire_all()
    stored = (await db.execute(select(MemoryAtom))).scalar_one()
    assert stored.embedding is not None
    assert stored.category == "goal"
    assert stored.stated is True

    found = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "search_memory",
        {"query": "zzz unrelated wording entirely"}, turn_id=None,
    )
    assert found == "- [goal] Sits the higher tier paper in June."


@requires_db
async def test_an_embedding_failure_saves_nothing_and_says_so(db, monkeypatch):
    """A tool that answered "Saved." here would have the tutor tell the learner
    it will remember something it has just lost."""
    monkeypatch.setattr("app.memory.dispatch.embed_texts", _explode)
    await _learner(db)
    await db.commit()

    answer = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "remember",
        {"text": "Prefers being asked before being told.", "category": "preference"},
        turn_id=None,
    )

    assert answer == _FAILED["remember"]
    assert "NOT saved" in answer

    # A fact that is not a sentence never reaches the embedder — with `_explode`
    # still installed, the failure string above is what a missing guard would
    # return, so this distinguishes "refused" from "tried and broke".
    refused = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "remember",
        {"text": {"fact": "prefers mornings"}, "category": "preference"},
        turn_id=None,
    )
    assert "Nothing was saved" in refused

    db.expire_all()
    assert (await db.execute(select(MemoryAtom))).scalars().all() == []


@requires_db
async def test_an_empty_store_answers_without_claiming_anything(db, monkeypatch):
    """Two different nothings. "Nothing on file" is a fact about the store;
    the failure strings above are a fact about the tool. Only one of them
    licenses the tutor to tell the learner it does not know them."""
    monkeypatch.setattr("app.memory.retrieve.embed_texts", _Embedder(_axis(0)))
    await _learner(db)
    await db.commit()

    assert await handle_memory_tool(
        db, SOLE_LEARNER_ID, "search_memory", {"query": "anything at all"},
        turn_id=None,
    ) == "Nothing on file about that."
    assert await handle_memory_tool(
        db, SOLE_LEARNER_ID, "recent_sessions", {"limit": 5}, turn_id=None,
    ) == "No previous sessions on file."
    # An empty query never reaches the store, and saying so is what gets the
    # model to write a real one rather than conclude memory is empty.
    assert "self-contained" in await handle_memory_tool(
        db, SOLE_LEARNER_ID, "search_memory", {"query": "   "}, turn_id=None,
    )


@requires_db
async def test_recent_sessions_lists_digests_newest_first_within_the_cap(db):
    await _learner(db)
    start = datetime(2026, 6, 1, tzinfo=timezone.utc)
    for day in range(3):
        db.add(Episode(
            learner_id=SOLE_LEARNER_ID, session_id=uuid.uuid4(),
            transcript="learner: hi", digest=f"day {day}", message_count=1,
            started_at=start + timedelta(days=day),
            closed_at=start + timedelta(days=day),
        ))
    await db.commit()

    # 99 is out of the tool's stated range; clamped rather than refused,
    # because a slipped bound should cost the model nothing.
    listed = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "recent_sessions", {"limit": 99}, turn_id=None,
    )
    assert listed.splitlines() == [
        "2026-06-03: day 2", "2026-06-02: day 1", "2026-06-01: day 0",
    ]

    assert await handle_memory_tool(
        db, SOLE_LEARNER_ID, "recent_sessions", {"limit": 1}, turn_id=None,
    ) == "2026-06-03: day 2"


@requires_db
async def test_record_evidence_moves_the_learner_model_and_commits(db_factory):
    """Committed, not merely flushed. The model is told the observation landed
    in the same turn, and a "Recorded" the request later rolls back is the one
    thing the tool must not be able to say."""
    async with db_factory() as db:
        await _learner(db)
        db.add_all([
            KC(id=uuid.uuid4(), code=RATIO, title="Ratios", description="", grade="7"),
            KC(id=uuid.uuid4(), code=UNIT_RATE, title="Unit rate", description="",
               grade="6"),
        ])
        await db.commit()

        assert await handle_memory_tool(
            db, SOLE_LEARNER_ID, "record_evidence",
            {"kcs": [{"code": RATIO, "weight": 0.7},
                     {"code": UNIT_RATE, "weight": 0.3}],
             "outcome": 1.0, "kind": "ink_symbolic", "difficulty": 0.5,
             "misconception": None},
            turn_id=None,
        ) == "Recorded against 2 concept(s)."

    async with db_factory() as db:
        observations = (await db.execute(select(Observation))).scalars().all()
        assert len(observations) == 2
        assert {row.kind for row in observations} == {"ink_symbolic"}
        assert {row.reliability for row in observations} == {RELIABILITY["ink_symbolic"]}
        states = (await db.execute(select(LearnerKCState))).scalars().all()
        assert len(states) == 2
        assert all(state.theta > 0.0 for state in states)


@requires_db
async def test_an_unknown_concept_code_is_reported_rather_than_swallowed(db):
    """`record` returns 0 and writes nothing when no code resolves, and the
    model cannot see that happened unless the answer says so."""
    await _learner(db)
    await db.commit()

    answer = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "record_evidence",
        {"kcs": [{"code": "NOT.A.STANDARD", "weight": 1.0}], "outcome": 1.0,
         "kind": "answer_llm", "difficulty": 0.0, "misconception": None},
        turn_id=None,
    )

    assert "Nothing was recorded" in answer
    assert "7.RP.A.2" in answer
    db.expire_all()
    assert (await db.execute(select(Observation))).scalars().all() == []


@requires_db
async def test_the_bound_handler_needs_only_a_sessionmaker(db_factory, monkeypatch):
    """What `run_turn` is actually given. The request's own session is closed
    by the time the stream body runs, so the handler must open its own."""
    monkeypatch.setattr("app.memory.dispatch.embed_texts", _Embedder(_axis(1)))
    async with db_factory() as db:
        await _learner(db)
        await db.commit()

    handle = memory_handler(db_factory, learner_id=SOLE_LEARNER_ID)
    assert (await handle("remember", {"text": "Works best in the morning.",
                                      "category": "preference"})).startswith("Saved.")

    async with db_factory() as db:
        stored = (await db.execute(select(MemoryAtom))).scalar_one()
        assert stored.text == "Works best in the morning."
        assert stored.embedding is not None
