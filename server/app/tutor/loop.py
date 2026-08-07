from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from openai import AsyncOpenAI

from app.tutor.context import ContextBundle
from app.tutor.events import ClientEvent, EventTranslator, WorkspaceEvent
from app.tutor.tools import TOOL_DEFINITIONS

# How many times a turn may come back with a tool call before we stop asking.
#
# A well-behaved turn takes two rounds: the tool call, then the prose. Three
# leaves room for a model that sets the workspace, reconsiders and sets it
# again, without letting a model that has decided the only thing it will ever
# do is call `set_workspace` bill the learner indefinitely. Hitting the bound
# is not an error — whatever prose arrived by then is the answer, and the
# workspace was applied on the way.
MAX_TOOL_ROUNDS = 3

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
        conversation = conversation + calls + [
            {
                "type": "function_call_output",
                "call_id": call["call_id"],
                "output": SET_WORKSPACE_ACK,
            }
            for call in calls
            if call.get("call_id")
        ]
