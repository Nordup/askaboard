from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

from openai import APIStatusError, AsyncOpenAI

from app.tutor.board_scene import parse_board_update
from app.tutor.context import ContextBundle
from app.tutor.events import (
    BoardRequestEvent, ClientEvent, EventTranslator, StatusEvent, WorkspaceEvent,
)
from app.tutor.rendezvous import BoardRegion, BoardUnavailable
from app.tutor.retry import RETRY_LIMIT, classify, retry_delay
from app.tutor.tools import MEMORY_TOOLS, TOOL_DEFINITIONS

logger = logging.getLogger(__name__)

# How many times a turn may come back with a tool call before we stop asking.
#
# A well-behaved turn takes two rounds: the tool call, then the prose. Three
# left room for a model that sets the workspace, reconsiders and sets it again,
# without letting a model that has decided the only thing it will ever do is
# call `set_workspace` bill the learner indefinitely. Hitting the bound is not
# an error — whatever prose arrived by then is the answer, and the workspace was
# applied on the way.
#
# **Five since `view_board`.** Reading a board is genuinely iterative in a way
# setting a workspace is not: the overview says where the work is, one crop
# reads the first few lines, and a second reads the line the first one ran out
# at. Three rounds made a tutor that looked twice spend its last round looking
# instead of answering — the learner got silence for the same reason the
# workspace bug produced silence, one layer up. Five leaves two looks and an
# answer with room to spare, and the per-crop pixel caps in `board` are what
# actually bound the cost.
MAX_TOOL_ROUNDS = 5

# The smallest region `view_board` will honour, as a percentage of a side.
#
# Below this the device is being asked to render a sliver, and a sliver of blank
# paper is what a model reads as "there is nothing written here" — the one wrong
# conclusion this whole pipeline exists to prevent. Clamping up returns a real
# picture of a slightly larger area; the `detail` string says what was actually
# shown, so the model can tell its aim was adjusted.
MIN_REGION_PERCENT = 2.0

# How long a memory tool may run before the turn gives up on it.
#
# This is the only wait in a turn that no provider event passes through, so it
# is the only one the heartbeat cannot cover: `EventTranslator.translate` is
# what emits a keep-alive, and it runs on incoming provider events, of which
# there are none while this is awaited. Unbounded, the worst case is not the
# "one embedding round trip" this used to claim — `embed_texts` keeps the SDK
# defaults, two retries against a 600s request timeout, so a hung embeddings
# call is minutes of absolute silence.
#
# What that costs is not a slow turn, it is a lie: the client gives up at 120s
# (`BackendTutorService.streamTimeout`) while the server carries on and records
# a *successful* turn. `max_silence_ms` observes that afterwards, it does not
# prevent it. Twenty seconds is `rendezvous.RENDER_TIMEOUT_SECONDS` — the other
# eventless wait in this loop, and already known to be survivable — against
# work that is normally a query and one embedding.
MEMORY_TIMEOUT_SECONDS = 20.0

# How long a whole turn may spend waiting on memory tools, added up.
#
# `MEMORY_TIMEOUT_SECONDS` bounds one call and nothing bounds the number of
# them: the per-call timeout sits inside `for call in calls`, inside the
# `MAX_TOOL_ROUNDS` loop, and nothing caps calls-per-response. Seven
# `search_memory` calls in one response is 140 seconds of silence inside a
# single round — past the client's 120s `streamTimeout` before the second round
# even starts, which is exactly the failure the per-call bound above was added
# to prevent, arrived at by a different road.
#
# So the budget is cumulative across the turn: each call is allowed
# `min(MEMORY_TIMEOUT_SECONDS, what is left)`, and once nothing is left the
# tool is answered immediately with `MEMORY_TIMEOUT_ACK` rather than waited on.
# That introduces no new failure mode — the model already has to handle that
# string, and it already means "this was abandoned and you do not know what it
# managed to do". Forty seconds is two full-length calls, comfortably inside
# 120s alongside the model streaming that has to fit there too.
MEMORY_BUDGET_SECONDS = 40.0

