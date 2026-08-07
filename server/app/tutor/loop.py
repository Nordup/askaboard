from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from openai import AsyncOpenAI

from app.tutor.context import ContextBundle
from app.tutor.events import ClientEvent, EventTranslator, WorkspaceEvent
from app.tutor.tools import TOOL_DEFINITIONS


@dataclass
class TurnResult:
    raw_events: list[dict] = field(default_factory=list)
    usage: dict | None = None
    workspace: dict | None = None
    text: str = ""
    response_id: str | None = None


async def run_turn(
    *,
    client: AsyncOpenAI,
    model: str,
    effort: str,
    bundle: ContextBundle,
    translator: EventTranslator | None = None,
) -> AsyncIterator[tuple[ClientEvent, TurnResult]]:
    """Stream one turn, yielding client events as they happen.

    The accumulating TurnResult rides along on every yield so the caller can
    persist it after the stream ends — including when the stream ends badly.
    """
    translator = translator or EventTranslator()
    result = TurnResult()

    stream = await client.responses.create(
        model=model,
        input=bundle.input,
        reasoning={"effort": effort, "summary": "auto"},
        tools=TOOL_DEFINITIONS,
        store=False,
        stream=True,
    )

    async for raw in stream:
        event = raw.model_dump(mode="json", exclude_none=True)
        result.raw_events.append(event)

        kind = event.get("type", "")
        if kind == "response.output_text.delta":
            result.text += event.get("delta", "")
        elif kind == "response.completed":
            response = event.get("response") or {}
            result.usage = response.get("usage")
            result.response_id = response.get("id")

        for client_event in translator.translate(event):
            if isinstance(client_event, WorkspaceEvent):
                result.workspace = client_event.model_dump(mode="json")
            yield client_event, result
