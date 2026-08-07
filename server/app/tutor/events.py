from __future__ import annotations

import json
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError


class Plan(BaseModel):
    title: str
    goal: str
    outcomes: list[str]
    steps: list[str]
    currentStep: int


class ExerciseModel(BaseModel):
    title: str
    prompt: str
    hint: str
    context: str


class StatusEvent(BaseModel):
    type: Literal["status"] = "status"
    phase: Literal["thinking", "looking", "searching", "writing"]
    detail: str | None = None


class ReasoningDeltaEvent(BaseModel):
    type: Literal["reasoning_delta"] = "reasoning_delta"
    text: str


class TextDeltaEvent(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    text: str


class WorkspaceEvent(BaseModel):
    type: Literal["workspace"] = "workspace"
    plan: Plan
    exercise: ExerciseModel


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    turn_id: UUID
    input_tokens: int | None = None
    output_tokens: int | None = None
    reasoning_tokens: int | None = None


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    message: str
    retryable: bool


ClientEvent = Annotated[
    StatusEvent | ReasoningDeltaEvent | TextDeltaEvent | WorkspaceEvent | DoneEvent | ErrorEvent,
    Field(discriminator="type"),
]


class EventTranslator:
    """Turns Responses API events into our own vocabulary.

    Stateful on purpose: a function call's name arrives on
    `response.output_item.added` and its arguments arrive later carrying only
    `output_index`, so the two have to be correlated.
    """

    def __init__(self) -> None:
        self._tool_names: dict[int, str] = {}
        self._writing_announced = False

    def translate(self, event: dict) -> list[ClientEvent]:
        kind = event.get("type", "")

        if kind == "response.created":
            return [StatusEvent(phase="thinking")]

        if kind == "response.reasoning_summary_text.delta":
            return [ReasoningDeltaEvent(text=event.get("delta", ""))]

        if kind == "response.output_text.delta":
            delta = TextDeltaEvent(text=event.get("delta", ""))
            if self._writing_announced:
                return [delta]
            self._writing_announced = True
            return [StatusEvent(phase="writing"), delta]

        if kind == "response.output_item.added":
            item = event.get("item") or {}
            if item.get("type") == "function_call":
                self._tool_names[event["output_index"]] = item.get("name", "")
            return []

        if kind == "response.function_call_arguments.done":
            name = self._tool_names.get(event.get("output_index", -1))
            if name != "set_workspace":
                return []
            return self._workspace_from(event.get("arguments", ""))

        if kind.startswith("response.file_search_call.") or kind.startswith(
            "response.web_search_call."
        ):
            return [StatusEvent(phase="searching")]

        return []

    def _workspace_from(self, raw_arguments: str) -> list[ClientEvent]:
        # A half-parsed workspace must never reach the board. Dropping it leaves
        # the learner's current plan and exercise exactly as they were.
        try:
            payload = json.loads(raw_arguments)
            return [WorkspaceEvent(plan=payload["plan"], exercise=payload["exercise"])]
        except (json.JSONDecodeError, KeyError, TypeError, ValidationError):
            return []