# What the tool call is answered with. `set_workspace` has no server-side
# effect to report: the plan and exercise ride out on the WorkspaceEvent and
# the device applies them. The model still needs *something* back before it
# will continue, and an acknowledgement it can read is what stops it calling
# the same tool a second time to find out whether the first one worked.
SET_WORKSPACE_ACK = json.dumps({
    "status": "applied",
    "detail": "The learner's plan and board exercise now show what you set. "
              "Tell them about it in your reply.",
})

# What `update_board` is answered with after its `board_update` event has gone
# out. The event is the actual mutation; this ack is what tells the provider
# the round succeeded so it can write the accompanying prose.
UPDATE_BOARD_ACK = json.dumps({
    "status": "applied",
    "detail": "The tutor's board objects were updated on the learner's iPad. "
              "Mention what you drew and why, in your reply.",
})

# What a malformed `update_board` call is answered with. No event was sent, so
# the learner's scene is unchanged; the model must read this and revise rather
# than believing its invalid geometry landed.
MALFORMED_BOARD_ACK = json.dumps({
    "status": "rejected",
    "detail": "The board update could not be parsed or validated, so nothing "
              "was drawn. Check the id, kind, coordinates, and required fields, "
              "then call `update_board` again with a valid batch.",
})

# What an unknown tool name is answered with. The provider should only ever
# call tools in the registry; this keeps a future renamed tool from silently
# receiving the `set_workspace` ack and being recorded as a workspace change.
UNSUPPORTED_TOOL_ACK = json.dumps({
    "status": "unsupported",
    "detail": "That tool is not available in this tutor session. Continue with "
              "ordinary prose, or use the tools listed in your instructions.",
})

# What `view_board` is answered with when the turn carries no board at all.
#
# A learner can ask "check this" with an empty canvas, and the model has no way
# to know that until it looks. Saying so plainly is what stops it either
# inventing working or falling silent.
NO_BOARD_ACK = json.dumps({
    "status": "empty",
    "detail": "There is nothing on the learner's board to look at. Say so, and ask "
              "them to write something first rather than guessing at their work.",
})

# What `view_board` is answered with when the device never sent the render.
#
# The iPad is the only thing that can draw a region of the board, so a
# backgrounded app or a dropped connection means this round genuinely has no
# picture. Told plainly, the model says it could not see and carries on; told
# nothing, it fills the gap from the transcript, which is the exact failure the
# whole board pipeline exists to prevent.
UNAVAILABLE_ACK = json.dumps({
    "status": "unavailable",
    "detail": "The learner's iPad did not send that region in time, so you still have "
              "not seen it. Do not describe what is written there. Say you could not "
              "load their board and ask them to try again.",
})


# What a memory tool is answered with when this turn has no memory wired to it.
#
# The four are in `TOOL_DEFINITIONS` unconditionally — varying the tool set per
# turn invalidates the whole cached prompt prefix — so a caller that passes no
# handler still gets them called. Plain prose rather than the JSON above
# because that is what every *successful* memory answer is; see
# `app/memory/dispatch.py`.
NO_MEMORY_ACK = (
    "Memory is not available in this session, so nothing was searched, saved "
    "or recorded. Do not tell the learner you have remembered anything, and do "
    "not tell them you have no memory of something — you have not looked."
)

# What a memory tool call whose arguments will not parse is answered with. The
# handler never ran, so nothing was written; saying so is what stops the model
# reporting a save that did not happen.
MALFORMED_MEMORY_ACK = (
    "That call's arguments could not be read, so nothing happened. Check the "
    "field names and types and call it again."
)

# What a memory tool is answered with when it ran past
# `MEMORY_TIMEOUT_SECONDS` and was abandoned.
#
# Deliberately does not claim nothing was written. The timeout cancels the
# handler wherever it had got to, which may be either side of its commit, so
# "nothing was saved" would be a guess — and the one thing these strings exist
# to stop is the model reporting a state of the store it does not know.
MEMORY_TIMEOUT_ACK = (
    "That took too long and was abandoned, and whether it finished is not "
    "known. Do not tell the learner you have remembered anything, and do not "
    "tell them you have no memory of something — you have not looked. Carry "
    "on without it."
)


