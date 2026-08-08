from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field

from openai import AsyncOpenAI

from app.tutor.board_scene import parse_board_update
from app.tutor.context import ContextBundle
from app.tutor.events import BoardRequestEvent, ClientEvent, EventTranslator, WorkspaceEvent
from app.tutor.rendezvous import BoardRegion, BoardUnavailable
from app.tutor.tools import TOOL_DEFINITIONS

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


#: How `run_turn` gets a region of the board rendered.
#:
#: Injected rather than imported so the loop stays testable without a device, a
#: rendezvous, or an event stream: a test hands it a lambda returning PNG bytes.
#: Raising `BoardUnavailable` is how a fetcher says the device did not answer.
BoardFetcher = Callable[[str, BoardRegion], Awaitable[bytes]]


@dataclass
class ToolAnswer:
    """What answering one tool call produces, before anything is awaited.

    Two shapes, and exactly one of them is set. `items` is a reply the server can
    write on its own — `set_workspace`, an empty board, a malformed call. `ask`
    is a `view_board` that needs the device: the caller has to emit it, wait for
    the render, and only then build the items. Splitting it this way is what lets
    the waiting live in `run_turn`, which is the only place that can *yield* the
    request down the stream the device is listening to.
    """

    items: list[dict] | None = None
    ask: tuple[BoardRequestEvent, BoardRegion] | None = None


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


def _answer(call: dict, *, has_board: bool) -> ToolAnswer:
    """Plan one tool call's reply.

    `view_board` is the only call that cannot be answered here, because the only
    thing that can render a region of a `PKDrawing` is the iPad holding it.
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

    if name != "view_board":
        # Anything a later seam adds that has no server-side result to report.
        return ToolAnswer(items=[
            {"type": "function_call_output", "call_id": call_id, "output": SET_WORKSPACE_ACK}
        ])

    if not has_board:
        return ToolAnswer(items=[
            {"type": "function_call_output", "call_id": call_id, "output": NO_BOARD_ACK}
        ])

    try:
        arguments = json.loads(call.get("arguments") or "{}")
    except json.JSONDecodeError:
        arguments = {}

    region = _region_from(arguments if isinstance(arguments, dict) else {})
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
    translator: EventTranslator | None = None,
    fetch_board: BoardFetcher | None = None,
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

    The accumulating TurnResult rides along on every yield so the caller can
    persist it after the stream ends — including when the stream ends badly.
    """
    translator = translator or EventTranslator()
    result = TurnResult()
    conversation = list(bundle.input)

    for _ in range(MAX_TOOL_ROUNDS):
        output_items: list[dict] = []

        stream = await client.responses.create(
            model=model,
            input=conversation,
            reasoning={"effort": effort, "summary": "auto"},
            tools=TOOL_DEFINITIONS,
            store=False,
            stream=True,
        )

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

        # Only the calls go back, not the whole `output` list. A reasoning item
        # returned by a `store=False` response is a bare id with no content —
        # the encrypted payload is only present when the request asked for it —
        # and handing that id back names an item the API has not kept. The
        # function calls are self-contained and are what the outputs attach to.
        #
        # Outputs stay packed immediately behind the calls, and anything a tool
        # wants to *show* the model goes after all of them. A response carrying
        # two `view_board` calls would otherwise interleave — call, call,
        # output, picture, output — putting the second output behind a user
        # message and breaking the run of outputs the API expects to find
        # answering the run of calls.
        conversation = conversation + calls
        attachments: list[dict] = []
        for call in calls:
            if not call.get("call_id"):
                continue
            call_id = call["call_id"]
            answer = _answer(call, has_board=bundle.has_board and fetch_board is not None)

            if answer.items is not None:
                conversation.append(answer.items[0])
                attachments.extend(answer.items[1:])
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
            conversation.append(items[0])
            attachments.extend(items[1:])
        conversation = conversation + attachments
