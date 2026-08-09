import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

import respx
from httpx import Response
from openai import AsyncOpenAI
from sqlalchemy import select

from app.config import SOLE_LEARNER_ID
from app.learner.evidence import DEFAULT_KIND
from app.learner.mastery import RELIABILITY
from app.memory.dispatch import (
    _FAILED,
    _HANDLERS,
    handle_memory_tool,
    memory_handler,
)
from app.store.models import (
    KC,
    MEMORY_CATEGORIES,
    Episode,
    Learner,
    LearnerKCState,
    MemoryAtom,
    Observation,
)
from app.memory.schema import EXTRACTION_SCHEMA, STATED_EXEMPT, MemoryCategory
from app.tutor.context import ContextBundle
from app.tutor.loop import (
    MALFORMED_MEMORY_ACK,
    MAX_TOOL_ROUNDS,
    MEMORY_PHASES,
    MEMORY_TIMEOUT_ACK,
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


def test_every_offered_memory_tool_has_a_handler():
    """`_HANDLERS` and `_FAILED` cannot be derived from the JSON definitions —
    they hold functions and sentences, not schemas — so this is what stops a
    fifth tool being offered, routed to dispatch, and told it does not exist."""
    assert set(_HANDLERS) == MEMORY_TOOLS
    assert set(_FAILED) == MEMORY_TOOLS


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


def test_remember_does_not_offer_itself_as_a_way_to_forget():
    """There is no delete path. Sending the model here to handle "forget my old
    exam date" would add an atom and hand back a licence to say it was done."""
    description = _named("remember")["description"]
    assert "remember or forget" not in description
    assert "no way to make you forget anything yet" in description


def test_remember_asks_who_the_fact_came_from():
    """`stated` is not a label. An unstated fact outside STATED_EXEMPT is
    dropped on both write paths, so the model has to be asked the question the
    offline extractor is asked."""
    params = _named("remember")["parameters"]
    assert "stated" in params["required"]
    assert params["properties"]["stated"]["type"] == "boolean"
    assert (params["properties"]["stated"]["description"]
            == EXTRACTION_SCHEMA["properties"]["atoms"]["items"]
               ["properties"]["stated"]["description"])


def test_remember_offers_exactly_the_categories_the_column_allows():
    """Asserted against `MEMORY_CATEGORIES`, which is the tuple
    `ck_memory_atoms_category` is built from — not against `MemoryCategory`,
    which is a hand-maintained copy of it. A category the model may pick and
    the CHECK will reject is a fact lost between the tool call and the INSERT,
    in front of a learner who was just told it was saved."""
    offered = _named("remember")["parameters"]["properties"]["category"]["enum"]
    assert offered == list(MEMORY_CATEGORIES)


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


def _run(handle, *legs):
    """One `run_turn` over the given provider responses, with `handle` bound."""
    respx.post("https://api.openai.com/v1/responses").mock(
        side_effect=[
            Response(200, headers={"Content-Type": "text/event-stream"},
                     content=sse_stream(*leg))
            for leg in legs
        ]
    )
    return run_turn(
        client=AsyncOpenAI(api_key="sk-test"), model="gpt-5.6-luna", effort="high",
        bundle=ContextBundle(system="s", input=[{"role": "user", "content": "hi"}]),
        handle_memory=handle,
    )


@respx.mock
async def test_a_memory_call_announces_itself_so_the_wait_is_not_silent():
    """The one stretch of a turn no provider event passes through.

    `EventTranslator`'s keep-alive fires on incoming provider events, and there
    are none while the handler is awaited — so without this status the wire is
    silent for the whole call, and the client gives up at 120 seconds. The
    assertion is on the event *immediately* before the handler ran, not merely
    that a status appeared somewhere: `response.created` emits one too.
    """
    async def phase_for(tool: str) -> str:
        before: list = []
        events: list = []

        async def handle(name: str, arguments: dict) -> str:
            before.append(events[-1])
            return "Nothing on file about that."

        async for event, _ in _run(
            handle, _memory_call_turn(tool, {}), TEXT_ONLY_TURN
        ):
            events.append(event)
        assert before[0].type == "status"
        return before[0].phase

    assert await phase_for("search_memory") == "searching"
    # Not in `MEMORY_PHASES`, so it falls back rather than going unannounced.
    assert await phase_for("remember") == "thinking"
    assert set(MEMORY_PHASES) <= MEMORY_TOOLS


@respx.mock
async def test_a_memory_call_that_hangs_is_abandoned_rather_than_held_forever(
    monkeypatch
):
    """Unbounded, this is the worst failure in the turn.

    `embed_texts` keeps the SDK's two retries against a 600s request timeout,
    so a hung embeddings call is minutes of silence — the client dies at 120s
    while the server finishes and records a *successful* turn. The ack says
    nothing about whether the write landed, because the cancellation can fall
    either side of the handler's commit.
    """
    monkeypatch.setattr("app.tutor.loop.MEMORY_TIMEOUT_SECONDS", 0.05)
    started = asyncio.Event()

    async def handle(name: str, arguments: dict) -> str:
        started.set()
        await asyncio.sleep(5)
        return "Saved."

    route = respx.post("https://api.openai.com/v1/responses")
    async for _ in _run(
        handle, _memory_call_turn("remember", {"text": "x"}), TEXT_ONLY_TURN
    ):
        pass

    assert started.is_set()
    second = json.loads(route.calls[1].request.content)["input"]
    outputs = [item for item in second if item.get("type") == "function_call_output"]
    assert outputs[0]["output"] == MEMORY_TIMEOUT_ACK
    # And the turn carried on: the model still got its second round.
    assert route.call_count == 2


@respx.mock
async def test_exhausting_the_tool_rounds_says_so(caplog):
    """Hitting the cap is not an error, but it is invisible.

    A last round that ends on tool calls leaves `result.text` empty, so the
    learner gets a `done` event and silence — the exact failure
    `MAX_TOOL_ROUNDS`' own comment was written to prevent — and nothing
    anywhere said it had happened.
    """
    async def handle(name: str, arguments: dict) -> str:
        return "Nothing on file about that."

    with caplog.at_level(logging.WARNING, logger="app.tutor.loop"):
        async for _ in _run(
            handle,
            *[_memory_call_turn("search_memory", {"query": "q"})] * MAX_TOOL_ROUNDS,
        ):
            pass

    assert "tool rounds exhausted" in caplog.text
    assert "text_chars=0" in caplog.text
    assert "search_memory" in caplog.text


async def test_a_session_that_cannot_be_opened_answers_instead_of_killing_the_turn():
    """Acquiring and releasing the session sit outside `handle_memory_tool`'s
    own guard, so this was the one memory failure that took the whole turn
    down while every other one was answered politely."""
    def _broken():
        raise RuntimeError("QueuePool limit reached")

    handle = memory_handler(_broken, learner_id=SOLE_LEARNER_ID)

    assert await handle("search_memory", {"query": "x"}) == _FAILED["search_memory"]


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

    fact = {"text": "Sits the higher tier paper in June.", "category": "goal",
            "stated": True}
    saved = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "remember", fact, turn_id=None,
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

    # Saying it again stores it once. Nothing downstream would catch this:
    # `consolidate` rules on the atoms handed to it, and a row already in the
    # table only ever appears on the candidate side.
    again = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "remember",
        {**fact, "text": "  sits the HIGHER tier paper in June.  "}, turn_id=None,
    )
    assert "Already on file" in again
    db.expire_all()
    assert len((await db.execute(select(MemoryAtom))).scalars().all()) == 1


