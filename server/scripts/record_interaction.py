"""Print the raw events of one real Gemini turn, as fixture source.

The Interactions API's event *names* are documented; the keys inside a
`step.delta` are not. A fixture written from a guess tests the guess, so this
makes one real call and prints what actually arrived.

Usage:

    cd server && uv run python -m scripts.record_interaction "draw a right triangle"
    cd server && uv run python -m scripts.record_interaction "..." gemini-3.7-flash

`-m`, not a path. Running `python scripts/record_interaction.py` puts `scripts/`
on `sys.path` instead of `server/`, so `import app` fails; `-m` keeps the working
directory there, which is how `scripts/build_kc_seed.py` is run too.

The model is the optional second argument, defaulting to the cheaper Flash-Lite.

Paste the output into `tests/fixtures/interactions.py`, trimming the argument
deltas to two or three so the fixture stays readable. Keep every event *type*
that appeared, including any this service does not read: the heartbeat fires on
those, and a fixture without them under-tests it.
"""

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


async def main(prompt: str, model: str) -> None:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise SystemExit("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    stream = await client.aio.interactions.create(
        model=model,
        input=prompt,
        system_instruction="You are a maths tutor. Use your tools.",
        tools=to_gemini_tools(TOOL_DEFINITIONS),
        generation_config={"thinking_level": "low", "thinking_summaries": "auto"},
        store=True,
        stream=True,
    )
    async for event in stream:
        print(json.dumps(event.model_dump(mode="json", exclude_none=True)))


if __name__ == "__main__":
    asyncio.run(main(
        sys.argv[1] if len(sys.argv) > 1 else "hello",
        sys.argv[2] if len(sys.argv) > 2 else DEFAULT_MODEL,
    ))