async def _open_round(client: AsyncOpenAI, payload: dict):
    """Open one round's stream, retrying a retryable failure silently.

    The turn client keeps `max_retries=0`, because the SDK's own retry cannot
    tell a rate-limit 429 from a billing one and would sit through backoff on
    an exhausted account before `classify` ever saw it. That is the right call
    — but for a long time it left the turn path with *no* retry at all, so a
    single refused connection or one 500 ended a learner's turn outright.
    `/v1/dictation` had solved this already; this is the same shape, against
    the same `classify`.

    Only the open is retried. `responses.create` returns once the response
    headers arrive, so a failure here means nothing has streamed and nothing
    has been yielded — the round can be started again with no visible seam. A
    failure *after* that point is a different thing and is never retried:
    re-running a round whose text the learner has already read would write it
    twice. This holds for a later round as much as the first, because
    `previous_response_id` names a response the provider is holding, and
    re-opening against it asks for the same continuation again.
    """
    for attempt in range(RETRY_LIMIT + 1):
        try:
            return await client.responses.create(**payload)
        except APIStatusError as error:
            decision = classify(error.status_code, error.body)
            if not decision.retry or attempt == RETRY_LIMIT:
                raise
            logger.warning(
                "retrying round after %s | attempt=%d reason=%s",
                error.status_code, attempt + 1, decision.reason,
            )
            await asyncio.sleep(retry_delay(error.response))
    raise AssertionError("unreachable: loop above always returns or raises")


#: How `run_turn` gets a region of the board rendered.
#:
#: Injected rather than imported so the loop stays testable without a device, a
#: rendezvous, or an event stream: a test hands it a lambda returning PNG bytes.
#: Raising `BoardUnavailable` is how a fetcher says the device did not answer.
BoardFetcher = Callable[[str, BoardRegion], Awaitable[bytes]]

#: How `run_turn` runs a memory tool. Injected for the reason `BoardFetcher` is,
#: and for one more: the four memory tools need a database session, and this
#: loop is the wrong place to decide where one comes from. It runs for the whole
#: length of a turn, so a session handed in here would be a pooled connection
#: pinned for minutes of model streaming. What the caller binds in is a handler
#: that opens its own; `app.memory.dispatch.memory_handler` is that binding and
#: says the rest.
MemoryHandler = Callable[[str, dict], Awaitable[str]]

#: What the learner's status line says while a memory tool runs.
#:
#: Not in `events.TOOL_PHASES`: that maps a call to a phase as its *arguments*
#: stream in, and by the time the wait below happens the call is complete and
#: the translator has nothing left to react to. A name missing from here falls
#: back to "thinking", which is true of any tool, so this cannot drift into
#: telling the learner a tool does not exist — it can only be less specific.
MEMORY_PHASES: dict[str, str] = {
    "search_memory": "searching",
    "recent_sessions": "searching",
}


@dataclass
class ToolAnswer:
    """What answering one tool call produces, before anything is awaited.

    Three shapes, and exactly one of them is set. `items` is a reply the server
    can write on its own — `set_workspace`, an empty board, a malformed call.
    `ask` is a `view_board` that needs the device: the caller has to emit it,
    wait for the render, and only then build the items. `run` is a memory tool,
    which needs a database session `_answer` has not got. Splitting it this way
    is what lets the awaiting live in `run_turn` — the only place that can
    *yield* the board request down the stream the device is listening to, and
    the only place holding the injected handlers.
    """

    items: list[dict] | None = None
    ask: tuple[BoardRequestEvent, BoardRegion] | None = None
    run: tuple[str, dict] | None = None