@requires_db
async def test_an_embedding_failure_saves_nothing_and_says_so(db, monkeypatch):
    """A tool that answered "Saved." here would have the tutor tell the learner
    it will remember something it has just lost."""
    monkeypatch.setattr("app.memory.dispatch.embed_texts", _explode)
    await _learner(db)
    await db.commit()

    answer = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "remember",
        {"text": "Prefers being asked before being told.",
         "category": "preference", "stated": True},
        turn_id=None,
    )

    assert answer == _FAILED["remember"]
    assert "NOT saved" in answer

    # A fact that is not a sentence never reaches the embedder — with `_explode`
    # still installed, the failure string above is what a missing guard would
    # return, so this distinguishes "refused" from "tried and broke".
    refused = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "remember",
        {"text": {"fact": "prefers mornings"}, "category": "preference",
         "stated": True},
        turn_id=None,
    )
    assert "Nothing was saved" in refused

    db.expire_all()
    assert (await db.execute(select(MemoryAtom))).scalars().all() == []


@requires_db
async def test_an_inference_is_refused_rather_than_stored_as_the_learners_words(
    db, monkeypatch
):
    """`stated` decides whether the row is written at all, not how it is
    labelled — the same rule `extract._parse` applies, because it is the same
    column and provenance cannot be reconstructed afterwards. `_explode` is
    installed so a refusal that still embedded would be visible."""
    monkeypatch.setattr("app.memory.dispatch.embed_texts", _explode)
    await _learner(db)
    await db.commit()

    guessed = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "remember",
        {"text": "Seems anxious about the higher tier paper.",
         "category": "skill_state", "stated": False},
        turn_id=None,
    )
    assert "your own inference" in guessed
    assert "Do not tell them you have remembered it." in guessed
    db.expire_all()
    assert (await db.execute(select(MemoryAtom))).scalars().all() == []

    # `episode_ref` is exempt: it records what a session covered, which is a
    # fact about the session and the tutor's to state. It must survive unstated
    # and keep `stated=False` — relabelling it True would give a tutor's
    # summary a learner statement's authority.
    monkeypatch.setattr("app.memory.dispatch.embed_texts", _Embedder(_axis(2)))
    kept = await handle_memory_tool(
        db, SOLE_LEARNER_ID, "remember",
        {"text": "Covered adding unlike fractions on 2026-06-01.",
         "category": "episode_ref", "stated": False},
        turn_id=None,
    )
    assert kept.startswith("Saved.")
    db.expire_all()
    stored = (await db.execute(select(MemoryAtom))).scalar_one()
    assert stored.category == "episode_ref"
    assert stored.stated is False
    assert MemoryCategory(stored.category) in STATED_EXEMPT


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
async def test_a_server_only_kind_is_refused_at_the_write_and_not_just_the_enum(db):
    """Leaving `answer_verified` out of the schema is a request to the
    provider. `Observation.kind` is a bare String(24) and `reliability_of` is a
    dict lookup, so a model that ignores the enum would have its own guess
    stored at 0.95 — near-certainty — with nothing to notice it by."""
    await _learner(db)
    db.add(KC(id=uuid.uuid4(), code=RATIO, title="Ratios", description="",
              grade="7"))
    await db.commit()

    assert await handle_memory_tool(
        db, SOLE_LEARNER_ID, "record_evidence",
        {"kcs": [{"code": RATIO, "weight": 1.0}], "outcome": 1.0,
         "kind": "answer_verified", "difficulty": 0.0, "misconception": None},
        turn_id=None,
    ) == "Recorded against 1 concept(s)."

    db.expire_all()
    stored = (await db.execute(select(Observation))).scalar_one()
    assert stored.kind == DEFAULT_KIND
    assert stored.reliability == RELIABILITY[DEFAULT_KIND]
    assert stored.reliability < RELIABILITY["answer_verified"]


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
    """What `run_turn` is actually given. A turn runs for minutes, so the
    handler opens a session per call rather than holding one — and rolls back
    only its own work when a tool fails."""
    monkeypatch.setattr("app.memory.dispatch.embed_texts", _Embedder(_axis(1)))
    async with db_factory() as db:
        await _learner(db)
        await db.commit()

    handle = memory_handler(db_factory, learner_id=SOLE_LEARNER_ID)
    assert (await handle("remember", {"text": "Works best in the morning.",
                                      "category": "preference",
                                      "stated": True})).startswith("Saved.")

    async with db_factory() as db:
        stored = (await db.execute(select(MemoryAtom))).scalar_one()
        assert stored.text == "Works best in the morning."
        assert stored.embedding is not None
