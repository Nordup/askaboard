"""Print the raw events of one real Gemini turn, as fixture source.

The Interactions API's event *names* are documented; the keys inside a
`step.delta` are not. A fixture written from a guess tests the guess, so this
makes one real call and prints what actually arrived.

Usage:

    cd server && uv run python -m scripts.record_interaction "draw a right triangle"
    cd server && uv run python -m scripts.record_interaction "..." gemini-3.7-flash

`-m`, not a path. This script imports `app`, and running it by path puts
`scripts/` on `sys.path` rather than `server/`, so the import fails with
`ModuleNotFoundError: No module named 'app'`. `-m` runs it with the working
directory — `server/` — on the path instead. Scripts here that import nothing
from `app` run either way; this one does not.

The model is the optional second argument, defaulting to the cheaper Flash-Lite.

**Recording a second round.** A tool-calling turn stops at `requires_action`,
and what the model writes *after* the tool answers is a separate interaction
chained by `previous_interaction_id`. `--answer` records both rounds: round one
from the prompt, then the `function_result` fed back with the `call_id` and
`name` round one announced.

    # both rounds of a tool-calling turn
    cd server && uv run python -m scripts.record_interaction \
        "draw a right triangle on the board" --answer '{"ok": true}'

    # the same, but the result names the wrong tool — this is a 400, and it is
    # how the `error` event's shape gets recorded
    cd server && uv run python -m scripts.record_interaction \
        "look at the board" --answer '{"ok": true}' --answer-as update_board

Events go to stdout, one JSON object per line. Round banners and the
`call_id` go to stderr, so stdout stays valid JSONL either way; a second round
also starts with its own `interaction.created`, which is an unambiguous
boundary.

Paste the output into `tests/fixtures/interactions.py`, trimming the argument
deltas to two or three so the fixture stays readable. Keep every event *type*
that appeared, including any this service does not read: the heartbeat fires on
those, and a fixture without them under-tests it.
"""

import argparse
import asyncio
import json
import sys

from google import genai

from app.config import get_settings
from app.tutor.providers.gemini_schema import to_gemini_tools
from app.tutor.tools import TOOL_DEFINITIONS

#: Flash-Lite, not Flash: this script records the *wire shape*, which is
#: identical across Gemini 3.x, and Flash-Lite's input is $0.30 against $0.75.
#: The one exception is the board recording — if Flash-Lite will not draw a
#: usable `update_board` call, record that one on `gemini-3.7-flash` and say so
#: in the fixture module's docstring.
DEFAULT_MODEL = "gemini-3.5-flash-lite"

#: Deliberately thin. The production prompt is thousands of tokens of steering,
#: and a recording made under it would show which tool that prompt provokes
#: rather than how the provider frames whichever tool fires.
SYSTEM_INSTRUCTION = "You are a maths tutor. Use your tools."


async def record(client, model: str, **payload) -> list[dict]:
    """Stream one round, print every event, and return them."""
    stream = await client.aio.interactions.create(
        model=model,
        system_instruction=SYSTEM_INSTRUCTION,
        tools=to_gemini_tools(TOOL_DEFINITIONS),
        generation_config={"thinking_level": "low", "thinking_summaries": "auto"},
        # Retained on the paid tier, and that is the point: it is what
        # `previous_interaction_id` chains against, so `--answer` needs it.
        store=True,
        stream=True,
        **payload,
    )
    events = []
    async for event in stream:
        raw = event.model_dump(mode="json", exclude_none=True)
        events.append(raw)
        print(json.dumps(raw), flush=True)
    return events


def first_function_call(events: list[dict]) -> tuple[str, str] | None:
    """The `(call_id, name)` of the round's function call, if it made one.

    Read off `step.start`, because that is the only event that carries them:
    `step.stop` has nothing but its index, and `interaction.completed` carries
    no steps at all.
    """
    for event in events:
        step = event.get("step") or {}
        if step.get("type") == "function_call":
            return step["id"], step["name"]
    return None


async def main(args: argparse.Namespace) -> None:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise SystemExit("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)

    print("=== round 1 ===", file=sys.stderr)
    one = await record(client, args.model, input=args.prompt)
    if args.answer is None:
        return

    call = first_function_call(one)
    if call is None:
        raise SystemExit(
            "round one called no function, so there is nothing to answer; "
            "try a prompt that needs a tool"
        )
    call_id, name = call
    # `--answer-as` overrides the name on purpose. A `function_result` whose
    # `name` disagrees with the call it answers is rejected as
    # `invalid_request`, and that rejection is the only way to record the
    # `error` event's shape without provoking a real outage.
    answered_as = args.answer_as or name
    print(f"=== round 2: {call_id} as {answered_as} ===", file=sys.stderr)
    await record(
        client, args.model,
        previous_interaction_id=one[0]["interaction"]["id"],
        input=[{
            "type": "function_result",
            "call_id": call_id,
            "name": answered_as,
            # A plain string is one of the three shapes `result` accepts, and
            # it is the one `_answer` produces on the OpenAI side.
            "result": args.answer,
        }],
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.record_interaction",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("prompt", nargs="?", default="hello")
    parser.add_argument("model", nargs="?", default=DEFAULT_MODEL)
    parser.add_argument(
        "--answer", metavar="JSON",
        help="record a second round, feeding this back as the tool result",
    )
    parser.add_argument(
        "--answer-as", metavar="TOOL",
        help="name the result after this tool instead of the one that was "
             "called; a mismatch is a 400, which records the error event",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    asyncio.run(main(parse_args(sys.argv[1:])))