def _region_from(arguments: dict) -> BoardRegion:
    """The rectangle a model asked for, clamped into one that exists.

    Every field is model-authored, so each is treated as absent-or-wrong until
    proven otherwise, and the whole board is the fallback for any of them. A
    confused model gets a picture of everything rather than a dead tool round.

    The clamp order matters: size first, then origin against it, so a region that
    is both too small and off the edge ends up inside the board rather than
    pinned to a corner with no extent. `MIN_REGION_PERCENT` exists because a
    region of nothing renders as a sliver of blank paper that the model reads as
    "there is nothing here".
    """
    def number(key: str, fallback: float) -> float:
        value = arguments.get(key)
        return float(value) if isinstance(value, (int, float)) else fallback

    width = min(100.0, max(MIN_REGION_PERCENT, number("width", 100.0)))
    height = min(100.0, max(MIN_REGION_PERCENT, number("height", 100.0)))
    x = min(100.0 - width, max(0.0, number("x", 0.0)))
    y = min(100.0 - height, max(0.0, number("y", 0.0)))
    return BoardRegion(x=x, y=y, width=width, height=height)


def _arguments(call: dict) -> dict | None:
    """A tool call's arguments as a dict, or None if they are not one.

    A model can emit a bare array, a string, or nothing at all where an object
    was asked for. Each caller decides what that costs: `view_board` treats it
    as an unaimed look and shows the whole board, a memory tool refuses.
    """
    try:
        arguments = json.loads(call.get("arguments") or "{}")
    except json.JSONDecodeError:
        return None
    return arguments if isinstance(arguments, dict) else None


def _answer(call: dict, *, has_board: bool, has_memory: bool = False) -> ToolAnswer:
    """Plan one tool call's reply.

    Two calls cannot be answered here. `view_board` needs the iPad, because the
    only thing that can render a region of a `PKDrawing` is the device holding
    it. The memory tools need a database session, which this function has no
    way to be given — it is synchronous and is called per tool call from inside
    the stream. Both come back as an intent for `run_turn` to carry out.
    """
    call_id = call["call_id"]

    name = call.get("name")
    if name == "set_workspace":
        return ToolAnswer(items=[
            {"type": "function_call_output", "call_id": call_id, "output": SET_WORKSPACE_ACK}
        ])

    if name == "update_board":
        update, _ = parse_board_update(call.get("arguments") or "{}")
        output = UPDATE_BOARD_ACK if update is not None else MALFORMED_BOARD_ACK
        return ToolAnswer(items=[
            {"type": "function_call_output", "call_id": call_id, "output": output}
        ])

    if name in MEMORY_TOOLS:
        arguments = _arguments(call)
        if not has_memory:
            output = NO_MEMORY_ACK
        elif arguments is None:
            output = MALFORMED_MEMORY_ACK
        else:
            return ToolAnswer(run=(name, arguments))
        return ToolAnswer(items=[
            {"type": "function_call_output", "call_id": call_id, "output": output}
        ])

    if name != "view_board":
        return ToolAnswer(items=[
            {"type": "function_call_output", "call_id": call_id, "output": UNSUPPORTED_TOOL_ACK}
        ])

    if not has_board:
        return ToolAnswer(items=[
            {"type": "function_call_output", "call_id": call_id, "output": NO_BOARD_ACK}
        ])

    region = _region_from(_arguments(call) or {})
    detail = (
        f"Showing x {region.x:.0f}\u2013{region.x + region.width:.0f}%, "
        f"y {region.y:.0f}\u2013{region.y + region.height:.0f}% of the board."
    )
    return ToolAnswer(ask=(
        BoardRequestEvent(
            call_id=call_id,
            x=region.x, y=region.y, width=region.width, height=region.height,
            detail=detail,
        ),
        region,
    ))


def _rendered_items(call_id: str, image: bytes, detail: str) -> list[dict]:
    """The device's render, as the items that put it in front of the model.

    Two items rather than one because a `function_call_output` is a string and
    this answer is a **picture**. The output announces it and the picture follows
    as a user message, so the next thing in the model's context after it asked to
    look at something is that something. This is the documented shape for handing
    an image back through a text-only tool channel, and it leaves the
    call/output pairing the API requires exactly intact.
    """
    encoded = base64.b64encode(image).decode()
    return [
        {
            "type": "function_call_output",
            "call_id": call_id,
            "output": json.dumps({"status": "ok", "detail": detail}),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": f"Here is the region of the board you asked for. {detail}",
                },
                {
                    "type": "input_image",
                    "image_url": f"data:image/png;base64,{encoded}",
                    "detail": "high",
                },
            ],
        },
    ]


@dataclass
class TurnResult:
    raw_events: list[dict] = field(default_factory=list)
    usage: dict | None = None
    workspace: dict | None = None
    text: str = ""
    response_id: str | None = None
    #: Every tool call this turn made, in order, with the answer it got back.
    #: The recorder turns these into `tool_calls` rows; without them the only
    #: trace of a tool use was the raw events blob, which the API never read.
    tool_calls: list[dict] = field(default_factory=list)


def _merge_usage(total: dict | None, addition: dict | None) -> dict | None:
    """Sum the token counts across a turn's rounds.

    A turn is one turn to the learner and to the bill, however many round
    trips it took. Keeping only the last round's usage — which is what a plain
    assignment does — under-reports every turn that called a tool, and those
    are exactly the expensive ones.
    """
    if addition is None:
        return total
    if total is None:
        return dict(addition)
    merged = dict(total)
    for key, value in addition.items():
        if isinstance(value, (int, float)) and isinstance(merged.get(key), (int, float)):
            merged[key] = merged[key] + value
        elif isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_usage(merged[key], value) or {}
        else:
            merged[key] = value
    return merged


async def run_turn(
    *,
    client: AsyncOpenAI,
    model: str,
    effort: str,
    bundle: ContextBundle,
    request_body: dict | None = None,
    translator: EventTranslator | None = None,
    fetch_board: BoardFetcher | None = None,
    handle_memory: MemoryHandler | None = None,
    cache_key: str | None = None,
) -> AsyncIterator[tuple[ClientEvent, TurnResult]]:
    """Stream one turn, yielding client events as they happen.

    **A turn is a loop, not a request.** A function call *ends* a Responses
    API response: the model stops, and the caller is expected to run the tool,
    hand back a `function_call_output`, and ask it to continue. This ran one
    request and stopped, so a turn that called `set_workspace` streamed
    reasoning, streamed the tool's arguments, and finished having written no
    prose at all — the learner got a new plan on the board and silence in the
    thread. The prompt asks for prose *and* a tool call in one pass; the model
    is entitled to answer with the call alone, and with a reasoning model it
    usually does.

    So: stream, and if the response ended on a tool call, feed the result back
    and stream again, up to `MAX_TOOL_ROUNDS`. Every round appends to the same
    `TurnResult`, so the recording is the whole turn rather than its last leg.

    **Only the first round sends the prompt.** Every round after it names the
    previous response with `previous_response_id` and sends nothing but the
    tool results. The provider already holds the rest — including the model's
    own reasoning, which is what a later round needs and cannot otherwise have:
    a function call ends a response, and the thinking that chose to make that
    call is not something the caller is ever shown. Rebuilt from the caller's
    side instead, each round would start from nothing and work out again what
    it had already decided before it reached for the tool, at the output rate.

    The accumulating TurnResult rides along on every yield so the caller can
    persist it after the stream ends — including when the stream ends badly.

    ``request_body``, when given, is the dict the caller records as this
    turn's request envelope. The loop fills it with the *actual* first-round
    payload — tools, reasoning, store, stream and all — so a stored call says
    what the model was really offered, not the subset a parallel hand-built
    dict happened to remember. The recorded body is the only place a bad turn
    can be diagnosed from; finding there that ``tools`` was never recorded
    would read as "the model had no tools" whether or not that was true.
    """
    translator = translator or EventTranslator()
    result = TurnResult()
    #: What the next round puts on the wire. The whole prompt to begin with,
    #: and after that only what the provider does not already hold.
    outbox = list(bundle.input)
    previous_id: str | None = None
    # Time left for memory tools across the whole turn, spent down by every
    # call in every round. Wall-clock spent *waiting on memory*, not wall-clock
    # since the turn began: a turn is legitimately minutes of model streaming,
    # and a deadline measured from the start would refuse a memory call in a
    # later round for time the model spent thinking.
    memory_budget = MEMORY_BUDGET_SECONDS

    for _ in range(MAX_TOOL_ROUNDS):
        output_items: list[dict] = []

        # `payload`, not `request`: a `BoardRequestEvent` is already called
        # that further down this same function.
        payload: dict = {
            "model": model,
            "input": outbox,
            "reasoning": {"effort": effort, "summary": "auto"},
            "tools": TOOL_DEFINITIONS,
            # Retained by the provider for thirty days, and that is the point.
            # It is what `previous_response_id` below needs to chain against,
            # so the reasoning behind a tool call survives into the round that
            # has to act on it. The traces are also readable in the provider's
            # dashboard, which is the only view of a turn that does not come
            # out of this service's own recorder.
            "store": True,
            "stream": True,
        }
        if previous_id is not None:
            # Names the round this one continues. With it, `outbox` holds only
            # the tool results; without it, every round would resend the whole
            # prompt and the model would lose its own reasoning each time.
            payload["previous_response_id"] = previous_id
        if cache_key is not None:
            # Requests are routed to a cache by a hash of the start of the
            # prompt; this joins that hash so every round of every turn of one
            # session lands where that session's prefix already is. The
            # provider's guidance is roughly fifteen requests a minute per key,
            # which one learner in one session cannot reach.
            payload["prompt_cache_key"] = cache_key
        if request_body is not None and previous_id is None:
            # First round only: later rounds are `previous_response_id` plus
            # tool outputs, which the envelope's `input` already accounts for.
            # Copy rather than assign so the recorded dict is detached from the
            # payload the SDK mutates during send.
            request_body.clear()
            request_body.update(payload)
        stream = await _open_round(client, payload)

        # `async with` guarantees the upstream HTTP response is closed
        # deterministically — including when the caller stops iterating early
        # (a `break` out of `async for ... in run_turn(...)`) — rather than
        # leaving the connection to whenever the asyncgen finalizer happens to
        # run. `AsyncStream.__aexit__` calls `response.aclose()`.
        async with stream:
            async for raw in stream:
                event = raw.model_dump(mode="json", exclude_none=True)
                result.raw_events.append(event)

                kind = event.get("type", "")
                if kind == "response.output_text.delta":
                    result.text += event.get("delta", "")
                elif kind == "response.completed":
                    response = event.get("response") or {}
                    result.usage = _merge_usage(result.usage, response.get("usage"))
                    result.response_id = response.get("id")
                    output_items = response.get("output") or []

                for client_event in translator.translate(event):
                    if isinstance(client_event, WorkspaceEvent):
                        result.workspace = client_event.model_dump(mode="json")
                    yield client_event, result

        calls = [item for item in output_items if item.get("type") == "function_call"]
        if not calls:
            return

        # Nothing from `output_items` is echoed back. The calls, the reasoning
        # that led to them, and the prompt they came from are all in the
        # response this round is about to name — sending copies would show the
        # model each of them twice.
        previous_id = result.response_id

        # Outputs stay packed together, and anything a tool wants to *show* the
        # model goes after all of them. A response carrying two `view_board`
        # calls would otherwise interleave — output, picture, output — putting
        # the second output behind a user message and breaking the run of
        # outputs the API expects to find answering the run of calls.
        outputs: list[dict] = []
        attachments: list[dict] = []
        for call in calls:
            if not call.get("call_id"):
                continue
            call_id = call["call_id"]
            answer = _answer(
                call,
                has_board=bundle.has_board and fetch_board is not None,
                has_memory=handle_memory is not None,
            )

            if answer.items is not None:
                outputs.append(answer.items[0])
                attachments.extend(answer.items[1:])
                continue

            if answer.run is not None:
                name, arguments = answer.run
                if memory_budget <= 0:
                    # Answered without waiting, and no status first: there is
                    # no eventless stretch to cover, because nothing is being
                    # awaited. The ack is the same string a timeout produces,
                    # which is the point — the model already knows how to read
                    # "abandoned, and you do not know what it managed to do".
                    logger.warning(
                        "memory budget of %.0fs exhausted; answering without "
                        "running | tool=%s", MEMORY_BUDGET_SECONDS, name,
                    )
                    output = MEMORY_TIMEOUT_ACK
                else:
                    # Announced before the wait, for the reason the
                    # `board_request` below is: this is an eventless stretch,
                    # so nothing else will put anything on the wire until it
                    # ends. A status is what tells the learner the tutor is
                    # doing something, and what stops the gap being the largest
                    # silence in the turn.
                    yield StatusEvent(
                        phase=MEMORY_PHASES.get(name, "thinking"), detail=None
                    ), result
                    allowance = min(MEMORY_TIMEOUT_SECONDS, memory_budget)
                    started = time.monotonic()
                    try:
                        # Bounded twice, because nothing else bounds either
                        # one: `MEMORY_TIMEOUT_SECONDS` is what one call may
                        # take, `memory_budget` is what the turn has left. The
                        # handler answers rather than raising, so a timeout is
                        # the only failure that can reach this branch — and
                        # cancelling mid-flight can hand a half-used connection
                        # back to the pool, which is what `pool_pre_ping` on
                        # the engine is for.
                        async with asyncio.timeout(allowance):
                            output = await handle_memory(name, arguments)
                    except TimeoutError:
                        logger.warning(
                            "memory tool timed out after %.0fs | tool=%s",
                            allowance, name,
                        )
                        output = MEMORY_TIMEOUT_ACK
                    finally:
                        # In `finally` so a call that timed out still spends
                        # what it burned. Charging only successful calls would
                        # let a run of timeouts cost 20s each and never reduce
                        # the budget that exists to stop exactly that.
                        memory_budget -= time.monotonic() - started
                outputs.append({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                })
                continue

            request, region = answer.ask
            # The request goes out *before* the wait, because the thing that
            # answers it is at the far end of this very stream: the device is
            # reading these events, and it cannot render a region it has not
            # been asked for. Yielding here is what puts it on the wire.
            yield request, result
            try:
                image = await fetch_board(call_id, region)
                items = _rendered_items(call_id, image, request.detail)
            except BoardUnavailable:
                items = [{
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": UNAVAILABLE_ACK,
                }]
            outputs.append(items[0])
            attachments.extend(items[1:])

        # Captured here, after every branch has filled `outputs`, so the
        # recorded call carries the answer it actually got — the memory
        # handler's reply, the board render, the ack — rather than only the
        # call the model made. Attachments are not outputs and carry no
        # `call_id`, which is why they are matched through the outputs list
        # rather than the outbox.
        answers = {
            item["call_id"]: item.get("output")
            for item in outputs if item.get("call_id") is not None
        }
        for call in calls:
            if call.get("call_id") is None:
                continue
            result.tool_calls.append({
                "name": call.get("name") or "?",
                "arguments": _arguments(call),
                "result": answers.get(call["call_id"]),
            })

        if not outputs:
            # Every call was skipped, which only happens if the provider sent
            # calls with no `call_id` at all. There is nothing to answer them
            # with, and a round that names the previous response and posts an
            # empty `input` asks the model to continue from nothing. Stop
            # instead: whatever prose arrived is the answer, and the warning is
            # what says a round was thrown away.
            logger.warning(
                "tool calls arrived with no call_id; ending the turn | tools=%s",
                ",".join(call.get("name") or "?" for call in calls),
            )
            return
        outbox = outputs + attachments
    else:
        # The cap bit — `return` above is the only other way out, so this runs
        # exactly when the last round still ended on tool calls. Hitting it is
        # not an error, but it is invisible: whatever prose arrived is the
        # answer, and if none did the learner gets a `done` event and silence,
        # which is the failure `MAX_TOOL_ROUNDS`' own comment was written to
        # prevent. Nothing anywhere said it had happened. `text_chars=0` is the
        # bad case; the tool names say which loop the model was stuck in.
        logger.warning(
            "tool rounds exhausted | rounds=%d text_chars=%d last_tools=%s",
            MAX_TOOL_ROUNDS, len(result.text),
            ",".join(call.get("name") or "?" for call in calls),
        )
